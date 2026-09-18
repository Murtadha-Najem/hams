// Simulated room between two phones: clock mismatch, different sample rates, speaker roll-off,
// reverb, noise and speech. Runs the real modem end to end and reports how many packets arrive.
//   node test/sim.mjs            full table
//   node test/sim.mjs quick      a short smoke run
import { pathToFileURL } from 'node:url';
import { buildPacket, Receiver, PROFILES, BANDS, fft, nextPow2, airtime } from '../modem.js';

let seed = 12345;
const rand = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
const randn = () => Math.sqrt(-2 * Math.log(rand() + 1e-12)) * Math.cos(2 * Math.PI * rand());

// windowed-sinc resampler: output sample j is taken at input position j * ratio
export function resample(x, ratio) {
  const out = new Float32Array(Math.floor(x.length / ratio));
  const W = 24, fc = Math.min(1, 1 / ratio) * 0.97;
  for (let j = 0; j < out.length; j++) {
    const pos = j * ratio, c = Math.floor(pos);
    let acc = 0;
    for (let i = c - W + 1; i <= c + W; i++) {
      if (i < 0 || i >= x.length) continue;
      const t = pos - i;
      const sinc = t === 0 ? fc : Math.sin(Math.PI * fc * t) / (Math.PI * t);
      acc += x[i] * sinc * (0.5 + 0.5 * Math.cos((Math.PI * t) / W));
    }
    out[j] = acc;
  }
  return out;
}

// reverb plus speaker/mic response, applied in the frequency domain
export function room(x, fs, { rt60, drr, tiltDb, band }) {
  const irLen = Math.round(rt60 * fs);
  const ir = new Float64Array(irLen);
  ir[0] = 1;
  let e = 0;
  const start = Math.round(0.002 * fs);
  for (let n = start; n < irLen; n++) { ir[n] = randn() * Math.exp((-6.9 * n) / (rt60 * fs)); e += ir[n] ** 2; }
  const g = Math.sqrt(10 ** (-drr / 10) / e);
  for (let n = start; n < irLen; n++) ir[n] *= g;
  const F = nextPow2(x.length + irLen);
  const xr = new Float64Array(F), xi = new Float64Array(F), hr = new Float64Array(F), hi = new Float64Array(F);
  xr.set(x); hr.set(ir);
  fft(xr, xi); fft(hr, hi);
  const f0 = BANDS[band].f0, span = BANDS[band].nbins * BANDS[band].df;
  for (let k = 0; k < F; k++) {
    const f = (Math.min(k, F - k) * fs) / F;
    const tilt = 10 ** ((-tiltDb * Math.max(0, Math.min(1, (f - f0) / span))) / 20);
    const a = xr[k] * hr[k] - xi[k] * hi[k], b = xr[k] * hi[k] + xi[k] * hr[k];
    xr[k] = a * tilt; xi[k] = b * tilt;
  }
  fft(xr, xi, true);
  return Float32Array.from(xr.subarray(0, x.length + irLen));
}

export function inBandPower(x, fs, band) {
  const F = nextPow2(x.length);
  const re = new Float64Array(F), im = new Float64Array(F);
  re.set(x);
  fft(re, im);
  const lo = BANDS[band].f0 - 25, hi = BANDS[band].f0 + BANDS[band].nbins * BANDS[band].df;
  let p = 0;
  for (let k = 0; k < F; k++) {
    const f = (Math.min(k, F - k) * fs) / F;
    if (f >= lo && f <= hi) p += re[k] ** 2 + im[k] ** 2;
  }
  return p / F / x.length;
}

// one trial: returns the timeline the receiver hears
export function scene({ pid, payloads, fsTx = 48000, fsRx = 48000, ppm = 60, snrDb, rt60 = 0.35, drr = 3, tiltDb = 8, speechDb = 30 }) {
  const band = PROFILES[pid].band;
  const parts = [new Float32Array(Math.round((0.2 + rand() * 0.5) * fsTx))];
  for (const p of payloads) {
    parts.push(buildPacket(p, pid, fsTx, { id: 45 }));
    parts.push(new Float32Array(Math.round(0.4 * fsTx)));
  }
  parts.push(new Float32Array(Math.round(0.6 * fsTx)));
  const tx = new Float32Array(parts.reduce((s, p) => s + p.length, 0));
  let o = 0;
  for (const p of parts) { tx.set(p, o); o += p.length; }

  let y = room(tx, fsTx, { rt60, drr, tiltDb, band });
  y = resample(y, (fsTx / fsRx) * (1 + ppm * 1e-6));
  const sig = inBandPower(buildPacket(payloads[0], pid, fsRx), fsRx, band);
  const span = BANDS[band].nbins * BANDS[band].df;
  const sigma = Math.sqrt(((sig * 10 ** (-snrDb / 10)) * (fsRx / 2)) / span);
  // speech-like interference: loud noise below 4 kHz (only meaningful for the ultrasonic band)
  // four one-pole stages keep it well below the band, as real speech mostly is
  const spAmp = band === 'U' ? sigma * 10 ** (speechDb / 20) : 0;
  const st = [0, 0, 0, 0];
  for (let i = 0; i < y.length; i++) {
    let v = randn();
    for (let j = 0; j < 4; j++) v = st[j] = 0.9 * st[j] + 0.1 * v;
    y[i] += sigma * randn() + spAmp * v * 8;
  }
  return y;
}

export function listen(y, fsRx) {
  const got = [];
  const rx = new Receiver(fsRx, { onPacket: (p) => got.push(p) });
  for (let i = 0; i < y.length; ) {
    const n = 1024 + Math.floor(rand() * 3072);
    rx.push(y.subarray(i, i + n));
    i += n;
  }
  return got;
}

export const same = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);
export const payloadOf = (n) => Uint8Array.from({ length: n }, () => Math.floor(rand() * 256));

export function trialRate(pid, snrDb, trials, opts = {}) {
  let ok = 0, snrs = [];
  for (let t = 0; t < trials; t++) {
    const p = payloadOf(opts.len || 48);
    const fsRx = t % 2 ? 44100 : 48000;
    const got = listen(scene({ pid, payloads: [p], snrDb, fsRx, ...opts }), fsRx);
    if (got.some((g) => same(g.bytes, p))) { ok++; snrs.push(got[0].snrDb); }
  }
  return { ok, trials };
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
const quick = process.argv[2] === 'quick';
const t0 = Date.now();

console.log('profile     airtime 10 B   48 B');
for (const p of PROFILES) console.log(`${p.key.padEnd(11)} ${airtime(10, p.id).toFixed(2).padStart(8)} s ${airtime(48, p.id).toFixed(2).padStart(6)} s`);

const snrs = quick ? [12, 3] : [15, 9, 6, 3, 0, -3];
const trials = quick ? 4 : 10;
console.log(`\nsuccess out of ${trials}, 48-byte payload, reverb RT60 0.35 s, 8 dB roll-off, 60 ppm clock error, half the trials at 44.1 kHz`);
console.log('in-band SNR ' + snrs.map((s) => String(s).padStart(5)).join(''));
for (const p of PROFILES) {
  const row = snrs.map((s) => String(trialRate(p.id, s, trials).ok).padStart(5));
  console.log(`${p.key.padEnd(11)} ${row.join('')}`);
}

// the echo measured in a real room on 18 Sep 2026: the old fast mode got 3 of 9 there
console.log(`
strong echo (RT60 0.5 s, direct = reverb), SNR 20 dB, 24-byte payload: success out of ${trials}`);
for (const p of PROFILES) console.log(`${p.key.padEnd(11)} ${String(trialRate(p.id, 20, trials, { rt60: 0.5, drr: 0, len: 24 }).ok).padStart(5)}`);

// repeats: the receiver adds up soft values from each copy it hears
if (!quick) {
  console.log('\nrepeat combining (u-normal): packets decoded out of 10');
  for (const snr of [3, 1, 0]) {
    let one = 0, three = 0;
    for (let t = 0; t < 10; t++) {
      const p = payloadOf(48);
      if (listen(scene({ pid: 1, payloads: [p], snrDb: snr }), 48000).some((g) => same(g.bytes, p))) one++;
      if (listen(scene({ pid: 1, payloads: [p, p, p], snrDb: snr }), 48000).some((g) => same(g.bytes, p))) three++;
    }
    console.log(`SNR ${String(snr).padStart(3)} dB   one copy ${one}/10   three copies ${three}/10`);
  }

  // false alarms: a minute of noise and speech with no packets
  let fa = 0, events = 0;
  const fs = 48000, n = fs * 60;
  const rx = new Receiver(fs, { onPacket: () => fa++, onEvent: (e) => e.type === 'incoming' && events++ });
  let sp = 0;
  for (let i = 0; i < n; i += 4096) {
    const x = new Float32Array(4096);
    for (let j = 0; j < 4096; j++) { sp = 0.97 * sp + 0.03 * randn(); x[j] = 0.01 * randn() + 0.3 * sp; }
    rx.push(x);
  }
  console.log(`\nfalse alarms in 60 s of noise and speech: packets ${fa}, headers ${events}`);
}
console.log(`\n(${((Date.now() - t0) / 1000).toFixed(1)} s)`);
}
