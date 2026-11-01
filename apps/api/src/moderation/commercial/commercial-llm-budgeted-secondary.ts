import type { CommercialLlmClassifier } from './commercial-llm.protocol';
import { CommercialLlmError, type CommercialLlmHttpClassifier } from './commercial-llm.client';
import type { CommercialLlmShadowLease } from './commercial-llm-shadow.lease';
import { CommercialLlmCpuLeaseScope } from './commercial-llm-cpu-lease-scope';

// FLAG: The workstation has its own admission; the server retains its shared rate and lease.
export class CommercialLlmBudgetedSecondary implements CommercialLlmClassifier {
  constructor(
    private readonly lease: Pick<
      CommercialLlmShadowLease,
      'acquire' | 'owns' | 'retainUntilReleased' | 'release'
    >,
    private readonly client: CommercialLlmHttpClassifier,
  ) {}

  async classify(excerpt: string, signal?: AbortSignal, mayContinue?: () => Promise<boolean>) {
    if (signal?.aborted || (mayContinue && !(await mayContinue())))
      throw new CommercialLlmError('ABORTED');
    const token = await this.lease.acquire();
    if (!token) throw new CommercialLlmError('BUSY');
    const scope = new CommercialLlmCpuLeaseScope(this.lease, token);
    const valid = async () =>
      !signal?.aborted && (await this.lease.owns(token)) && (!mayContinue || (await mayContinue()));
    try {
      if (!(await valid())) throw new CommercialLlmError('ABORTED');
      const result = await scope.classifier(this.client).classify(excerpt, signal, valid);
      // FLAG: A server result cannot escape a lost lease or revive expired source authority.
      if (!(await valid())) throw new CommercialLlmError('ABORTED');
      return result;
    } finally {
      await scope.finish();
    }
  }
}
