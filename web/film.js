// Trip film: the visitor picks photos from their visit and gets a short vertical film.
// Opening: a title over a soft backdrop of the first photo, then each photo with slow Ken Burns motion and an optional caption, then a closing card.
// Everything runs in the browser: photos never leave the device.
import { withScene } from './scene-config.js';
import * as story from './film-story.js';
import { estimateDepth, Parallax, randomParallax } from './film-depth.js';


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

let photos = [];        // { img, tiny, thumb, caption, motion, voice: AudioBuffer|null, voiceUrl }
let audio = null;       // { ctx, gain, dest }
let playing = null;     // { raf, resolve }
let resultUrl = null;
let mode = 'idle';      // 'idle' | 'playing' | 'recording'
let narration = null;   // AudioBuffer: the story read in the visitor's voice
let narrationSrc = null;
let aiTitle = '';       // the film title the story came with
let sampleWav = null;   // the visitor's recorded voice sample, kept only in memory until the clip is made
const NARRATION_START = 1.5;   // seconds into the film
const NARRATION_DUCK = 0.15;   // ambient volume under the voice
const VOICE_LEAD = 0.6;        // a photo's own voice starts this long after the photo appears
const VOICE_MAX = 30;          // seconds of voice per photo
let photoVoices = [];          // the sources playing the photos' voices
let recording = null;          // { p, rec, stream, left, timer } while the visitor records a photo's voice
let tellMode = 'text';         // how each photo is told: 'text' | 'voice' (the visitor's) | 'saad' (Saad reads the line)
// The voice that goes over a photo in the current mode
const voiceOf = (p) => tellMode === 'voice' ? p.voice
  : tellMode === 'saad' && p.saadText === p.caption.trim() ? p.saadVoice : null;
const hasPhotoVoices = () => photos.some(voiceOf);
// The whole story read in the visitor's cloned voice (voice_clone.py) is part of the "my voice" mode only,
// and only when no photo has its own recording
const storyVoice = () => tellMode === 'voice' && !hasPhotoVoices() ? narration : null;

// Arabic glyphs must be loaded before the canvas can draw them in Readex Pro
const fontsReady = Promise.all([
  document.fonts.load(`600 40px "Readex Pro"`, 'رحلة'),
  document.fonts.load(`300 30px "Readex Pro"`, 'رحلة'),
]).catch(() => {});

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
    voice: null,          // the visitor's own voice for this photo (recorded here, never leaves the browser)
    voiceUrl: null,
    saadVoice: null,      // Saad reading this photo's line (AudioBuffer), and the line it was made for
    saadText: '',
    motion: randomMotion(),
    parallax: randomParallax(),
    depth: null,          // filled in the background by the depth model (film-depth.js)
  };
}

// ---------- 3D motion: depth for each photo, in the background ----------
let parallax = null;
let depthQueue = Promise.resolve();
let depthFailed = false;
const use3d = () => $('depthToggle').checked && !depthFailed;

function queueDepth() {
  if (!use3d()) return;
  depthQueue = depthQueue.then(async () => {
    const todo = photos.filter((p) => !p.depth);
    for (let i = 0; i < todo.length; i++) {
      if (!use3d()) return;
      $('depthStatus').textContent = `يجهز الحركة 3D… ${i + 1} من ${todo.length}` + (i === 0 && !parallax ? ' (أول مرة ينزل الموديل، تقريباً 27 ميقا)' : '');
      try {
        parallax ||= new Parallax();
        todo[i].depth = await estimateDepth(todo[i].img);
      } catch (err) {
        console.warn('3D motion off:', err);
        depthFailed = true;
        $('depthStatus').textContent = 'الحركة 3D ما تشتغل على هذا المتصفح، فالصور بتتحرك بالطريقة العادية.';
        return;
      }
    }
    if (todo.length) $('depthStatus').textContent = 'الحركة 3D جاهزة ✓';
  });
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
  if (p.depth && parallax && use3d()) {
    // The same frame, but the photo moves like a scene: near things slide more than far ones
    const f = Math.min(1, 1280 / Math.max(dw, dh));
    const layer = parallax.render(p, e, Math.max(1, Math.round(dw * f)), Math.max(1, Math.round(dh * f)));
    ctx.drawImage(layer, cx - dw / 2, cy - dh / 2, dw, dh);
  } else {
    ctx.drawImage(img, cx - dw / 2, cy - dh / 2, dw, dh);
  }
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
  // A soft, slowly zooming backdrop of the first photo (the visitor's own trip, not the 3D scan)
  ctx.fillStyle = NIGHT;
  ctx.fillRect(0, 0, W, H);
  if (photos[0]) drawCover(photos[0].tiny, lerp(1.2, 1.35, ease(t)));
  ctx.fillStyle = 'rgba(29, 36, 64, .55)';
  ctx.fillRect(0, 0, W, H);
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
    title: aiTitle || (name ? `رحلة ${name}` : 'رحلتي'),
    place: $('placeInput').value.trim(),
    date: new Date().toLocaleDateString('ar-SA-u-ca-gregory', { day: 'numeric', month: 'long', year: 'numeric' }),
  };
}

function buildTimeline() {
  // Each segment overlaps the previous one by DUR.fade for a crossfade
  // With a narration, the photos share its length (the film never cuts the voice off)
  let photoDur = DUR.photo;
  if (storyVoice() && photos.length) {
    const need = NARRATION_START + narration.duration + 2.5;   // the voice, then a breath before the end
    const fixed = (DUR.intro - DUR.fade) + (DUR.outro - DUR.fade) + DUR.fade;
    photoDur = Math.max(DUR.photo, (need - fixed) / photos.length + DUR.fade);
  }
  const segs = [
    { kind: 'intro', dur: DUR.intro },
    ...photos.map((p) => ({ kind: 'photo', p,
      dur: voiceOf(p) ? Math.max(photoDur, VOICE_LEAD + voiceOf(p).duration + 0.4 + DUR.fade) : photoDur })),
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
    const voiceGain = ac.createGain();
    voiceGain.connect(ac.destination);
    voiceGain.connect(dest);
    audio = { ctx: ac, gain, dest, voiceGain };
  }
  audio.ctx.resume();
  return audio;
}

function startAmbient(total, tl) {
  if (!audio) return;
  ambientEl.currentTime = 0;
  ambientEl.play().catch(() => {});                   // no ambient.mp3 yet = silent film
  const g = audio.gain.gain, now = audio.ctx.currentTime;
  g.cancelScheduledValues(now);
  g.setValueAtTime(0, now);
  const level = storyVoice() || hasPhotoVoices() ? NARRATION_DUCK : AMBIENT_VOLUME;   // softer under the voice
  g.linearRampToValueAtTime(level, now + 2);
  g.setValueAtTime(level, now + Math.max(2, total - 2.5));
  g.linearRampToValueAtTime(0, now + total);
  if (hasPhotoVoices()) startPhotoVoices(tl);   // a voice over each photo
  else if (storyVoice()) startNarration();      // or the whole story in the visitor's cloned voice
}

function startPhotoVoices(tl) {
  stopPhotoVoices();
  if (!audio || !tl) return;
  const now = audio.ctx.currentTime;
  for (const s of tl.segs) {
    if (s.kind !== 'photo' || !voiceOf(s.p)) continue;
    const src = audio.ctx.createBufferSource();
    src.buffer = voiceOf(s.p);
    src.connect(audio.voiceGain);
    src.start(now + s.start + VOICE_LEAD);
    photoVoices.push(src);
  }
}

function stopPhotoVoices() {
  photoVoices.forEach((src) => { try { src.stop(); } catch { /* not started */ } });
  photoVoices = [];
}

function startNarration() {
  stopNarration();
  if (!audio || !narration) return;
  narrationSrc = audio.ctx.createBufferSource();
  narrationSrc.buffer = narration;
  narrationSrc.connect(audio.voiceGain);
  narrationSrc.start(audio.ctx.currentTime + NARRATION_START);
}

function stopNarration() {
  try { narrationSrc?.stop(); } catch { /* not started */ }
  narrationSrc = null;
}

function stopAmbient() {
  ambientEl.pause();
  stopNarration();
  stopPhotoVoices();
  if (audio) {
    audio.gain.gain.cancelScheduledValues(audio.ctx.currentTime);
    audio.gain.gain.setValueAtTime(0, audio.ctx.currentTime);
  }
}

// ---------- Playback ----------
async function prepare() {
  setStatus('جاري تجهيز الفيلم…');
  await fontsReady;
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
  startAmbient(tl.total, tl);
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

// ---------- The visitor's voice on each photo ----------
// Recorded with the microphone and kept only in this page: nothing is uploaded.
function voiceRow(p, i) {
  const row = document.createElement('div');
  row.className = 'voice-row';
  const btn = (label, aria, onClick, cls = '') => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = `vbtn ${cls}`;
    b.textContent = label;
    b.setAttribute('aria-label', aria);
    b.disabled = mode !== 'idle' || (recording && recording.p !== p);
    b.addEventListener('click', onClick);
    row.appendChild(b);
    return b;
  };
  if (recording?.p === p) {
    btn(`■ وقّف (${recording.left})`, 'وقّف التسجيل', () => stopRecording(true), 'rec');
  } else if (p.voice) {
    btn('▶ اسمع', `اسمع صوتك على الصورة ${i + 1}`, () => new Audio(p.voiceUrl).play().catch(() => {}));
    btn('🎙 أعد', `أعد تسجيل صوتك على الصورة ${i + 1}`, () => startRecording(p));
    btn('✕', `احذف صوتك من الصورة ${i + 1}`, () => {
      URL.revokeObjectURL(p.voiceUrl);
      p.voice = null; p.voiceUrl = null;
      renderList();
    }, 'remove');
    const len = document.createElement('span');
    len.className = 'vlen';
    len.textContent = `${Math.max(1, Math.round(p.voice.duration))} ث`;
    row.appendChild(len);
  } else {
    btn('🎙 احكِ عن الصورة بصوتك', `سجّل صوتك على الصورة ${i + 1}`, () => startRecording(p));
  }
  return row;
}

async function startRecording(p) {
  if (recording) return;
  if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) {
    $('count').textContent = 'المتصفح هذا ما يدعم التسجيل. جرّب Chrome أو Edge.';
    return;
  }
  ensureAudio();   // inside the click, so the browser lets the film play sound later
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, channelCount: 1 },
    });
  } catch {
    $('count').textContent = 'ما قدرت أفتح المايك. اسمح للمتصفح يستخدمه وجرّب مرة ثانية.';
    return;
  }
  const rec = new MediaRecorder(stream);
  const chunks = [];
  rec.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
  rec.onstop = async () => {
    stream.getTracks().forEach((t) => t.stop());   // the microphone light goes off
    const keep = recording?.keep;
    recording = null;
    if (keep && chunks.length) {
      const blob = new Blob(chunks, { type: rec.mimeType || 'audio/webm' });
      try {
        const buf = await ensureAudio().ctx.decodeAudioData(await blob.arrayBuffer());
        if (p.voiceUrl) URL.revokeObjectURL(p.voiceUrl);
        p.voice = buf;
        p.voiceUrl = URL.createObjectURL(blob);
      } catch {
        $('count').textContent = 'ما قدرت أقرأ التسجيل. جرّب مرة ثانية.';
      }
    }
    renderList();
  };
  recording = { p, rec, stream, left: VOICE_MAX, keep: true };
  recording.timer = setInterval(() => {
    if (!recording) return;
    recording.left -= 1;
    if (recording.left <= 0) stopRecording(true); else renderList();
  }, 1000);
  rec.start();
  renderList();
}

function stopRecording(keep) {
  if (!recording) return;
  clearInterval(recording.timer);
  recording.keep = keep;
  if (recording.rec.state !== 'inactive') recording.rec.stop();
}

// ---------- Saad reading each photo's line ----------
async function makeSaadVoices() {
  const todo = photos.filter((p) => p.caption.trim() && p.saadText !== p.caption.trim());
  let failed = 0;
  for (const [n, p] of todo.entries()) {
    setStatus(`سعد يسجّل صوته… (${n + 1} من ${todo.length})`, true);
    const text = p.caption.trim();
    try {
      const { clip } = await story.speakStory(text, 'ar');
      p.saadVoice = await ensureAudio().ctx.decodeAudioData(clip.slice(0));
      p.saadText = text;
    } catch {
      failed++;
    }
  }
  renderList();   // the rows show which photos have Saad's voice
  setStatus(failed ? `ما قدر سعد يسجّل ${failed} من الصور، بتطلع مكتوبة بس. جرّب بعد شوي.` : '');
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
    caption.placeholder = tellMode === 'saad' ? 'وش يقول سعد عن هالصورة؟'
      : tellMode === 'voice' ? 'سطر يطلع مكتوب مع صوتك (اختياري)' : 'وش صار هنا؟ (اختياري)';
    caption.value = p.caption;
    caption.setAttribute('aria-label', `وصف الصورة ${i + 1}`);
    caption.addEventListener('input', () => { p.caption = caption.value; });

    const middle = document.createElement('div');
    middle.className = 'middle';
    middle.append(caption);
    if (tellMode === 'voice') middle.append(voiceRow(p, i));
    if (tellMode === 'saad' && voiceOf(p)) {
      const tag = document.createElement('span');
      tag.className = 'saad-tag';
      tag.textContent = `🔊 صوت سعد جاهز (${Math.max(1, Math.round(p.saadVoice.duration))} ث)`;
      middle.append(tag);
    }

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
      if (recording?.p === p) stopRecording(false);
      URL.revokeObjectURL(p.thumb);
      if (p.voiceUrl) URL.revokeObjectURL(p.voiceUrl);
      photos.splice(i, 1);
      renderList();
    }, false, 'remove');

    li.append(img, middle, tools);
    list.appendChild(li);
  });

  $('count').textContent = photos.length
    ? `${photos.length} من ${MAX_PHOTOS} صور. ${{ text: 'اكتب سطر عن كل صورة ورتبها.',
        voice: 'سجّل صوتك على كل صورة ورتبها.', saad: 'اكتب وش يقول سعد عن كل صورة ورتبها.' }[tellMode]}`
    : `حتى ${MAX_PHOTOS} صورة. تقدر تكتب سطر قصير عن كل صورة.`;
  $('makeBtn').disabled = photos.length === 0;
  const cloneHere = features.clone && tellMode === 'voice';
  $('storyBox').hidden = photos.length === 0 || !features.story && !cloneHere;
  $('saadBox').hidden = true;                  // Saad reads each photo's line in the "Saad" mode instead
  $('voiceBox').hidden = !cloneHere;
  $('voiceOff').hidden = true;
  $('voicePreview').hidden = !(cloneHere && narration);
  updateStoryButtons();
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
  queueDepth();
});

$('makeBtn').addEventListener('click', async () => {
  stopRecording(true);   // keep what was said so far
  if (tellMode === 'saad') ensureAudio();   // inside the click, so the browser lets the film play sound
  $('setup').hidden = true;
  $('player').hidden = false;
  $('result').hidden = true;
  $('filmTitle').textContent = filmInfo().title;
  $('bar').style.width = '0';
  setMode('idle');
  window.scrollTo(0, 0);
  if (tellMode === 'saad') await makeSaadVoices();
  await prepare();
  showPoster();
  setStatus('');
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

$('depthToggle').addEventListener('change', () => {
  if (use3d()) queueDepth(); else $('depthStatus').textContent = '';
});

// ---------- Story and voice ----------
let features = { story: false, clone: false, tts: false };
const storyBusy = { on: false };

function updateStoryButtons() {
  $('storyBtn').disabled = !features.story || !$('storyConsent').checked || !photos.length || storyBusy.on;
  $('saadBtn').disabled = !features.tts || !$('storyText').value.trim() || storyBusy.on;
  $('recBtn').disabled = !features.clone || !$('voiceConsent').checked || storyBusy.on;
  $('cloneBtn').disabled = !features.clone || !$('voiceConsent').checked || !sampleWav
    || !$('storyText').value.trim() || storyBusy.on;
}

$('storyConsent').addEventListener('change', updateStoryButtons);
$('voiceConsent').addEventListener('change', () => {
  if (!$('voiceConsent').checked) sampleWav = null;   // consent withdrawn: forget the sample
  updateStoryButtons();
});
$('storyText').addEventListener('input', () => {
  if (narration) {
    narration = null;
    $('voicePreview').hidden = true;
    $('saadStatus').textContent = $('voiceStatus').textContent = 'غيّرت القصة: ولّد الصوت من جديد.';
  }
  updateStoryButtons();
});

$('storyBtn').addEventListener('click', async () => {
  storyBusy.on = true; updateStoryButtons();
  $('storyStatus').textContent = 'يشوف صورك ويكتب القصة… (ممكن ياخذ دقيقة)';
  try {
    const r = await story.writeStory(photos.map((p) => story.forUpload(p.img)), {
      place: $('placeInput').value.trim(), name: $('nameInput').value.trim(), lang: 'ar',
    });
    if (r.story) {
      $('storyText').value = r.story;
      if (narration) { narration = null; $('voicePreview').hidden = true; }
    }
    if (r.title) aiTitle = r.title;
    (r.captions || []).forEach((c, i) => { if (photos[i] && !photos[i].caption && c) photos[i].caption = c; });
    renderList();
    $('storyStatus').textContent = 'جاهزة ✓ عدّلها براحتك.';
  } catch {
    $('storyStatus').textContent = 'ما قدرت أكتبها الحين. جرّب بعد شوي، أو اكتبها بنفسك.';
  }
  storyBusy.on = false; updateStoryButtons();
});

$('recBtn').addEventListener('click', async () => {
  if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) {
    $('voiceStatus').textContent = 'المتصفح هذا ما يدعم التسجيل.';
    return;
  }
  storyBusy.on = true; updateStoryButtons();
  $('recBtn').classList.add('on');
  try {
    sampleWav = await story.recordSample(15, (left) => {
      $('voiceStatus').textContent = `اقرأ الجملة اللي فوق… باقي ${left} ثانية`;
    });
    $('voiceStatus').textContent = 'تسجّل ✓ الحين اضغط "ولّد القصة بصوتي".';
  } catch {
    sampleWav = null;
    $('voiceStatus').textContent = 'ما قدرت أسجل. اسمح للمتصفح يستخدم المايك وجرّب مرة ثانية.';
  }
  $('recBtn').classList.remove('on');
  storyBusy.on = false; updateStoryButtons();
});

// The narration as the film's voice track, with a preview the visitor can listen to
async function useNarration(clip, type) {
  const a = ensureAudio();
  narration = await a.ctx.decodeAudioData(clip.slice(0));
  if ($('voicePreview').src) URL.revokeObjectURL($('voicePreview').src);
  $('voicePreview').src = URL.createObjectURL(new Blob([clip], { type }));
  $('voicePreview').hidden = false;
}

$('saadBtn').addEventListener('click', async () => {
  const text = $('storyText').value.trim();
  if (!text) return;
  ensureAudio();   // inside the click, so the browser lets the film play sound
  storyBusy.on = true; updateStoryButtons();
  $('saadStatus').textContent = 'سعد يقرأ قصتك… (ثواني)';
  try {
    const { clip, type } = await story.speakStory(text, 'ar');
    await useNarration(clip, type);
    $('saadStatus').textContent = `جاهز ✓ (${Math.round(narration.duration)} ثانية). بيكون مع الفيلم.`;
  } catch (e) {
    $('saadStatus').textContent = e.message === 'offline'
      ? 'صوت سعد مو شغال الحين (حطوا GEMINI_API_KEY في .env).' : 'ما قدرت أولّد الصوت. جرّب بعد شوي.';
  }
  storyBusy.on = false; updateStoryButtons();
});

$('cloneBtn').addEventListener('click', async () => {
  const text = $('storyText').value.trim();
  if (!text || !sampleWav) return;
  ensureAudio();   // inside the click, so the browser lets the film play sound
  storyBusy.on = true; updateStoryButtons();
  $('voiceStatus').textContent = 'يحكي قصتك بصوتك… (2 إلى 4 دقايق، خلّ الصفحة مفتوحة)';
  try {
    const clip = await story.cloneStory(text, sampleWav, 'ar');
    sampleWav = null;   // done with the visitor's voice sample
    await useNarration(clip, 'audio/wav');
    $('voiceStatus').textContent = `جاهز ✓ (${Math.round(narration.duration)} ثانية). بيكون مع الفيلم. العينة انحذفت.`;
  } catch (e) {
    $('voiceStatus').textContent = e.message === 'offline'
      ? 'خدمة الصوت مو شغالة الحين.' : 'ما قدرت أولّد الصوت. جرّب مرة ثانية.';
  }
  storyBusy.on = false; updateStoryButtons();
});

document.querySelectorAll('input[name="tell"]').forEach((r) => r.addEventListener('change', () => {
  if (!r.checked) return;
  stopRecording(true);
  tellMode = r.value;
  renderList();
}));

story.features().then((f) => {
  features = f;
  const saad = document.querySelector('input[name="tell"][value="saad"]');
  saad.disabled = !f.tts;   // Saad's voice needs scripts/server.py with a Gemini key
  if (!f.tts) {
    $('saadModeHint').textContent = 'يحتاج سيرفر المشروع (python scripts/server.py) مع مفتاح Gemini.';
    if (saad.checked) { document.querySelector('input[name="tell"][value="text"]').checked = true; tellMode = 'text'; }
  }
  $('storyConsent').disabled = !f.story;
  renderList();
});

// ---------- Start ----------
(async () => {
  try {
    const story = await (await fetch('narration.json')).json();
    if (story.place && !$('placeInput').value) $('placeInput').value = story.place;
  } catch { /* no narration yet: place stays empty */ }
})();
renderList();