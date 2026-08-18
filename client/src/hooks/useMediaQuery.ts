import { useEffect, useState } from 'react';

/** Reactive `matchMedia`. Used to decide layout, never to hide content entirely. */
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => window.matchMedia(query).matches);

  useEffect(() => {
    const list = window.matchMedia(query);
    // Re-read on subscribe: the viewport can change between render and effect.
    setMatches(list.matches);
    const onChange = (event: MediaQueryListEvent): void => setMatches(event.matches);
    list.addEventListener('change', onChange);
    return () => list.removeEventListener('change', onChange);
  }, [query]);

  return matches;
}

/** Tailwind's `lg` breakpoint — where the sidebar stops being a drawer. */
export function useIsDesktop(): boolean {
  return useMediaQuery('(min-width: 1024px)');
}
