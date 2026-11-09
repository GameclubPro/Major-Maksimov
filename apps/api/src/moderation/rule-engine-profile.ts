import type { ChatSettings } from '../prisma/prisma-client';
import type { RuntimeDiagnosticsService } from '../system/runtime-diagnostics.service';
import type { RuleCoverageSnapshot } from './rule-engine-observation';

const RULE_ENGINE_SLOW_LOG_THRESHOLD_MS = 3_000;

export type RuleEngineDetectProfile = {
  startedAtMs: number;
  lastMarkedAtMs: number;
  latestStage: string;
  pendingStage?: string;
  stages: Map<string, number>;
  stageTimelineMs: Map<string, number>;
};

export function createRuleEngineDetectProfile(): RuleEngineDetectProfile {
  const now = Date.now();
  return {
    startedAtMs: now,
    lastMarkedAtMs: now,
    latestStage: 'start',
    stages: new Map(),
    stageTimelineMs: new Map(),
  };
}

export function beginRuleEngineDetectStage(profile: RuleEngineDetectProfile, stage: string): void {
  profile.pendingStage = stage;
}

export function markRuleEngineDetectStage(profile: RuleEngineDetectProfile, stage: string): void {
  const now = Date.now();
  profile.latestStage = stage;
  profile.stages.set(stage, Math.max(0, now - profile.lastMarkedAtMs));
  profile.stageTimelineMs.set(stage, Math.max(0, now - profile.startedAtMs));
  profile.lastMarkedAtMs = now;
  profile.pendingStage = undefined;
}

export function readRuleEngineDetectProfileSnapshot(profile: RuleEngineDetectProfile): {
  latestStage: string;
  elapsedMs: number;
  stageDurations: Record<string, number>;
  stageTimelineMs: Record<string, number>;
} {
  return {
    latestStage: profile.latestStage,
    elapsedMs: Math.max(0, Date.now() - profile.startedAtMs),
    stageDurations: Object.fromEntries(profile.stages.entries()),
    stageTimelineMs: Object.fromEntries(profile.stageTimelineMs.entries()),
  };
}

export function logSlowRuleEngineDetectIfNeeded(params: {
  chatId: string;
  userId: string;
  measuredLength: number;
  settings: ChatSettings;
  violationsCount: number;
  duplicateCandidate: boolean;
  profile: RuleEngineDetectProfile;
}): void {
  const snapshot = readRuleEngineDetectProfileSnapshot(params.profile);
  if (snapshot.elapsedMs < RULE_ENGINE_SLOW_LOG_THRESHOLD_MS) {
    return;
  }

  console.warn(
    JSON.stringify({
      level: 'warn',
      context: 'RuleEngineService',
      chatId: params.chatId,
      userId: params.userId,
      elapsedMs: snapshot.elapsedMs,
      latestStage: snapshot.latestStage,
      textLength: params.measuredLength,
      linkPolicy: params.settings.linkPolicy,
      antiDuplicateEnabled: params.settings.antiDuplicateEnabled,
      commercialAdsFilterEnabled: params.settings.commercialAdsFilterEnabled,
      messageCountLimitEnabled: params.settings.messageCountLimitEnabled,
      russianProfanityFilterEnabled: params.settings.russianProfanityFilterEnabled,
      violationsCount: params.violationsCount,
      duplicateCandidate: params.duplicateCandidate,
      stageDurations: snapshot.stageDurations,
      stageTimelineMs: snapshot.stageTimelineMs,
      msg: 'Slow rule-engine detect completed close to the hot-path deadline',
    }),
  );
}

export function recordRuleEngineDetectProfile(
  profile: RuleEngineDetectProfile,
  runtimeDiagnosticsService?: RuntimeDiagnosticsService,
  ruleCoverage?: RuleCoverageSnapshot,
): void {
  // FLAG: Partial timings/coverage survive an exception, but diagnostics never replace it.
  try {
    if (profile.pendingStage) markRuleEngineDetectStage(profile, profile.pendingStage);
    const snapshot = readRuleEngineDetectProfileSnapshot(profile);
    const pending = runtimeDiagnosticsService?.recordHotPathProfile({
      snapshot: {
        ruleCoverage,
        stageDurations: Object.fromEntries(
          Object.entries(snapshot.stageDurations).map(([stage, elapsedMs]) => [
            `rule-engine.${stage}`,
            elapsedMs,
          ]),
        ),
      },
    });
    if (pending) void pending.catch(() => undefined);
  } catch {
    // FLAG: A diagnostic sink cannot change moderation results or retry authority.
  }
}
