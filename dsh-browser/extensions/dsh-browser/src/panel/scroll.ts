/**
 * Smart follow-scroll: while the user sits near the bottom, new content
 * pulls the view down with it; the moment they scroll up to read, following
 * stops (and a jump-to-latest button appears). Pure distance check so the
 * threshold is unit-tested.
 *
 * @module
 */

/** Distance-from-bottom (px) still counted as "stuck to the bottom". */
export const SCROLL_STICK_THRESHOLD_PX = 80

/**
 * Whether a scroll position counts as stuck to the bottom.
 * @param scrollHeight - total scrollable height.
 * @param scrollTop - current scroll offset.
 * @param clientHeight - visible viewport height.
 * @returns true when the bottom is within the stick threshold (or content is shorter than the viewport).
 */
export function isNearBottom(scrollHeight: number, scrollTop: number, clientHeight: number): boolean {
  return scrollHeight - scrollTop - clientHeight < SCROLL_STICK_THRESHOLD_PX
}
