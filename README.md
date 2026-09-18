# Hams

**Chat with nearby devices by sound, with no internet.**

Hams ("whisper" in Arabic) is a chat that travels as tones between 18 and 19.8 kHz, above what most adults can hear. Every device in the room with Hams open picks up the tones with its microphone and shows the message. It runs in the browser, and after the first visit it works offline.

**Try it:** https://murtadha203.github.io/hams/

## Features

- **Public room:** everyone nearby with Hams open can read it and reply. Its messages clear after 24 hours; groups keep their history.
- **Groups:** a group is a shared code. Its messages are encrypted with that code, so only members see them; everyone else ignores them silently.
- **Delivery marks:** a clock while sending, one tick once the message has gone out, and two ticks once at least one device confirms it received the message. Tap a message to see who received it. If nobody confirms after a few rounds, the message is marked as not delivered and can be sent again.
- **Replies:** tap a message and reply to it; the reply carries a quote of the original.
- **Names:** everyone picks a name when they join. Each device also has a fixed random number, so two people with the same name stay apart.
- **Long messages:** up to 3000 bytes, split into parts and reassembled in any order.
- **Two bands, two speeds:** inaudible or audible, robust or normal. Receivers work out the mode by themselves.
- **Two-device test:** a frequency sweep that shows which frequencies get through between two devices.

## How to use it

1. Open the link on two or more devices in the same room.
2. Enter a name and tap **Join**. This turns on the microphone.
3. Write a message. The others see it appear, and your message gets two ticks when someone has it.

For a private conversation, tap **New group** and agree on a code with the others in person.

It works best with the speaker facing the other device. It has been tested up to 2 m.

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
| Chat | `protocol.js` | A chat message carries the sender's device number, name, an optional reply reference, and the text. Open in the public room, sealed with the group code in a group. |
| App | `app.js`, `index.html` | The chat, the outbox (one broadcast at a time), the receipt windows, and the offline service worker. |

**Receipts:** the last packet of each round carries a flag. After it, the sender stays silent for three receipt slots, and every device that can read the message answers in a slot picked at random. A message goes out in up to five rounds and stops at the first round that brings a receipt.

## Limitations

- **Tested on little hardware:** an Android phone sending to a Windows laptop. Phone to phone and iPhone have not been tested yet.
- **Sound can leave the room:** in one test a message got through from behind a wall, most likely through the door. Do not rely on it as proof that someone is in the room.
- **Encryption is only as strong as the code:** a short code can be guessed, so use one longer than 8 characters.
- **Codes are stored in the browser** on that device, with no extra encryption.
- **Two devices sending at once** collide, and their messages get through on a later round.
- **Groups are only as private as the code**, and anyone who has the code can read and write in the group.
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
