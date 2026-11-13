import type { ReactNode } from 'react';
import { cn } from '../lib/cn';
import {
  renderSupportedMarkdownAsHtml,
  stripSupportedMarkdownToPlainText,
} from '../lib/max-markdown';
import { useNormalizedMarkdownSource } from '../lib/use-normalized-markdown-source';
import './max-markdown-preview.css';

export function MaxMarkdownPreview({
  value,
  sourceFormat = 'markdown',
  className,
  normalizeWhitespace = false,
  preserveLinks = false,
  preserveWhitespace = false,
  fallback = null,
}: {
  value: string;
  sourceFormat?: 'plain' | 'markdown';
  className?: string;
  normalizeWhitespace?: boolean;
  preserveLinks?: boolean;
  preserveWhitespace?: boolean;
  fallback?: ReactNode;
}) {
  const source = normalizeWhitespace
    ? value.replace(/\r/g, '').replace(/\s+/gu, ' ').trim()
    : value;
  const normalizedSource = useNormalizedMarkdownSource(source, sourceFormat === 'markdown');
  if (sourceFormat === 'plain') {
    const plainText = preserveWhitespace ? source : source.trim();
    if (!plainText) {
      return fallback ? <>{fallback}</> : null;
    }

    return <span className={cn('max-markdown-preview', className)}>{plainText}</span>;
  }

  if (normalizedSource.status === 'loading') {
    return <span className={cn('max-markdown-preview', className)} aria-busy="true" />;
  }

  if (normalizedSource.status === 'error') {
    return (
      <span
        className={cn('max-markdown-preview', 'is-normalization-error', className)}
        role="alert"
      >
        <span>Не удалось отобразить форматированный текст.</span>
        <button type="button" onClick={normalizedSource.retry}>
          Повторить
        </button>
      </span>
    );
  }

  const plainText = stripSupportedMarkdownToPlainText(normalizedSource.value).trim();

  if (!plainText) {
    return fallback ? <>{fallback}</> : null;
  }

  const html = renderSupportedMarkdownAsHtml(normalizedSource.value, {
    blockMode: preserveWhitespace ? 'editor' : 'inline',
    preserveWhitespace,
    linkMode: preserveLinks ? 'anchor' : 'underline',
  });

  const Container = preserveWhitespace ? 'div' : 'span';
  return (
    <Container
      className={cn('max-markdown-preview', className)}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
