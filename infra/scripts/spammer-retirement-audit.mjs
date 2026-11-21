import { pathToFileURL } from 'node:url';

export const families = Object.freeze({
  registry: ['global_spammers', 'user_id'],
  candidates: ['global_spammer_candidates', 'user_id'],
  chats: ['global_spammer_candidate_chats', 'candidate_user_id', 'chat_id'],
  archives: ['global_spammer_archives', 'id'],
  observations: ['spammer_observations', 'id'],
  profiles: ['spammer_user_runtime_profiles', 'user_id'],
  campaigns: ['spammer_campaign_clusters', 'id'],
});
const namespace = 'maxim_spammer_audit';
const columns = ['key1', 'key2', 'provenance', 'raw_copy', 'active'];
const knownSources = [
  'FANOUT_HIGH',
  'FANOUT_REPEAT',
  'COMMERCIAL_AD',
  'COMMERCIAL_CAMPAIGN',
  'REPEATED_LINK',
  'REPEATED_PHONE',
  'GRAPH_DOMAIN',
  'GRAPH_PHONE',
  'GRAPH_TEXT',
  'GRAPH_CAMPAIGN',
  'GRAPH_FANOUT_PATTERN',
  'SANCTION_BAN',
  'MANUAL_BAN',
  'LOCAL_ADMIN_BLOCK',
  'LOCAL_ADMIN_ALLOW',
  'REVIEW_APPROVED',
];
const names = Object.keys(families);
const sl = (value) => "'" + value.replaceAll("'", "''") + "'";
const list = (vals) => vals.map(sl).join(',');
const keyNames = names.map((name) => 'keys_' + name);
const protectedViews = [...names, ...keyNames].map(sl).join(',');
const oversized = (field) =>
  `(pg_column_compression(${field}) IS NOT NULL OR pg_column_size(${field})>32768)`;
function provenance(family) {
  if (family === 'chats' || family === 'campaigns') return 'NULL::text';
  if (family === 'observations')
    return `CASE WHEN source='DEVELOPER_FORCED' THEN 'retired_only' WHEN source IN (${list(knownSources)}) THEN 'ordinary' ELSE 'unknown' END`;
  return `CASE WHEN ${oversized('source_breakdown')} THEN 'unmeasured'
    WHEN jsonb_typeof(source_breakdown) IS DISTINCT FROM 'object' OR source_breakdown='{}'::jsonb THEN 'unknown'
    WHEN source_breakdown ? 'DEVELOPER_FORCED' THEN CASE WHEN source_breakdown-'DEVELOPER_FORCED'='{}'::jsonb THEN 'retired_only' ELSE 'mixed' END
    WHEN (source_breakdown - ARRAY[${list(knownSources)}]::text[])<>'{}'::jsonb THEN 'unknown' ELSE 'ordinary' END`;
}
function rawCopy(family) {
  if (family === 'profiles') return 'NULL::boolean';
  if (family === 'campaigns')
    return `CASE WHEN signal_type<>'URL' THEN false WHEN ${oversized('signal_value_preview')} THEN NULL ELSE COALESCE(strpos(signal_value_preview,'/')>0,false) END`;
  const obs = family === 'observations';
  const field = obs ? 'evidence' : 'last_evidence';
  return `CASE ${family === 'chats' ? 'WHEN last_excerpt IS NOT NULL THEN true' : ''}
    WHEN ${oversized(field)} ${obs ? 'OR ' + oversized('normalized_features') : ''} THEN NULL
    ELSE COALESCE(${field} ?| ARRAY['text','messageText','excerpt','urls','metadata','actorUserId'],false)
      OR COALESCE(jsonb_typeof(${field}->'evidence')<>'null',false) ${obs ? "OR COALESCE(normalized_features ? 'urls',false)" : ''} END`;
}

export function parseScope(argv) {
  const seen = new Set();
  const result = { family: 'registry', limit: 25, after: null, explain: false };
  for (let i = 0; i < argv.length; i++) {
    const option = argv[i];
    if (seen.has(option)) throw new Error('Duplicate report option');
    seen.add(option);
    if (option === '--explain') {
      result.explain = true;
      continue;
    }
    const value = argv[++i];
    if (option === '--family' && Object.hasOwn(families, value)) result.family = value;
    else if (option === '--limit' && /^(?:[1-9]|[1-3][0-9]|40)$/u.test(value ?? ''))
      result.limit = Number(value);
    else if (option === '--after' && /^[A-Za-z0-9_-]{1,3072}$/u.test(value ?? ''))
      result.after = value;
    else throw new Error('Invalid spammer retirement report scope');
  }
  if (result.after) {
    const fields = JSON.parse(Buffer.from(result.after, 'base64url').toString('utf8'));
    if (
      !Array.isArray(fields) ||
      fields.length !== 3 ||
      fields[0] !== result.family ||
      fields
        .slice(1)
        .some(
          (key) => typeof key !== 'string' || Buffer.byteLength(key) > 1024 || key.includes('\0'),
        ) ||
      (result.family !== 'chats' && fields[2] !== '')
    )
      throw new Error('Invalid cursor scope');
    result.after = fields.slice(1);
  }
  return result;
}

export function provisionSql() {
  return (
    BASE_PROVISION +
    '\n' +
    names
      .map((family) => {
        const [table, key, second] = families[family];
        const view = namespace + '.' + family;
        const active =
          family === 'registry'
            ? 'COALESCE(expires_at>statement_timestamp(),false)'
            : 'NULL::boolean';
        return `CREATE OR REPLACE VIEW ${namespace}.keys_${family} WITH(security_invoker=false) AS
      SELECT ${key} AS key1,${second ?? "''::text"} AS key2 FROM public.${table};
      REVOKE ALL ON ${namespace}.keys_${family} FROM PUBLIC;
      GRANT SELECT(key1,key2) ON ${namespace}.keys_${family} TO maxim_audit;
    CREATE OR REPLACE VIEW ${view} WITH(security_barrier=true,security_invoker=false) AS
      SELECT ${key} AS key1,${second ?? "''::text"} AS key2,${provenance(family)} AS provenance,
        ${rawCopy(family)} AS raw_copy,${active} AS active FROM public.${table};
      REVOKE ALL ON ${view} FROM PUBLIC;
      GRANT SELECT(${columns.join(',')}) ON ${view} TO maxim_audit;`;
      })
      .join('\n')
      .split('\n')
      .map((line) => line.trimEnd())
      .join('\n')
  );
}

const BASE_PROVISION = `-- Infrastructure-owned projections for the fixed read-only history inventory.
SET LOCAL search_path = pg_catalog, public, pg_temp;
CREATE SCHEMA IF NOT EXISTS maxim_spammer_audit;
DO $schema_guard$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_namespace n WHERE n.nspname='maxim_spammer_audit'
    AND n.nspowner=(SELECT oid FROM pg_roles WHERE rolname=current_user)
    AND NOT EXISTS (SELECT 1 FROM aclexplode(COALESCE(n.nspacl,acldefault('n',n.nspowner))) acl
      WHERE acl.grantee<>n.nspowner AND NOT (acl.grantee='maxim_audit'::regrole AND acl.privilege_type='USAGE'))) THEN
    RAISE EXCEPTION 'Unexpected spammer audit schema permissions';
  END IF;
END $schema_guard$;
GRANT USAGE ON SCHEMA maxim_spammer_audit TO maxim_audit;`;
export function privilegeCondition(required = false) {
  return `(WITH v AS (SELECT c.* FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='${namespace}'),
   ns AS (SELECT * FROM pg_namespace WHERE nspname='${namespace}')
   SELECT ${required ? 'false' : 'NOT EXISTS(SELECT 1 FROM ns)'} OR (
     EXISTS(SELECT 1 FROM ns WHERE nspowner=(SELECT oid FROM pg_roles WHERE rolname='maxim') AND has_schema_privilege('maxim_audit',oid,'USAGE') AND NOT has_schema_privilege('maxim_audit',oid,'CREATE')
        AND NOT EXISTS (SELECT 1 FROM aclexplode(COALESCE(nspacl,acldefault('n',nspowner))) acl WHERE acl.grantee<>nspowner AND NOT(acl.grantee='maxim_audit'::regrole AND acl.privilege_type='USAGE')))
     AND (SELECT count(*) FROM v)=${names.length * 2}
     AND NOT EXISTS(SELECT 1 FROM v WHERE relname NOT IN (${protectedViews}) OR relkind<>'v' OR relowner<>(SELECT nspowner FROM ns)
       OR NOT COALESCE(reloptions @> ARRAY['security_invoker=false'],false) OR (relname IN (${list(names)}) AND NOT COALESCE(reloptions @> ARRAY['security_barrier=true'],false))
       OR has_table_privilege('maxim_audit',oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'))
     AND NOT EXISTS(SELECT 1 FROM v JOIN pg_attribute a ON a.attrelid=v.oid WHERE a.attnum>0 AND NOT a.attisdropped AND
       (a.attname NOT IN (${list(columns)}) OR (v.relname IN (${list(keyNames)}) AND a.attname NOT IN ('key1','key2')) OR NOT has_column_privilege('maxim_audit',v.oid,a.attnum,'SELECT') OR has_column_privilege('maxim_audit',v.oid,a.attnum,'INSERT,UPDATE,REFERENCES')))
     AND (SELECT count(*) FROM v JOIN pg_attribute a ON a.attrelid=v.oid WHERE a.attnum>0 AND NOT a.attisdropped)=${names.length * (columns.length + 2)}
   ))`;
}

export function buildQuery({ family, limit, after }) {
  const compound = family === 'chats';
  const predicate = !after ? 'TRUE' : compound ? '(key1,key2)>($1,$2)' : 'key1>$1';
  const order = compound ? 'key1,key2' : 'key1';
  return `WITH probe AS MATERIALIZED (SELECT key1,key2 FROM ${namespace}.keys_${family} WHERE ${predicate} ORDER BY ${order} LIMIT ${limit + 1}),
    page AS MATERIALIZED (SELECT * FROM probe ORDER BY ${order} LIMIT ${limit}),
    classified AS MATERIALIZED (SELECT d.provenance,d.raw_copy,d.active FROM page p CROSS JOIN LATERAL (
       SELECT provenance,raw_copy,active FROM ${namespace}.${family} v WHERE v.key1=p.key1 ${compound ? 'AND v.key2=p.key2' : ''} LIMIT 1
    ) d)
    SELECT json_build_object('report','spammer_retirement','version',1,'sampledAt',statement_timestamp(),'family','${family}',
      'scanned',count(*),'retiredOnly',count(*) FILTER(WHERE provenance='retired_only'),'mixed',count(*) FILTER(WHERE provenance='mixed'),
      'activeRetiredOrMixed',${family === 'registry' ? "count(*) FILTER(WHERE active AND provenance IN ('retired_only','mixed'))" : 'NULL::bigint'},
      'unknown',count(*) FILTER(WHERE provenance='unknown'),'provenanceUnmeasured',${['chats', 'campaigns'].includes(family) ? 'NULL::bigint' : "count(*) FILTER(WHERE provenance='unmeasured')"},
      'rawCopyIndicators',${family === 'profiles' ? 'NULL::bigint' : 'count(*) FILTER(WHERE raw_copy)'},'rawCopyUnmeasured',${family === 'profiles' ? 'NULL::bigint' : 'count(*) FILTER(WHERE raw_copy IS NULL)'},
      'nextCursor',CASE WHEN (SELECT count(*) FROM probe)>${limit} THEN (SELECT rtrim(translate(replace(encode(convert_to(json_build_array('${family}',key1,key2)::text,'UTF8'),'base64'),chr(10),''),'+/','-_'),'=') FROM page ORDER BY key1 DESC,key2 DESC LIMIT 1) END,
      'mutationAuthorized',false) AS report FROM classified`;
}
const guard = (condition, marker) => `SELECT ${condition} AS ready \\gset
\\if :ready
\\else
\\echo ${marker}
SELECT 1 / 0;
\\endif`;
export function reportSql(argv) {
  const scope = parseScope(argv);
  const [table, ...keys] = families[scope.family];
  const index = guard(
    `EXISTS(SELECT 1 FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid JOIN pg_am m ON m.oid=c.relam WHERE i.indrelid='public.${table}'::regclass AND i.indisprimary AND i.indisvalid AND i.indisready AND i.indislive AND m.amname='btree' AND i.indnkeyatts=${keys.length} AND i.indnatts=i.indnkeyatts AND i.indpred IS NULL AND i.indexprs IS NULL AND ARRAY(SELECT a.attname::text FROM unnest(i.indkey::smallint[]) WITH ORDINALITY k(num,n) JOIN pg_attribute a ON a.attrelid=i.indrelid AND a.attnum=k.num ORDER BY k.n)=ARRAY[${list(keys)}]::text[])`,
    'MAXIM_SPAMMER_RETIREMENT_INDEX_UNAVAILABLE',
  );
  const params = scope.after?.map(
    (key) => `convert_from(decode('${Buffer.from(key).toString('hex')}','hex'),'UTF8')`,
  ) ?? ["''", "''"];
  return (
    guard(privilegeCondition(true), 'MAXIM_SPAMMER_RETIREMENT_GRANTS_UNAVAILABLE') +
    '\n' +
    index +
    '\n' +
    `SET LOCAL plan_cache_mode=force_generic_plan;
PREPARE spammer_retirement_page(text,text) AS ${buildQuery(scope)};
${scope.explain ? 'EXPLAIN (FORMAT JSON) ' : ''}EXECUTE spammer_retirement_page(${params.join(',')});`
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const args = process.argv.slice(2);
    if (args[0] === '--validate-scope') parseScope(args.slice(1));
    else if (args.length === 1 && args[0] === '--provision') console.log(provisionSql());
    else if (args.length === 1 && args[0] === '--privileges')
      console.log(guard(privilegeCondition(), 'MAXIM_SPAMMER_RETIREMENT_GRANTS_INVALID'));
    else console.log(reportSql(args));
  } catch {
    console.error('Invalid spammer retirement audit arguments');
    process.exitCode = 2;
  }
}
