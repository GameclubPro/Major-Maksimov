import { Injectable, Optional } from '@nestjs/common';
import { AsyncLocalStorage } from 'node:async_hooks';
import { Prisma } from '../prisma/prisma-client';
import { PrismaService } from '../prisma/prisma.service';
import { StorageRuntimeMetricsService } from '../system/storage-runtime-metrics.service';
import {
  optimizationElapsed,
  optimizationNow,
  type DeleteAuthorModule,
} from '../system/optimization-runtime-metrics';
import { MaxClientService, type MaxChatMemberAccess } from './max-client.service';

export type AutomaticDeleteMemberReadOptions = NonNullable<
  Parameters<MaxClientService['getChatMemberAccess']>[2]
>;
export type AutomaticDeleteAdminProtection = {
  initialized: boolean;
  isAdmin: boolean;
  revision: string | null;
};
export type AutomaticDeleteAuthorAccess = AutomaticDeleteAdminProtection & {
  // Undefined means no membership observation was needed. It never proves membership.
  member: MaxChatMemberAccess | null | undefined;
};
type DispatchReads = {
  protection: Map<string, Promise<AutomaticDeleteAdminProtection>>;
  membership: Map<string, Promise<MaxChatMemberAccess | null>>;
};

export class AutomaticDeleteAuthorProtectedError extends Error {
  readonly code = 'automatic_delete_author_protected';
  constructor() {
    super('Saved administrator protection revoked automatic deletion');
  }
}

export function automaticDeleteUserIdVariants(userId: string): string[] {
  const normalized = userId.trim().toLowerCase();
  if (!normalized) throw new Error('Automatic deletion requires an exact author');
  return [
    ...new Set([
      normalized,
      normalized.startsWith('id') && normalized.length > 2
        ? normalized.slice(2)
        : `id${normalized}`,
    ]),
  ];
}

export function automaticDeleteAdminProtectionQuery(chatId: string, userId: string): Prisma.Sql {
  const variants = automaticDeleteUserIdVariants(userId);
  return Prisma.sql`
    SELECT state.revision::text AS revision,
      (state.completed_at IS NOT NULL AND state.complete_probe_started_at IS NOT NULL)
        AS initialized,
      EXISTS (SELECT 1 FROM chat_admin_allowlist a
        WHERE a.chat_id = c.id AND a.user_id IN (${Prisma.join(variants)})) AS "isAdmin"
    FROM chats c
    LEFT JOIN chat_admin_roster_states state ON state.chat_id = c.id
    WHERE c.id = ${chatId}
  `;
}

@Injectable()
export class AutomaticDeleteAuthorAccessService {
  private readonly dispatch = new AsyncLocalStorage<DispatchReads>();
  private readonly counts = { roster: 0, protected: 0, legacy: 0, membership: 0, shared: 0 };

  constructor(
    private readonly prisma: PrismaService,
    private readonly maxClient: MaxClientService,
    @Optional() private readonly metrics?: StorageRuntimeMetricsService,
  ) {
    metrics?.registerAutomaticDeleteAuthorSnapshot(() => this.getSnapshot());
  }

  withDispatchScope<T>(work: () => Promise<T>): Promise<T> {
    // FLAG: Read sharing belongs to this one preparation attempt, never a queued retry,
    // another bot route, a sanction or a notice. Fresh final protection bypasses this scope.
    return this.dispatch.run({ protection: new Map(), membership: new Map() }, work);
  }

  async readCurrentProtection(
    chatId: string,
    userId: string,
  ): Promise<AutomaticDeleteAdminProtection> {
    const [row] = await this.prisma.$queryRaw<AutomaticDeleteAdminProtection[]>(
      automaticDeleteAdminProtectionQuery(chatId, userId),
    );
    return {
      initialized: row?.initialized === true,
      isAdmin: row?.isAdmin === true,
      revision: row?.revision ?? null,
    };
  }

  async resolve(
    chatId: string,
    userId: string,
    options: AutomaticDeleteMemberReadOptions,
    policy: { requireMembership: boolean; module?: DeleteAuthorModule },
  ): Promise<AutomaticDeleteAuthorAccess> {
    const started = optimizationNow();
    let failed = true;
    this.metrics?.optimization.author(policy.module, 'calls');
    try {
      const result = await this.resolveAuthor(chatId, userId, options, policy);
      failed = false;
      return result;
    } catch (error) {
      this.metrics?.optimization.author(policy.module, 'errors');
      throw error;
    } finally {
      this.metrics?.optimization.timing('author', optimizationElapsed(started), failed);
    }
  }

  private async resolveAuthor(
    chatId: string,
    userId: string,
    options: AutomaticDeleteMemberReadOptions,
    policy: { requireMembership: boolean; module?: DeleteAuthorModule },
  ): Promise<AutomaticDeleteAuthorAccess> {
    const scope = this.dispatch.getStore();
    const protectionKey = JSON.stringify([chatId, userId]);
    let pendingProtection = scope?.protection.get(protectionKey);
    if (!pendingProtection) {
      pendingProtection = this.readCurrentProtection(chatId, userId);
      scope?.protection.set(protectionKey, pendingProtection);
    }
    const protection = await pendingProtection;
    if (!protection.initialized) this.metrics?.optimization.author(policy.module, 'missingRoster');
    if (protection.isAdmin) {
      this.counts.protected += 1;
      this.metrics?.optimization.author(policy.module, 'protectedSkips');
      return { ...protection, member: undefined };
    }
    if (protection.initialized) this.counts.roster += 1;
    else this.counts.legacy += 1;
    if (protection.initialized && !policy.requireMembership) {
      this.metrics?.optimization.author(policy.module, 'rosterSkips');
      return { ...protection, member: undefined };
    }
    if (policy.requireMembership)
      this.metrics?.optimization.author(policy.module, 'membershipRequired');

    const membershipKey = JSON.stringify([
      chatId,
      userId,
      options.botId ?? null,
      options.timeoutMs ?? null,
      options.sourceTag ?? null,
      options.trafficClass ?? null,
    ]);
    let pendingMember = scope?.membership.get(membershipKey);
    if (pendingMember) {
      this.counts.shared += 1;
      this.metrics?.optimization.author(policy.module, 'sharedReads');
    } else {
      this.counts.membership += 1;
      this.metrics?.optimization.author(policy.module, 'memberCalls');
      pendingMember = this.maxClient.getChatMemberAccess(chatId, userId, {
        ...options,
        bypassCache: true,
      });
      scope?.membership.set(membershipKey, pendingMember);
    }
    const member = await pendingMember;
    // FLAG: The complete saved roster owns DELETE immunity only. A real membership
    // observation remains separate and cannot grant a sanction or fabricate a human member.
    return {
      ...protection,
      isAdmin: protection.initialized ? false : !!(member?.isAdmin || member?.isOwner),
      member,
    };
  }

  getSnapshot(): Readonly<typeof this.counts> {
    return { ...this.counts };
  }
}
