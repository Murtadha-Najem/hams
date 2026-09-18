# Hams

**Messages between nearby devices by sound, with no internet.**

Hams ("whisper" in Arabic) turns a message into tones between 18 and 19.8 kHz, above what most adults can hear. Another device picks them up with its microphone and turns them back into text. It runs in the browser, and after the first visit it works offline.

**Try it:** https://murtadha203.github.io/hams/

## Features

- **Messages by sound:** text, codes, links, Wi-Fi passwords, or anything up to 3000 bytes. Long messages are split into parts and reassembled on the receiving side, in any order.
- **Receipts:** choose how many devices must confirm. After each round the sender falls silent and listens. Every device that got the message answers with its name, and the broadcast stops once enough have confirmed.
- **Sealed messages:** encrypted with a shared code, so only devices holding the same code can read them. Everyone else ignores them silently and sends no receipt.
- **Two bands, two speeds:** inaudible, or audible (more reliable on weak hardware), each with a robust and a normal speed. The receiver works out which one is in use by itself.
- **Two-device test:** a frequency sweep that shows which frequencies get through between two devices and suggests a mode.

## How to use it

1. Open the link on both devices.
2. On the receiver, open **Receive** and tap the circle to start listening.
3. On the sender, type the message and tap **Send**.

Both devices need to be in the same room, ideally with the speaker facing the microphone. It has been tested up to 2 m.

## Speed

| Mode | 10-byte message | 48-byte message |
|---|---|---|
| Inaudible, robust | 1.2 s | 3.7 s |
| Inaudible, normal | 0.7 s | 1.7 s |
| Audible, robust / normal | 1.0 / 0.6 s | 3.0 / 1.5 s |

Arabic text is packed at 6 bits a character instead of UTF-8's 16, so Arabic messages come out about 2.3 times smaller.

## How it works

| Layer | File | What it does |
|---|---|---|
| Modem | `modem.js` | Multi-tone FSK in 50 Hz bins. An 80 ms chirp handles detection and timing, and its direction names the mode. A 26-bit header comes next, then the payload. A K=7 convolutional code with soft-decision Viterbi, plus a time and frequency interleaver. When a copy fails, the receiver keeps its soft values and adds them to the next repeat until the packet decodes. |
| Messages | `protocol.js` | Splits long messages into 120-byte parts, handles receipts, and seals and opens messages with AES-GCM (64-bit tag, PBKDF2 key, and a one-byte hint so a receiver only tries codes that can match). |
| Text | `codec.js` | Arabic at 6 bits a character, ASCII at 7, UTF-8 otherwise, whichever is smallest. |
| App | `app.js`, `index.html` | The interface, the receipt windows, and the offline service worker. |

**Receipts:** the last packet of each round carries a flag. After it, the sender stays silent for three receipt slots, and every receiver that can read the message answers in a slot picked at random. Each device has a fixed random 16-bit number, so the sender counts distinct receivers, not repeated receipts.

## Limitations

- **Tested on little hardware:** an Android phone sending to a Windows laptop. Phone to phone and iPhone have not been tested yet.
- **Sound can leave the room:** in one test a message got through from behind a wall, most likely through the door. Do not rely on it as proof that someone is in the room.
- **Encryption is only as strong as the code:** a short code can be guessed, so use one longer than 8 characters.
- **Codes are stored in the browser** on that device, with no extra encryption.
- **Two devices broadcasting at once** collide, and their messages get through on the next round.
- **The font loads from Google Fonts** on the first visit. It is cached after that.

## Tests

```
npm test        # text codec, message layer, full flow through a simulated room, quick modem run
npm run sim     # full modem table: noise, echo, clock drift, 44.1/48 kHz (about 5 minutes)
```

`test/sim.mjs` models reverb, speaker roll-off, clock error, sample-rate mismatch, noise and speech. In it, the robust mode decodes down to about 0 dB in-band SNR and the normal mode down to about 6 dB. Repeats combine: at 3 dB, where a single copy never decodes, three copies decode 9 times in 10. A minute of noise and speech produced no false messages.

In a real test (Android phone to Windows laptop, at 1 m, 2 m and behind a wall, with 10-byte messages), the robust mode decoded 9 of 9 on the first attempt and the normal mode 8 of 9. A faster mode was dropped because it failed in that room's echo, and so did every faster design tried in simulation.

## Run locally

The microphone needs `https` or `localhost`:

```
python -m http.server 8766
```

## Licence

MIT
