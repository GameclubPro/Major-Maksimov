import { isMaxMutationOutcomeAmbiguous } from '../max/max-mutation-outcome.util';

type PrivateHandoffSendResult<T> = { outcome: 'sent'; receipt: T } | { outcome: 'rejected' };

export async function trySendPrivateHandoff<T>(
  send: () => Promise<T>,
  onFailure: (error: unknown) => void,
): Promise<PrivateHandoffSendResult<T>> {
  try {
    return { outcome: 'sent', receipt: await send() };
  } catch (error: unknown) {
    onFailure(error);
    // FLAG: A private handoff fallback must not repeat an uncertain MAX SEND.
    if (isMaxMutationOutcomeAmbiguous(error)) throw error;
    return { outcome: 'rejected' };
  }
}
