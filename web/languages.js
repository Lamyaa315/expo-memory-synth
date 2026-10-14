// The languages a visitor can pick: the main languages of the countries taking part in Expo 2030 Riyadh.
// Saad (the guide) answers and talks in the chosen one (scripts/server.py has the same list). The page's own
// text is written in Arabic and English only, so any other choice shows the page in English.

export const LANGUAGES = [
  { code: 'ar', name: 'العربية', speech: 'ar-SA', greet: 'هلا والله! أنا سعد، مرشدك. اسألني عن اللي تبي' },
  { code: 'en', name: 'English', speech: 'en-US', greet: "Hello! I'm Saad, your guide. Ask me anything you like." },
  { code: 'fr', name: 'Français', speech: 'fr-FR', greet: 'Bonjour ! Je suis Saad, votre guide. Posez-moi vos questions.' },
  { code: 'es', name: 'Español', speech: 'es-ES', greet: '¡Hola! Soy Saad, tu guía. Pregúntame lo que quieras.' },
  { code: 'pt', name: 'Português', speech: 'pt-BR', greet: 'Olá! Eu sou o Saad, seu guia. Pergunte o que quiser.' },
  { code: 'de', name: 'Deutsch', speech: 'de-DE', greet: 'Hallo! Ich bin Saad, dein Guide. Frag mich, was du willst.' },
  { code: 'it', name: 'Italiano', speech: 'it-IT', greet: 'Ciao! Sono Saad, la tua guida. Chiedimi quello che vuoi.' },
  { code: 'nl', name: 'Nederlands', speech: 'nl-NL', greet: 'Hallo! Ik ben Saad, je gids. Vraag me wat je wilt.' },
  { code: 'ru', name: 'Русский', speech: 'ru-RU', greet: 'Здравствуйте! Я Саад, ваш гид. Спрашивайте о чём угодно.' },
  { code: 'uk', name: 'Українська', speech: 'uk-UA', greet: 'Вітаю! Я Саад, ваш гід. Питайте про що завгодно.' },
  { code: 'pl', name: 'Polski', speech: 'pl-PL', greet: 'Cześć! Jestem Saad, twój przewodnik. Pytaj, o co chcesz.' },
  { code: 'el', name: 'Ελληνικά', speech: 'el-GR', greet: 'Γεια σας! Είμαι ο Σαάντ, ο ξεναγός σας. Ρωτήστε με ό,τι θέλετε.' },
  { code: 'sv', name: 'Svenska', speech: 'sv-SE', greet: 'Hej! Jag är Saad, din guide. Fråga mig vad du vill.' },
  { code: 'tr', name: 'Türkçe', speech: 'tr-TR', greet: 'Merhaba! Ben Saad, rehberinizim. Bana istediğinizi sorun.' },
  { code: 'fa', name: 'فارسی', speech: 'fa-IR', dir: 'rtl', greet: 'سلام! من سعد هستم، راهنمای شما. هر چه می‌خواهید بپرسید.' },
  { code: 'ur', name: 'اردو', speech: 'ur-PK', dir: 'rtl', greet: 'السلام علیکم! میں سعد ہوں، آپ کا گائیڈ۔ جو چاہیں پوچھیں۔' },
  { code: 'hi', name: 'हिन्दी', speech: 'hi-IN', greet: 'नमस्ते! मैं साद हूँ, आपका गाइड। जो चाहें पूछिए।' },
  { code: 'bn', name: 'বাংলা', speech: 'bn-BD', greet: 'নমস্কার! আমি সাদ, আপনার গাইড। যা খুশি জিজ্ঞেস করুন।' },
  { code: 'zh', name: '中文', speech: 'zh-CN', greet: '你好！我是萨德，你的导游。想问什么都可以。' },
  { code: 'ja', name: '日本語', speech: 'ja-JP', greet: 'こんにちは！ガイドのサードです。何でも聞いてください。' },
  { code: 'ko', name: '한국어', speech: 'ko-KR', greet: '안녕하세요! 저는 가이드 사드예요. 무엇이든 물어보세요.' },
  { code: 'id', name: 'Bahasa Indonesia', speech: 'id-ID', greet: 'Halo! Saya Saad, pemandu Anda. Tanyakan apa saja.' },
  { code: 'ms', name: 'Bahasa Melayu', speech: 'ms-MY', greet: 'Helo! Saya Saad, pemandu anda. Tanyalah apa sahaja.' },
  { code: 'th', name: 'ไทย', speech: 'th-TH', greet: 'สวัสดีครับ! ผมชื่อซาอัด ไกด์ของคุณ ถามอะไรก็ได้ครับ' },
  { code: 'vi', name: 'Tiếng Việt', speech: 'vi-VN', greet: 'Xin chào! Tôi là Saad, hướng dẫn viên của bạn. Hãy hỏi tôi bất cứ điều gì.' },
  { code: 'fil', name: 'Filipino', speech: 'fil-PH', greet: 'Kumusta! Ako si Saad, ang iyong gabay. Magtanong ka ng kahit ano.' },
  { code: 'sw', name: 'Kiswahili', speech: 'sw-KE', greet: 'Habari! Mimi ni Saad, kiongozi wako. Niulize chochote.' },
  { code: 'am', name: 'አማርኛ', speech: 'am-ET', greet: 'ሰላም! እኔ ሳአድ ነኝ፣ አስጎብኚዎ። የፈለጉትን ይጠይቁኝ።' },
  { code: 'so', name: 'Soomaali', speech: 'so-SO', greet: 'Salaan! Waxaan ahay Saad, hagahaaga. I weydii wax kasta.' },
  { code: 'uz', name: 'Oʻzbekcha', speech: 'uz-UZ', greet: 'Salom! Men Saad, sizning gidingizman. Xohlagan narsangizni soʻrang.' },
  { code: 'kk', name: 'Қазақша', speech: 'kk-KZ', greet: 'Сәлеметсіз бе! Мен Саад, сіздің гидіңізбін. Қалағаныңызды сұраңыз.' },
];

const KEY = 'expo-lang';
const byCode = (code) => LANGUAGES.find((l) => l.code === code);

// What Saad speaks: the visitor's choice (dataset.speak); the page's text uses dataset.lang (ar or en)
export const speakLang = () => byCode(document.documentElement.dataset.speak) || LANGUAGES[0];
export const uiLang = (code) => (code === 'ar' ? 'ar' : 'en');

export function savedLang() {
  try { return byCode(localStorage.getItem(KEY))?.code || null; } catch { return null; }
}

export function rememberLang(code) {
  try { localStorage.setItem(KEY, code); } catch { /* private window */ }
}

export { byCode };
