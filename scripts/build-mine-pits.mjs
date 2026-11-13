/* Builds data/mine_pits.geojson: the quarry outlines around every mine of js/config.js (MINES and VEG_MINES), from
 * OpenStreetMap via the Overpass API. The vegetation box draws them as a thin line, so that the reader sees where the
 * pit ends and the steppe begins; the point in config.js is one coordinate and says nothing about the pit's shape.
 * Runs on GitHub Actions, like build-settlements.mjs: the public Overpass servers are often at capacity and cannot be
 * relied on from a browser. Data (c) OpenStreetMap contributors, ODbL.
 * A mine with no quarry mapped in OpenStreetMap simply gets no feature, and the box falls back to the point.
 *
 * The servers answer a GitHub runner with HTTP 429 often, because runners share their addresses with everyone else.
 * So the mines are asked for in groups of a few rather than one by one, 429 is waited out rather than retried at
 * once, and the wait grows the longer the servers stay busy. A polygon comes back without a mine attached, so each is
 * given to the nearest mine centre. */
import { writeFile, mkdir } from "node:fs/promises";
import { MINES, VEG_MINES } from "../js/config.js";

const ENDPOINTS = ["https://overpass-api.de/api/interpreter", "https://overpass.kumi.systems/api/interpreter", "https://overpass.private.coffee/api/interpreter"];
const RADIUS_M = 7000;  // the pit and its dumps; wider pulls in unrelated borrow pits along the roads
const KEEP_KM = 8;      // a polygon further than this from every mine centre is somebody else's quarry
const GROUP = 4;        // mines per query: fewer requests is what the servers actually mind
const WAITS = [30, 60, 120, 240, 480]; // seconds between rounds, in all about 16 minutes against the job's 60

const sleep = (s) => new Promise((r) => setTimeout(r, s * 1000));

/** Quarry ways and relations within RADIUS_M of any of the given points, in one query. */
export function pitQuery(points, radius = RADIUS_M) {
  const body = points.map(({ lat, lon }) => `way["landuse"="quarry"](around:${radius},${lat},${lon});relation["landuse"="quarry"](around:${radius},${lat},${lon});`).join("");
  return `[out:json][timeout:180];(${body});out geom;`;
}

/** One query against the mirrors, waiting out a busy server instead of hammering it. Throws when all rounds fail. */
async function overpass(query) {
  let last;
  for (let round = 0; round <= WAITS.length; round++) {
    for (const url of ENDPOINTS) {
      try {
        const res = await fetch(url, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: "data=" + encodeURIComponent(query), signal: AbortSignal.timeout(300000) });
        if (res.ok) return await res.json();
        last = new Error(`${url}: HTTP ${res.status}`);
        // 429 is "slow down" and 504 "I am busy": the server names its own wait in Retry-After when it has one
        if (res.status === 429 || res.status === 504) {
          const after = Number(res.headers.get("retry-after"));
          if (Number.isFinite(after) && after > 0) await sleep(Math.min(after, 120));
        }
      } catch (e) { last = new Error(`${url}: ${e.message}`); }
      await sleep(5);
    }
    if (round < WAITS.length) {
      console.log(`all mirrors busy (${last?.message}); waiting ${WAITS[round]}s`);
      await sleep(WAITS[round]);
    }
  }
  throw last;
}

const round6 = (x) => Math.round(x * 1e6) / 1e6;
const KM_PER_DEG = 111.32;
/** Flat-earth distance in km; the mines are far apart, so this is accurate enough to tell them from each other. */
const km = (aLat, aLon, bLat, bLon) => Math.hypot((aLat - bLat) * KM_PER_DEG, (aLon - bLon) * KM_PER_DEG * Math.cos(((aLat + bLat) / 2 * Math.PI) / 180));

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

/** The mean of a ring's points: good enough to say which mine a quarry belongs to. */
export function centre(r) {
  let x = 0, y = 0;
  for (const [lon, lat] of r) { x += lon; y += lat; }
  return { lon: x / r.length, lat: y / r.length };
}

/** The id of the nearest mine within KEEP_KM of a ring's centre, or null when it belongs to none of them. */
export function nearestMine(r, mines, keepKm = KEEP_KM) {
  const c = centre(r);
  let best = null, bestKm = Infinity;
  for (const m of mines) {
    const d = km(c.lat, c.lon, m.lat, m.lon);
    if (d < bestKm) { bestKm = d; best = m; }
  }
  return best && bestKm <= keepKm ? best.id : null;
}

async function main() {
  const byId = new Map(); // MINES and VEG_MINES share ids (baganuur is in both), so one entry per id
  for (const m of [...MINES, ...VEG_MINES]) if (!byId.has(m.id)) byId.set(m.id, m);
  const mines = [...byId.values()], seen = new Set(), features = [];
  for (let i = 0; i < mines.length; i += GROUP) {
    const group = mines.slice(i, i + GROUP);
    console.log(`querying ${group.map((m) => m.id).join(", ")}`);
    const data = await overpass(pitQuery(group));
    for (const el of data.elements ?? []) {
      const osm = `${el.type}/${el.id}`;
      if (seen.has(osm)) continue;
      const rings = ringsOf(el);
      if (!rings.length) continue;
      seen.add(osm);
      for (const r of rings) {
        const mine = nearestMine(r, mines);
        if (!mine) continue;
        features.push({ type: "Feature", properties: { mine, osm, name: el.tags?.name ?? null }, geometry: { type: "Polygon", coordinates: [r] } });
      }
    }
    await sleep(10); // the servers ask callers to space their queries out
  }
  const perMine = {};
  for (const f of features) perMine[f.properties.mine] = (perMine[f.properties.mine] ?? 0) + 1;
  for (const m of mines) console.log(`${m.id}: ${perMine[m.id] ?? 0} polygon(s)`);
  await mkdir("data", { recursive: true });
  const out = { type: "FeatureCollection", attribution: "(c) OpenStreetMap contributors, ODbL", built: new Date().toISOString().slice(0, 10), features };
  await writeFile("data/mine_pits.geojson", JSON.stringify(out) + "\n");
  console.log(`data/mine_pits.geojson: ${features.length} polygon(s) for ${mines.length} mine(s)`);
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
