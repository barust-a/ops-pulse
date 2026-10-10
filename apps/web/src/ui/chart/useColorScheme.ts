import { useSyncExternalStore } from 'react';

import type { ChartTheme } from './echartsCore';

const DARK_QUERY = '(prefers-color-scheme: dark)';

function subscribe(onChange: () => void): () => void {
  const query = globalThis.matchMedia(DARK_QUERY);
  query.addEventListener('change', onChange);
  return () => {
    query.removeEventListener('change', onChange);
  };
}

function snapshot(): ChartTheme {
  return globalThis.matchMedia(DARK_QUERY).matches ? 'dark' : 'light';
}

/** The OS colour scheme, live: charts redraw in dark mode as the CSS does. */
export function useColorScheme(): ChartTheme {
  return useSyncExternalStore(subscribe, snapshot);
}
