// One voice for the whole page: recorded files, the server's natural voice (scripts/server.py with edge-tts),
// or the browser's own voice as a last resort (preferring its "Natural"/"Online" voices).
// Only one thing speaks at a time.

import { byCode } from './languages.js';

const isArabic = (text) => /[؀-ۿ]/.test(text);
const player = new Audio();
let serverVoice = false;
let token = 0;           // bumps on every speak/stop so late replies don't start talking
let onDone = null;
let onBlocked = null;   // called when the browser refuses to play (no recent tap): show a play button

// A tiny silent clip: playing it during a tap lets the page play the real answer later, when it arrives
// (browsers only allow sound shortly after the visitor touches the page)
const SILENCE = 'data:audio/wav;base64,UklGRkQDAABXQVZFZm10IBAAAAABAAEAQB8AAIA+AAACABAAZGF0YSADAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==';
// The page's sound button: everything keeps running (the tour still waits for each line), just silent
let muted = false;
export function setMuted(on) {
  muted = on;
  player.muted = on;
  if (on && 'speechSynthesis' in window) speechSynthesis.cancel();
}

export function unlock() {
  try {
    player.src = SILENCE;
    player.play().catch(() => {});
  } catch { /* nothing to unlock */ }
  if ('speechSynthesis' in window) speechSynthesis.resume();
}

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

// lang: the language code of the text (languages.js), so the voice reads it with the right accent
export function speak(text, { onend, onblocked, lang } = {}) {
  const t = start(onend);
  onBlocked = onblocked || null;
  speakNow(text, t, lang);
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

// Clips asked for ahead of time (the tour's next stop), so they play without the wait for the voice
const ready = new Map();   // lang|text -> Promise<Blob | null>
function clip(text, lang) {
  const key = `${lang || ''}|${text}`;
  if (!ready.has(key)) {
    const p = fetch('/api/tts', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text, lang }),
    }).then((res) => (res.ok ? res.blob() : null)).catch(() => null);
    p.then((b) => { if (!b) ready.delete(key); });   // failed: ask again next time
    ready.set(key, p);
    if (ready.size > 30) ready.delete(ready.keys().next().value);
  }
  return ready.get(key);
}

// Start making a clip now, to be spoken later with speak()
export function prepare(text, lang) {
  if (serverVoice && text) clip(text, lang);
}

async function speakNow(text, t, lang) {
  if (!text) return finish(t);
  if (serverVoice) {
    try {
      const blob = await clip(text, lang);
      if (!blob) throw new Error('no clip');
      const url = URL.createObjectURL(blob);
      if (t !== token) return URL.revokeObjectURL(url);
      player.src = url;
      player.onended = () => { URL.revokeObjectURL(url); finish(t); };
      try {
        await player.play();
      } catch (e) {
        if (e?.name === 'NotAllowedError' && onBlocked && t === token) {
          // The audio is ready but needs a tap: hand the visitor a button that plays it
          const blocked = onBlocked;
          onBlocked = null;
          blocked(() => { player.play().catch(() => {}); });
          return;
        }
        throw e;
      }
      return;
    } catch {
      if (t !== token) return;
    }
  }
  browserSpeak(text, t, lang);
}

// Saad is a man: only male browser voices (by their names; browsers don't say which voices are male)
const MALE = /\b(male|man|hamed|naayf|shakir|bassel|fahed|omar|david|mark|guy|andrew|brian|christopher|eric|roger|steffan|ryan|george|james|daniel|thomas|henri|paul|claude|remy|alvaro|pablo|jorge|raul|antonio|conrad|stefan|killian|diego|cosimo|maarten|dmitry|ahmet|farid|asad|madhur|prabhat|pradeep|yunxi|yunyang|keita|ichiro|injoon|ardi|osman|niwat|nam ?minh|angelo|rafiki|ostap|marek|nestoras|mattias|ameha|muuse|sardor|daulet)\b/i;
const FEMALE = /\b(female|woman|hoda|zariyah|salma|amany|laila|zira|aria|jenny|sonia|denise|elvira|katja|elsa)\b/i;

function bestVoice(lang) {
  const voices = speechSynthesis.getVoices()
    .filter((v) => v.lang.toLowerCase().startsWith(lang) && MALE.test(v.name) && !FEMALE.test(v.name));
  const score = (v) => (/natural|online|neural/i.test(v.name) ? 3 : 0) + (/google/i.test(v.name) ? 1 : 0)
    + (/sa|ae|kw|qa|bh|om/i.test(v.lang.slice(3)) ? 1 : 0);
  return voices.sort((a, b) => score(b) - score(a))[0];
}

// The last resort when the server's voice can't speak. Without a male voice for the language he stays
// silent (his answer is still written in the chat) rather than speak in someone else's voice.
function browserSpeak(text, t, lang) {
  if (muted || !('speechSynthesis' in window)) return finish(t);
  const u = new SpeechSynthesisUtterance(text);
  u.lang = byCode(lang)?.speech || (isArabic(text) ? 'ar-SA' : 'en-US');
  const voice = bestVoice(u.lang.split('-')[0].toLowerCase());
  if (!voice) return finish(t);
  u.voice = voice;
  u.rate = 0.95;
  u.onend = u.onerror = () => finish(t);
  speechSynthesis.speak(u);
}
