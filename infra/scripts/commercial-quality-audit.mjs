import { pathToFileURL } from 'node:url';

export const COMMERCIAL_QUALITY_AUDIT_COLUMNS = [
  'id',
  'observed_at',
  'expires_at',
  'source',
  'independent_label',
  'independent_review_count',
  'review_state',
  'quality_metadata',
];

export function buildCommercialQualityPrivilegesSql(requireAll = false) {
  const columns = COMMERCIAL_QUALITY_AUDIT_COLUMNS.map((column) => `('${column}')`).join(',');
  return `WITH allowed(column_name) AS (VALUES ${columns})
SELECT NOT EXISTS (
  SELECT 1 FROM pg_attribute attribute
  WHERE attribute.attrelid = to_regclass('public.commercial_review_samples')
    AND attribute.attnum > 0 AND NOT attribute.attisdropped
    AND has_column_privilege('maxim_audit', attribute.attrelid, attribute.attnum, 'SELECT')
    AND attribute.attname NOT IN (SELECT column_name FROM allowed)
) AND (${requireAll ? 'true' : 'false'} = false OR NOT EXISTS (
  SELECT 1 FROM allowed LEFT JOIN pg_attribute attribute
    ON attribute.attrelid = to_regclass('public.commercial_review_samples')
      AND attribute.attname = allowed.column_name AND NOT attribute.attisdropped
  WHERE attribute.attnum IS NULL OR NOT has_column_privilege(
    'maxim_audit', attribute.attrelid, attribute.attnum, 'SELECT')
)) AS commercial_quality_privileges_ready \\gset
\\if :commercial_quality_privileges_ready
\\else
\\echo 'Commercial quality metadata privileges are missing or excessive; refusing diagnostics.'
-- FLAG: PostgreSQL 16 psql ignores numeric \\quit arguments. Fail under ON_ERROR_STOP.
SELECT 1 / 0;
\\endif
`;
}

export function buildCommercialQualityIndexReadinessSql() {
  return `WITH required(column_name, type_name, type_modifier) AS (VALUES
  ('id', 'text', -1), ('observed_at', 'timestamp without time zone', 3),
  ('expires_at', 'timestamp without time zone', 3), ('source', 'text', -1),
  ('independent_label', 'text', -1), ('independent_review_count', 'integer', -1),
  ('review_state', 'text', -1), ('quality_metadata', 'jsonb', -1)
)
SELECT NOT EXISTS (
  SELECT 1 FROM required LEFT JOIN pg_attribute attribute
    ON attribute.attrelid = to_regclass('public.commercial_review_samples')
      AND attribute.attname = required.column_name AND NOT attribute.attisdropped
  WHERE attribute.attnum IS NULL OR attribute.atttypid <> to_regtype(required.type_name)
    OR attribute.atttypmod <> required.type_modifier
) AND EXISTS (
  SELECT 1 FROM pg_index definition JOIN pg_class index_relation
    ON index_relation.oid = definition.indexrelid
  JOIN pg_am method ON method.oid = index_relation.relam
  WHERE definition.indexrelid = to_regclass('public.commercial_review_samples_blind_queue_idx')
    AND definition.indrelid = to_regclass('public.commercial_review_samples')
    AND definition.indisvalid AND definition.indisready AND definition.indislive
    AND method.amname = 'btree' AND definition.indnkeyatts = 2 AND definition.indnatts = 2
    AND definition.indpred IS NULL AND definition.indexprs IS NULL
    AND pg_get_indexdef(definition.indexrelid, 1, true) = 'observed_at'
    AND pg_get_indexdef(definition.indexrelid, 2, true) = 'id'
    AND definition.indoption[0] = 3 AND definition.indoption[1] = 3
) AS commercial_quality_index_ready \\gset
\\if :commercial_quality_index_ready
\\else
\\echo 'Required commercial quality index is unavailable or incompatible; refusing an unindexed scan.'
-- FLAG: PostgreSQL 16 psql ignores numeric \\quit arguments. Fail under ON_ERROR_STOP.
SELECT 1 / 0;
\\endif
`;
}

export function buildCommercialQualityAuditSql(explain = false) {
  // FLAG: The sole table walk uses the attested observed_at/id index and a 5,001-row sentinel.
  // Metadata projection uses fixed enums only. Evidence, identifiers, scores, hashes, contact
  // material and arbitrary reason/candidate strings cannot appear in the report.
  // FLAG: Project bounded scalar fields before materialization. Retaining raw JSON in several
  // CTE stores can exhaust the audit role's 8 MiB temporary-file limit within the row cap.
  const query = `WITH candidates AS MATERIALIZED (
  WITH source_rows AS NOT MATERIALIZED (
  SELECT id, observed_at, expires_at, source, independent_label,
    independent_review_count, review_state, quality_metadata
  FROM commercial_review_samples
  WHERE observed_at >= statement_timestamp() - interval '24 hours'
    AND observed_at <= statement_timestamp()
  ORDER BY observed_at DESC, id DESC LIMIT 5001
), classified AS NOT MATERIALIZED (
  SELECT id, observed_at, expires_at > statement_timestamp() AS unexpired,
    CASE WHEN source IN ('TEXT', 'OCR') THEN source ELSE 'UNKNOWN' END AS source,
    CASE WHEN quality_metadata->'schemaVersion' = '2'::jsonb THEN true ELSE false END AS metadata_v2,
    CASE WHEN quality_metadata->'schemaVersion' = '2'::jsonb THEN quality_metadata ELSE '{}'::jsonb END AS metadata,
    CASE WHEN independent_label IN ('COMMERCIAL', 'NOT_COMMERCIAL', 'UNSURE')
      THEN independent_label ELSE 'UNKNOWN' END AS independent_label,
    CASE WHEN review_state IN ('UNREVIEWED', 'AWAITING_SECOND', 'DISAGREEMENT', 'RESOLVED')
      THEN review_state ELSE 'UNKNOWN' END AS review_state,
    CASE WHEN independent_review_count = 0 THEN 'ZERO' WHEN independent_review_count = 1
      THEN 'ONE' WHEN independent_review_count >= 2 THEN 'TWO_OR_MORE' ELSE 'UNKNOWN' END AS review_count
  FROM source_rows
)
  SELECT id, observed_at, unexpired, source, metadata_v2, independent_label, review_state, review_count,
    CASE WHEN metadata->>'samplingStratum' IN ('HIT', 'REVIEW', 'NO_HIT', 'TECHNICAL')
      THEN metadata->>'samplingStratum' ELSE 'UNKNOWN' END AS stratum,
    CASE WHEN jsonb_typeof(metadata->'samplingProbability') = 'number' THEN
      CASE WHEN (metadata->>'samplingProbability')::numeric BETWEEN 0.000001 AND 1
        THEN (metadata->>'samplingProbability')::numeric ELSE NULL END
      ELSE NULL END AS probability,
    CASE WHEN metadata->'randomEvaluationIncluded' = 'true'::jsonb THEN 'YES'
      WHEN metadata->'randomEvaluationIncluded' = 'false'::jsonb THEN 'NO'
      ELSE 'UNKNOWN' END AS evaluation_membership,
    CASE WHEN jsonb_typeof(metadata->'evaluationSamplingProbability') = 'number' THEN
      CASE WHEN (metadata->>'evaluationSamplingProbability')::numeric BETWEEN 0.000001 AND 1
        THEN true ELSE false END
      ELSE false END AS evaluation_probability_known,
    CASE WHEN jsonb_typeof(metadata->'pseudonymizationKeyId') = 'string'
      AND metadata->>'pseudonymizationKeyId' <> '' THEN true ELSE false END AS key_identity_known,
    CASE WHEN metadata->>'decisionOutcome' IN ('KEEP', 'DELETE')
      THEN metadata->>'decisionOutcome' ELSE 'UNKNOWN' END AS decision,
    CASE WHEN metadata->'deleteEligible' = 'true'::jsonb THEN 'YES'
      WHEN metadata->'deleteEligible' = 'false'::jsonb THEN 'NO' ELSE 'UNKNOWN' END AS delete_eligible,
    CASE WHEN metadata->>'executionOutcome' IN ('PENDING', 'CONFIRMED_DELETE', 'ALREADY_ABSENT', 'NOT_REQUESTED')
      THEN metadata->>'executionOutcome' ELSE 'UNKNOWN' END AS execution,
    CASE WHEN metadata->>'analysisOutcome' IN ('COMPLETE', 'TECHNICAL_INCOMPLETE', 'NOT_APPLICABLE')
      THEN metadata->>'analysisOutcome' ELSE 'UNKNOWN' END AS analysis,
    CASE WHEN metadata->'sourceExcerptComplete' = 'true'::jsonb THEN 'COMPLETE'
      WHEN metadata->'sourceExcerptComplete' = 'false'::jsonb THEN 'INCOMPLETE' ELSE 'UNKNOWN' END AS excerpt
  FROM classified
), normalized AS MATERIALIZED (
  SELECT * FROM candidates ORDER BY observed_at DESC, id DESC LIMIT 5000
), strata AS (
  SELECT source, stratum, count(*) AS captured_samples,
    count(probability) AS samples_with_probability,
    round(sum(1 / probability), 3) AS weighted_captured_population_estimate
  FROM normalized GROUP BY source, stratum
), decisions AS (
  SELECT source, decision, delete_eligible, execution, count(*) AS captured_samples
  FROM normalized GROUP BY source, decision, delete_eligible, execution
), independent AS (
  SELECT source, independent_label, review_state, review_count, count(*) AS captured_samples
  FROM normalized GROUP BY source, independent_label, review_state, review_count
), analyses AS (
  SELECT source, analysis, count(*) AS captured_samples FROM normalized GROUP BY source, analysis
), excerpts AS (
  SELECT source, excerpt, count(*) AS captured_samples FROM normalized GROUP BY source, excerpt
)
SELECT json_build_object(
  'schema_version', 1, 'audit', 'commercial_quality',
  'window_start_at', statement_timestamp() - interval '24 hours', 'window_end_at', statement_timestamp(),
  'window_basis', 'observed_at', 'sample_cap', 5000,
  'population_basis', 'captured_review_samples_not_all_messages',
  'weighted_count_is_estimate', true, 'accuracy_measured', false,
  'truncated', (SELECT count(*) > 5000 FROM candidates),
  'complete', (SELECT count(*) <= 5000 FROM candidates)
    AND NOT EXISTS (SELECT 1 FROM normalized WHERE NOT metadata_v2 OR probability IS NULL),
  'captured_samples', (SELECT count(*) FROM normalized),
  'oldest_observed_at', (SELECT min(observed_at) FROM normalized),
  'newest_observed_at', (SELECT max(observed_at) FROM normalized),
  'metadata_missing_or_legacy', (SELECT count(*) FROM normalized WHERE NOT metadata_v2),
  'probability_unknown', (SELECT count(*) FROM normalized WHERE probability IS NULL),
  'uniform_evaluation_samples', (SELECT count(*) FROM normalized WHERE evaluation_membership = 'YES'),
  'evaluation_membership_unknown', (SELECT count(*) FROM normalized WHERE evaluation_membership = 'UNKNOWN'),
  'evaluation_probability_known', (SELECT count(*) FROM normalized WHERE evaluation_probability_known),
  'evaluation_probability_unknown', (SELECT count(*) FROM normalized WHERE NOT evaluation_probability_known),
  'key_identity_unknown', (SELECT count(*) FROM normalized WHERE NOT key_identity_known),
  'expired_samples', (SELECT count(*) FROM normalized WHERE NOT unexpired),
  'source_strata', coalesce((SELECT json_agg(strata ORDER BY source, stratum) FROM strata), '[]'::json),
  'decisions', coalesce((SELECT json_agg(decisions ORDER BY source, decision, delete_eligible, execution) FROM decisions), '[]'::json),
  'independent_reviews', coalesce((SELECT json_agg(independent ORDER BY source, independent_label, review_state, review_count) FROM independent), '[]'::json),
  'analysis_outcomes', coalesce((SELECT json_agg(analyses ORDER BY source, analysis) FROM analyses), '[]'::json),
  'excerpt_coverage', coalesce((SELECT json_agg(excerpts ORDER BY source, excerpt) FROM excerpts), '[]'::json)
);`;
  return `${explain ? 'EXPLAIN (FORMAT JSON) ' : ''}${query}\n`;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const args = process.argv.slice(2);
  if (
    args[0] === '--privileges' &&
    args.length <= 2 &&
    (args.length === 1 || args[1] === '--require-all')
  ) {
    process.stdout.write(buildCommercialQualityPrivilegesSql(args[1] === '--require-all'));
  } else {
    if (args.length > 1 || (args.length === 1 && args[0] !== '--explain')) {
      throw new Error('Usage: commercial-quality-audit.mjs [--explain]');
    }
    process.stdout.write(
      buildCommercialQualityIndexReadinessSql() +
        buildCommercialQualityAuditSql(args[0] === '--explain'),
    );
  }
}
