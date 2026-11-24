/* When the fire reaches each cell. From the ignition cells the fastest way across the grid is found by Dijkstra's
 * shortest-time search on a 16-neighbour stencil, as the minimum travel time method does (Finney 2002): the time to
 * cross from one cell to a neighbour is the distance over the mean of the two cells' rates toward that direction,
 * each from its own head fire ellipse (js/sim3d/rothermel.js). The weather is taken at the hour the fire arrives, so a
 * wind shift turns the fire. Snow on the ground (≥ 1 cm) or a wet hour stops spread in that cell for that hour. */
import { FUEL, deadMoisture, fuelOf, headFire, liveMoisture, prepare, rateToward, waf } from "./rothermel.js";
import { at, cellMetres } from "./inputs.js";
import { M_PER_DEG } from "../aoi/raster.js";

const RAD = Math.PI / 180;
// 16 neighbours: the 8 next ones and the 8 knight moves, which bring the shapes close to ellipses
const STENCIL = [[0, 1], [1, 0], [0, -1], [-1, 0], [1, 1], [1, -1], [-1, 1], [-1, -1], [1, 2], [2, 1], [2, -1], [1, -2], [-1, -2], [-2, -1], [-2, 1], [-1, 2]];

/** Slope (tan) and the upslope direction (radians clockwise from north) of every cell (Horn 1981). */
export function slopeAspect(z, w, h, mx, my) {
  const tan = new Float32Array(w * h), up = new Float32Array(w * h);
  const Z = (r, c) => z[Math.min(h - 1, Math.max(0, r)) * w + Math.min(w - 1, Math.max(0, c))];
  for (let r = 0; r < h; r++) for (let c = 0; c < w; c++) {
    const a = Z(r - 1, c - 1), b = Z(r - 1, c), cc = Z(r - 1, c + 1), d = Z(r, c - 1), f = Z(r, c + 1), g = Z(r + 1, c - 1), hh = Z(r + 1, c), i = Z(r + 1, c + 1);
    const dzdx = ((cc + 2 * f + i) - (a + 2 * d + g)) / (8 * mx); // rise toward east
    const dzdn = ((a + 2 * b + cc) - (g + 2 * hh + i)) / (8 * my); // rise toward north (row 0 is north)
    tan[r * w + c] = Math.hypot(dzdx, dzdn);
    up[r * w + c] = Math.atan2(dzdx, dzdn);
  }
  return { tan, up };
}

/** A small binary heap of (time, cell). */
class Heap {
  constructor() { this.t = []; this.i = []; }
  get size() { return this.t.length; }
  push(t, i) {
    const T = this.t, I = this.i;
    let k = T.length; T.push(t); I.push(i);
    while (k > 0) { const p = (k - 1) >> 1; if (T[p] <= t) break; T[k] = T[p]; I[k] = I[p]; k = p; }
    T[k] = t; I[k] = i;
  }
  pop() {
    const T = this.t, I = this.i, top = [T[0], I[0]], lt = T.pop(), li = I.pop();
    if (T.length) {
      let k = 0;
      for (;;) {
        let c = 2 * k + 1; if (c >= T.length) break;
        if (c + 1 < T.length && T[c + 1] < T[c]) c++;
        if (T[c] >= lt) break;
        T[k] = T[c]; I[k] = I[c]; k = c;
      }
      T[k] = lt; I[k] = li;
    }
    return top;
  }
}

/** Canopy for the wind reduction of forest cells: half cover, 15 m high (no canopy map of Mongolia is used). */
export const CANOPY = { cover: 0.5, heightFt: 49 };

/**
 * Arrival time (minutes after the start) of every cell.
 *  g: grid; z: DEM; cover: WorldCover codes; fields: hourly fields (js/sim3d/inputs.js hourlyFields) whose hour 0 is the
 *  start; ignition: cell indices; month: 1-12; hours: how long to run. Returns arrival (Float32, Infinity where the
 *  fire does not arrive), the head rate (m/min) and fireline intensity (kW/m) at arrival, and the fuel models.
 */
export function spreadFire({ g, z, cover, fields, ignition, month, hours = 24, startHour = 0 }) {
  const w = g.w, h = g.h, n = w * h, m = cellMetres(g);
  const { tan, up } = slopeAspect(z, w, h, m.x, m.y);
  const fuel = new Uint8Array(n);
  for (let i = 0; i < n; i++) fuel[i] = fuelOf(cover[i]);
  const prep = {}; for (const k of Object.keys(FUEL)) prep[k] = prepare(Number(k));
  const wafOf = {}; for (const k of Object.keys(FUEL)) wafOf[k] = Number(k) === 2 || Number(k) >= 8 ? waf(FUEL[k].delta, CANOPY.cover, CANOPY.heightFt) : waf(FUEL[k].delta);
  const live = liveMoisture(month);
  // the head fire of a cell for an hour, computed when first needed
  const stamp = new Int32Array(n).fill(-1), ros = new Float32Array(n), dir = new Float32Array(n), ecc = new Float32Array(n), IR = new Float32Array(n);
  const fieldHour = (hh) => Math.min(fields.hours - 1, startHour + hh);
  function head(i, hh) {
    if (stamp[i] === hh) return;
    stamp[i] = hh;
    const k = fuel[i];
    if (!k) { ros[i] = 0; return; }
    const r = (i / w) | 0, c = i - r * w, H2 = fieldHour(hh), P = fields.plan;
    const snow = at(P, fields.snowDepth[H2], r, c), rain = at(P, fields.precip[H2], r, c);
    if (snow >= 0.01) { ros[i] = 0; return; }
    const dead = deadMoisture(at(P, fields.temp[H2], r, c), at(P, fields.rh[H2], r, c), rain);
    const u = at(P, fields.u[H2], r, c), v = at(P, fields.v[H2], r, c);
    const hf = headFire(prep[k], dead, live, Math.hypot(u, v), Math.atan2(u, v), tan[i], up[i], wafOf[k]);
    ros[i] = hf.ros; dir[i] = hf.dir; ecc[i] = hf.ecc; IR[i] = hf.IR;
  }
  const rate = (i, theta) => (ros[i] > 0 ? ros[i] * (1 - ecc[i]) / (1 - ecc[i] * Math.cos(theta - dir[i])) : 0);

  const time = new Float64Array(n).fill(Infinity), done = new Uint8Array(n); // doubles: the heap compares them exactly
  const headRos = new Float32Array(n), fli = new Float32Array(n);
  const heap = new Heap(), tEnd = hours * 60;
  for (const i of ignition) if (i >= 0 && i < n && fuel[i]) { time[i] = 0; heap.push(0, i); }
  // the stencil in metres and the direction of each step (clockwise from north)
  const steps = STENCIL.map(([dr, dc]) => ({ dr, dc, d: Math.hypot(dr * m.y, dc * m.x), th: Math.atan2(dc * m.x, -dr * m.y) }));
  while (heap.size) {
    const [t, i] = heap.pop();
    if (done[i] || t > time[i]) continue;
    done[i] = 1;
    if (t > tEnd) break;
    const hh = Math.floor(t / 60);
    head(i, hh);
    headRos[i] = ros[i];
    fli[i] = ros[i] > 0 ? IR[i] * (ros[i] * 3.28084) * (384 / prep[fuel[i]].sigma) / 60 * 3.4613 : 0;
    if (!(ros[i] > 0)) continue;
    const r = (i / w) | 0, c = i - r * w;
    for (const s of steps) {
      const rr = r + s.dr, cc = c + s.dc;
      if (rr < 0 || rr >= h || cc < 0 || cc >= w) continue;
      const j = rr * w + cc;
      if (done[j] || !fuel[j]) continue;
      // a knight move passes over two cells: both must burn, or the fire would jump a road or a stream
      if (Math.abs(s.dr) + Math.abs(s.dc) === 3) {
        const a = (r + Math.sign(s.dr) * (Math.abs(s.dr) === 2 ? 1 : 0)) * w + c + Math.sign(s.dc) * (Math.abs(s.dc) === 2 ? 1 : 0);
        const b = (r + (Math.abs(s.dr) === 2 ? Math.sign(s.dr) : s.dr)) * w + c + (Math.abs(s.dc) === 2 ? Math.sign(s.dc) : s.dc);
        if (!fuel[a] || !fuel[b]) continue;
      }
      head(j, hh);
      const ra = rate(i, s.th), rb = rate(j, s.th);
      if (!(ra > 0) || !(rb > 0)) continue;
      const tt = t + s.d * 0.5 * (1 / ra + 1 / rb);
      if (tt < time[j]) { time[j] = tt; heap.push(tt, j); }
    }
  }
  const arrival = new Float32Array(n);
  for (let i = 0; i < n; i++) arrival[i] = done[i] && time[i] <= tEnd ? time[i] : Infinity;
  return { arrival, headRos, fli, fuel, hours };
}

/** The cell of a point (lat, lon) on the grid, or -1 outside it. */
export function cellOf(g, lat, lon) {
  const r = Math.floor((g.north - lat) / g.dy), c = Math.floor((lon - g.west) / g.dx);
  return r < 0 || r >= g.h || c < 0 || c >= g.w ? -1 : r * g.w + c;
}

/** Cells within `radiusM` metres of a point: a detection of 375 m or 1 km is a footprint, not a point. Only cells that
 * can burn are kept; the fire starts from all of them at once. */
export function footprint(g, lat, lon, radiusM, cover) {
  const m = cellMetres(g), out = [];
  const r0 = (g.north - lat) / g.dy, c0 = (lon - g.west) / g.dx, kr = Math.ceil(radiusM / m.y), kc = Math.ceil(radiusM / m.x);
  for (let r = Math.floor(r0) - kr; r <= Math.floor(r0) + kr; r++) for (let c = Math.floor(c0) - kc; c <= Math.floor(c0) + kc; c++) {
    if (r < 0 || r >= g.h || c < 0 || c >= g.w) continue;
    if (Math.hypot((r + 0.5 - r0) * m.y, (c + 0.5 - c0) * m.x) > radiusM) continue;
    if (fuelOf(cover[r * g.w + c])) out.push(r * g.w + c);
  }
  return out;
}

/** Burned area (km2) at time t minutes. */
export function burnedKm2(g, arrival, t) {
  const m = cellMetres(g), a = m.x * m.y / 1e6;
  let k = 0; for (let i = 0; i < arrival.length; i++) if (arrival[i] <= t) k++;
  return k * a;
}
export { M_PER_DEG, RAD, rateToward };
