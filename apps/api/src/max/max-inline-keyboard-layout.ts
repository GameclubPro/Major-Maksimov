import { normalizeHttpButtonUrl } from '@maxim/contracts';

const MAX_INLINE_KEYBOARD_BUTTONS = 210;
const MAX_INLINE_KEYBOARD_ROWS = 30;
const MAX_INLINE_KEYBOARD_BUTTONS_PER_ROW = 7;
const MAX_INLINE_KEYBOARD_ACTION_BUTTONS_PER_ROW = 1;
const MAX_INLINE_KEYBOARD_ROW_TEXT_WEIGHT = 22;
const MAX_INLINE_KEYBOARD_FULL_WIDTH_BUTTON_TYPES = new Set([
  'link',
  'open_app',
  'request_contact',
  'request_geo_location',
]);

export type MaxInlineKeyboardTrimDetails = {
  requestedButtons: number;
  deliveredButtons: number;
  requestedRows: number;
  deliveredRows: number;
  buttonLimit: number;
  rowLimit: number;
};

export type MaxInlineKeyboardLayoutOptions = {
  onTrimmed?: (details: MaxInlineKeyboardTrimDetails) => void;
};

export function normalizeMaxInlineKeyboardButtons(
  sourceButtons: readonly unknown[],
  options: MaxInlineKeyboardLayoutOptions = {},
): Array<Array<Record<string, unknown>>> | null {
  if (sourceButtons.length === 0) {
    return null;
  }

  const rows: Array<Array<Record<string, unknown>>> = [];
  const requestedButtons = sourceButtons.reduce<number>(
    (acc, row) => acc + (Array.isArray(row) ? row.length : 0),
    0,
  );
  const requestedRows = sourceButtons.filter((row) => Array.isArray(row) && row.length > 0).length;
  let totalButtons = 0;
  let truncated = false;
  let rowBuffer: Array<Record<string, unknown>> = [];
  let rowLimit = MAX_INLINE_KEYBOARD_BUTTONS_PER_ROW;
  let rowTextWeight = 0;

  const flushRow = (): boolean => {
    if (rowBuffer.length === 0) {
      return true;
    }

    if (rows.length >= MAX_INLINE_KEYBOARD_ROWS) {
      rowBuffer = [];
      rowLimit = MAX_INLINE_KEYBOARD_BUTTONS_PER_ROW;
      rowTextWeight = 0;
      truncated = true;
      return false;
    }

    rows.push(rowBuffer);
    rowBuffer = [];
    rowLimit = MAX_INLINE_KEYBOARD_BUTTONS_PER_ROW;
    rowTextWeight = 0;
    return true;
  };

  for (const row of sourceButtons) {
    if (!Array.isArray(row) || row.length === 0) {
      continue;
    }

    for (const button of row) {
      if (totalButtons >= MAX_INLINE_KEYBOARD_BUTTONS) {
        truncated = true;
        break;
      }

      const normalizedButton = normalizeMaxInlineKeyboardButton(button);
      if (normalizedButton) {
        const buttonRowLimit = resolveInlineKeyboardButtonRowLimit(normalizedButton);
        const buttonTextWeight = measureInlineKeyboardButtonTextWeight(normalizedButton);
        const nextRowLimit =
          rowBuffer.length === 0 ? buttonRowLimit : Math.min(rowLimit, buttonRowLimit);
        if (
          rowBuffer.length > 0 &&
          (rowBuffer.length >= nextRowLimit ||
            rowTextWeight + buttonTextWeight > MAX_INLINE_KEYBOARD_ROW_TEXT_WEIGHT) &&
          !flushRow()
        ) {
          break;
        }
        if (rows.length >= MAX_INLINE_KEYBOARD_ROWS && rowBuffer.length === 0) {
          truncated = true;
          break;
        }

        rowLimit = rowBuffer.length === 0 ? buttonRowLimit : Math.min(rowLimit, buttonRowLimit);
        rowBuffer.push(normalizedButton);
        rowTextWeight += buttonTextWeight;
        totalButtons += 1;

        if (rowBuffer.length >= rowLimit && !flushRow()) {
          break;
        }
      }
    }

    flushRow();

    if (truncated) {
      break;
    }
  }

  if (truncated || requestedButtons > totalButtons || requestedRows > MAX_INLINE_KEYBOARD_ROWS) {
    options.onTrimmed?.({
      requestedButtons,
      deliveredButtons: totalButtons,
      requestedRows,
      deliveredRows: rows.length,
      buttonLimit: MAX_INLINE_KEYBOARD_BUTTONS,
      rowLimit: MAX_INLINE_KEYBOARD_ROWS,
    });
  }

  return rows.length > 0 ? rows : null;
}

function normalizeMaxInlineKeyboardButton(button: unknown): Record<string, unknown> | null {
  const source = asInlineKeyboardButtonSource(button);
  if (!source) {
    return null;
  }

  const text = readTrimmedString(source.text);
  if (!text) {
    return null;
  }

  const explicitType = readLowerString(source.type);
  const type = explicitType ?? (source.url !== undefined ? 'link' : null);

  switch (type) {
    case 'link': {
      const url = normalizeHttpInlineKeyboardUrl(source.url);
      if (!url) {
        return null;
      }
      return {
        type: 'link',
        text,
        url,
      };
    }
    case 'callback': {
      const payload = readTrimmedString(source.payload);
      if (!payload) {
        return null;
      }

      const intent = readLowerString(source.intent);

      return {
        type: 'callback',
        text,
        payload,
        ...(intent === 'default' || intent === 'positive' || intent === 'negative'
          ? { intent }
          : {}),
      };
    }
    case 'open_app': {
      const webApp = normalizeHttpInlineKeyboardUrl(source.webApp ?? source.web_app);
      const contactIdCandidate = source.contactId ?? source.contact_id;
      const contactId =
        typeof contactIdCandidate === 'number'
          ? String(contactIdCandidate)
          : typeof contactIdCandidate === 'string'
            ? contactIdCandidate.trim()
            : '';
      if (!webApp && !contactId) {
        return null;
      }

      return {
        type: 'open_app',
        text,
        ...(webApp ? { web_app: webApp } : {}),
        ...(contactId ? { contact_id: contactId } : {}),
      };
    }
    case 'request_contact':
      return {
        type: 'request_contact',
        text,
      };
    case 'request_geo_location': {
      const quick = typeof source.quick === 'boolean' ? source.quick : undefined;
      return {
        type: 'request_geo_location',
        text,
        ...(quick !== undefined ? { quick } : {}),
      };
    }
    case 'clipboard': {
      const payload =
        typeof source.payload === 'string' && source.payload.length <= 1024 ? source.payload : '';
      if (!payload) {
        return null;
      }

      return {
        type: 'clipboard',
        text,
        payload,
      };
    }
    case 'chat': {
      const chatTitle = readTrimmedString(source.chatTitle ?? source.chat_title);
      if (!chatTitle) {
        return null;
      }

      const chatDescription = readTrimmedString(source.chatDescription ?? source.chat_description);
      const startPayload = readTrimmedString(source.startPayload ?? source.start_payload);
      const uuid = readTrimmedString(source.uuid);

      return {
        type: 'chat',
        text,
        chat_title: chatTitle,
        ...(chatDescription ? { chat_description: chatDescription } : {}),
        ...(startPayload ? { start_payload: startPayload } : {}),
        ...(uuid ? { uuid } : {}),
      };
    }
    default:
      return null;
  }
}

function asInlineKeyboardButtonSource(button: unknown): Record<string, unknown> | null {
  if (!button || typeof button !== 'object' || Array.isArray(button)) {
    return null;
  }

  return button as Record<string, unknown>;
}

function readTrimmedString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function readLowerString(value: unknown): string | null {
  const normalized = readTrimmedString(value);
  return normalized ? normalized.toLowerCase() : null;
}

function normalizeHttpInlineKeyboardUrl(value: unknown): string | null {
  return typeof value === 'string' ? normalizeHttpButtonUrl(value) : null;
}

function resolveInlineKeyboardButtonRowLimit(button: Record<string, unknown>): number {
  const type = typeof button.type === 'string' ? button.type.trim().toLowerCase() : '';
  return MAX_INLINE_KEYBOARD_FULL_WIDTH_BUTTON_TYPES.has(type)
    ? MAX_INLINE_KEYBOARD_ACTION_BUTTONS_PER_ROW
    : MAX_INLINE_KEYBOARD_BUTTONS_PER_ROW;
}

function measureInlineKeyboardButtonTextWeight(button: Record<string, unknown>): number {
  const text = typeof button.text === 'string' ? button.text.trim() : '';
  if (!text) {
    return 0;
  }

  return measureMaxInlineKeyboardTextWeight(text);
}

export function measureMaxInlineKeyboardTextWeight(value: string): number {
  return Array.from(value).reduce((weight, char) => {
    if (/\p{Emoji_Presentation}|\p{Extended_Pictographic}/u.test(char)) {
      return weight + 2;
    }

    if ((char.codePointAt(0) ?? 0) > 0x7f) {
      return weight + 1;
    }

    return weight + 0.7;
  }, 0);
}
