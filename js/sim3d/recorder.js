/* The video of a 3D run: every frame of the 3D picture is copied onto a canvas that also carries the title, the time,
 * the legend and the words "model, not observation", and that canvas is recorded by the browser's own MediaRecorder.
 * MP4 (H.264) where the browser records it (Safari, recent Chrome and Edge), WebM otherwise (Firefox, older Chrome). */

/** The first container the browser can record, with its file extension. */
export function pickFormat(isSupported = (t) => typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported(t)) {
  for (const [type, ext] of [["video/mp4;codecs=avc1.42E01F", "mp4"], ["video/mp4", "mp4"], ["video/webm;codecs=vp9", "webm"], ["video/webm;codecs=vp8", "webm"], ["video/webm", "webm"]]) {
    if (isSupported(type)) return { type, ext };
  }
  return null;
}

/** Frame layout: the 3D picture fills the canvas, a band at the top holds the title and time, one at the bottom the
 * legend and the warning. */
export function compose(ctx, src, { title, time, legend = [], warning, note }) {
  const W = ctx.canvas.width, H = ctx.canvas.height, s = H / 720;
  ctx.fillStyle = "#0b0f13"; ctx.fillRect(0, 0, W, H);
  // keep the aspect of the 3D picture
  const k = Math.min(W / src.width, H / src.height), dw = src.width * k, dh = src.height * k;
  ctx.drawImage(src, (W - dw) / 2, (H - dh) / 2, dw, dh);
  ctx.fillStyle = "rgba(11,15,19,0.72)"; ctx.fillRect(0, 0, W, 64 * s);
  ctx.fillStyle = "#fff"; ctx.font = `600 ${24 * s}px system-ui, sans-serif`; ctx.textBaseline = "middle";
  ctx.fillText(title, 20 * s, 22 * s);
  ctx.font = `${20 * s}px system-ui, sans-serif`; ctx.fillStyle = "#ffd28a";
  ctx.fillText(time, 20 * s, 48 * s);
  if (note) { ctx.textAlign = "right"; ctx.fillStyle = "#cfd8e3"; ctx.font = `${16 * s}px system-ui, sans-serif`; ctx.fillText(note, W - 20 * s, 48 * s); ctx.textAlign = "left"; }
  const bh = 56 * s;
  ctx.fillStyle = "rgba(11,15,19,0.72)"; ctx.fillRect(0, H - bh, W, bh);
  let x = 20 * s;
  ctx.font = `${16 * s}px system-ui, sans-serif`;
  for (const { color, label } of legend) {
    ctx.fillStyle = color; ctx.fillRect(x, H - bh + 12 * s, 16 * s, 16 * s);
    ctx.fillStyle = "#fff"; ctx.fillText(label, x + 22 * s, H - bh + 20 * s);
    x += 22 * s + ctx.measureText(label).width + 18 * s;
  }
  ctx.fillStyle = "#ffb3a7"; ctx.font = `600 ${15 * s}px system-ui, sans-serif`;
  ctx.fillText(warning, 20 * s, H - 14 * s);
}

/**
 * Records `seconds` of video. Each frame calls `frame(f)` with f from 0 to 1 (the caller moves the run and renders),
 * then the 3D canvas `src` is composed with `labels(f)`. Resolves to {blob, ext}. `onProgress(f)` reports.
 */
export function record({ src, seconds = 24, fps = 30, width = 1280, height = 720, frame, labels, onProgress = () => {}, signal }) {
  const fmt = pickFormat();
  if (!fmt) return Promise.reject(new Error("no_recorder"));
  const canvas = document.createElement("canvas");
  canvas.width = width; canvas.height = height;
  const ctx = canvas.getContext("2d");
  const stream = canvas.captureStream(fps);
  const rec = new MediaRecorder(stream, { mimeType: fmt.type, videoBitsPerSecond: 8e6 });
  const chunks = [];
  rec.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
  return new Promise((resolve, reject) => {
    rec.onstop = () => resolve({ blob: new Blob(chunks, { type: fmt.type.split(";")[0] }), ext: fmt.ext });
    rec.onerror = (e) => reject(e.error ?? new Error("recorder"));
    const total = Math.round(seconds * fps);
    let k = 0, t0 = null;
    // frames are drawn on the screen's clock, so the video plays at the intended speed even if a frame is slow
    function tick(now) {
      if (signal?.aborted) { rec.stop(); return; }
      if (t0 === null) t0 = now;
      const f = Math.min(1, (now - t0) / 1000 / seconds);
      frame(f);
      compose(ctx, src, labels(f));
      k++;
      onProgress(f);
      if (f >= 1 || k > total * 3) { setTimeout(() => rec.stop(), 200); return; }
      requestAnimationFrame(tick);
    }
    rec.start(1000);
    requestAnimationFrame(tick);
  });
}
