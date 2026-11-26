/* The 3D dust run (js/sim3d/dust_sim.js) and the weather spreading of js/sim3d/inputs.js, on cases worked out by hand. */
import { DUST3D, createDustRun, emissions, quietReasons, rng, thresholdOf, whiteFlux, wetDays } from "../js/sim3d/dust_sim.js";
import { LAND } from "../js/aoi/dust.js";
import { makeGrid } from "../js/aoi/raster.js";
import { fillHoles, grid3d, idwPlan, lattice, spread, weatherPlan, windVector } from "../js/sim3d/inputs.js";

function fields(g, hours, { wind = 12, to = 90, rain = 0, snow = 0, soil = 0.1 } = {}) {
  const one = (v) => Array.from({ length: hours }, () => new Float32Array([v]));
  const time = Array.from({ length: hours }, (_, h) => `2023-04-${String(10 + Math.floor(h / 24)).padStart(2, "0")}T${String(h % 24).padStart(2, "0")}:00`);
  return { plan: { cw: 1, ch: 1, k: 1, g }, hours, time, u: one(wind * Math.sin(to * Math.PI / 180)), v: one(wind * Math.cos(to * Math.PI / 180)), precip: one(rain), snowDepth: one(snow), soil: one(soil) };
}

export function check() {
  const out = [];
  const yes = (name, cond) => out.push({ name, got: cond, want: true, ok: cond === true });
  const near = (name, got, want, tol) => out.push({ name, got, want, ok: Math.abs(got - want) <= tol });

  yes("thresholds: bare 8.9, sparse 9.8, vegetation none", thresholdOf(LAND.bare) === 8.9 && thresholdOf(LAND.sparse) === 9.8 && thresholdOf(LAND.veg) === Infinity);
  near("White flux at u = 2 ut: u^3 * 1.5 * 0.75", whiteFlux(20, 10), 8000 * 1.5 * 0.75, 1e-9);
  yes("no flux at or below the threshold", whiteFlux(8.9, 8.9) === 0 && whiteFlux(5, 8.9) === 0);

  const g = makeGrid({ s: 43, n: 43.02, w: 104, e: 104.03 }, 60), n = g.w * g.h;
  const land = new Uint8Array(n).fill(LAND.bare);
  for (let i = 0; i < n / 2; i++) land[i] = LAND.veg;
  const em = emissions(g, land, fields(g, 6));
  yes("only bare cells emit", em.perHour[0][0] === 0 && em.perHour[0][n - 1] > 0);
  yes("a wet day stops emission", emissions(g, land, fields(g, 6, { rain: 0.1 })).totals.every((v) => v === 0));
  yes("snow stops emission", emissions(g, land, fields(g, 6, { snow: 0.02 })).totals.every((v) => v === 0));
  yes("wet topsoil stops emission", emissions(g, land, fields(g, 6, { soil: 0.3 })).totals.every((v) => v === 0));
  yes("calm wind: nothing", emissions(g, land, fields(g, 6, { wind: 5 })).totals.every((v) => v === 0));
  const wd = wetDays(fields(g, 30, { rain: 0.02 }));
  yes("wet day from the day's sum (24 × 0.02 = 0.48 mm)", wd.has("2023-04-10") && !wd.has("2023-04-11"));

  // why nothing rose: only the reasons that held
  const sparse = new Uint8Array(n).fill(LAND.sparse);
  const calm = quietReasons(g, sparse, fields(g, 72, { wind: 8.3, soil: 0.014 }));
  yes("calm, dry sparse ground: wind 8.3 below 9.8, no wet day, soil or snow named",
    calm.source && calm.threshold === 9.8 && Math.abs(calm.maxWind - 8.3) < 1e-4 && !calm.wetDays.length && calm.soilHours === 0 && calm.snowHours === 0 && calm.blockedWindyHours === 0);
  const blocked = quietReasons(g, sparse, fields(g, 72, { wind: 12, soil: 0.3 }));
  yes("strong wind on wet soil: blocked hours and soil hours, all 72", blocked.blockedWindyHours === 72 && blocked.soilHours === 72);
  const rainy = quietReasons(g, land, fields(g, 48, { wind: 12, rain: 0.1 }));
  yes("rain every hour: both days wet, the bare threshold 8.9 is the lowest", rainy.wetDays.length === 2 && rainy.threshold === 8.9 && rainy.blockedWindyHours === 48);
  yes("vegetation only: no source", quietReasons(g, new Uint8Array(n).fill(LAND.veg), fields(g, 6)).source === false);
  yes("only the first n hours count", quietReasons(g, sparse, fields(g, 72, { wind: 12, soil: 0.3 }), 10).soilHours === 10);

  // particles go downwind (east) and the run repeats exactly; a box of 40 km so they stay in it for a while
  const gb = makeGrid({ s: 43, n: 43.36, w: 104, e: 104.5 }, 500), lb = new Uint8Array(gb.w * gb.h).fill(LAND.bare);
  const f = fields(gb, 6), run = createDustRun(gb, f, emissions(gb, lb, f));
  run.advanceTo(60);
  let sx = 0, k = 0; for (let s = 0; s < run.x.length; s++) if (run.alive[s]) { sx += run.x[s]; k++; }
  yes("particles are released", k > 0 && run.count === k);
  const first = sx / k;
  run.advanceTo(120);
  let sx2 = 0, k2 = 0; for (let s = 0; s < run.x.length; s++) if (run.alive[s]) { sx2 += run.x[s]; k2++; }
  yes("they move east", sx2 / k2 > first || k2 < k);
  run.reset(); run.advanceTo(60);
  let sx3 = 0; for (let s = 0; s < run.x.length; s++) if (run.alive[s]) sx3 += run.x[s];
  near("same seed, same run", sx3, sx, 1e-3);
  yes("the generator stays in [0, 1)", (() => { const r = rng(1); for (let i = 0; i < 1000; i++) { const v = r(); if (v < 0 || v >= 1) return false; } return true; })());
  yes("no more particles than the cap", run.count <= DUST3D.maxParticles);

  // weather spreading
  const wv = windVector(10, 270);
  near("a west wind blows toward the east", wv.u, 10, 1e-9);
  near("…with no north part", wv.v, 0, 1e-9);
  const box = { s: 47, n: 47.2, w: 106, e: 106.3 }, pts = lattice(box);
  yes("16 points inside the box", pts.length === 16 && pts.every((p) => p.lat > 47 && p.lat < 47.2 && p.lon > 106 && p.lon < 106.3));
  const g3 = grid3d(box), plan = idwPlan(g3, pts);
  const flat = spread(plan, pts.map(() => 5));
  yes("weights sum to 1: a constant stays constant", flat.every((v) => Math.abs(v - 5) < 1e-5));
  yes("30 m up to 1024 cells a side, coarser beyond", grid3d({ s: 47, n: 47.2, w: 106, e: 106.3 }).scale === 30 && grid3d({ s: 47, n: 48, w: 106, e: 107 }).scale > 30);
  const holes = fillHoles(Float32Array.from([1, NaN, 3, NaN]), 2, 2);
  yes("DEM holes filled from neighbours", holes.every(Number.isFinite));
  const now = Date.parse("2026-11-24T00:00:00Z");
  yes("recent days from the forecast, old days from ERA5", weatherPlan("2026-11-20", 3, now).source === "forecast" && weatherPlan("2020-05-01", 3, now).source === "era5");
  yes("ERA5 ends about 6 days ago", weatherPlan("2026-07-01", 3, now).source === "era5" && weatherPlan("2026-11-23", 3, now).to === "2026-11-25");
  return out;
}

if (typeof process !== "undefined" && process.versions?.node) {
  const { default: test } = await import("node:test");
  const { default: assert } = await import("node:assert/strict");
  test("3D dust run and weather spreading", () => assert.deepEqual(check().filter((r) => !r.ok), []));
}
