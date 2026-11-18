import { createDefaultPrivateControlSession } from './private-control-session-normalizer';
import { PrivateControlSessionStore } from './private-control-session.store';
import type { PendingKaravanAllowlistFlow, PrivateSession } from './private-control.types';

function createStore(redisCounter?: {
  getString: jest.Mock;
  setStringWithTtl: jest.Mock;
  deleteKey: jest.Mock;
  acquireLock: jest.Mock;
  releaseLock: jest.Mock;
  replaceStringIfUnchangedWithTtl?: jest.Mock;
}) {
  return new PrivateControlSessionStore({
    redisCounter: redisCounter as never,
    logger: { warn: jest.fn() },
    normalizeSession: (raw) => raw as PrivateSession,
    createDefaultSession: () => createDefaultPrivateControlSession(),
  });
}

describe('PrivateControlSessionStore', () => {
  it.each([false, true])(
    'recovers a corrupt handoff session without overwriting a concurrent repair (%s)',
    async (concurrentRepair) => {
      let raw = '{';
      let calls = 0;
      const redis = {
        getString: jest.fn(async () => raw),
        replaceStringIfUnchangedWithTtl: jest.fn(
          async (_key: string, expected: string, next: string) => {
            if (concurrentRepair && calls++ === 0) {
              raw = JSON.stringify({
                ...createDefaultPrivateControlSession(),
                selectedChatId: 'repaired-chat',
              });
            }
            if (raw !== expected) return false;
            raw = next;
            return true;
          },
        ),
        setStringWithTtl: jest.fn(),
        deleteKey: jest.fn(),
        acquireLock: jest.fn(),
        releaseLock: jest.fn(),
      };
      const store = createStore(redis);
      const candidate: PendingKaravanAllowlistFlow = {
        chatId: 'chat',
        chatTitle: 'Chat',
        actorUserId: 'admin',
        botId: 'bot',
        nonce: 'offer',
        stage: 'await_forward',
        targetUserId: null,
        targetDisplayName: null,
        sourceMessageId: null,
        expiresAt: Date.now() + 30_000,
      };
      await expect(store.claimKaravanAllowlist('admin', 'bot', candidate)).resolves.toEqual(
        candidate,
      );
      expect(JSON.parse(raw)).toMatchObject({
        pendingKaravanAllowlist: candidate,
        selectedChatId: concurrentRepair ? 'repaired-chat' : null,
      });
    },
  );

  it('isolates mutable sessions for the same user across bots', async () => {
    const store = createStore();
    const first = createDefaultPrivateControlSession();
    first.selectedChatId = 'chat-from-bot-1';
    const second = createDefaultPrivateControlSession();
    second.selectedChatId = 'chat-from-bot-2';

    await store.saveSession('user-1', first, 'bot-1');
    await store.saveSession('user-1', second, 'bot-2');

    await expect(store.loadSession('user-1', 'bot-1')).resolves.toMatchObject({
      selectedChatId: 'chat-from-bot-1',
    });
    await expect(store.loadSession('user-1', 'bot-2')).resolves.toMatchObject({
      selectedChatId: 'chat-from-bot-2',
    });
    expect(store.sessionKey('user-1', 'bot-1')).toBe('private-ui:v2:bot-1:user-1');
  });

  it('moves a legacy user-only session to exactly one bot scope', async () => {
    const store = createStore();
    const legacy = createDefaultPrivateControlSession();
    legacy.selectedChatId = 'legacy-chat';

    await store.saveSession('user-1', legacy);

    await expect(store.loadSession('user-1', 'bot-1')).resolves.toMatchObject({
      selectedChatId: 'legacy-chat',
    });
    await expect(store.loadSession('user-1', 'bot-2')).resolves.toMatchObject({
      selectedChatId: null,
    });
    await expect(store.loadSession('user-1')).resolves.toMatchObject({ selectedChatId: null });
  });

  it('moves a legacy Redis session under a migration lock and deletes the shared key', async () => {
    const values = new Map<string, string>();
    const redisCounter = {
      getString: jest.fn(async (key: string) => values.get(key) ?? null),
      setStringWithTtl: jest.fn(async (key: string, value: string) => {
        values.set(key, value);
      }),
      deleteKey: jest.fn(async (key: string) => (values.delete(key) ? 1 : 0)),
      acquireLock: jest.fn().mockResolvedValue('migration-token'),
      releaseLock: jest.fn().mockResolvedValue(undefined),
    };
    const store = createStore(redisCounter);
    const legacy = createDefaultPrivateControlSession();
    legacy.selectedChatId = 'legacy-redis-chat';

    await store.saveSession('user-2', legacy);
    await expect(store.loadSession('user-2', 'bot-1')).resolves.toMatchObject({
      selectedChatId: 'legacy-redis-chat',
    });

    expect(redisCounter.acquireLock).toHaveBeenCalledWith(
      'private-ui:v2:user-2:migration-lock',
      5_000,
    );
    expect(redisCounter.deleteKey).toHaveBeenCalledWith('private-ui:v2:user-2');
    expect(redisCounter.releaseLock).toHaveBeenCalledWith(
      'private-ui:v2:user-2:migration-lock',
      'migration-token',
    );
    expect(values.has('private-ui:v2:bot-1:user-2')).toBe(true);
    expect(values.has('private-ui:v2:user-2')).toBe(false);
  });
});
