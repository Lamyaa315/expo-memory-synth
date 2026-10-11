// One voice for the whole page: recorded files, the server's natural voice (scripts/server.py with edge-tts),
// or the browser's own voice as a last resort (preferring its "Natural"/"Online" voices).
// Only one thing speaks at a time.

const isArabic = (text) => /[؀-ۿ]/.test(text);
const player = new Audio();
let serverVoice = false;
let token = 0;           // bumps on every speak/stop so late replies don't start talking
let onDone = null;

export async function initVoice() {
  try {
    const res = await fetch('/api/health', { cache: 'no-store' });
    serverVoice = res.ok && (await res.json()).tts === true;
  } catch {
    serverVoice = false;
  }
  if ('speechSynthesis' in window) speechSynthesis.getVoices();   // Chrome loads voices lazily
}

function finish(t) {
  if (t !== token) return;
  const cb = onDone;
  onDone = null;
  cb?.();
}

// Play a recorded file; falls back to speaking the text if the file can't play
export function playFile(src, text, { onend } = {}) {
  const t = start(onend);
  player.src = src;
  player.onended = () => finish(t);
  player.play().catch(() => { if (t === token) speakNow(text, t); });
}

export function speak(text, { onend } = {}) {
  const t = start(onend);
  speakNow(text, t);
}

// Stops whatever is speaking; its onend still runs so buttons go back to "listen"
export function stop() {
  token++;
  const cb = onDone;
  onDone = null;
  player.pause();
  player.removeAttribute('src');
  if ('speechSynthesis' in window) speechSynthesis.cancel();
  cb?.();
}

function start(onend) {
  stop();
  onDone = onend || null;
  return token;
}

async function speakNow(text, t) {
  if (!text) return finish(t);
  if (serverVoice) {
    try {
      const res = await fetch('/api/tts', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text }),
      });
      if (!res.ok) throw new Error(res.status);
      const url = URL.createObjectURL(await res.blob());
      if (t !== token) return URL.revokeObjectURL(url);
      player.src = url;
      player.onended = () => { URL.revokeObjectURL(url); finish(t); };
      await player.play();
      return;
    } catch {
      if (t !== token) return;
    }
  }
  browserSpeak(text, t);
}

function bestVoice(lang) {
  const voices = speechSynthesis.getVoices().filter((v) => v.lang.toLowerCase().startsWith(lang));
  const score = (v) => (/natural|online|neural/i.test(v.name) ? 3 : 0) + (/google/i.test(v.name) ? 1 : 0)
    + (/sa|ae|kw|qa|bh|om/i.test(v.lang.slice(3)) ? 1 : 0);
  return voices.sort((a, b) => score(b) - score(a))[0];
}

function browserSpeak(text, t) {
  if (!('speechSynthesis' in window)) return finish(t);
  const u = new SpeechSynthesisUtterance(text);
  u.lang = isArabic(text) ? 'ar-SA' : 'en-US';
  const voice = bestVoice(u.lang.slice(0, 2));
  if (voice) u.voice = voice;
  u.rate = 0.95;
  u.onend = u.onerror = () => finish(t);
  speechSynthesis.speak(u);
}
