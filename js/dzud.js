/* Reads the dzud files of the pipeline (pipeline/dzud_build.py, docs/GEE_DATA_FORMAT.md). Dzud has a season, 1 November to
 * 31 March, and files of its own; everything else about it runs as for the other hazards of the grid. */
import { NODATA, bytes } from "./dataset.js";
import { oddsChance } from "./stats.js";
import { SCORE_MODEL } from "./meaning.js";

const BASE = "data/gee/dzud/";
/** Nandintsetseg et al. (2018), Table 1: correlations with livestock deaths. Fixed, not fitted (docs/DZUD_CHECK.md). */
export const DZUD_WEIGHTS = { snow: 0.41, cold: 0.35, press: 0.29, summer: 0.24 };
const SUM = Object.values(DZUD_WEIGHTS).reduce((a, b) => a + b, 0);
const decodeZ = (v) => (v === NODATA ? null : v / 240 * 6 - 3);

export function inSeason(date, [from, to]) {
  const m = Number(date.slice(5, 7));
  return m >= from || m <= to;
}

/** The winter of a day of the season, by the year it starts in. */
export const winterOf = (date) => Number(date.slice(0, 4)) - (Number(date.slice(5, 7)) >= 7 ? 0 : 1);

/** Frame of day `i` (0 first): the file holds the first day, then each day's change from the day before, modulo 256. */
export function undelta(pack, size, i) {
  const out = pack.slice(0, size);
  for (let d = 1; d <= i; d++) for (let k = 0, o = d * size; k < size; k++) out[k] += pack[o + k]; // a Uint8Array wraps at 256
  return out;
}

const packs = new Map();
function pack(name) {
  if (!packs.has(name)) {
    packs.set(name, bytes(`${BASE}${name}.bin.gz`).catch((e) => { packs.delete(name); if (e.status === 404) return null; throw e; }));
    if (packs.size > 8) packs.delete(packs.keys().next().value);
  }
  return packs.get(name);
}

/** The day's score and the four z-scores it is made of, or null out of season and on a day not computed. */
export async function loadDzudDay(m, date) {
  if (!m.dzud || !inSeason(date, m.dzud.season)) return null;
  const n = m.grid.nx * m.grid.ny, nb = m.dzud.bands.length, i = Number(date.slice(8)) - 1;
  const [month, fixed] = await Promise.all([pack(date.slice(0, 7)), pack(`season_${winterOf(date)}`)]);
  if (!month || !fixed || (i + 1) * n * nb > month.length) return null;
  const f = undelta(month, n * nb, i), band = (k) => f.subarray(k * n, (k + 1) * n);
  if (!band(0).some((v) => v !== NODATA)) return null;
  return { dzud: band(0), z_snow: band(1), z_cold: band(2), z_press: fixed.subarray(0, n), z_summer: fixed.subarray(n, 2 * n) }; // no u_dzud: input error not measured
}

/** Mean z-score of each indicator over the cells, or null where there is none. */
function meanZ(cells, day) {
  const out = {};
  for (const k of Object.keys(DZUD_WEIGHTS)) {
    let sw = 0, s = 0;
    for (const { i, w } of cells) { const v = decodeZ(day[`z_${k}`][i]); if (v !== null) { sw += w; s += w * v; } }
    if (!sw) return null;
    out[k] = s / sw;
  }
  return out;
}

/** How much each indicator adds to the index of the area (weight times z-score), the strongest first. */
export function dzudParts(cells, day) {
  const z = day && meanZ(cells, day);
  return z && Object.entries(z).map(([key, v]) => ({ key, z: v, part: DZUD_WEIGHTS[key] * v / SUM })).sort((a, b) => b.part - a.part);
}

const round = (v, d) => (v === null || v === undefined ? null : +v.toFixed(d));
/** The columns dzud adds to the files. The chance stops where the check stopped, and p_capped says so. */
export const DZUD_FIELDS = [{ name: "p_loss6", type: "N", size: 8, decimals: 3 }, { name: "p_capped", type: "C", size: 1 },
  ...Object.keys(DZUD_WEIGHTS).map((k) => ({ name: `z_${k}`, type: "N", size: 8, decimals: 2 }))];
export function dzudFields(score, cells, day) {
  const { base, trust } = SCORE_MODEL.dzud, z = meanZ(cells, day), has = typeof score === "number";
  const p = has ? oddsChance(score, base) : null;
  return { p_loss6: has ? round(Math.min(p, trust), 3) : null, p_capped: has && p > trust ? "Y" : "N", ...Object.fromEntries(Object.keys(DZUD_WEIGHTS).map((k) => [`z_${k}`, z ? round(z[k], 2) : null])) };
}
