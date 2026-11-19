function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** Visible aliases of one message only; replies and forwards belong to separate content. */
export function extractMaxVisibleContentTextSegments(
  message: Record<string, unknown>,
  options: { preserveParagraphBoundaries?: boolean; preferLineBreaks?: boolean } = {},
): string[] {
  const body = asRecord(message.body);
  const content = asRecord(message.content);
  const payload = asRecord(message.payload);
  const nested = asRecord(message.message);
  const candidates = [
    message.text,
    message.caption,
    message.plain,
    message.message_text,
    message.messageText,
    body?.text,
    body?.caption,
    body?.plain,
    content?.text,
    content?.caption,
    content?.plain,
    payload?.text,
    payload?.caption,
    payload?.plain,
    nested?.text,
    nested?.caption,
    nested?.plain,
    nested?.message_text,
    nested?.messageText,
  ];
  const segments = new Map<string, string>();
  const paragraphCount = (value: string) =>
    value.match(/[\f\u2029]|\n[\p{Zs}\t]*\n/gu)?.length ?? 0;
  const lineCount = (value: string) => value.match(/\r\n|[\r\n\v\f\u2028\u2029]/gu)?.length ?? 0;
  for (const value of candidates) {
    if (typeof value !== 'string') continue;
    const key = value.replace(/\s+/gu, ' ').trim().toLowerCase();
    if (!key) continue;
    const previous = segments.get(key);
    // FLAG: Keep source whitespace and paragraphs; only the parser's presentation flattens them.
    // Equivalent aliases may include an already flattened copy. Prefer the copy retaining
    // paragraph barriers so that deduplication cannot turn it into an actionable phrase.
    if (
      previous === undefined ||
      (options.preserveParagraphBoundaries !== false &&
        paragraphCount(value.replace(/\r\n|\r|\v|\u2028/gu, '\n')) >
          paragraphCount(previous.replace(/\r\n|\r|\v|\u2028/gu, '\n'))) ||
      (options.preferLineBreaks === true && lineCount(value) > lineCount(previous))
    )
      segments.set(key, value);
  }
  return [...segments.values()];
}
