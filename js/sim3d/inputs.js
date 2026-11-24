/* What the 3D runs read, all on one grid of the drawn box: the terrain (Copernicus DEM GLO-30, 30 m, the finest open
 * elevation over Mongolia), the land cover (ESA WorldCover 2021, 10 m taken onto the grid) and the hourly weather of
 * Open-Meteo at a 4 by 4 lattice of points, spread over the grid by inverse-distance weighting. The fetching parts need
 * the network; the rest are plain functions on arrays so the tests can run them. */
import { makeGrid, M_PER_DEG } from "../aoi/raster.js";
import { API, TZ } from "../config.js";

/** Finest cell and the most cells on a side: 30 m up to 1024 cells (about 30 by 30 km), coarser beyond. */
export const GRID = { finest: 30, maxSide: 1024, lattice: 4, archiveAfterDays: 85 };

/** The 3D grid of a box {s, n, w, e}: 30 m, or the step that keeps the longer side within maxSide cells. */
export function grid3d(box, maxSide = GRID.maxSide) {
  const lat0 = (box.s + box.n) / 2;
  const wm = (box.e - box.w) * M_PER_DEG * Math.cos(lat0 * Math.PI / 180), hm = (box.n - box.s) * M_PER_DEG;
  const scale = Math.max(GRID.finest, Math.ceil(Math.max(wm, hm) / maxSide));
  return makeGrid(box, scale);
}

export const boxOf = (g) => ({ s: g.north - g.h * g.dy, n: g.north, w: g.west, e: g.west + g.w * g.dx });

/** Cell size in metres east-west and north-south. */
export const cellMetres = (g) => ({ x: g.dx * M_PER_DEG * Math.cos(g.lat0 * Math.PI / 180), y: g.dy * M_PER_DEG });

/** Holes in the DEM (no data at the edge of a tile) filled from the nearest cell of the same row, then column. */
export function fillHoles(z, w, h) {
  const out = Float32Array.from(z);
  for (let pass = 0; pass < 2; pass++) {
    for (let r = 0; r < h; r++) {
      let last = NaN;
      for (let c = 0; c < w; c++) { const i = r * w + c; if (Number.isNaN(out[i])) { if (!Number.isNaN(last)) out[i] = last; } else last = out[i]; }
      last = NaN;
      for (let c = w - 1; c >= 0; c--) { const i = r * w + c; if (Number.isNaN(out[i])) { if (!Number.isNaN(last)) out[i] = last; } else last = out[i]; }
    }
    for (let c = 0; c < w; c++) {
      let last = NaN;
      for (let r = 0; r < h; r++) { const i = r * w + c; if (Number.isNaN(out[i])) { if (!Number.isNaN(last)) out[i] = last; } else last = out[i]; }
      last = NaN;
      for (let r = h - 1; r >= 0; r--) { const i = r * w + c; if (Number.isNaN(out[i])) { if (!Number.isNaN(last)) out[i] = last; } else last = out[i]; }
    }
  }
  return out;
}

/** The weather points: centres of a k by k split of the box. */
export const lattice = (b, k = GRID.lattice) => Array.from({ length: k * k }, (_, i) => ({
  lat: b.s + (b.n - b.s) * (Math.floor(i / k) + 0.5) / k, lon: b.w + (b.e - b.w) * ((i % k) + 0.5) / k,
}));

/** Weights of the points for every cell of a coarse helper grid (inverse distance squared, in metres). The fields are
 * smooth at the 9-25 km of the weather models, so they are spread on a grid of at most 64 by 64 and read from it. */
export function idwPlan(g, pts, side = 64) {
  const cw = Math.min(side, g.w), ch = Math.min(side, g.h), m = cellMetres(g), k = pts.length;
  const wts = new Float32Array(cw * ch * k);
  for (let r = 0; r < ch; r++) for (let c = 0; c < cw; c++) {
    const lat = g.north - (r + 0.5) * g.h / ch * g.dy, lon = g.west + (c + 0.5) * g.w / cw * g.dx;
    let sum = 0;
    const o = (r * cw + c) * k;
    for (let p = 0; p < k; p++) {
      const dy = (lat - pts[p].lat) / g.dy * m.y, dx = (lon - pts[p].lon) / g.dx * m.x;
      const v = 1 / Math.max(1, dx * dx + dy * dy);
      wts[o + p] = v; sum += v;
    }
    for (let p = 0; p < k; p++) wts[o + p] /= sum;
  }
  return { cw, ch, k, wts, g };
}

/** A field of point values on the coarse grid. */
export function spread(plan, values) {
  const { cw, ch, k, wts } = plan, out = new Float32Array(cw * ch);
  for (let i = 0; i < cw * ch; i++) { let s = 0; for (let p = 0; p < k; p++) s += wts[i * k + p] * (values[p] ?? 0); out[i] = s; }
  return out;
}

/** The value of a coarse field at cell (r, c) of the full grid (nearest coarse cell). */
export const at = (plan, field, r, c) => field[Math.min(plan.ch - 1, Math.floor(r * plan.ch / plan.g.h)) * plan.cw + Math.min(plan.cw - 1, Math.floor(c * plan.cw / plan.g.w))];

const DAY = 86400000;
const iso = (ms) => new Date(ms).toISOString().slice(0, 10);
export const addDays = (d, n) => iso(Date.parse(d + "T00:00:00Z") + n * DAY);

/** Which Open-Meteo service and which days: the forecast within 85 days of today (it holds the recent past too), the
 * ERA5 archive before, which is complete up to about 6 days ago. Returns null when no hour of the period exists yet. */
export function weatherPlan(day, days, now = Date.now()) {
  const ageDays = (now - Date.parse(day + "T00:00:00Z")) / DAY, archive = ageDays > GRID.archiveAfterDays;
  const lastDay = archive ? iso(now - 6 * DAY) : iso(now + 15 * DAY);
  const end = addDays(day, days - 1), stop = end < lastDay ? end : lastDay;
  if (stop < day) return null;
  return { url: archive ? API.archive : API.forecast, source: archive ? "era5" : "forecast", from: day, to: stop };
}

export const WEATHER_VARS = ["temperature_2m", "relative_humidity_2m", "precipitation", "rain", "snowfall", "snow_depth", "wind_speed_10m", "wind_direction_10m", "wind_gusts_10m", "soil_moisture_0_to_7cm"];

/** Hourly weather at the lattice for `days` days from `day` (local time of Ulaanbaatar). */
export async function weatherAt(box, day, days, now = Date.now()) {
  const plan = weatherPlan(day, days, now);
  if (!plan) throw new Error("no_weather");
  const pts = lattice(box);
  const q = new URLSearchParams({
    latitude: pts.map((p) => p.lat.toFixed(4)).join(","), longitude: pts.map((p) => p.lon.toFixed(4)).join(","),
    start_date: plan.from, end_date: plan.to, timezone: TZ, hourly: WEATHER_VARS.join(","), wind_speed_unit: "ms",
  });
  const r = await fetch(`${plan.url}?${q}`);
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`Open-Meteo ${r.status}${j.reason ? ": " + j.reason : ""}`);
  const list = Array.isArray(j) ? j : [j];
  return { source: plan.source, points: pts, hourly: list.map((p) => p.hourly), time: list[0].hourly.time };
}

/** Wind (from-direction in degrees, speed) as the components it blows toward: east (u) and north (v). */
export function windVector(speed, fromDeg) {
  const a = fromDeg * Math.PI / 180;
  return { u: -speed * Math.sin(a), v: -speed * Math.cos(a) };
}

/** The hourly fields used by the runs, each a list over hours of a coarse field. Wind is spread as components so that
 * opposite winds at two points do not average to a wrong direction with full speed. */
export function hourlyFields(wx, g) {
  const plan = idwPlan(g, wx.points), H = wx.time.length, get = (name, h) => wx.hourly.map((p) => p[name]?.[h]);
  const f = { plan, time: wx.time, hours: H, u: [], v: [], temp: [], rh: [], rain: [], precip: [], snowDepth: [], soil: [], gust: [] };
  for (let h = 0; h < H; h++) {
    const vec = wx.hourly.map((p) => windVector(p.wind_speed_10m?.[h] ?? 0, p.wind_direction_10m?.[h] ?? 0));
    f.u.push(spread(plan, vec.map((x) => x.u)));
    f.v.push(spread(plan, vec.map((x) => x.v)));
    f.temp.push(spread(plan, get("temperature_2m", h)));
    f.rh.push(spread(plan, get("relative_humidity_2m", h)));
    f.rain.push(spread(plan, get("rain", h)));
    f.precip.push(spread(plan, get("precipitation", h)));
    f.snowDepth.push(spread(plan, get("snow_depth", h)));
    f.soil.push(spread(plan, get("soil_moisture_0_to_7cm", h)));
    f.gust.push(spread(plan, get("wind_gusts_10m", h)));
  }
  return f;
}

/** Means over the box of an hourly coarse field list (for the time line and the video caption). */
export const boxMean = (fields) => fields.map((f) => f.reduce((a, b) => a + b, 0) / f.length);

/** Terrain and land cover of the grid from the Planetary Computer. */
export async function terrain(g, step = () => {}) {
  const { search, floatOnGrid, bandOnGrid } = await import("../aoi/stac.js");
  const box = boxOf(g);
  step("dem");
  const dems = await search("cop-dem-glo-30", box);
  if (!dems.length) throw new Error("no_dem");
  let z = null;
  for (const it of dems) z = await floatOnGrid(g, it, { assets: "data" }, z);
  z = fillHoles(z, g.w, g.h);
  step("cover");
  const wc = (await search("esa-worldcover", box)).filter((i) => /2021/.test(i.id));
  let cover = null;
  for (const it of wc) cover = await bandOnGrid(g, it, { assets: "map", rescale: "0,255" }, (v) => v, cover);
  return { z, cover: cover ? Uint8Array.from(cover, (v) => (Number.isNaN(v) ? 0 : v)) : new Uint8Array(g.w * g.h) };
}
