/* Turns a set of grid cells and the stored grids into the numbers of the area window.
 * Used for a drawn box and for a soum alike, so both are computed the same way. */
import { cellsLevel, cellsMean, combineUncertainty, fin, samplingUncertainty, spatialLag1, trendReport } from "./stats.js";
import { gumbelFit, returnLevel } from "./flood_stats.js";
import { decode, decodeCount } from "./dataset.js";
import { SCORE_MODEL } from "./meaning.js";

export const HIGH_SCORE = 60;
const KM2_PER_DEG2 = 111.32 * 111.32;

/** Area in km2 of the cells that hold data in `frame`. */
export function validAreaKm2(cells, frame, grid) {
  let a = 0;
  for (const { i, w } of cells) if (decode(frame[i]) !== null) a += w;
  return a * grid.dx * grid.dy * KM2_PER_DEG2;
}

/** Mean score of each month. A month with no data stays null. */
export function monthSeries(cube, firstMonth, cells) {
  const [y0, m0] = firstMonth.split("-").map(Number), out = [];
  for (let f = 0; f < cube.frames; f++) {
    const k = m0 - 1 + f, y = y0 + Math.floor(k / 12), m = (k % 12) + 1, r = cellsMean(cube.frame(f), cells, decode);
    out.push({ y, m, t: y + (m - 0.5) / 12, v: r ? r.mean : null });
  }
  return out;
}

/** A hazard with a season ([first month, last month], over the turn of the year) is counted by season, named by the year it
 * starts in: the period of a month, or null outside the season. Without a season it is the calendar year. */
const periodOf = (y, m, season) => (!season ? y : m >= season[0] ? y : m <= season[1] ? y - 1 : null);
const periodMonths = (season) => (season ? 13 - season[0] + season[1] : 12);
/** "2015", or "2015/16" for a season. */
export const periodLabel = (y, season) => (season ? `${y}/${String((y + 1) % 100).padStart(2, "0")}` : String(y));

/** Yearly (or seasonal) means. Only whole years count: a partial year would bias the trend towards its season. */
export function yearSeries(months, season = null) {
  const by = new Map(), n = periodMonths(season);
  for (const r of months) {
    const y = periodOf(r.y, r.m, season);
    if (y === null) continue;
    if (!by.has(y)) by.set(y, []);
    if (fin(r.v)) by.get(y).push(r.v);
  }
  return [...by].map(([y, v]) => ({ y, v: v.length === n ? v.reduce((a, b) => a + b, 0) / n : null, peak: v.length === n ? Math.max(...v) : null, months: v.length }));
}

/** High-risk days per year (or season), summed from the monthly counts. One missing a month has no total: it would read too low. */
export function highDaySeries(cube, firstMonth, cells, season = null) {
  const [y0, m0] = firstMonth.split("-").map(Number), by = new Map();
  for (let f = 0; f < cube.frames; f++) {
    const k = m0 - 1 + f, y = periodOf(y0 + Math.floor(k / 12), (k % 12) + 1, season);
    if (y === null) continue;
    const r = cellsMean(cube.frame(f), cells, decodeCount);
    const rec = by.get(y) ?? { sum: 0, n: 0 };
    if (r) { rec.sum += r.mean; rec.n += 1; }
    by.set(y, rec);
  }
  return [...by].map(([y, r]) => ({ y, v: r.n === periodMonths(season) ? r.sum : null }));
}

/** Hazards whose score stands for a chance (js/meaning.js): their area level is the mean chance, not the mean score. Fire and
 * dust are ratios in powers of 4, dzud the same on the odds. See cellsLevel in js/stats.js. */
export const chanceScale = (hazard) => (hazard === "fire" || hazard === "dust" ? "lift" : hazard === "dzud" ? { odds: SCORE_MODEL.dzud.base } : null);

/** Level of the area on one day with its combined uncertainty (JCGM 100). `scale`: see cellsLevel in js/stats.js.
 * `mean` is the level shown and classed; `meanScore` is the plain mean of the cell scores. */
export function dayReport({ frame, uframe, cells, grid, classes, uModel, scale = null }) {
  const m = cellsLevel(frame, cells, decode, scale);
  if (!m) return null;
  const rho = spatialLag1(frame, cells, decode, grid.nx);
  const uSampling = samplingUncertainty(m.sd, m.neff, rho);
  const uInput = uframe ? cellsMean(uframe, cells, decode)?.mean ?? null : null;
  const budget = combineUncertainty({ input: uInput, model: uModel ?? null, sampling: uSampling });
  let max = -Infinity, total = 0;
  const share = classes.map(() => 0);
  for (const { i, w } of cells) {
    const v = decode(frame[i]);
    if (v === null) continue;
    if (v > max) max = v;
    total += w;
    share[classes.findIndex((c) => v < c.max)] += w;
  }
  return { mean: m.mean, meanScore: m.meanScore, sd: m.sd, max, coverage: m.coverage, budget, share: share.map((s) => s / total), area: validAreaKm2(cells, frame, grid) };
}

/** Long-term block: trend, high-risk days and return levels of the highest monthly mean of each year. */
export function longReport({ months, high, season = null }) {
  const years = yearSeries(months, season), whole = years.filter((r) => fin(r.v));
  const trend = trendReport(years.map((r) => r.y), years.map((r) => r.v));
  const days = high.filter((r) => fin(r.v)).map((r) => r.v);
  const peaks = whole.map((r) => r.peak);
  const fit = gumbelFit(peaks);
  const mean = (a) => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : null);
  const worst = high.reduce((b, r) => (fin(r.v) && (!b || r.v > b.v) ? r : b), null);
  return {
    years, trend, high,
    highMean: mean(days), highWorst: worst,
    rl: fit ? { t5: Math.min(100, returnLevel(fit, 5)), t20: Math.min(100, returnLevel(fit, 20)), n: fit.n } : null, // the score ends at 100, the Gumbel curve does not
  };
}
