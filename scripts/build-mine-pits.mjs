/* Builds data/mine_pits.geojson: the quarry outlines around every mine of js/config.js (MINES and VEG_MINES), from
 * OpenStreetMap via the Overpass API. The vegetation box draws them as a thin line, so that the reader sees where the
 * pit ends and the steppe begins; the point in config.js is one coordinate and says nothing about the pit's shape.
 * Runs on GitHub Actions, like build-settlements.mjs: the public Overpass servers are often at capacity and cannot be
 * relied on from a browser. Data (c) OpenStreetMap contributors, ODbL.
 * A mine with no quarry mapped in OpenStreetMap simply gets no feature, and the box falls back to the point. */
import { writeFile, mkdir } from "node:fs/promises";
import { MINES, VEG_MINES } from "../js/config.js";

const ENDPOINTS = ["https://overpass-api.de/api/interpreter", "https://overpass.kumi.systems/api/interpreter", "https://overpass.private.coffee/api/interpreter"];
const RADIUS_M = 7000; // the pit and its dumps; wider pulls in unrelated borrow pits along the roads

/** Quarry ways and relations within RADIUS_M of a point. `out geom` returns the coordinates with the elements. */
export function pitQuery(lat, lon, radius = RADIUS_M) {
  return `[out:json][timeout:90];(way["landuse"="quarry"](around:${radius},${lat},${lon});relation["landuse"="quarry"](around:${radius},${lat},${lon}););out geom;`;
}

async function overpass(query) {
  let last;
  for (let round = 0; round < 3; round++) {
    for (const url of ENDPOINTS) {
      try {
        const res = await fetch(url, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: "data=" + encodeURIComponent(query), signal: AbortSignal.timeout(100000) });
        if (res.ok) return await res.json();
        last = new Error(`${url}: HTTP ${res.status}`);
      } catch (e) { last = new Error(`${url}: ${e.message}`); }
    }
    await new Promise((r) => setTimeout(r, 20000 * (round + 1)));
  }
  throw last;
}

const round6 = (x) => Math.round(x * 1e6) / 1e6;

/** A closed ring of [lon, lat] pairs, or null when the element carries too few points to be a polygon. */
export function ring(points) {
  if (!points || points.length < 4) return null;
  const r = points.map((p) => [round6(p.lon), round6(p.lat)]);
  const [x0, y0] = r[0], [xn, yn] = r[r.length - 1];
  if (x0 !== xn || y0 !== yn) r.push([x0, y0]);
  return r.length >= 4 ? r : null;
}

/** Every outer ring an element carries: a way has one, a relation one per member with the role "outer". */
export function ringsOf(el) {
  if (el.type === "way") { const r = ring(el.geometry); return r ? [r] : []; }
  if (el.type === "relation") return (el.members ?? []).filter((m) => m.role === "outer" && m.geometry).map((m) => ring(m.geometry)).filter(Boolean);
  return [];
}

async function main() {
  const mines = [...MINES, ...VEG_MINES];
  const byId = new Map(); // one entry per mine id: MINES and VEG_MINES share ids (baganuur is in both)
  for (const m of mines) if (!byId.has(m.id)) byId.set(m.id, m);
  const seen = new Set(), features = [];
  for (const m of byId.values()) {
    const data = await overpass(pitQuery(m.lat, m.lon));
    let n = 0;
    for (const el of data.elements ?? []) {
      const osm = `${el.type}/${el.id}`;
      if (seen.has(osm)) continue;
      const rings = ringsOf(el);
      if (!rings.length) continue;
      seen.add(osm);
      for (const r of rings) {
        features.push({ type: "Feature", properties: { mine: m.id, osm, name: el.tags?.name ?? null }, geometry: { type: "Polygon", coordinates: [r] } });
        n++;
      }
    }
    console.log(`${m.id}: ${n} polygon(s)`);
    await new Promise((r) => setTimeout(r, 4000)); // the public servers ask callers to space their queries out
  }
  await mkdir("data", { recursive: true });
  const out = { type: "FeatureCollection", attribution: "(c) OpenStreetMap contributors, ODbL", built: new Date().toISOString().slice(0, 10), features };
  await writeFile("data/mine_pits.geojson", JSON.stringify(out) + "\n");
  console.log(`data/mine_pits.geojson: ${features.length} polygon(s) for ${byId.size} mine(s)`);
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
