import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveSuggestionKeyboardLayout } from '../src/lib/channel-suggestion-keyboard-layout';

const baseline = {
  layoutHeight: 760,
  visualHeight: 760,
};

test('reserves 42 percent for an overlay keyboard without viewport metadata', () => {
  assert.deepEqual(
    resolveSuggestionKeyboardLayout({
      focused: true,
      fallbackEligible: true,
      layoutHeight: 760,
      visualHeight: 760,
      visualOffsetTop: 0,
      containerBottom: 760,
      keyboardOverlap: 0,
      baseline,
    }),
    {
      barReservePx: 319,
      fallbackReservePx: 319,
      viewportShrinkPx: 0,
      visibleBottomPx: 441,
    },
  );
});

test('bounds the overlay fallback reserve', () => {
  const compact = resolveSuggestionKeyboardLayout({
    focused: true,
    fallbackEligible: true,
    layoutHeight: 360,
    visualHeight: 360,
    visualOffsetTop: 0,
    containerBottom: 360,
    keyboardOverlap: 0,
    baseline: { layoutHeight: 360, visualHeight: 360 },
  });
  const tall = resolveSuggestionKeyboardLayout({
    focused: true,
    fallbackEligible: true,
    layoutHeight: 839,
    visualHeight: 839,
    visualOffsetTop: 0,
    containerBottom: 839,
    keyboardOverlap: 0,
    baseline: { layoutHeight: 839, visualHeight: 839 },
  });

  assert.equal(compact.fallbackReservePx, 180);
  assert.equal(tall.fallbackReservePx, 320);
});

test('keeps the unmeasured keyboard fallback below tabs and a usable composer', () => {
  for (const available of [0, 44, 96]) {
    const layout = resolveSuggestionKeyboardLayout({
      focused: true,
      fallbackEligible: true,
      layoutHeight: 320,
      visualHeight: 320,
      visualOffsetTop: 0,
      containerBottom: 320,
      keyboardOverlap: 0,
      fallbackMaxReservePx: available,
      baseline: { layoutHeight: 320, visualHeight: 320 },
    });
    assert.equal(layout.fallbackReservePx, available);
    assert.equal(layout.visibleBottomPx, 320 - available);
    assert.equal(layout.barReservePx, available);
  }
});

test('the composer space limit does not hide measured keyboard occlusion', () => {
  const layout = resolveSuggestionKeyboardLayout({
    focused: true,
    fallbackEligible: true,
    layoutHeight: 760,
    visualHeight: 760,
    visualOffsetTop: 0,
    containerBottom: 760,
    keyboardOverlap: 280,
    fallbackMaxReservePx: 0,
    baseline,
  });
  assert.equal(layout.fallbackReservePx, 0);
  assert.equal(layout.barReservePx, 280);
  assert.equal(layout.visibleBottomPx, 480);
});

test('uses visual viewport occlusion without adding the overlay fallback', () => {
  assert.deepEqual(
    resolveSuggestionKeyboardLayout({
      focused: true,
      fallbackEligible: true,
      layoutHeight: 760,
      visualHeight: 460,
      visualOffsetTop: 0,
      containerBottom: 760,
      keyboardOverlap: 0,
      baseline,
    }),
    {
      barReservePx: 300,
      fallbackReservePx: 0,
      viewportShrinkPx: 300,
      visibleBottomPx: 460,
    },
  );
});

test('does not reserve twice when the container already follows the visual viewport', () => {
  assert.deepEqual(
    resolveSuggestionKeyboardLayout({
      focused: true,
      fallbackEligible: true,
      layoutHeight: 760,
      visualHeight: 460,
      visualOffsetTop: 0,
      containerBottom: 460,
      keyboardOverlap: 300,
      baseline,
    }),
    {
      barReservePx: 0,
      fallbackReservePx: 0,
      viewportShrinkPx: 300,
      visibleBottomPx: 460,
    },
  );
});

test('does not reserve twice when the layout viewport and container already shrank', () => {
  assert.deepEqual(
    resolveSuggestionKeyboardLayout({
      focused: true,
      fallbackEligible: true,
      layoutHeight: 460,
      visualHeight: 460,
      visualOffsetTop: 0,
      containerBottom: 460,
      keyboardOverlap: 0,
      baseline,
    }),
    {
      barReservePx: 0,
      fallbackReservePx: 0,
      viewportShrinkPx: 300,
      visibleBottomPx: 460,
    },
  );
});

test('prefers measured overlap and clears all reserve after blur', () => {
  const measured = resolveSuggestionKeyboardLayout({
    focused: true,
    fallbackEligible: true,
    layoutHeight: 760,
    visualHeight: 760,
    visualOffsetTop: 0,
    containerBottom: 760,
    keyboardOverlap: 280,
    baseline,
  });
  const blurred = resolveSuggestionKeyboardLayout({
    focused: false,
    fallbackEligible: true,
    layoutHeight: 760,
    visualHeight: 760,
    visualOffsetTop: 0,
    containerBottom: 760,
    keyboardOverlap: 0,
    baseline,
  });

  assert.equal(measured.barReservePx, 280);
  assert.equal(measured.fallbackReservePx, 0);
  assert.equal(measured.visibleBottomPx, 480);
  assert.equal(blurred.barReservePx, 0);
  assert.equal(blurred.fallbackReservePx, 0);
});
