import { useEffect, type RefObject } from 'react';

/**
 * Calls `handler` when a pointer press lands outside `ref`.
 *
 * Listens on `pointerdown` rather than `click`: a menu that closes on click
 * would still be open while the browser dispatches the press to whatever is
 * underneath it, so the first click outside would both close the menu and
 * activate the thing behind it.
 */
export function useOnClickOutside(
  ref: RefObject<HTMLElement | null>,
  handler: (event: PointerEvent) => void,
  enabled = true,
): void {
  useEffect(() => {
    if (!enabled) return undefined;

    const onPointerDown = (event: PointerEvent): void => {
      const element = ref.current;
      if (!element || event.target === null) return;
      if (element.contains(event.target as Node)) return;
      handler(event);
    };

    document.addEventListener('pointerdown', onPointerDown, true);
    return () => document.removeEventListener('pointerdown', onPointerDown, true);
  }, [ref, handler, enabled]);
}
