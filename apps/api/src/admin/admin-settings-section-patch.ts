import { patchSettingsSectionRequestSchema, type ChatSettings } from '@maxim/contracts';
import { BadRequestException, ConflictException } from '@nestjs/common';
import {
  SETTINGS_SECTION_BOT_SPEECH_MEDIA_KEYS,
  SETTINGS_SECTION_KEYS,
} from './admin.service.support';

// FLAG: A section patch authors only that section. The caller's original revision fences the
// server merge; independent stop-list and Publisher ownership remain outside this endpoint.
export function buildSettingsSectionPatch(current: ChatSettings, body: unknown): ChatSettings {
  const parsed = patchSettingsSectionRequestSchema.safeParse(body);
  if (!parsed.success) throw new BadRequestException(parsed.error.format());
  const { section, changes, expectedRevision } = parsed.data;
  if (section === 'stopWords') throw new BadRequestException('Используйте редактор стоп-слов.');
  if (!current.settingsRevision || current.settingsRevision !== expectedRevision) {
    throw new ConflictException({
      code: 'CHAT_SETTINGS_CONCURRENT_UPDATE',
      message: 'Настройки изменились. Обновите экран и сравните изменения с черновиком.',
    });
  }
  const mediaKeys: readonly string[] = SETTINGS_SECTION_BOT_SPEECH_MEDIA_KEYS[section];
  const allowed = new Set<string>(SETTINGS_SECTION_KEYS[section]);
  if (mediaKeys.length > 0) allowed.add('botSpeechMedia');
  const unknown = Object.keys(changes).filter((key) => !allowed.has(key));
  if (unknown.length > 0) throw new BadRequestException('Изменения содержат поля другого блока.');
  const next = { ...current, ...changes, settingsRevision: expectedRevision } as ChatSettings;
  // FLAG: Merging a section must not author or clear an unrelated commercial policy.
  if (!Object.hasOwn(changes, 'commercialAdsPolicy'))
    delete (next as Partial<ChatSettings>).commercialAdsPolicy;
  if (Object.hasOwn(changes, 'botSpeechMedia')) {
    const media = changes.botSpeechMedia;
    if (!media || typeof media !== 'object' || Array.isArray(media)) {
      throw new BadRequestException('Некорректные изображения сообщений.');
    }
    if (Object.keys(media).some((key) => !mediaKeys.includes(key))) {
      throw new BadRequestException('Изображения содержат поля другого блока.');
    }
    next.botSpeechMedia = { ...current.botSpeechMedia };
    for (const key of mediaKeys) {
      const field = key as keyof ChatSettings['botSpeechMedia'];
      if (Object.hasOwn(media, key))
        next.botSpeechMedia[field] = (media as ChatSettings['botSpeechMedia'])[field];
      else delete next.botSpeechMedia[field];
    }
  }
  delete next.stopWordsPolicy;
  delete next.stopWordsRevision;
  return next;
}
