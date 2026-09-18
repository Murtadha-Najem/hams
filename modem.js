// Hams modem: short data over sound, no network.
// Pure DSP with no DOM, so the browser app and the Node simulation (test/sim.mjs) run the same code.
//
// Packet on air:
//   chirp (100 ms sweep across the band, for detection and timing)
//   gap (20 ms)
//   header symbols (always the band's robust profile): profile, length, message id, CRC-8
//   payload symbols (chosen profile): payload + CRC-16
//
// Each symbol is multi-tone FSK: the band is split into groups of M adjacent bins and every group
// sends one tone, so a symbol carries G * log2(M) bits. Bits are protected by a K=7 convolutional
// code decoded with soft-decision Viterbi, and spread by an interleaver across time and frequency.
// A receiver that misses a packet keeps its soft values and adds the next repeat to them.

export const RAMP_T = 0.0015;
export const CHIRP_T = 0.1;
export const GAP_T = 0.02;
export const LEAD_T = 0.03;
export const TAIL_T = 0.06;

// df is also the symbol window: bins are 1/tw apart, so they are orthogonal over one window.
export const BANDS = {
  U: { key: 'U', f0: 18000, df: 50, nbins: 36, chirp: [17900, 19850], hp: 17000, lp: 21000 },
  A: { key: 'A', f0: 2000, df: 50, nbins: 40, chirp: [1900, 4050], hp: 1500, lp: 4600 },
};

// h: number of interleaved bin sets that consecutive symbols rotate through (h=2 keeps the
//    reverb tail of one symbol out of the next symbol's bins)
// tg: silence after each tone, for the room's echo to die down
// rate: 2 means code rate 1/2, 3 means 2/3 (punctured)
export const PROFILES = [
  { id: 0, band: 'U', key: 'u-robust', h: 2, M: 4, tg: 0.012, rate: 2 },
  { id: 1, band: 'U', key: 'u-normal', h: 1, M: 4, tg: 0.008, rate: 2 },
  { id: 2, band: 'U', key: 'u-fast', h: 1, M: 4, tg: 0.005, rate: 3 },
  { id: 3, band: 'A', key: 'a-robust', h: 2, M: 4, tg: 0.012, rate: 2 },
  { id: 4, band: 'A', key: 'a-normal', h: 1, M: 4, tg: 0.008, rate: 2 },
  { id: 5, band: 'A', key: 'a-fast', h: 1, M: 4, tg: 0.005, rate: 3 },
];
export const HEADER_PROFILE = { U: 0, A: 3 };
const HDR_BYTES = 4;
export const MAX_PAYLOAD = 255;

// ---------------------------------------------------------------- small utilities

function mulberry32(a) {
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function crc16(bytes) {
  let c = 0xffff;
  for (const b of bytes) {
    c ^= b << 8;
    for (let i = 0; i < 8; i++) c = c & 0x8000 ? ((c << 1) ^ 0x1021) & 0xffff : (c << 1) & 0xffff;
  }
  return c;
}

export function crc8(bytes) {
  let c = 0;
  for (const b of bytes) {
    c ^= b;
    for (let i = 0; i < 8; i++) c = c & 0x80 ? ((c << 1) ^ 0x07) & 0xff : (c << 1) & 0xff;
  }
  return c;
}

const gray = (t) => t ^ (t >> 1);
function invGray(v) {
  let t = v;
  for (let s = v >> 1; s; s >>= 1) t ^= s;
  return t;
}

function bytesToBits(bytes) {
  const bits = new Uint8Array(bytes.length * 8);
  for (let i = 0; i < bytes.length; i++) for (let j = 0; j < 8; j++) bits[i * 8 + j] = (bytes[i] >> (7 - j)) & 1;
  return bits;
}

function bitsToBytes(bits) {
  const out = new Uint8Array(bits.length >> 3);
  for (let i = 0; i < out.length; i++) {
    let v = 0;
    for (let j = 0; j < 8; j++) v = (v << 1) | bits[i * 8 + j];
    out[i] = v;
  }
  return out;
}

function median(arr) {
  const a = Float64Array.from(arr).sort();
  const m = a.length >> 1;
  return a.length % 2 ? a[m] : 0.5 * (a[m - 1] + a[m]);
}

// ln I0(x), from the Abramowitz and Stegun polynomial approximations
function lnI0(x) {
  if (x < 3.75) {
    const t = (x / 3.75) ** 2;
    return Math.log(1 + t * (3.5156229 + t * (3.0899424 + t * (1.2067492 + t * (0.2659732 + t * (0.0360768 + t * 0.0045813))))));
  }
  const t = 3.75 / x;
  const p = 0.39894228 + t * (0.01328592 + t * (0.00225319 + t * (-0.00157565 + t * (0.00916281 +
    t * (-0.02057706 + t * (0.02635537 + t * (-0.01647633 + t * 0.00392377)))))));
  return x - 0.5 * Math.log(x) + Math.log(p);
}

// ---------------------------------------------------------------- FFT (radix 2, in place)

const fftTables = new Map();
function fftTable(n) {
  let t = fftTables.get(n);
  if (t) return t;
  const rev = new Uint32Array(n);
  const bits = Math.log2(n);
  for (let i = 0; i < n; i++) {
    let r = 0;
    for (let j = 0; j < bits; j++) r |= ((i >> j) & 1) << (bits - 1 - j);
    rev[i] = r;
  }
  const cos = new Float64Array(n / 2), sin = new Float64Array(n / 2);
  for (let i = 0; i < n / 2; i++) { cos[i] = Math.cos((2 * Math.PI * i) / n); sin[i] = -Math.sin((2 * Math.PI * i) / n); }
  t = { rev, cos, sin };
  fftTables.set(n, t);
  return t;
}

export function fft(re, im, inverse = false) {
  const n = re.length;
  const { rev, cos, sin } = fftTable(n);
  for (let i = 0; i < n; i++) {
    const j = rev[i];
    if (j > i) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; }
  }
  const sgn = inverse ? -1 : 1;
  for (let size = 2; size <= n; size <<= 1) {
    const half = size >> 1, step = n / size;
    for (let i = 0; i < n; i += size) {
      for (let j = 0, k = 0; j < half; j++, k += step) {
        const wr = cos[k], wi = sgn * sin[k];
        const a = i + j, b = a + half;
        const xr = re[b] * wr - im[b] * wi, xi = re[b] * wi + im[b] * wr;
        re[b] = re[a] - xr; im[b] = im[a] - xi;
        re[a] += xr; im[a] += xi;
      }
    }
  }
  if (inverse) for (let i = 0; i < n; i++) { re[i] /= n; im[i] /= n; }
}

export const nextPow2 = (n) => 1 << Math.ceil(Math.log2(n));

// ---------------------------------------------------------------- geometry of a profile

const layoutCache = new Map();
export function layout(pid, fs) {
  const key = pid + '@' + fs;
  let L = layoutCache.get(key);
  if (L) return L;
  const p = PROFILES[pid], b = BANDS[p.band];
  const tw = 1 / b.df;
  const k = Math.log2(p.M);
  const sets = [];
  for (let j = 0; j < p.h; j++) {
    const bins = [];
    for (let i = j; i < b.nbins; i += p.h) bins.push(i);
    const groups = [];
    for (let g = 0; g + p.M <= bins.length; g += p.M) groups.push(bins.slice(g, g + p.M));
    sets.push(groups);
  }
  const G = sets[0].length;
  L = {
    p, b, k, G,
    N: Math.round(tw * fs),
    R: Math.round(RAMP_T * fs),
    Ns: Math.round((tw + p.tg) * fs),
    bps: G * k,
    sets,
    freqs: Array.from({ length: b.nbins }, (_, i) => b.f0 + i * b.df),
  };
  layoutCache.set(key, L);
  return L;
}

export function bitsPerSecond(pid) {
  const p = PROFILES[pid];
  const L = layout(pid, 48000);
  return (L.bps * (p.rate === 2 ? 0.5 : 2 / 3)) / (1 / BANDS[p.band].df + p.tg);
}

// ---------------------------------------------------------------- channel coding

const POLY0 = 0o171, POLY1 = 0o133;
const OUT = new Uint8Array(128);
for (let r = 0; r < 128; r++) {
  const par = (v) => { let p = 0; for (; v; v &= v - 1) p ^= 1; return p; };
  OUT[r] = par(r & POLY0) | (par(r & POLY1) << 1);
}

function convEncode(bits) {
  const steps = bits.length + 6;
  const out = new Uint8Array(2 * steps);
  let reg = 0;
  for (let i = 0; i < steps; i++) {
    reg = ((reg << 1) | (i < bits.length ? bits[i] : 0)) & 0x7f;
    out[2 * i] = OUT[reg] & 1;
    out[2 * i + 1] = OUT[reg] >> 1;
  }
  return out;
}

// rate 2/3: of every two steps (four coded bits) the last one is not sent
const kept = (i, rate) => rate === 2 || (i & 3) !== 3;

function puncture(coded, rate) {
  if (rate === 2) return coded;
  const out = [];
  for (let i = 0; i < coded.length; i++) if (kept(i, rate)) out.push(coded[i]);
  return Uint8Array.from(out);
}

function depuncture(llr, fullLen, rate) {
  if (rate === 2) return llr;
  const out = new Float32Array(fullLen);
  for (let i = 0, j = 0; i < fullLen; i++) if (kept(i, rate)) out[i] = llr[j++];
  return out;
}

export function codedLength(nbits, rate) {
  const full = 2 * (nbits + 6);
  if (rate === 2) return full;
  let n = 0;
  for (let i = 0; i < full; i++) if (kept(i, rate)) n++;
  return n;
}

// llr > 0 means the coded bit is more likely 0. The tail forces the trellis back to state 0.
function viterbi(llr, nbits) {
  const steps = nbits + 6;
  let pm = new Float64Array(64).fill(-1e30);
  pm[0] = 0;
  let npm = new Float64Array(64);
  const dec = new Uint8Array(steps * 64);
  for (let i = 0; i < steps; i++) {
    const l0 = llr[2 * i], l1 = llr[2 * i + 1];
    for (let ns = 0; ns < 64; ns++) {
      if (i >= nbits && ns & 1) { npm[ns] = -1e30; continue; }
      let best = -Infinity, bx = 0;
      for (let x = 0; x < 2; x++) {
        const o = OUT[(x << 6) | ns];
        const m = pm[(ns >> 1) | (x << 5)] + (o & 1 ? -l0 : l0) + (o & 2 ? -l1 : l1);
        if (m > best) { best = m; bx = x; }
      }
      npm[ns] = best;
      dec[i * 64 + ns] = bx;
    }
    const t = pm; pm = npm; npm = t;
  }
  const bits = new Uint8Array(nbits);
  let s = 0;
  for (let i = steps - 1; i >= 0; i--) {
    if (i < nbits) bits[i] = s & 1;
    s = (s >> 1) | (dec[i * 64 + s] << 5);
  }
  return bits;
}

const permCache = new Map();
function permutation(T) {
  let P = permCache.get(T);
  if (P) return P;
  P = new Uint32Array(T);
  for (let i = 0; i < T; i++) P[i] = i;
  const rnd = mulberry32(0x5eed ^ (T * 2654435761));
  for (let i = T - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    const t = P[i]; P[i] = P[j]; P[j] = t;
  }
  permCache.set(T, P);
  return P;
}

function toSlots(coded, bps) {
  const S = Math.ceil(coded.length / bps);
  const T = S * bps;
  const slots = new Uint8Array(T);
  const P = permutation(T);
  for (let i = 0; i < coded.length; i++) slots[P[i]] = coded[i];
  return { slots, S };
}

function fromSlots(llrSlots, len) {
  const P = permutation(llrSlots.length);
  const out = new Float32Array(len);
  for (let i = 0; i < len; i++) out[i] = llrSlots[P[i]];
  return out;
}

export function symbolCount(pid, payloadLen) {
  const L = layout(pid, 48000);
  return Math.ceil(codedLength((payloadLen + 2) * 8, L.p.rate) / L.bps);
}

// ---------------------------------------------------------------- transmitter

const chirpCache = new Map();
export function chirp(band, fs) {
  const key = band + '@' + fs;
  let c = chirpCache.get(key);
  if (c) return c;
  const [fa, fb] = BANDS[band].chirp;
  const Lc = Math.round(CHIRP_T * fs);
  const taper = Math.round(0.1 * Lc);
  c = new Float32Array(Lc);
  for (let n = 0; n < Lc; n++) {
    const t = n / fs;
    let w = 1;
    if (n < taper) w = 0.5 - 0.5 * Math.cos((Math.PI * n) / taper);
    else if (n >= Lc - taper) w = 0.5 - 0.5 * Math.cos((Math.PI * (Lc - 1 - n)) / taper);
    c[n] = w * Math.sin(2 * Math.PI * (fa * t + ((fb - fa) * t * t) / (2 * CHIRP_T)));
  }
  chirpCache.set(key, c);
  return c;
}

function synthSymbol(out, off, bins, L, fs, amp) {
  const G = bins.length;
  const len = L.N + 2 * L.R;
  const tmp = new Float32Array(len);
  for (let g = 0; g < G; g++) {
    const w = (2 * Math.PI * L.freqs[bins[g]]) / fs;
    const ph = (Math.PI * g * g) / G; // Newman phases keep the peak of the tone sum low
    for (let n = 0; n < len; n++) tmp[n] += Math.sin(w * (n - L.R) + ph);
  }
  let peak = 1e-9;
  for (let n = 0; n < len; n++) {
    let e = 1;
    if (n < L.R) e = 0.5 - 0.5 * Math.cos((Math.PI * n) / L.R);
    else if (n >= L.R + L.N) e = 0.5 + 0.5 * Math.cos((Math.PI * (n - L.R - L.N)) / L.R);
    tmp[n] *= e;
    peak = Math.max(peak, Math.abs(tmp[n]));
  }
  const s = amp / peak;
  for (let n = 0; n < len; n++) out[off + n] += tmp[n] * s;
}

function writeSymbols(out, off, slots, S, L, fs, amp) {
  for (let s = 0; s < S; s++) {
    const groups = L.sets[s % L.p.h];
    const bins = groups.map((grp, g) => {
      let v = 0;
      for (let j = 0; j < L.k; j++) v |= slots[s * L.bps + g * L.k + j] << j;
      return grp[invGray(v)];
    });
    synthSymbol(out, off + s * L.Ns, bins, L, fs, amp);
  }
  return off + S * L.Ns;
}

// copy: which repeat this is (1 to 15, capped), so the receiver can tell how many attempts a
// message took, including copies it never heard. 0 means not counted.
export function buildPacket(payload, pid, fs, { id = Math.floor(Math.random() * 256), amp = 0.9, copy = 0 } = {}) {
  if (!payload.length || payload.length > MAX_PAYLOAD) throw new Error('payload must be 1 to 255 bytes');
  const p = PROFILES[pid];
  const LH = layout(HEADER_PROFILE[p.band], fs), LP = layout(pid, fs);
  const hdr = [(pid << 4) | Math.min(15, copy), payload.length, id & 255];
  hdr.push(crc8(hdr));
  const H = toSlots(convEncode(bytesToBits(hdr)), LH.bps);
  const crc = crc16(payload);
  const body = Uint8Array.from([...payload, crc >> 8, crc & 255]);
  const P = toSlots(puncture(convEncode(bytesToBits(body)), p.rate), LP.bps);
  const c = chirp(p.band, fs);
  const lead = Math.round(LEAD_T * fs), gap = Math.round(GAP_T * fs), tail = Math.round(TAIL_T * fs);
  const total = lead + c.length + gap + H.S * LH.Ns + P.S * LP.Ns + tail;
  const out = new Float32Array(total);
  for (let n = 0; n < c.length; n++) out[lead + n] = c[n] * amp;
  let off = lead + c.length + gap;
  off = writeSymbols(out, off, H.slots, H.S, LH, fs, amp);
  writeSymbols(out, off, P.slots, P.S, LP, fs, amp);
  return out;
}

export function airtime(payloadLen, pid) {
  const p = PROFILES[pid], b = BANDS[p.band];
  const hp = PROFILES[HEADER_PROFILE[p.band]];
  const hS = Math.ceil(codedLength(HDR_BYTES * 8, 2) / layout(hp.id, 48000).bps);
  return LEAD_T + CHIRP_T + GAP_T + hS * (1 / b.df + hp.tg) + symbolCount(pid, payloadLen) * (1 / b.df + p.tg) + TAIL_T;
}

// ---------------------------------------------------------------- receiver

function biquad(type, f, fs, Q = Math.SQRT1_2) {
  const w = (2 * Math.PI * f) / fs, cw = Math.cos(w), al = Math.sin(w) / (2 * Q);
  const a0 = 1 + al;
  const b = type === 'lp' ? [(1 - cw) / 2, 1 - cw, (1 - cw) / 2] : [(1 + cw) / 2, -(1 + cw), (1 + cw) / 2];
  return { b0: b[0] / a0, b1: b[1] / a0, b2: b[2] / a0, a1: (-2 * cw) / a0, a2: (1 - al) / a0, x1: 0, x2: 0, y1: 0, y2: 0 };
}

function runBiquad(f, x) {
  let { x1, x2, y1, y2 } = f;
  for (let i = 0; i < x.length; i++) {
    const x0 = x[i];
    const y0 = f.b0 * x0 + f.b1 * x1 + f.b2 * x2 - f.a1 * y1 - f.a2 * y2;
    x2 = x1; x1 = x0; y2 = y1; y1 = y0;
    x[i] = y0;
  }
  Object.assign(f, { x1, x2, y1, y2 });
}

const DETECT_THRESHOLD = 0.2;
const RING = 1 << 20; // about 21 s at 48 kHz

class BandRx {
  constructor(band, parent) {
    const fs = parent.fs;
    this.parent = parent;
    this.fs = fs;
    this.band = band;
    this.b = BANDS[band];
    this.filters = [biquad('hp', this.b.hp, fs), biquad('hp', this.b.hp, fs)];
    if (this.b.lp < fs / 2 - 500) this.filters.push(biquad('lp', this.b.lp, fs), biquad('lp', this.b.lp, fs));
    this.ring = new Float32Array(RING);
    this.n = 0;
    const c = chirp(band, fs);
    this.Lc = c.length;
    this.Ec = c.reduce((s, v) => s + v * v, 0);
    this.B = 8192;
    this.F = nextPow2(this.B + this.Lc);
    this.Cre = new Float64Array(this.F);
    this.Cim = new Float64Array(this.F);
    this.Cre.set(c);
    fft(this.Cre, this.Cim);
    this.corrPos = 0;
    this.pending = null;
    this.jobs = [];
    this.gap = Math.round(GAP_T * fs);
    this.LH = layout(HEADER_PROFILE[band], fs);
    this.hCoded = codedLength(HDR_BYTES * 8, 2);
    this.hS = Math.ceil(this.hCoded / this.LH.bps);
    this.win = new Float32Array(Math.round(fs / this.b.df) + 8);
    this.coef = new Map();
  }

  push(x) {
    const y = Float32Array.from(x);
    for (const f of this.filters) runBiquad(f, y);
    for (let i = 0; i < y.length; i++) this.ring[(this.n + i) & (RING - 1)] = y[i];
    this.n += y.length;
    while (this.n >= this.corrPos + this.B + this.Lc) this.correlate();
    this.runJobs();
  }

  correlate() {
    const { F, B, Lc, ring } = this;
    const re = new Float64Array(F), im = new Float64Array(F);
    const segLen = B + Lc - 1;
    const pe = new Float64Array(segLen + 1);
    for (let i = 0; i < segLen; i++) {
      const v = ring[(this.corrPos + i) & (RING - 1)];
      re[i] = v;
      pe[i + 1] = pe[i] + v * v;
    }
    fft(re, im);
    for (let i = 0; i < F; i++) {
      const a = re[i], b = im[i], c = this.Cre[i], d = this.Cim[i];
      re[i] = a * c + b * d;
      im[i] = b * c - a * d;
    }
    fft(re, im, true);
    let maxRho = 0;
    for (let t = 0; t < B; t++) {
      const ex = pe[t + Lc] - pe[t];
      if (ex <= 1e-12) continue;
      const rho = Math.abs(re[t]) / Math.sqrt(this.Ec * ex);
      if (rho > maxRho) maxRho = rho;
      if (rho < DETECT_THRESHOLD) continue;
      const a = this.corrPos + t;
      if (this.pending && a - this.pending.a < Lc) {
        if (rho > this.pending.rho) this.pending = { a, rho };
      } else {
        if (this.pending) this.finalize(this.pending);
        this.pending = { a, rho };
      }
    }
    this.corrPos += B;
    if (this.pending && this.corrPos - this.pending.a > Lc) { this.finalize(this.pending); this.pending = null; }
    this.maxRho = maxRho;
  }

  finalize(pk) {
    const off = Math.round(0.003 * this.fs);
    const hdrBase = pk.a + this.Lc + this.gap;
    this.jobs.push({ stage: 'hdr', start: pk.a, rho: pk.rho, hdrBase, need: hdrBase + this.hS * this.LH.Ns + off + this.LH.Ns });
  }

  runJobs() {
    const keep = [];
    for (const job of this.jobs) {
      if (this.n - job.start > RING - this.fs) continue; // fell out of the buffer
      if (this.n < job.need) { keep.push(job); continue; }
      if (job.stage === 'hdr') {
        if (this.decodeHeader(job)) keep.push(job);
      } else {
        this.decodePayload(job);
      }
    }
    this.jobs = keep;
  }

  // energy of every bin of the band over one window starting at absolute sample `at`
  energies(at, L) {
    const { N } = L;
    const w = this.win;
    for (let i = 0; i < N; i++) w[i] = this.ring[(at + i) & (RING - 1)];
    const E = new Float64Array(L.freqs.length);
    for (let k = 0; k < L.freqs.length; k++) {
      let c = this.coef.get(L.freqs[k]);
      if (c === undefined) { c = 2 * Math.cos((2 * Math.PI * L.freqs[k]) / this.fs); this.coef.set(L.freqs[k], c); }
      let s1 = 0, s2 = 0;
      for (let i = 0; i < N; i++) { const s0 = w[i] + c * s1 - s2; s2 = s1; s1 = s0; }
      E[k] = s1 * s1 + s2 * s2 - c * s1 * s2;
    }
    return E;
  }

  // how clearly one tone stands out in each group: 1/M for noise, 1 for a clean symbol
  sharpness(at, L, s) {
    const E = this.energies(at, L);
    let m = 0;
    for (const grp of L.sets[s % L.p.h]) {
      let mx = 0, sum = 1e-30;
      for (const k of grp) { mx = Math.max(mx, E[k]); sum += E[k]; }
      m += mx / sum;
    }
    return m;
  }

  // soft bits for one symbol; returns the estimated SNR per tone
  symbolLLR(at, L, s, out, off) {
    const E = this.energies(at, L);
    const groups = L.sets[s % L.p.h];
    const noise = [], peaks = [];
    for (const grp of groups) {
      let mi = 0;
      for (let t = 1; t < grp.length; t++) if (E[grp[t]] > E[grp[mi]]) mi = t;
      for (let t = 0; t < grp.length; t++) if (t !== mi) noise.push(E[grp[t]]);
      peaks.push(E[grp[mi]]);
    }
    const s2 = Math.max(median(noise) / Math.LN2, 1e-20);
    const mu2 = Math.max(median(peaks) - s2, 0.25 * s2);
    const mu = Math.sqrt(mu2);
    const m = new Float64Array(L.p.M);
    groups.forEach((grp, g) => {
      for (let t = 0; t < grp.length; t++) m[t] = lnI0((2 * Math.sqrt(E[grp[t]]) * mu) / s2);
      for (let j = 0; j < L.k; j++) {
        let b0 = -Infinity, b1 = -Infinity;
        for (let t = 0; t < grp.length; t++) {
          if ((gray(t) >> j) & 1) b1 = Math.max(b1, m[t]);
          else b0 = Math.max(b0, m[t]);
        }
        out[off + g * L.k + j] = Math.max(-40, Math.min(40, b0 - b1));
      }
    });
    return mu2 / s2;
  }

  decodeHeader(job) {
    const L = this.LH, fs = this.fs;
    const span = Math.round(0.003 * fs), step = Math.max(1, Math.round(0.0005 * fs));
    const cands = [];
    for (let d = -span; d <= span; d += step) {
      let m = 0;
      for (let s = 0; s < this.hS; s++) m += this.sharpness(job.hdrBase + d + s * L.Ns + L.R, L, s);
      cands.push({ d, m });
    }
    cands.sort((a, b) => b.m - a.m);
    for (const { d } of cands.slice(0, 3)) {
      const slots = new Float32Array(this.hS * L.bps);
      for (let s = 0; s < this.hS; s++) this.symbolLLR(job.hdrBase + d + s * L.Ns + L.R, L, s, slots, s * L.bps);
      const bytes = bitsToBytes(viterbi(fromSlots(slots, this.hCoded), HDR_BYTES * 8));
      if (crc8(bytes.subarray(0, 3)) !== bytes[3]) continue;
      const pid = bytes[0] >> 4, copy = bytes[0] & 15, len = bytes[1], id = bytes[2];
      if (!PROFILES[pid] || PROFILES[pid].band !== this.band || len < 1) continue;
      const LP = layout(pid, fs);
      const S = Math.ceil(codedLength((len + 2) * 8, LP.p.rate) / LP.bps);
      Object.assign(job, {
        stage: 'pay', pid, len, id, copy, S, LP,
        payBase: job.hdrBase + d + this.hS * L.Ns,
        need: job.hdrBase + d + this.hS * L.Ns + S * LP.Ns + Math.round(0.004 * fs) + LP.Ns,
      });
      this.parent.onEvent({ type: 'incoming', band: this.band, pid, len, id, seconds: (job.need - this.n) / fs });
      return true;
    }
    return false;
  }

  decodePayload(job) {
    const { LP: L, S, pid, len, id, copy } = job;
    const fs = this.fs;
    const unit = Math.max(1, Math.round(fs / 16000));
    const slots = new Float32Array(S * L.bps);
    let cur = 0, snr = 0;
    const BLOCK = 12;
    for (let s0 = 0; s0 < S; s0 += BLOCK) {
      const s1 = Math.min(S, s0 + BLOCK);
      const reach = s0 === 0 ? 4 : 2;
      let best = { d: 0, m: -1 };
      for (let i = -reach; i <= reach; i++) {
        const d = i * unit;
        let m = 0;
        for (let s = s0; s < s1; s++) m += this.sharpness(job.payBase + cur + d + s * L.Ns + L.R, L, s);
        if (m > best.m) best = { d, m };
      }
      cur += best.d;
      for (let s = s0; s < s1; s++) snr += this.symbolLLR(job.payBase + cur + s * L.Ns + L.R, L, s, slots, s * L.bps);
    }
    const nbits = (len + 2) * 8;
    const llr = depuncture(fromSlots(slots, codedLength(nbits, L.p.rate)), 2 * (nbits + 6), L.p.rate);
    this.parent.deliver({ band: this.band, pid, len, id, copy, llr, nbits, snrDb: 10 * Math.log10(snr / S + 1e-12), rho: job.rho });
  }
}

export class Receiver {
  constructor(fs, { bands = ['U', 'A'], onPacket = () => {}, onEvent = () => {}, ignoreIds = null } = {}) {
    this.fs = fs;
    this.onPacket = onPacket;
    this.onEvent = onEvent;
    this.ignoreIds = ignoreIds;
    this.rx = bands.filter((b) => BANDS[b].chirp[1] < fs / 2 - 300).map((b) => new BandRx(b, this));
    this.partial = new Map(); // soft values of packets that failed their CRC, waiting for a repeat
    this.done = new Map(); // packets already delivered, so a repeat only bumps a counter
    this.recent = new Map(); // header key of a delivered packet, for repeats too weak to decode alone
  }

  get bands() { return this.rx.map((r) => r.band); }

  push(x) { for (const r of this.rx) r.push(x); }

  deliver(pk) {
    const key = `${pk.band}:${pk.pid}:${pk.len}:${pk.id}`;
    const now = this.rx[0].n / this.fs;
    for (const [k, v] of this.partial) if (now - v.t > 120) this.partial.delete(k);
    if (this.ignoreIds && this.ignoreIds.has(pk.id)) return;

    let bytes = this.check(pk.llr, pk.nbits);
    let combined = 1;
    let snrs = [pk.snrDb];
    const earlier = this.recent.get(key);
    if (!bytes && earlier && now - earlier.t < 300) {
      // a weak copy of something already delivered: count it, do not report a failure
      const seen = this.done.get(earlier.doneKey);
      seen.count++;
      seen.t = earlier.t = now;
      this.onEvent({ type: 'repeat', key: earlier.doneKey, count: seen.count, snrDb: pk.snrDb, copy: pk.copy });
      return;
    }
    if (!bytes) {
      const prev = this.partial.get(key);
      if (prev && prev.llr.length === pk.llr.length) {
        const sum = new Float32Array(pk.llr.length);
        for (let i = 0; i < sum.length; i++) sum[i] = prev.llr[i] + pk.llr[i];
        combined = prev.count + 1;
        snrs = [...prev.snrs, pk.snrDb];
        bytes = this.check(sum, pk.nbits);
        this.partial.set(key, { llr: sum, count: combined, snrs, t: now });
      } else {
        this.partial.set(key, { llr: Float32Array.from(pk.llr), count: 1, snrs, t: now });
      }
    }
    if (!bytes) {
      this.onEvent({ type: 'failed', band: pk.band, pid: pk.pid, id: pk.id, snrDb: pk.snrDb, heard: this.partial.get(key).count, copy: pk.copy });
      return;
    }
    this.partial.delete(key);
    const doneKey = key + ':' + crc16(bytes);
    const seen = this.done.get(doneKey);
    if (seen && now - seen.t < 300) {
      seen.count++;
      seen.t = now;
      this.onEvent({ type: 'repeat', key: doneKey, count: seen.count, snrDb: pk.snrDb, copy: pk.copy });
      return;
    }
    this.done.set(doneKey, { t: now, count: 1 });
    this.recent.set(key, { doneKey, t: now });
    // copy: the sender's repeat number that completed it (0 if the sender does not count);
    // combined: how many copies were added up; snrs: the signal of each of those copies
    this.onPacket({ bytes, band: pk.band, pid: pk.pid, id: pk.id, snrDb: pk.snrDb, combined, snrs, copy: pk.copy, key: doneKey });
  }

  check(llr, nbits) {
    const bytes = bitsToBytes(viterbi(llr, nbits));
    const n = bytes.length - 2;
    return crc16(bytes.subarray(0, n)) === ((bytes[n] << 8) | bytes[n + 1]) ? bytes.slice(0, n) : null;
  }

  // strongest chirp match in the last block, per band: a live "is anything there" indicator
  levels() { return Object.fromEntries(this.rx.map((r) => [r.band, r.maxRho || 0])); }
}
