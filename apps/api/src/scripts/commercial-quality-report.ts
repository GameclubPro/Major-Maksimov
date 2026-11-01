import { createHash } from 'node:crypto';
import {
  resolveCommercialLabelAuthority,
  type CommercialReviewExportResponse,
  type CommercialReviewSamplingFrameResponse,
} from '@maxim/contracts/safety-desk';
import { COMMERCIAL_INTENT_QUALITY_DECISION_VERSION } from '../moderation/commercial/commercial-policy-cohorts';
import { fingerprintCommercialTextSettingsProfile } from '../moderation/commercial/commercial-text-runtime-policy.service';
import { commercialWilson95 } from './commercial-text-holdout-artifact';
import { COMMERCIAL_OCR_DETECTOR_SOURCE_SHA256 } from '../moderation/commercial-ocr/commercial-ocr-detector-source.generated';
import { COMMERCIAL_QUALITY_EVALUATION_PROBABILITY } from '../moderation/commercial/commercial-quality-sampling';
import { isCommercialMessageDeleteEligible } from '../moderation/commercial/commercial-action-policy';

type ExportItem = CommercialReviewExportResponse['items'][number];
export type CommercialQualityExportPage = {
  cursor: string | null;
  response: CommercialReviewExportResponse;
};
export type CommercialQualityFramePage = {
  cursor: string | null;
  response: CommercialReviewSamplingFrameResponse;
};
export type CommercialQualityEvidenceBundle = {
  schemaVersion: 'commercial-quality-paired/v1';
  detectorSourceSha256: string;
  frozenAt: string;
  evaluatedAt: string;
  development: CommercialQualityExportPage[];
  holdout: CommercialQualityExportPage[];
  holdoutFrame?: CommercialQualityFramePage[];
};
type PairedUnit = {
  protected: boolean;
  offer: boolean;
  baselineFp: boolean;
  candidateFp: boolean;
  baselineMiss: boolean;
  candidateMiss: boolean;
  baselineRecognitionMiss: boolean;
  candidateRecognitionMiss: boolean;
  executionMiss: boolean;
  executionUnknown: boolean;
  confirmedDelete: boolean;
  alreadyAbsent: boolean;
};
const DAY = 86400_000;
const PROFILES = [
  { sensitivity: 'BALANCED' as const, warn: 45, remove: 65 },
  { sensitivity: 'STRICT' as const, warn: 38, remove: 55 },
].map((profile) => ({
  ...profile,
  digest: fingerprintCommercialTextSettingsProfile({
    commercialAdsSensitivity: profile.sensitivity,
    commercialAdsWarnThreshold: profile.warn,
    commercialAdsDeleteThreshold: profile.remove,
  }),
}));

// FLAG: The report validates declared source/reviewer evidence. It cannot establish
// human truth. No historical/automatic label, caption-only image or unknown execution
// is converted into independent evidence or a confirmed deletion.
export function analyzeCommercialQualityEvidence(bundle: CommercialQualityEvidenceBundle) {
  const errors: string[] = [];
  const development = readPages(bundle.development, 'development', errors);
  const holdout = readPages(bundle.holdout, 'holdout', errors);
  const developmentText = development.filter((row) => row.sample.source === 'TEXT');
  const holdoutText = holdout.filter((row) => row.sample.source === 'TEXT');
  const frozenAt = Date.parse(bundle.frozenAt);
  const evaluatedAt = Date.parse(bundle.evaluatedAt);
  if (
    bundle.schemaVersion !== 'commercial-quality-paired/v1' ||
    !Number.isFinite(frozenAt) ||
    !Number.isFinite(evaluatedAt) ||
    evaluatedAt > Date.now() ||
    frozenAt >= evaluatedAt ||
    bundle.detectorSourceSha256 !== COMMERCIAL_OCR_DETECTOR_SOURCE_SHA256
  )
    errors.push('invalid_frozen_identity');
  if (development.length + holdout.length > 100_000) errors.push('record_limit_exceeded');
  const span = (rows: ExportItem[]) => {
    const times = rows
      .map((row) => Date.parse(row.sample.evidenceMetadata?.messageCreatedAt ?? ''))
      .filter(Number.isFinite);
    return times.length
      ? {
          first: Math.min(...times),
          last: Math.max(...times),
          milliseconds: Math.max(...times) - Math.min(...times),
        }
      : null;
  };
  const devSpan = span(developmentText);
  const holdoutSpan = span(holdoutText);
  if (!devSpan || devSpan.milliseconds < 7 * DAY || devSpan.last > frozenAt)
    errors.push('development_requires_seven_days_before_freeze');
  if (!holdoutSpan || holdoutSpan.milliseconds < 7 * DAY || holdoutSpan.first < frozenAt + DAY)
    errors.push('holdout_requires_seven_days_after_24h_gap');

  const developmentKeys = new Set(development.flatMap(groupKeys));
  const developmentSources = new Set(development.flatMap(sourceKeys));
  if (developmentText.some((row) => !independentEvidence(row)))
    errors.push('development_independent_evidence_incomplete');
  if (
    developmentText.some((row) =>
      row.ratings.some((rating) => Date.parse(rating.reviewedAt) > frozenAt),
    )
  )
    errors.push('development_review_after_freeze');
  const seenSources = new Set<string>();
  for (const row of holdout) {
    if (
      Date.parse(row.sample.evidenceMetadata?.messageCreatedAt ?? '') > evaluatedAt ||
      row.ratings.some((rating) => Date.parse(rating.reviewedAt) > evaluatedAt)
    )
      errors.push('source_or_review_after_evaluation');
    if (groupKeys(row).some((key) => developmentKeys.has(key)))
      errors.push('author_or_campaign_overlap');
    if (sourceKeys(row).some((key) => developmentSources.has(key))) errors.push('source_overlap');
    const revision = `${row.sample.source}:${row.sample.evidenceMetadata?.sourceSnapshotSha256}`;
    if (seenSources.has(revision)) errors.push('duplicate_source_revision');
    seenSources.add(revision);
  }
  const coverage = summarizeCoverage(holdout);
  const frameCoverage = reconcileFrame(
    bundle.holdoutFrame,
    holdout,
    errors,
    bundle.holdout[0]?.response,
  );
  const keyIds = new Set(
    [...development, ...holdout].map((row) => row.sample.evidenceMetadata?.pseudonymizationKeyId),
  );
  if (keyIds.size !== 1 || keyIds.has(null) || keyIds.has(undefined))
    errors.push('pseudonym_key_missing_or_rotated');
  const allGroups = connectedGroups(holdout);
  const profiles = PROFILES.map((profile) => {
    const selected = holdout.filter(
      (row) =>
        row.sample.source === 'TEXT' &&
        row.sample.evidenceMetadata?.settingsProfileDigest === profile.digest &&
        row.sample.evidenceMetadata?.randomEvaluationIncluded === true,
    );
    const usable = selected.filter(
      (row) =>
        independentEvidence(row) &&
        row.sample.evidenceMetadata?.evaluationSamplingProbability ===
          COMMERCIAL_QUALITY_EVALUATION_PROBABILITY &&
        row.sample.evidenceMetadata?.detectorSourceSha256 === bundle.detectorSourceSha256 &&
        row.sample.detectorVersion === 'commercial-deterministic-v5' &&
        row.sample.evidenceMetadata?.candidateDecision?.detectorVersion ===
          COMMERCIAL_INTENT_QUALITY_DECISION_VERSION &&
        row.sample.evidenceMetadata?.candidateDecision?.hasDetection != null &&
        row.sample.evidenceMetadata?.candidateDecision?.actionable != null &&
        row.sample.evidenceMetadata?.candidateDecision?.deleteEligible != null &&
        row.sample.evidenceMetadata?.hasDetection != null &&
        row.sample.evidenceMetadata?.deleteEligible != null,
    );
    const units = new Map<string, PairedUnit>();
    for (const row of usable) {
      const quality = row.sample.evidenceMetadata!;
      const candidate = quality.candidateDecision!;
      const expected = finalRating(row)?.expectedDisposition;
      const key = allGroups(groupKeys(row)[0]!);
      const unit = units.get(key) ?? {
        protected: false,
        offer: false,
        baselineFp: false,
        candidateFp: false,
        baselineMiss: false,
        candidateMiss: false,
        baselineRecognitionMiss: false,
        candidateRecognitionMiss: false,
        executionMiss: false,
        executionUnknown: false,
        confirmedDelete: false,
        alreadyAbsent: false,
      };
      const candidateDelete = isCommercialMessageDeleteEligible(
        candidate.actionBand,
        candidate.actionable === true,
        candidate.messageDisposition,
      );
      if (candidate.deleteEligible !== candidateDelete)
        errors.push('candidate_permission_inconsistent');
      if (expected === 'KEEP') {
        unit.protected = true;
        unit.baselineFp ||= quality.deleteEligible === true;
        unit.candidateFp ||= candidateDelete;
      } else if (expected === 'DELETE') {
        unit.offer = true;
        unit.baselineMiss ||= quality.deleteEligible !== true;
        unit.candidateMiss ||= !candidateDelete;
        unit.baselineRecognitionMiss ||= quality.hasDetection !== true;
        unit.candidateRecognitionMiss ||= candidate.hasDetection !== true;
        unit.executionUnknown ||= ['UNKNOWN', 'PENDING'].includes(quality.executionOutcome);
        unit.confirmedDelete ||= quality.executionOutcome === 'CONFIRMED_DELETE';
        unit.alreadyAbsent ||= quality.executionOutcome === 'ALREADY_ABSENT';
        unit.executionMiss ||= ![
          'CONFIRMED_DELETE',
          'ALREADY_ABSENT',
          'UNKNOWN',
          'PENDING',
        ].includes(quality.executionOutcome);
      }
      units.set(key, unit);
    }
    const values = [...units.values()];
    const negatives = values.filter((unit) => unit.protected);
    const offers = values.filter((unit) => unit.offer);
    const fpPair = paired(negatives.map((unit) => [unit.baselineFp, unit.candidateFp]));
    const missPair = paired(offers.map((unit) => [unit.baselineMiss, unit.candidateMiss]));
    const fpUpper = commercialWilson95(fpPair.candidateErrors, negatives.length)?.upper ?? null;
    const recallLower =
      commercialWilson95(offers.length - missPair.candidateErrors, offers.length)?.lower ?? null;
    const qualityPass =
      negatives.length >= 4000 &&
      offers.length >= 500 &&
      fpUpper !== null &&
      fpUpper <= 0.001 &&
      recallLower !== null &&
      recallLower >= 0.95;
    const pairedImprovement = fpPair.improved && missPair.improved;
    return {
      settings: {
        sensitivity: profile.sensitivity,
        warnThreshold: profile.warn,
        deleteThreshold: profile.remove,
      },
      evaluationFrame: 'stable_uniform_10_percent_logical_messages_collapsed_by_connected_groups',
      rows: selected.length,
      usableRows: usable.length,
      excludedRows: selected.length - usable.length,
      independentProtectedUnits: negatives.length,
      independentOfferUnits: offers.length,
      falseDeletionPermissions: fpPair,
      cleanupMisses: missPair,
      candidateFalseDeletionUpper95: fpUpper,
      candidateCleanupRecallLower95: recallLower,
      recognitionMisses: paired(
        offers.map((unit) => [unit.baselineRecognitionMiss, unit.candidateRecognitionMiss]),
      ),
      releasedExecution: {
        missedUnits: offers.filter((unit) => unit.executionMiss).length,
        unknownUnits: offers.filter((unit) => unit.executionUnknown).length,
        confirmedDeletionObservedUnits: offers.filter((unit) => unit.confirmedDelete).length,
        alreadyAbsentObservedUnits: offers.filter((unit) => unit.alreadyAbsent).length,
        knownOutcomeUnits: offers.filter((unit) => !unit.executionUnknown).length,
        // Shadow mode never executes candidate deletions; paired execution is unevaluated.
        candidateExecutionEvaluated: false,
      },
      qualityPass,
      pairedImprovement,
    };
  });
  const uniqueErrors = [...new Set(errors)].slice(0, 50);
  return {
    schemaVersion: 'commercial-quality-report/v1',
    inputSha256: createHash('sha256').update(JSON.stringify(bundle)).digest('hex'),
    frozenAt: bundle.frozenAt,
    evaluatedAt: bundle.evaluatedAt,
    scope: 'provided_private_own_reviewed_exports',
    populationDenominatorKnown: false,
    developmentRows: development.length,
    holdoutRows: holdout.length,
    developmentSourceWindow: isoSpan(devSpan),
    holdoutSourceWindow: isoSpan(holdoutSpan),
    coverage,
    profiles,
    provenanceErrors: uniqueErrors,
    textPairedImprovementInProvidedSample:
      uniqueErrors.length === 0 &&
      holdout.every(
        (row) =>
          row.sample.source !== 'TEXT' ||
          (row.sample.evidenceMetadata?.randomEvaluationIncluded != null &&
            PROFILES.some(
              (profile) => profile.digest === row.sample.evidenceMetadata?.settingsProfileDigest,
            )),
      ) &&
      profiles.every(
        (profile) => profile.qualityPass && profile.pairedImprovement && profile.excludedRows === 0,
      ),
    frameCoverage,
    textIndependentImprovementProven:
      frameCoverage.complete &&
      uniqueErrors.length === 0 &&
      profiles.every(
        (profile) => profile.qualityPass && profile.pairedImprovement && profile.excludedRows === 0,
      ),
    ocr: {
      evaluated: false,
      reason: 'requires_private_original_images_native_paired_evaluation',
      minimumNegativeUnits: 4603,
      minimumPositiveUnits: 500,
    },
    promotionAuthorized: false,
  };
}

function reconcileFrame(
  pages: CommercialQualityFramePage[] | undefined,
  rows: ExportItem[],
  errors: string[],
  expectedWindow: CommercialReviewExportResponse | undefined,
) {
  if (!pages?.length || pages.length > 200)
    return {
      supplied: false,
      complete: false,
      selectedTextRevisions: null,
      independentlyReviewedTextRevisions: null,
      missingTextRevisions: null,
    };
  let cursor: string | null = null;
  const first = pages[0]!.response;
  if (
    !expectedWindow ||
    first.since !== expectedWindow.since ||
    first.until !== expectedWindow.until
  )
    errors.push('frame_window_mismatch');
  const frame = new Map<string, CommercialReviewSamplingFrameResponse['items'][number]>();
  for (const page of pages) {
    if (page.response.samplingUnavailableRows !== 0)
      errors.push('frame_sampling_membership_unknown');
    if (
      page.cursor !== cursor ||
      page.response.since !== first.since ||
      page.response.until !== first.until ||
      page.response.complete !== (page.response.nextCursor === null)
    )
      errors.push('frame_pagination_incomplete');
    cursor = page.response.nextCursor;
    for (const entry of page.response.items) {
      if (entry.source !== 'TEXT') continue;
      const key = `${entry.source}:${entry.sourceSnapshotSha256}`;
      if (
        !entry.sourceSnapshotSha256 ||
        !entry.logicalMessageKey ||
        !entry.pseudonymizationKeyId ||
        entry.campaignGroupingComplete !== true ||
        entry.evaluationSamplingProbability !== COMMERCIAL_QUALITY_EVALUATION_PROBABILITY ||
        !PROFILES.some((profile) => profile.digest === entry.settingsProfileDigest)
      )
        errors.push('frame_metadata_incomplete');
      if (frame.has(key)) errors.push('duplicate_frame_source_revision');
      frame.set(key, entry);
    }
  }
  if (cursor !== null) errors.push('frame_pagination_truncated');
  const reviewed = new Set<string>();
  for (const row of rows) {
    if (
      row.sample.source !== 'TEXT' ||
      row.sample.evidenceMetadata?.randomEvaluationIncluded !== true
    )
      continue;
    const metadata = row.sample.evidenceMetadata!;
    const key = `TEXT:${metadata.sourceSnapshotSha256}`;
    const selected = frame.get(key);
    if (
      !selected ||
      selected.logicalMessageKey !== metadata.logicalMessageKey ||
      selected.pseudonymizationKeyId !== metadata.pseudonymizationKeyId ||
      selected.settingsProfileDigest !== metadata.settingsProfileDigest ||
      selected.messageCreatedAt !== metadata.messageCreatedAt
    )
      errors.push('review_outside_frozen_frame');
    if (selected && independentEvidence(row)) reviewed.add(key);
  }
  const missing = [...frame.keys()].filter((key) => !reviewed.has(key)).length;
  if (missing) errors.push('frame_independent_reviews_missing');
  return {
    supplied: true,
    complete: cursor === null && missing === 0 && frame.size > 0,
    selectedTextRevisions: frame.size,
    independentlyReviewedTextRevisions: reviewed.size,
    missingTextRevisions: missing,
  };
}

function readPages(
  pages: CommercialQualityExportPage[],
  role: string,
  errors: string[],
): ExportItem[] {
  if (!pages.length || pages.length > 200) {
    errors.push(`${role}_pages_missing_or_excessive`);
    return [];
  }
  const first = pages[0]!.response;
  let cursor: string | null = null;
  const rows: ExportItem[] = [];
  for (const page of pages) {
    if (
      page.cursor !== cursor ||
      page.response.since !== first.since ||
      page.response.until !== first.until
    )
      errors.push(`${role}_pagination_incomplete`);
    if (page.response.complete !== (page.response.nextCursor === null))
      errors.push(`${role}_pagination_inconsistent`);
    cursor = page.response.nextCursor;
    rows.push(...page.response.items);
  }
  if (cursor !== null) errors.push(`${role}_pagination_truncated`);
  return rows;
}

function groupKeys(row: ExportItem): string[] {
  const quality = row.sample.evidenceMetadata;
  if (!quality?.authorGroupId || !quality.campaignGroupId) return [];
  return [
    `author:${quality.authorGroupId}`,
    ...new Set(
      [quality.campaignGroupId, ...quality.campaignGroupIds].map((value) => `campaign:${value}`),
    ),
  ];
}
function sourceKeys(row: ExportItem): string[] {
  const quality = row.sample.evidenceMetadata;
  return [
    quality?.logicalMessageKey && `logical:${quality.logicalMessageKey}`,
    quality?.sourceSnapshotSha256 && `snapshot:${quality.sourceSnapshotSha256}`,
  ].filter((key): key is string => Boolean(key));
}
function finalRating(row: ExportItem) {
  return resolveCommercialLabelAuthority(row.ratings).finalRating;
}
function independentEvidence(row: ExportItem): boolean {
  const quality = row.sample.evidenceMetadata;
  const independent = row.ratings.filter((rating) => rating.kind === 'INDEPENDENT');
  const adjudication = row.ratings.filter(
    (rating) => rating.kind === 'ADJUDICATION' || rating.kind === 'SEMANTIC_ADJUDICATION',
  );
  const { finalRating: final, labelRatings } = resolveCommercialLabelAuthority(row.ratings);
  if (
    !row.eligibleForIndependentCorpus ||
    row.sample.reviewState !== 'RESOLVED' ||
    independent.length !== 2 ||
    new Set(row.ratings.map((rating) => rating.reviewerKey)).size !== row.ratings.length ||
    adjudication.length > 1 ||
    !quality?.sourceSnapshotSha256 ||
    !quality.logicalMessageKey ||
    groupKeys(row).length < 2 ||
    !quality.messageCreatedAt ||
    quality.campaignGroupingComplete !== true ||
    !quality.samplingProbability ||
    quality.samplingProbability > 1 ||
    !final ||
    final.label === 'UNSURE' ||
    !final.expectedDisposition
  )
    return false;
  // FLAG: A semantic adjudicator's own uncertainty cannot replace two agreed label votes.
  // Every stored review still has to pass the source, timestamp and actor evidence checks.
  if (labelRatings.some((rating) => rating.label === 'UNSURE' || !rating.expectedDisposition))
    return false;
  if (
    !adjudication.length &&
    (independent[0]!.label !== independent[1]!.label ||
      independent[0]!.expectedDisposition !== independent[1]!.expectedDisposition)
  )
    return false;
  if (row.sample.label !== final.label) return false;
  return row.ratings.every(
    (rating) =>
      Date.parse(rating.reviewedAt) >= Date.parse(quality.messageCreatedAt!) &&
      (row.sample.source === 'TEXT'
        ? rating.evidenceKind === 'TEXT' && quality.sourceExcerptComplete === true
        : rating.evidenceKind === 'PRIVATE_SOURCE_IMAGE' &&
          rating.sourceEvidenceDigest === quality.sourceSnapshotSha256),
  );
}
function connectedGroups(rows: ExportItem[]) {
  const parents = new Map<string, string>();
  const find = (key: string): string => {
    if (!parents.has(key)) parents.set(key, key);
    let root = key;
    while (parents.get(root) !== root) root = parents.get(root)!;
    let current = key;
    while (current !== root) {
      const next = parents.get(current)!;
      parents.set(current, root);
      current = next;
    }
    return root;
  };
  for (const row of rows) {
    const keys = groupKeys(row);
    for (const key of keys.slice(1)) parents.set(find(key), find(keys[0]!));
  }
  return find;
}
function summarizeCoverage(rows: ExportItem[]) {
  return {
    suppliedRows: rows.length,
    independentReviewedRows: rows.filter(independentEvidence).length,
    unresolvedRows: rows.filter((row) => row.sample.reviewState !== 'RESOLVED').length,
    uncertainRows: rows.filter((row) => finalRating(row)?.label === 'UNSURE').length,
    uncertainFraction: rows.length
      ? rows.filter((row) => finalRating(row)?.label === 'UNSURE').length / rows.length
      : null,
    incompleteTextRows: rows.filter(
      (row) =>
        row.sample.source === 'TEXT' && row.sample.evidenceMetadata?.sourceExcerptComplete !== true,
    ).length,
    captionOnlyImageRows: rows.filter(
      (row) => row.sample.source === 'OCR' && !independentEvidence(row),
    ).length,
    historicalLabelsIgnored: rows.filter((row) => row.sample.historicalLabel != null).length,
    technicalIncompleteRows: rows.filter(
      (row) => row.sample.evidenceMetadata?.analysisOutcome === 'TECHNICAL_INCOMPLETE',
    ).length,
    uniformEvaluationRows: rows.filter(
      (row) => row.sample.evidenceMetadata?.randomEvaluationIncluded === true,
    ).length,
    evaluationMembershipUnknownRows: rows.filter(
      (row) => row.sample.evidenceMetadata?.randomEvaluationIncluded == null,
    ).length,
  };
}
function paired(values: boolean[][]) {
  const corrected = values.filter(([baseline, candidate]) => baseline && !candidate).length;
  const regressed = values.filter(([baseline, candidate]) => !baseline && candidate).length;
  const discordant = corrected + regressed;
  // Exact one-sided paired sign/McNemar test; Bonferroni across FP and FN endpoints.
  // Stable binomial recurrence avoids factorial overflow on large corpora.
  let p = 1;
  if (discordant > 0 && corrected > regressed) {
    const logs = new Array<number>(regressed + 1);
    logs[0] = -discordant * Math.LN2;
    for (let k = 1; k <= regressed; k++)
      logs[k] = logs[k - 1]! + Math.log(discordant - k + 1) - Math.log(k);
    const max = Math.max(...logs);
    p = Math.min(1, Math.exp(max) * logs.reduce((sum, value) => sum + Math.exp(value - max), 0));
  }
  return {
    units: values.length,
    baselineErrors: values.filter(([baseline]) => baseline).length,
    candidateErrors: values.filter(([, candidate]) => candidate).length,
    correctedUnits: corrected,
    regressedUnits: regressed,
    oneSidedExactP: p,
    improved: corrected > regressed && p <= 0.025,
  };
}
function isoSpan(span: { first: number; last: number; milliseconds: number } | null) {
  return span
    ? {
        first: new Date(span.first).toISOString(),
        last: new Date(span.last).toISOString(),
        hours: span.milliseconds / 3600_000,
      }
    : null;
}
