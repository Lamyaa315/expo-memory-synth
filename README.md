# Expo Memory Synth

تجربة تشاركية للزائر اللي ما يقدر يسافر للرياض: زائر في الموقع يصور الجناح بجواله، ونبني منه مشهد ثلاثي الأبعاد (Gaussian Splatting) مع سرد ثقافي وصوت محيطي، يفتحه أي شخص بعيد من رابط.

**المسار:** الإرث الثقافي والترويج، تحدي 6.5 (الزائر الذي لا يستطيع السفر إلى الرياض)

## كيف يشتغل

```
فيديو من الجوال
   ↓  scripts/extract_frames.py
فريمات
   ↓  scripts/blur_faces.py        (خصوصية: طمس الوجيه)
   ↓  COLMAP                        (مكان الكاميرا لكل صورة)
   ↓  gsplat                        (بناء المشهد 3D)
scene.ply
   ↓  scripts/narrate.py            (LLM يكتب السرد + وصف الصوت)
   ↓  scripts/make_audio.py         (تحويل السرد لصوت)
web/  ←  الزائر البعيد يفتح الرابط
```

## هيكل الريبو

| المسار | الوصف |
|---|---|
| `notebooks/01_reconstruction_colab.ipynb` | النوتبوك الكامل على Google Colab: من الفيديو لملف `.ply` |
| `scripts/extract_frames.py` | تقطيع الفيديو لفريمات (يدعم قص جزء معين) |
| `scripts/blur_faces.py` | طمس الوجيه قبل البناء |
| `scripts/narrate.py` | يرسل لقطات لموديل رؤية ويطلع `web/narration.json` |
| `scripts/make_audio.py` | يحول السرد العربي لملف صوتي |
| `web/index.html` | صفحة العرض: المشهد 3D + السرد + الصوت |
| `web/narration.json` | ملف سرد مثال (ينكتب فوقه بعد تشغيل narrate.py) |

## البداية السريعة

### 1. بناء المشهد (Colab)
1. افتحوا `notebooks/01_reconstruction_colab.ipynb` في Google Colab (من GitHub مباشرة: `File > Open notebook > GitHub`).
2. اختاروا **T4 GPU** من `Runtime > Change runtime type`.
3. ارفعوا الفيديو على Drive داخل مجلد `expo-memory-synth`، وعدلوا `VIDEO_NAME` بالنوتبوك.
4. شغلوا الخلايا بالترتيب. بالنهاية ينزل ملف `.ply`.

**نصايح التصوير:** امشوا حول القطعة ببطء (orbit)، 20-60 ثانية، لقطة وحدة بدون قص، إضاءة ثابتة، وبدون ناس يتحركون قدام الكاميرا.

### 2. تنظيف المشهد
افتحوا الملف في [SuperSplat](https://superspl.at/editor)، قصوا الأطراف المشوهة، وصدروه. حطوه في `web/scene.ply`.

### 3. السرد والصوت
```bash
pip install -r requirements.txt
export ANTHROPIC_API_KEY=your_key_here          # Windows PowerShell: $env:ANTHROPIC_API_KEY="your_key_here"
python scripts/narrate.py data/scene1/images --place "المتحف الوطني، الرياض"
python scripts/make_audio.py
```
الصوت المحيطي: خذوا `ambient_prompt` من `web/narration.json`، ولدوا منه صوت بأي أداة text-to-audio، واحفظوه في `web/audio/ambient.mp3`.

### 4. تشغيل الموقع محلياً
الصفحة تحتاج سيرفر بسيط (ما تشتغل بفتح الملف مباشرة):
```bash
cd web
python -m http.server 8000
```
افتحوا `http://localhost:8000`. إذا ما فيه `scene.ply`، تقدرون تختارون أي ملف من زر "افتح مشهد".

إذا طلع المشهد مقلوب أو بعيد، عدلوا قيم `CAMERA` أعلى السكربت في `web/index.html`.

### 5. النشر برابط (GitHub Pages)
`Settings > Pages > Deploy from a branch`، واختاروا مجلد `/web` أو انقلوا محتواه للـ root. ملفات `.ply` الكبيرة ممكن تتجاوز حدود GitHub (100MB للملف)، فالأفضل تضغطونها بـ SuperSplat أو تحولونها لـ `.ksplat`.

## مصادر بيانات للتجربة
- [Mip-NeRF 360](https://jonbarron.info/mipnerf360/): مشاهد جاهزة مع مواقع الكاميرا.
- [Open Heritage 3D](https://openheritage3d.org/data): بيانات تراث حقيقية بترخيص Creative Commons (اذكروا المصدر والـ DOI عند الاستخدام).

## الأدوات المستخدمة
[gsplat](https://github.com/nerfstudio-project/gsplat) للتدريب، [COLMAP](https://colmap.github.io/) لمواقع الكاميرا، و[GaussianSplats3D](https://github.com/mkkellogg/GaussianSplats3D) للعرض بالمتصفح.

## خارطة الطريق
- [ ] رفع الصور من الزائر في الموقع مباشرة من صفحة الويب
- [ ] موديلات feed-forward (مثل MVSplat) لبناء المشهد في ثوانٍ بدل دقائق
- [ ] دمج لقطات عدة زوار لتحديث المشهد باستمرار
- [ ] كشف الأشخاص المتحركين وحذفهم قبل البناء
