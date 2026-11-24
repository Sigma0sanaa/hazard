/* Dust lifted from the ground of the drawn area and blown by the hourly wind, for the 3D view. A picture of where and
 * when dust can rise and where the wind takes it, not a concentration:
 *  - Emission: a cell emits in an hour when Sentinel-2 marks it bare or sparse (js/aoi/dust.js), there is no snow
 *    (< 1 cm), the topsoil is not wet (< 0.25 m3/m3), the day is not a wet day (≥ 0.254 mm, US EPA AP-42 13.2.2), and
 *    the 10 m wind is above the threshold measured in Mongolia (Kurosaki & Mikami 2007: 8.9 m/s for Gobi desert, 9.8 m/s
 *    for grassland, their 5th percentile, the ground at its most erodible), as the dust check of the page uses.
 *  - Strength: White's (1979) saltation flux shape u^3 (1 + ut/u)(1 - ut^2/u^2), relative only.
 *  - Particles are released in proportion, blown by the wind of their cell and hour, and mixed upward by a random
 *    walk; they fade after `lifeHours`. The wind is the 9-25 km field of the weather model spread over the box, so
 *    valleys and ridges do not steer it. The same seed gives the same run, so the time line can be scrubbed. */
import { at, cellMetres } from "./inputs.js";
import { LAND, DUST, THRESHOLD_WIND } from "../aoi/dust.js";

export const DUST3D = { maxParticles: 40000, perHourPeak: 6000, stepMinutes: 5, lifeHours: 18, mixing: 1.5, top: 1500 };

/** Threshold wind (m/s) of a ground class, or Infinity where no dust rises. */
export const thresholdOf = (land) => (land === LAND.bare ? THRESHOLD_WIND.favourable.desert : land === LAND.sparse ? THRESHOLD_WIND.favourable.grass : Infinity);

/** White (1979) flux shape for wind u above threshold ut (relative units). */
export const whiteFlux = (u, ut) => (u > ut ? u * u * u * (1 + ut / u) * (1 - (ut * ut) / (u * u)) : 0);

/** Wet days: local days whose mean rain over the box reaches 0.254 mm. */
export function wetDays(fields) {
  const byDay = new Map();
  for (let h = 0; h < fields.hours; h++) {
    const f = fields.precip[h], m = f.reduce((a, b) => a + b, 0) / f.length, d = fields.time[h].slice(0, 10);
    byDay.set(d, (byDay.get(d) ?? 0) + m);
  }
  return new Set([...byDay].filter(([, mm]) => mm >= DUST.wetDayMm).map(([d]) => d));
}

/** Emission of every cell for every hour (relative flux, Float32 per hour) and the hourly totals. */
export function emissions(g, land, fields) {
  const n = g.w * g.h, wet = wetDays(fields), out = [], totals = [], P = fields.plan;
  const ut = new Float32Array(n);
  for (let i = 0; i < n; i++) ut[i] = thresholdOf(land[i]);
  for (let h = 0; h < fields.hours; h++) {
    const e = new Float32Array(n);
    let sum = 0;
    if (!wet.has(fields.time[h].slice(0, 10))) {
      for (let r = 0; r < g.h; r++) for (let c = 0; c < g.w; c++) {
        const i = r * g.w + c;
        if (ut[i] === Infinity) continue;
        if (at(P, fields.snowDepth[h], r, c) >= DUST.snowM || at(P, fields.soil[h], r, c) >= DUST.soilWet) continue;
        const u = Math.hypot(at(P, fields.u[h], r, c), at(P, fields.v[h], r, c));
        const f = whiteFlux(u, ut[i]);
        e[i] = f; sum += f;
      }
    }
    out.push(e); totals.push(sum);
  }
  return { perHour: out, totals };
}

/** A small seeded random generator (mulberry32). */
export function rng(seed) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

/** The particle run. advanceTo(minutes) moves it forward; reset() starts over (for scrubbing back). */
export function createDustRun(g, fields, em, { seed = 7 } = {}) {
  const m = cellMetres(g), W = g.w * m.x, H = g.h * m.y, N = DUST3D.maxParticles;
  const x = new Float32Array(N), y = new Float32Array(N), z = new Float32Array(N), age = new Float32Array(N), alive = new Uint8Array(N);
  const peak = Math.max(...em.totals, 0);
  let t = 0, next = 0, rand = rng(seed), live = 0;
  // cumulative emission of each hour, for drawing release cells in proportion
  const cumCache = new Map();
  const cum = (h) => {
    if (!cumCache.has(h)) { const e = em.perHour[h], c = new Float64Array(e.length); let s = 0; for (let i = 0; i < e.length; i++) { s += e[i]; c[i] = s; } cumCache.set(h, c); }
    return cumCache.get(h);
  };
  const pick = (c, v) => { let lo = 0, hi = c.length - 1; while (lo < hi) { const mid = (lo + hi) >> 1; if (c[mid] < v) lo = mid + 1; else hi = mid; } return lo; };
  function release(h, minutes) {
    const total = em.totals[h];
    if (!(total > 0) || !(peak > 0)) return;
    let k = Math.round(DUST3D.perHourPeak * (total / peak) * minutes / 60 + rand() - 0.5);
    const c = cum(h);
    while (k-- > 0) {
      const i = pick(c, rand() * total), r = (i / g.w) | 0, col = i - r * g.w;
      let s = next; for (let tries = 0; tries < N && alive[s]; tries++) s = (s + 1) % N;
      if (alive[s]) return; // all in the air
      next = (s + 1) % N;
      x[s] = (col + rand()) * m.x; y[s] = (r + rand()) * m.y; z[s] = 2 + 20 * rand(); age[s] = 0; alive[s] = 1; live++;
    }
  }
  function move(minutes) {
    const h = Math.min(fields.hours - 1, Math.floor(t / 60)), P = fields.plan, dt = minutes * 60, life = DUST3D.lifeHours * 60;
    const sd = Math.sqrt(2 * DUST3D.mixing * dt) * 10; // a visual vertical spread, metres
    for (let s = 0; s < N; s++) {
      if (!alive[s]) continue;
      const r = Math.min(g.h - 1, Math.max(0, Math.floor(y[s] / m.y))), c = Math.min(g.w - 1, Math.max(0, Math.floor(x[s] / m.x)));
      x[s] += at(P, fields.u[h], r, c) * dt;
      y[s] -= at(P, fields.v[h], r, c) * dt; // rows grow southward, v is northward
      z[s] = Math.min(DUST3D.top, Math.abs(z[s] + (rand() * 2 - 1) * sd));
      age[s] += minutes;
      if (x[s] < 0 || y[s] < 0 || x[s] > W || y[s] > H || age[s] > life) { alive[s] = 0; live--; }
    }
  }
  return {
    get time() { return t; }, x, y, z, age, alive, width: W, height: H, get count() { return live; },
    reset() { t = 0; next = 0; rand = rng(seed); alive.fill(0); live = 0; },
    advanceTo(target) {
      if (target < t) this.reset();
      const st = DUST3D.stepMinutes;
      while (t + st <= target + 1e-9) {
        const h = Math.min(fields.hours - 1, Math.floor(t / 60));
        release(h, st); move(st); t += st;
      }
    },
  };
}

/** Plain numbers of the run for the caption: hours with emission, the strongest hour, and its wind. */
export function summary(fields, em) {
  let hours = 0, best = -1;
  em.totals.forEach((v, h) => { if (v > 0) { hours++; if (best < 0 || v > em.totals[best]) best = h; } });
  return { hours, peakHour: best < 0 ? null : fields.time[best] };
}
