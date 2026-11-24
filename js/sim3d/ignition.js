/* Where and when the fire starts, the finest source first:
 *  1. Sentinel-2 on the chosen day, 20 m: unambiguous active-fire pixels by the reflectance rule of Kumar & Roy (2018,
 *     Int. J. Digital Earth 11, GOLI) for Landsat-8 OLI, red <= 0.53 SWIR2 - 0.214, with Sentinel-2 B04 and B12 for OLI
 *     bands 4 and 7 (as restated by Pereira et al. 2021). The rule was set on top-of-atmosphere reflectance of OLI;
 *     here it reads the surface reflectance of Sentinel-2 L2A, the only level the Planetary Computer serves, so faint
 *     fires may be missed. Hu et al. (2021, AFD-S2) built Sentinel-2's own rules; their equations could not be read
 *     for this page.
 *  2. VIIRS 375 m (S-NPP, NOAA-20, NOAA-21) from the site's own FIRMS file, which the scheduled build writes for the
 *     last 3 days (data/fires.json).
 *  3. MODIS 1 km (MOD14A1 and MYD14A1, Planetary Computer), the day's fire mask: no hour is stored, so the start is
 *     taken at 13:30, the time of the Aqua pass.
 * The user can always click a point instead. A 375 m or 1 km detection starts the fire on all burnable cells of its
 * footprint, not on one point. */
import { search, searchModis, passes, bandOnGrid } from "../aoi/stac.js";
import { makeGrid } from "../aoi/raster.js";
import { boxOf } from "./inputs.js";
import { fuelOf } from "./rothermel.js";
import { footprint } from "./fire_sim.js";
import { TZ_OFFSET_HOURS } from "../config.js";

export const IGNITION = { s2Scale: 20, viirsRadius: 375 / 2, modisRadius: 500, modisLocalHour: 13.5, fireMask: 7 };

/** The rule of Kumar & Roy (2018) on reflectances (0-1). */
export const hotPixel = (red, swir2) => red <= 0.53 * swir2 - 0.214;

/** Data API expression for the rule; baseline 04.00 and later adds 1000 to every band. */
export const hotExpression = (item) => {
  const off = Number(item.properties["s2:processing_baseline"]) >= 4 ? 1000 : 0;
  return { expression: `((B04-${off})/10000.0)<=(0.53*((B12-${off})/10000.0)-0.214)`, asset_as_band: "True", rescale: "0,1" };
};

/** Hours from local midnight of `day` to a UTC instant. */
export const localHour = (day, ms) => (ms - Date.parse(day + "T00:00:00Z")) / 3600000 + TZ_OFFSET_HOURS;

/** Sentinel-2 fire cells of the 3D grid g on the day, or null. */
export async function fromSentinel2(g, cover, day) {
  const box = boxOf(g), items = await search("sentinel-2-l2a", box, day, day);
  if (!items.length) return null;
  const fine = makeGrid(box, IGNITION.s2Scale);
  for (const p of passes(items)) {
    let hot = null;
    for (const it of p.items) hot = await bandOnGrid(fine, it, hotExpression(it), (v) => (v > 0 ? 1 : 0), hot);
    const cells = new Set(), points = [];
    for (let r = 0; r < fine.h; r++) for (let c = 0; c < fine.w; c++) {
      if (hot[r * fine.w + c] !== 1) continue;
      const lat = fine.north - (r + 0.5) * fine.dy, lon = fine.west + (c + 0.5) * fine.dx;
      const gr = Math.floor((g.north - lat) / g.dy), gc = Math.floor((lon - g.west) / g.dx);
      if (gr < 0 || gr >= g.h || gc < 0 || gc >= g.w) continue;
      points.push({ lat, lon });
      const i = gr * g.w + gc;
      if (fuelOf(cover[i])) cells.add(i);
    }
    if (cells.size) return { source: "s2", resolution: 20, cells: [...cells], points, hour: localHour(day, p.t0), when: p.t0, count: points.length };
  }
  return null;
}

/** VIIRS detections of the day inside the grid from the site's FIRMS file, or null. */
export async function fromViirs(g, cover, day, url = "data/fires.json") {
  let j;
  try { const r = await fetch(url, { cache: "no-store" }); if (!r.ok) return null; j = await r.json(); } catch { return null; }
  const box = boxOf(g);
  const dets = (j.detections ?? []).filter((d) => /VIIRS/.test(d.src ?? "") && d.lat >= box.s && d.lat <= box.n && d.lon >= box.w && d.lon <= box.e);
  // FIRMS dates and times are UTC
  const withTime = dets.map((d) => ({ ...d, ms: Date.parse(`${d.date}T${String(d.time ?? "0000").padStart(4, "0").slice(0, 2)}:${String(d.time ?? "0000").padStart(4, "0").slice(2)}:00Z`) }));
  const today = withTime.filter((d) => { const h = localHour(day, d.ms); return h >= 0 && h < 24; }).sort((a, b) => a.ms - b.ms);
  if (!today.length) return null;
  const first = today[0].ms, cells = new Set();
  for (const d of today.filter((x) => x.ms - first < 3600000)) for (const i of footprint(g, d.lat, d.lon, IGNITION.viirsRadius, cover)) cells.add(i);
  if (!cells.size) return null;
  return { source: "viirs", resolution: 375, cells: [...cells], points: today.map((d) => ({ lat: d.lat, lon: d.lon })), hour: localHour(day, first), when: first, count: today.length };
}

/** MODIS fire mask of the day (FireMask >= 7: fire of low, nominal or high confidence), or null. */
export async function fromModis(g, cover, day) {
  const box = boxOf(g), coarse = makeGrid(box, 1000);
  const items = await searchModis("modis-14A1-061", box, addDays(day, -8), day);
  let flag = null;
  for (const it of items) {
    const start = (it.properties.start_datetime ?? it.properties.datetime).slice(0, 10);
    const b = Math.round((Date.parse(day) - Date.parse(start)) / 86400000) + 1;
    if (b < 1 || b > 8) continue;
    flag = await bandOnGrid(coarse, it, { expression: `(FireMask_b${b}>=${IGNITION.fireMask})`, rescale: "0,1" }, (v) => (v > 0 ? 1 : 0), flag);
  }
  if (!flag) return null;
  const cells = new Set(), points = [];
  for (let r = 0; r < coarse.h; r++) for (let c = 0; c < coarse.w; c++) {
    if (flag[r * coarse.w + c] !== 1) continue;
    const lat = coarse.north - (r + 0.5) * coarse.dy, lon = coarse.west + (c + 0.5) * coarse.dx;
    points.push({ lat, lon });
    for (const i of footprint(g, lat, lon, IGNITION.modisRadius, cover)) cells.add(i);
  }
  if (!cells.size) return null;
  return { source: "modis", resolution: 1000, cells: [...cells], points, hour: IGNITION.modisLocalHour, when: null, count: points.length };
}

const addDays = (d, n) => new Date(Date.parse(d + "T00:00:00Z") + n * 86400000).toISOString().slice(0, 10);

/** The finest ignition found, trying the sources in order; `step(key)` reports which one is read. */
export async function findIgnition(g, cover, day, step = () => {}) {
  const tries = [["s2", fromSentinel2], ["viirs", fromViirs], ["modis", fromModis]];
  const errors = [];
  for (const [key, f] of tries) {
    step("ign_" + key);
    try { const r = await f(g, cover, day); if (r) return { ...r, errors }; } catch (e) { errors.push(`${key}: ${e.message}`); }
  }
  return { source: null, cells: [], errors };
}
