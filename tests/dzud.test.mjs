/* Dzud on the page: the odds scale, winters in the long-term block, the files, the season, what the score is made of.
 * check() is plain JavaScript so it also runs in a browser where Node is not installed. */
import { cellsLevel, oddsChance, oddsScore } from "../js/stats.js";
import { chanceScale, highDaySeries, longReport, periodLabel, yearSeries } from "../js/area.js";
import { SCORE_MODEL, meaning } from "../js/meaning.js";
import { DZUD_WEIGHTS, dzudFields, dzudParts, inSeason, undelta, winterOf } from "../js/dzud.js";
import { U } from "../js/ui_text.js";

const dec = (v) => (v === 255 ? null : v * 0.4);

export function check() {
  const out = [];
  const yes = (name, cond) => out.push({ name, got: cond, want: true, ok: cond === true });
  const near = (name, got, want, tol) => out.push({ name, got, want, ok: Math.abs(got - want) <= tol });
  const base = 0.124;

  // the scale: powers of 4 of the odds
  near("40 is the usual winter", oddsChance(40, base), base, 1e-9);
  near("80 is 16 times the odds", oddsChance(80, base), 0.6937, 5e-4);
  near("score and chance turn into each other", oddsScore(oddsChance(57, base), base), 57, 1e-9);
  near("a rare event scores as fire and dust do", oddsScore(0.0004, 0.0001), 60, 0.02);
  yes("the scale of each hazard", chanceScale("fire") === "lift" && chanceScale("dust") === "lift" && chanceScale("flood") === null && chanceScale("dzud").odds === SCORE_MODEL.dzud.base);
  const frame = Uint8Array.from([50, 100, 200, 255]), cells = [0, 1, 2, 3].map((i) => ({ i, w: 1 }));
  const meanP = [20, 40, 80].reduce((a, s) => a + oddsChance(s, base), 0) / 3;
  near("the level of an area is the mean chance", oddsChance(cellsLevel(frame, cells, dec, { odds: base }).mean, base), meanP, 1e-9);
  near("a uniform area keeps its score", cellsLevel(Uint8Array.from([100, 100]), cells.slice(0, 2), dec, { odds: base }).mean, 40, 1e-9);
  near("the old switch of fire and dust still works", cellsLevel(frame, cells, dec, true).mean, cellsLevel(frame, cells, dec, "lift").mean, 1e-12);

  // words
  const m = meaning("dzud", 45, 10, 1);
  yes("dzud speaks in chances", m.kind === "odds" && m.p > 0.12 && m.p < 0.25 && !m.beyond && m.ratio > 1);
  yes("no chance is said beyond what the check held", meaning("dzud", 75, 5, 1).beyond === true && meaning("dzud", 100, 30, 1).p <= SCORE_MODEL.dzud.trust);
  yes("the range ends at the same limit", meaning("dzud", 50, 40, 1).pHi <= SCORE_MODEL.dzud.trust && meaning("dzud", 50, 40, 1).hiBeyond === true);
  yes("November is early, January is not", meaning("dzud", 50, 10, 11).early === true && meaning("dzud", 50, 10, 1).early === false);
  yes("summer is off season", meaning("dzud", 50, 10, 7).offSeason === true && meaning("dzud", 50, 10, 3).offSeason === false);
  yes("fire and dust are as before", meaning("fire", 60, 10, 7).kind === "lift" && meaning("dust", 50, 10, 11).offSeason === true);

  // winters
  const S = [11, 3], mo = [];
  for (let y = 2019; y <= 2021; y++) for (let k = 1; k <= 12; k++) mo.push({ y, m: k, v: (k >= 11 || k <= 3) && !(y === 2021 && k > 11) && !(y === 2019 && k <= 3) ? 10 * (k >= 11 ? k - 10 : k + 2) : null });
  const ys = yearSeries(mo, S), at = (y) => ys.find((r) => r.y === y);
  near("a whole winter is the mean of its five months", at(2020).v, 30, 1e-9);
  near("its peak is the highest month", at(2020).peak, 50, 1e-9);
  yes("a winter under way has no value", at(2021).v === null && at(2021).months === 1);
  yes("a winter without its autumn has none", !at(2018) || at(2018).v === null);
  yes("without a season nothing changes", yearSeries(Array.from({ length: 12 }, (_, k) => ({ y: 2020, m: k + 1, v: 6 })))[0].v === 6);
  const cube = { frames: 36, frame: (f) => { const k = (f % 12) + 1, y = 2019 + Math.floor(f / 12); return Uint8Array.from([(k >= 11 || k <= 3) && !(y === 2019 && k <= 3) ? k : 255]); } };
  const hd = highDaySeries(cube, "2019-01", [{ i: 0, w: 1 }], S);
  near("high days of a winter", hd.find((r) => r.y === 2019).v, 11 + 12 + 1 + 2 + 3, 1e-9);
  yes("not of one under way", hd.find((r) => r.y === 2021).v === null);
  yes("the long report counts winters", longReport({ months: mo, high: hd, season: S }).years.filter((r) => r.v !== null).length === 2);
  yes("a winter is named by both years", periodLabel(2015, S) === "2015/16" && periodLabel(1999, S) === "1999/00" && periodLabel(2015, null) === "2015");

  // season and files
  yes("season", inSeason("2027-03-31", S) && inSeason("2026-11-01", S) && !inSeason("2026-10-31", S) && !inSeason("2027-04-01", S));
  yes("winter of a day", winterOf("2027-02-01") === 2026 && winterOf("2026-12-31") === 2026);
  const days = [[250, 255, 3], [10, 255, 0], [255, 7, 255]];
  const stored = Uint8Array.from(days.flatMap((d, i) => d.map((v, j) => (i ? v - days[i - 1][j] : v) & 255)));
  yes("days are added up again, modulo 256", days.every((d, i) => String([...undelta(stored, 3, i)]) === String(d)));
  yes("only the day asked for is needed", undelta(stored, 3, 1).length === 3);

  // what the score is made of
  const z = (v) => Math.round((v + 3) / 6 * 240);
  const day = { z_snow: Uint8Array.from([z(2), z(2), 255]), z_cold: Uint8Array.from([z(1), z(0), 255]), z_press: Uint8Array.from([z(-1), z(-1), 255]), z_summer: Uint8Array.from([z(0.5), z(0.5), 255]) };
  const parts = dzudParts([0, 1, 2].map((i) => ({ i, w: 1 })), day);
  const total = parts.reduce((a, p) => a + p.part, 0), w = DZUD_WEIGHTS, sum = w.snow + w.cold + w.press + w.summer;
  near("the parts add up to the index", total, (w.snow * 2 + w.cold * 0.5 - w.press + w.summer * 0.5) / sum, 0.01);
  yes("the strongest part comes first", parts[0].key === "snow" && parts[parts.length - 1].key === "press" && parts[parts.length - 1].part < 0);
  yes("no data gives no parts", dzudParts([{ i: 2, w: 1 }], day) === null && dzudParts([], day) === null);
  const f = dzudFields(75, [{ i: 0, w: 1 }], day);
  yes("a file never holds a chance the check did not reach", f.p_loss6 === SCORE_MODEL.dzud.trust && f.p_capped === "Y" && dzudFields(40, [{ i: 0, w: 1 }], day).p_capped === "N");
  yes("field names fit a shapefile", Object.keys(f).every((k) => k.length <= 10) && Object.keys(f).join() === "p_loss6,p_capped,z_snow,z_cold,z_press,z_summer");
  near("a z-score comes back", f.z_snow, 2, 0.02);

  // both languages say everything
  for (const l of ["mn", "en"]) for (const k of ["dzud", "verdict_dzud", "say_dzud", "say_dzud_beyond", "early_dzud", "dz_off_season", "dz_why", "dz_snow", "dz_cold", "dz_press", "dz_summer", "help_odds", "v_plain_dzud", "t_winter", "partial_winter"]) {
    yes(`${l} has ${k}`, typeof U[l][k] === "string" && U[l][k].length > 0);
  }
  for (const l of ["mn", "en"]) yes(`${l} sentence has its blanks`, ["{p}", "{base}", "{dir}"].every((b) => U[l].say_dzud.includes(b)) && U[l].say_dzud_beyond.includes("{p}"));
  return out;
}

if (typeof process !== "undefined" && process.versions?.node) {
  const { default: test } = await import("node:test");
  const { default: assert } = await import("node:assert/strict");
  const { readFileSync } = await import("node:fs");
  test("dzud on the page", () => assert.deepEqual(check().filter((r) => !r.ok), []));
  test("the page and the pipeline hold the same base and weights", () => {
    const m = JSON.parse(readFileSync(new URL("../pipeline/model.json", import.meta.url), "utf8")).dzud;
    assert.ok(Math.abs(m.base - SCORE_MODEL.dzud.base) < 5e-5);
    assert.deepEqual(m.weights, DZUD_WEIGHTS);
  });
}
