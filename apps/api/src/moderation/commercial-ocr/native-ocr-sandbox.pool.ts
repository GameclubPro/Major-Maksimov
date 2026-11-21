import { Injectable, type OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import {
  NativeOcrSandboxClient,
  NativeOcrSandboxRequestError,
  NativeOcrSandboxRequestTimeoutError,
  NativeOcrSandboxUnavailableError,
  type NativeOcrSandboxBoundaryStatus,
} from './native-ocr-sandbox.client';
import {
  NATIVE_OCR_SANDBOX_POOL_SOCKET_PATHS_ENV,
  NATIVE_OCR_SANDBOX_SOCKET_PATH_ENV,
  resolveNativeOcrSandboxExtraPaths,
} from './native-ocr-sandbox.protocol';

type Lane = { client: NativeOcrSandboxClient; occupied: boolean };

@Injectable()
export class NativeOcrSandboxPool implements OnModuleDestroy {
  private readonly lanes: readonly Lane[];
  private lastAssigned = -1;

  constructor(config: ConfigService) {
    const extras = resolveNativeOcrSandboxExtraPaths(
      config.get(NATIVE_OCR_SANDBOX_SOCKET_PATH_ENV),
      config.get(NATIVE_OCR_SANDBOX_POOL_SOCKET_PATHS_ENV),
    );
    this.lanes = [
      new NativeOcrSandboxClient(config),
      ...extras.map(
        (path) =>
          new NativeOcrSandboxClient({
            get: (key) => (key === NATIVE_OCR_SANDBOX_SOCKET_PATH_ENV ? path : config.get(key)),
          }),
      ),
    ].map((client) => ({ client, occupied: false }));
  }

  get count(): number {
    return this.lanes.length;
  }

  isConfigured(): boolean {
    return this.lanes[0]!.client.isConfigured();
  }

  isRequired(): boolean {
    return this.lanes[0]!.client.isRequired();
  }

  isVerified(): boolean {
    return this.lanes.some(({ client }) => client.isVerified());
  }

  getStatuses(): readonly NativeOcrSandboxBoundaryStatus[] {
    return this.lanes.map(({ client }) => client.getStatus());
  }

  getStatus(): NativeOcrSandboxBoundaryStatus {
    return this.getStatuses()[0]!;
  }

  async probe() {
    if (this.count === 1) return this.lanes[0]!.client.probe();
    // Probe every lane independently. A broken lane cannot revoke a healthy sibling.
    return Promise.any(this.lanes.map(({ client }) => client.probe())).catch(
      (error: AggregateError) => {
        throw (
          error.errors.find(
            (cause: unknown) =>
              cause instanceof NativeOcrSandboxUnavailableError && cause.reason !== 'unavailable',
          ) ?? new NativeOcrSandboxUnavailableError('unavailable')
        );
      },
    );
  }

  preprocess(...args: Parameters<NativeOcrSandboxClient['preprocess']>) {
    return this.dispatch((client) => client.preprocess(...args));
  }

  recognize(...args: Parameters<NativeOcrSandboxClient['recognize']>) {
    return this.dispatch((client) => client.recognize(...args));
  }

  close(): void {
    for (const { client } of this.lanes) client.close();
  }

  onModuleDestroy(): void {
    this.close();
  }

  private async dispatch<T>(send: (client: NativeOcrSandboxClient) => Promise<T>): Promise<T> {
    if (this.count === 1) return send(this.lanes[0]!.client);
    if (!this.isVerified()) await this.probe();
    for (let offset = 1; offset <= this.count; offset += 1) {
      const index = (this.lastAssigned + offset) % this.count;
      const lane = this.lanes[index]!;
      if (lane.occupied || !lane.client.isVerified()) continue;
      lane.occupied = true;
      this.lastAssigned = index;
      try {
        return await send(lane.client);
      } catch (error: unknown) {
        if (
          error instanceof NativeOcrSandboxUnavailableError ||
          error instanceof NativeOcrSandboxRequestTimeoutError
        ) {
          lane.client.invalidateVerification();
        }
        // FLAG: Do not send the same operation to another lane while its completion is uncertain.
        throw error;
      } finally {
        lane.occupied = false;
      }
    }
    throw new NativeOcrSandboxRequestError('capacity_exhausted');
  }
}
