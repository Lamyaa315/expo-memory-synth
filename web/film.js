// Trip film: the visitor picks photos from their visit and gets a short vertical film.
// Opening: the camera flies through the 3D scene (or a title card if there's no scene.ply),
// then each photo with slow Ken Burns motion and an optional caption, then a closing card.
// Everything runs in the browser: photos never leave the device.
import * as THREE from 'three';
import * as GS from '@mkkellogg/gaussian-splats-3d';
import { findScene, CAMERA } from './scene-config.js';
import { makeFloorScene } from './stage.js';

// ---------- Film settings ----------
const W = 720, H = 1280;                                    // vertical 9:16, fits phones and stories
const FPS = 30;
const DUR = { intro: 6, photo: 4.5, fade: 1, outro: 4 };    // seconds
const MAX_PHOTOS = 12;
const AMBIENT_VOLUME = 0.5;
const FONT = '"Readex Pro", "Segoe UI", Tahoma, sans-serif';
const NIGHT = '#1D2440', STONE = '#E6E3DA', SAFFRON = '#D9A23A', MUTED = '#A9AFC7';

const $ = (id) => document.getElementById(id);
const canvas = $('film');
const ctx = canvas.getContext('2d');
const ambientEl = $('ambientAudio');

const clamp01 = (x) => Math.min(1, Math.max(0, x));
const lerp = (a, b, t) => a + (b - a) * t;
const ease = (t) => 0.5 - 0.5 * Math.cos(Math.PI * clamp01(t));
const nextFrame = () => new Promise((r) => requestAnimationFrame(r));

let photos = [];        // { img, tiny, thumb, caption, motion }
let viewer = null;      // GS.Viewer when scene.ply exists
let audio = null;       // { ctx, gain, dest }
let playing = null;     // { raf, resolve }
let resultUrl = null;
let mode = 'idle';      // 'idle' | 'playing' | 'recording'

// Arabic glyphs must be loaded before the canvas can draw them in Readex Pro
const fontsReady = Promise.all([
  document.fonts.load(`600 40px "Readex Pro"`, 'رحلة'),
  document.fonts.load(`300 30px "Readex Pro"`, 'رحلة'),
]).catch(() => {});

// ---------- 3D scene (optional) ----------
const sceneReady = (async () => {
  try {
    const url = await findScene();
    if (!url) return null;
    const v = new GS.Viewer({
      ...CAMERA,
      rootElement: $('sceneHost'),
      threeScene: makeFloorScene(),
      selfDrivenMode: false,           // we drive the camera and copy each frame into the film
      useBuiltInControls: false,
      ignoreDevicePixelRatio: true,    // render at exactly 720x1280
      sharedMemoryForWorkers: false,
    });
    await v.addSplatScene(url, { showLoadingUI: false, splatAlphaRemovalThreshold: 5 });
    return v;
  } catch (e) {
    console.warn('Scene not available for the film, using a title card instead.', e);
    return null;
  }
})();

const target = new THREE.Vector3(...CAMERA.initialCameraLookAt);
const up = new THREE.Vector3(...CAMERA.cameraUp).normalize();
const baseOffset = new THREE.Vector3(...CAMERA.initialCameraPosition).sub(target);
// Orbit around the starting angle saved in the editor, when there is one
fetch('hotspots.json', { cache: 'no-cache' }).then((r) => r.json()).then(({ start }) => {
  if (!start) return;
  target.fromArray(start.target);
  baseOffset.fromArray(start.position).sub(target);
}).catch(() => {});
const offset = new THREE.Vector3();

// With a corridor tour (tour.json), the opening walks the first stops of the filmed path instead of
// orbiting: the scan is only sharp near where it was filmed.
let walk = null;
fetch('tour.json', { cache: 'no-cache' }).then((r) => (r.ok ? r.json() : null)).then((tour) => {
  if (!tour?.stops?.length || tour.stops.length < 2) return;
  walk = { fov: tour.fov, stops: tour.stops.slice(0, 4).map((s) => ({
    position: new THREE.Vector3(...s.position), target: new THREE.Vector3(...s.target) })) };
}).catch(() => {});
const walkTarget = new THREE.Vector3();

function placeOnWalk(cam, t) {
  const segs = walk.stops.length - 1;
  const x = ease(t) * segs;
  const i = Math.min(segs - 1, Math.floor(x));
  const k = x - i;
  cam.position.lerpVectors(walk.stops[i].position, walk.stops[i + 1].position, k);
  walkTarget.lerpVectors(walk.stops[i].target, walk.stops[i + 1].target, k);
  cam.up.copy(up);
  cam.lookAt(walkTarget);
  if (walk.fov && cam.fov !== walk.fov + 10) { cam.fov = walk.fov + 10; cam.updateProjectionMatrix(); }
}

function drawScene(t) {
  const cam = viewer.camera;
  if (walk) {
    placeOnWalk(cam, t);
  } else {
    // Slow orbit around the look-at point while dollying in
    const e = ease(t);
    offset.copy(baseOffset).applyAxisAngle(up, lerp(-0.45, 0.45, e)).multiplyScalar(lerp(1.15, 0.85, e));
    cam.position.copy(target).add(offset);
    cam.up.copy(up);
    cam.lookAt(target);
  }
  viewer.update();
  viewer.render();
  // Same warm museum backdrop as the site, behind the transparent 3D frame
  const bg = ctx.createRadialGradient(W / 2, H * 0.38, 0, W / 2, H * 0.38, H * 0.75);
  bg.addColorStop(0, '#3d352b');
  bg.addColorStop(0.55, '#221d18');
  bg.addColorStop(1, '#110e0c');
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, W, H);
  ctx.drawImage(viewer.renderer.domElement, 0, 0, W, H);
}

// ---------- Photos ----------
function decode(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const im = new Image();
    im.onload = () => resolve({ im, url });
    im.onerror = () => { URL.revokeObjectURL(url); reject(new Error(`Could not read ${file.name}`)); };
    im.src = url;
  });
}

function scaled(source, w, h) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const g = c.getContext('2d');
  g.imageSmoothingQuality = 'high';
  g.drawImage(source, 0, 0, w, h);
  return c;
}

function randomMotion() {
  // Zoom stays above 1.06 so the small pan never reveals an edge
  const zoomIn = Math.random() < 0.6;
  const r = () => (Math.random() - 0.5) * 0.06;
  return { z0: zoomIn ? 1.06 : 1.18, z1: zoomIn ? 1.18 : 1.06, x0: r(), y0: r(), x1: r(), y1: r() };
}

async function loadPhoto(file) {
  const { im, url } = await decode(file);
  const s = Math.min(1, 1400 / Math.max(im.naturalWidth, im.naturalHeight));
  const w = Math.round(im.naturalWidth * s), h = Math.round(im.naturalHeight * s);
  return {
    img: scaled(im, w, h),
    tiny: scaled(im, 24, Math.max(1, Math.round(24 * h / w))),   // stretched up later = soft blur on every browser
    thumb: url,
    caption: '',
    motion: randomMotion(),
  };
}

// ---------- Drawing ----------
function drawCover(src, extra = 1) {
  const s = Math.max(W / src.width, H / src.height) * extra;
  const dw = src.width * s, dh = src.height * s;
  ctx.imageSmoothingEnabled = true;
  ctx.drawImage(src, (W - dw) / 2, (H - dh) / 2, dw, dh);
}

function drawPhoto(p, t) {
  const { img, tiny, motion: m } = p;
  const e = ease(t);
  drawCover(tiny, 1.15);
  ctx.fillStyle = 'rgba(29, 36, 64, .35)';
  ctx.fillRect(0, 0, W, H);
  // Portrait photos fill the frame; landscape ones sit on the blurred backdrop
  const base = img.height >= img.width ? Math.max(W / img.width, H / img.height) : Math.min(W / img.width, H / img.height);
  const s = base * lerp(m.z0, m.z1, e);
  const dw = img.width * s, dh = img.height * s;
  const cx = W / 2 + lerp(m.x0, m.x1, e) * W;
  const cy = H / 2 + lerp(m.y0, m.y1, e) * H;
  ctx.drawImage(img, cx - dw / 2, cy - dh / 2, dw, dh);
}

function wrap(text, max) {
  const lines = [];
  let line = '';
  for (const word of text.split(/\s+/).filter(Boolean)) {
    const test = line ? `${line} ${word}` : word;
    if (line && ctx.measureText(test).width > max) { lines.push(line); line = word; }
    else line = test;
  }
  if (line) lines.push(line);
  return lines;
}

function setText(font, color, text) {
  ctx.font = `${font} ${FONT}`;
  ctx.fillStyle = color;
  ctx.textAlign = 'center';
  ctx.direction = /[؀-ۿ]/.test(text) ? 'rtl' : 'ltr';
}

function bottomShade(from) {
  const g = ctx.createLinearGradient(0, from, 0, H);
  g.addColorStop(0, 'rgba(10, 14, 30, 0)');
  g.addColorStop(1, 'rgba(10, 14, 30, .78)');
  ctx.fillStyle = g;
  ctx.fillRect(0, from, W, H - from);
}

function drawCaption(text, seconds) {
  if (!text) return;
  ctx.save();
  ctx.globalAlpha *= clamp01((seconds - 0.6) / 0.6);
  bottomShade(H * 0.58);
  setText('600 40px', '#fff', text);
  const lines = wrap(text, W - 120).slice(0, 3);
  let y = H - 150 - (lines.length - 1) * 58;
  for (const l of lines) { ctx.fillText(l, W / 2, y); y += 58; }
  ctx.restore();
}

function drawTitle(info, seconds) {
  ctx.save();
  ctx.globalAlpha *= clamp01((seconds - 0.8) / 1);
  bottomShade(H * 0.5);
  if (info.place) {
    setText('300 30px', STONE, info.place);
    ctx.fillText(info.place, W / 2, H - 250);
  }
  setText('600 66px', '#fff', info.title);
  const lines = wrap(info.title, W - 100).slice(0, 2);
  let y = H - 170 - (lines.length - 1) * 80;
  for (const l of lines) { ctx.fillText(l, W / 2, y); y += 80; }
  ctx.fillStyle = SAFFRON;
  ctx.fillRect(W / 2 - 28, H - 120, 56, 4);
  ctx.restore();
}

function drawIntro(info, t, seconds) {
  if (viewer) {
    drawScene(t);
  } else {
    // No 3D scene yet: open on a soft, slowly zooming backdrop of the first photo
    ctx.fillStyle = NIGHT;
    ctx.fillRect(0, 0, W, H);
    if (photos[0]) drawCover(photos[0].tiny, lerp(1.2, 1.35, ease(t)));
    ctx.fillStyle = 'rgba(29, 36, 64, .55)';
    ctx.fillRect(0, 0, W, H);
  }
  drawTitle(info, seconds);
}

function drawOutro(info) {
  ctx.fillStyle = NIGHT;
  ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = SAFFRON;
  ctx.beginPath();
  ctx.arc(W / 2, H / 2 - 130, 7, 0, Math.PI * 2);
  ctx.fill();
  setText('600 54px', '#fff', info.title);
  ctx.fillText(info.title, W / 2, H / 2 - 40);
  if (info.place) {
    setText('300 32px', STONE, info.place);
    ctx.fillText(info.place, W / 2, H / 2 + 20);
  }
  setText('300 28px', MUTED, info.date);
  ctx.fillText(info.date, W / 2, H / 2 + 72);
  setText('400 22px', MUTED, 'Expo Memory Synth');
  ctx.fillText('Expo Memory Synth', W / 2, H - 90);
}

function drawVignette() {
  const g = ctx.createRadialGradient(W / 2, H / 2, H * 0.35, W / 2, H / 2, H * 0.75);
  g.addColorStop(0, 'rgba(0, 0, 0, 0)');
  g.addColorStop(1, 'rgba(0, 0, 0, .35)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);
}

// ---------- Timeline ----------
function filmInfo() {
  const name = $('nameInput').value.trim();
  return {
    title: name ? `رحلة ${name}` : 'رحلتي',
    place: $('placeInput').value.trim(),
    date: new Date().toLocaleDateString('ar-SA-u-ca-gregory', { day: 'numeric', month: 'long', year: 'numeric' }),
  };
}

function buildTimeline() {
  // Each segment overlaps the previous one by DUR.fade for a crossfade
  const segs = [
    { kind: 'intro', dur: DUR.intro },
    ...photos.map((p) => ({ kind: 'photo', p, dur: DUR.photo })),
    { kind: 'outro', dur: DUR.outro },
  ];
  let t = 0;
  for (const s of segs) { s.start = t; t += s.dur - DUR.fade; }
  return { segs, total: t + DUR.fade, info: filmInfo() };
}

function renderFrame(tl, t) {
  ctx.save();
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, W, H);
  tl.segs.forEach((s, i) => {
    const local = t - s.start;
    if (local < 0 || local > s.dur) return;
    ctx.globalAlpha = i === 0 ? 1 : clamp01(local / DUR.fade);
    const p = local / s.dur;
    if (s.kind === 'intro') drawIntro(tl.info, p, local);
    else if (s.kind === 'photo') { drawPhoto(s.p, p); drawCaption(s.p.caption, local); }
    else drawOutro(tl.info);
  });
  ctx.globalAlpha = 1;
  drawVignette();
  // Fade in from black at the start, out to black at the end
  const black = Math.max(clamp01(1 - t / 0.6), clamp01((t - (tl.total - 0.8)) / 0.8));
  if (black > 0) { ctx.fillStyle = `rgba(0, 0, 0, ${black})`; ctx.fillRect(0, 0, W, H); }
  ctx.restore();
}

// ---------- Audio ----------
function ensureAudio() {
  // Must run inside a click so the browser allows sound
  if (!audio) {
    const ac = new (window.AudioContext || window.webkitAudioContext)();
    const gain = ac.createGain();
    gain.gain.value = 0;
    const dest = ac.createMediaStreamDestination();   // lets the recorder capture the sound too
    gain.connect(ac.destination);
    gain.connect(dest);
    ac.createMediaElementSource(ambientEl).connect(gain);
    audio = { ctx: ac, gain, dest };
  }
  audio.ctx.resume();
  return audio;
}

function startAmbient(total) {
  if (!audio) return;
  ambientEl.currentTime = 0;
  ambientEl.play().catch(() => {});                   // no ambient.mp3 yet = silent film
  const g = audio.gain.gain, now = audio.ctx.currentTime;
  g.cancelScheduledValues(now);
  g.setValueAtTime(0, now);
  g.linearRampToValueAtTime(AMBIENT_VOLUME, now + 2);
  g.setValueAtTime(AMBIENT_VOLUME, now + Math.max(2, total - 2.5));
  g.linearRampToValueAtTime(0, now + total);
}

function stopAmbient() {
  ambientEl.pause();
  if (audio) {
    audio.gain.gain.cancelScheduledValues(audio.ctx.currentTime);
    audio.gain.gain.setValueAtTime(0, audio.ctx.currentTime);
  }
}

// ---------- Playback ----------
async function prepare() {
  setStatus('جاري تجهيز الفيلم…');
  await fontsReady;
  viewer = await sceneReady;
  if (viewer) {
    // Let the splat sorter settle on the first camera position before rolling
    for (let i = 0; i < 20; i++) { drawScene(0); await nextFrame(); }
  }
  setStatus('');
}

function showPoster() {
  // The title over the opening shot, used before playing and after the film ends
  renderFrame(buildTimeline(), 2.2);
}

// Resolves true when the film reaches the end, false when stopped early
function play() {
  stop();
  const tl = buildTimeline();
  startAmbient(tl.total);
  return new Promise((resolve) => {
    const t0 = performance.now();
    const tick = () => {
      const t = (performance.now() - t0) / 1000;
      renderFrame(tl, Math.min(t, tl.total));
      $('bar').style.width = `${Math.min(100, (t / tl.total) * 100)}%`;
      if (t >= tl.total) { playing = null; stopAmbient(); resolve(true); return; }
      playing.raf = requestAnimationFrame(tick);
    };
    playing = { raf: requestAnimationFrame(tick), resolve };
  });
}

function stop() {
  if (!playing) return;
  cancelAnimationFrame(playing.raf);
  const { resolve } = playing;
  playing = null;
  stopAmbient();
  resolve(false);
}

function pickMime() {
  const options = [
    'video/mp4;codecs=avc1.42E01E,mp4a.40.2',
    'video/mp4',
    'video/webm;codecs=vp9,opus',
    'video/webm;codecs=vp8,opus',
    'video/webm',
  ];
  return options.find((t) => MediaRecorder.isTypeSupported(t)) || '';
}

async function record() {
  const a = ensureAudio();
  await prepare();
  const stream = canvas.captureStream(FPS);
  a.dest.stream.getAudioTracks().forEach((tr) => stream.addTrack(tr));
  const mime = pickMime();
  const rec = new MediaRecorder(stream, { ...(mime && { mimeType: mime }), videoBitsPerSecond: 8_000_000 });
  const chunks = [];
  rec.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
  const stopped = new Promise((r) => { rec.onstop = r; });

  rec.start(1000);
  const seconds = Math.round(buildTimeline().total);
  setStatus(`جاري حفظ الفيلم (${seconds} ثانية تقريباً). خلّ الصفحة مفتوحة لين يخلص.`, true);
  const finished = await play();
  rec.stop();
  await stopped;
  stream.getVideoTracks().forEach((tr) => tr.stop());

  if (!finished) { setStatus('انلغى الحفظ.'); return; }
  const type = rec.mimeType || mime || 'video/webm';
  const ext = type.includes('mp4') ? 'mp4' : 'webm';
  const blob = new Blob(chunks, { type });
  showResult(blob, `rihla-${new Date().toISOString().slice(0, 10)}.${ext}`, type);
}

function showResult(blob, filename, type) {
  if (resultUrl) URL.revokeObjectURL(resultUrl);
  resultUrl = URL.createObjectURL(blob);
  const link = $('downloadLink');
  link.href = resultUrl;
  link.download = filename;
  const file = new File([blob], filename, { type });
  const canShare = navigator.canShare && navigator.canShare({ files: [file] });
  $('shareBtn').hidden = !canShare;
  $('shareBtn').onclick = () => navigator.share({ files: [file], title: filmInfo().title }).catch(() => {});
  $('result').hidden = false;
  setStatus(`الفيلم جاهز (${(blob.size / 1e6).toFixed(1)} MB).`);
}

// ---------- UI ----------
function setStatus(text, busy = false) {
  $('status').textContent = text;
  $('status').classList.toggle('busy', busy);
}

function setMode(next) {
  mode = next;
  $('playBtn').textContent = mode === 'idle' ? '▶ شغّل الفيلم' : mode === 'playing' ? '■ أوقف' : 'إلغاء الحفظ';
  $('saveBtn').disabled = mode !== 'idle';
  $('editBtn').disabled = mode !== 'idle';
}

function renderList() {
  const list = $('photos');
  list.innerHTML = '';
  photos.forEach((p, i) => {
    const li = document.createElement('li');
    li.className = 'photo';

    const img = document.createElement('img');
    img.src = p.thumb;
    img.alt = `صورة ${i + 1}`;

    const caption = document.createElement('input');
    caption.type = 'text';
    caption.maxLength = 80;
    caption.placeholder = 'وش صار هنا؟ (اختياري)';
    caption.value = p.caption;
    caption.setAttribute('aria-label', `وصف الصورة ${i + 1}`);
    caption.addEventListener('input', () => { p.caption = caption.value; });

    const tools = document.createElement('div');
    tools.className = 'tools';
    const tool = (label, aria, onClick, disabled = false, cls = '') => {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = label;
      b.setAttribute('aria-label', aria);
      b.disabled = disabled;
      if (cls) b.className = cls;
      b.addEventListener('click', onClick);
      tools.appendChild(b);
    };
    const move = (d) => { [photos[i], photos[i + d]] = [photos[i + d], photos[i]]; renderList(); };
    tool('↑', `قدّم الصورة ${i + 1}`, () => move(-1), i === 0);
    tool('↓', `أخّر الصورة ${i + 1}`, () => move(1), i === photos.length - 1);
    tool('✕', `احذف الصورة ${i + 1}`, () => {
      URL.revokeObjectURL(p.thumb);
      photos.splice(i, 1);
      renderList();
    }, false, 'remove');

    li.append(img, caption, tools);
    list.appendChild(li);
  });

  $('count').textContent = photos.length
    ? `${photos.length} من ${MAX_PHOTOS} صور. تقدر تكتب سطر قصير عن كل صورة وترتبها.`
    : `حتى ${MAX_PHOTOS} صورة. تقدر تكتب سطر قصير عن كل صورة.`;
  $('makeBtn').disabled = photos.length === 0;
  $('photoInput').disabled = photos.length >= MAX_PHOTOS;
}

$('photoInput').addEventListener('change', async (e) => {
  const files = [...e.target.files].slice(0, MAX_PHOTOS - photos.length);
  e.target.value = '';
  if (!files.length) return;
  $('count').textContent = 'جاري تجهيز الصور…';
  let failed = 0;
  for (const f of files) {
    try { photos.push(await loadPhoto(f)); } catch { failed++; }
  }
  renderList();
  if (failed) $('count').textContent += ` (تعذّر فتح ${failed} صورة)`;
});

$('makeBtn').addEventListener('click', async () => {
  $('setup').hidden = true;
  $('player').hidden = false;
  $('result').hidden = true;
  $('filmTitle').textContent = filmInfo().title;
  $('bar').style.width = '0';
  setMode('idle');
  window.scrollTo(0, 0);
  await prepare();
  showPoster();
  setStatus(viewer ? '' : 'ما فيه مشهد 3D بعد، فالفيلم يبدأ بصورتك الأولى. أضف web/scene.ply عشان يبدأ بجولة داخل المكان.');
});

$('playBtn').addEventListener('click', async () => {
  if (mode !== 'idle') { stop(); return; }
  ensureAudio();
  setMode('playing');
  await prepare();
  await play();
  showPoster();
  setMode('idle');
});

$('saveBtn').addEventListener('click', async () => {
  if (!window.MediaRecorder || !canvas.captureStream) {
    setStatus('هذا المتصفح ما يدعم حفظ الفيديو. جرّب Chrome أو Safari بنسخة حديثة.');
    return;
  }
  setMode('recording');
  $('result').hidden = true;
  try {
    await record();
  } catch (err) {
    console.error(err);
    setStatus('صار خطأ أثناء الحفظ. جرّب مرة ثانية.');
  }
  showPoster();
  setMode('idle');
});

$('editBtn').addEventListener('click', () => {
  stop();
  $('player').hidden = true;
  $('setup').hidden = false;
  setStatus('');
});

// ---------- Start ----------
(async () => {
  try {
    const story = await (await fetch('narration.json')).json();
    if (story.place && !$('placeInput').value) $('placeInput').value = story.place;
  } catch { /* no narration yet: place stays empty */ }
})();
renderList();
