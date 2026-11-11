import assert from 'node:assert/strict';
import test from 'node:test';
import { isValidElement, type ReactElement } from 'react';
import { PostMediaPicker, PostPhotoChoice } from '../src/components/vk-parsing/post-media-picker';
import {
  isDirectVkParsingVideoUrl,
  PostVideoChoice,
} from '../src/components/vk-parsing/post-video-preview';

function collectElements(
  value: unknown,
  predicate: (element: ReactElement) => boolean,
  result: ReactElement[] = [],
): ReactElement[] {
  if (Array.isArray(value)) {
    for (const child of value) {
      collectElements(child, predicate, result);
    }
    return result;
  }

  if (!isValidElement(value)) {
    return result;
  }

  if (predicate(value)) {
    result.push(value);
  }

  collectElements((value.props as { children?: unknown }).children, predicate, result);
  return result;
}

function getClassName(element: ReactElement): string {
  const className = (element.props as { className?: unknown }).className;
  return typeof className === 'string' ? className : '';
}

function hasClass(element: ReactElement, className: string): boolean {
  return getClassName(element).split(/\s+/u).includes(className);
}

function renderPostVideoChoice(url: string, checked = true): ReactElement {
  const tree = PostVideoChoice({
    url,
    index: 0,
    checked,
    disabled: false,
    onToggle: () => undefined,
  });
  assert.ok(isValidElement(tree));
  return tree;
}

test('VK media picker keeps photo buttons and uses the video preview choice', () => {
  const videoUrl = 'https://vk.com/video-100200_4276';
  const tree = PostMediaPicker({
    photoUrls: ['https://example.com/photo-a.jpg', 'https://example.com/photo-b.jpg'],
    videoUrls: [videoUrl],
    linkUrls: [],
    selectedPhotoUrls: ['https://example.com/photo-a.jpg'],
    selectedVideoUrls: [videoUrl],
    selectedLinkUrls: [],
    stripLinksEnabled: false,
    disabled: false,
    onTogglePhoto: () => undefined,
    onToggleVideo: () => undefined,
    onToggleLink: () => undefined,
  });

  const photoButtons = collectElements(tree, (element) => element.type === PostPhotoChoice);
  const videoChoices = collectElements(tree, (element) => element.type === PostVideoChoice);

  assert.equal(photoButtons.length, 2);
  assert.equal((photoButtons[0]?.props as { checked?: unknown }).checked, true);
  assert.equal((photoButtons[1]?.props as { checked?: unknown }).checked, false);
  assert.equal(videoChoices.length, 1);
  assert.equal((videoChoices[0]?.props as { url?: unknown }).url, videoUrl);
});

test('VK video choice renders a compact preview with a separate open link', () => {
  const url = 'https://vk.com/video-100200_4276';
  const tree = renderPostVideoChoice(url);
  const selectButtons = collectElements(
    tree,
    (element) => element.type === 'button' && hasClass(element, 'vk-parsing-video-choice__select'),
  );
  const thumbs = collectElements(tree, (element) =>
    hasClass(element, 'vk-parsing-video-choice__thumb'),
  );
  const openLinks = collectElements(
    tree,
    (element) => element.type === 'a' && hasClass(element, 'vk-parsing-video-choice__open'),
  );

  assert.equal(selectButtons.length, 1);
  assert.equal((selectButtons[0]?.props as { 'aria-pressed'?: unknown })['aria-pressed'], true);
  assert.equal(thumbs.length, 1);
  assert.equal(openLinks.length, 1);
  assert.equal((openLinks[0]?.props as { href?: unknown }).href, url);
});

test('VK direct video URLs are detected separately from VK page links', () => {
  assert.equal(isDirectVkParsingVideoUrl('https://vkvd.example/video-720.mp4'), true);
  assert.equal(isDirectVkParsingVideoUrl('https://vk.com/video-100200_4276'), false);
});
