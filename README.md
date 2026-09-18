# همس (Hams)

A web app that sends short data between phones by sound, with no internet: text, codes, links, Wi-Fi passwords. Works in the near-ultrasonic band (18 to 19.8 kHz) or the audible band (2 to 4 kHz).

## Run it

The microphone only works over `https` or on `localhost`.

- On this computer: `python -m http.server 8766`, then open `http://localhost:8766`.
- On phones: host the folder on any https static host (GitHub Pages, for example). After the first visit a service worker caches the app, so it keeps working with no network.

## Modes

| Mode | Net rate | Needs (simulated room, in-band SNR) |
|---|---|---|
| near-ultrasonic, robust | about 13 B/s | about 0 dB |
| near-ultrasonic, normal | about 30 B/s | about 6 dB |
| near-ultrasonic, fast | about 41 B/s | about 12 to 15 dB |
| audible, robust / normal / fast | 17 / 34 / 47 B/s | similar |

The receiver works out the mode by itself. The sender only picks one.

## What it does beyond ggwave

- **Soft-decision decoding:** a K=7 convolutional code decoded with a soft Viterbi, with an interleaver across time and frequency.
- **Repeat combining:** the sender repeats until stopped. If a copy fails, the receiver keeps its soft values and adds them to the next copy. In simulation, a packet that never decodes from one copy decodes after two or three.
- **Chirp preamble:** detection and timing come from a matched filter, plus fine timing search and drift tracking. This tolerates clock mismatch, and a sender at 48 kHz with a receiver at 44.1 kHz.
- **Compact payloads:** Arabic text at 6 bits a character (about 2.3 times smaller than UTF-8), plain ASCII at 7 bits.
- **Test tab:** a frequency sweep between two devices, the microphone processing the browser actually applied, and an offline self-test.

## Tests

```
npm test          # codec round trips + quick simulation
npm run sim       # full simulation table (about 6 minutes)
```

`test/sim.mjs` models reverb, speaker roll-off, clock error, sample-rate mismatch, noise and speech. It is a model: real phones are the real test.
