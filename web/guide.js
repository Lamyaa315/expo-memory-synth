// The tour guide, Saad: the visitor asks about whatever is in front of them ("which civilization is this from?",
// "how old is it?"). The question goes to scripts/server.py with a picture of the current view, so the model
// can see the piece and read any museum label in it. He answers in the visitor's language (languages.js), out
// loud or as text only, as the visitor chooses. Facts come only from the labels and the pavilion's notes.
// Hidden when the page runs without that server (python -m http.server, GitHub Pages).

import * as voice from './voice.js';
import { SCENE, sceneUrl } from './scene-config.js';
import { captureView } from './hotspots.js';
import { speakLang } from './languages.js';

const $ = (id) => document.getElementById(id);
const lang = () => document.documentElement.dataset.lang || 'ar';
const isRtl = (text) => /[֐-ࣿ]/.test(text);
const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
const MODE_KEY = 'expo-reply';

const history = [];   // [{ role, content }] for this pavilion
let demo = false;
let busy = false;
let listening = null;
let spoken = true;    // his answers out loud (true) or as text only

export async function initGuide() {
  let available = false;
  try {
    const res = await fetch('/api/health', { cache: 'no-store' });
    available = res.ok && (await res.json()).guide === true;
  } catch { /* static server */ }
  if (!available) return;
  $('guide').hidden = false;
  $('guideBtn').hidden = false;
  $('askBtn').hidden = false;
  usePhoto();
  $('guideMic').hidden = !Recognition;
  try { spoken = localStorage.getItem(MODE_KEY) !== 'text'; } catch { /* private window */ }
  // Notes marked as demo (web/scenes/<id>/guide.json) are not from the museum: say so under his name
  try {
    const res = await fetch(sceneUrl('guide.json'), { cache: 'no-cache' });
    demo = res.ok && (await res.json()).demo === true;
  } catch { demo = false; }
  labels();
  // He waves and introduces himself once the scene is up, and the greeting stays while the panel is closed
  setTimeout(() => {
    $('guideBtn').classList.add('waving');
    greet();
    setTimeout(() => $('guideBtn').classList.remove('waving'), 2200);
  }, 2500);
  document.addEventListener('panel:close', () => {
    $('panel').classList.remove('guide-mode');
    document.body.classList.remove('asking');
    greet();
  });
  // At each stop his bubble says a line about it (tour.js sends the stop with its text); the first stop greets
  document.addEventListener('tour:arrive', (e) => {
    here = e.detail.index > 0 ? e.detail.story : null;
    greet();
  });
}

// What his bubble says: the greeting at the start, then a line about the stop the visitor is at
let here = null;
function greet() {
  if (!$('panel').classList.contains('closed')) return;
  say(lineFor(here) || speakLang().greet);
}

// The first sentence of what he tells at the stop (Arabic), or its name and an invitation to ask
function lineFor(stop) {
  if (!stop) return '';
  const code = speakLang().code;
  if (code === 'ar' && stop.say) {
    const first = stop.say.split(/(?<=[.!؟?…])\s+/)[0].trim();
    return first.length > 90 ? first.slice(0, 88).replace(/\s+\S*$/, '') + '…' : first;
  }
  if (code === 'en') return `This is ${stop.title_en || 'the next stop'}. Ask me anything about it!`;
  return '';   // other languages: his greeting in that language stays
}

// A realistic picture (web/guide.png) replaces the drawing when it exists
function usePhoto() {
  const img = $('guidePhoto');
  img.onload = () => { img.hidden = false; $('guideBtn').classList.add('has-photo'); };
  img.onerror = () => img.remove();
  img.src = 'guide.png';
}

// A short line in his speech bubble
let bubbleTimer = null;
function say(text, ms = 0) {
  const b = $('guideBubble');
  clearTimeout(bubbleTimer);
  // The direction goes on the words, not the bubble: its place beside him follows the page's direction
  const words = document.createElement('span');
  words.dir = isRtl(text) ? 'rtl' : 'ltr';
  words.textContent = text;
  b.replaceChildren(words);
  b.classList.toggle('on', !!text);
  if (text && ms) bubbleTimer = setTimeout(() => b.classList.remove('on'), ms);
}

// Open the chat with him (from the floating button): the panel shows only the conversation
function open() {
  document.dispatchEvent(new Event('guide:open'));   // pauses the automatic tour
  document.dispatchEvent(new Event('tour:move'));   // closes an open hotspot, back to the main view
  const panel = $('panel');
  panel.classList.remove('closed', 'collapsed');
  panel.classList.add('guide-mode');
  document.body.classList.add('asking');   // the tour's bars step aside, like the design's ask screen
  $('spotView').hidden = true;
  $('storyView').hidden = false;
  say('');
  welcome();
  $('guideInput').focus({ preventScroll: true });
}

// His first message in the chat, in the visitor's language (swapped if they change it before asking)
function welcome() {
  const box = $('guideChat');
  const first = box.firstElementChild;
  if (first && !first.classList.contains('welcome')) return;
  box.replaceChildren(bubble('assistant', speakLang().greet, 'welcome'));
}

function labels() {
  const en = lang() === 'en';
  $('guideTitle').textContent = en ? 'Saad, your guide' : 'سعد، مرشدك';
  $('guideInput').placeholder = en ? 'e.g. How old is this stone?' : 'مثلاً: كم عمر هالحجر؟';
  $('guideInput').dir = speakLang().dir || (speakLang().code === 'ar' ? 'rtl' : 'ltr');
  $('guideSend').textContent = en ? 'Ask' : 'اسأل';
  $('guideDemo').hidden = !demo;
  $('guideDemo').textContent = en ? 'Demo info' : 'معلومات تجريبية';
  $('guideDemo').title = en ? 'Demo information for this showcase, not from the museum labels yet' : 'معلومات تجريبية للعرض، مو من لوحات المتحف';
  $('guideMic').setAttribute('aria-label', en ? 'Ask with your voice' : 'اسأل بصوتك');
  $('guideBtn').setAttribute('aria-label', en ? 'Talk to Saad, the guide' : 'كلّم سعد، المرشد');
  $('replyMode').textContent = spoken ? (en ? '🔊 Voice' : '🔊 صوت') : (en ? '💬 Text' : '💬 كتابة');
  $('replyMode').title = spoken
    ? (en ? 'Saad answers out loud. Tap for text only' : 'سعد يرد بالصوت. اضغط عشان يرد كتابة بس')
    : (en ? 'Saad answers in text. Tap to hear him' : 'سعد يرد كتابة. اضغط عشان تسمعه');
  $('replyMode').setAttribute('aria-pressed', String(spoken));
  $('guideBubble').dataset.cta = en ? '✦ Tap Saad' : '✦ اضغط على سعد';
  $('micHint').textContent = listening ? (en ? 'Saad is listening… tap again when you finish' : 'سعد يسمعك… اضغط مرة ثانية إذا خلصت')
    : (en ? 'Tap and ask with your voice' : 'اضغط واسأل بصوتك');
  // ready questions: one tap asks them
  const chips = en
    ? ['Which civilization is this from?', 'How old is it?', 'What does it look like elsewhere?']
    : ['من أي حضارة هذا؟', 'كم عمره تقريباً؟', 'وش يشبهه في حضارات ثانية؟'];
  $('guideChips').replaceChildren(...chips.map((q) => {
    const b = Object.assign(document.createElement('button'), { type: 'button', className: 'chip', textContent: q });
    b.addEventListener('click', () => send(q));
    return b;
  }));
  if (!$('panel').classList.contains('closed') && $('panel').classList.contains('guide-mode')) welcome();
  else if ($('guideBubble').classList.contains('on')) greet();
}

function setSpoken(on) {
  spoken = on;
  try { localStorage.setItem(MODE_KEY, on ? 'voice' : 'text'); } catch { /* private window */ }
  if (!on) { voice.stop(); $('guideBtn').classList.remove('speaking'); }
  labels();
}

function bubble(role, text, extra = '') {
  const div = document.createElement('div');
  div.className = `msg ${role} ${extra}`.trim();
  div.dir = isRtl(text) ? 'rtl' : 'ltr';
  div.textContent = text;
  return div;
}

async function send(question) {
  question = question.trim();
  if (!question || busy) return;
  const en = lang() === 'en';
  const speech = speakLang();
  busy = true;
  try { localStorage.setItem('laqya-asked', String(+(localStorage.getItem('laqya-asked') || 0) + 1)); } catch {}   // the account's "asked Saad" stamp
  if (spoken) voice.unlock();   // still inside the tap: lets the spoken answer play when it arrives
  $('guideSend').disabled = true;
  $('guideInput').value = '';
  const box = $('guideChat');
  box.querySelector('.welcome')?.classList.remove('welcome');   // the conversation has started: keep it
  box.appendChild(bubble('user', question));
  const wait = box.appendChild(bubble('assistant', '…', 'pending'));
  wait.scrollIntoView({ block: 'nearest', behavior: 'smooth' });

  let answer = null;
  try {
    // What the visitor is looking at right now (without it he answers from the pavilion's notes)
    const image = await captureView().catch(() => null);
    const res = await fetch('/api/guide', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        scene: SCENE.id, scene_title: en ? SCENE.title_en : SCENE.title,
        image, question, lang: speech.code, history,
      }),
    });
    if (res.ok) answer = (await res.json()).answer;
  } catch { /* shown below */ }

  wait.remove();
  if (answer) {
    history.push({ role: 'user', content: question }, { role: 'assistant', content: answer });
    const reply = box.appendChild(bubble('assistant', answer));
    reply.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    document.dispatchEvent(new Event('hotspot:play'));   // pauses the scene's audio tour
    if (spoken) {
      $('guideBtn').classList.add('speaking');
      voice.speak(answer, {
        lang: speech.code,
        onend: () => $('guideBtn').classList.remove('speaking'),
        onblocked: (play) => {   // the browser wants a tap before it plays sound
          $('guideBtn').classList.remove('speaking');
          const b = document.createElement('button');
          b.type = 'button';
          b.className = 'ghost listen-btn';
          b.textContent = en ? '▶ Play the answer' : '▶ اسمع الجواب';
          b.addEventListener('click', () => { b.remove(); $('guideBtn').classList.add('speaking'); play(); });
          reply.after(b);
        },
      });
    }
  } else {
    box.appendChild(bubble('assistant', en ? "I couldn't answer right now. Try again in a moment." : 'ما قدرت أجاوب الحين. جرّب بعد شوي.', 'error'));
  }
  busy = false;
  $('guideSend').disabled = false;
}

// ---------- Voice question (Chrome, Edge, Safari) ----------
function startListening() {
  if (!Recognition || listening) return;
  const r = new Recognition();
  r.lang = speakLang().speech;
  r.interimResults = true;
  r.onresult = (e) => {
    const text = [...e.results].map((x) => x[0].transcript).join('');
    $('guideInput').value = text;
    if (e.results[e.results.length - 1].isFinal) send(text);
  };
  r.onend = r.onerror = () => { listening = null; $('guideMic').classList.remove('on'); labels(); };
  voice.stop();
  listening = r;
  $('guideMic').classList.add('on');
  labels();
  r.start();
}

function stopListening() {
  if (listening) listening.abort();
  listening = null;
  $('guideMic').classList.remove('on');
}

$('guideForm').addEventListener('submit', (e) => { e.preventDefault(); send($('guideInput').value); });
$('guideMic').addEventListener('click', () => (listening ? stopListening() : startListening()));
$('replyMode').addEventListener('click', () => setSpoken(!spoken));
$('guideBtn').addEventListener('click', open);
document.addEventListener('langchange', labels);
