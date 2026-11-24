/* The 3D fire run (js/sim3d/rothermel.js, fire_sim.js, ignition.js): Rothermel against the rates Anderson (1982,
 * INT-GTR-122) prints for 8 % dead and 100 % live moisture at a 5 mi/h midflame wind, and the shape of the spread on
 * flat and sloping ground, worked out by hand. */
import { FUEL, deadMoisture, emc, fuelOf, headFire, lengthToBreadth, noWindNoSlope, phiS, phiW, prepare, rateToward, waf } from "../js/sim3d/rothermel.js";
import { burnedKm2, footprint, slopeAspect, spreadFire } from "../js/sim3d/fire_sim.js";
import { hotPixel } from "../js/sim3d/ignition.js";
import { makeGrid } from "../js/aoi/raster.js";
import { cellMetres } from "../js/sim3d/inputs.js";

/** Hourly fields that are the same everywhere: one coarse cell. */
function flatFields(g, { hours = 30, wind = 0, to = 0, temp = 25, rh = 20, rain = 0, snow = 0 } = {}) {
  const one = (v) => Array.from({ length: hours }, () => new Float32Array([v]));
  const u = wind * Math.sin(to * Math.PI / 180), v = wind * Math.cos(to * Math.PI / 180);
  return { plan: { cw: 1, ch: 1, k: 1, g }, hours, u: one(u), v: one(v), temp: one(temp), rh: one(rh), precip: one(rain), rain: one(rain), snowDepth: one(snow) };
}

export function check() {
  const out = [];
  const yes = (name, cond) => out.push({ name, got: cond, want: true, ok: cond === true });
  const near = (name, got, want, tol) => out.push({ name, got, want, ok: Math.abs(got - want) <= tol });

  // Anderson (1982): 78, 35, 104 and 1.6 chains per hour for models 1, 2, 3 and 8
  const chph = (n) => { const p = prepare(n), nw = noWindNoSlope(p, [0.08, 0.09, 0.10], 1.0); return nw.R0 * (1 + phiW(p, 440)) * 60 / 66; };
  for (const [n, want] of [[1, 78], [2, 35], [3, 104], [8, 1.6]]) near(`fuel model ${n} within 10 % of Anderson's ${want} ch/h`, chph(n) / want, 1, 0.10);
  yes("no spread when the dead fuel is at its moisture of extinction", noWindNoSlope(prepare(1), [0.12, 0.13, 0.14], 1).R0 === 0);
  yes("wetter fuel spreads slower", noWindNoSlope(prepare(1), [0.04, 0.05, 0.06], 1).R0 > noWindNoSlope(prepare(1), [0.09, 0.10, 0.11], 1).R0);
  near("slope factor 5.275 beta^-0.3 tan^2 (model 1, 30 %)", phiS(prepare(1), 0.3), 5.275 * Math.pow(prepare(1).beta, -0.3) * 0.09, 1e-12);
  near("no wind: length-to-breadth 1", lengthToBreadth(0), 1, 1e-9);
  yes("length-to-breadth capped at 8", lengthToBreadth(80) === 8);
  near("unsheltered wind adjustment of 1 ft grass ≈ 0.36", waf(1), 1.83 / Math.log(20.36 / 0.13), 1e-12);
  yes("a canopy shelters more than open grass", waf(1, 0.5, 49) < waf(1));

  // moisture from weather: NFDRS equilibrium moisture, three humidity branches
  near("EMC at 30 °C (86 °F), 20 %", emc(30, 20), 2.22749 + 0.160107 * 20 - 0.01478 * 86, 1e-9);
  near("EMC at 10 °C (50 °F), 60 %", emc(10, 60), 21.0606 + 0.005565 * 3600 - 0.00035 * 60 * 50 - 0.483199 * 60, 1e-9);
  yes("rain wets the fine fuel", deadMoisture(25, 20, 1)[0] === 0.30);

  // head fire: wind and upslope in the same direction add up; the ellipse is fastest at the head
  const p1 = prepare(1), dead = [0.06, 0.07, 0.08];
  const calm = headFire(p1, dead, 0.9, 0, 0, 0, 0, waf(1)), windy = headFire(p1, dead, 0.9, 5, Math.PI / 2, 0, 0, waf(1));
  near("calm flat fire spreads alike every way", rateToward(calm, 1) / calm.ros, 1, 1e-9);
  near("a wind toward the east sends the head east", windy.dir, Math.PI / 2, 1e-9);
  yes("backing fire is slower than the flank, the flank slower than the head", rateToward(windy, -Math.PI / 2) < rateToward(windy, 0) && rateToward(windy, 0) < windy.ros);
  const both = headFire(p1, dead, 0.9, 5, Math.PI / 2, 0.3, Math.PI / 2, waf(1));
  yes("upslope in the wind direction speeds the head", both.ros > windy.ros && Math.abs(both.dir - Math.PI / 2) < 1e-9);

  // land cover to fuel
  yes("grass, forest, shrub burn; bare, water, built-up, snow do not", fuelOf(30) === 1 && fuelOf(10) === 2 && fuelOf(20) === 5 && [60, 80, 50, 70, 0].every((c) => fuelOf(c) === 0));
  yes("every fuel model used is in the table", [10, 20, 30, 40, 90].every((c) => FUEL[fuelOf(c)]));

  // slope and aspect: a plane rising toward the east
  const sa = slopeAspect(Float32Array.from({ length: 25 }, (_, i) => (i % 5) * 3), 5, 5, 30, 30);
  near("slope of a 10 % plane", sa.tan[12], 0.1, 1e-6);
  near("upslope toward the east (90°)", sa.up[12] * 180 / Math.PI, 90, 1e-4);

  // spread on a flat grass plain without wind: a circle of radius R0 * t
  const g = makeGrid({ s: 47, n: 47.03, w: 106, e: 106.044 }, 30), n = g.w * g.h;
  const cover = new Uint8Array(n).fill(30), z = new Float32Array(n);
  const mid = Math.floor(g.h / 2) * g.w + Math.floor(g.w / 2);
  const calmRun = spreadFire({ g, z, cover, fields: flatFields(g), ignition: [mid], month: 9, hours: 1 });
  const hf = headFire(p1, deadMoisture(25, 20, 0), 0.9, 0, 0, 0, 0, waf(1));
  const m = cellMetres(g), r60 = hf.ros * 60, area = burnedKm2(g, calmRun.arrival, 60) * 1e6;
  near("calm: area after 1 h is the circle of the Rothermel rate (16 neighbours, within 8 %)", area / (Math.PI * r60 * r60), 1, 0.08);
  yes("calm: arrival grows with distance", calmRun.arrival[mid + 3] > calmRun.arrival[mid + 1] && calmRun.arrival[mid + 1] > 0);
  // wind toward the east: the fire runs farther east than west
  const windRun = spreadFire({ g, z, cover, fields: flatFields(g, { wind: 6, to: 90 }), ignition: [mid], month: 9, hours: 1 });
  let east = 0, west = 0;
  const r0 = Math.floor(g.h / 2), c0 = Math.floor(g.w / 2);
  for (let c = c0; c < g.w && windRun.arrival[r0 * g.w + c] <= 60; c++) east = c - c0;
  for (let c = c0; c >= 0 && windRun.arrival[r0 * g.w + c] <= 60; c--) west = c0 - c;
  yes("wind: the head runs downwind, the back much less", east > 3 * Math.max(1, west));
  // a strip of bare ground stops the fire
  const strip = new Uint8Array(cover);
  for (let r = 0; r < g.h; r++) for (let c = c0 + 5; c < c0 + 8; c++) strip[r * g.w + c] = 60;
  const stripRun = spreadFire({ g, z, cover: strip, fields: flatFields(g, { wind: 6, to: 90 }), ignition: [mid], month: 9, hours: 3 });
  yes("a bare strip three cells wide stops it (no jumps)", stripRun.arrival[r0 * g.w + c0 + 9] === Infinity);
  // snow on the ground: nothing spreads
  const snowRun = spreadFire({ g, z, cover, fields: flatFields(g, { snow: 0.05 }), ignition: [mid], month: 1, hours: 2 });
  near("snow: only the ignition cell", burnedKm2(g, snowRun.arrival, 120) * 1e6, m.x * m.y, 1);

  // ignition footprints and the hot-pixel rule
  yes("a 375 m footprint covers ≈ 120 cells of 30 m", Math.abs(footprint(g, 47.015, 106.022, 187.5, cover).length - Math.PI * 187.5 ** 2 / (m.x * m.y)) < 15);
  yes("hot pixel: red 0.05, SWIR2 0.6 is fire; red 0.1, SWIR2 0.3 is not", hotPixel(0.05, 0.6) && !hotPixel(0.1, 0.3));
  return out;
}

if (typeof process !== "undefined" && process.versions?.node) {
  const { default: test } = await import("node:test");
  const { default: assert } = await import("node:assert/strict");
  test("3D fire run", () => assert.deepEqual(check().filter((r) => !r.ok), []));
}
