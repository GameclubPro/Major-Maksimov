import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';
import { assertLinkRulesSource } from './assert-link-rules-source.mjs';

const root = resolve(import.meta.dirname, '../..');
const read = (path) => readFileSync(resolve(root, path), 'utf8');

test('both rollback entrypoints require the persisted selective link reader', () => {
  for (const file of ['vps-runtime-rollback.sh', 'vps-release-rollback.sh']) {
    assert.match(read(`infra/scripts/${file}`), /maxim_topology_require_link_rules_policy_reader/u);
  }
  assert.doesNotThrow(() => assertLinkRulesSource(read));
});

test('runtime link reader follows the installed pause boundary and precedes rollback work', () => {
  const source = read('infra/scripts/vps-runtime-rollback.sh');
  const pauseBoundary =
    '"$release_policy_node" /usr/local/lib/maxim-release/infra/scripts/release-service-policy.mjs pause-rollback >/dev/null || exit $?\nfi\n';
  const pause = source.indexOf(pauseBoundary);
  assert.ok(pause >= 0, 'Keep the installed release service pause boundary');
  assert.equal(source.indexOf(pauseBoundary, pause + pauseBoundary.length), -1);

  const call = '\nmaxim_topology_require_link_rules_policy_reader "$TARGET_FULL_SHA"\n';
  const reader = source.indexOf(call);
  assert.ok(reader >= pause + pauseBoundary.length, 'Reader must follow the protected prefix');
  assert.equal(source.indexOf(call, reader + call.length), -1, 'Check the exact target once');
  for (const work of [
    '\nmaxim_require_ordinary_effect_authority "$ROOT_DIR" || exit $?\n',
    '\nensure_compose_env\n',
    '\nensure_stateful_services_ready\n',
    '\ngit switch --detach "$TARGET_FULL_SHA"\n',
    '\nmaxim_topology_build_shared_api_image "$ROLLBACK_API_IMAGE" "$TARGET_FULL_SHA"\n',
    '\nbegin_runtime_rollback_transition\n',
    '\nMAXIM_MIGRATION_API_IMAGE="$ROLLBACK_API_IMAGE" \\\n',
    '\nmaxim_webhook_quiesce_for_api_rollout COMPOSE_FILES\n',
    '\nrecreate_runtime_api_wave non-webhook "${non_webhook_services[@]}"\n',
  ]) {
    assert.ok(source.indexOf(work) > reader, `Reader must precede the actual call: ${work}`);
  }
});

test('a legacy target or disconnected final policy recheck is refused', () => {
  assert.throws(() =>
    assertLinkRulesSource((path) =>
      path.endsWith('schema.prisma')
        ? read(path).replace(/linkRulesPolicy\s+Json\?/u, 'retiredPolicy Json?')
        : read(path),
    ),
  );
  assert.throws(() =>
    assertLinkRulesSource((path) =>
      path.endsWith('link-history-delete-guard.service.ts')
        ? read(path).replaceAll('current.settings.linkRulesPolicy', 'null')
        : read(path),
    ),
  );
  assert.throws(() =>
    assertLinkRulesSource((path) =>
      path.endsWith('rule-engine-link-detector.ts')
        ? read(path).replace(
            'evaluateRuntimeLinkRulesPolicy(rules.policy, targets)',
            'legacyPolicy(rules.policy, targets)',
          )
        : read(path),
    ),
  );
});

test('a target without the persisted operation reader or policy hash fence is refused', () => {
  assert.throws(() =>
    assertLinkRulesSource((path) =>
      path.endsWith('network-settings.service.ts')
        ? read(path).replace("change.path === 'linkRulesPolicy'", "change.path === 'linkPolicy'")
        : read(path),
    ),
  );
  assert.throws(() =>
    assertLinkRulesSource((path) =>
      path.endsWith('link-history-delete-guard.service.ts')
        ? read(path).replace('reason.linkRulesPolicySha256 ===', 'reason.retiredFingerprint ===')
        : read(path),
    ),
  );
});
