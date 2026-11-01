import { CommercialLlmError, type CommercialLlmHttpClassifier } from './commercial-llm.client';
import type { CommercialLlmClassifier } from './commercial-llm.protocol';
import type { CommercialLlmShadowLease } from './commercial-llm-shadow.lease';

export type CommercialLlmCpuLease = Pick<
  CommercialLlmShadowLease,
  'owns' | 'retainUntilReleased' | 'release'
>;

// FLAG: Admission owns a token; only actual HTTP lifecycle establishes physical uncertainty.
// An unknown dispatched request retains its persistent lease across caller/runtime restarts.
export class CommercialLlmCpuLeaseScope {
  private uncertain = false;
  private running = false;
  private finished = false;
  private release: Promise<void> | null = null;

  constructor(
    private readonly lease: CommercialLlmCpuLease,
    private readonly token: string,
  ) {}

  classifier(
    client: CommercialLlmHttpClassifier,
    mayDispatch: () => boolean = () => true,
  ): CommercialLlmClassifier {
    return {
      classify: async (excerpt, signal, mayContinue) => {
        if (this.finished || this.running || this.uncertain) throw new CommercialLlmError('BUSY');
        this.running = true;
        const valid = async () =>
          !this.finished &&
          !signal?.aborted &&
          (!mayContinue || (await mayContinue())) &&
          (await this.lease.owns(this.token)) &&
          mayDispatch() &&
          !this.finished &&
          !signal?.aborted;
        try {
          return await client.classifyWithLifecycle(excerpt, signal, {
            beforeDispatch: async () => {
              if (!(await valid())) throw new CommercialLlmError('ABORTED');
              if (!(await this.lease.retainUntilReleased(this.token)))
                throw new CommercialLlmError('ABORTED');
              if (!(await valid())) throw new CommercialLlmError('ABORTED');
            },
            dispatched: () => {
              // FLAG: finish can run between beforeDispatch's resolved promise and fetch.
              // This synchronous guard must precede the actual handoff without another await.
              if (this.finished || !this.running || signal?.aborted)
                throw new CommercialLlmError('ABORTED');
              this.uncertain = true;
            },
            completed: () => {
              this.uncertain = false;
              // A late validated completion may release only this exact token; it never
              // restores expired source authority or returns a discarded classification.
              if (this.finished) void this.releaseOwned();
            },
          });
        } finally {
          this.running = false;
        }
      },
    };
  }

  async finish(): Promise<void> {
    this.finished = true;
    if (!this.uncertain) await this.releaseOwned();
  }

  private releaseOwned(): Promise<void> {
    this.release ??= this.lease.release(this.token).catch(() => undefined);
    return this.release;
  }
}
