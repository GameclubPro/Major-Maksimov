import { normalizeNavigationAllowlistTarget } from '@maxim/contracts/settings';

const GOOGLE_SEARCH_LINK_PREFIX = 'https://www.google.com/url?';
const MAX_WRAPPER_LENGTH = 2_048;
const TRACKING_PARAMETERS = new Set(['sa', 'source', 'rct', 'opi', 'ved', 'sqi', 'usg']);
const WHITESPACE_OR_CONTROL = /[\s\p{Cc}\p{Cf}]/u;

export function readGoogleSearchLinkDestination(value: string): string | null {
  if (
    value.length > MAX_WRAPPER_LENGTH ||
    !value.startsWith(GOOGLE_SEARCH_LINK_PREFIX) ||
    value.includes('#') ||
    value.includes('\\') ||
    WHITESPACE_OR_CONTROL.test(value)
  ) {
    return null;
  }
  const wrapper = new URL(value);

  // FLAG: Infer one destination only for this known wrapper. Competing or unknown
  // parameters leave the original link subject to its existing rules.
  const seen = new Set<string>();
  let destination: string | null = null;
  for (const [name, parameter] of wrapper.searchParams) {
    if (seen.has(name)) return null;
    seen.add(name);
    if (name === 'url') {
      destination = parameter;
    } else if (!TRACKING_PARAMETERS.has(name) && !(name === 'q' && parameter === '')) {
      return null;
    }
  }
  if (
    !destination ||
    !/^https?:\/\//iu.test(destination) ||
    WHITESPACE_OR_CONTROL.test(destination)
  ) {
    return null;
  }
  return normalizeNavigationAllowlistTarget(destination, 'WEB_EXACT');
}
