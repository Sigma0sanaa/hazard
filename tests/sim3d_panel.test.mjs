/* Plain parts of the 3D window (js/sim3d/panel.js, recorder.js): the clock text, the coarser ground for the processor
 * run, and the choice of video format. */
import { clockText, coarsen } from "../js/sim3d/panel.js";
import { pickFormat } from "../js/sim3d/recorder.js";

export function check() {
  const out = [];
  const yes = (name, cond) => out.push({ name, got: cond, want: true, ok: cond === true });
  yes("clock: 26 hours after midnight is the next day 02:00", clockText("2024-05-10", 26 * 60) === "2024-05-11 02:00");
  yes("clock: minutes rounded", clockText("2024-05-10", 90.4) === "2024-05-10 01:30");
  const g = { west: 100, north: 50, dx: 0.001, dy: 0.001, w: 10, h: 6, scale: 30, lat0: 49.997 };
  const z = Float32Array.from({ length: 60 }, (_, i) => i), cover = new Uint8Array(60).fill(30);
  const c = coarsen(g, z, cover, 5);
  yes("coarsen: factor 2 for 10 cells into 5", c.f === 2 && c.g.w === 5 && c.g.h === 3 && c.g.scale === 60);
  yes("coarsen: block mean of the DEM", c.z[0] === (0 + 1 + 10 + 11) / 4);
  yes("coarsen: nothing to do when small", coarsen(g, z, cover, 64).f === 1);
  yes("video: MP4 first", pickFormat(() => true).ext === "mp4");
  yes("video: WebM when MP4 cannot be recorded", pickFormat((t) => t.startsWith("video/webm")).ext === "webm");
  yes("video: none when nothing can be recorded", pickFormat(() => false) === null);
  return out;
}

if (typeof process !== "undefined" && process.versions?.node) {
  const { default: test } = await import("node:test");
  const { default: assert } = await import("node:assert/strict");
  test("3D window: clock, coarser ground, video format", () => assert.deepEqual(check().filter((r) => !r.ok), []));
}
