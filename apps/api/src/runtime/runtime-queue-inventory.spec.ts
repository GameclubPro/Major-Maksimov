import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  AUXILIARY_QUEUE_NAMES,
  RETENTION_PRIORITY_ADDITIONAL_QUEUE_NAMES,
} from './runtime-queue-inventory';
import { RETENTION_PRIORITY_QUEUE_NAMES } from '../max/retention-priority-admission';

const QUEUE_EXPORTS = [
  ['admin/admin-managed-entities-refresh.queue.ts', 'ADMIN_MANAGED_ENTITIES_REFRESH_QUEUE'],
  ['admin/vk-parsing.queue.ts', 'VK_PARSING_SYNC_QUEUE'],
  ['admin/vk-parsing.queue.ts', 'VK_PARSING_PUBLISHER_QUEUE'],
  ['publisher/publisher-binding-refresh.queue.ts', 'PUBLISHER_BINDING_REFRESH_QUEUE'],
  ['publisher/publisher-chat-comment.queue.ts', 'PUBLISHER_CHAT_COMMENT_QUEUE'],
  ['publisher/publisher-post-import.queue.ts', 'PUBLISHER_POST_IMPORT_QUEUE'],
  ['publisher/publisher-auto-reply.queue.ts', 'PUBLISHER_AUTO_REPLY_QUEUE'],
  ['publisher/publisher-auto-reply-authoring.queue.ts', 'PUBLISHER_AUTO_REPLY_AUTHORING_QUEUE'],
  ['admin/publisher-suggestion-publication.queue.ts', 'PUBLISHER_SUGGESTION_PUBLICATION_QUEUE'],
  ['admin/publisher-publication-wakeup.queue.ts', 'PUBLISHER_PUBLICATION_WAKEUP_QUEUE'],
  ['publisher/publisher-suggestion-admin.queue.ts', 'PUBLISHER_SUGGESTION_ADMIN_QUEUE'],
  ['publisher/publisher-start.queue.ts', 'PUBLISHER_START_QUEUE'],
  ['publisher/publisher-video-upload.queue.ts', 'PUBLISHER_VIDEO_UPLOAD_QUEUE'],
  ['moderation/night-mode-transition.queue.ts', 'NIGHT_MODE_TRANSITION_QUEUE'],
  ['max/max-chat-admin-roster-sync.queue.ts', 'MAX_CHAT_ADMIN_ROSTER_SYNC_QUEUE'],
  ['admin/admin-manual-fanout.queue.ts', 'ADMIN_MANUAL_FANOUT_QUEUE'],
  ['admin/admin-manual-command.queue.ts', 'ADMIN_MANUAL_COMMAND_QUEUE'],
  ['admin/admin-super-ban.queue.ts', 'ADMIN_SUPER_BAN_QUEUE'],
  ['admin/admin-suggestion-delivery.queue.ts', 'ADMIN_SUGGESTION_DELIVERY_QUEUE'],
  ['moderation/moderation-delete-intent.queue.ts', 'MODERATION_DELETE_INTENT_QUEUE'],
  ['moderation/message-duplicate/message-duplicate.queue.ts', 'MESSAGE_DUPLICATE_QUEUE'],
  ['moderation/commercial-ocr/commercial-ocr.queue.ts', 'COMMERCIAL_OCR_QUEUE'],
] as const;

describe('runtime queue inventory boundary', () => {
  it('does not import runtime services into MAX transport initialization', () => {
    const source = readFileSync(resolve(__dirname, 'runtime-queue-inventory.ts'), 'utf8');
    expect(source).not.toMatch(/^\s*(?:import\s|export\s+[^\n]*\sfrom\s)/m);
    expect(source).not.toMatch(/\b(?:require|import)\s*\(/);
  });

  it('matches the literal queue exports without loading their decorated modules', () => {
    const actualNames = QUEUE_EXPORTS.map(([file, exportName]) => {
      const source = readFileSync(resolve(__dirname, '..', file), 'utf8');
      const match = source.match(
        new RegExp(`^export const ${exportName} = ['"]([^'"]+)['"];`, 'm'),
      );
      if (!match) throw new Error(`Missing literal queue export ${exportName} in ${file}`);
      return match[1];
    });
    expect(AUXILIARY_QUEUE_NAMES).toEqual(['message-retention', ...actualNames]);
    expect(new Set(AUXILIARY_QUEUE_NAMES).size).toBe(AUXILIARY_QUEUE_NAMES.length);
  });

  it('includes every declared queue even when it has no dashboard counter', () => {
    const queueFiles = (directory: string): string[] =>
      readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
        const path = resolve(directory, entry.name);
        return entry.isDirectory()
          ? queueFiles(path)
          : entry.name.endsWith('.queue.ts')
            ? [path]
            : [];
      });
    const declaredNames = queueFiles(resolve(__dirname, '..')).flatMap((file) =>
      Array.from(
        readFileSync(file, 'utf8').matchAll(/^export const [A-Z_]+QUEUE = ['"]([^'"]+)['"];$/gm),
        (match) => match[1],
      ),
    );
    for (const name of declaredNames) expect(RETENTION_PRIORITY_QUEUE_NAMES).toContain(name);
    expect(RETENTION_PRIORITY_ADDITIONAL_QUEUE_NAMES).toEqual([
      'marketplace-publisher-access',
      'photo-duplicates',
    ]);
    expect(RETENTION_PRIORITY_QUEUE_NAMES).not.toContain('message-retention');
  });
});
