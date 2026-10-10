// "Ask about this piece": the visitor types or speaks a question about the open hotspot,
// Claude answers through scripts/server.py, and the answer is read aloud.
// Hidden when the page runs without that server (python -m http.server, GitHub Pages).

const $ = (id) => document.getElementById(id);
const lang = () => document.documentElement.dataset.lang || 'ar';
const isArabic = (text) => /[؀-ۿ]/.test(text);
const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;

let available = false;
let spot = null;
const chats = new Map();     // hotspot id -> [{ role, content }]
let busy = false;
let listening = null;

export async function initAsk() {
  try {
    const res = await fetch('/api/health', { cache: 'no-store' });
    available = res.ok && (await res.json()).ask === true;
  } catch {
    available = false;
  }
  $('askMic').hidden = !Recognition;
  labels();
}

export function askFor(h) {
  stopListening();
  spot = h;
  $('ask').hidden = !available || !h;
  renderChat();
}

function labels() {
  const en = lang() === 'en';
  $('askTitle').textContent = en ? 'Ask about this piece' : 'اسأل عن هذي القطعة';
  $('askInput').placeholder = en ? 'e.g. What do these carvings show?' : 'مثلاً: وش تمثل هالنقوش؟';
  $('askInput').dir = en ? 'ltr' : 'rtl';
  $('askSend').textContent = en ? 'Ask' : 'اسأل';
  $('askMic').setAttribute('aria-label', en ? 'Ask with your voice' : 'اسأل بصوتك');
}

function bubble(role, text, extra = '') {
  const div = document.createElement('div');
  div.className = `msg ${role} ${extra}`.trim();
  div.dir = isArabic(text) ? 'rtl' : 'ltr';
  div.textContent = text;
  return div;
}

function renderChat() {
  const box = $('chat');
  box.innerHTML = '';
  for (const m of chats.get(spot?.id) || []) box.appendChild(bubble(m.role, m.content));
  box.hidden = !box.children.length;
}

function speak(text) {
  if (!('speechSynthesis' in window)) return;
  document.dispatchEvent(new Event('hotspot:play'));   // pauses the scene's audio tour
  speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(text);
  u.lang = isArabic(text) ? 'ar-SA' : 'en-US';
  const voice = speechSynthesis.getVoices().find((v) => v.lang.toLowerCase().startsWith(u.lang.slice(0, 2)));
  if (voice) u.voice = voice;
  u.rate = 0.95;
  speechSynthesis.speak(u);
}

async function send(question) {
  question = question.trim();
  if (!question || busy || !spot) return;
  const id = spot.id;
  const history = chats.get(id) || [];
  const en = lang() === 'en';

  busy = true;
  $('askSend').disabled = true;
  $('askInput').value = '';
  const box = $('chat');
  box.hidden = false;
  box.appendChild(bubble('user', question));
  const wait = box.appendChild(bubble('assistant', en ? 'Thinking…' : 'لحظة…', 'pending'));
  wait.scrollIntoView({ block: 'nearest', behavior: 'smooth' });

  let answer;
  try {
    const res = await fetch('/api/ask', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, question, lang: lang(), history }),
    });
    if (!res.ok) throw new Error(res.status);
    answer = (await res.json()).answer;
  } catch {
    answer = null;
  }

  wait.remove();
  if (answer) {
    history.push({ role: 'user', content: question }, { role: 'assistant', content: answer });
    chats.set(id, history);
    if (spot?.id === id) {
      box.appendChild(bubble('assistant', answer)).scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      speak(answer);
    }
  } else if (spot?.id === id) {
    box.appendChild(bubble('assistant', en ? "I couldn't answer right now. Try again in a moment." : 'ما قدرت أجاوب الحين. جرّب بعد شوي.', 'error'));
  }
  busy = false;
  $('askSend').disabled = false;
}

// ---------- Voice question (Chrome, Edge, Safari) ----------
function startListening() {
  if (!Recognition || listening) return;
  const r = new Recognition();
  r.lang = lang() === 'en' ? 'en-US' : 'ar-SA';
  r.interimResults = true;
  r.onresult = (e) => {
    const text = [...e.results].map((x) => x[0].transcript).join('');
    $('askInput').value = text;
    if (e.results[e.results.length - 1].isFinal) send(text);
  };
  r.onend = r.onerror = () => { listening = null; $('askMic').classList.remove('on'); };
  if ('speechSynthesis' in window) speechSynthesis.cancel();
  listening = r;
  $('askMic').classList.add('on');
  r.start();
}

function stopListening() {
  if (listening) listening.abort();
  listening = null;
  $('askMic')?.classList.remove('on');
}

$('askForm').addEventListener('submit', (e) => { e.preventDefault(); send($('askInput').value); });
$('askMic').addEventListener('click', () => (listening ? stopListening() : startListening()));
document.addEventListener('langchange', labels);
