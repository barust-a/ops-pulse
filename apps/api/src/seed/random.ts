/** A seeded pseudo-random source: the same seed always generates the same demo data. */
export interface Random {
  /** Uniform in [0, 1). */
  next(): number;
  /** Uniform integer in [min, max]. */
  int(min: number, max: number): number;
  chance(probability: number): boolean;
  pick<T>(items: readonly T[]): T;
  weighted<T>(entries: readonly (readonly [T, number])[]): T;
  logNormal(median: number, sigma: number): number;
  poisson(mean: number): number;
}

/** mulberry32: tiny, fast and good enough for synthetic data (not for anything secret). */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d_2b_79_f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

export function createRandom(seed: number): Random {
  const next = mulberry32(seed);

  function pick<T>(items: readonly T[]): T {
    const item = items[Math.floor(next() * items.length)];
    if (item === undefined) throw new Error('pick() needs at least one item');
    return item;
  }

  function weighted<T>(entries: readonly (readonly [T, number])[]): T {
    const total = entries.reduce((sum, [, weight]) => sum + weight, 0);
    let threshold = next() * total;
    for (const [value, weight] of entries) {
      threshold -= weight;
      if (threshold < 0) return value;
    }
    return pick(entries)[0];
  }

  function standardNormal(): number {
    // Box–Muller; 1 - next() avoids log(0).
    return Math.sqrt(-2 * Math.log(1 - next())) * Math.cos(2 * Math.PI * next());
  }

  function poisson(mean: number): number {
    // Knuth's method: fine for the small means used here.
    const limit = Math.exp(-mean);
    let count = 0;
    let product = next();
    while (product > limit) {
      count += 1;
      product *= next();
    }
    return count;
  }

  return {
    next,
    int: (min, max) => min + Math.floor(next() * (max - min + 1)),
    chance: (probability) => next() < probability,
    pick,
    weighted,
    logNormal: (median, sigma) => median * Math.exp(sigma * standardNormal()),
    poisson,
  };
}
