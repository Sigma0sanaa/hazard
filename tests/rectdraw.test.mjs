/* Drawing the area box with a mouse and with a finger (js/rectdraw.js). check() is plain JavaScript so it also runs in a
 * browser where Node is not installed; the map and its container are stand-ins. */
import { initRectDraw } from "../js/rectdraw.js";
import { U } from "../js/ui_text.js";

/** A map of 1 pixel per 0.01 degree with the corner at 100 E, 50 N, and a container that takes pointer events. */
function stage(coarse) {
  const box = new EventTarget(), classes = new Set(), done = [], modes = [];
  Object.assign(box, {
    getBoundingClientRect: () => ({ left: 0, top: 0 }), setPointerCapture() {}, closest: () => null,
    classList: { add: (c) => classes.add(c), remove: (c) => classes.delete(c), toggle: (c, on) => (on ? classes.add(c) : classes.delete(c)) },
  });
  const drag = { on: true, enable() { this.on = true; }, disable() { this.on = false; } };
  const bounds = (a, b) => ({ getSouth: () => Math.min(a.lat, b.lat), getNorth: () => Math.max(a.lat, b.lat), getWest: () => Math.min(a.lng, b.lng), getEast: () => Math.max(a.lng, b.lng) });
  const L = { latLngBounds: bounds, rectangle: (b) => ({ b, addTo() { return this; }, remove() { return this; }, setBounds(x) { this.b = x; }, getBounds() { return this.b; } }) };
  const map = { getContainer: () => box, dragging: drag, boxZoom: { disable() {} }, panBy() {}, containerPointToLatLng: ([x, y]) => ({ lat: 50 - y / 100, lng: 100 + x / 100 }) };
  const env = { L, matchMedia: () => ({ matches: coarse }), addEventListener() {} };
  const rect = initRectDraw(map, { onDone: (b) => done.push(b), onMode: (m) => modes.push(m), env });
  const fire = (type, x, y, id = 1) => box.dispatchEvent(Object.assign(new Event(type, { cancelable: true }), { pointerType: coarse ? "touch" : "mouse", button: 0, pointerId: id, clientX: x, clientY: y }));
  const line = () => { fire("pointerdown", 100, 100); fire("pointermove", 140, 130); fire("pointermove", 200, 180); };
  return { rect, done, modes, classes, drag, fire, line };
}

export function check() {
  const out = [];
  const yes = (name, cond) => out.push({ name, got: cond, want: true, ok: cond === true });

  const m = stage(false);
  yes("a mouse starts in draw mode", m.rect.mode === "draw" && !m.drag.on);
  m.line(); m.fire("pointerup", 200, 180);
  yes("a drag draws the box", m.done.length === 1 && m.done[0].w === 101 && m.done[0].e === 102 && m.done[0].n === 49 && Math.abs(m.done[0].s - 48.2) < 1e-9);
  yes("a mouse stays in draw mode", m.rect.mode === "draw");

  const f = stage(true);
  yes("a finger starts in move mode, the map moves", f.rect.mode === "move" && f.drag.on && f.rect.touch === true);
  f.line(); f.fire("pointerup", 200, 180);
  yes("in move mode a finger draws nothing", f.done.length === 0);
  f.rect.toggle();
  yes("the button turns drawing on", f.rect.mode === "draw" && !f.drag.on && f.classes.has("is-draw"));
  f.line(); f.fire("pointerup", 200, 180);
  yes("then a finger draws the box", f.done.length === 1);
  yes("and the next finger moves the map again", f.rect.mode === "move" && f.drag.on && f.modes.at(-1) === "move");
  f.rect.toggle(); f.fire("pointerdown", 100, 100); f.fire("pointerup", 101, 101);
  yes("a tap is not a box and drawing stays on", f.done.length === 1 && f.rect.mode === "draw");
  f.line(); f.fire("pointerdown", 300, 300, 2); f.fire("pointerup", 200, 180);
  yes("a second finger is a pinch, not a box", f.done.length === 1 && f.rect.mode === "draw");
  f.line(); f.fire("pointercancel", 200, 180);
  yes("a gesture the browser takes away leaves no box", f.done.length === 1);
  for (const l of ["mn", "en"]) yes(`${l} says it for a finger`, Boolean(U[l].touch_draw && U[l].touch_drawing));
  return out;
}

if (typeof process !== "undefined" && process.versions?.node) {
  const { default: test } = await import("node:test");
  const { default: assert } = await import("node:assert/strict");
  const { readFileSync } = await import("node:fs");
  test("drawing the area box", () => assert.deepEqual(check().filter((r) => !r.ok), []));
  test("in draw mode the browser must not take the finger for scrolling", () => {
    // Leaflet leaves touch-action at pan-x pan-y once its own dragging is off, and the browser then cancels the pointer
    const css = readFileSync(new URL("../css/app.css", import.meta.url), "utf8");
    assert.match(css, /#map\.is-draw\s*\{[^}]*touch-action:\s*none/);
  });
}
