import { ServiceUnavailableException, type Logger } from '@nestjs/common';
import { SESSION_KEY_PREFIX, SESSION_TTL_SEC } from './private-control.constants';
import type { PendingKaravanAllowlistFlow, PrivateSession } from './private-control.types';
import type { RedisCounterService } from './redis-counter.service';

const LEGACY_SESSION_MIGRATION_LOCK_TTL_MS = 5_000;

export class PrivateControlSessionStore {
  private readonly memorySession = new Map<
    string,
    { expiresAt: number; session: PrivateSession }
  >();

  constructor(
    private readonly options: {
      redisCounter?: RedisCounterService;
      logger: Pick<Logger, 'warn'>;
      normalizeSession(raw: unknown): PrivateSession;
      createDefaultSession(): PrivateSession;
    },
  ) {}

  async loadSession(userId: string, botId?: string | null): Promise<PrivateSession> {
    const sessionKey = this.sessionKey(userId, botId);
    const scopedSession = await this.loadStoredSession(sessionKey, userId);
    if (scopedSession) {
      return scopedSession;
    }

    if (this.normalizeBotId(botId)) {
      const migratedLegacySession = await this.migrateLegacySession(userId, sessionKey);
      if (migratedLegacySession) {
        return migratedLegacySession;
      }
    }

    return this.options.createDefaultSession();
  }

  private async loadStoredSession(
    sessionKey: string,
    userId: string,
  ): Promise<PrivateSession | null> {
    if (this.options.redisCounter) {
      const raw = await this.options.redisCounter.getString(sessionKey);
      const session = this.parseStoredSession(raw, userId);
      if (session) return session;
    }

    const memory = this.memorySession.get(sessionKey);
    if (memory && memory.expiresAt > Date.now()) {
      return this.options.normalizeSession(memory.session);
    }

    return null;
  }

  private parseStoredSession(raw: string | null, userId: string): PrivateSession | null {
    if (!raw) return null;
    try {
      return this.options.normalizeSession(JSON.parse(raw));
    } catch {
      this.options.logger.warn({ userId }, 'Failed to parse private control session from redis');
      return null;
    }
  }

  async loadSessionForDiagnostics(
    userId: string,
    botId?: string | null,
  ): Promise<PrivateSession | null> {
    try {
      return await this.loadSession(userId, botId);
    } catch (error: unknown) {
      this.options.logger.warn(
        {
          userId,
          err: error instanceof Error ? error.message : String(error),
        },
        'Failed to load private control session for diagnostics',
      );
      return null;
    }
  }

  async saveSession(userId: string, session: PrivateSession, botId?: string | null): Promise<void> {
    const normalized = this.options.normalizeSession(session);
    const sessionKey = this.sessionKey(userId, botId);

    await this.persistStoredSession(sessionKey, normalized);
  }

  async claimKaravanAllowlist(
    userId: string,
    botId: string | null,
    candidate: PendingKaravanAllowlistFlow,
  ): Promise<PendingKaravanAllowlistFlow> {
    const key = this.sessionKey(userId, botId);
    const redis = this.options.redisCounter;
    if (!redis) {
      const row = this.memorySession.get(key);
      const session =
        row && row.expiresAt > Date.now()
          ? this.options.normalizeSession(row.session)
          : this.options.createDefaultSession();
      const existing = session.pendingKaravanAllowlist;
      if (existing && existing.expiresAt > Date.now()) return existing;
      session.pendingKaravanAllowlist = candidate;
      this.memorySession.set(key, { session, expiresAt: Date.now() + SESSION_TTL_SEC * 1_000 });
      return candidate;
    }
    // FLAG: Concurrent handoffs must share the winning nonce without replacing other private input.
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const raw = await redis.getString(key);
      const session = this.parseStoredSession(raw, userId) ?? this.options.createDefaultSession();
      const existing = session.pendingKaravanAllowlist;
      if (existing && existing.expiresAt > Date.now()) return existing;
      session.pendingKaravanAllowlist = candidate;
      const value = JSON.stringify(session);
      const saved =
        raw === null
          ? await redis.setStringIfAbsentWithTtl(key, value, SESSION_TTL_SEC)
          : await redis.replaceStringIfUnchangedWithTtl(key, raw, value, SESSION_TTL_SEC);
      if (saved) return candidate;
    }
    throw new ServiceUnavailableException('Настройки изменились. Повторите добавление.');
  }

  private async persistStoredSession(sessionKey: string, session: PrivateSession): Promise<void> {
    const normalized = this.options.normalizeSession(session);

    if (this.options.redisCounter) {
      await this.options.redisCounter.setStringWithTtl(
        sessionKey,
        JSON.stringify(normalized),
        SESSION_TTL_SEC,
      );
      return;
    }

    this.memorySession.set(sessionKey, {
      expiresAt: Date.now() + SESSION_TTL_SEC * 1_000,
      session: normalized,
    });
  }

  private async migrateLegacySession(
    userId: string,
    scopedSessionKey: string,
  ): Promise<PrivateSession | null> {
    const legacySessionKey = this.legacySessionKey(userId);
    const lockKey = `${legacySessionKey}:migration-lock`;
    const lockToken = this.options.redisCounter
      ? await this.options.redisCounter.acquireLock(lockKey, LEGACY_SESSION_MIGRATION_LOCK_TTL_MS)
      : 'memory';
    if (!lockToken) {
      return null;
    }

    try {
      const legacySession = await this.loadStoredSession(legacySessionKey, userId);
      if (!legacySession) {
        return null;
      }

      await this.persistStoredSession(scopedSessionKey, legacySession);
      if (this.options.redisCounter) {
        await this.options.redisCounter.deleteKey(legacySessionKey);
      }
      this.memorySession.delete(legacySessionKey);
      return legacySession;
    } finally {
      if (this.options.redisCounter) {
        await this.options.redisCounter.releaseLock(lockKey, lockToken).catch((error: unknown) => {
          this.options.logger.warn(
            {
              userId,
              err: error instanceof Error ? error.message : String(error),
            },
            'Failed to release private control legacy session migration lock',
          );
        });
      }
    }
  }

  sessionKey(userId: string, botId?: string | null): string {
    const normalizedBotId = this.normalizeBotId(botId);
    if (normalizedBotId) {
      return `${SESSION_KEY_PREFIX}:${encodeURIComponent(normalizedBotId)}:${userId}`;
    }

    return this.legacySessionKey(userId);
  }

  private legacySessionKey(userId: string): string {
    return `${SESSION_KEY_PREFIX}:${userId}`;
  }

  private normalizeBotId(botId: string | null | undefined): string | null {
    const normalized = typeof botId === 'string' ? botId.trim() : '';
    return normalized || null;
  }
}
