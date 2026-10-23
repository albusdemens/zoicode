import type { DOMElement } from 'ink';

interface YogaBox {
  getComputedHeight(): number;
  setMinHeight(rows: number): void;
}

/** The parts of Ink's DOM this relies on. They are not public API, so each one is checked. */
type InkNode = DOMElement & {
  parentNode?: InkNode;
  yogaNode?: YogaBox;
  onComputeLayout?: () => void;
  staticNode?: { yogaNode?: YogaBox };
};

export interface Pin {
  /** After the screen is cleared: fill it again, so the live area starts at the bottom. */
  refill(): void;
  release(): void;
}

/**
 * Keeps the live area (everything under the transcript: Raon's work, the cat, the prompt box and
 * the footer) at the bottom of the screen.
 *
 * Ink redraws the live area in place, from its top row down, so whenever it got shorter (the
 * command menu closes, a permission prompt is answered, the spinner goes away) the prompt box would
 * float up and leave blank rows under it. Instead the live area never gets shorter than it was,
 * except by the rows of transcript printed above it in the same frame, which push it down by as
 * much. The spare rows go at its top, so `live` should lay out its children with
 * justifyContent="flex-end". At first it fills the screen under whatever is printed above it.
 *
 * How many transcript rows a frame prints is only known inside Ink's layout pass, so this wraps
 * it. If Ink's internals are not what it expects, it does nothing.
 */
export function pinToBottom(live: DOMElement, rows: () => number): Pin {
  let root = live as InkNode;
  while (root.parentNode) root = root.parentNode;
  const layout = root.onComputeLayout;
  const box = (live as InkNode).yogaNode;
  if (typeof layout !== 'function' || !box || typeof box.setMinHeight !== 'function') {
    return { refill() {}, release() {} };
  }
  // Ink ends each frame with a newline, so the cursor takes the last row and the live area can
  // have the ones above it.
  let keep = rows() - 1;
  const pinned = () => {
    layout();
    try {
      const printed = root.staticNode?.yogaNode?.getComputedHeight() ?? 0;
      box.setMinHeight(Math.max(0, Math.min(rows() - 1, keep - printed)));
      layout();
      keep = box.getComputedHeight();
    } catch {
      // A layout this can't read: leave Ink's own result.
    }
  };
  root.onComputeLayout = pinned;
  return {
    refill() {
      keep = rows() - 1;
    },
    release() {
      if (root.onComputeLayout === pinned) root.onComputeLayout = layout;
    },
  };
}
