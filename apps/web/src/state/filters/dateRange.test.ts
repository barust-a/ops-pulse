import { describe, expect, it } from 'vitest';

import { rangeEndingOn } from './dateRange';

describe('rangeEndingOn', () => {
  it('spans the preset, today included', () => {
    expect(rangeEndingOn(new Date('2026-10-10T09:00:00Z'), 7)).toEqual({
      from: '2026-10-04',
      to: '2026-10-10',
    });
  });

  it('crosses month boundaries', () => {
    expect(rangeEndingOn(new Date('2026-10-10T23:59:00Z'), 30)).toEqual({
      from: '2026-09-11',
      to: '2026-10-10',
    });
  });
});
