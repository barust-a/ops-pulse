import '@testing-library/jest-dom/vitest';

import { cleanup } from '@testing-library/react';
import { afterAll, afterEach, beforeAll, vi } from 'vitest';

import { fakeEcharts } from './fakeEcharts';
import { server } from './handlers';

// Canvas rendering is a process boundary jsdom cannot cross: every test talks to a fake ECharts.
vi.mock('../ui/chart/echartsCore', async () => {
  const fake = await import('./fakeEcharts');
  return { echarts: fake.fakeEcharts };
});

class NoopResizeObserver {
  observe(): void {
    // jsdom does no layout, so there is nothing to observe.
  }
  unobserve(): void {
    // See observe().
  }
  disconnect(): void {
    // See observe().
  }
}

/** jsdom has no `matchMedia`: tests run in the light colour scheme. */
class FakeMediaQueryList extends EventTarget implements MediaQueryList {
  readonly matches = false;
  readonly onchange = null;

  constructor(readonly media: string) {
    super();
  }

  addListener(): void {
    // Deprecated API, unused by the app.
  }

  removeListener(): void {
    // Deprecated API, unused by the app.
  }
}

function stubMatchMedia(query: string): MediaQueryList {
  return new FakeMediaQueryList(query);
}

vi.stubGlobal('ResizeObserver', NoopResizeObserver);
vi.stubGlobal('matchMedia', stubMatchMedia);

beforeAll(() => {
  server.listen({ onUnhandledRequest: 'error' });
});

afterEach(() => {
  cleanup();
  server.resetHandlers();
  sessionStorage.clear();
  fakeEcharts.reset();
});

afterAll(() => {
  server.close();
});
