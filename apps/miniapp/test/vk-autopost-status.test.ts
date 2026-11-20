import assert from 'node:assert/strict';
import test from 'node:test';
import { vkParsingSettingsSchema, vkParsingSourceSchema } from '@maxim/contracts/vk-parsing';
import { getVkAutoEnableSources, isVkAutomaticSource } from '../src/components/vk-parsing/model';
import { buildAutopostStatus } from '../src/components/vk-parsing/autopost-status';
import { parseVkQueueDate, resolveVkQueueQuickSlot } from '../src/components/vk-parsing/queue-time';

const settings = vkParsingSettingsSchema.parse({
  chatId: 'chat',
  autoPublishEnabled: true,
  schedulerTimezone: 'Europe/Moscow',
});
const source = vkParsingSourceSchema.parse({
  id: 'source',
  chatId: 'chat',
  ownerId: -1,
  wallOwnerId: -1,
  screenName: 'source',
  title: 'Источник',
  url: 'https://vk.com/source',
  status: 'ACTIVE',
  autoPublishEnabled: true,
  lastSyncAt: null,
  lastError: null,
  createdAt: '2026-09-01T00:00:00Z',
  updatedAt: '2026-09-01T00:00:00Z',
});
const now = new Date('2026-09-08T10:00:00Z');

test('autopost status distinguishes manual, pause and review without promising delivery', () => {
  assert.equal(
    buildAutopostStatus({ ...settings, autoPublishEnabled: false }, [source], now).title,
    'Ручной режим',
  );
  assert.equal(
    buildAutopostStatus({ ...settings, autoPublishKillSwitchEnabled: true }, [source], now).tone,
    'muted',
  );
  assert.equal(
    buildAutopostStatus(settings, [{ ...source, publishMode: 'REVIEW' }], now).title,
    'На проверке',
  );
  assert.equal(buildAutopostStatus(settings, [source], now).title, 'Авто включено');
});

test('disabled sources do not turn healthy automation into an error', () => {
  assert.equal(
    buildAutopostStatus(
      settings,
      [source, { ...source, importEnabled: false, syncStatus: 'ERROR' }],
      now,
    ).tone,
    'success',
  );
  assert.equal(buildAutopostStatus(settings, [], now).title, 'Нет источников');
  assert.equal(
    buildAutopostStatus(settings, [{ ...source, autoPublishEnabled: false }], now).title,
    'Авто не настроено',
  );
});

test('autopost uses the scheduler zone, supports midnight and exclusive range ends', () => {
  const midnight = { ...settings, workHoursStart: '22:00', workHoursEnd: '06:00' };
  assert.equal(
    buildAutopostStatus(midnight, [source], new Date('2026-09-08T21:00:00Z')).tone,
    'success',
  );
  assert.equal(
    buildAutopostStatus(midnight, [source], new Date('2026-09-08T03:00:00Z')).title,
    'Ожидает расписания',
  );
  assert.equal(
    buildAutopostStatus(
      { ...settings, quietHoursStart: '13:00', quietHoursEnd: '14:00' },
      [source],
      now,
    ).title,
    'Тихие часы',
  );
  assert.equal(
    buildAutopostStatus({ ...settings, schedulerTimezone: 'Invalid/Zone' }, [source], now).title,
    'Проверьте время',
  );
});

test('autopost status respects source quiet windows, burst protection and partial failure', () => {
  assert.equal(
    buildAutopostStatus(
      settings,
      [{ ...source, quietHoursStart: '13:00', quietHoursEnd: '14:00' }],
      now,
    ).title,
    'Источники на паузе',
  );
  assert.equal(
    buildAutopostStatus(
      settings,
      [{ ...source, autoPublishEnabled: false, autoPublishPausedReason: 'circuit_breaker' }],
      now,
    ).title,
    'Сработала защита',
  );
  assert.equal(
    buildAutopostStatus(settings, [source, { ...source, syncStatus: 'ERROR' }], now).tone,
    'warning',
  );
});

test('a protected group stays visible beside a healthy group and does not count for enabling', () => {
  const protect = {
    ...source,
    id: 'paused',
    autoPublishEnabled: false,
    autoPublishPausedAt: now.toISOString(),
    autoPublishPausedReason: 'circuit_breaker',
  };
  const manual = {
    ...source,
    id: 'manual',
    autoPublishEnabled: false,
    autoPublishPausedReason: 'manual',
  };
  const inactive = { ...source, id: 'inactive', importEnabled: false };
  const review = { ...source, id: 'review', publishMode: 'REVIEW' as const };
  const sources = [source, manual, protect, inactive, review];
  assert.deepEqual(
    sources.filter(isVkAutomaticSource).map(({ id }) => id),
    ['source'],
  );
  assert.deepEqual(
    getVkAutoEnableSources(settings, sources).map(({ id }) => id),
    ['source', 'manual'],
  );
  assert.deepEqual(
    getVkAutoEnableSources({ ...settings, autoPublishKillSwitchEnabled: true }, sources).map(
      ({ id }) => id,
    ),
    ['source'],
  );
  assert.equal(buildAutopostStatus(settings, [source, protect], now).tone, 'warning');
});

test('queue input rejects empty, past, invalid and nonexistent local timestamps', () => {
  for (const value of ['', 'T12:00', '2026-02-30T12:00', '2026-03-29T02:30']) {
    assert.equal(
      parseVkQueueDate(value, 'Europe/Berlin', Date.parse('2026-01-01T00:00:00Z')),
      null,
    );
  }
  assert.equal(parseVkQueueDate('2026-01-01T12:00', 'UTC', now.getTime()), null);
  assert.equal(
    parseVkQueueDate('2026-09-09T13:00', 'Europe/Moscow', now.getTime()),
    '2026-09-09T10:00:00.000Z',
  );
});

test('queue quick slots work across daylight-saving boundaries', () => {
  assert.equal(
    resolveVkQueueQuickSlot(null, 'Europe/Berlin', Date.parse('2026-03-28T12:00:00Z')),
    '2026-03-29T07:00:00.000Z',
  );
  assert.equal(
    resolveVkQueueQuickSlot(30, 'Europe/Moscow', now.getTime()),
    '2026-09-08T10:30:00.000Z',
  );
});
