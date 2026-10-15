// Trip film, the generated parts (both need scripts/server.py, and both only with the visitor's consent):
// - the story: the model looks at the photos and writes the film's narration in the visitor's own words
// - the voice: the visitor records a short sample and the story is read in their own voice
//   (scripts/voice_clone.py, XTTS-v2 on the server's computer; the sample is deleted right after)

const SAMPLE_RATE = 22050;

export async function features() {
  try {
    const res = await fetch('/api/health', { cache: 'no-store' });
    const h = res.ok ? await res.json() : {};
    return { story: h.film_story === true, clone: h.clone === true, tts: h.tts === true };
  } catch {
    return { story: false, clone: false, tts: false };
  }
}

// The story read in Saad's voice (Gemini, edge-tts as backup: scripts/tts.py). Returns { clip, type }
export async function speakStory(text, lang) {
  const res = await fetch('/api/tts', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, lang }),
  });
  if (!res.ok) throw new Error(res.status === 503 ? 'offline' : `tts ${res.status}`);
  return { clip: await res.arrayBuffer(), type: res.headers.get('Content-Type') || 'audio/wav' };
}

// A small JPEG of a photo for the model (it doesn't need the full size)
export function forUpload(source, max = 640) {
  const w = source.naturalWidth || source.width, h = source.naturalHeight || source.height;
  const s = Math.min(1, max / Math.max(w, h));
  const c = document.createElement('canvas');
  c.width = Math.round(w * s);
  c.height = Math.round(h * s);
  c.getContext('2d').drawImage(source, 0, 0, c.width, c.height);
  return c.toDataURL('image/jpeg', 0.82);
}

export async function writeStory(images, { place, name, lang }) {
  const res = await fetch('/api/film/story', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ photos: images, place, name, lang, consent: true }),
  });
  if (!res.ok) throw new Error(`story ${res.status}`);
  return res.json();
}

// Records the microphone for `seconds` and returns a mono 16-bit WAV (ArrayBuffer). onTick(secondsLeft).
export async function recordSample(seconds, onTick) {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: true, noiseSuppression: true, channelCount: 1 },
  });
  try {
    const rec = new MediaRecorder(stream);
    const chunks = [];
    rec.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
    const stopped = new Promise((r) => { rec.onstop = r; });
    rec.start();
    for (let left = seconds; left > 0; left--) {
      onTick?.(left);
      await new Promise((r) => setTimeout(r, 1000));
      if (rec.state !== 'recording') break;
    }
    if (rec.state === 'recording') rec.stop();
    await stopped;
    const blob = new Blob(chunks, { type: rec.mimeType || 'audio/webm' });
    return toWav(await blob.arrayBuffer());
  } finally {
    stream.getTracks().forEach((t) => t.stop());   // the microphone light goes off
  }
}

// Any recorded audio -> mono 16-bit PCM WAV at SAMPLE_RATE (what the voice model reads)
async function toWav(encoded) {
  const ac = new (window.OfflineAudioContext || window.webkitOfflineAudioContext)(1, 1, SAMPLE_RATE);
  const decoded = await ac.decodeAudioData(encoded);
  const frames = Math.ceil(decoded.duration * SAMPLE_RATE);
  const off = new OfflineAudioContext(1, frames, SAMPLE_RATE);
  const src = off.createBufferSource();
  src.buffer = decoded;
  src.connect(off.destination);
  src.start();
  const pcm = (await off.startRendering()).getChannelData(0);
  const buf = new ArrayBuffer(44 + pcm.length * 2);
  const v = new DataView(buf);
  const str = (o, s) => [...s].forEach((ch, i) => v.setUint8(o + i, ch.charCodeAt(0)));
  str(0, 'RIFF'); v.setUint32(4, 36 + pcm.length * 2, true); str(8, 'WAVE');
  str(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, SAMPLE_RATE, true); v.setUint32(28, SAMPLE_RATE * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  str(36, 'data'); v.setUint32(40, pcm.length * 2, true);
  for (let i = 0; i < pcm.length; i++) v.setInt16(44 + i * 2, Math.max(-1, Math.min(1, pcm[i])) * 0x7fff, true);
  return buf;
}

function toBase64(buf) {
  const bytes = new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

// The story read in the visitor's voice: returns the audio (ArrayBuffer)
export async function cloneStory(text, wav, lang) {
  const res = await fetch('/api/film/voice', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, sample: toBase64(wav), lang, consent: true }),
  });
  if (!res.ok) throw new Error(res.status === 503 ? 'offline' : `voice ${res.status}`);
  return res.arrayBuffer();
}
