/* Rain and snowmelt over the drawn area, routed over the ground. Two parts:
 *  - Runoff: the SCS curve number method (USDA NRCS TR-55, 1986) on the water that has fallen since the start of the
 *    run, cell by cell; the hourly runoff is the growth of the cumulative runoff. Curve numbers are those of TR-55
 *    Table 2-2 for hydrologic soil group C (no soil map of Mongolia is read; C is a middle, cautious choice) by the
 *    ESA WorldCover class. Snowmelt is the loss of snow depth in an hour above 0 °C times an assumed density of 0.3.
 *  - Routing: the local inertial form of the shallow water equations of Bates, Horritt & Fewtrell (2010, J. Hydrol.
 *    387) with the time step of de Almeida et al. (2012, Water Resour. Res. 48): flow between two cells from the
 *    difference of their water levels, slowed by Manning friction. Water leaves at the edges of the box.
 * This file holds the CPU version, which the tests check; js/sim3d/flood_gpu.js runs the same steps on the graphics
 * card. Depths and rates are in metres and seconds. */

export const FLOOD3D = { hours: 72, alpha: 0.7, g: 9.81, hMin: 1e-4, snowDensity: 0.3, frameMinutes: 60, dryMm: 10 };

/** TR-55 Table 2-2 curve numbers for soil group C by WorldCover class. Brush (fair) 70; woods (fair) 73; pasture,
 * grassland or range (fair) 79; small grain, straight row (good) 83; fallow bare soil 91; impervious 98. Snow and
 * ice, water and herbaceous wetland are taken as saturated (98, 100, 98); moss and lichen as poor range (86). */
export const CN = { 10: 73, 20: 70, 30: 79, 40: 83, 50: 98, 60: 91, 70: 98, 80: 100, 90: 98, 95: 98, 100: 86, 0: 79 };

/** Manning's n by WorldCover class (common values for overland flow: Chow 1959; Kalyanapu et al. 2009). */
export const MANNING = { 10: 0.10, 20: 0.07, 30: 0.035, 40: 0.035, 50: 0.015, 60: 0.025, 70: 0.02, 80: 0.03, 90: 0.05, 95: 0.05, 100: 0.035, 0: 0.035 };

/** Cumulative runoff (mm) of cumulative water input P (mm) for curve number cn, with Ia = 0.2 S. */
export function scsRunoff(P, cn) {
  if (cn >= 100) return P;
  const S = 25400 / cn - 254, Ia = 0.2 * S;
  return P > Ia ? (P - Ia) * (P - Ia) / (P - Ia + S) : 0;
}

/** Water input per hour (mm) of a coarse cell: rain plus melt of the snow lost in the hour above 0 °C. */
export function waterInput(rainMm, snowPrevM, snowNowM, tempC) {
  const melt = tempC > 0 && snowPrevM > snowNowM ? (snowPrevM - snowNowM) * FLOOD3D.snowDensity * 1000 : 0;
  return Math.max(0, rainMm) + melt;
}

/** Hourly water input fields (mm per coarse cell) from the hourly weather fields. */
export function inputSeries(fields) {
  const out = [];
  for (let h = 0; h < fields.hours; h++) {
    const n = fields.rain[h].length, a = new Float32Array(n);
    for (let k = 0; k < n; k++) a[k] = waterInput(fields.rain[h][k], h ? fields.snowDepth[h - 1][k] : fields.snowDepth[0][k], fields.snowDepth[h][k], fields.temp[h][k]);
    out.push(a);
  }
  return out;
}

/** The runoff of each hour for each cell, as a rate (m/s), with the cumulative input kept per cell.
 * Returns a function hour -> Float32Array(n). */
export function runoffRates(g, cover, plan, inputs) {
  const n = g.w * g.h, cum = new Float32Array(n), q = new Float32Array(n), cn = new Float32Array(n);
  for (let i = 0; i < n; i++) cn[i] = CN[cover[i]] ?? CN[0];
  const ch = (r) => Math.min(plan.ch - 1, Math.floor(r * plan.ch / g.h)), cw = (c) => Math.min(plan.cw - 1, Math.floor(c * plan.cw / g.w));
  let done = 0;
  return (hour) => {
    if (hour !== done) throw new Error("runoff hours must be asked in order");
    done++;
    const rate = new Float32Array(n), inp = inputs[hour];
    if (!inp) return rate;
    for (let r = 0; r < g.h; r++) {
      const row = ch(r) * plan.cw;
      for (let c = 0; c < g.w; c++) {
        const i = r * g.w + c, P = cum[i] + inp[row + cw(c)], Q = scsRunoff(P, cn[i]);
        rate[i] = (Q - q[i]) / 1000 / 3600;
        cum[i] = P; q[i] = Q;
      }
    }
    return rate;
  };
}

/** The routing state on a grid of w by h cells of dx by dy metres: depth h, unit flows qx on the w+1 vertical faces
 * of each row and qy on the h+1 horizontal faces of each column (positive toward east and south). */
export function makeState(w, h) {
  return { w, h, d: new Float32Array(w * h), qx: new Float32Array((w + 1) * h), qy: new Float32Array(w * (h + 1)), out: 0, rainIn: 0, clipped: 0, time: 0 };
}

/** The bed behind an edge: lower than the edge cell by the slope toward the edge, at least 0.1 %, so water drains out. */
const ghost = (zEdge, zIn, d) => zEdge - d * Math.max(0.001, (zIn - zEdge) / d);

/** Flow across one face from cell a (level ea, bed za) to cell b: the local inertial update. */
function face(q, ea, za, eb, zb, ha, hb, n2, dt, d) { // ha, hb: kept for the same call as the card's shader
  const hf = Math.max(ea, eb) - Math.max(za, zb);
  if (hf <= FLOOD3D.hMin) return 0;
  let nq = (q - FLOOD3D.g * hf * dt * (eb - ea) / d) / (1 + FLOOD3D.g * dt * n2 * Math.abs(q) / Math.pow(hf, 7 / 3));
  return nq;
}

/** One step of dt seconds: flows on every face, then depths. `src` is the runoff rate (m/s) of each cell. */
export function step(st, z, nMan, src, dx, dy, dt) {
  const { w, h, d, qx, qy } = st;
  for (let r = 0; r < h; r++) for (let c = 0; c <= w; c++) {
    const k = r * (w + 1) + c;
    if (c === 0) { const i = r * w, zb = ghost(z[i], z[i + (w > 1 ? 1 : 0)], dx); qx[k] = Math.min(0, face(qx[k], zb, zb, z[i] + d[i], z[i], 0, d[i], nMan[i] ** 2, dt, dx)); continue; }
    if (c === w) { const i = r * w + w - 1, zb = ghost(z[i], z[i - (w > 1 ? 1 : 0)], dx); qx[k] = Math.max(0, face(qx[k], z[i] + d[i], z[i], zb, zb, d[i], 0, nMan[i] ** 2, dt, dx)); continue; }
    const a = r * w + c - 1, b = a + 1, n2 = (0.5 * (nMan[a] + nMan[b])) ** 2;
    qx[k] = face(qx[k], z[a] + d[a], z[a], z[b] + d[b], z[b], d[a], d[b], n2, dt, dx);
  }
  for (let r = 0; r <= h; r++) for (let c = 0; c < w; c++) {
    const k = r * w + c;
    if (r === 0) { const i = c, zb = ghost(z[i], z[i + (h > 1 ? w : 0)], dy); qy[k] = Math.min(0, face(qy[k], zb, zb, z[i] + d[i], z[i], 0, d[i], nMan[i] ** 2, dt, dy)); continue; }
    if (r === h) { const i = (h - 1) * w + c, zb = ghost(z[i], z[i - (h > 1 ? w : 0)], dy); qy[k] = Math.max(0, face(qy[k], z[i] + d[i], z[i], zb, zb, d[i], 0, nMan[i] ** 2, dt, dy)); continue; }
    const a = (r - 1) * w + c, b = a + w, n2 = (0.5 * (nMan[a] + nMan[b])) ** 2;
    qy[k] = face(qy[k], z[a] + d[a], z[a], z[b] + d[b], z[b], d[a], d[b], n2, dt, dy);
  }
  // no cell gives more water in one step than it holds: where the faces would take more, all its outflows are scaled
  // down together (the depth then stays at or above 0 and the mass is kept)
  const scale = st.scale ?? (st.scale = new Float32Array(w * h));
  for (let r = 0; r < h; r++) for (let c = 0; c < w; c++) {
    const i = r * w + c, kx = r * (w + 1) + c, ky = r * w + c;
    const outV = (Math.max(0, -qx[kx]) + Math.max(0, qx[kx + 1])) * dt / dx + (Math.max(0, -qy[ky]) + Math.max(0, qy[ky + w])) * dt / dy;
    scale[i] = outV > d[i] ? d[i] / outV : 1;
  }
  for (let r = 0; r < h; r++) for (let c = 0; c <= w; c++) {
    const k = r * (w + 1) + c, q = qx[k];
    if (q > 0 && c > 0) qx[k] = q * scale[r * w + c - 1]; else if (q < 0 && c < w) qx[k] = q * scale[r * w + c];
  }
  for (let r = 0; r <= h; r++) for (let c = 0; c < w; c++) {
    const k = r * w + c, q = qy[k];
    if (q > 0 && r > 0) qy[k] = q * scale[(r - 1) * w + c]; else if (q < 0 && r < h) qy[k] = q * scale[r * w + c];
  }
  let out = 0, inflow = 0, clipped = 0;
  for (let r = 0; r < h; r++) for (let c = 0; c < w; c++) {
    const i = r * w + c, kx = r * (w + 1) + c, ky = r * w + c;
    const div = (qx[kx] - qx[kx + 1]) / dx + (qy[ky] - qy[ky + w]) / dy;
    const v = d[i] + dt * (div + src[i]);
    if (v < 0) clipped -= v;
    d[i] = Math.max(0, v);
    inflow += src[i] * dt;
  }
  st.clipped += clipped * dx * dy;
  for (let r = 0; r < h; r++) out += (-qx[r * (w + 1)] + qx[r * (w + 1) + w]) * dt * dy;
  for (let c = 0; c < w; c++) out += (-qy[c] + qy[h * w + c]) * dt * dx;
  st.out += out; st.rainIn += inflow * dx * dy; st.time += dt;
}

/** The step that keeps the scheme stable (de Almeida et al. 2012), at most 60 s. `wave` is the largest wave speed
 * sqrt(g h) + |u| on the grid: on steep Mongolian slopes the flow becomes supercritical, so the speed of the water
 * counts as well as the depth. */
export const stableDt = (wave, dx, dy) => Math.min(60, FLOOD3D.alpha * Math.min(dx, dy) / Math.max(wave, Math.sqrt(FLOOD3D.g * 0.01)));

/** Largest sqrt(g h) + |u| of the state, the speed from the flows of the faces around each wet cell. */
export function waveSpeed(st) {
  const { w, h, d, qx, qy } = st;
  let m = 0;
  for (let r = 0; r < h; r++) for (let c = 0; c < w; c++) {
    const i = r * w + c, hh = d[i];
    if (hh <= FLOOD3D.hMin) continue;
    const u = Math.max(Math.abs(qx[r * (w + 1) + c]), Math.abs(qx[r * (w + 1) + c + 1])) / hh, v = Math.max(Math.abs(qy[r * w + c]), Math.abs(qy[(r + 1) * w + c])) / hh;
    const s = Math.sqrt(FLOOD3D.g * hh) + Math.hypot(u, v);
    if (s > m) m = s;
  }
  return m;
}

/** Depth (m) to one byte for the frames: 0 below 1 cm, then log scale up to 20 m. */
export const depthByte = (h) => (h < 0.01 ? 0 : Math.min(255, 1 + Math.round(254 * Math.log(h / 0.01) / Math.log(2000))));
export const byteDepth = (b) => (b === 0 ? 0 : 0.01 * Math.exp((b - 1) / 254 * Math.log(2000)));

/** Water volume (m3) on the grid. */
export const volume = (st, dx, dy) => { let s = 0; for (const v of st.d) s += v; return s * dx * dy; };

/** The whole run on the CPU: frames of depth bytes every frameMinutes and the totals. `tick` lets a page breathe. */
export async function runCpu({ z, cover, w, h, dx, dy, rateOf, hours = FLOOD3D.hours, tick = async () => {} }) {
  const st = makeState(w, h), nMan = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) nMan[i] = MANNING[cover[i]] ?? MANNING[0];
  const frames = [], every = FLOOD3D.frameMinutes * 60;
  const snap = () => { const f = new Uint8Array(w * h); for (let i = 0; i < w * h; i++) f[i] = depthByte(st.d[i]); frames.push(f); };
  snap();
  for (let hr = 0; hr < hours; hr++) {
    const src = rateOf(hr);
    let t = 0;
    while (t < 3600 - 1e-6) {
      const dt = Math.min(stableDt(waveSpeed(st), dx, dy), 3600 - t);
      step(st, z, nMan, src, dx, dy, dt);
      t += dt;
    }
    if (((hr + 1) * 3600) % every === 0) snap();
    await tick(hr + 1, hours);
  }
  return { frames, maxDepth: maxOf(frames), state: st };
}

/** Deepest water seen in any frame of each cell (a byte). */
export function maxOf(frames) {
  const out = new Uint8Array(frames[0].length);
  for (const f of frames) for (let i = 0; i < f.length; i++) if (f[i] > out[i]) out[i] = f[i];
  return out;
}
