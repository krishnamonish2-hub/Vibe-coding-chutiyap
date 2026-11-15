// Small seeded pseudo-random number generator for the synthetic simulation (no external package).
//
// createRng(...keys) returns an independent, reproducible stream for any combination of keys, e.g.
// createRng(runSeed, 'votes', mealIndex). The same keys always give the same sequence, so every simulation step can
// re-derive a meal's hidden state without storing it, and results do not depend on how simulated time was advanced.
//
// Generator: sfc32 seeded through the cyrb128 string hash. Distributions mirror the numpy calls used by
// ml/src/generate_data.py (uniform, normal, lognormal, gamma, binomial, integers, choice without replacement).

function cyrb128(str) {
  let h1 = 1779033703; let h2 = 3144134277; let h3 = 1013904242; let h4 = 2773480762;
  for (let i = 0; i < str.length; i += 1) {
    const k = str.charCodeAt(i);
    h1 = h2 ^ Math.imul(h1 ^ k, 597399067);
    h2 = h3 ^ Math.imul(h2 ^ k, 2869860233);
    h3 = h4 ^ Math.imul(h3 ^ k, 951274213);
    h4 = h1 ^ Math.imul(h4 ^ k, 2716044179);
  }
  h1 = Math.imul(h3 ^ (h1 >>> 18), 597399067);
  h2 = Math.imul(h4 ^ (h2 >>> 22), 2869860233);
  h3 = Math.imul(h1 ^ (h3 >>> 17), 951274213);
  h4 = Math.imul(h2 ^ (h4 >>> 19), 2716044179);
  h1 ^= h2 ^ h3 ^ h4; h2 ^= h1; h3 ^= h1; h4 ^= h1;
  return [h1 >>> 0, h2 >>> 0, h3 >>> 0, h4 >>> 0];
}

function sfc32(a, b, c, d) {
  return function next() {
    a >>>= 0; b >>>= 0; c >>>= 0; d >>>= 0;
    let t = (a + b) | 0;
    a = b ^ (b >>> 9);
    b = (c + (c << 3)) | 0;
    c = (c << 21) | (c >>> 11);
    d = (d + 1) | 0;
    t = (t + d) | 0;
    c = (c + t) | 0;
    return (t >>> 0) / 4294967296; // [0, 1)
  };
}

export function createRng(...keys) {
  if (keys.length === 0) throw new TypeError('createRng needs at least one key');
  const next = sfc32(...cyrb128(keys.map(String).join('|')));
  for (let i = 0; i < 12; i += 1) next(); // warm-up

  let spareNormal = null;

  const rng = {
    random: next,

    uniform(low = 0, high = 1) {
      return low + (high - low) * next();
    },

    // Box-Muller (one spare value cached).
    normal(mean = 0, sd = 1) {
      if (spareNormal !== null) {
        const z = spareNormal;
        spareNormal = null;
        return mean + sd * z;
      }
      let u = 0;
      while (u === 0) u = next();
      const v = next();
      const r = Math.sqrt(-2 * Math.log(u));
      spareNormal = r * Math.sin(2 * Math.PI * v);
      return mean + sd * r * Math.cos(2 * Math.PI * v);
    },

    lognormal(mean = 0, sigma = 1) {
      return Math.exp(rng.normal(mean, sigma));
    },

    // Marsaglia-Tsang; shape < 1 handled with the standard boost.
    gamma(shape, scale = 1) {
      if (!(shape > 0) || !(scale > 0)) throw new RangeError('gamma needs shape > 0 and scale > 0');
      if (shape < 1) return rng.gamma(shape + 1, scale) * next() ** (1 / shape);
      const d = shape - 1 / 3;
      const c = 1 / Math.sqrt(9 * d);
      for (;;) {
        let x;
        let v;
        do {
          x = rng.normal();
          v = 1 + c * x;
        } while (v <= 0);
        v = v * v * v;
        const u = next();
        if (u < 1 - 0.0331 * x ** 4 || Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v * scale;
      }
    },

    // Exact: sum of n Bernoulli trials (n is at most 1,000 in the simulation).
    binomial(n, p) {
      if (!Number.isInteger(n) || n < 0) throw new RangeError('binomial needs a non-negative integer n');
      if (p <= 0) return 0;
      if (p >= 1) return n;
      let k = 0;
      for (let i = 0; i < n; i += 1) if (next() < p) k += 1;
      return k;
    },

    // Integer in [low, high) — like numpy's rng.integers(low, high).
    integers(low, high) {
      return low + Math.floor(next() * (high - low));
    },

    // `size` distinct elements of `items` in random order (partial Fisher-Yates) — like choice(replace=False).
    sample(items, size) {
      if (size > items.length) throw new RangeError('sample size larger than population');
      const pool = [...items];
      for (let i = 0; i < size; i += 1) {
        const j = i + Math.floor(next() * (pool.length - i));
        [pool[i], pool[j]] = [pool[j], pool[i]];
      }
      return pool.slice(0, size);
    },
  };
  return rng;
}

export function clip(value, low, high) {
  return Math.min(high, Math.max(low, value));
}

export function round(value, decimals) {
  const f = 10 ** decimals;
  return Math.round(value * f) / f;
}
