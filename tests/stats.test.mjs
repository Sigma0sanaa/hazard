/* js/stats.js against independent scipy values (tests/stats_reference.json, seeded AR(1) data).
 * `check()` is plain JavaScript so the same assertions also run in a browser where Node is not installed. */
import * as S from "../js/stats.js";

export function check(ref) {
  const out = [];
  const near = (name, got, want, tol = 1e-8) => out.push({ name, got, want, ok: typeof got === "number" && Math.abs(got - want) <= tol });
  const yes = (name, cond) => out.push({ name, got: cond, want: true, ok: cond === true });

  const fit = S.ols(ref.years, ref.y);
  near("OLS slope", fit.slope, ref.slope);
  near("OLS intercept", fit.intercept, ref.intercept, 1e-6);
  near("OLS standard error", fit.se, ref.se);
  near("OLS p", fit.p, ref.p);

  const adj = S.adjustedTrend(fit);
  near("lag-1 r1", adj.r1, ref.r1);
  near("effective n", adj.ne, ref.ne);
  near("adjusted se", adj.se, ref.se_adj);
  near("adjusted p", adj.p, ref.p_adj);
  near("adjusted CI low", adj.ci[0], ref.ci[0], 1e-7);
  near("adjusted CI high", adj.ci[1], ref.ci[1], 1e-7);

  const ar = S.olsAr1(ref.years, ref.y);
  near("Cochrane-Orcutt slope", ar.slope, ref.co_slope, 1e-6);
  near("Cochrane-Orcutt p", ar.p, ref.co_p, 1e-6);
  near("Cochrane-Orcutt phi", ar.phi, ref.co_phi, 1e-6);

  const mk = S.mannKendall(ref.y);
  near("Mann-Kendall S", mk.S, ref.mk_S);
  near("Mann-Kendall Z", mk.Z, ref.mk_Z);
  near("Mann-Kendall p", mk.p, ref.mk_p);
  near("Theil-Sen slope", S.senSlope(ref.years, ref.y), ref.sen);

  const rep = S.trendReport(ref.years, ref.y);
  near("sigma N", rep.sigmaN, ref.sigmaN);
  // ref.nstar is the published monthly form. The report works on one value a year, where the time axis has 12 times
  // less leverage: the noise term carries sqrt(12), so n* is 12^(1/3) times longer (Weatherhead et al. 1998, eq. 2, 3).
  near("years to detect, monthly form", S.yearsToDetect(rep.slope, rep.sigmaN, rep.phi), ref.nstar, 1e-7);
  near("years to detect, yearly values", rep.nStar, ref.nstar * 12 ** (1 / 3), 1e-6);
  // The smallest detectable trend of yearly values is 3.3 standard errors of the OLS slope (no autocorrelation):
  // se = sigma sqrt(12 / (n (n^2 - 1))), which sqrt(12) sigma / n^1.5 approaches. Before the fix it was below one se.
  {
    const n = 25, sigma = 2, se = sigma * Math.sqrt(12 / (n * (n * n - 1)));
    near("detectable trend of yearly values is 3.3 se", S.minDetectable(n, sigma, 0, 3.3, 1) / (3.3 * se), 1, 0.002);
    near("monthly values keep the published form", S.minDetectable(n, sigma, 0), 3.3 * sigma / n ** 1.5, 1e-12);
    yes("the detectable trend is not smaller than the 95 % interval half-width", rep.detectableDecade > (rep.ciDecade[1] - rep.ciDecade[0]) / 2);
  }
  for (const [t, df, p] of ref.t_p_checks) near(`t p(${t}, ${df})`, S.tPValue(t, df), p);
  for (const [df, q] of ref.tcrit_checks) near(`t crit(${df})`, S.tCrit(0.05, df), q, 1e-7);
  for (const [z, p] of ref.norm_checks) near(`normal p(${z})`, S.normPValue(z), p);

  // Weatherhead et al. (2000): doubling noise raises n* by 2^(2/3); autocorrelation only ever raises it.
  near("n* scales with noise", S.yearsToDetect(1, 4, 0) / S.yearsToDetect(1, 2, 0), 2 ** (2 / 3));
  yes("autocorrelation raises n*", S.yearsToDetect(1, 2, 0.5) > S.yearsToDetect(1, 2, 0));
  // n* and the smallest detectable trend are inverses of one another.
  near("detectable trend is the inverse of n*", S.yearsToDetect(S.minDetectable(25, 3, 0.2), 3, 0.2), 25, 1e-9);

  // GUM: 3-4-5, k = 2, and a missing part is reported instead of being treated as zero.
  const u = S.combineUncertainty({ input: 3, model: 4, sampling: null });
  near("combined u", u.uc, 5);
  near("expanded U", u.U, 10);
  yes("missing part is reported", u.missing.length === 1 && u.missing[0] === "sampling");
  yes("no parts gives null", S.combineUncertainty({ a: null }) === null);

  // Grid geometry: full cells get cos(lat); a half-covered cell gets half.
  const grid = { west: 100, north: 50, dx: 1, dy: 1, nx: 4, ny: 4 };
  const full = S.boxCells(grid, { w: 101, e: 102, s: 47, n: 48 });
  yes("one full cell", full.length === 1);
  near("cos-lat weight", full[0].w, Math.cos(47.5 * Math.PI / 180));
  near("half cell", S.boxCells(grid, { w: 101, e: 101.5, s: 47, n: 48 })[0].w, Math.cos(47.5 * Math.PI / 180) / 2);
  yes("box outside the grid has no cells", S.boxCells(grid, { w: 10, e: 20, s: 0, n: 5 }).length === 0);

  // Weighted mean skips missing values and reports coverage.
  const dec = (v) => (v === 255 ? null : v);
  const m = S.cellsMean(Uint8Array.from([10, 255, 30]), [{ i: 0, w: 1 }, { i: 1, w: 1 }, { i: 2, w: 1 }], dec);
  near("mean skips missing", m.mean, 20);
  near("coverage", m.coverage, 2 / 3);
  yes("all missing gives null", S.cellsMean(Uint8Array.from([255]), [{ i: 0, w: 1 }], dec) === null);

  // Area level on the ratio scale (fire, dust): 20 points are 4 times the chance, so one cell at 80 (16 times) and
  // three at 40 (1 time) average (16 + 3) / 4 = 4.75 times = 62.5 points, not the mean score of 50 (2 times).
  const four = [0, 1, 2, 3].map((i) => ({ i, w: 1 })), frame = Uint8Array.from([80, 40, 40, 40]);
  near("ratio of a score", S.scoreToRatio(60), 4, 1e-12);
  near("score of a ratio", S.ratioToScore(16), 80, 1e-9);
  near("linear scale keeps the mean score", S.cellsLevel(frame, four, dec).mean, 50);
  const lvl = S.cellsLevel(frame, four, dec, true);
  near("ratio scale takes the mean chance", lvl.mean, 20 * (Math.log(4.75) / Math.log(4) + 2), 1e-9);
  near("the plain mean is kept beside it", lvl.meanScore, 50);
  yes("the mean chance is never below the mean score", lvl.mean >= lvl.meanScore);
  near("equal cells give the same level on both scales", S.cellsLevel(Uint8Array.from([55, 55]), four.slice(0, 2), dec, true).mean, 55, 1e-9);
  yes("ratio scale: all missing gives null", S.cellsLevel(Uint8Array.from([255]), [{ i: 0, w: 1 }], dec, true) === null);

  // Too little data never yields a number.
  yes("short series gives null", S.trendReport([2001, 2002, 2003], [1, 2, 3]) === null);
  const gaps = S.trendReport(ref.years, ref.y.map((v, i) => (i % 5 === 0 ? null : v)));
  yes("gaps are skipped", gaps.n === 20);
  return out;
}

if (typeof process !== "undefined" && process.versions?.node) {
  const { default: test } = await import("node:test");
  const { default: assert } = await import("node:assert/strict");
  const { readFileSync } = await import("node:fs");
  const ref = JSON.parse(readFileSync(new URL("./stats_reference.json", import.meta.url), "utf8"));
  test("stats match scipy and the published formulas", () => {
    const bad = check(ref).filter((r) => !r.ok);
    assert.deepEqual(bad, []);
  });
}
