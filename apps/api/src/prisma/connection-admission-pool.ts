import { Pool, type PoolClient, type PoolConfig } from 'pg';
import { PrismaPg } from '@prisma/adapter-pg';
import { currentConnectionAdmissionBudget } from './connection-admission-budget';
import {
  connectionAdmissionMetrics,
  type ConnectionAdmissionPoolState,
} from './connection-admission-metrics';

type ConnectCallback = (
  error: Error | undefined,
  client: PoolClient | undefined,
  release: (error?: Error | boolean) => void,
) => void;

export class ConnectionAdmissionPool extends Pool {
  private budgetedAdmissions = 0;

  constructor(config?: PoolConfig) {
    super(config);
    connectionAdmissionMetrics.registerPool(this);
  }

  readConnectionAdmissionState(): ConnectionAdmissionPoolState {
    return {
      capacity: this.options.max,
      total: this.totalCount,
      idle: this.idleCount,
      waiting: this.waitingCount,
      budgetedInFlight: this.budgetedAdmissions,
      ending: this.ending,
      ended: this.ended,
    };
  }

  override connect(): Promise<PoolClient>;
  override connect(callback: ConnectCallback): void;
  override connect(callback?: ConnectCallback): Promise<PoolClient> | void {
    if (!callback) {
      return new Promise<PoolClient>((resolve, reject) => {
        this.connect((error, client) => {
          if (error) reject(error);
          else if (client) resolve(client);
          else reject(new Error('PostgreSQL admission returned no connection'));
        });
      });
    }

    const budget = currentConnectionAdmissionBudget();
    const finish = connectionAdmissionMetrics.begin(budget ? 'budgeted' : 'ordinary');
    const handoff: ConnectCallback = (error, client, release) => {
      finish(Boolean(error) || !client);
      callback(error, client, release);
    };
    if (budget) {
      try {
        budget.check();
      } catch (error) {
        connectionAdmissionMetrics.increment('budgetRejectedBefore');
        handoff(
          error instanceof Error ? error : new Error('Read admission expired'),
          undefined,
          () => {},
        );
        return;
      }
      // FLAG: Expired Prisma maxWait callers can leave a pg waiter behind. Bound that
      // backlog, and never hand a late connection to Prisma (which would issue BEGIN).
      if (this.budgetedAdmissions >= 16) {
        connectionAdmissionMetrics.increment('capacityRejected');
        handoff(new Error('Read admission capacity exhausted'), undefined, () => {});
        return;
      }
      this.budgetedAdmissions++;
    }
    let retried = false;
    const acquire = () => {
      try {
        super.connect((error, client, release) => {
          if (budget) {
            this.budgetedAdmissions--;
            try {
              budget.check();
            } catch (expired) {
              connectionAdmissionMetrics.increment('budgetRejectedAfter');
              if (client) {
                release();
                connectionAdmissionMetrics.increment('lateReleases');
              }
              handoff(
                expired instanceof Error ? expired : new Error('Read admission expired'),
                undefined,
                () => {},
              );
              return;
            }
            // A budgeted read gets one bounded admission, never the ordinary second wait.
            handoff(error, client, release);
            return;
          }
          // FLAG: Retry only pg-pool's expired waiting-list admission, before a client
          // or SQL reaches the caller. Query, transaction, commit and socket failures
          // never enter this branch. The pool limit and each acquisition timeout stay fixed;
          // total admission is bounded by two waits (5s + 5s with production configuration).
          if (
            !retried &&
            !client &&
            !this.ending &&
            error instanceof Error &&
            error.message === 'timeout exceeded when trying to connect'
          ) {
            retried = true;
            connectionAdmissionMetrics.increment('retryTimeouts');
            acquire();
            return;
          }
          handoff(error, client, release);
        });
      } catch (error) {
        finish(true);
        throw error;
      }
    };
    acquire();
  }
}

export class ConnectionAdmissionPrismaPg extends PrismaPg {
  constructor(
    private readonly connectionConfig: PoolConfig,
    private readonly adapterOptions?: ConstructorParameters<typeof PrismaPg>[1],
  ) {
    super(connectionConfig, adapterOptions);
  }

  override connect(): ReturnType<PrismaPg['connect']> {
    // FLAG: Each Prisma connection lifecycle owns its pool, including reconnect after
    // $disconnect. Adapter disposal must close every connection and pending admission.
    return new PrismaPg(new ConnectionAdmissionPool(this.connectionConfig), {
      ...this.adapterOptions,
      disposeExternalPool: true,
    }).connect();
  }
}
