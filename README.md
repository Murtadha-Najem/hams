<div dir="rtl">

# همس

**رسائل بالصوت بين الأجهزة، بدون إنترنت.**

همس يحوّل الرسالة لنغمات بين 18 و19.8 ألف هرتز، يعني فوق ما يسمعه أغلب البالغين، والجهاز الثاني يلتقطها بالمايك ويرجّعها نص. يشتغل بالمتصفح، وبعد أول فتحة يشتغل بدون نت.

**جرّبه:** https://murtadha203.github.io/hams/

## شنو يسوي

- **رسائل بالصوت:** نص، رمز، رابط، باسورد Wi-Fi، أو رسالة لحد 3000 بايت تنقسم لأجزاء وتتجمع عند المستلم.
- **تأكيد الاستلام:** تحدد كم جهاز لازم يستلم. المرسل يسكت بعد كل جولة ويسمع، وكل جهاز استلم الرسالة يرد بتأكيد فيه اسمه، ولما يوصل العدد البث يوقف.
- **رسائل محمية:** تنشفر برمز، وبس الأجهزة اللي عندها نفس الرمز تقراها. البقية يتجاهلونها بصمت وما يرسلون تأكيد.
- **وضعين للبث:** فوق سمعي (ما ينسمع) أو مسموع (أوثق على الأجهزة الضعيفة)، وكل واحد بسرعتين: متين وعادي. المستلم يعرف الوضع بنفسه.
- **فحص جهازين:** مسح ترددي يبين أي ترددات توصل بين جهازين ويقترح الوضع المناسب.

## شلون تستخدمه

1. افتح الرابط على الجهازين.
2. على المستلم: **الوارد**، ثم **ابدأ الاستماع**.
3. على المرسل: اكتب الرسالة واضغط **إرسال**.

الجهازين لازم يكونون بنفس الغرفة، والأفضل السماعة مواجهة للمايك. المسافة اللي جربناها لحد مترين.

## السرعة

| الوضع | رسالة 10 بايت | رسالة 48 بايت |
|---|---|---|
| فوق سمعي، متين | 1.2 ثانية | 3.7 ثانية |
| فوق سمعي، عادي | 0.7 ثانية | 1.7 ثانية |
| مسموع، متين / عادي | 1.0 / 0.6 ثانية | 3.0 / 1.5 ثانية |

النص العربي ينضغط لـ6 بت للحرف بدل 16، فالرسالة العربية أصغر بحدود مرتين وربع.

## حدود لازم تعرفها

- **جُرّب على أجهزة قليلة:** موبايل أندرويد يرسل ولابتوب ويندوز يستقبل. موبايل لموبايل وآيفون ما انجربت بعد.
- **الصوت يطلع من الغرفة أحياناً:** بتجربة وحدة وصلت الرسالة من خلف حائط، غالباً عن طريق الباب. فلا تعتمد عليه كدليل إن الشخص داخل الغرفة.
- **التشفير قوي بقدر الرمز:** AES-GCM بمفتاح مشتق من الرمز. الرمز القصير يتخمّن، فاستخدم رمز أطول من 8 حروف.
- **الرموز محفوظة بالمتصفح** على نفس الجهاز، بدون تشفير إضافي.
- **جهازين يبثون بنفس الوقت** رسائلهم تتصادم، وتنجح بالجولة الجاية.

</div>

---

## English

**Hams** ("whisper") sends short messages between devices by sound, with no network. It encodes data as tones in the 18 to 19.8 kHz band, above what most adults hear, and runs in the browser as an offline-capable web app.

**Features:** messages up to 3000 bytes (split into parts and reassembled), receipts that stop the broadcast once enough devices confirm, sealed messages (AES-GCM, key from a shared code, ignored by devices without it), an inaudible and an audible band with a robust and a normal speed, and a two-device frequency test.

### How it works

| Layer | File | What it does |
|---|---|---|
| Modem | `modem.js` | Multi-tone FSK in 50 Hz bins. An 80 ms chirp for detection and timing, and its direction names the mode. A 26-bit header, then the payload. A K=7 convolutional code with soft-decision Viterbi and a time and frequency interleaver. A receiver adds up the soft values of failed repeats until the packet decodes. |
| Messages | `protocol.js` | Splits long messages into 120-byte parts, handles receipts, seals and opens with AES-GCM (64-bit tag, PBKDF2 key, one-byte hint so a receiver only tries matching codes). |
| Text | `codec.js` | Arabic at 6 bits a character, ASCII at 7, UTF-8 otherwise, whichever is smallest. |
| App | `app.js`, `index.html` | The interface, the receipt windows, and the offline service worker. |

**Receipts:** the last packet of each round carries a flag. After it, the sender stays silent for three receipt slots, and every receiver that can read the message answers in a random slot. Each device has a fixed random 16-bit number, so the sender counts distinct receivers, not repeated receipts.

### Tests

```
npm test        # text codec, message layer, full flow through a simulated room, quick modem run
npm run sim     # full modem table: noise, echo, clock drift, 44.1/48 kHz (about 5 minutes)
```

`test/sim.mjs` models reverb, speaker roll-off, clock error, sample-rate mismatch, noise and speech. In it, the robust mode decodes down to about 0 dB in-band SNR and the normal mode down to about 6 dB. Repeats combine: at 3 dB, where a single copy never decodes, three copies decode 9 times in 10. There were no false messages in a minute of noise and speech.

In a real test (Android phone to Windows laptop, 1 m, 2 m and behind a wall, 10-byte messages), the robust mode decoded 9 of 9 on the first attempt and the normal mode 8 of 9. A faster mode was dropped: it failed in that room's echo, and every faster design tried in simulation did too.

### Run locally

The microphone needs `https` or `localhost`:

```
python -m http.server 8766
```

MIT licence.
