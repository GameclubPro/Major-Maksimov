import type {
  ChatClosureStatus,
  ChatClosureSummary,
  ChatSettings,
} from '@maxim/contracts/settings';

export function createPreviewOpenChatClosure(
  settings: ChatSettings,
  observedAt: Date,
): ChatClosureStatus {
  return {
    observedAt: observedAt.toISOString(),
    scheduleEnabled: settings.nightModeEnabled,
    restriction: 'open',
    timezone: settings.nightModeTimezone,
    opensAt: null,
    deleteRoute: 'available',
    notice: settings.nightModeBotMessageEnabled ? 'not_expected' : 'disabled',
    recovery: 'idle',
    nextTransitionAt: null,
    notices: {
      expectationBasis: 'current_schedule',
      boundary:
        settings.nightModeStartTimeMinutes === settings.nightModeEndTimeMinutes
          ? 'continuous'
          : 'unavailable',
      evidenceScope: 'exact_send_ledger',
      sendRouteNow: 'unknown',
      close: { enabledNow: settings.nightModeBotMessageEnabled, latest: null },
      open: { enabledNow: settings.nightModeOpenMessageEnabled, latest: null },
      recovery: { scope: 'latest_occurrences', observation: 'unavailable', obligations: [] },
    },
  };
}

export function createPreviewChatClosureSummary(
  settings: ChatSettings,
  now: Date,
): ChatClosureSummary {
  const minutes = new Intl.DateTimeFormat('en-GB', {
    timeZone: settings.nightModeTimezone,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  })
    .format(now)
    .split(':')
    .map(Number);
  const localMinute = minutes[0] * 60 + minutes[1];
  const start = settings.nightModeStartTimeMinutes;
  const end = settings.nightModeEndTimeMinutes;
  const nightActive =
    settings.nightModeEnabled &&
    (start < end
      ? start <= localMinute && localMinute < end
      : localMinute >= start || localMinute < end);
  const until = Date.parse(settings.nightModeForceCloseUntil);
  const manualMode = !settings.nightModeForceCloseEnabled
    ? null
    : settings.nightModeForceCloseForever
      ? 'forever'
      : until > now.getTime()
        ? 'timed'
        : null;
  return {
    observedAt: now.toISOString(),
    scheduleEnabled: settings.nightModeEnabled,
    restriction: manualMode ? 'manual' : nightActive ? 'night' : 'open',
    manualMode,
    nightActive,
    timezone: settings.nightModeTimezone,
    opensAt:
      manualMode === 'timed' && !settings.nightModeEnabled ? new Date(until).toISOString() : null,
    nextTransitionAt: manualMode === 'timed' ? new Date(until).toISOString() : null,
    deleteRoute: 'available',
    sendRoute: 'available',
    notificationsEnabled:
      settings.nightModeEnabled &&
      (settings.nightModeBotMessageEnabled || settings.nightModeOpenMessageEnabled),
  };
}
