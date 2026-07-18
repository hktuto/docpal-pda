/**
 * Dismiss an overlay dialog only on a genuine overlay click: the press must
 * both start AND end on the overlay itself. Prevents accidental dismissal
 * when a drag (e.g. selecting text in an input) starts inside the dialog and
 * ends on the overlay.
 */
export function useOverlayDismiss(dismiss: () => void) {
  let downOnOverlay = false;

  function onMousedown(e: MouseEvent) {
    downOnOverlay = e.target === e.currentTarget;
  }

  function onClick(e: MouseEvent) {
    if (downOnOverlay && e.target === e.currentTarget) dismiss();
    downOnOverlay = false;
  }

  return { onMousedown, onClick };
}
