/* The 3D window: for the drawn area and the day of the date bar it fetches the ground and the weather, runs one hazard
 * (js/sim3d/flood_*.js, fire_sim.js, dust_sim.js), shows it on the terrain with a time line, and records a video.
 * Everything runs in the user's browser from open data. */
import { el } from "../dom.js";
import { drawingMark } from "../logo.js";
import { boxAreaKm2 } from "../aoi/raster.js";
import { backdrop } from "../aoi/backdrop.js";
import { surface, landShares, LAND } from "../aoi/dust.js";
import { save } from "../export.js";
import { GRID, addDays, boxOf, cellMetres, grid3d, hourlyFields, terrain, weatherAt } from "./inputs.js";
import { FLOOD3D, byteDepth, depthByte, inputSeries, runCpu, runoffRates } from "./flood_sim.js";
import { floatContext, runGpu } from "./flood_gpu.js";
import { burnedKm2, cellOf, spreadFire } from "./fire_sim.js";
import { findIgnition } from "./ignition.js";
import { createDustRun, emissions, quietReasons, summary } from "./dust_sim.js";
import { autoExaggeration, createScene } from "./scene.js";
import { pickFormat, record } from "./recorder.js";

export const LIMITS = { hardKm2: 2500, cpuSide: 256, fireHours: 24 };

const fill = (s, v) => s.replace(/\{(\w+)\}/g, (_, k) => v[k] ?? "");
const pad = (x) => String(x).padStart(2, "0");
/** Local clock text of `minutes` after local midnight of `day`. */
export function clockText(day, minutes) {
  const ms = Date.parse(day + "T00:00:00Z") + Math.round(minutes) * 60000, d = new Date(ms);
  return `${d.toISOString().slice(0, 10)} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}

/** A coarser copy of the ground for the CPU flood run: every f-th cell (the DEM is smooth at that step). */
export function coarsen(g, z, cover, maxSide) {
  const f = Math.max(1, Math.ceil(Math.max(g.w, g.h) / maxSide));
  if (f === 1) return { g, z, cover, f };
  const w = Math.ceil(g.w / f), h = Math.ceil(g.h / f), z2 = new Float32Array(w * h), c2 = new Uint8Array(w * h);
  for (let r = 0; r < h; r++) for (let c = 0; c < w; c++) {
    let s = 0, k = 0;
    for (let rr = r * f; rr < Math.min(g.h, (r + 1) * f); rr++) for (let cc = c * f; cc < Math.min(g.w, (c + 1) * f); cc++) { s += z[rr * g.w + cc]; k++; }
    z2[r * w + c] = s / k;
    c2[r * w + c] = cover[Math.min(g.h - 1, r * f + (f >> 1)) * g.w + Math.min(g.w - 1, c * f + (f >> 1))];
  }
  return { g: { ...g, w, h, dx: g.dx * f, dy: g.dy * f, scale: g.scale * f }, z: z2, cover: c2, f };
}

export function createSim3d({ t, getBox, getDay, lang = () => "mn" }) {
  const status = el("p", { class: "s3-status", role: "status" });
  const mark = el("div", { class: "s3-mark", hidden: true }); // the drawing logo above the status while data load and the model runs
  const info = el("div", { class: "s3-info" });
  const view = el("div", { class: "s3-view" });
  const slider = el("input", { type: "range", min: "0", max: "1000", value: "0", class: "s3-slider", "aria-label": "time" });
  const clock = el("span", { class: "s3-clock" });
  const playBtn = el("button", { type: "button", class: "btn s3-play" });
  const speedSel = el("select", { class: "field s3-sel", title: "" });
  const exagSel = el("select", { class: "field s3-sel" }, ...[1, 2, 3, 5, 10].map((x) => el("option", { value: String(x), text: `×${x}`, selected: x === 2 })));
  const recBtn = el("button", { type: "button", class: "btn s3-rec" });
  const title = el("b", { class: "s3-title" });
  const closeBtn = el("button", { type: "button", class: "side-close s3-close", text: "×", onclick: () => close() });
  const bar = el("div", { class: "s3-bar" }, playBtn, slider, clock, el("label", { class: "s3-lab" }, el("span", { class: "s3-l-speed" }), speedSel), el("label", { class: "s3-lab" }, el("span", { class: "s3-l-exag" }), exagSel), recBtn);
  const root = el("section", { class: "s3 glass", role: "dialog", "aria-modal": "true", hidden: true },
    el("header", { class: "s3-head" }, title, closeBtn), el("div", { class: "s3-main" }, view, el("aside", { class: "s3-side" }, mark, status, info)), bar);
  document.body.append(root);

  const st = { hz: null, scene: null, run: null, T: 0, t: 0, playing: false, raf: 0, rec: null, picking: false, token: 0 };

  function setStatus(text, err = false) { status.textContent = text; status.classList.toggle("err", err); }
  /** Shows the drawing logo (from the start of its loop) or takes it away. */
  function working(on) { mark.hidden = !on; mark.replaceChildren(...(on ? [drawingMark({ go: true })] : [])); }
  function labelsNow() {
    root.querySelector(".s3-l-speed").textContent = t("s3_speed");
    root.querySelector(".s3-l-exag").textContent = t("s3_exag");
    playBtn.textContent = st.playing ? t("s3_pause") : t("s3_play");
    recBtn.textContent = t("s3_record");
    closeBtn.title = t("s3_close"); closeBtn.setAttribute("aria-label", t("s3_close"));
  }
  const speeds = () => (st.hz === "fire" ? [0.5, 1, 2, 4] : [1, 3, 6, 12]); // simulated hours per second
  function fillSpeeds() {
    speedSel.replaceChildren(...speeds().map((v, i) => el("option", { value: String(v), text: `${v} ${t("s3_hours")}/s`, selected: i === 1 })));
  }

  function setTime(tm) {
    st.t = Math.max(0, Math.min(st.T, tm));
    slider.value = String(Math.round(1000 * st.t / (st.T || 1)));
    clock.textContent = st.run ? clockText(st.run.day, st.run.offset + st.t) : "";
    st.scene?.setTime(st.t);
  }
  let last = 0;
  function loop(now) {
    st.raf = requestAnimationFrame(loop);
    if (!st.scene) return;
    if (st.playing && !st.rec) {
      const dt = last ? (now - last) / 1000 : 0;
      let tm = st.t + dt * Number(speedSel.value) * 60;
      if (tm >= st.T) { tm = st.T; st.playing = false; labelsNow(); }
      setTime(tm);
    }
    last = now;
    if (!st.rec) st.scene.render(now / 1000);
  }

  playBtn.addEventListener("click", () => { if (!st.run) return; if (st.t >= st.T) setTime(0); st.playing = !st.playing; labelsNow(); });
  slider.addEventListener("input", () => { st.playing = false; labelsNow(); setTime(Number(slider.value) / 1000 * st.T); });
  exagSel.addEventListener("change", () => { st.scene?.setExaggeration(Number(exagSel.value)); if (st.run?.markers) st.scene.setMarkers(st.run.markers); setTime(st.t); });
  recBtn.addEventListener("click", () => video());
  window.addEventListener("resize", () => st.scene?.resize());

  function legend() {
    if (st.hz === "flood") return [{ color: "#79c8f0", label: t("s3_lg_shallow") }, { color: "#0a2e8c", label: t("s3_lg_deep") }];
    if (st.hz === "fire") return [{ color: "#ffb21a", label: t("s3_lg_front") }, { color: "#141210", label: t("s3_lg_burned") }, { color: "#ff3b30", label: t("s3_lg_ign") }];
    return [{ color: "#ee8c2e", label: t("s3_lg_emit") }, { color: "#dbad6b", label: t("s3_lg_dust") }];
  }
  function renderLegend() {
    return el("div", { class: "aoi-legend s3-legend" }, ...legend().map((l) => el("span", { class: "check" }, el("i", { style: `background:${l.color}` }), el("span", { text: l.label }))));
  }

  async function video() {
    if (!st.run || st.rec) return;
    if (!pickFormat()) { setStatus(t("s3_rec_none"), true); return; }
    st.playing = false; labelsNow();
    const ctl = new AbortController();
    st.rec = ctl;
    recBtn.disabled = true;
    working(true);
    const secs = Math.max(8, Math.min(40, st.T / 60 / Number(speedSel.value)));
    try {
      const { blob, ext } = await record({
        src: st.scene.renderer.domElement, seconds: secs, signal: ctl.signal,
        frame: (f) => { setTime(f * st.T); st.scene.render(performance.now() / 1000); },
        labels: () => ({ title: `${t("s3_title_" + st.hz)} · ${st.run.place}`, time: clockText(st.run.day, st.run.offset + st.t) + " " + t("s3_tz"), legend: legend(), warning: t("s3_warn_short"), note: st.run.note }),
        onProgress: (f) => setStatus(fill(t("s3_recording"), { p: Math.round(100 * f) })),
      });
      save(blob, `mongolia_${st.hz}_3d_${st.run.day}.${ext}`);
      setStatus(fill(t("s3_rec_done"), { ext: ext.toUpperCase() }));
    } catch (e) {
      console.error(e);
      setStatus(t("s3_err") + (e.message === "no_recorder" ? t("s3_rec_none") : e.message), true);
    }
    st.rec = null; recBtn.disabled = false;
    working(false);
  }

  function close() {
    st.token++;
    st.playing = false; st.rec?.abort();
    cancelAnimationFrame(st.raf);
    st.scene?.dispose(); st.scene = null; st.run = null;
    working(false);
    root.hidden = true;
  }

  /** Common inputs: grid, ground, satellite picture, weather. */
  async function base(box, day, days, token) {
    const g = grid3d(box);
    const { z, cover } = await terrain(g, (k) => token === st.token && setStatus(t("s3_step_" + k)));
    if (token !== st.token) return null;
    setStatus(t("s3_step_sat"));
    const sat = await backdrop(g, addDays(day, -20), day).catch(() => null);
    if (token !== st.token) return null;
    setStatus(t("s3_step_weather"));
    const wx = await weatherAt(boxOf(g), day, days);
    const fields = hourlyFields(wx, g);
    return { g, z, cover, sat, wx, fields };
  }

  function showScene(b) {
    st.scene?.dispose();
    st.scene = createScene(view, { north: t("s3_north") });
    st.scene.resize();
    // flat ground (most of the steppe and the Gobi) shows no shape at its true height: raise it until the relief reads
    let zmin = Infinity, zmax = -Infinity; for (const v of b.z) { if (v < zmin) zmin = v; if (v > zmax) zmax = v; }
    const m = cellMetres(b.g), x = autoExaggeration(zmax - zmin, Math.max(b.g.w * m.x, b.g.h * m.y));
    exagSel.value = String(x);
    st.exagNote = x > 2 ? fill(t("s3_exag_auto"), { x }) : "";
    st.scene.setExaggeration(x);
    st.scene.setGround(b.g, b.z, b.sat?.canvas ?? null);
    view.onclick = (ev) => { if (st.picking) pickIgnition(ev); };
  }

  function lines(list) {
    const l = list.filter(Boolean);
    if (st.exagNote) l.splice(1, 0, el("p", { class: "note", text: st.exagNote }));
    info.replaceChildren(...l);
  }
  const p = (text, cls = "note") => el("p", { class: cls, text });

  // ---------- flood
  async function runFlood(b, token) {
    const ctx = floatContext();
    const ground = ctx ? { g: b.g, z: b.z, cover: b.cover, f: 1 } : coarsen(b.g, b.z, b.cover, LIMITS.cpuSide);
    const m = cellMetres(ground.g), inputs = inputSeries(b.fields), rates = runoffRates(ground.g, ground.cover, b.fields.plan, inputs);
    const hours = Math.min(FLOOD3D.hours, b.fields.hours);
    let runoff = 0;
    const rateOf = (h) => { const r = rates(h); let s = 0; for (const v of r) s += v; runoff += s / r.length * 3600 * 1000; return r; };
    const note = ctx ? "" : " " + fill(t("s3_step_flood_cpu"), { s: Math.round(ground.g.scale) });
    const tick = async (h, n) => { if (token === st.token) setStatus(fill(t("s3_step_flood"), { h, n }) + note); await new Promise((r) => setTimeout(r, 0)); };
    const args = { z: ground.z, cover: ground.cover, w: ground.g.w, h: ground.g.h, dx: m.x, dy: m.y, rateOf, hours, tick };
    let res = ctx ? await runGpu({ ...args, ctx }) : null;
    if (!res) res = await runCpu(args);
    if (token !== st.token) return;
    let rain = 0; for (let h = 0; h < hours; h++) { const a = inputs[h]; rain += a.reduce((x, y) => x + y, 0) / a.length; }
    const deep = depthByte(0.1), cellKm2 = m.x * m.y / 1e6;
    let peakKm2 = 0, maxB = 0;
    for (const f of res.frames) { let k = 0; for (const v of f) { if (v >= deep) k++; if (v > maxB) maxB = v; } peakKm2 = Math.max(peakKm2, k * cellKm2); }
    st.scene.setFlood(res.frames, ground.g.w, ground.g.h);
    st.T = hours * 60;
    st.run = { ...st.run, offset: 0, note: fill(t("s3_grid"), { s: Math.round(ground.g.scale) }) };
    lines([
      p(fill(t("s3_r_flood"), { h: hours, rain: rain.toFixed(1), run: runoff.toFixed(1), a: peakKm2.toFixed(2), d: byteDepth(maxB).toFixed(2) }), "s3-res"),
      p(fill(t("s3_grid"), { s: Math.round(ground.g.scale) }) + ` · ${ground.g.w}×${ground.g.h} · ${res.gpu ? t("s3_gpu") : t("s3_cpu")} · ${t("s3_wx_" + b.wx.source)}`),
      renderLegend(), p(t("s3_m_flood")), p(t("s3_l_flood")), p(t("s3_warn"), "note s3-warn"), p(t("s3_src"), "note small"),
    ]);
  }

  // ---------- fire
  let fireBase = null;
  function pickIgnition(ev) {
    const ll = st.scene?.pick(ev);
    if (!ll || !fireBase) return;
    st.picking = false;
    root.classList.remove("s3-picking");
    const i = cellOf(fireBase.g, ll.lat, ll.lon);
    const hour = Number(root.querySelector(".s3-hour")?.value ?? 12);
    spreadFrom({ source: "click", resolution: fireBase.g.scale, cells: [i], points: [ll], hour, count: 1 });
  }
  function fireControls(extra = []) {
    const hourSel = el("select", { class: "field s3-sel s3-hour" }, ...Array.from({ length: 24 }, (_, h) => el("option", { value: String(h), text: `${pad(h)}:00`, selected: h === 12 })));
    return el("div", { class: "s3-fire-ctl" }, ...extra,
      el("label", { class: "s3-lab" }, el("span", { text: t("s3_ign_hour") }), hourSel),
      el("button", { type: "button", class: "btn", text: t("s3_ign_click"), onclick: () => { st.picking = true; root.classList.add("s3-picking"); setStatus(t("s3_ign_pick")); } }));
  }
  function spreadFrom(ign) {
    const b = fireBase, token = st.token;
    setStatus(t("s3_step_fire"));
    setTimeout(() => {
      if (token !== st.token) return;
      const startHour = Math.max(0, Math.floor(ign.hour));
      const hours = Math.max(1, Math.min(LIMITS.fireHours, b.fields.hours - startHour));
      const month = Number(b.day.slice(5, 7));
      const res = spreadFire({ g: b.g, z: b.z, cover: b.cover, fields: b.fields, ignition: ign.cells, month, hours, startHour });
      st.scene.setFire(res.arrival, b.g.w, b.g.h);
      st.run = { ...st.run, offset: startHour * 60, markers: ign.points, note: t("s3_src_" + ign.source) };
      st.scene.setMarkers(ign.points);
      st.T = hours * 60;
      let maxRos = 0, maxI = 0;
      for (let i = 0; i < res.arrival.length; i++) if (Number.isFinite(res.arrival[i])) { maxRos = Math.max(maxRos, res.headRos[i]); maxI = Math.max(maxI, res.fli[i]); }
      const when = clockText(b.day, startHour * 60);
      lines([
        p(fill(t("s3_ign_from"), { src: t("s3_src_" + ign.source), n: ign.count, time: when }), "s3-res"),
        p(fill(t("s3_r_fire"), { h: hours, a: burnedKm2(b.g, res.arrival, hours * 60).toFixed(2), r: maxRos.toFixed(1), i: Math.round(maxI) }), "s3-res"),
        fireControls(),
        p(fill(t("s3_grid"), { s: Math.round(b.g.scale) }) + ` · ${b.g.w}×${b.g.h} · ${t("s3_wx_" + b.wx.source)}`),
        renderLegend(), p(t("s3_m_fire")), p(t("s3_l_fire")), p(t("s3_warn"), "note s3-warn"), p(t("s3_src"), "note small"),
      ]);
      setTime(0);
      setStatus(t("s3_ready"));
    }, 30);
  }
  async function runFire(b, token) {
    fireBase = b;
    const ign = await findIgnition(b.g, b.cover, b.day, (k) => token === st.token && setStatus(t("s3_step_" + k)));
    if (token !== st.token) return false;
    if (!ign.cells.length) {
      st.T = 0;
      lines([p(t("s3_ign_none"), "s3-res"), fireControls(), renderLegend(), p(t("s3_m_fire")), p(t("s3_warn"), "note s3-warn")]);
      setStatus(t("s3_ign_pick"));
      st.picking = true; root.classList.add("s3-picking");
      return false;
    }
    spreadFrom(ign);
    return false;
  }

  // ---------- dust
  /** The caption when no dust rises: only the reasons that held, then how this differs from the map score. */
  function quietLines(q, n) {
    const ul = (s) => s.charAt(0).toUpperCase() + s.slice(1), why = [];
    if (!q.source) why.push(t("s3_q_nosrc"));
    else {
      const u = q.threshold.toFixed(1);
      if (q.maxWind !== null && q.maxWind <= q.threshold) why.push(fill(t("s3_q_calm"), { w: q.maxWind.toFixed(1), t: q.maxWindTime.replace("T", " "), u }));
      if (q.blockedWindyHours) why.push(fill(t("s3_q_blocked"), { u, k: q.blockedWindyHours }));
      if (q.wetDays.length) why.push(fill(t("s3_q_wet"), { d: q.wetDays.join(", ") }));
      if (q.soilHours) why.push(fill(t("s3_q_soil"), { k: q.soilHours }));
      if (q.snowHours) why.push(fill(t("s3_q_snow"), { k: q.snowHours }));
    }
    const out = [p(fill(t("s3_r_dust_none"), { n }), "s3-res"), ...why.map((w) => p("• " + ul(w), "s3-res"))];
    if (q.source && q.maxGust !== null && q.maxGust > q.threshold && q.maxWind !== null && q.maxWind <= q.threshold) out.push(p(fill(t("s3_q_gust"), { g: q.maxGust.toFixed(1) })));
    out.push(p(t("s3_q_map"), "note"));
    return out;
  }
  async function runDust(b, token) {
    setStatus(t("s3_step_surface"));
    const sf = await surface(boxOf(b.g), b.day).catch(() => ({ land: null }));
    if (token !== st.token) return;
    if (!sf.land) { lines([p(t("s3_no_surface"), "s3-res"), p(t("s3_warn"), "note s3-warn")]); setStatus(t("s3_no_surface"), true); return; }
    // the 20-60 m ground classes onto the 3D grid
    const g = b.g, land = new Uint8Array(g.w * g.h);
    for (let r = 0; r < g.h; r++) for (let c = 0; c < g.w; c++) {
      const lat = g.north - (r + 0.5) * g.dy, lon = g.west + (c + 0.5) * g.dx;
      const rr = Math.floor((sf.grid.north - lat) / sf.grid.dy), cc = Math.floor((lon - sf.grid.west) / sf.grid.dx);
      land[r * g.w + c] = rr >= 0 && rr < sf.grid.h && cc >= 0 && cc < sf.grid.w ? sf.land[rr * sf.grid.w + cc] : LAND.none;
    }
    setStatus(t("s3_step_dust"));
    const em = emissions(g, land, b.fields), run = createDustRun(g, b.fields, em), sum = summary(b.fields, em);
    st.scene.setDust(em.perHour, g.w, g.h, run);
    st.T = Math.min(72, b.fields.hours) * 60;
    st.run = { ...st.run, offset: 0, note: fill(t("s3_grid"), { s: Math.round(g.scale) }) };
    const sh = landShares(sf.grid, sf.land), bare = ((sh.share[LAND.bare] ?? 0) + (sh.share[LAND.sparse] ?? 0)) * 100;
    lines([
      ...(sum.hours ? [p(fill(t("s3_r_dust"), { h: sum.hours, n: Math.round(st.T / 60), t: sum.peakHour.replace("T", " ") }), "s3-res")] : quietLines(quietReasons(g, land, b.fields, st.T / 60), Math.round(st.T / 60))),
      p(fill(t("s3_bare"), { p: Math.round(bare), d: sf.dates.join(", ") })),
      p(fill(t("s3_grid"), { s: Math.round(g.scale) }) + ` · ${g.w}×${g.h} · ${t("s3_wx_" + b.wx.source)}`),
      renderLegend(), p(t("s3_m_dust")), p(t("s3_l_dust")), p(t("s3_warn"), "note s3-warn"), p(t("s3_src"), "note small"),
    ]);
  }

  async function open(hz) {
    close();
    const token = ++st.token;
    st.hz = hz; st.T = 0; st.t = 0;
    root.hidden = false;
    title.textContent = t("s3_title_" + hz);
    fillSpeeds(); labelsNow(); info.replaceChildren(); clock.textContent = "";
    const box = getBox(), day = getDay();
    if (!box) { setStatus(t("s3_need_box"), true); return; }
    const km2 = boxAreaKm2(box);
    if (km2 > LIMITS.hardKm2) { setStatus(fill(t("s3_too_big"), { a: Math.round(km2), m: LIMITS.hardKm2 }), true); return; }
    st.raf = requestAnimationFrame(loop);
    working(true);
    try {
      const days = hz === "fire" ? 2 : 3;
      const b = await base(box, day, days, token);
      if (!b || token !== st.token) return;
      b.day = day;
      const c = { lat: (box.s + box.n) / 2, lon: (box.w + box.e) / 2 };
      st.run = { day, offset: 0, place: `${c.lat.toFixed(3)}°N ${c.lon.toFixed(3)}°E` };
      showScene(b);
      if (hz === "flood") await runFlood(b, token);
      else if (hz === "fire") await runFire(b, token);
      else await runDust(b, token);
      if (token !== st.token) return;
      setTime(0);
      if (st.T > 0) setStatus(t("s3_ready") + " " + t("s3_hint_mouse"));
    } catch (e) {
      console.error(e);
      if (token !== st.token) return;
      const key = { no_weather: "s3_err_weather", no_dem: "s3_err_dem" }[e.message];
      setStatus(key ? t(key) : t("s3_err") + e.message, true);
    } finally {
      if (token === st.token) working(false);
    }
  }

  return { open, close, get isOpen() { return !root.hidden; }, refreshText() { if (!root.hidden) { labelsNow(); title.textContent = t("s3_title_" + st.hz); } } };
}

export { GRID };
