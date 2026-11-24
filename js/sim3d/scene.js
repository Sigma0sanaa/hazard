/* The 3D picture: the ground of the drawn area from the DEM, the clearest Sentinel-2 picture laid on it, and the hazard
 * of the moment drawn by the ground's own shader (water depth, the fire's arrival time, where dust rises) plus the
 * dust particles. The ground stands as a block with earth walls; latitude and longitude are written on its four sides
 * on labels that always face the viewer. One world unit is one metre; x grows east, z grows south, y is height times
 * the exaggeration. */
import * as THREE from "../../vendor/three/three.module.min.js";
import { OrbitControls } from "../../vendor/three/OrbitControls.js";
import { cellMetres } from "./inputs.js";

const VERT = `
uniform sampler2D uFA; uniform sampler2D uFB; uniform float uMix; uniform float uExag; uniform int uMode;
varying vec2 vUv; varying vec3 vN; varying float vDepth; varying vec3 vPos;
float depthOf(float b) { return b < 0.5 / 255.0 ? 0.0 : 0.01 * exp((b * 255.0 - 1.0) / 254.0 * log(2000.0)); }
void main() {
  vUv = uv; vN = normalize(mat3(modelMatrix) * normal); // world normal: the sun stays put while the camera turns
  vec3 p = position; vDepth = 0.0;
  if (uMode == 1) {
    vec2 t = vec2(uv.x, 1.0 - uv.y);
    vDepth = mix(depthOf(texture2D(uFA, t).r), depthOf(texture2D(uFB, t).r), uMix);
    p.y += vDepth * uExag;
  }
  vPos = (modelMatrix * vec4(p, 1.0)).xyz;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
}`;

const FRAG = `
uniform sampler2D uSat; uniform bool uHasSat; uniform int uMode; uniform float uClock;
uniform sampler2D uFA; uniform sampler2D uFB; uniform float uMix;
uniform sampler2D uArr; uniform float uT; uniform float uFront;
uniform sampler2D uEA; uniform sampler2D uEB;
uniform vec3 uSun;
varying vec2 vUv; varying vec3 vN; varying float vDepth; varying vec3 vPos;
float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
void main() {
  vec3 base = uHasSat ? texture2D(uSat, vUv).rgb : vec3(0.62, 0.58, 0.48);
  float light = 0.5 + 0.65 * max(dot(normalize(vN), normalize(uSun)), 0.0);
  vec3 col = base * light;
  vec2 t = vec2(vUv.x, 1.0 - vUv.y);
  if (uMode == 1 && vDepth > 0.01) {
    float k = clamp(log(vDepth / 0.01) / log(300.0), 0.0, 1.0);
    vec3 water = mix(vec3(0.45, 0.80, 0.95), vec3(0.03, 0.18, 0.55), k);
    float ripple = 0.06 * sin(vPos.x * 0.05 + uClock * 2.0) * sin(vPos.z * 0.04 - uClock * 1.6);
    col = mix(col, water * (0.9 + ripple + 0.25 * light), 0.55 + 0.4 * k);
  }
  if (uMode == 2) {
    float a = texture2D(uArr, t).r;
    if (a <= uT) {
      float since = uT - a;
      if (since < uFront) {
        float f = 1.0 - since / uFront;
        float flicker = 0.75 + 0.25 * sin(uClock * 12.0 + hash(floor(vPos.xz / 15.0)) * 6.28);
        col = mix(col * 0.35, vec3(1.0, 0.45 + 0.4 * f, 0.05) * (1.2 + 0.6 * f) * flicker, 0.85);
      } else col = mix(col, vec3(0.08, 0.07, 0.06), 0.8);
    }
  }
  if (uMode == 3) {
    float e = mix(texture2D(uEA, t).r, texture2D(uEB, t).r, uMix);
    if (e > 0.0) col = mix(col, vec3(0.93, 0.50, 0.15), 0.08 + 0.32 * e);
  }
  gl_FragColor = vec4(col, 1.0);
}`;

/** Labels of a graticule from a to b: about n round values, and the decimals they need. */
export function ticks(a, b, n = 4) {
  const raw = (b - a) / n;
  if (!(raw > 0)) return { step: 0, digits: 0, values: [] };
  const p = 10 ** Math.floor(Math.log10(raw)), step = [1, 2, 2.5, 5, 10].map((m) => m * p).find((x) => x >= raw * 0.999);
  let digits = Math.max(0, Math.ceil(-Math.log10(step) - 1e-9));
  if (Math.abs(step * 10 ** digits - Math.round(step * 10 ** digits)) > 1e-6) digits++;
  const values = [];
  for (let k = Math.ceil(a / step - 1e-9); k * step <= b + 1e-9; k++) values.push(+(k * step).toFixed(digits));
  return { step, digits, values };
}

/** Exaggeration that lets flat ground show its shape: relief about 7% of the width, from the given choices. */
export function autoExaggeration(relief, span, choices = [1, 2, 3, 5, 10]) {
  const want = 0.07 * span / Math.max(relief, 1);
  return choices.filter((x) => x <= want).pop() ?? choices[0];
}

/** A text label drawn on a canvas, as a sprite that faces the camera and keeps its size on the screen. */
function label(text, { color = "#f2f5f8", bg = "rgba(11,15,19,0.78)", border = "rgba(255,255,255,0.28)", px = 12.5, bold = false } = {}) {
  const dpr = 2, c = document.createElement("canvas"), x = c.getContext("2d");
  const font = `${bold ? 700 : 600} ${px * dpr}px system-ui, -apple-system, "Segoe UI", sans-serif`;
  x.font = font;
  const w = Math.ceil(x.measureText(text).width + 14 * dpr), h = Math.ceil(px * dpr * 1.75);
  c.width = w; c.height = h;
  x.font = font;
  const r = h / 2;
  x.beginPath(); x.moveTo(r, 1); x.lineTo(w - r, 1); x.arc(w - r, r, r - 1, -Math.PI / 2, Math.PI / 2); x.lineTo(r, h - 1); x.arc(r, r, r - 1, Math.PI / 2, -Math.PI / 2); x.closePath();
  x.fillStyle = bg; x.fill(); x.lineWidth = dpr; x.strokeStyle = border; x.stroke();
  x.fillStyle = color; x.textAlign = "center"; x.textBaseline = "middle"; x.fillText(text, w / 2, h / 2 + dpr * 0.5);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace; tex.minFilter = THREE.LinearFilter; tex.generateMipmaps = false;
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, sizeAttenuation: false, depthTest: false, depthWrite: false, transparent: true }));
  s.renderOrder = 10;
  s.userData.px = [w / dpr, h / dpr];
  return s;
}

/** A vertical gradient for the sky behind the block. */
function skyTexture() {
  const c = document.createElement("canvas"); c.width = 2; c.height = 256;
  const x = c.getContext("2d"), g = x.createLinearGradient(0, 0, 0, 256);
  g.addColorStop(0, "#35506b"); g.addColorStop(0.55, "#16212c"); g.addColorStop(1, "#0b0f13");
  x.fillStyle = g; x.fillRect(0, 0, 2, 256);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/** A soft dark patch under the block, so it stands on something. */
function shadowTexture() {
  const c = document.createElement("canvas"); c.width = c.height = 128;
  const x = c.getContext("2d"), g = x.createRadialGradient(64, 64, 10, 64, 64, 64);
  g.addColorStop(0, "rgba(0,0,0,0.55)"); g.addColorStop(1, "rgba(0,0,0,0)");
  x.fillStyle = g; x.fillRect(0, 0, 128, 128);
  return new THREE.CanvasTexture(c);
}

const dataTex = (data, w, h, type = THREE.UnsignedByteType) => {
  const t = new THREE.DataTexture(data, w, h, THREE.RedFormat, type);
  t.minFilter = t.magFilter = type === THREE.FloatType ? THREE.NearestFilter : THREE.LinearFilter;
  t.needsUpdate = true;
  return t;
};

export function createScene(parent, { north = "N" } = {}) {
  const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
  renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
  parent.append(renderer.domElement);
  const scene = new THREE.Scene();
  scene.background = skyTexture();
  scene.fog = new THREE.Fog(0x0b0f13, 1e5, 4e5);
  const camera = new THREE.PerspectiveCamera(45, 1, 10, 1e6);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true; controls.maxPolarAngle = Math.PI * 0.49;
  const blank = dataTex(new Uint8Array([0]), 1, 1), blankF = dataTex(new Float32Array([1e9]), 1, 1, THREE.FloatType);
  const uniforms = {
    uSat: { value: blank }, uHasSat: { value: false }, uMode: { value: 0 }, uClock: { value: 0 }, uExag: { value: 2 },
    uFA: { value: blank }, uFB: { value: blank }, uMix: { value: 0 }, uArr: { value: blankF }, uT: { value: 0 }, uFront: { value: 45 },
    uEA: { value: blank }, uEB: { value: blank }, uSun: { value: new THREE.Vector3(-0.55, 0.62, -0.55) }, // from the north-west, as on a shaded relief map
  };
  const material = new THREE.ShaderMaterial({ uniforms, vertexShader: VERT, fragmentShader: FRAG });
  let mesh = null, geo = null, ground = null, points = null, markers = new THREE.Group(), frame = new THREE.Group();
  scene.add(markers, frame);
  let viewH = 500;

  /** Height of the ground (metres above the lowest cell) at a grid position, bilinear. */
  function heightAt(px, py) {
    const { z, w, h, zmin } = ground;
    const c = Math.min(w - 1.001, Math.max(0, px - 0.5)), r = Math.min(h - 1.001, Math.max(0, py - 0.5));
    const c0 = Math.floor(c), r0 = Math.floor(r), fc = c - c0, fr = r - r0, i = r0 * w + c0;
    const a = z[i], b = z[i + (c0 + 1 < w ? 1 : 0)], cc = z[i + (r0 + 1 < h ? w : 0)], d = z[i + (r0 + 1 < h ? w : 0) + (c0 + 1 < w ? 1 : 0)];
    return (a * (1 - fc) * (1 - fr) + b * fc * (1 - fr) + cc * (1 - fc) * fr + d * fc * fr) - zmin;
  }

  function buildMesh() {
    const { w, h, W, H } = ground, exag = uniforms.uExag.value;
    const sx = Math.min(w - 1, 511), sy = Math.min(h - 1, 511);
    geo?.dispose();
    geo = new THREE.PlaneGeometry(W, H, Math.max(1, sx), Math.max(1, sy));
    geo.rotateX(-Math.PI / 2);
    const pos = geo.attributes.position, uv = geo.attributes.uv;
    for (let k = 0; k < pos.count; k++) {
      const px = uv.getX(k) * w, py = (1 - uv.getY(k)) * h;
      pos.setY(k, heightAt(px, py) * exag);
    }
    geo.computeVertexNormals();
    if (!mesh) { mesh = new THREE.Mesh(geo, material); scene.add(mesh); } else mesh.geometry = geo;
    buildFrame();
  }

  function clearFrame() {
    frame.traverse((o) => { if (!o.isSprite) o.geometry?.dispose(); o.material?.map?.dispose(); o.material?.dispose(); }); // sprites share one geometry
    frame.clear();
  }

  /** Earth walls on the four sides down to a base, the shadow under them, and the latitude and longitude labels. */
  function buildFrame() {
    clearFrame();
    const { g, w, h, W, H, mx, my } = ground, exag = uniforms.uExag.value, span = Math.max(W, H);
    const top = (px, py) => heightAt(px, py) * exag, base = -0.045 * span - 0.1 * (ground.zmax - ground.zmin) * exag;
    // walls: a strip along each edge, from the ground down to the base; darker below, shaded by the side the sun sees
    const sun = uniforms.uSun.value.clone().normalize(), soil = new THREE.Color("#7a5f42"), deep = new THREE.Color("#2b211a");
    const sides = [
      { n: [0, 0, -1], at: (f) => [f * w, 0], len: w }, // north
      { n: [1, 0, 0], at: (f) => [w, f * h], len: h }, // east
      { n: [0, 0, 1], at: (f) => [(1 - f) * w, h], len: w }, // south
      { n: [-1, 0, 0], at: (f) => [0, (1 - f) * h], len: h }, // west
    ];
    for (const sd of sides) {
      const k = Math.max(2, Math.min(512, Math.round(sd.len))), pos = new Float32Array((k + 1) * 6), col = new Float32Array((k + 1) * 6), idx = [];
      const shade = 0.45 + 0.55 * Math.max(0, sd.n[0] * sun.x + sd.n[2] * sun.z) + 0.2;
      for (let i = 0; i <= k; i++) {
        const [px, py] = sd.at(i / k), x = px * mx - W / 2, z = py * my - H / 2;
        pos.set([x, top(px, py), z, x, base, z], i * 6);
        col.set([soil.r * shade, soil.g * shade, soil.b * shade, deep.r * shade, deep.g * shade, deep.b * shade], i * 6);
        if (i < k) { const a = i * 2; idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2); }
      }
      const gg = new THREE.BufferGeometry();
      gg.setAttribute("position", new THREE.BufferAttribute(pos, 3)); gg.setAttribute("color", new THREE.BufferAttribute(col, 3)); gg.setIndex(idx);
      frame.add(new THREE.Mesh(gg, new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.DoubleSide })));
    }
    const bottom = new THREE.Mesh(new THREE.PlaneGeometry(W, H), new THREE.MeshBasicMaterial({ color: 0x1a1410, side: THREE.DoubleSide }));
    bottom.rotation.x = -Math.PI / 2; bottom.position.y = base;
    const shadow = new THREE.Mesh(new THREE.PlaneGeometry(W * 1.6, H * 1.6), new THREE.MeshBasicMaterial({ map: shadowTexture(), transparent: true, depthWrite: false }));
    shadow.rotation.x = -Math.PI / 2; shadow.position.y = base - 0.002 * span;
    frame.add(bottom, shadow);

    // the graticule: a white tick down each wall and a label just outside the edge, on all four sides
    const east = g.west + w * g.dx, south = g.north - h * g.dy, out = 0.035 * span, lift = 0.012 * span;
    // values right at a corner are left out: the labels of the two sides would sit on each other
    const inner = (t, a, b) => ({ ...t, values: t.values.filter((v) => Math.min(v - a, b - v) > 0.06 * (b - a)) });
    const lon = inner(ticks(g.west, east, 6), g.west, east), lat = inner(ticks(south, g.north, 6), south, g.north);
    const tickPts = [], add = (sp, x, y, z) => { sp.position.set(x, y, z); frame.add(sp); };
    for (const v of lon.values) {
      const px = (v - g.west) / g.dx, x = px * mx - W / 2, text = `${v.toFixed(lon.digits)}°E`;
      for (const [py, z, s] of [[0, -H / 2, -1], [h, H / 2, 1]]) {
        const y = top(px, py);
        tickPts.push(x, y, z, x, base, z, x, y, z, x, y, z + s * out * 0.6);
        add(label(text), x, y + lift, z + s * out);
      }
    }
    for (const v of lat.values) {
      const py = (g.north - v) / g.dy, z = py * my - H / 2, text = `${v.toFixed(lat.digits)}°N`;
      for (const [px, x, s] of [[0, -W / 2, -1], [w, W / 2, 1]]) {
        const y = top(px, py);
        tickPts.push(x, y, z, x, base, z, x, y, z, x + s * out * 0.6, y, z);
        add(label(text), x + s * out, y + lift, z);
      }
    }
    if (tickPts.length) {
      const lg = new THREE.BufferGeometry(); lg.setAttribute("position", new THREE.Float32BufferAttribute(tickPts, 3));
      const lines = new THREE.LineSegments(lg, new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.7 }));
      lines.renderOrder = 5; frame.add(lines);
    }
    // north, beyond the middle of the north side
    const n = label(north, { color: "#fff", bg: "rgba(214,48,39,0.92)", border: "rgba(255,255,255,0.7)", px: 14, bold: true });
    n.userData.keep = true;
    add(n, 0, top(w / 2, 0) + lift * 2, -H / 2 - out * 2.6);
    sizeLabels();
  }

  /** Labels that would cover each other on the screen: the nearer one stays (north always), the other is hidden. */
  const _v = new THREE.Vector3();
  function declutter() {
    const W = renderer.domElement.clientWidth || 800, taken = [];
    const list = [];
    for (const o of frame.children) {
      if (!o.isSprite) continue;
      _v.copy(o.position).project(camera);
      list.push({ o, x: (_v.x + 1) / 2 * W, y: (1 - _v.y) / 2 * viewH, front: _v.z < 1, d: o.userData.keep ? -1 : o.position.distanceToSquared(camera.position) });
    }
    list.sort((a, b) => a.d - b.d);
    for (const it of list) {
      const [pw, ph] = it.o.userData.px, r = [it.x - pw / 2 - 4, it.x + pw / 2 + 4, it.y - ph / 2 - 2, it.y + ph / 2 + 2];
      const hit = taken.some((q) => r[0] < q[1] && r[1] > q[0] && r[2] < q[3] && r[3] > q[2]);
      it.o.visible = it.front && !hit;
      if (it.o.visible) taken.push(r);
    }
  }

  /** Labels keep their size in screen pixels: a sprite without size attenuation is scaled by 2 px / (p11 · height). */
  function sizeLabels() {
    const k = 2 / (camera.projectionMatrix.elements[5] * viewH);
    frame.traverse((o) => { if (o.isSprite) o.scale.set(o.userData.px[0] * k, o.userData.px[1] * k, 1); });
  }

  return {
    renderer, camera, controls, scene,
    get exaggeration() { return uniforms.uExag.value; },
    /** Relief (metres) and width (metres) of the ground, for choosing the exaggeration. */
    get extent() { return ground ? { relief: ground.zmax - ground.zmin, span: Math.max(ground.W, ground.H) } : null; },
    /** The ground of grid g with elevations z (metres) and an optional satellite canvas. */
    setGround(g, z, sat) {
      const m = cellMetres(g);
      let zmin = Infinity, zmax = -Infinity; for (const v of z) { if (v < zmin) zmin = v; if (v > zmax) zmax = v; }
      ground = { g, z, w: g.w, h: g.h, W: g.w * m.x, H: g.h * m.y, mx: m.x, my: m.y, zmin, zmax };
      // the picture is shown as stored: the shader writes its colour straight out
      if (sat) { const t = new THREE.CanvasTexture(sat); t.anisotropy = 4; uniforms.uSat.value = t; uniforms.uHasSat.value = true; }
      else uniforms.uHasSat.value = false;
      buildMesh();
      const span = Math.max(ground.W, ground.H), relief = (zmax - zmin) * uniforms.uExag.value;
      // an oblique view from the south-west, low enough that the relief and the walls read as 3D
      camera.position.set(-0.55 * span, 0.42 * span + relief, 0.95 * span);
      controls.target.set(0, relief * 0.25, 0);
      controls.minDistance = span * 0.08; controls.maxDistance = span * 4;
      camera.far = span * 10; camera.updateProjectionMatrix();
      scene.fog.near = span * 2; scene.fog.far = span * 6;
      controls.update();
    },
    setExaggeration(x) { uniforms.uExag.value = x; if (ground) buildMesh(); },
    /** Flood frames: depth bytes, one per hour. */
    setFlood(frames, w, h) {
      uniforms.uMode.value = 1;
      const texs = frames.map((f) => dataTex(f, w, h));
      this._flood = texs;
    },
    setFire(arrival, w, h) {
      uniforms.uMode.value = 2;
      const a = new Float32Array(arrival.length);
      for (let i = 0; i < a.length; i++) a[i] = Number.isFinite(arrival[i]) ? arrival[i] : 1e9;
      uniforms.uArr.value = dataTex(a, w, h, THREE.FloatType);
    },
    /** Dust: emission per hour scaled to bytes, and the particle run. */
    setDust(perHour, w, h, run) {
      uniforms.uMode.value = 3;
      let peak = 0; for (const e of perHour) for (const v of e) if (v > peak) peak = v;
      this._dust = perHour.map((e) => dataTex(Uint8Array.from(e, (v) => (peak > 0 ? Math.round(255 * Math.sqrt(v / peak)) : 0)), w, h));
      const geom = new THREE.BufferGeometry();
      geom.setAttribute("position", new THREE.BufferAttribute(new Float32Array(run.x.length * 3), 3));
      geom.setAttribute("alpha", new THREE.BufferAttribute(new Float32Array(run.x.length), 1));
      const mat = new THREE.ShaderMaterial({
        transparent: true, depthWrite: false, uniforms: { uSpan: { value: Math.max(ground.W, ground.H) } },
        vertexShader: "uniform float uSpan; attribute float alpha; varying float vA; void main(){ vA = alpha; vec4 mv = modelViewMatrix * vec4(position, 1.0); gl_PointSize = clamp(4.0 * uSpan / -mv.z, 2.0, 14.0); gl_Position = projectionMatrix * mv; }",
        fragmentShader: "varying float vA; void main(){ vec2 d = gl_PointCoord - 0.5; float r = dot(d, d); if (r > 0.25) discard; gl_FragColor = vec4(0.86, 0.68, 0.42, vA * (1.0 - 4.0 * r)); }",
      });
      points?.geometry.dispose();
      if (points) scene.remove(points);
      points = new THREE.Points(geom, mat); points.frustumCulled = false; scene.add(points);
      this._run = run;
    },
    /** Moves the picture to time t (minutes from the start). */
    setTime(t) {
      uniforms.uT.value = t;
      const hr = t / 60;
      if (this._flood) { const k = Math.min(this._flood.length - 1, Math.floor(hr)); uniforms.uFA.value = this._flood[k]; uniforms.uFB.value = this._flood[Math.min(this._flood.length - 1, k + 1)]; uniforms.uMix.value = hr - k; }
      if (this._dust) { const k = Math.min(this._dust.length - 1, Math.floor(hr)); uniforms.uEA.value = this._dust[k]; uniforms.uEB.value = this._dust[Math.min(this._dust.length - 1, k + 1)]; uniforms.uMix.value = hr - k; }
      if (this._run && points) {
        this._run.advanceTo(t);
        const r = this._run, pos = points.geometry.attributes.position.array, al = points.geometry.attributes.alpha.array, exag = uniforms.uExag.value;
        const { W, H, mx, my } = ground;
        for (let s = 0; s < r.x.length; s++) {
          if (!r.alive[s]) { al[s] = 0; continue; }
          pos[s * 3] = r.x[s] - W / 2; pos[s * 3 + 2] = r.y[s] - H / 2;
          pos[s * 3 + 1] = (heightAt(r.x[s] / mx, r.y[s] / my) + r.z[s]) * exag;
          al[s] = 0.85 * Math.max(0.15, 1 - r.age[s] / (18 * 60));
        }
        points.geometry.attributes.position.needsUpdate = true; points.geometry.attributes.alpha.needsUpdate = true;
      }
    },
    /** Markers on the ground (ignition points), lat/lon. */
    setMarkers(list, color = 0xff3b30) {
      markers.clear();
      if (!ground) return;
      const { g, W, H, mx, my } = ground, span = Math.max(W, H), exag = uniforms.uExag.value;
      for (const p of list.slice(0, 200)) {
        const px = (p.lon - g.west) / g.dx, py = (g.north - p.lat) / g.dy;
        const cone = new THREE.Mesh(new THREE.ConeGeometry(span / 250, span / 60, 12), new THREE.MeshBasicMaterial({ color }));
        cone.rotation.x = Math.PI;
        cone.position.set(px * mx - W / 2, heightAt(px, py) * exag + span / 120, py * my - H / 2);
        markers.add(cone);
      }
    },
    /** The latitude and longitude under a pointer event, or null. */
    pick(ev) {
      if (!mesh) return null;
      const rect = renderer.domElement.getBoundingClientRect();
      const v = new THREE.Vector2(((ev.clientX - rect.left) / rect.width) * 2 - 1, -((ev.clientY - rect.top) / rect.height) * 2 + 1);
      const ray = new THREE.Raycaster(); ray.setFromCamera(v, camera);
      const hit = ray.intersectObject(mesh)[0];
      if (!hit) return null;
      const { g, W, H, mx, my } = ground;
      const px = (hit.point.x + W / 2) / mx, py = (hit.point.z + H / 2) / my;
      return { lat: g.north - py * g.dy, lon: g.west + px * g.dx };
    },
    resize() {
      const w = parent.clientWidth || 800, h = parent.clientHeight || 500;
      renderer.setSize(w, h, false); camera.aspect = w / h; camera.updateProjectionMatrix();
      viewH = h; sizeLabels();
    },
    render(clockSeconds) {
      uniforms.uClock.value = clockSeconds;
      controls.update();
      declutter();
      renderer.render(scene, camera);
    },
    clearHazard() { uniforms.uMode.value = 0; this._flood = null; this._dust = null; this._run = null; if (points) { scene.remove(points); points.geometry.dispose(); points = null; } markers.clear(); },
    dispose() { this.clearHazard(); clearFrame(); scene.background?.dispose?.(); geo?.dispose(); material.dispose(); renderer.dispose(); renderer.domElement.remove(); },
  };
}
