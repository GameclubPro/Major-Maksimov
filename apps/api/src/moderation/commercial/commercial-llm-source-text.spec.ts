import { WebhookParser } from '../../webhook/webhook.parser';
import { commercialLlmSourceUpdate } from './commercial-llm-source-text';
import { prepareCommercialLlmOffer } from './commercial-llm-enforcement.protocol';
import type { CommercialDeleteSettings } from './commercial-delete-binding';

const settings: CommercialDeleteSettings = {
  commercialAdsFilterEnabled: true,
  commercialAdsSensitivity: 'BALANCED',
  commercialAdsWarnThreshold: 45,
  commercialAdsDeleteThreshold: 65,
  nightModeTimezone: 'UTC',
  textFiltersWarnEnabled: false,
  textFiltersBanEnabled: false,
  textFiltersMuteEnabled: false,
  textFiltersMuteDurationHours: 1,
  textFiltersBotMessageEnabled: false,
};
const now = Date.now();
function parse(message: Record<string, unknown>) {
  return new WebhookParser().parse({
    type: 'message_created',
    updateId: 'fixture',
    message: {
      sender: { user_id: '17' },
      recipient: { chat_id: 'chat', chat_type: 'chat' },
      timestamp: now,
      ...message,
    },
  });
}
const original =
  'Посоветуйте магазин мебели\nРемонт квартир под ключ по договору, принимаем заказы.';
const flat = original.replace('\n', ' ');
describe('visible commercial model source', () => {
  it('preserves the original body despite a flat presentation alias at intake and exact dispatch', () => {
    const parsed = parse({ text: flat, body: { mid: 'mid', text: original } });
    expect(parsed.message?.text).toBe(flat);
    const message = commercialLlmSourceUpdate(parsed).message!;
    expect(message.text).toBe(original);
    expect(
      commercialLlmSourceUpdate(parse({ body: { mid: 'mid', text: original } })).message?.text,
    ).toBe(message.text);
    const request = prepareCommercialLlmOffer(
      {
        chatId: message.chatId,
        messageId: message.messageId,
        userId: message.senderId,
        text: message.text,
        originBotId: 'bot',
        eventAt: new Date(now).toISOString(),
        settings,
        origin: {
          sourceWebhookEventId: 'fixture',
          sourceReceivingBotId: 'bot',
          sourceExecutionBotId: 'bot',
          sourceEventAtMs: now,
          sourceEvidenceVersion: 1,
        },
      },
      now,
    );
    expect(request.offer?.excerpt).toBe(original);
  });
  it('retains the visible forward while ignoring linked reply text and hidden contact markup', () => {
    const body = {
      mid: 'mid',
      text: 'Комментарий',
      markup: [{ type: 'link', url: 'https://example.org' }],
    };
    const forward = parse({ body, link: { type: 'forward', message: { text: original } } });
    expect(commercialLlmSourceUpdate(forward).message?.text).toBe('Комментарий ' + original);
    const reply = parse({ body, link: { type: 'reply', message: { text: original } } });
    expect(commercialLlmSourceUpdate(reply)).toBe(reply);
  });
  it('does not recover hidden source content when the presentation does not match', () => {
    const parsed = parse({ body: { mid: 'mid', text: original } });
    const changed = { ...parsed, message: { ...parsed.message!, text: 'Другой исходный текст' } };
    expect(commercialLlmSourceUpdate(changed)).toBe(changed);
  });
});
