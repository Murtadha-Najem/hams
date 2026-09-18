# همس (Hams)

A web app that sends short data between phones by sound, with no internet: text, codes, links, Wi-Fi passwords. Works in the near-ultrasonic band (18 to 19.8 kHz) or the audible band (2 to 4 kHz).

## Run it

The microphone only works over `https` or on `localhost`.

- On this computer: `python -m http.server 8766`, then open `http://localhost:8766`.
- On phones: host the folder on any https static host (GitHub Pages, for example). After the first visit a service worker caches the app, so it keeps working with no network.

## Modes

| Mode | 10-byte message | 48-byte message | Needs (simulated room, in-band SNR) |
|---|---|---|---|
| near-ultrasonic, robust | 1.2 s | 3.7 s | about 0 dB |
| near-ultrasonic, normal | 0.7 s | 1.7 s | about 6 dB |
| audible, robust / normal | 1.0 / 0.6 s | 3.0 / 1.5 s | similar |

The receiver works out the mode from the start chirp (rising for robust, falling for normal). There is no faster mode: every faster design tried fell apart in a room with the echo measured in a real test, and the ones that survived came out slower than normal.

In that real test (phone to laptop, 1 m, 2 m and behind a wall, 10-byte messages), robust decoded 9 of 9 on the first attempt and normal 8 of 9.

## What it does beyond ggwave

- **Soft-decision decoding:** a K=7 convolutional code decoded with a soft Viterbi, with an interleaver across time and frequency.
- **Repeat combining:** the sender repeats until stopped. If a copy fails, the receiver keeps its soft values and adds them to the next copy. In simulation, a packet that never decodes from one copy decodes after two or three.
- **Short preamble:** an 80 ms chirp for detection, timing and the mode, then a 26-bit header in the packet's own mode (sent twice in normal, since a header cannot be combined across repeats). Fine timing search and drift tracking follow. This tolerates clock mismatch, and a sender at 48 kHz with a receiver at 44.1 kHz.
- **Compact payloads:** Arabic text at 6 bits a character (about 2.3 times smaller than UTF-8), plain ASCII at 7 bits.
- **Test tab:** a frequency sweep between two devices, the microphone processing the browser actually applied, and an offline self-test.

## Tests

```
npm test          # codec round trips + quick simulation
npm run sim       # full simulation table (about 6 minutes)
```

`test/sim.mjs` models reverb, speaker roll-off, clock error, sample-rate mismatch, noise and speech. It is a model: real phones are the real test.
