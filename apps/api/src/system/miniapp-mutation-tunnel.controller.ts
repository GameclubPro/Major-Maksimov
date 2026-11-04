import {
  BadRequestException,
  Controller,
  GatewayTimeoutException,
  Get,
  Headers,
  type OnModuleDestroy,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { InitDataGuard } from '../auth/init-data.guard';
import { MiniappProfiles } from '../auth/miniapp-profile';
import { MINIAPP_CSRF_HEADER_NAME } from '../auth/miniapp-session.constants';
import type { MiniappAuthContext } from '../auth/miniapp-session.types';
import { CurrentUser, type AuthUser } from '../common/decorators/current-user.decorator';
import {
  ChunkedMutationTunnelUploadStore,
  DEFAULT_CHUNKED_MUTATION_TUNNEL_UPLOAD_LIMITS,
} from './chunked-mutation-tunnel-upload.store';

const ALLOWED_TUNNEL_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const MAX_TUNNEL_BODY_LENGTH = 128 * 1024;
const MAX_CONTROL_TUNNEL_BODY_LENGTH = 16 * 1024;
const MAX_CHUNKED_TUNNEL_BODY_LENGTH = DEFAULT_CHUNKED_MUTATION_TUNNEL_UPLOAD_LIMITS.maxBodyBytes;
const MAX_CHUNKED_TUNNEL_CHUNKS = 9_000;
const MAX_CHUNKED_TUNNEL_CHUNK_ENCODED_LENGTH = 6 * 1024;
const TUNNEL_TIMEOUT_MS = 25_000;

type TunnelRouteRule = {
  method: string;
  pattern: RegExp;
  body?: {
    format: 'json-object';
    maxBytes: number;
  };
};

const ENTITY_ID_SEGMENT = '[^/?#]+';
const DIALOG_TYPE_SEGMENT = '[^/?#]+';
const PUBLISHER_VK_PARSING_PATH = `/publisher/entities/(chat|channel)/${ENTITY_ID_SEGMENT}/vk-parsing`;

const ALLOWED_TUNNEL_ROUTES: readonly TunnelRouteRule[] = [
  { method: 'POST', pattern: /^\/system\/miniapp-boot-trace$/u },
  {
    method: 'POST',
    pattern: new RegExp(
      `^/chats/${ENTITY_ID_SEGMENT}/karavan-marketplace/(setup|preview|publication-choice|handoffs|bindings/${ENTITY_ID_SEGMENT}|operations/${ENTITY_ID_SEGMENT}/cancel|connection/(binding|import-binding|operations/${ENTITY_ID_SEGMENT}/resume))$`,
    ),
  },
  {
    method: 'POST',
    pattern: new RegExp(
      `^/chats/${ENTITY_ID_SEGMENT}/bots/(primary|partner-assist|promote-standby)$`,
    ),
  },
  {
    method: 'POST',
    pattern: new RegExp(
      `^/channels/${ENTITY_ID_SEGMENT}/bots/(primary|partner-assist|promote-standby)$`,
    ),
  },
  {
    method: 'POST',
    pattern: new RegExp(`^/managed-entities/(chat|channel)/${ENTITY_ID_SEGMENT}/access/recheck$`),
  },
  {
    method: 'PUT',
    pattern: new RegExp(`^/managed-entities/(chat|channel)/${ENTITY_ID_SEGMENT}/favorites$`),
  },
  { method: 'PUT', pattern: /^\/managed-entities\/favorite-labels$/u },
  { method: 'PUT', pattern: /^\/managed-entities\/networks\/(chat|channel)\/composition$/u },
  { method: 'POST', pattern: /^\/networks\/settings\/(read|preview|apply)$/u },
  {
    method: 'POST',
    pattern:
      /^\/networks\/settings\/(required-subscription\/resolve|admin-contacts\/(read|resolve)|navigation-allowlist\/read)$/u,
  },
  { method: 'POST', pattern: /^\/managed-entities\/presentation$/u },
  {
    method: 'POST',
    pattern: new RegExp(`^/managed-entities/(chat|channel)/${ENTITY_ID_SEGMENT}/moderator$`),
  },

  {
    method: 'POST',
    pattern: new RegExp(`^/chats/${ENTITY_ID_SEGMENT}/required-subscription/channels/resolve$`),
  },
  { method: 'PUT', pattern: new RegExp(`^/chats/${ENTITY_ID_SEGMENT}/settings$`) },
  {
    method: 'PATCH',
    pattern: new RegExp(`^/chats/${ENTITY_ID_SEGMENT}/settings/speech-style$`),
  },
  {
    method: 'POST',
    pattern: new RegExp(`^/chats/${ENTITY_ID_SEGMENT}/reports/${ENTITY_ID_SEGMENT}/dismiss$`),
  },
  { method: 'PUT', pattern: new RegExp(`^/chats/${ENTITY_ID_SEGMENT}/stop-words$`) },
  { method: 'POST', pattern: new RegExp(`^/chats/${ENTITY_ID_SEGMENT}/stop-words/preview$`) },
  {
    method: 'POST',
    pattern: new RegExp(
      `^/chats/${ENTITY_ID_SEGMENT}/settings/apply-(section-to-all|section-preview|to-all)$`,
    ),
  },
  { method: 'PUT', pattern: new RegExp(`^/channels/${ENTITY_ID_SEGMENT}/settings$`) },
  {
    method: 'PATCH',
    pattern: new RegExp(`^/channels/${ENTITY_ID_SEGMENT}/post-signature$`),
  },
  { method: 'PUT', pattern: new RegExp(`^/chats/${ENTITY_ID_SEGMENT}/rules$`) },
  { method: 'POST', pattern: new RegExp(`^/chats/${ENTITY_ID_SEGMENT}/rules/(publish|handoff)$`) },
  { method: 'DELETE', pattern: new RegExp(`^/chats/${ENTITY_ID_SEGMENT}/rules/publish$`) },
  { method: 'POST', pattern: new RegExp(`^/channels/${ENTITY_ID_SEGMENT}/engagement-publish$`) },

  { method: 'POST', pattern: new RegExp(`^/chats/${ENTITY_ID_SEGMENT}/domain-allowlist$`) },
  {
    method: 'DELETE',
    pattern: new RegExp(`^/chats/${ENTITY_ID_SEGMENT}/domain-allowlist(/${ENTITY_ID_SEGMENT})?$`),
  },
  {
    method: 'PUT',
    pattern: new RegExp(
      `^/chats/${ENTITY_ID_SEGMENT}/domain-allowlist(/${ENTITY_ID_SEGMENT})?/removal-schedule$`,
    ),
  },

  {
    method: 'POST',
    pattern: new RegExp(`^/(chats|channels)/${ENTITY_ID_SEGMENT}/broadcast(/test|/handoff)?$`),
  },
  {
    method: 'DELETE',
    pattern: new RegExp(`^/(chats|channels)/${ENTITY_ID_SEGMENT}/broadcast/handoff$`),
  },
  {
    method: 'PUT',
    pattern: new RegExp(`^/(chats|channels)/${ENTITY_ID_SEGMENT}/broadcasts/${ENTITY_ID_SEGMENT}$`),
  },
  {
    method: 'DELETE',
    pattern: new RegExp(`^/(chats|channels)/${ENTITY_ID_SEGMENT}/broadcasts/${ENTITY_ID_SEGMENT}$`),
  },
  {
    method: 'POST',
    pattern: new RegExp(
      `^/(chats|channels)/${ENTITY_ID_SEGMENT}/broadcasts/${ENTITY_ID_SEGMENT}/retry$`,
    ),
  },
  {
    method: 'POST',
    pattern: new RegExp(`^/(chats|channels)/${ENTITY_ID_SEGMENT}/autopost-rules$`),
  },
  { method: 'POST', pattern: /^\/autopost-rules$/u },
  {
    method: 'PUT',
    pattern: new RegExp(
      `^/(chats|channels)/${ENTITY_ID_SEGMENT}/autopost-rules/${ENTITY_ID_SEGMENT}$`,
    ),
  },
  { method: 'PUT', pattern: new RegExp(`^/autopost-rules/${ENTITY_ID_SEGMENT}$`) },
  {
    method: 'DELETE',
    pattern: new RegExp(
      `^/(chats|channels)/${ENTITY_ID_SEGMENT}/autopost-rules/${ENTITY_ID_SEGMENT}$`,
    ),
  },
  { method: 'DELETE', pattern: new RegExp(`^/autopost-rules/${ENTITY_ID_SEGMENT}$`) },

  { method: 'POST', pattern: /^\/publications(?:\/test)?$/u },
  { method: 'POST', pattern: /^\/publications\/calendar-availability$/u },
  { method: 'POST', pattern: /^\/publications\/drafts$/u },
  { method: 'POST', pattern: /^\/publications\/video-uploads$/u },
  { method: 'POST', pattern: /^\/publications\/video-uploads\/[A-Za-z0-9_-]{16,80}\/complete$/u },
  { method: 'PUT', pattern: new RegExp(`^/publications/drafts/${ENTITY_ID_SEGMENT}$`) },
  { method: 'DELETE', pattern: new RegExp(`^/publications/drafts/${ENTITY_ID_SEGMENT}$`) },
  {
    method: 'POST',
    pattern: new RegExp(
      `^/publications/${ENTITY_ID_SEGMENT}/deliveries/${ENTITY_ID_SEGMENT}/post-actions$`,
    ),
  },
  {
    method: 'POST',
    pattern: /^\/publisher\/post-imports$/u,
  },
  { method: 'DELETE', pattern: /^\/publisher\/post-imports$/u },
  {
    method: 'PATCH',
    pattern: new RegExp(`^/publisher/entities/(chat|channel)/${ENTITY_ID_SEGMENT}/policy$`),
  },
  {
    method: 'PATCH',
    pattern: new RegExp(`^/publisher/entities/(chat|channel)/${ENTITY_ID_SEGMENT}/modules$`),
    body: { format: 'json-object', maxBytes: MAX_CONTROL_TUNNEL_BODY_LENGTH },
  },
  {
    method: 'POST',
    pattern: new RegExp(
      `^/publisher/entities/channel/${ENTITY_ID_SEGMENT}/suggestions/${ENTITY_ID_SEGMENT}/review$`,
    ),
    body: { format: 'json-object', maxBytes: MAX_CONTROL_TUNNEL_BODY_LENGTH },
  },
  {
    method: 'POST',
    pattern: new RegExp(`^/publisher/entities/(chat|channel)/${ENTITY_ID_SEGMENT}/refresh$`),
  },
  {
    method: 'POST',
    pattern: /^\/publisher\/entities\/refresh$/u,
  },
  {
    method: 'POST',
    pattern: /^\/publisher\/entities\/resolve$/u,
  },
  {
    method: 'POST',
    pattern: /^\/publisher\/entities\/refresh-selected$/u,
  },
  {
    method: 'PUT',
    pattern: new RegExp(`^/publications/${ENTITY_ID_SEGMENT}$`),
  },
  {
    method: 'DELETE',
    pattern: new RegExp(`^/publications/${ENTITY_ID_SEGMENT}$`),
  },
  {
    method: 'POST',
    pattern: new RegExp(`^/publications/${ENTITY_ID_SEGMENT}/(pause|resume|cancel)$`),
  },
  {
    method: 'POST',
    pattern: new RegExp(`^/publications/${ENTITY_ID_SEGMENT}/targets/refresh$`),
  },
  {
    method: 'POST',
    pattern: new RegExp(
      `^/publications/${ENTITY_ID_SEGMENT}/occurrences/${ENTITY_ID_SEGMENT}/(retry|resolve-ambiguous)$`,
    ),
  },

  { method: 'POST', pattern: new RegExp(`^/(chats|channels)/${ENTITY_ID_SEGMENT}/giveaways$`) },
  {
    method: 'POST',
    pattern: new RegExp(
      `^/(chats|channels)/${ENTITY_ID_SEGMENT}/giveaways/required-channels/resolve$`,
    ),
  },
  {
    method: 'PUT',
    pattern: new RegExp(`^/(chats|channels)/${ENTITY_ID_SEGMENT}/giveaways/${ENTITY_ID_SEGMENT}$`),
  },
  {
    method: 'DELETE',
    pattern: new RegExp(`^/(chats|channels)/${ENTITY_ID_SEGMENT}/giveaways/${ENTITY_ID_SEGMENT}$`),
  },
  {
    method: 'POST',
    pattern: new RegExp(
      `^/(chats|channels)/${ENTITY_ID_SEGMENT}/giveaways/${ENTITY_ID_SEGMENT}/(publish|close|reroll|deliver|cancel)$`,
    ),
  },
  {
    method: 'POST',
    pattern: new RegExp(
      `^/(chats|channels)/${ENTITY_ID_SEGMENT}/giveaways/${ENTITY_ID_SEGMENT}/refresh-publication$`,
    ),
  },
  { method: 'POST', pattern: new RegExp(`^/giveaways/${ENTITY_ID_SEGMENT}/(enter|claim)$`) },
  {
    method: 'POST',
    pattern: new RegExp(`^/(chats|channels)/${ENTITY_ID_SEGMENT}/giveaway/handoff$`),
  },

  { method: 'POST', pattern: new RegExp(`^/(chats|channels)/${ENTITY_ID_SEGMENT}/polls$`) },
  {
    method: 'PUT',
    pattern: new RegExp(`^/(chats|channels)/${ENTITY_ID_SEGMENT}/polls/${ENTITY_ID_SEGMENT}$`),
  },
  {
    method: 'DELETE',
    pattern: new RegExp(`^/(chats|channels)/${ENTITY_ID_SEGMENT}/polls/${ENTITY_ID_SEGMENT}$`),
  },
  {
    method: 'POST',
    pattern: new RegExp(
      `^/(chats|channels)/${ENTITY_ID_SEGMENT}/polls/${ENTITY_ID_SEGMENT}/(publish|close|refresh|reset-publication)$`,
    ),
  },

  {
    method: 'POST',
    pattern: new RegExp(
      `^/(chats|channels)/${ENTITY_ID_SEGMENT}/dialog/${DIALOG_TYPE_SEGMENT}/messages$`,
    ),
  },
  {
    method: 'POST',
    pattern: new RegExp(`^/channels/${ENTITY_ID_SEGMENT}/dialog/suggest/video$`),
  },
  {
    method: 'PUT',
    pattern: new RegExp(
      `^/(chats|channels)/${ENTITY_ID_SEGMENT}/dialog/${DIALOG_TYPE_SEGMENT}/notifications$`,
    ),
  },
  {
    method: 'PATCH',
    pattern: new RegExp(
      `^/(chats|channels)/${ENTITY_ID_SEGMENT}/dialog/${DIALOG_TYPE_SEGMENT}/messages/${ENTITY_ID_SEGMENT}$`,
    ),
  },
  {
    method: 'DELETE',
    pattern: new RegExp(
      `^/(chats|channels)/${ENTITY_ID_SEGMENT}/dialog/${DIALOG_TYPE_SEGMENT}/messages/${ENTITY_ID_SEGMENT}$`,
    ),
  },
  {
    method: 'POST',
    pattern: new RegExp(
      `^/(chats|channels)/${ENTITY_ID_SEGMENT}/dialog/${DIALOG_TYPE_SEGMENT}/messages/${ENTITY_ID_SEGMENT}/reactions$`,
    ),
  },

  {
    method: 'PATCH',
    pattern: new RegExp(`^${PUBLISHER_VK_PARSING_PATH}/settings$`),
  },
  {
    method: 'PATCH',
    pattern: new RegExp(`^/publisher/entities/channel/${ENTITY_ID_SEGMENT}/vk-parsing/bot-review$`),
  },
  {
    method: 'POST',
    pattern: new RegExp(
      `^/publisher/entities/channel/${ENTITY_ID_SEGMENT}/vk-parsing/bot-review/posts/${ENTITY_ID_SEGMENT}$`,
    ),
  },
  {
    method: 'POST',
    pattern: new RegExp(`^${PUBLISHER_VK_PARSING_PATH}/(rollback|refresh)$`),
  },
  {
    method: 'POST',
    pattern: new RegExp(`^${PUBLISHER_VK_PARSING_PATH}/sources(/bulk)?$`),
  },
  {
    method: 'PATCH',
    pattern: new RegExp(`^${PUBLISHER_VK_PARSING_PATH}/sources/${ENTITY_ID_SEGMENT}$`),
  },
  {
    method: 'DELETE',
    pattern: new RegExp(`^${PUBLISHER_VK_PARSING_PATH}/sources/${ENTITY_ID_SEGMENT}$`),
  },
  {
    method: 'POST',
    pattern: new RegExp(`^${PUBLISHER_VK_PARSING_PATH}/sources/${ENTITY_ID_SEGMENT}/refresh$`),
  },
  {
    method: 'PATCH',
    pattern: new RegExp(
      `^${PUBLISHER_VK_PARSING_PATH}/posts/${ENTITY_ID_SEGMENT}/(schedule|review-draft)$`,
    ),
  },
  {
    method: 'POST',
    pattern: new RegExp(
      `^${PUBLISHER_VK_PARSING_PATH}/posts/${ENTITY_ID_SEGMENT}/(retry|cancel|publish|publish-now)$`,
    ),
  },

  {
    method: 'PUT',
    pattern: new RegExp(`^/chats/${ENTITY_ID_SEGMENT}/members/${ENTITY_ID_SEGMENT}/immunity$`),
  },
  {
    method: 'POST',
    pattern: new RegExp(
      `^/chats/${ENTITY_ID_SEGMENT}/members/${ENTITY_ID_SEGMENT}/(moderation-action|profile/handoff)$`,
    ),
  },
  {
    method: 'POST',
    pattern: new RegExp(`^/chats/${ENTITY_ID_SEGMENT}/members/unavailable-cleanup$`),
  },
  {
    method: 'POST',
    pattern: new RegExp(
      `^/channels/${ENTITY_ID_SEGMENT}/members/${ENTITY_ID_SEGMENT}/(profile/handoff|ban)$`,
    ),
  },
  {
    method: 'POST',
    pattern: new RegExp(`^/chats/${ENTITY_ID_SEGMENT}/spammer-review/${ENTITY_ID_SEGMENT}$`),
  },
  { method: 'POST', pattern: new RegExp(`^/chats/${ENTITY_ID_SEGMENT}/admin-allowlist$`) },
  {
    method: 'DELETE',
    pattern: new RegExp(`^/chats/${ENTITY_ID_SEGMENT}/admin-allowlist/${ENTITY_ID_SEGMENT}$`),
  },
];

type MutationTunnelQuery = {
  method?: string;
  path?: string;
  body?: string;
  bodyGzip?: string;
  contentType?: string;
  nonce?: string;
  uploadId?: string;
  chunkIndex?: string;
  chunkCount?: string;
  chunk?: string;
  commit?: string;
};

type MutationTunnelRequest = FastifyRequest & {
  miniappAuth?: MiniappAuthContext;
};

@Controller('v1')
@UseGuards(InitDataGuard)
export class MiniappMutationTunnelController implements OnModuleDestroy {
  private readonly chunkedUploadStore = new ChunkedMutationTunnelUploadStore();

  onModuleDestroy(): void {
    this.chunkedUploadStore.dispose();
  }

  @Get('_mutation-tunnel')
  @MiniappProfiles('moderation', 'publisher')
  async tunnel(
    @Query() query: MutationTunnelQuery,
    @Headers('authorization') authorization: string | undefined,
    @CurrentUser() user: AuthUser,
    @Res() reply: FastifyReply,
    @Req() request?: MutationTunnelRequest,
  ): Promise<void> {
    const method = this.normalizeMethod(query.method);
    const target = this.normalizePath(query.path, method);

    if (query.uploadId) {
      if (this.isTruthy(query.commit)) {
        await this.commitChunkedTunnel(query, authorization, user, reply, method, target, request);
        return;
      }

      this.storeChunkedTunnelPart(query, authorization, user, reply, method, target, request);
      return;
    }

    const body = this.decodeBody(query.body, query.bodyGzip);
    const contentType = this.normalizeContentType(query.contentType, body);
    this.assertTunnelBodyConstraints(method, target, body, contentType);
    await this.forwardMutation({
      method,
      target,
      body,
      contentType,
      authorization,
      reply,
      request,
    });
  }

  private async forwardMutation(params: {
    method: string;
    target: string;
    body: string | Buffer | undefined;
    contentType: string | undefined;
    authorization: string | undefined;
    reply: FastifyReply;
    request?: MutationTunnelRequest;
  }): Promise<void> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), TUNNEL_TIMEOUT_MS);

    try {
      const response = await fetch(this.buildInternalUrl(params.target), {
        method: params.method,
        // Node fetch accepts Buffer bodies even though the DOM BodyInit declaration omits them.
        body: params.body as BodyInit | undefined,
        signal: controller.signal,
        headers: {
          Authorization: params.authorization ?? '',
          ...(params.contentType ? { 'Content-Type': params.contentType } : {}),
          ...(this.readHeader(params.request, 'cookie')
            ? { Cookie: this.readHeader(params.request, 'cookie') as string }
            : {}),
          ...(this.readHeader(params.request, MINIAPP_CSRF_HEADER_NAME)
            ? {
                'X-Miniapp-Csrf-Token': this.readHeader(
                  params.request,
                  MINIAPP_CSRF_HEADER_NAME,
                ) as string,
              }
            : {}),
          ...(this.readHeader(params.request, 'origin')
            ? { Origin: this.readHeader(params.request, 'origin') as string }
            : {}),
          ...(this.readHeader(params.request, 'sec-fetch-site')
            ? { 'Sec-Fetch-Site': this.readHeader(params.request, 'sec-fetch-site') as string }
            : {}),
          'X-Miniapp-Mutation-Tunnel': '1',
        },
      });

      const responseContentType = response.headers.get('content-type');
      if (responseContentType) {
        params.reply.header('Content-Type', responseContentType);
      }
      this.applyNoStoreHeaders(params.reply);

      const payload = await response.text();
      params.reply.status(response.status);
      if (response.status === 204 || response.status === 205 || !payload) {
        params.reply.send();
        return;
      }

      params.reply.send(payload);
    } catch (error: unknown) {
      if (controller.signal.aborted || (error instanceof Error && error.name === 'AbortError')) {
        throw new GatewayTimeoutException('Mutation tunnel timed out');
      }

      throw error;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  private storeChunkedTunnelPart(
    query: MutationTunnelQuery,
    authorization: string | undefined,
    user: AuthUser,
    reply: FastifyReply,
    method: string,
    target: string,
    request?: MutationTunnelRequest,
  ): void {
    const uploadId = this.normalizeUploadId(query.uploadId);
    const chunkIndex = this.normalizeChunkIndex(query.chunkIndex);
    const chunkCount = this.normalizeChunkCount(query.chunkCount);
    if (chunkIndex >= chunkCount) {
      throw new BadRequestException('Invalid tunnel chunk index');
    }

    const chunk = this.decodeChunk(query.chunk);
    const contentType = this.normalizeContentType(query.contentType, '');
    const authHash = this.resolveAuthBinding(authorization, request);
    const maxBodyBytes = this.resolveTunnelBodyMaxBytes(method, target);
    const progress = this.chunkedUploadStore.storeChunk({
      uploadId,
      metadata: {
        method,
        path: target,
        contentType,
        authHash,
        authUserKey: user.userId,
        chunkCount,
        maxBodyBytes,
      },
      chunkIndex,
      chunk,
    });

    this.applyNoStoreHeaders(reply);
    reply.header('Content-Type', 'application/json; charset=utf-8');
    reply.status(200);
    reply.send(
      JSON.stringify({
        ok: true,
        received: progress.receivedCount,
        total: progress.chunkCount,
      }),
    );
  }

  private async commitChunkedTunnel(
    query: MutationTunnelQuery,
    authorization: string | undefined,
    user: AuthUser,
    reply: FastifyReply,
    method: string,
    target: string,
    request?: MutationTunnelRequest,
  ): Promise<void> {
    const uploadId = this.normalizeUploadId(query.uploadId);
    const chunkCount = this.normalizeChunkCount(query.chunkCount);
    const authHash = this.resolveAuthBinding(authorization, request);
    const contentType = this.normalizeContentType(query.contentType, '');
    const maxBodyBytes = this.resolveTunnelBodyMaxBytes(method, target);
    const upload = this.chunkedUploadStore.beginCompletedUpload(uploadId, {
      method,
      path: target,
      contentType,
      authHash,
      authUserKey: user.userId,
      chunkCount,
      maxBodyBytes,
    });

    try {
      const body = Buffer.concat(upload.chunks as Buffer[], upload.receivedBytes);
      if (body.length > MAX_CHUNKED_TUNNEL_BODY_LENGTH) {
        throw new BadRequestException('Tunnel body is too large');
      }
      this.assertTunnelBodyConstraints(method, target, body, upload.contentType);

      await this.forwardMutation({
        method,
        target,
        body,
        contentType: upload.contentType,
        authorization,
        reply,
        request,
      });
    } finally {
      this.chunkedUploadStore.deleteUpload(uploadId);
    }
  }

  private normalizeMethod(value: string | undefined): string {
    const method = (value ?? '').trim().toUpperCase();
    if (!ALLOWED_TUNNEL_METHODS.has(method)) {
      throw new BadRequestException('Unsupported tunnel method');
    }

    return method;
  }

  private applyNoStoreHeaders(reply: FastifyReply): void {
    reply.header('Cache-Control', 'no-store, private');
    reply.header('Pragma', 'no-cache');
    reply.header('Vary', 'Authorization');
  }

  private normalizePath(value: string | undefined, method: string): string {
    const rawPath = (value ?? '').trim();
    if (!rawPath || !rawPath.startsWith('/') || rawPath.startsWith('//')) {
      throw new BadRequestException('Invalid tunnel path');
    }

    const parsed = new URL(rawPath, 'http://miniapp-tunnel.local');
    if (parsed.origin !== 'http://miniapp-tunnel.local') {
      throw new BadRequestException('Invalid tunnel path');
    }

    if (
      parsed.pathname === '/_mutation-tunnel' ||
      parsed.pathname.startsWith('/_mutation-tunnel/')
    ) {
      throw new BadRequestException('Invalid tunnel target');
    }

    const normalized = `${parsed.pathname}${parsed.search}`;
    if (!this.isAllowedTunnelTarget(normalized, method)) {
      throw new BadRequestException('Unsupported tunnel target');
    }

    return normalized;
  }

  private decodeBody(value: string | undefined, gzipValue: string | undefined): string | undefined {
    if (value && gzipValue) {
      throw new BadRequestException('Ambiguous tunnel body');
    }

    if (!value && !gzipValue) {
      return undefined;
    }

    const encodedValue = value ?? gzipValue;
    if (!encodedValue) {
      return undefined;
    }

    if (encodedValue.length > MAX_TUNNEL_BODY_LENGTH) {
      throw new BadRequestException('Tunnel body is too large');
    }

    const decoded = this.decodeBase64Url(encodedValue);
    const bodyBuffer = gzipValue ? this.gunzipBody(decoded) : decoded;
    if (bodyBuffer.length > MAX_TUNNEL_BODY_LENGTH) {
      throw new BadRequestException('Tunnel body is too large');
    }

    return bodyBuffer.toString('utf8');
  }

  private decodeBase64Url(value: string): Buffer {
    if (!/^[A-Za-z0-9_-]+$/u.test(value) || value.length % 4 === 1) {
      throw new BadRequestException('Invalid tunnel body');
    }

    const padded = value.padEnd(value.length + ((4 - (value.length % 4)) % 4), '=');
    return Buffer.from(padded.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
  }

  private gunzipBody(value: Buffer): Buffer {
    try {
      return gunzipSync(value, { maxOutputLength: MAX_TUNNEL_BODY_LENGTH });
    } catch {
      throw new BadRequestException('Invalid tunnel body');
    }
  }

  private normalizeContentType(
    value: string | undefined,
    body: string | undefined,
  ): string | undefined {
    const contentType = (value ?? '').trim();
    if (contentType) {
      return contentType;
    }

    return body === undefined ? undefined : 'application/json';
  }

  private normalizeUploadId(value: string | undefined): string {
    const uploadId = (value ?? '').trim();
    if (!/^[A-Za-z0-9_-]{16,96}$/u.test(uploadId)) {
      throw new BadRequestException('Invalid tunnel upload id');
    }

    return uploadId;
  }

  private normalizeChunkIndex(value: string | undefined): number {
    const chunkIndex = Number.parseInt((value ?? '').trim(), 10);
    if (!Number.isSafeInteger(chunkIndex) || chunkIndex < 0) {
      throw new BadRequestException('Invalid tunnel chunk index');
    }

    return chunkIndex;
  }

  private normalizeChunkCount(value: string | undefined): number {
    const chunkCount = Number.parseInt((value ?? '').trim(), 10);
    if (
      !Number.isSafeInteger(chunkCount) ||
      chunkCount < 1 ||
      chunkCount > MAX_CHUNKED_TUNNEL_CHUNKS
    ) {
      throw new BadRequestException('Invalid tunnel chunk count');
    }

    return chunkCount;
  }

  private decodeChunk(value: string | undefined): Buffer {
    const chunk = (value ?? '').trim();
    if (!chunk) {
      throw new BadRequestException('Invalid tunnel chunk');
    }
    if (chunk.length > MAX_CHUNKED_TUNNEL_CHUNK_ENCODED_LENGTH) {
      throw new BadRequestException('Tunnel chunk is too large');
    }

    return this.decodeBase64Url(chunk);
  }

  private isTruthy(value: string | undefined): boolean {
    return ['1', 'true', 'yes'].includes((value ?? '').trim().toLowerCase());
  }

  private hashAuthorization(value: string | undefined): string {
    return createHash('sha256')
      .update(value ?? '')
      .digest('hex');
  }

  private resolveAuthBinding(
    authorization: string | undefined,
    request: MutationTunnelRequest | undefined,
  ): string {
    return request?.miniappAuth?.principalKey ?? this.hashAuthorization(authorization);
  }

  private readHeader(request: MutationTunnelRequest | undefined, name: string): string | undefined {
    const value = request?.headers[name];
    return Array.isArray(value) ? value[0] : value;
  }

  private buildInternalUrl(target: string): string {
    const port = Number(process.env.PORT ?? 3001);
    return `http://127.0.0.1:${port}/api/v1${target}`;
  }

  private assertTunnelBodyConstraints(
    method: string,
    target: string,
    body: string | Buffer | undefined,
    contentType: string | undefined,
  ): void {
    const rule = this.findAllowedTunnelRule(target, method);
    if (!rule?.body) {
      return;
    }
    if (body === undefined) {
      throw new BadRequestException('Tunnel body is required');
    }

    const bodyBuffer = typeof body === 'string' ? Buffer.from(body, 'utf8') : body;
    if (bodyBuffer.length === 0 || bodyBuffer.length > rule.body.maxBytes) {
      throw new BadRequestException('Invalid tunnel body size');
    }
    const mediaType = (contentType ?? '').split(';', 1)[0]?.trim().toLowerCase();
    if (mediaType !== 'application/json') {
      throw new BadRequestException('Tunnel body must be JSON');
    }

    try {
      const value: unknown = JSON.parse(bodyBuffer.toString('utf8'));
      if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error('Expected JSON object');
      }
    } catch {
      throw new BadRequestException('Tunnel body must be a JSON object');
    }
  }

  private findAllowedTunnelRule(target: string, method: string): TunnelRouteRule | undefined {
    const parsed = new URL(target, 'http://miniapp-tunnel.local');
    const pathname = parsed.pathname;
    return ALLOWED_TUNNEL_ROUTES.find(
      (rule) => rule.method === method && rule.pattern.test(pathname),
    );
  }

  private resolveTunnelBodyMaxBytes(method: string, target: string): number {
    return Math.min(
      MAX_CHUNKED_TUNNEL_BODY_LENGTH,
      this.findAllowedTunnelRule(target, method)?.body?.maxBytes ?? MAX_CHUNKED_TUNNEL_BODY_LENGTH,
    );
  }

  private isAllowedTunnelTarget(target: string, method: string): boolean {
    return this.findAllowedTunnelRule(target, method) !== undefined;
  }
}
