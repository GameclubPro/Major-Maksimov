const ADMIN_MAX_MEDIA_FILE_NAME_MAX_LENGTH = 128;

function trimTrailingDotsAndSpaces(value: string): string {
  let end = value.length;
  while (end > 0 && (value[end - 1] === '.' || value[end - 1] === ' ')) {
    end -= 1;
  }
  return value.slice(0, end);
}

export function canonicalizeAdminMaxMediaFileName(
  fileName: string,
  extension: string,
  fallbackStem: string,
): string {
  const basename =
    fileName
      .normalize('NFC')
      .trim()
      .split(/[\\/]+/u)
      .pop()
      ?.trim() ?? '';
  const sanitized = trimTrailingDotsAndSpaces(
    basename
      .replace(/[\p{Cc}\p{Cf}]+/gu, '_')
      .replace(/[<>:"|?*]+/gu, '_')
      .replace(/_+/gu, '_')
      .replace(/\s+/gu, ' '),
  ).trim();
  const extensionStart = sanitized.lastIndexOf('.');
  const requestedStem = trimTrailingDotsAndSpaces(
    extensionStart === -1 ? sanitized : sanitized.slice(0, extensionStart),
  ).trim();
  const suffix = `.${extension}`;
  const maxStemLength = ADMIN_MAX_MEDIA_FILE_NAME_MAX_LENGTH - suffix.length;
  const truncatedStem = trimTrailingDotsAndSpaces(
    (requestedStem || fallbackStem).slice(0, Math.max(1, maxStemLength)),
  );
  return `${truncatedStem || fallbackStem.slice(0, Math.max(1, maxStemLength))}${suffix}`;
}
