import { useEffect, type RefObject } from 'react';
import { useKeyboardOpen } from './use-keyboard-open';

export function useVisibleEditorCaret(editorRef: RefObject<HTMLElement | null>) {
  const keyboardOpen = useKeyboardOpen();
  useEffect(() => {
    if (!keyboardOpen) return;
    const viewport = window.visualViewport;
    let frame = 0;
    const reveal = () => {
      window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(() => {
        const editor = editorRef.current;
        const selection = window.getSelection();
        if (
          !editor ||
          document.activeElement !== editor ||
          !selection?.focusNode ||
          !editor.contains(selection.focusNode)
        )
          return;
        const caret = document.createRange();
        caret.setStart(selection.focusNode, selection.focusOffset);
        caret.collapse(true);
        if (
          !caret.getBoundingClientRect().height &&
          selection.focusNode instanceof Text &&
          selection.focusNode.length
        ) {
          const offset = Math.min(
            Math.max(0, selection.focusOffset - 1),
            selection.focusNode.length - 1,
          );
          caret.setStart(selection.focusNode, offset);
          caret.setEnd(selection.focusNode, offset + 1);
        }
        const caretBounds = () => {
          const rect = caret.getBoundingClientRect();
          if (rect.height) return rect;
          // Empty contenteditables have no measurable Range in WebKit. Use their
          // first text line, recomputing its position after each ancestor scroll.
          const anchor = selection.focusNode instanceof Element ? selection.focusNode : editor;
          const bounds = anchor.getBoundingClientRect();
          const style = getComputedStyle(anchor);
          const lineHeight = parseFloat(style.lineHeight) || parseFloat(style.fontSize) * 1.4;
          const top =
            bounds.top +
            parseFloat(style.borderTopWidth) +
            parseFloat(style.paddingTop) -
            anchor.scrollTop;
          return { top, bottom: top + lineHeight };
        };
        const top = (viewport?.offsetTop ?? 0) + 12;
        const bottom = (viewport?.offsetTop ?? 0) + (viewport?.height ?? innerHeight) - 12;
        const delta = (start: number, end: number) => {
          const rect = caretBounds();
          return rect.top < start ? rect.top - start : rect.bottom > end ? rect.bottom - end : 0;
        };
        for (
          let parent: HTMLElement | null = editor;
          parent && parent !== document.body;
          parent = parent.parentElement
        ) {
          if (
            !/(auto|scroll)/.test(getComputedStyle(parent).overflowY) ||
            parent.scrollHeight <= parent.clientHeight
          )
            continue;
          const bounds = parent.getBoundingClientRect();
          const start = Math.max(top, bounds.top + 8);
          const end = Math.min(bottom, bounds.bottom - 8);
          if (end > start) parent.scrollTop += delta(start, end);
        }
        const distance = delta(top, bottom);
        if (Math.abs(distance) > 1) window.scrollBy({ top: distance, behavior: 'instant' });
      });
    };
    const observer = new ResizeObserver(reveal);
    for (
      let parent = editorRef.current;
      parent && parent !== document.body;
      parent = parent.parentElement
    )
      observer.observe(parent);
    reveal();
    viewport?.addEventListener('resize', reveal);
    window.addEventListener('resize', reveal);
    document.addEventListener('selectionchange', reveal);
    editorRef.current?.addEventListener('focus', reveal);
    const editor = editorRef.current;
    return () => {
      window.cancelAnimationFrame(frame);
      observer.disconnect();
      viewport?.removeEventListener('resize', reveal);
      window.removeEventListener('resize', reveal);
      document.removeEventListener('selectionchange', reveal);
      editor?.removeEventListener('focus', reveal);
    };
  }, [editorRef, keyboardOpen]);
}
