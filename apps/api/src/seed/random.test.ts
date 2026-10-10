import { describe, expect, it } from 'vitest';

import { createRandom } from './random.js';

describe('createRandom', () => {
  it('replays the same sequence for the same seed', () => {
    const a = createRandom(42);
    const b = createRandom(42);
    expect(Array.from({ length: 5 }, () => a.next())).toEqual(
      Array.from({ length: 5 }, () => b.next()),
    );
  });

  it('draws in [0, 1)', () => {
    const random = createRandom(7);
    const draws = Array.from({ length: 1000 }, () => random.next());
    expect(Math.min(...draws)).toBeGreaterThanOrEqual(0);
    expect(Math.max(...draws)).toBeLessThan(1);
  });

  it('picks weighted entries in proportion', () => {
    const random = createRandom(1);
    const picks = Array.from({ length: 10_000 }, () =>
      random.weighted([
        ['rare', 1],
        ['common', 9],
      ]),
    );
    const rare = picks.filter((pick) => pick === 'rare').length / picks.length;
    expect(rare).toBeGreaterThan(0.08);
    expect(rare).toBeLessThan(0.12);
  });

  it('draws a log-normal around its median', () => {
    const random = createRandom(3);
    const draws = Array.from({ length: 5001 }, () => random.logNormal(100, 0.8)).toSorted(
      (a, b) => a - b,
    );
    expect(draws[2500]).toBeGreaterThan(90);
    expect(draws[2500]).toBeLessThan(110);
  });

  it('draws a Poisson count with the requested mean', () => {
    const random = createRandom(5);
    const draws = Array.from({ length: 5000 }, () => random.poisson(4));
    const mean = draws.reduce((sum, draw) => sum + draw, 0) / draws.length;
    expect(mean).toBeGreaterThan(3.8);
    expect(mean).toBeLessThan(4.2);
  });
});
