import { z } from 'zod';
import type { MaxMessageButton } from '../max/max-client.service';
import { nativeContentSchema, type NativeSuggestionContent } from './suggestion-native-content';
import type { SuggestionNativeAction } from './suggestion-native-protocol';

export const nativeDraftSchema = nativeContentSchema.extend({
  warnings: z.array(z.string()).max(400),
});

export function readNativeDraft(value: unknown) {
  const parsed = nativeDraftSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

export function suggestionEditView(
  content: NativeSuggestionContent,
  button: (text: string, action: SuggestionNativeAction) => MaxMessageButton,
  options: { source: boolean; resume: boolean; error: string },
): { text: string; buttons: MaxMessageButton[][] } {
  const copyable = content.text.length > 0 && content.text.length <= 1024;
  const instruction =
    'Редактирование предложки\n\n' +
    (content.text
      ? copyable
        ? 'Скопируйте текст кнопкой ниже. '
        : 'Откройте «Текст для копирования» и скопируйте сообщение. '
      : '') +
    'Выберите «Ответить» на этой карточке, вставьте и исправьте текст, затем отправьте его.\n\n' +
    'После ответа появятся предпросмотр, «Сохранить» и «Опубликовать». Автор, фото и видео сохранятся.';
  const guide = [options.error, instruction].filter(Boolean).join('\n\n');
  const withBody = `${guide}\n\nТекст для правки:\n${content.text}`;
  // FLAG: Plain copy text must be complete, without author attribution, UI copy or Markdown escapes.
  const text =
    options.source && !options.error
      ? content.text
      : content.text && withBody.length <= 4000
        ? withBody
        : guide;
  const buttons: MaxMessageButton[][] = [];
  if (copyable)
    buttons.push([{ type: 'clipboard', text: 'Скопировать текст', payload: content.text }]);
  else if (content.text && !options.source)
    buttons.push([button('Текст для копирования', 'source')]);
  if (options.source) buttons.push([button('К редактированию', 'hint')]);
  if (options.resume && !options.error) buttons.push([button('К предпросмотру', 'preview')]);
  buttons.push([button('Отмена', 'back')]);
  return { text, buttons };
}
