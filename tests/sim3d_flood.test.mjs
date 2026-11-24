/* The 3D flood run (js/sim3d/flood_sim.js): curve number runoff by hand, water at rest stays at rest, mass is kept,
 * and steady flow down a slope matches Manning's normal depth. */
import { CN, FLOOD3D, MANNING, byteDepth, depthByte, makeState, runoffRates, scsRunoff, stableDt, step, volume, waterInput, waveSpeed } from "../js/sim3d/flood_sim.js";

export function check() {
  const out = [];
  const yes = (name, cond) => out.push({ name, got: cond, want: true, ok: cond === true });
  const near = (name, got, want, tol) => out.push({ name, got, want, ok: Math.abs(got - want) <= tol });

  // TR-55: 100 mm on CN 79 -> S = 67.52 mm, Ia = 13.50 mm, Q = 86.50^2 / 154.02 = 48.58 mm
  near("SCS runoff, 100 mm on CN 79", scsRunoff(100, 79), 48.58, 0.01);
  yes("no runoff below the initial abstraction", scsRunoff(13, 79) === 0);
  near("water (CN 100) gives everything", scsRunoff(30, 100), 30, 1e-12);
  yes("grassland, forest, bare and built-up are in the table", CN[30] === 79 && CN[10] === 73 && CN[60] === 91 && CN[50] === 98);
  near("melt of 10 cm of snow at density 0.3 is 30 mm", waterInput(0, 0.30, 0.20, 2), 30, 1e-9);
  yes("no melt below 0 °C", waterInput(1, 0.3, 0.2, -1) === 1);
  // hourly runoff rates add up to the cumulative runoff
  const g1 = { w: 1, h: 1 }, plan = { cw: 1, ch: 1 };
  const rate = runoffRates(g1, new Uint8Array([30]), plan, [new Float32Array([40]), new Float32Array([60])]);
  const r0 = rate(0)[0], r1 = rate(1)[0];
  near("two hours of runoff add up to Q(100 mm)", (r0 + r1) * 3600 * 1000, scsRunoff(100, 79), 1e-3);
  near("depth bytes round trip within 2.5 %", byteDepth(depthByte(1.234)) / 1.234, 1, 0.025);
  yes("dry below 1 cm", depthByte(0.009) === 0);

  // a lake at rest over an uneven bed: nothing moves (the scheme is well balanced)
  {
    const w = 20, h = 20, z = new Float32Array(w * h), n = new Float32Array(w * h).fill(0.035);
    for (let i = 0; i < w * h; i++) z[i] = 100 + 50 * Math.sin(i * 0.7) * 0.01 + ((i % w === 0 || i % w === w - 1 || i < w || i >= w * (h - 1)) ? 10 : 0);
    const st = makeState(w, h);
    for (let i = 0; i < w * h; i++) st.d[i] = Math.max(0, 101 - z[i]);
    const src = new Float32Array(w * h);
    for (let k = 0; k < 200; k++) step(st, z, n, src, 30, 30, stableDt(Math.sqrt(9.81 * 2), 30, 30));
    let dev = 0; for (let i = 0; i < w * h; i++) if (st.d[i] > 0) dev = Math.max(dev, Math.abs(z[i] + st.d[i] - 101));
    near("lake at rest: level stays at 101 m", dev, 0, 1e-4);
  }

  // rain on a bowl with walls: all the water stays, volume = rain
  {
    const w = 30, h = 30, z = new Float32Array(w * h), n = new Float32Array(w * h).fill(0.035);
    for (let r = 0; r < h; r++) for (let c = 0; c < w; c++) z[r * w + c] = 0.01 * ((r - 15) ** 2 + (c - 15) ** 2) + ((r === 0 || c === 0 || r === h - 1 || c === w - 1) ? 50 : 0);
    const st = makeState(w, h), src = new Float32Array(w * h).fill(20 / 1000 / 3600); // 20 mm/h
    let t = 0;
    while (t < 3600) { const dt = Math.min(stableDt(waveSpeed(st), 30, 30), 3600 - t); step(st, z, n, src, 30, 30, dt); t += dt; }
    // the rain on the wall tops runs off over the outer edge; everything else stays in the bowl
    near("bowl: rain in = water left + water out (mass kept within 0.1 %)", (volume(st, 30, 30) + st.out - st.clipped) / st.rainIn, 1, 1e-3);
    yes("bowl: the water gathered in the middle", st.d[15 * w + 15] > 0.02 * 3);
  }

  // steady rain down a 1 % slope 6 km long: what falls leaves, and the depth near the foot is Manning's normal depth
  {
    const w = 3, h = 200, dy = 30, S = 0.01, z = new Float32Array(w * h), n = new Float32Array(w * h).fill(0.035);
    // a channel one cell wide between walls; rain falls on the channel only
    for (let r = 0; r < h; r++) for (let c = 0; c < w; c++) z[r * w + c] = 100 - S * r * dy + (c === 1 ? 0 : 20);
    const st = makeState(w, h), rain = 50 / 1000 / 3600, src = new Float32Array(w * h);
    for (let r = 0; r < h; r++) src[r * w + 1] = rain;
    while (st.time < 12 * 3600) step(st, z, n, src, 30, dy, stableDt(waveSpeed(st), 30, dy));
    // out over the last steps equals rain on the area
    const before = st.out, t0 = st.time;
    for (let k = 0; k < 200; k++) step(st, z, n, src, 30, dy, stableDt(waveSpeed(st), 30, dy));
    near("slope: steady outflow equals rain", (st.out - before) / (st.time - t0) / (rain * h * 30 * dy), 1, 0.02);
    const r = 180, q = rain * (r + 1) * dy, hn = Math.pow(q * 0.035 / Math.sqrt(S), 3 / 5);
    near("slope: depth at 5.4 km is Manning's normal depth (within 5 %)", st.d[r * w + 1] / hn, 1, 0.05);
    near("mass: rain in = water out + water left", (st.out + volume(st, 30, dy) - st.clipped) / st.rainIn, 1, 1e-3);
    near("hardly any depth clipped at 0", st.clipped / st.rainIn, 0, 1e-3);
  }
  yes("Manning's n: forest rougher than grass", MANNING[10] > MANNING[30]);
  near("stable step for still water 1 m deep on 30 m cells", stableDt(Math.sqrt(9.81), 30, 30), FLOOD3D.alpha * 30 / Math.sqrt(9.81), 1e-9);
  return out;
}

if (typeof process !== "undefined" && process.versions?.node) {
  const { default: test } = await import("node:test");
  const { default: assert } = await import("node:assert/strict");
  test("3D flood run", () => assert.deepEqual(check().filter((r) => !r.ok), []));
}
