import { useEffect } from 'react';

let lockCount = 0;
let restoreOverflow = '';

/**
 * Prevents the page scrolling behind an open overlay.
 *
 * Counted rather than boolean: a drawer that opens a confirmation dialog would
 * otherwise release the lock when the *inner* one closes, leaving the page
 * scrollable underneath the drawer that is still open.
 */
export function useScrollLock(active: boolean): void {
  useEffect(() => {
    if (!active) return undefined;

    if (lockCount === 0) {
      restoreOverflow = document.body.style.overflow;
      document.body.style.overflow = 'hidden';
    }
    lockCount += 1;

    return () => {
      lockCount -= 1;
      if (lockCount === 0) document.body.style.overflow = restoreOverflow;
    };
  }, [active]);
}
