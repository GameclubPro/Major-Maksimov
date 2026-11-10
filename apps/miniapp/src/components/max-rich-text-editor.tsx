import { AppIcon as IconoirSprite } from './ui/app-icon';

import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from 'react';
import { MAX_MARKDOWN_TOOL_DEFINITIONS, type MaxMarkdownTool } from '../lib/max-markdown-tools';
import { cn } from '../lib/cn';
import { renderPlainTextAsEditorHtml, renderSupportedMarkdownAsHtml } from '../lib/max-markdown';
import { clipboardHtmlToSupportedMarkdown } from '../lib/max-rich-text-clipboard';
import { parseEditorLinkHref, serializeEditorLinkMarkdown } from '../lib/max-rich-text-link';
import { serializeEditorInlineMarkdown } from '../lib/max-rich-text-serialization';
import { useVisibleEditorCaret } from '../lib/use-visible-editor-caret';
import { useNormalizedMarkdownSource } from '../lib/use-normalized-markdown-source';
import {
  isElementInTopmostNativeBackModal,
  NATIVE_BACK_RICH_TEXT_LINK_PRIORITY,
  useNativeBackHandler,
} from '../lib/native-back';
import './max-rich-text-editor.css';
import './max-rich-text-editor-content.css';

export type MaxRichTextEditorHandle = {
  focus: () => void;
  applyTool: (tool: MaxMarkdownTool) => void;
};

export type MaxRichTextEditorProps = {
  value: string;
  sourceFormat?: 'plain' | 'markdown';
  onChange: (value: string) => void;
  maxLength: number;
  placeholder: string;
  disabled?: boolean;
  preserveCurlyBracePlaceholders?: boolean;
  curlyBracePlaceholderLabels?: Readonly<Record<string, string>>;
  ariaLabel: string;
  ariaInvalid?: boolean;
  ariaDescribedBy?: string;
  className?: string;
  onPasteFiles?: (files: File[]) => void;
  onNormalizationReadyChange?: (ready: boolean) => void;
  onActiveToolsChange?: (tools: ReadonlySet<MaxMarkdownTool>) => void;
};

const LINK_PLACEHOLDER_URL = 'https://max.ru/';
const NATIVE_INLINE_COMMANDS = {
  bold: 'bold',
  italic: 'italic',
  underline: 'underline',
  strike: 'strikeThrough',
} as const;
const BLOCK_TAGS = new Set([
  'address',
  'article',
  'blockquote',
  'div',
  'footer',
  'header',
  'li',
  'p',
]);

export const MaxRichTextEditor = forwardRef<MaxRichTextEditorHandle, MaxRichTextEditorProps>(
  function MaxRichTextEditor(
    {
      value,
      sourceFormat = 'markdown',
      onChange,
      maxLength,
      placeholder,
      disabled = false,
      preserveCurlyBracePlaceholders = false,
      curlyBracePlaceholderLabels,
      ariaLabel,
      ariaInvalid = false,
      ariaDescribedBy,
      className,
      onPasteFiles,
      onNormalizationReadyChange,
      onActiveToolsChange,
    },
    ref,
  ) {
    const editorRef = useRef<HTMLDivElement | null>(null);
    useVisibleEditorCaret(editorRef);
    const savedRangeRef = useRef<Range | null>(null);
    const editingLinkRef = useRef<HTMLAnchorElement | null>(null);
    const lastEmittedMarkdownRef = useRef(value);
    const lastRenderedSourceFormatRef = useRef(sourceFormat);
    const lastRenderedNormalizationStatusRef = useRef<'ready' | 'loading' | 'error'>('ready');
    const [linkEditorOpen, setLinkEditorOpen] = useState(false);
    const [linkDraft, setLinkDraft] = useState(LINK_PLACEHOLDER_URL);
    const [linkError, setLinkError] = useState('');
    const [activeTools, setActiveTools] = useState<ReadonlySet<MaxMarkdownTool>>(() => new Set());
    useEffect(() => {
      onActiveToolsChange?.(activeTools);
    }, [activeTools, onActiveToolsChange]);
    const normalizedValue = useNormalizedMarkdownSource(value, sourceFormat === 'markdown', true);
    const normalizationReady = normalizedValue.status === 'ready';
    const interactive = !disabled && normalizationReady;
    const interactiveRef = useRef(interactive);
    interactiveRef.current = interactive;

    const remainingLength = maxLength - value.length;
    const isOverLimit = remainingLength < 0;
    const editorHtml = useMemo(
      () =>
        sourceFormat === 'plain' || !normalizationReady
          ? renderPlainTextAsEditorHtml(value)
          : renderSupportedMarkdownAsHtml(normalizedValue.value, {
              // FLAG: Imported sources use the same link boundary as typing and paste.
              resolveLinkHref: parseEditorLinkHref,
              blockMode: 'editor',
              linkMode: 'anchor',
              preserveCurlyBracePlaceholders,
              curlyBracePlaceholderLabels,
            }),
      [
        curlyBracePlaceholderLabels,
        normalizationReady,
        normalizedValue.value,
        preserveCurlyBracePlaceholders,
        sourceFormat,
        value,
      ],
    );

    const emitCurrentMarkdown = useCallback(() => {
      const editor = editorRef.current;
      if (!editor || !interactiveRef.current) {
        return;
      }

      const nextMarkdown = serializeEditorMarkdown(editor, {
        preserveCurlyBracePlaceholders,
      });
      if (nextMarkdown === lastEmittedMarkdownRef.current) return;
      lastEmittedMarkdownRef.current = nextMarkdown;
      lastRenderedSourceFormatRef.current = 'markdown';
      onChange(nextMarkdown);
    }, [onChange, preserveCurlyBracePlaceholders]);

    const syncActiveTools = useCallback(() => {
      const editor = editorRef.current;
      const range =
        editor && interactiveRef.current && typeof document !== 'undefined'
          ? readCurrentEditorRange(editor)
          : null;
      if (range) savedRangeRef.current = range.cloneRange();
      const next = editor && range ? resolveActiveTools(editor, range) : new Set<MaxMarkdownTool>();
      setActiveTools((current) =>
        current.size === next.size && [...next].every((tool) => current.has(tool)) ? current : next,
      );
    }, []);

    useEffect(() => {
      const editor = editorRef.current;
      if (!editor) {
        return;
      }

      if (
        lastEmittedMarkdownRef.current === value &&
        lastRenderedSourceFormatRef.current === sourceFormat &&
        lastRenderedNormalizationStatusRef.current === normalizedValue.status &&
        editor.innerHTML
      ) {
        return;
      }

      editor.innerHTML = editorHtml;
      lastEmittedMarkdownRef.current = value;
      lastRenderedSourceFormatRef.current = sourceFormat;
      lastRenderedNormalizationStatusRef.current = normalizedValue.status;
      syncActiveTools();
    }, [editorHtml, normalizedValue.status, sourceFormat, syncActiveTools, value]);

    useEffect(() => {
      onNormalizationReadyChange?.(normalizationReady);
    }, [normalizationReady, onNormalizationReadyChange]);

    useEffect(() => {
      if (!interactive) {
        editingLinkRef.current = null;
        setLinkEditorOpen(false);
        setActiveTools(new Set());
      }
    }, [interactive]);

    useEffect(() => {
      if (typeof document === 'undefined') {
        return undefined;
      }

      document.addEventListener('selectionchange', syncActiveTools);
      return () => {
        document.removeEventListener('selectionchange', syncActiveTools);
      };
    }, [syncActiveTools]);

    useEffect(() => {
      const editor = editorRef.current;
      if (!editor) return;

      const preserveLinkOnReplacement = (event: InputEvent) => {
        if (
          !interactiveRef.current ||
          !['insertText', 'insertCompositionText', 'insertReplacementText'].includes(
            event.inputType,
          )
        ) {
          return;
        }
        let range = readCurrentEditorRange(editor);
        if (event.inputType === 'insertReplacementText') {
          const target = event.getTargetRanges()[0];
          if (target) {
            const replacementRange = document.createRange();
            replacementRange.setStart(target.startContainer, target.startOffset);
            replacementRange.setEnd(target.endContainer, target.endOffset);
            if (editorContainsRange(editor, replacementRange)) range = replacementRange;
          }
        }
        if (range) preserveSelectedLink(editor, range, event);
      };
      editor.addEventListener('beforeinput', preserveLinkOnReplacement);
      return () => editor.removeEventListener('beforeinput', preserveLinkOnReplacement);
    }, []);

    const focusEditor = useCallback(() => {
      if (interactiveRef.current) editorRef.current?.focus();
    }, []);

    useNativeBackHandler(
      () => {
        const root = editorRef.current?.parentElement;
        if (!root || !isElementInTopmostNativeBackModal(root)) {
          return false;
        }

        editingLinkRef.current = null;
        setLinkEditorOpen(false);
        setLinkError('');
        focusEditor();
        return true;
      },
      { enabled: linkEditorOpen, priority: NATIVE_BACK_RICH_TEXT_LINK_PRIORITY },
    );

    const restoreOrCreateEditorRange = useCallback(() => {
      const editor = editorRef.current;
      if (!editor || !interactiveRef.current || typeof document === 'undefined') {
        return null;
      }

      const liveRange = readCurrentEditorRange(editor);
      if (liveRange) {
        savedRangeRef.current = liveRange.cloneRange();
        return liveRange;
      }

      const savedRange = savedRangeRef.current;
      if (savedRange && editorContainsRange(editor, savedRange)) {
        applyDocumentRange(savedRange);
        return savedRange.cloneRange();
      }

      const range = document.createRange();
      range.selectNodeContents(editor);
      range.collapse(false);
      applyDocumentRange(range);
      savedRangeRef.current = range.cloneRange();
      return range;
    }, []);

    const applyInlineTool = useCallback(
      (tool: MaxMarkdownTool) => {
        if (!interactiveRef.current) {
          return;
        }

        if (tool === 'heading') {
          const range = restoreOrCreateEditorRange();
          if (!range) {
            return;
          }

          wrapRangeWithHeading(range);
          emitCurrentMarkdown();
          syncActiveTools();
          return;
        }

        if (tool === 'link') {
          const range = restoreOrCreateEditorRange();
          const editor = editorRef.current;
          if (!range || !editor) {
            return;
          }

          savedRangeRef.current = range.cloneRange();
          const existingLink = findClosestElement(range.commonAncestorContainer, editor, 'a');
          editingLinkRef.current = existingLink instanceof HTMLAnchorElement ? existingLink : null;
          setLinkDraft(existingLink?.getAttribute('href') || LINK_PLACEHOLDER_URL);
          setLinkError('');
          setLinkEditorOpen(true);
          return;
        }

        const range = restoreOrCreateEditorRange();
        if (!range) {
          return;
        }

        if (tool in NATIVE_INLINE_COMMANDS) {
          // FLAG: Native editing preserves selection, pending typing marks and undo history.
          // Wrapping a Range cannot toggle an inherited mark off or format future typing.
          editorRef.current?.focus();
          document.execCommand('styleWithCSS', false, 'false');
          document.execCommand(NATIVE_INLINE_COMMANDS[tool as keyof typeof NATIVE_INLINE_COMMANDS]);
          emitCurrentMarkdown();
          syncActiveTools();
          return;
        }

        wrapRangeWithElement(range, resolveToolTagName(tool), resolveToolPlaceholder(tool));
        emitCurrentMarkdown();
        syncActiveTools();
      },
      [emitCurrentMarkdown, restoreOrCreateEditorRange, syncActiveTools],
    );

    const confirmLink = useCallback(() => {
      if (!interactiveRef.current) {
        return;
      }

      if (!linkDraft.trim()) {
        setLinkError('Укажите ссылку.');
        return;
      }

      const canonicalHref = parseEditorLinkHref(linkDraft);
      if (!canonicalHref) {
        setLinkError('Поддерживаются https:// и max://.');
        return;
      }

      const editor = editorRef.current;
      const savedRange = savedRangeRef.current;
      const editingLink = editingLinkRef.current;
      if (editor && editingLink && editor.contains(editingLink)) {
        editingLink.setAttribute('href', canonicalHref);
        editingLinkRef.current = null;
        setLinkEditorOpen(false);
        setLinkError('');
        emitCurrentMarkdown();
        syncActiveTools();
        return;
      }

      if (!editor || !savedRange || !editorContainsRange(editor, savedRange)) {
        editingLinkRef.current = null;
        setLinkEditorOpen(false);
        return;
      }

      applyDocumentRange(savedRange);
      wrapRangeWithLink(savedRange, canonicalHref);
      editingLinkRef.current = null;
      setLinkEditorOpen(false);
      setLinkError('');
      emitCurrentMarkdown();
      syncActiveTools();
    }, [emitCurrentMarkdown, linkDraft, syncActiveTools]);

    const closeLinkEditor = useCallback(() => {
      editingLinkRef.current = null;
      setLinkEditorOpen(false);
      setLinkError('');
      focusEditor();
    }, [focusEditor]);

    useImperativeHandle(
      ref,
      () => ({
        focus: focusEditor,
        applyTool: applyInlineTool,
      }),
      [applyInlineTool, focusEditor],
    );

    return (
      <div className={cn('max-rich-text-editor', className)}>
        <div
          ref={editorRef}
          className={cn(
            'max-rich-text-editor__surface',
            isOverLimit && 'is-limit',
            normalizedValue.status === 'loading' && 'is-loading',
            normalizedValue.status === 'error' && 'is-normalization-error',
          )}
          contentEditable={interactive}
          data-placeholder={placeholder}
          role="textbox"
          aria-label={ariaLabel}
          aria-invalid={ariaInvalid}
          aria-describedby={ariaDescribedBy}
          aria-multiline="true"
          aria-disabled={!interactive || undefined}
          aria-busy={normalizedValue.status === 'loading' || undefined}
          spellCheck
          suppressContentEditableWarning
          onPointerDownCapture={(event) => {
            const editor = editorRef.current;
            if (!editor || !moveCaretAfterPlaceholderToken(editor, event.target)) {
              return;
            }

            event.preventDefault();
            savedRangeRef.current = readCurrentEditorRange(editor);
          }}
          onBeforeInput={() => {
            savedRangeRef.current = restoreOrCreateEditorRange();
          }}
          onInput={() => {
            emitCurrentMarkdown();
            syncActiveTools();
          }}
          onKeyUp={syncActiveTools}
          onMouseUp={syncActiveTools}
          onPointerUp={syncActiveTools}
          onFocus={syncActiveTools}
          onBlur={() => {
            editorRef.current
              ?.querySelectorAll('[data-max-link-boundary]')
              .forEach((boundary) => boundary.remove());
          }}
          onPaste={(event) => {
            if (!interactiveRef.current) {
              return;
            }

            event.preventDefault();
            const pastedFiles = Array.from(event.clipboardData.files).filter((file) =>
              file.type.toLowerCase().startsWith('image/'),
            );
            const pastedHtml = event.clipboardData.getData('text/html');
            const pastedText = event.clipboardData.getData('text/plain');
            const handlingImageFiles = pastedFiles.length > 0 && onPasteFiles !== undefined;
            if (handlingImageFiles) onPasteFiles?.(pastedFiles);

            if (!pastedHtml) {
              if (handlingImageFiles && !pastedText) return;
              insertPlainTextAtCurrentRange(pastedText);
              emitCurrentMarkdown();
              syncActiveTools();
              return;
            }

            // FLAG: Finish rich paste in this event so review/save cannot observe the old text.
            restoreOrCreateEditorRange();
            try {
              const pastedMarkdown = clipboardHtmlToSupportedMarkdown(pastedHtml);
              if (
                pastedMarkdown &&
                insertSupportedMarkdownAtCurrentRange(pastedMarkdown, {
                  preserveCurlyBracePlaceholders,
                  curlyBracePlaceholderLabels,
                })
              ) {
                emitCurrentMarkdown();
                syncActiveTools();
                return;
              }
            } catch {
              // FLAG: Unsupported clipboard markup retains the supplied plain-text fallback.
            }

            // FLAG: An image without a text caption must leave the current text selection intact.
            if (handlingImageFiles && !pastedText) return;
            insertPlainTextAtCurrentRange(pastedText);
            emitCurrentMarkdown();
            syncActiveTools();
          }}
        />

        {normalizedValue.status === 'error' ? (
          <div className="max-rich-text-editor__normalization-error" role="alert">
            <span>Форматирование не загрузилось. Исходный текст сохранен.</span>
            <button type="button" onClick={normalizedValue.retry} disabled={disabled}>
              Повторить
            </button>
          </div>
        ) : null}

        {linkEditorOpen ? (
          <div className="max-rich-text-editor__link-panel">
            <IconoirSprite variant="iconoir" icon="Link" aria-hidden focusable="false" />
            <input
              value={linkDraft}
              onChange={(event) => {
                setLinkDraft(event.target.value);
                if (linkError) {
                  setLinkError('');
                }
              }}
              inputMode="url"
              autoCapitalize="none"
              autoCorrect="off"
              placeholder="https://"
              aria-label="Адрес ссылки"
              disabled={!interactive}
            />
            <button
              type="button"
              onClick={confirmLink}
              disabled={!interactive}
              aria-label="Применить"
            >
              OK
            </button>
            <button
              type="button"
              onClick={closeLinkEditor}
              disabled={!interactive}
              aria-label="Закрыть"
            >
              <IconoirSprite variant="iconoir" icon="Xmark" aria-hidden focusable="false" />
            </button>
            {linkError ? <small>{linkError}</small> : null}
          </div>
        ) : null}

        <span className={cn('max-rich-text-editor__counter', isOverLimit && 'is-limit')}>
          {value.length}/{maxLength}
        </span>

        <span className="max-rich-text-editor__active-tools" aria-hidden>
          {MAX_MARKDOWN_TOOL_DEFINITIONS.map((tool) => (
            <span
              key={tool.id}
              className={cn(activeTools.has(tool.id) && 'is-active')}
              data-tool={tool.id}
            />
          ))}
        </span>
      </div>
    );
  },
);

MaxRichTextEditor.displayName = 'MaxRichTextEditor';

function resolveToolTagName(
  tool: Exclude<MaxMarkdownTool, 'heading' | 'link'>,
): keyof HTMLElementTagNameMap {
  switch (tool) {
    case 'bold':
      return 'strong';
    case 'italic':
      return 'em';
    case 'underline':
      return 'u';
    case 'strike':
      return 's';
    case 'code':
      return 'code';
  }
}

function resolveToolPlaceholder(tool: Exclude<MaxMarkdownTool, 'heading' | 'link'>): string {
  switch (tool) {
    case 'bold':
      return 'жирный';
    case 'italic':
      return 'курсив';
    case 'underline':
      return 'подчеркнутый';
    case 'strike':
      return 'зачеркнутый';
    case 'code':
      return 'код';
  }
}

function readCurrentEditorRange(editor: HTMLElement): Range | null {
  const selection = document.getSelection();
  if (!selection || selection.rangeCount === 0) {
    return null;
  }

  const range = selection.getRangeAt(0);
  if (!editorContainsRange(editor, range)) {
    return null;
  }

  return range.cloneRange();
}

function editorContainsRange(editor: HTMLElement, range: Range): boolean {
  return (
    editor.contains(resolveRangeNode(range.startContainer)) &&
    editor.contains(resolveRangeNode(range.endContainer))
  );
}

function resolveRangeNode(node: Node): Node {
  return node.nodeType === Node.ELEMENT_NODE ? node : (node.parentNode ?? node);
}

function applyDocumentRange(range: Range): void {
  const selection = document.getSelection();
  if (!selection) {
    return;
  }

  selection.removeAllRanges();
  selection.addRange(range);
}

function moveCaretAfterPlaceholderToken(editor: HTMLElement, target: EventTarget | null): boolean {
  if (!(target instanceof Element)) {
    return false;
  }

  const token = target.closest<HTMLElement>('[data-max-placeholder]');
  if (!token || !editor.contains(token)) {
    return false;
  }

  const range = document.createRange();
  range.setStartAfter(token);
  range.collapse(true);
  editor.focus();
  applyDocumentRange(range);
  return true;
}

function wrapRangeWithElement(
  range: Range,
  tagName: keyof HTMLElementTagNameMap,
  placeholder: string,
): void {
  const element = document.createElement(tagName);

  if (range.collapsed) {
    element.textContent = placeholder;
    range.insertNode(element);
    selectElementContents(element);
    return;
  }

  const fragment = range.extractContents();
  element.appendChild(fragment);
  range.insertNode(element);
  selectElementContents(element);
}

function wrapRangeWithLink(range: Range, href: string): void {
  const link = document.createElement('a');
  link.setAttribute('href', href);

  if (range.collapsed) {
    link.textContent = 'текст ссылки';
    range.insertNode(link);
    selectElementContents(link);
    return;
  }

  const fragment = range.extractContents();
  // FLAG: A new destination replaces links inside the selection; nested anchors corrupt Markdown.
  for (const existingLink of fragment.querySelectorAll('a')) {
    existingLink.replaceWith(...existingLink.childNodes);
  }
  link.appendChild(fragment);
  range.insertNode(link);
  selectElementContents(link);
}

function preserveSelectedLink(editor: HTMLElement, range: Range, event: InputEvent): void {
  if (range.collapsed) return;
  const selectedText = range.toString();
  const link =
    findClosestElement(range.commonAncestorContainer, editor, 'a') ??
    Array.from(editor.querySelectorAll('a')).find(
      (candidate) =>
        candidate.textContent === selectedText && rangeContainsLinkLabel(range, candidate),
    );
  if (!link || selectedText !== link.textContent) {
    return;
  }

  // FLAG: Native full-label replacement drops the anchor unless an unselected content boundary
  // remains. This empty atomic span preserves native typing/undo without adding hidden text.
  if (
    event.inputType !== 'insertCompositionText' &&
    event.data &&
    (event.data.length > 1 || event.inputType === 'insertReplacementText') &&
    event.cancelable
  ) {
    let replacementRoot = link;
    while (
      replacementRoot.parentElement &&
      /^(STRONG|B|EM|I|U|S|STRIKE|DEL|MARK|CODE)$/u.test(replacementRoot.parentElement.tagName) &&
      replacementRoot.parentElement.textContent === link.textContent
    ) {
      replacementRoot = replacementRoot.parentElement;
    }
    let replacement = replacementRoot.cloneNode(true) as HTMLElement;
    const replacementLink =
      replacement.tagName === 'A' ? replacement : replacement.querySelector('a')!;
    replacement
      .querySelectorAll('[data-max-link-boundary]')
      .forEach((boundary) => boundary.remove());
    const walker = document.createTreeWalker(replacementLink, NodeFilter.SHOW_TEXT);
    let textNode = walker.nextNode();
    if (textNode) {
      textNode.textContent = event.data;
      while ((textNode = walker.nextNode())) textNode.textContent = '';
    } else {
      replacementLink.textContent = event.data;
    }
    replacementLink.setAttribute('data-max-link-replacement', '');
    replacementLink.appendChild(createLinkTypingBoundary());
    for (
      let ancestor = replacementRoot.parentElement;
      ancestor && /^(STRONG|B|EM|I|U|S|STRIKE|DEL|MARK|CODE)$/u.test(ancestor.tagName);
      ancestor = ancestor.parentElement
    ) {
      const wrapper = ancestor.cloneNode(false) as HTMLElement;
      wrapper.appendChild(replacement);
      replacement = wrapper;
    }
    const replacementRange = document.createRange();
    replacementRange.selectNode(replacementRoot);
    applyDocumentRange(replacementRange);
    // FLAG: insertHTML keeps the replacement in native undo history. DOM textContent escapes data.
    let replaced = false;
    try {
      replaced = document.execCommand('insertHTML', false, replacement.outerHTML);
    } catch {
      // FLAG: An unavailable native command must leave the original text input enabled.
    }
    const inserted = editor.querySelector('a[data-max-link-replacement]');
    if (replaced || inserted) {
      event.preventDefault();
      inserted?.removeAttribute('data-max-link-replacement');
      const insertedText = inserted
        ? document.createTreeWalker(inserted, NodeFilter.SHOW_TEXT).nextNode()
        : null;
      if (insertedText) {
        const caret = document.createRange();
        caret.setStart(insertedText, insertedText.textContent?.length ?? 0);
        caret.collapse(true);
        applyDocumentRange(caret);
      }
      return;
    }
    applyDocumentRange(range);
  }

  if (link.querySelector('[data-max-link-boundary]')) return;
  const selection = range.cloneRange();
  link.appendChild(createLinkTypingBoundary());
  applyDocumentRange(selection);
}

function rangeContainsLinkLabel(range: Range, link: HTMLElement): boolean {
  const walker = document.createTreeWalker(link, NodeFilter.SHOW_TEXT);
  let first: Node | null = null;
  let last: Node | null = null;
  let node;
  while ((node = walker.nextNode())) {
    if (!node.textContent) continue;
    first ??= node;
    last = node;
  }
  return Boolean(
    first &&
    last &&
    range.comparePoint(first, 0) === 0 &&
    range.comparePoint(last, last.textContent?.length ?? 0) === 0,
  );
}

function createLinkTypingBoundary(): HTMLSpanElement {
  const boundary = document.createElement('span');
  boundary.dataset.maxLinkBoundary = '';
  boundary.contentEditable = 'false';
  boundary.setAttribute('aria-hidden', 'true');
  boundary.style.cssText = 'display:inline-block;width:0;height:0;overflow:hidden';
  return boundary;
}

function wrapRangeWithHeading(range: Range): void {
  const heading = document.createElement('h3');

  if (range.collapsed) {
    heading.textContent = 'Заголовок';
    range.insertNode(heading);
    selectElementContents(heading);
    return;
  }

  const fragment = range.extractContents();
  heading.appendChild(fragment);
  range.insertNode(heading);
  selectElementContents(heading);
}

function selectElementContents(element: HTMLElement): void {
  const range = document.createRange();
  range.selectNodeContents(element);
  applyDocumentRange(range);
}

function insertPlainTextAtCurrentRange(text: string): void {
  const selection = document.getSelection();
  if (!selection || selection.rangeCount === 0) {
    return;
  }

  const range = selection.getRangeAt(0);
  range.deleteContents();
  const node = document.createTextNode(text);
  range.insertNode(node);
  range.setStartAfter(node);
  range.collapse(true);
  applyDocumentRange(range);
}

type RichTextSerializationOptions = {
  preserveCurlyBracePlaceholders?: boolean;
  curlyBracePlaceholderLabels?: Readonly<Record<string, string>>;
};

function insertSupportedMarkdownAtCurrentRange(
  markdown: string,
  options: RichTextSerializationOptions = {},
): boolean {
  if (typeof document === 'undefined') {
    return false;
  }

  const selection = document.getSelection();
  if (!selection || selection.rangeCount === 0) {
    return false;
  }

  const html = renderSupportedMarkdownAsHtml(markdown, {
    resolveLinkHref: parseEditorLinkHref,
    blockMode: 'editor',
    linkMode: 'anchor',
    preserveCurlyBracePlaceholders: options.preserveCurlyBracePlaceholders,
    curlyBracePlaceholderLabels: options.curlyBracePlaceholderLabels,
  });
  if (!html) {
    return false;
  }

  const template = document.createElement('template');
  template.innerHTML = html;
  const fragment = template.content;
  const lastNode = fragment.lastChild;
  if (!lastNode) {
    return false;
  }

  const range = selection.getRangeAt(0);
  range.deleteContents();
  range.insertNode(fragment);
  range.setStartAfter(lastNode);
  range.collapse(true);
  applyDocumentRange(range);
  return true;
}

function resolveActiveTools(editor: HTMLElement, range: Range): ReadonlySet<MaxMarkdownTool> {
  const active = new Set<MaxMarkdownTool>();
  const container = resolveRangeNode(range.commonAncestorContainer);

  for (const tool of Object.keys(NATIVE_INLINE_COMMANDS) as Array<
    keyof typeof NATIVE_INLINE_COMMANDS
  >) {
    if (document.queryCommandState(NATIVE_INLINE_COMMANDS[tool])) active.add(tool);
  }

  if (findClosestElement(container, editor, 'code')) {
    active.add('code');
  }

  if (findClosestElement(container, editor, 'a')) {
    active.add('link');
  }

  if (
    findClosestElement(container, editor, '[data-max-block="heading"]') ||
    findClosestElement(container, editor, 'h1,h2,h3,h4,h5,h6')
  ) {
    active.add('heading');
  }

  return active;
}

function findClosestElement(node: Node, root: HTMLElement, selector: string): HTMLElement | null {
  const element = node.nodeType === Node.ELEMENT_NODE ? (node as Element) : node.parentElement;
  const closest = element?.closest(selector);
  return closest && root.contains(closest) ? (closest as HTMLElement) : null;
}

function serializeEditorMarkdown(
  root: HTMLElement,
  options: RichTextSerializationOptions = {},
): string {
  return serializeChildNodes(root.childNodes, options).trimEnd();
}

function serializeChildNodes(
  nodes: NodeListOf<ChildNode> | ChildNode[],
  options: RichTextSerializationOptions = {},
): string {
  let content = '';
  for (const node of Array.from(nodes)) {
    const serialized = serializeNode(node, options);
    if (serialized && node.nodeType === Node.ELEMENT_NODE) {
      const element = node as HTMLElement;
      const tag = element.tagName.toLowerCase();
      const isBlock =
        BLOCK_TAGS.has(tag) ||
        tag === 'pre' ||
        isHeadingElement(element, tag) ||
        element.dataset.maxBlock === 'quote';
      // FLAG: Native Enter can leave the first line unwrapped before div/p siblings.
      if (isBlock && content && !content.endsWith('\n')) content += '\n';
    }
    content += serialized;
  }
  return content;
}

function serializeNode(node: Node, options: RichTextSerializationOptions = {}): string {
  if (node.nodeType === Node.TEXT_NODE) {
    return escapeMarkdownText((node.textContent ?? '').replace(/\u00a0/g, ' '), options);
  }

  if (node.nodeType !== Node.ELEMENT_NODE) {
    return '';
  }

  const element = node as HTMLElement;
  const tagName = element.tagName.toLowerCase();

  if (element.hasAttribute('data-max-link-boundary')) return '';

  if (options.preserveCurlyBracePlaceholders && element.dataset.maxPlaceholder) {
    const placeholderKey = element.dataset.maxPlaceholder;
    return /^[A-Za-z0-9_]+$/u.test(placeholderKey) ? `{${placeholderKey}}` : '';
  }

  if (tagName === 'br') {
    return '\n';
  }

  if (tagName === 'code') {
    return `\`${serializeCodeText(element.textContent ?? '')}\``;
  }

  if (tagName === 'pre') {
    return appendBlockBreak(`\`\`\`\n${serializeCodeBlockText(element.textContent ?? '')}\n\`\`\``);
  }

  const content = serializeChildNodes(element.childNodes, options);

  if (isHeadingElement(element, tagName)) {
    const headingContent = content.replace(/\n+/gu, ' ').trim();
    const level = /^h([1-6])$/u.exec(tagName)?.[1] ?? element.dataset.maxHeadingLevel ?? '1';
    const normalizedLevel = /^[1-6]$/u.test(level) ? level : '1';
    return headingContent
      ? appendBlockBreak(`${'#'.repeat(Number.parseInt(normalizedLevel, 10))} ${headingContent}`)
      : '';
  }

  if (tagName === 'blockquote' || element.dataset.maxBlock === 'quote') {
    return appendBlockBreak(
      content
        .split('\n')
        .map((line) => (line.trim() ? `> ${line}` : line))
        .join('\n'),
    );
  }

  switch (tagName) {
    case 'strong':
    case 'b':
      return serializeEditorInlineMarkdown(content, 'bold');
    case 'em':
    case 'i':
      return serializeEditorInlineMarkdown(content, 'italic');
    case 'u':
      return serializeEditorInlineMarkdown(content, 'underline');
    case 's':
    case 'strike':
    case 'del':
      return serializeEditorInlineMarkdown(content, 'strike');
    case 'mark':
      return serializeEditorInlineMarkdown(content, 'highlight');
    case 'a':
      return serializeEditorLinkMarkdown(content, element.getAttribute('href') || '');
    default:
      return BLOCK_TAGS.has(tagName) ? appendBlockBreak(content) : content;
  }
}

function appendBlockBreak(content: string): string {
  if (!content) {
    return '\n';
  }

  return content.endsWith('\n') ? content : `${content}\n`;
}

function escapeMarkdownText(value: string, options: RichTextSerializationOptions = {}): string {
  if (options.preserveCurlyBracePlaceholders) {
    const parts: string[] = [];
    const placeholderPattern = /\{[A-Za-z0-9_]+\}/gu;
    let cursor = 0;

    for (const match of value.matchAll(placeholderPattern)) {
      parts.push(escapePlainMarkdownText(value.slice(cursor, match.index)));
      parts.push(match[0]);
      cursor = match.index + match[0].length;
    }

    parts.push(escapePlainMarkdownText(value.slice(cursor)));
    return parts.join('');
  }

  return escapePlainMarkdownText(value);
}

function escapePlainMarkdownText(value: string): string {
  return value.replace(/[\\`*_()[\]~+#^>]/gu, '\\$&');
}

function serializeCodeText(value: string): string {
  return value.replace(/\r?\n/gu, ' ').replace(/`/gu, "'");
}

function serializeCodeBlockText(value: string): string {
  return value.replace(/\r\n?/gu, '\n').replace(/```/gu, "'''").trimEnd();
}

function isHeadingElement(element: HTMLElement, tagName: string): boolean {
  return /^h[1-6]$/u.test(tagName) || element.dataset.maxBlock === 'heading';
}
