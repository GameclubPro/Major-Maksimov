const KEYBOARD_OPEN_THRESHOLD_PX = 120;
const FALLBACK_KEYBOARD_RATIO = 0.42;
const MIN_FALLBACK_KEYBOARD_RESERVE_PX = 180;
const MAX_FALLBACK_KEYBOARD_RESERVE_PX = 320;

export type SuggestionKeyboardViewportBaseline = {
  layoutHeight: number;
  visualHeight: number;
};

type SuggestionKeyboardLayoutInput = {
  focused: boolean;
  fallbackEligible: boolean;
  layoutHeight: number;
  visualHeight: number;
  visualOffsetTop: number;
  containerBottom: number;
  keyboardOverlap: number;
  fallbackMaxReservePx?: number;
  baseline: SuggestionKeyboardViewportBaseline;
};

export type SuggestionKeyboardLayout = {
  barReservePx: number;
  fallbackReservePx: number;
  viewportShrinkPx: number;
  visibleBottomPx: number;
};

function normalizeDimension(value: number, fallback = 0): number {
  return Number.isFinite(value) ? Math.max(0, value) : fallback;
}

export function resolveSuggestionKeyboardLayout(
  input: SuggestionKeyboardLayoutInput,
): SuggestionKeyboardLayout {
  const layoutHeight = normalizeDimension(input.layoutHeight);
  const visualHeight = normalizeDimension(input.visualHeight, layoutHeight);
  const visualOffsetTop = normalizeDimension(input.visualOffsetTop);
  const containerBottom = normalizeDimension(input.containerBottom, layoutHeight);
  const keyboardOverlap = normalizeDimension(input.keyboardOverlap);
  const baselineLayoutHeight = normalizeDimension(input.baseline.layoutHeight, layoutHeight);
  const baselineVisualHeight = normalizeDimension(input.baseline.visualHeight, visualHeight);
  const layoutShrink = Math.max(0, baselineLayoutHeight - layoutHeight);
  const visualShrink = Math.max(0, baselineVisualHeight - visualHeight);
  const viewportShrinkPx = Math.ceil(Math.max(layoutShrink, visualShrink));
  const visualOcclusionPx = Math.ceil(Math.max(0, layoutHeight - (visualOffsetTop + visualHeight)));
  const hasMeasuredOverlap = keyboardOverlap >= KEYBOARD_OPEN_THRESHOLD_PX;
  const hasViewportShrink =
    viewportShrinkPx >= KEYBOARD_OPEN_THRESHOLD_PX ||
    visualOcclusionPx >= KEYBOARD_OPEN_THRESHOLD_PX;
  const fallbackReservePx =
    input.focused && input.fallbackEligible && !hasMeasuredOverlap && !hasViewportShrink
      ? Math.min(
          normalizeDimension(input.fallbackMaxReservePx ?? layoutHeight),
          MAX_FALLBACK_KEYBOARD_RESERVE_PX,
          Math.max(
            MIN_FALLBACK_KEYBOARD_RESERVE_PX,
            Math.round(visualHeight * FALLBACK_KEYBOARD_RATIO),
          ),
        )
      : 0;

  const visualBottom = Math.min(layoutHeight, visualOffsetTop + visualHeight);
  const metadataBottom = hasMeasuredOverlap ? layoutHeight - keyboardOverlap : layoutHeight;
  const fallbackBottom = fallbackReservePx > 0 ? layoutHeight - fallbackReservePx : layoutHeight;
  const visibleBottomPx = Math.max(0, Math.min(visualBottom, metadataBottom, fallbackBottom));
  const barReservePx = input.focused
    ? Math.ceil(Math.max(0, containerBottom - visibleBottomPx))
    : 0;

  return {
    barReservePx,
    fallbackReservePx,
    viewportShrinkPx,
    visibleBottomPx,
  };
}
