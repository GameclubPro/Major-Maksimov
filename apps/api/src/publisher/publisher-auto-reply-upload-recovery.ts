import { Prisma } from '../prisma/prisma-client';

const UPLOAD_RECOVERY_BATCH_SIZE = 100;

export type PublisherAutoReplyUploadRecoveryCursor = {
  id: string;
  lockedAt: Date | null;
  updatedAt: Date;
};
export type PublisherAutoReplyUploadRecoveryRow = {
  changed_count: bigint;
  candidate_count: bigint;
  last_id: string | null;
  last_locked_at: Date | null;
  last_updated_at: Date | null;
};

export function buildPublisherAutoReplyUploadRecoveryQuery(
  now: Date,
  staleBefore: Date,
  cursor: PublisherAutoReplyUploadRecoveryCursor | null = null,
): Prisma.Sql {
  const nullAfter = !cursor
    ? Prisma.empty
    : cursor.lockedAt
      ? Prisma.sql`AND FALSE`
      : Prisma.sql`AND (updated_at, id) > (${cursor.updatedAt}, ${cursor.id})`;
  const expiredAfter = cursor?.lockedAt
    ? Prisma.sql`AND (locked_at, updated_at, id) > (${cursor.lockedAt}, ${cursor.updatedAt}, ${cursor.id})`
    : Prisma.empty;
  // FLAG: Limit each indexed range before sorting ties or skipping locks. A locked
  // prefix must never turn a 100-row repair into an unbounded row-lock scan.
  return Prisma.sql`
    WITH null_candidates AS MATERIALIZED (
      SELECT id, locked_at, lock_token, updated_at
      FROM publisher_auto_reply_asset_uploads
      WHERE status = 'UPLOADING' AND locked_at IS NULL ${nullAfter}
      ORDER BY locked_at, updated_at, id
      LIMIT ${UPLOAD_RECOVERY_BATCH_SIZE}
    ), expired_candidates AS MATERIALIZED (
      SELECT id, locked_at, lock_token, updated_at
      FROM publisher_auto_reply_asset_uploads
      WHERE status = 'UPLOADING' AND locked_at <= ${staleBefore} ${expiredAfter}
      ORDER BY locked_at, updated_at, id
      LIMIT ${UPLOAD_RECOVERY_BATCH_SIZE}
    ), candidates AS MATERIALIZED (
      SELECT * FROM (
        SELECT * FROM null_candidates
        UNION ALL
        SELECT * FROM expired_candidates
      ) bounded
      ORDER BY locked_at NULLS FIRST, updated_at, id
      LIMIT ${UPLOAD_RECOVERY_BATCH_SIZE}
    ), locked AS MATERIALIZED (
      SELECT exact.* FROM candidates candidate
      CROSS JOIN LATERAL (
        SELECT upload.id, upload.locked_at, upload.lock_token
        FROM publisher_auto_reply_asset_uploads upload
        WHERE upload.id = candidate.id
          AND upload.status = 'UPLOADING'
          AND upload.locked_at IS NOT DISTINCT FROM candidate.locked_at
          AND upload.lock_token IS NOT DISTINCT FROM candidate.lock_token
          AND (upload.locked_at IS NULL OR upload.locked_at <= ${staleBefore})
        LIMIT 1 FOR UPDATE OF upload SKIP LOCKED
      ) exact
    ), changed AS (
      UPDATE publisher_auto_reply_asset_uploads upload
      SET status = 'PENDING', locked_at = NULL, lock_token = NULL,
        failure_code = 'STALE_UPLOAD_LEASE', updated_at = ${now}
      FROM locked
      WHERE upload.id = locked.id AND upload.status = 'UPLOADING'
        AND upload.locked_at IS NOT DISTINCT FROM locked.locked_at
        AND upload.lock_token IS NOT DISTINCT FROM locked.lock_token
        AND (upload.locked_at IS NULL OR upload.locked_at <= ${staleBefore})
      RETURNING upload.id
    )
    SELECT (SELECT count(*) FROM changed) AS changed_count,
      (SELECT count(*) FROM candidates) AS candidate_count,
      (SELECT id FROM candidates ORDER BY locked_at DESC NULLS LAST, updated_at DESC, id DESC LIMIT 1) AS last_id,
      (SELECT locked_at FROM candidates ORDER BY locked_at DESC NULLS LAST, updated_at DESC, id DESC LIMIT 1) AS last_locked_at,
      (SELECT updated_at FROM candidates ORDER BY locked_at DESC NULLS LAST, updated_at DESC, id DESC LIMIT 1) AS last_updated_at`;
}
