import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveModerationFeedReason } from '../src/lib/moderation-feed-reason';

test('shows allowlist link reason instead of only message excerpt', () => {
  assert.equal(
    resolveModerationFeedReason({
      ruleCode: 'LINK_BLOCKED_DELETE',
      metadata: { reason: 'Link https://spam.example is not in allowlist' },
    }),
    'Ссылка https://spam.example не входит в разрешённый список.',
  );
});

test('keeps action-suffixed delete rules normalized to their base rule', () => {
  assert.equal(
    resolveModerationFeedReason({
      ruleCode: 'LINK_BLOCKED_DELETE',
      metadata: {},
    }),
    'Ссылка запрещена настройками чата.',
  );
});

test('shows the configured delay for a bot-message auto-cleanup event', () => {
  assert.equal(
    resolveModerationFeedReason({
      ruleCode: 'BOT_MESSAGE_AUTO_DELETE',
      metadata: {
        reason: 'Bot-authored message deleted after configured delay',
        delayMinutes: 2,
      },
    }),
    'Сообщение бота удалено по настройкам автоочистки через 2 мин.',
  );
});

test('preserves standalone moderation delete rule codes', () => {
  assert.equal(
    resolveModerationFeedReason({
      ruleCode: 'NIGHT_MODE_DELETE',
      metadata: {
        nightModeStartTime: '20:00',
        nightModeEndTime: '06:00',
        nightModeTimezone: 'Europe/Moscow',
      },
    }),
    'Чат закрыт на ночь: 20:00–06:00 (Московское время).',
  );
  assert.equal(
    resolveModerationFeedReason({ ruleCode: 'MUTE_ACTIVE_DELETE', metadata: {} }),
    'На момент отправки участнику было запрещено писать.',
  );
  assert.equal(
    resolveModerationFeedReason({ ruleCode: 'MANUAL_GROUP_CLOSE_DELETE', metadata: {} }),
    'Группа закрыта вручную, новые сообщения временно удаляются.',
  );
});

test('shows blocked word from moderation metadata', () => {
  assert.equal(
    resolveModerationFeedReason({
      ruleCode: 'MESSAGE_BLOCKED_WORD_DELETE',
      metadata: { blockedWord: 'казино', reason: 'Blocked word detected: казино' },
    }),
    'Стоп-слово: казино.',
  );
});

test('shows structured profanity categories and keeps the legacy fallback', () => {
  const cases = [
    ['PROFANITY_DELETE', 'CORE_MAT', 'Нецензурная лексика.'],
    ['PROFANITY', 'SEVERE_ABUSE', 'Грубое оскорбление.'],
    ['PROFANITY_DELETE', 'MILD_INSULT', 'Оскорбление по строгому режиму.'],
  ] as const;

  for (const [ruleCode, category, expected] of cases) {
    assert.equal(
      resolveModerationFeedReason({
        ruleCode,
        metadata: {
          category,
          reason: 'Detected profanity or abusive language pattern',
        },
      }),
      expected,
    );
  }

  assert.equal(
    resolveModerationFeedReason({
      ruleCode: 'PROFANITY_DELETE',
      metadata: { reason: 'Detected profanity or abusive language pattern' },
    }),
    'Грубая лексика запрещена правилами чата.',
  );
});

test('summarizes commercial ad evidence', () => {
  const reason = resolveModerationFeedReason({
    ruleCode: 'COMMERCIAL_AD_DELETE',
    metadata: {
      reason: 'Detected Russian commercial ad pattern',
      primarySubtype: 'SERVICES',
      featureVector: {
        contactEvidence: 1,
        priceStructure: 1,
      },
    },
  });

  assert.match(reason, /Коммерческая реклама запрещена/u);
  assert.match(reason, /услуги/u);
  assert.match(reason, /контакт и цена/u);
});

test('renders image OCR sentinels as their privacy-safe stop-list reason', () => {
  assert.equal(
    resolveModerationFeedReason({
      ruleCode: 'COMMERCIAL_OCR_DELETE',
      metadata: {
        source: 'image_text_ocr',
        matchedRuleCode: 'MESSAGE_BLOCKED_WORD',
        blockedWord: 'казино',
      },
    }),
    'Стоп-слово: казино.',
  );

  assert.equal(
    resolveModerationFeedReason({
      ruleCode: 'COMMERCIAL_OCR_DELETE',
      metadata: {
        source: 'image_text_ocr',
        matchedRuleCode: 'MESSAGE_BLOCKED_DOMAIN',
        blockedDomain: 'spam.example',
      },
    }),
    'Запрещённый домен: spam.example.',
  );
});

test('shows required subscription targets when available', () => {
  assert.equal(
    resolveModerationFeedReason({
      ruleCode: 'REQUIRED_SUBSCRIPTION_DELETE',
      metadata: { missingChannelTitles: ['Новости', 'Анонсы'] },
    }),
    'Нет подписки на обязательные чаты или каналы: Новости, Анонсы.',
  );
});

test('translates message length deletion reason', () => {
  assert.equal(
    resolveModerationFeedReason({
      ruleCode: 'MESSAGE_TOO_LONG_DELETE',
      metadata: { reason: 'Message length 187 exceeds limit 100' },
    }),
    'Сообщение длиннее лимита: 187 из 100 символов.',
  );
});

test('shows the forwarded-message restriction for base and delete rule codes', () => {
  const cases = [
    { ruleCode: 'FORWARDED_MESSAGE_BLOCKED', metadata: {} },
    {
      ruleCode: 'FORWARDED_MESSAGE_BLOCKED_DELETE',
      metadata: { reason: 'Forwarded messages are disabled by chat settings' },
    },
  ] as const;

  for (const violation of cases) {
    assert.equal(
      resolveModerationFeedReason(violation),
      'Пересланные сообщения в этом чате запрещены.',
    );
  }
});

test('explains duplicate moderation window', () => {
  assert.equal(
    resolveModerationFeedReason({
      ruleCode: 'DUPLICATE_DELETE',
      metadata: { count: 2, threshold: 2, windowSec: 12 * 60 * 60 },
    }),
    'Повтор сообщения: 2/2 за 12ч.',
  );
});

test('distinguishes repeated photos and albums from text', () => {
  assert.equal(
    resolveModerationFeedReason({
      ruleCode: 'DUPLICATE_DELETE',
      metadata: { fingerprintType: 'image', count: 1, windowSec: 3600 },
    }),
    'Повтор фото за 1ч.',
  );
  assert.equal(
    resolveModerationFeedReason({
      ruleCode: 'DUPLICATE_BAN',
      metadata: { fingerprintType: 'image_set', count: 3, threshold: 2 },
    }),
    'Повтор альбома: 3/2.',
  );
});

test('keeps retired topic-filter violations readable in historical events', () => {
  assert.equal(
    resolveModerationFeedReason({
      ruleCode: 'TOPIC_FILTER_MISMATCH',
      metadata: { requiredCodeword: 'максим' },
    }),
    'Сообщение должно начинаться с кодового слова "максим".',
  );
});

test('explains current AI deletions using saved categories without generic fallback', () => {
  assert.match(
    resolveModerationFeedReason({
      ruleCode: 'COMMERCIAL_LLM_DELETE',
      metadata: { commercialAdsDecision: { categories: ['SERVICES'] } },
    }),
    /услуги/u,
  );
  assert.match(
    resolveModerationFeedReason({
      ruleCode: 'COMMERCIAL_LLM_DELETE',
      metadata: { commercialAdsDecision: { categories: ['PERSONAL_SALE'] } },
    }),
    /личные продажи/u,
  );
  assert.equal(
    resolveModerationFeedReason({ ruleCode: 'COMMERCIAL_LLM_DELETE', metadata: {} }),
    'Реклама запрещена правилами чата.',
  );
  assert.equal(
    resolveModerationFeedReason({ ruleCode: 'COMMERCIAL_OCR_DELETE', metadata: {} }),
    'Реклама на изображении.',
  );
  assert.equal(
    resolveModerationFeedReason({ ruleCode: 'FUTURE_RULE_DELETE', metadata: {} }),
    'Причина не сохранена.',
  );
});
