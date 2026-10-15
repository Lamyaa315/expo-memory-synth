// The trip film engine: the visitor's photos as a short vertical film (Shaden's film.js, as a module for the memories page).
// An opening title over the first photo, then each photo with slow Ken Burns motion (or 3D parallax when the depth model
// runs) and its own line, with a voice over each photo (the visitor's recording, or Saad reading the line), then a closing card.
// Everything runs in the browser: photos and recordings never leave the device.
import { estimateDepth, Parallax, randomParallax } from './film-depth.js';

const W = 720, H = 1280;                                    // vertical 9:16, fits phones and stories
const FPS = 30;
const DUR = { intro: 5, photo: 4.5, fade: 1, outro: 4 };    // seconds
const AMBIENT_VOLUME = 0.5;
const VOICE_DUCK = 0.15;        // ambient volume under the voices
const VOICE_LEAD = 0.6;         // a photo's voice starts this long after the photo appears
export const MAX_PHOTOS = 12;
const FONT = '"IBM Plex Sans Arabic", "Segoe UI", Tahoma, sans-serif';
// Lqya colours: warm night, stone, terracotta
const NIGHT = '#22201A', STONE = '#E9E4D8', ACCENT = '#C8693E', MUTED = '#B9B2A2';

const clamp01 = (x) => Math.min(1, Math.max(0, x));
const lerp = (a, b, t) => a + (b - a) * t;
const ease = (t) => 0.5 - 0.5 * Math.cos(Math.PI * clamp01(t));

// ---------- Photos ----------
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

// A photo from a file: { img, tiny, thumb, caption, voice, voiceUrl, saadVoice, saadText, motion, parallax, depth }
export async function loadPhoto(file) {
  const thumb = URL.createObjectURL(file);
  const im = new Image();
  im.src = thumb;
  try { await im.decode(); } catch { URL.revokeObjectURL(thumb); throw new Error(`Could not read ${file.name}`); }
  const s = Math.min(1, 1400 / Math.max(im.naturalWidth, im.naturalHeight));
  const w = Math.round(im.naturalWidth * s), h = Math.round(im.naturalHeight * s);
  return {
    img: scaled(im, w, h),
    tiny: scaled(im, 24, Math.max(1, Math.round(24 * h / w))),   // stretched up later = soft blur on every browser
    thumb,
    caption: '',
    voice: null, voiceUrl: null,     // the visitor's own voice for this photo (recorded here, never uploaded)
    saadVoice: null, saadText: '',   // Saad reading this photo's line, and the line it was made for
    motion: randomMotion(),
    parallax: randomParallax(),
    depth: null,                     // filled in the background by the depth model (film-depth.js)
  };
}

export function forgetPhoto(p) {
  URL.revokeObjectURL(p.thumb);
  if (p.voiceUrl) URL.revokeObjectURL(p.voiceUrl);
}

// ---------- The film ----------
export function createFilm({ canvas, ambient, getPhotos, getMode, getInfo }) {
  const ctx = canvas.getContext('2d');
  canvas.width = W; canvas.height = H;
  let audio = null;     // { ctx, gain, dest, voiceGain }
  let playing = null;   // { raf, resolve }
  let voices = [];
  let parallax = null;
  let depthOn = true;
  let depthQueue = Promise.resolve();

  // The voice over a photo in the current mode: 'mine' (recorded), 'saad' (Saad reads the line), 'none'
  const voiceOf = (p) => {
    const mode = getMode();
    if (mode === 'mine') return p.voice;
    if (mode === 'saad' && p.saadText && p.saadText === p.caption.trim()) return p.saadVoice;
    return null;
  };

  const fontsReady = Promise.all([
    document.fonts.load(`600 40px "IBM Plex Sans Arabic"`, 'رحلة'),
    document.fonts.load(`400 30px "IBM Plex Sans Arabic"`, 'رحلة'),
  ]).catch(() => {});

  // ---------- 3D motion: depth for each photo, in the background ----------
  function queueDepth(onStatus) {
    if (!depthOn) return;
    depthQueue = depthQueue.then(async () => {
      const todo = getPhotos().filter((p) => !p.depth);
      for (let i = 0; i < todo.length; i++) {
        if (!depthOn) return;
        onStatus?.(`نجهّز الحركة ثلاثية الأبعاد… ${i + 1} من ${todo.length}`);
        try {
          parallax ||= new Parallax();
          todo[i].depth = await estimateDepth(todo[i].img);
        } catch (err) {
          console.warn('3D motion off:', err);
          depthOn = false;   // this browser can't: the photos move the usual way
          onStatus?.('');
          return;
        }
      }
      onStatus?.('');
    });
    return depthQueue;
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
    ctx.fillStyle = 'rgba(34, 32, 26, .35)';
    ctx.fillRect(0, 0, W, H);
    // Portrait photos fill the frame; landscape ones sit on the blurred backdrop
    const base = img.height >= img.width ? Math.max(W / img.width, H / img.height) : Math.min(W / img.width, H / img.height);
    const s = base * lerp(m.z0, m.z1, e);
    const dw = img.width * s, dh = img.height * s;
    const cx = W / 2 + lerp(m.x0, m.x1, e) * W;
    const cy = H / 2 + lerp(m.y0, m.y1, e) * H;
    if (p.depth && parallax && depthOn) {
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
    g.addColorStop(0, 'rgba(20, 18, 14, 0)');
    g.addColorStop(1, 'rgba(20, 18, 14, .8)');
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
      setText('400 30px', STONE, info.place);
      ctx.fillText(info.place, W / 2, H - 250);
    }
    setText('700 66px', '#fff', info.title);
    const lines = wrap(info.title, W - 100).slice(0, 2);
    let y = H - 170 - (lines.length - 1) * 80;
    for (const l of lines) { ctx.fillText(l, W / 2, y); y += 80; }
    ctx.fillStyle = ACCENT;
    ctx.fillRect(W / 2 - 28, H - 120, 56, 4);
    ctx.restore();
  }

  function drawIntro(info, t, seconds) {
    // A soft, slowly zooming backdrop of the first photo
    const first = getPhotos()[0];
    ctx.fillStyle = NIGHT;
    ctx.fillRect(0, 0, W, H);
    if (first) drawCover(first.tiny, lerp(1.2, 1.35, ease(t)));
    ctx.fillStyle = 'rgba(34, 32, 26, .55)';
    ctx.fillRect(0, 0, W, H);
    drawTitle(info, seconds);
  }

  function drawOutro(info) {
    ctx.fillStyle = NIGHT;
    ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = ACCENT;
    ctx.beginPath();
    ctx.arc(W / 2, H / 2 - 130, 7, 0, Math.PI * 2);
    ctx.fill();
    setText('700 54px', '#fff', info.title);
    ctx.fillText(info.title, W / 2, H / 2 - 40);
    if (info.place) {
      setText('400 32px', STONE, info.place);
      ctx.fillText(info.place, W / 2, H / 2 + 20);
    }
    setText('400 28px', MUTED, info.date);
    ctx.fillText(info.date, W / 2, H / 2 + 72);
    setText('600 30px', MUTED, 'لقيا · Luqya');
    ctx.fillText('لقيا · Luqya', W / 2, H - 90);
  }

  function drawVignette() {
    const g = ctx.createRadialGradient(W / 2, H / 2, H * 0.35, W / 2, H / 2, H * 0.75);
    g.addColorStop(0, 'rgba(0, 0, 0, 0)');
    g.addColorStop(1, 'rgba(0, 0, 0, .35)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);
  }

  // ---------- Timeline ----------
  function timeline() {
    // Each segment overlaps the previous one by DUR.fade for a crossfade; a photo stays as long as its voice
    const segs = [
      { kind: 'intro', dur: DUR.intro },
      ...getPhotos().map((p) => ({ kind: 'photo', p,
        dur: voiceOf(p) ? Math.max(DUR.photo, VOICE_LEAD + voiceOf(p).duration + 0.4 + DUR.fade) : DUR.photo })),
      { kind: 'outro', dur: DUR.outro },
    ];
    let t = 0;
    for (const s of segs) { s.start = t; t += s.dur - DUR.fade; }
    return { segs, total: t + DUR.fade, info: getInfo() };
  }

  function frame(tl, t) {
    ctx.save();
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, W, H);
    tl.segs.forEach((s, i) => {
      const local = t - s.start;
      if (local < 0 || local > s.dur) return;
      ctx.globalAlpha = i === 0 ? 1 : clamp01(local / DUR.fade);
      const p = local / s.dur;
      if (s.kind === 'intro') drawIntro(tl.info, p, local);
      else if (s.kind === 'photo') { drawPhoto(s.p, p); drawCaption(s.p.caption.trim(), local); }
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
    // Must first run inside a click so the browser allows sound
    if (!audio) {
      const ac = new (window.AudioContext || window.webkitAudioContext)();
      const gain = ac.createGain();
      gain.gain.value = 0;
      const dest = ac.createMediaStreamDestination();   // lets the recorder capture the sound too
      gain.connect(ac.destination);
      gain.connect(dest);
      ac.createMediaElementSource(ambient).connect(gain);
      const voiceGain = ac.createGain();
      voiceGain.connect(ac.destination);
      voiceGain.connect(dest);
      audio = { ctx: ac, gain, dest, voiceGain };
    }
    audio.ctx.resume();
    return audio;
  }

  function startSound(tl) {
    if (!audio) return;
    ambient.currentTime = 0;
    ambient.play().catch(() => {});
    const g = audio.gain.gain, now = audio.ctx.currentTime;
    g.cancelScheduledValues(now);
    g.setValueAtTime(0, now);
    const level = getPhotos().some(voiceOf) ? VOICE_DUCK : AMBIENT_VOLUME;   // softer under the voices
    g.linearRampToValueAtTime(level, now + 2);
    g.setValueAtTime(level, now + Math.max(2, tl.total - 2.5));
    g.linearRampToValueAtTime(0, now + tl.total);
    for (const s of tl.segs) {
      if (s.kind !== 'photo' || !voiceOf(s.p)) continue;
      const src = audio.ctx.createBufferSource();
      src.buffer = voiceOf(s.p);
      src.connect(audio.voiceGain);
      src.start(now + s.start + VOICE_LEAD);
      voices.push(src);
    }
  }

  function stopSound() {
    ambient.pause();
    voices.forEach((src) => { try { src.stop(); } catch { /* not started */ } });
    voices = [];
    if (audio) {
      audio.gain.gain.cancelScheduledValues(audio.ctx.currentTime);
      audio.gain.gain.setValueAtTime(0, audio.ctx.currentTime);
    }
  }

  // ---------- Playback ----------
  async function poster() {
    await fontsReady;
    frame(timeline(), 2.2);   // the title over the opening shot
  }

  // Resolves true when the film reaches the end, false when stopped early
  async function play(onProgress) {
    stop();
    await fontsReady;
    const tl = timeline();
    startSound(tl);
    return new Promise((resolve) => {
      const t0 = performance.now();
      const tick = () => {
        const t = (performance.now() - t0) / 1000;
        frame(tl, Math.min(t, tl.total));
        onProgress?.(Math.min(1, t / tl.total), tl.total - t);
        if (t >= tl.total) { playing = null; stopSound(); resolve(true); return; }
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
    stopSound();
    resolve(false);
  }

  function pickMime() {
    return ['video/mp4;codecs=avc1.42E01E,mp4a.40.2', 'video/mp4', 'video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm']
      .find((t) => MediaRecorder.isTypeSupported(t)) || '';
  }

  // Plays the film once while recording it; resolves { blob, type, filename } or null when stopped
  async function record(onProgress) {
    const a = ensureAudio();
    await fontsReady;
    const stream = canvas.captureStream(FPS);
    a.dest.stream.getAudioTracks().forEach((tr) => stream.addTrack(tr));
    const mime = pickMime();
    const rec = new MediaRecorder(stream, { ...(mime && { mimeType: mime }), videoBitsPerSecond: 8_000_000 });
    const chunks = [];
    rec.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
    const stopped = new Promise((r) => { rec.onstop = r; });
    rec.start(1000);
    const finished = await play(onProgress);
    rec.stop();
    await stopped;
    stream.getVideoTracks().forEach((tr) => tr.stop());
    if (!finished) return null;
    const type = rec.mimeType || mime || 'video/webm';
    const ext = type.includes('mp4') ? 'mp4' : 'webm';
    return { blob: new Blob(chunks, { type }), type, filename: `laqya-${new Date().toISOString().slice(0, 10)}.${ext}` };
  }

  return {
    ensureAudio, queueDepth, poster, play, stop, record, voiceOf,
    seconds: () => Math.round(timeline().total),
    decode: (buf) => ensureAudio().ctx.decodeAudioData(buf),
  };
}
