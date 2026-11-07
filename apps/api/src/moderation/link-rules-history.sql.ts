import { Prisma } from '../prisma/prisma-client';
import { LINK_RULES_MAX } from '@maxim/contracts/settings';

// FLAG: Both seed and lease readers use the same bounded policy baseline and settings alias.
export function activeLinkPolicySql(): Prisma.Sql {
  return Prisma.sql`(
    (settings."link_rules_policy" IS NULL AND settings."link_policy" IN (
      CAST('ALLOWLIST_ONLY' AS "LinkPolicy"), CAST('BLOCKLIST_ONLY' AS "LinkPolicy")
    )) OR (
      settings."link_rules_policy" -> 'version' = '1'::jsonb
      AND settings."link_rules_policy" ->> 'mode' IN ('DENY_SELECTED', 'ALLOW_SELECTED', 'DENY_ALL')
    )
  )`;
}

export function linkPolicySemanticEffectiveAtSql(now: Date): Prisma.Sql {
  return Prisma.sql`GREATEST(
    settings."link_policy_effective_at",
    CASE
      WHEN settings."link_rules_policy" IS NOT NULL THEN (
        SELECT MAX(expiry."expires_at")
        FROM (
          SELECT CASE
            WHEN pg_input_is_valid(rule ->> 'expiresAt', 'timestamp with time zone')
            THEN (rule ->> 'expiresAt')::timestamptz AT TIME ZONE 'UTC'
            ELSE NULL
          END AS "expires_at"
          FROM jsonb_array_elements(
            CASE WHEN jsonb_typeof(settings."link_rules_policy" -> 'rules') = 'array'
              THEN CASE WHEN jsonb_array_length(settings."link_rules_policy" -> 'rules') <= ${LINK_RULES_MAX}
                THEN settings."link_rules_policy" -> 'rules' ELSE '[]'::jsonb END
              ELSE '[]'::jsonb
            END
          ) AS rule
          WHERE settings."link_rules_policy" ->> 'mode' IN ('DENY_SELECTED', 'ALLOW_SELECTED')
            AND COALESCE(rule -> 'enabled', 'true'::jsonb) = 'true'::jsonb
            AND rule ->> 'effect' = 'ALLOW'
        ) expiry
        WHERE expiry."expires_at" <= ${now}
      )
      WHEN settings."link_policy" = CAST('ALLOWLIST_ONLY' AS "LinkPolicy") THEN (
        SELECT MAX(allowlist."remove_after_at")
        FROM "domain_allowlist" allowlist
        WHERE allowlist."chat_id" = settings."chat_id"
          AND allowlist."remove_after_at" <= ${now}
      )
      ELSE NULL
    END
  )`;
}
