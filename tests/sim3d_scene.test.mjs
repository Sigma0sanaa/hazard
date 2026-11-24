/* Plain parts of the 3D picture (js/sim3d/scene.js): the round values of the latitude and longitude labels on the
 * four sides, and the exaggeration chosen for flat ground. */
import { autoExaggeration, ticks } from "../js/sim3d/scene.js";

export function check() {
  const out = [];
  const yes = (name, cond) => out.push({ name, got: cond, want: true, ok: cond === true });
  const a = ticks(106.31, 106.68);
  yes("ticks: 0.1° steps across 0.37°", a.step === 0.1 && a.digits === 1 && a.values.join() === "106.4,106.5,106.6");
  const b = ticks(46.9, 47.2);
  yes("ticks: ends included when round", b.values[0] === 46.9 && b.values.at(-1) === 47.2);
  const c = ticks(100, 100.1);
  yes("ticks: 0.025° steps need three decimals", c.step === 0.025 && c.digits === 3 && c.values.length === 5);
  yes("ticks: values inside the range", ticks(91.23, 91.87).values.every((v) => v >= 91.23 && v <= 91.87));
  yes("ticks: nothing for an empty range", ticks(5, 5).values.length === 0);
  yes("exaggeration: flat Gobi (80 m over 33 km) raised ×10", autoExaggeration(80, 33000) === 10);
  yes("exaggeration: hills (400 m over 33 km) ×5", autoExaggeration(400, 33000) === 5);
  yes("exaggeration: mountains (1500 m over 33 km) at true height", autoExaggeration(1500, 33000) === 1);
  yes("exaggeration: no relief at all still a choice", autoExaggeration(0, 33000) === 10);
  return out;
}

if (typeof process !== "undefined" && process.versions?.node) {
  const { default: test } = await import("node:test");
  const { default: assert } = await import("node:assert/strict");
  test("3D picture: graticule labels and exaggeration", () => assert.deepEqual(check().filter((r) => !r.ok), []));
}
