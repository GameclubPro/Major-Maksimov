import { normalizeMessageLimitsBlockedWordCandidate } from '@maxim/contracts/settings';
import { stripUrlsFromText } from '../common/url-text.util';
import { normalizeMixedWriting } from './rule-engine-normalization';

export type BlockedWordDetection = {
  blockedWord: string;
  matchKind: 'inflection' | 'pattern';
};

type ResolvedBlockedWord = {
  blockedWord: string;
  inflectionRoot: string | null;
  prefilterToken: string;
};

type ResolvedBlockedWordTrieNode = {
  children: Map<string, ResolvedBlockedWordTrieNode>;
  terminalTokens?: string[];
};

type ResolvedBlockedWordIndex = {
  identities: ReadonlySet<string>;
  maxPrefilterTokenLength: number;
  prefilterRoot: ResolvedBlockedWordTrieNode;
  words: readonly ResolvedBlockedWord[];
  wordsByInflectionRoot: ReadonlyMap<string, readonly ResolvedBlockedWord[]>;
  wordsByPrefilterToken: ReadonlyMap<string, readonly ResolvedBlockedWord[]>;
};

const BLOCKED_WORD_LIST_CACHE_MAX_ENTRIES = 512;
const BLOCKED_WORD_PATTERN_CACHE_MAX_ENTRIES = 4_096;
const BLOCKED_WORD_CYRILLIC_INFLECTION_SUFFIXES = [
  'иями',
  'ями',
  'ами',
  'иях',
  'ях',
  'ах',
  'ого',
  'ему',
  'ому',
  'ыми',
  'ими',
  'его',
  'ией',
  'ою',
  'ею',
  'ую',
  'юю',
  'ая',
  'яя',
  'ое',
  'ее',
  'ые',
  'ие',
  'ий',
  'ый',
  'ой',
  'ов',
  'ев',
  'ей',
  'ам',
  'ям',
  'ом',
  'ем',
  'ым',
  'им',
  'ию',
  'ью',
  'ия',
  'ья',
  'а',
  'я',
  'у',
  'ю',
  'ы',
  'и',
  'ь',
  'й',
] as const;
const BLOCKED_WORD_LATIN_INFLECTION_SUFFIXES = [
  'ings',
  'ing',
  'ies',
  'ied',
  'ed',
  'es',
  's',
] as const;
const BLOCKED_WORD_CYRILLIC_MIN_ROOT_LENGTH = 4;
const BLOCKED_WORD_LATIN_MIN_ROOT_LENGTH = 4;
const BLOCKED_WORD_ARTICLE_CODE_PATTERN =
  /(?<![\p{L}\p{N}])(?:[A-Z0-9]{2,}(?:[-_/][A-Z0-9]{2,})+|[A-Z]{2,}\d[A-Z0-9_-]*|[A-Z0-9_-]*\d[A-Z]{2,}[A-Z0-9_-]*)(?![\p{L}\p{N}])/giu;

export function normalizeLegacyStopWordIdentity(value: string): string | null {
  const candidate = normalizeMessageLimitsBlockedWordCandidate(value);
  return candidate ? normalizeMixedWriting(candidate) : null;
}

export class MessageLimitsBlockedWordDetector {
  private readonly blockedWordListCache = new Map<string, ResolvedBlockedWordIndex>();
  private readonly blockedWordPatternCache = new Map<string, RegExp>();

  detect(text: string, blockedWords: readonly string[]): BlockedWordDetection | null {
    return this.detectMatches(text, blockedWords, true)[0] ?? null;
  }

  detectAll(text: string, blockedWords: readonly string[]): BlockedWordDetection[] {
    return this.detectMatches(text, blockedWords, false);
  }

  private detectMatches(
    text: string,
    blockedWords: readonly string[],
    stopAfterFirst: boolean,
  ): BlockedWordDetection[] {
    if (!text || !Array.isArray(blockedWords) || blockedWords.length === 0) {
      return [];
    }

    const blockedWordIndex = this.resolveMessageLimitsBlockedWordList(blockedWords);
    if (blockedWordIndex.words.length === 0) {
      return [];
    }

    const normalizedText = this.normalizeMessageLimitsBlockedWordText(
      this.stripMessageLimitsBlockedWordIgnoredTokens(
        stripUrlsFromText(text),
        blockedWordIndex.identities,
      ),
    );
    if (!normalizedText) {
      return [];
    }

    const compactText = normalizedText.replace(/[^\p{L}\p{N}]+/gu, '');
    const normalizedTokens = normalizedText.match(/[a-zа-яё0-9]+/giu) ?? [];
    const matchedPrefilterTokens = this.findMessageLimitsBlockedWordPrefilterTokens(
      compactText,
      blockedWordIndex.prefilterRoot,
      blockedWordIndex.maxPrefilterTokenLength,
    );
    const tokenInflectionRoots =
      this.resolveMessageLimitsBlockedWordInflectionRoots(normalizedTokens);
    if (matchedPrefilterTokens.size === 0 && tokenInflectionRoots.size === 0) {
      return [];
    }

    const candidateFlagsByBlockedWord = new Map<
      string,
      {
        inflection: boolean;
        prefilter: boolean;
      }
    >();

    for (const inflectionRoot of tokenInflectionRoots) {
      const words = blockedWordIndex.wordsByInflectionRoot.get(inflectionRoot);
      if (!words) {
        continue;
      }

      for (const word of words) {
        const candidate = candidateFlagsByBlockedWord.get(word.blockedWord) ?? {
          inflection: false,
          prefilter: false,
        };
        candidate.inflection = true;
        candidateFlagsByBlockedWord.set(word.blockedWord, candidate);
      }
    }

    for (const prefilterToken of matchedPrefilterTokens) {
      const words = blockedWordIndex.wordsByPrefilterToken.get(prefilterToken);
      if (!words) {
        continue;
      }

      for (const word of words) {
        const candidate = candidateFlagsByBlockedWord.get(word.blockedWord) ?? {
          inflection: false,
          prefilter: false,
        };
        candidate.prefilter = true;
        candidateFlagsByBlockedWord.set(word.blockedWord, candidate);
      }
    }

    if (candidateFlagsByBlockedWord.size === 0) {
      return [];
    }

    const detections: BlockedWordDetection[] = [];
    for (const blockedWord of blockedWordIndex.words) {
      const candidate = candidateFlagsByBlockedWord.get(blockedWord.blockedWord);
      if (!candidate) {
        continue;
      }

      if (
        candidate.prefilter &&
        this.getMessageLimitsBlockedWordPattern(blockedWord.blockedWord).test(normalizedText)
      ) {
        detections.push({
          blockedWord: blockedWord.blockedWord,
          matchKind: 'pattern',
        });
        if (stopAfterFirst) {
          return detections;
        }
        continue;
      }

      if (candidate.inflection) {
        detections.push({
          blockedWord: blockedWord.blockedWord,
          matchKind: 'inflection',
        });
        if (stopAfterFirst) {
          return detections;
        }
      }
    }

    return detections;
  }

  private normalizeMessageLimitsBlockedWordText(value: string): string {
    if (!value) {
      return '';
    }

    let normalized = normalizeMixedWriting(value.toLowerCase()).replace(/ё/g, 'е');
    normalized = normalized.replace(/([a-zа-я0-9])\1{2,}/giu, '$1$1');
    return normalized;
  }

  private resolveMessageLimitsBlockedWordList(
    blockedWords: readonly string[],
  ): ResolvedBlockedWordIndex {
    const cacheKey = this.buildBlockedWordListCacheKey(blockedWords);
    const cached = this.blockedWordListCache.get(cacheKey);
    if (cached) {
      return cached;
    }

    const words = [
      ...new Set(
        blockedWords
          .map((item) => this.normalizeMessageLimitsBlockedWordToken(item))
          .filter((item): item is string => Boolean(item)),
      ),
    ].map((blockedWord) => {
      const inflectionRoot = this.resolveMessageLimitsBlockedWordInflectionRoot(blockedWord);
      return {
        blockedWord,
        inflectionRoot,
        prefilterToken: inflectionRoot ?? blockedWord,
      };
    });
    const prefilterRoot: ResolvedBlockedWordTrieNode = {
      children: new Map(),
    };
    const wordsByInflectionRoot = new Map<string, ResolvedBlockedWord[]>();
    const wordsByPrefilterToken = new Map<string, ResolvedBlockedWord[]>();
    let maxPrefilterTokenLength = 0;

    for (const word of words) {
      if (word.inflectionRoot) {
        const existingByRoot = wordsByInflectionRoot.get(word.inflectionRoot) ?? [];
        existingByRoot.push(word);
        wordsByInflectionRoot.set(word.inflectionRoot, existingByRoot);
      }

      const existingByPrefilterToken = wordsByPrefilterToken.get(word.prefilterToken) ?? [];
      existingByPrefilterToken.push(word);
      wordsByPrefilterToken.set(word.prefilterToken, existingByPrefilterToken);
      maxPrefilterTokenLength = Math.max(maxPrefilterTokenLength, word.prefilterToken.length);
      this.insertMessageLimitsBlockedWordPrefilterToken(prefilterRoot, word.prefilterToken);
    }

    const resolved = {
      identities: new Set(words.map((word) => word.blockedWord)),
      maxPrefilterTokenLength,
      prefilterRoot,
      words,
      wordsByInflectionRoot,
      wordsByPrefilterToken,
    };

    this.blockedWordListCache.set(cacheKey, resolved);
    if (this.blockedWordListCache.size > BLOCKED_WORD_LIST_CACHE_MAX_ENTRIES) {
      const oldestKey = this.blockedWordListCache.keys().next().value;
      if (typeof oldestKey === 'string') {
        this.blockedWordListCache.delete(oldestKey);
      }
    }
    return resolved;
  }

  private buildBlockedWordListCacheKey(blockedWords: readonly string[]): string {
    return blockedWords.join('\u001f');
  }

  private getMessageLimitsBlockedWordPattern(value: string): RegExp {
    const cached = this.blockedWordPatternCache.get(value);
    if (cached) {
      return cached;
    }

    const pattern = this.buildMessageLimitsBlockedWordPattern(value);
    this.blockedWordPatternCache.set(value, pattern);
    if (this.blockedWordPatternCache.size > BLOCKED_WORD_PATTERN_CACHE_MAX_ENTRIES) {
      const oldestKey = this.blockedWordPatternCache.keys().next().value;
      if (typeof oldestKey === 'string') {
        this.blockedWordPatternCache.delete(oldestKey);
      }
    }
    return pattern;
  }

  private buildMessageLimitsBlockedWordPattern(value: string): RegExp {
    const joinerPattern = String.raw`[^\p{L}\p{N}]*`;
    const tokenPattern = [...value].map((char) => escapeRegExp(char)).join(joinerPattern);
    return new RegExp(String.raw`(?<![\p{L}\p{N}])${tokenPattern}(?![\p{L}\p{N}])`, 'iu');
  }

  private insertMessageLimitsBlockedWordPrefilterToken(
    root: ResolvedBlockedWordTrieNode,
    token: string,
  ): void {
    let node = root;
    for (const char of token) {
      let nextNode = node.children.get(char);
      if (!nextNode) {
        nextNode = {
          children: new Map(),
        };
        node.children.set(char, nextNode);
      }

      node = nextNode;
    }

    if (!node.terminalTokens) {
      node.terminalTokens = [token];
      return;
    }

    if (!node.terminalTokens.includes(token)) {
      node.terminalTokens.push(token);
    }
  }

  private findMessageLimitsBlockedWordPrefilterTokens(
    compactText: string,
    root: ResolvedBlockedWordTrieNode,
    maxPrefilterTokenLength: number,
  ): Set<string> {
    const matches = new Set<string>();
    if (!compactText || maxPrefilterTokenLength <= 0) {
      return matches;
    }

    for (let start = 0; start < compactText.length; start += 1) {
      let node = root;
      const endLimit = Math.min(compactText.length, start + maxPrefilterTokenLength);
      for (let end = start; end < endLimit; end += 1) {
        const nextNode = node.children.get(compactText[end]);
        if (!nextNode) {
          break;
        }

        node = nextNode;
        for (const token of node.terminalTokens ?? []) {
          matches.add(token);
        }
      }
    }

    return matches;
  }

  private resolveMessageLimitsBlockedWordInflectionRoots(values: readonly string[]): Set<string> {
    const roots = new Set<string>();
    for (const value of values) {
      const root = this.resolveMessageLimitsBlockedWordInflectionRoot(value);
      if (root) {
        roots.add(root);
      }
    }

    return roots;
  }

  private resolveMessageLimitsBlockedWordInflectionRoot(value: string): string | null {
    if (!value) {
      return null;
    }

    if (/^[а-яё]+$/iu.test(value)) {
      return this.resolveCyrillicMessageLimitsBlockedWordInflectionRoot(value);
    }

    if (/^[a-z]+$/iu.test(value)) {
      return this.resolveLatinMessageLimitsBlockedWordInflectionRoot(value);
    }

    return null;
  }

  private resolveCyrillicMessageLimitsBlockedWordInflectionRoot(value: string): string | null {
    for (const suffix of BLOCKED_WORD_CYRILLIC_INFLECTION_SUFFIXES) {
      if (!value.endsWith(suffix)) {
        continue;
      }

      const root = value.slice(0, -suffix.length);
      if (root.length >= BLOCKED_WORD_CYRILLIC_MIN_ROOT_LENGTH) {
        return root;
      }
    }

    if (/[аеёиоуыэюя]$/iu.test(value)) {
      return null;
    }

    return value.length >= BLOCKED_WORD_CYRILLIC_MIN_ROOT_LENGTH ? value : null;
  }

  private resolveLatinMessageLimitsBlockedWordInflectionRoot(value: string): string | null {
    for (const suffix of BLOCKED_WORD_LATIN_INFLECTION_SUFFIXES) {
      if (!value.endsWith(suffix)) {
        continue;
      }

      const root = value.slice(0, -suffix.length);
      if (root.length >= BLOCKED_WORD_LATIN_MIN_ROOT_LENGTH) {
        return root;
      }
    }

    if (/[aeiouy]$/iu.test(value)) {
      return null;
    }

    return value.length >= BLOCKED_WORD_LATIN_MIN_ROOT_LENGTH ? value : null;
  }

  private normalizeMessageLimitsBlockedWordToken(value: string): string | null {
    return normalizeLegacyStopWordIdentity(value);
  }

  private stripMessageLimitsBlockedWordIgnoredTokens(
    value: string,
    identities: ReadonlySet<string>,
  ): string {
    return value.replace(BLOCKED_WORD_ARTICLE_CODE_PATTERN, (token) => {
      // FLAG: Product codes suppress partial hits, but an explicitly configured whole word wins in every case.
      const identity = normalizeLegacyStopWordIdentity(token);
      return identity && identities.has(identity) ? token : ' ';
    });
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
