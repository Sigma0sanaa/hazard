/* What a score means in words. For an area the score passed in is the score of the mean chance ratio of its cells
 * (cellsLevel in js/stats.js), so the words speak of the average chance of a cell of the area. Fire and dust scores are powers of 4 of the lift of a fitted probability over its
 * national average (pipeline/calibrate.py: score = 20 * (log4(p / base) + 2)), so a score can be read back as "how
 * many times the usual chance". The flood score maps the return period of three days of rain and snowmelt
 * (1, 2, 5, 20, 100 years to 0, 40, 60, 80, 100; pipeline/scores.py), lowered away from drainage lines. The dzud score is
 * the powers of 4 on the odds that a soum loses 6 % or more of its adult livestock (pipeline/dzud.py). */
import { oddsChance } from "./stats.js";

/** Average daily chance of the event per 0.1° cell in the data the model was fitted to (pipeline/model.json "base"). */
export const SCORE_MODEL = {
  // MODIS active fire in the cell that day, all months. `seen` is what the years the model had not seen held:
  // 3284 fire cell-days / (18,467 cells x 2,922 days of 2018-2025), pipeline/model.json. Fires were 2.9 times rarer
  // than the 2001-2025 base, so a ratio to "the average" is a ratio to the usual day of recent years, and reads
  // about 3 times high against the 2001-2025 average. Refit with a time term to remove it (docs/HANDOFF.md, 3.1).
  fire: { base: 0.0001784, event: "fire", seen: { period: "2018–2025", rate: 0.0000609 } },
  dust: { base: 0.02235, event: "dust", months: [3, 4, 5] }, // TROPOMI aerosol index anomaly >= 1, fitted on March-May
  // Soum-winters of 2011/12-2024/25 with adult losses of 6 % or more. On winters left out of the fit, scores of 60 and over
  // said 43-73 % and 24-30 % happened (docs/DZUD_CHECK.md), so no chance above `trust` is said.
  dzud: { base: 0.1239, event: "dzud", trust: 0.3, said: "24–30%", season: [11, 3], early: 11 },
};

/** How many times the fitted base rate stands above what the unseen years held, or null where that is not known. */
export const drift = (hazard) => { const m = SCORE_MODEL[hazard]; return m?.seen ? m.base / m.seen.rate : null; };

const clamp = (s) => Math.min(100, Math.max(0, s));
/** The scale ends at 0 and 100 (stored in steps of 0.4), so a score at an end only bounds the chance: at 0 it is 1/16 of the
 * average or less (snow-covered ground is set to 0), at 100 it is 256 times or more. */
export const atFloor = (score) => score <= 0.2;
export const atCeiling = (score) => score >= 99.8;
/** The return levels are fitted to the annual maxima of 2001-2025. A return period far beyond the record is an
 * extrapolation, so the words stop at twice its length. */
export const FLOOD_RECORD_YEARS = 25;
export const FLOOD_TRUST_YEARS = 2 * FLOOD_RECORD_YEARS;
/** How many times the usual chance a score stands for. */
export const lift = (score) => 4 ** (clamp(score) / 20 - 2);

const FLOOD_T = [1.01, 2, 5, 20, 100], FLOOD_S = [0, 40, 60, 80, 100];
/** Return period in years that a flood score stands for near a drainage line (log-linear between the steps). */
export function floodYears(score) {
  const s = clamp(score);
  for (let i = 1; i < FLOOD_S.length; i++) if (s <= FLOOD_S[i]) {
    const f = (s - FLOOD_S[i - 1]) / (FLOOD_S[i] - FLOOD_S[i - 1]);
    return 10 ** (Math.log10(FLOOD_T[i - 1]) + f * (Math.log10(FLOOD_T[i]) - Math.log10(FLOOD_T[i - 1])));
  }
  return 100;
}

/** Everything the summary needs: { kind, ratio, p, pLo, pHi, years, yearsLo, yearsHi, offSeason }. U is the 95 % error. */
export function meaning(hazard, score, U, month) {
  const lo = clamp(score - (U ?? 0)), hi = clamp(score + (U ?? 0));
  const m = SCORE_MODEL[hazard];
  if (hazard === "dzud") {
    const p = oddsChance(clamp(score), m.base), pHi = oddsChance(hi, m.base), cap = (v) => Math.min(v, m.trust);
    return { kind: "odds", p: cap(p), beyond: p > m.trust, pLo: cap(oddsChance(lo, m.base)), pHi: cap(pHi), hiBeyond: pHi > m.trust, ratio: p / m.base,
      floor: atFloor(score), early: month === m.early, offSeason: Boolean(month) && month > m.season[1] && month < m.season[0] };
  }
  if (m) {
    return { kind: "lift", ratio: lift(score), ratioLo: lift(lo), ratioHi: lift(hi), p: m.base * lift(score), pLo: m.base * lift(lo), pHi: Math.min(1, m.base * lift(hi)),
      floor: atFloor(score), ceiling: atCeiling(score), floorLo: atFloor(lo), ceilingHi: atCeiling(hi),
      offSeason: Boolean(m.months && month && !m.months.includes(month)) };
  }
  if (hazard === "flood") return { kind: "flood", years: floodYears(score), yearsLo: floodYears(lo), yearsHi: floodYears(hi), beyond: floodYears(score) > FLOOD_TRUST_YEARS, offSeason: false };
  return { kind: "all", offSeason: false };
}

/** A share as people say it: 5 %, 0.7 %, 0.02 %. */
export function percent(p) {
  const v = p * 100;
  if (v >= 10) return `${Math.round(v)}%`;
  if (v >= 1) return `${v.toFixed(1).replace(/\.0$/, "")}%`;
  return `${Number(v.toPrecision(1))}%`;
}

/** A ratio as people say it: 2.1, 0.3, 15. */
export const times = (r) => (r >= 10 ? String(Math.round(r)) : r >= 1 ? r.toFixed(1).replace(/\.0$/, "") : r.toFixed(2).replace(/0$/, ""));
