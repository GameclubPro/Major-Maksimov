import { normalizeNavigationAllowlistTarget } from '@maxim/contracts/settings';

const MAX_WRAPPER_LENGTH = 2_048;
const WHITESPACE_OR_CONTROL = /[\s\p{Cc}\p{Cf}]/u;
const WRAPPER_ROUTE = /^https:\/\/([^/?#]+)(\/[^?#]+)(?=\?|$)/iu;
const YAHOO_ROUTE =
  /^\/_ylt=[\w.-]+;_ylu=[\w=-]+\/RV=2\/RE=\d+\/RO=\d+\/RU=([^/]+)\/RK=\d+\/RS=[\w.=-]+$/u;
const ABSOLUTE_WEB_AUTHORITY = /^https?:\/\/[^/?#@]+(?=[/?#]|$)/iu;

type SearchLinkFormat = {
  key: string;
  tracking: ReadonlySet<string>;
  emptyOnly?: ReadonlySet<string>;
  decode?: (value: string) => string | null;
  valid?: (query: URLSearchParams) => boolean;
};

const google: SearchLinkFormat = {
  key: 'url',
  tracking: new Set(['sa', 'source', 'rct', 'opi', 'ved', 'sqi', 'usg']),
  emptyOnly: new Set(['q']),
};
const duckDuckGo: SearchLinkFormat = {
  key: 'uddg',
  tracking: new Set(['rut']),
  valid: (query) => /^[a-f0-9]{64}$/u.test(query.get('rut') ?? ''),
};
const bing: SearchLinkFormat = {
  key: 'u',
  tracking: new Set(['p', 'ptn', 'ver', 'hsh', 'fclid', 'psq', 'ntb']),
  emptyOnly: new Set(['!']),
  decode: decodeBingDestination,
};

const searchLinkFormats = new Map<string, SearchLinkFormat>([
  ['www.google.com/url', google],
  ['duckduckgo.com/l/', duckDuckGo],
  ['r.duckduckgo.com/l/', duckDuckGo],
  ['www.bing.com/ck/a', bing],
]);

export function readSearchLinkDestination(value: string): string | null {
  if (value.length > MAX_WRAPPER_LENGTH || value.includes('#') || value.includes('\\')) {
    return null;
  }
  const route = WRAPPER_ROUTE.exec(value);
  if (!route) return null;
  const [, authority = '', path = ''] = route;
  const host = authority.toLowerCase();
  const format = searchLinkFormats.get(host + path);
  if ((!format && host !== 'r.search.yahoo.com') || WHITESPACE_OR_CONTROL.test(value)) return null;

  // FLAG: A destination is evidence only on a verified route with one supported value.
  const destination = format
    ? readQueryDestination(new URL(value).searchParams, format)
    : readYahooDestination(path, value);
  if (
    !destination ||
    !ABSOLUTE_WEB_AUTHORITY.test(destination) ||
    WHITESPACE_OR_CONTROL.test(destination)
  ) {
    return null;
  }
  return normalizeNavigationAllowlistTarget(destination, 'WEB_EXACT');
}

function readQueryDestination(query: URLSearchParams, format: SearchLinkFormat): string | null {
  if (format.valid && !format.valid(query)) return null;
  const seen = new Set<string>();
  let destination: string | null = null;
  for (const [name, parameter] of query) {
    if (seen.has(name)) return null;
    seen.add(name);
    if (name === format.key) {
      destination = format.decode ? format.decode(parameter) : parameter;
    } else if (!format.tracking.has(name) && !(format.emptyOnly?.has(name) && parameter === '')) {
      return null;
    }
  }
  return destination;
}

function readYahooDestination(path: string, value: string): string | null {
  if (value.includes('?')) return null;
  const encoded = YAHOO_ROUTE.exec(path)?.[1];
  if (!encoded) return null;
  try {
    return decodeURIComponent(encoded);
  } catch {
    return null;
  }
}

function decodeBingDestination(value: string): string | null {
  if (!/^a1[A-Za-z0-9_-]+$/u.test(value)) return null;
  const encoded = value.slice(2);
  const decoded = Buffer.from(encoded, 'base64url');
  if (decoded.toString('base64url') !== encoded) return null;
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(decoded);
  } catch {
    return null;
  }
}
