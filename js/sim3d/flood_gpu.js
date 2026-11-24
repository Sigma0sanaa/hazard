/* The flood routing of js/sim3d/flood_sim.js on the graphics card (WebGL2 with float render targets), so a 30 m grid
 * of up to 1024 by 1024 cells runs in seconds to a minute. The steps and the formulas are the same as the CPU version
 * (tests/sim3d_flood.test.mjs checks that one; the page compares the two on a small case when asked, see check()).
 * Returns null where the card cannot render to float textures; the caller then uses the CPU on a coarser grid. */
import { FLOOD3D, MANNING } from "./flood_sim.js";

const VS = `#version 300 es
in vec2 p; void main() { gl_Position = vec4(p, 0.0, 1.0); }`;

const HEAD = `#version 300 es
precision highp float; precision highp int;
uniform highp sampler2D D; uniform highp sampler2D Z; uniform highp sampler2D N;
uniform highp sampler2D T; uniform int W; uniform int H; uniform float dx; uniform float dy;
#define dt texelFetch(T, ivec2(0, 0), 0).r
const float G = ${FLOOD3D.g.toFixed(4)}; const float HMIN = ${FLOOD3D.hMin};
float d(int c, int r) { return texelFetch(D, ivec2(c, r), 0).r; }
float z(int c, int r) { return texelFetch(Z, ivec2(c, r), 0).r; }
float n(int c, int r) { return texelFetch(N, ivec2(c, r), 0).r; }
float ghost(float ze, float zi, float s) { return ze - s * max(0.001, (zi - ze) / s); }
float face(float q, float ea, float za, float eb, float zb, float ha, float hb, float n2, float s) {
  float hf = max(ea, eb) - max(za, zb);
  if (hf <= HMIN) return 0.0;
  float nq = (q - G * hf * dt * (eb - ea) / s) / (1.0 + G * dt * n2 * abs(q) / pow(hf, 7.0 / 3.0));
  float cap = (nq > 0.0 ? ha : hb) * s / dt;
  return clamp(nq, -cap, cap);
}
out vec4 o;
`;

// flows on the w+1 vertical faces of each row (texture (w+1) x h)
const FX = HEAD + `uniform highp sampler2D Q;
void main() {
  int c = int(gl_FragCoord.x), r = int(gl_FragCoord.y);
  float q = texelFetch(Q, ivec2(c, r), 0).r, v;
  if (c == 0) { int i2 = W > 1 ? 1 : 0; float zb = ghost(z(0, r), z(i2, r), dx); float nn = n(0, r);
    v = min(0.0, face(q, zb, zb, z(0, r) + d(0, r), z(0, r), 0.0, d(0, r), nn * nn, dx)); }
  else if (c == W) { int a = W - 1, i2 = W > 1 ? W - 2 : W - 1; float zb = ghost(z(a, r), z(i2, r), dx); float nn = n(a, r);
    v = max(0.0, face(q, z(a, r) + d(a, r), z(a, r), zb, zb, d(a, r), 0.0, nn * nn, dx)); }
  else { int a = c - 1; float nn = 0.5 * (n(a, r) + n(c, r));
    v = face(q, z(a, r) + d(a, r), z(a, r), z(c, r) + d(c, r), z(c, r), d(a, r), d(c, r), nn * nn, dx); }
  o = vec4(v, 0.0, 0.0, 1.0);
}`;

// flows on the h+1 horizontal faces of each column (texture w x (h+1)); row 0 is the north edge
const FY = HEAD + `uniform highp sampler2D Q;
void main() {
  int c = int(gl_FragCoord.x), r = int(gl_FragCoord.y);
  float q = texelFetch(Q, ivec2(c, r), 0).r, v;
  if (r == 0) { int i2 = H > 1 ? 1 : 0; float zb = ghost(z(c, 0), z(c, i2), dy); float nn = n(c, 0);
    v = min(0.0, face(q, zb, zb, z(c, 0) + d(c, 0), z(c, 0), 0.0, d(c, 0), nn * nn, dy)); }
  else if (r == H) { int a = H - 1, i2 = H > 1 ? H - 2 : H - 1; float zb = ghost(z(c, a), z(c, i2), dy); float nn = n(c, a);
    v = max(0.0, face(q, z(c, a) + d(c, a), z(c, a), zb, zb, d(c, a), 0.0, nn * nn, dy)); }
  else { int a = r - 1; float nn = 0.5 * (n(c, a) + n(c, r));
    v = face(q, z(c, a) + d(c, a), z(c, a), z(c, r) + d(c, r), z(c, r), d(c, a), d(c, r), nn * nn, dy); }
  o = vec4(v, 0.0, 0.0, 1.0);
}`;

// depths from the divergence of the new flows plus the runoff
const FD = HEAD + `uniform highp sampler2D QX; uniform highp sampler2D QY; uniform highp sampler2D S;
void main() {
  int c = int(gl_FragCoord.x), r = int(gl_FragCoord.y);
  float div = (texelFetch(QX, ivec2(c, r), 0).r - texelFetch(QX, ivec2(c + 1, r), 0).r) / dx
            + (texelFetch(QY, ivec2(c, r), 0).r - texelFetch(QY, ivec2(c, r + 1), 0).r) / dy;
  o = vec4(max(0.0, d(c, r) + dt * (div + texelFetch(S, ivec2(c, r), 0).r)), 0.0, 0.0, 1.0);
}`;

// the largest wave speed sqrt(g h) + |u| over blocks of 8 by 8 cells (for the time step)
const FW = HEAD + `uniform highp sampler2D QX; uniform highp sampler2D QY;
void main() {
  int c0 = int(gl_FragCoord.x) * 8, r0 = int(gl_FragCoord.y) * 8; float m = 0.0;
  for (int j = 0; j < 8; j++) for (int i = 0; i < 8; i++) {
    int c = c0 + i, r = r0 + j; if (c >= W || r >= H) continue;
    float h = d(c, r); if (h <= HMIN) continue;
    float u = max(abs(texelFetch(QX, ivec2(c, r), 0).r), abs(texelFetch(QX, ivec2(c + 1, r), 0).r)) / h;
    float v = max(abs(texelFetch(QY, ivec2(c, r), 0).r), abs(texelFetch(QY, ivec2(c, r + 1), 0).r)) / h;
    m = max(m, sqrt(G * h) + length(vec2(u, v)));
  }
  o = vec4(m, 0.0, 0.0, 1.0);
}`;

// the largest value over blocks of 8 by 8 texels of a smaller texture, down to one texel
const FR = `#version 300 es
precision highp float; uniform highp sampler2D A; uniform ivec2 size; out vec4 o;
void main() {
  int c0 = int(gl_FragCoord.x) * 8, r0 = int(gl_FragCoord.y) * 8; float m = 0.0;
  for (int j = 0; j < 8; j++) for (int i = 0; i < 8; i++) { if (c0 + i < size.x && r0 + j < size.y) m = max(m, texelFetch(A, ivec2(c0 + i, r0 + j), 0).r); }
  o = vec4(m, 0.0, 0.0, 1.0);
}`;

// the step of this round from the largest wave speed, and the clock of the hour: (dt, t)
const FT = `#version 300 es
precision highp float; uniform highp sampler2D M; uniform highp sampler2D C; uniform float dmin; out vec4 o;
void main() {
  float wave = max(texelFetch(M, ivec2(0, 0), 0).r, sqrt(${FLOOD3D.g.toFixed(4)} * 0.01));
  float t = texelFetch(C, ivec2(0, 0), 0).g;
  float d = max(0.0, min(min(60.0, ${FLOOD3D.alpha} * dmin / wave), 3600.0 - t));
  o = vec4(d, t + d, 0.0, 1.0);
}`;

// depth as one byte (as depthByte of flood_sim.js) for the frames
const FB = HEAD + `void main() {
  float h = d(int(gl_FragCoord.x), int(gl_FragCoord.y));
  float b = h < 0.01 ? 0.0 : min(255.0, 1.0 + floor(254.0 * log(h / 0.01) / log(2000.0) + 0.5));
  o = vec4(b / 255.0, 0.0, 0.0, 1.0);
}`;

function compile(gl, type, src) {
  const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
  return s;
}
function program(gl, fs) {
  const p = gl.createProgram();
  gl.attachShader(p, compile(gl, gl.VERTEX_SHADER, VS)); gl.attachShader(p, compile(gl, gl.FRAGMENT_SHADER, fs));
  gl.bindAttribLocation(p, 0, "p"); gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
  return p;
}

/** A WebGL2 context that can render to 32-bit float textures, or null. */
export function floatContext(canvas = (typeof OffscreenCanvas !== "undefined" ? new OffscreenCanvas(1, 1) : document.createElement("canvas"))) {
  const gl = canvas.getContext("webgl2", { antialias: false, depth: false, preserveDrawingBuffer: false });
  if (!gl || !gl.getExtension("EXT_color_buffer_float")) return null;
  const max = gl.getParameter(gl.MAX_TEXTURE_SIZE);
  return { gl, max };
}

/** The whole run on the card. Same inputs and result as runCpu of flood_sim.js. */
export async function runGpu({ z, cover, w, h, dx, dy, rateOf, hours = FLOOD3D.hours, tick = async () => {}, ctx = floatContext() }) {
  if (!ctx || w + 1 > ctx.max || h + 1 > ctx.max) return null;
  const { gl } = ctx;
  const tex = (tw, th, data = null, fmt = "R32F") => {
    const t = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, t);
    for (const k of [gl.TEXTURE_MIN_FILTER, gl.TEXTURE_MAG_FILTER]) gl.texParameteri(gl.TEXTURE_2D, k, gl.NEAREST);
    for (const k of [gl.TEXTURE_WRAP_S, gl.TEXTURE_WRAP_T]) gl.texParameteri(gl.TEXTURE_2D, k, gl.CLAMP_TO_EDGE);
    if (fmt === "R32F") gl.texImage2D(gl.TEXTURE_2D, 0, gl.R32F, tw, th, 0, gl.RED, gl.FLOAT, data ?? new Float32Array(tw * th));
    else if (fmt === "RGBA32F") gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, tw, th, 0, gl.RGBA, gl.FLOAT, data ?? new Float32Array(tw * th * 4));
    else gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, tw, th, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    const fb = gl.createFramebuffer(); gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, t, 0);
    if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) throw new Error("framebuffer");
    return { t, fb, w: tw, h: th };
  };
  const nMan = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) nMan[i] = MANNING[cover[i]] ?? MANNING[0];
  const Zt = tex(w, h, Float32Array.from(z)), Nt = tex(w, h, nMan), St = tex(w, h);
  const Dt = [tex(w, h), tex(w, h)], QXt = [tex(w + 1, h), tex(w + 1, h)], QYt = [tex(w, h + 1), tex(w, h + 1)];
  const ww = Math.ceil(w / 8), wh = Math.ceil(h / 8), Wt = tex(ww, wh), Bt = tex(w, h, null, "RGBA8");
  // the chain that reduces the wave speeds to one texel
  const chain = [Wt];
  while (chain[chain.length - 1].w > 1 || chain[chain.length - 1].h > 1) { const l = chain[chain.length - 1]; chain.push(tex(Math.ceil(l.w / 8), Math.ceil(l.h / 8))); }
  const Ct = [tex(1, 1, null, "RGBA32F"), tex(1, 1, null, "RGBA32F")];
  const P = { fx: program(gl, FX), fy: program(gl, FY), fd: program(gl, FD), fw: program(gl, FW), fb: program(gl, FB), fr: program(gl, FR), ft: program(gl, FT) };
  const vb = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, vb);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
  gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
  gl.disable(gl.BLEND); gl.disable(gl.DEPTH_TEST);

  const loc = new Map();
  const u = (p, name) => { const k = p; if (!loc.has(k)) loc.set(k, {}); const m = loc.get(k); if (!(name in m)) m[name] = gl.getUniformLocation(p, name); return m[name]; };
  function draw(p, target, samplers, extra = () => {}) {
    gl.useProgram(p);
    gl.bindFramebuffer(gl.FRAMEBUFFER, target.fb); gl.viewport(0, 0, target.w, target.h);
    gl.uniform1i(u(p, "W"), w); gl.uniform1i(u(p, "H"), h); gl.uniform1f(u(p, "dx"), dx); gl.uniform1f(u(p, "dy"), dy);
    extra(p);
    Object.entries(samplers).forEach(([name, t], k) => { gl.activeTexture(gl.TEXTURE0 + k); gl.bindTexture(gl.TEXTURE_2D, t.t); gl.uniform1i(u(p, name), k); });
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }
  let a = 0, k = 0; // index of the current depth and flows, of the current clock
  const bytes = new Uint8Array(w * h * 4);
  function frame() {
    draw(P.fb, Bt, { D: Dt[a], Z: Zt, N: Nt, T: Ct[k] });
    gl.bindFramebuffer(gl.FRAMEBUFFER, Bt.fb);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, bytes);
    const f = new Uint8Array(w * h); for (let i = 0; i < w * h; i++) f[i] = bytes[i * 4];
    return f;
  }
  const clockBuf = new Float32Array(4);
  function clock() { gl.bindFramebuffer(gl.FRAMEBUFFER, Ct[k].fb); gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.FLOAT, clockBuf); return clockBuf[1]; }
  function stepGpu() {
    // the time step from the largest wave speed of the present state, all on the card
    draw(P.fw, Wt, { D: Dt[a], Z: Zt, N: Nt, QX: QXt[a], QY: QYt[a], T: Ct[k] });
    for (let l = 1; l < chain.length; l++) draw(P.fr, chain[l], { A: chain[l - 1] }, (p) => gl.uniform2i(u(p, "size"), chain[l - 1].w, chain[l - 1].h));
    const kn = 1 - k;
    draw(P.ft, Ct[kn], { M: chain[chain.length - 1], C: Ct[k] }, (p) => gl.uniform1f(u(p, "dmin"), Math.min(dx, dy)));
    k = kn;
    const b = 1 - a;
    draw(P.fx, QXt[b], { D: Dt[a], Z: Zt, N: Nt, Q: QXt[a], T: Ct[k] });
    draw(P.fy, QYt[b], { D: Dt[a], Z: Zt, N: Nt, Q: QYt[a], T: Ct[k] });
    draw(P.fd, Dt[b], { D: Dt[a], Z: Zt, N: Nt, QX: QXt[b], QY: QYt[b], S: St, T: Ct[k] });
    a = b;
  }
  const frames = [frame()], every = FLOOD3D.frameMinutes * 60;
  let steps = 0;
  for (let hr = 0; hr < hours; hr++) {
    gl.bindTexture(gl.TEXTURE_2D, St.t);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, w, h, gl.RED, gl.FLOAT, rateOf(hr));
    gl.bindTexture(gl.TEXTURE_2D, Ct[k].t);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, 1, 1, gl.RGBA, gl.FLOAT, new Float32Array(4)); // the hour starts at 0
    // steps after the end of the hour have dt = 0 and change nothing, so the clock is read only every 32 steps
    for (;;) {
      for (let j = 0; j < 32; j++) { stepGpu(); steps++; }
      if (clock() >= 3600 - 1e-3) break;
    }
    if (((hr + 1) * 3600) % every === 0) frames.push(frame());
    await tick(hr + 1, hours);
  }
  // the final state, for the totals and checks
  const depth = new Float32Array(w * h);
  gl.bindFramebuffer(gl.FRAMEBUFFER, Dt[a].fb);
  const rgba = new Float32Array(w * h * 4);
  gl.readPixels(0, 0, w, h, gl.RGBA, gl.FLOAT, rgba);
  for (let i = 0; i < w * h; i++) depth[i] = rgba[i * 4];
  for (const t of [Zt, Nt, St, Bt, ...chain, ...Ct, ...Dt, ...QXt, ...QYt]) { gl.deleteTexture(t.t); gl.deleteFramebuffer(t.fb); }
  return { frames, depth, steps, gpu: true };
}
