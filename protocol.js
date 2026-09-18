// Messages on top of packets: long messages split into parts, receipts, and sealed (encrypted)
// messages. No DOM; the crypto is the standard Web Crypto API, present in browsers and in Node.
//
// Every packet payload is one frame:
//   single   [1][message id: 2]                          content          (whole message)
//   part     [2][message id: 2][part index][part count]  slice of content
//   receipt  [3][message id: 2][device id: 2]            name, packed text
//
// "content" is what codec.js produces, or a sealed blob:
//   sealed   [9][code hint][iv: 8][AES-GCM ciphertext with a 64-bit tag]

import { encodeText, decodePayload } from './codec.js?v=10';

const F_SINGLE = 1, F_PART = 2, F_RECEIPT = 3;
export const SEALED = 9;

export const PART_SIZE = 120;
export const MAX_CONTENT = 3000;
const SINGLE_MAX = 252; // packet payload limit 255, less the 3-byte frame head

const u16 = (v) => [(v >> 8) & 255, v & 255];
const readU16 = (b, i) => (b[i] << 8) | b[i + 1];

export const randomId16 = () => Math.floor(Math.random() * 65536);

// content -> the frames to broadcast, in order
export function frameMessage(content, msgId = randomId16()) {
  if (content.length > MAX_CONTENT) throw new Error(`message too long: ${content.length} bytes, limit ${MAX_CONTENT}`);
  if (content.length <= SINGLE_MAX) return { msgId, frames: [Uint8Array.from([F_SINGLE, ...u16(msgId), ...content])] };
  const total = Math.ceil(content.length / PART_SIZE);
  const frames = [];
  for (let i = 0; i < total; i++) {
    frames.push(Uint8Array.from([F_PART, ...u16(msgId), i, total, ...content.subarray(i * PART_SIZE, (i + 1) * PART_SIZE)]));
  }
  return { msgId, frames };
}

export function receiptFrame(msgId, deviceId, name = '') {
  const packed = name ? encodeText(name.slice(0, 16)) : new Uint8Array(0);
  return Uint8Array.from([F_RECEIPT, ...u16(msgId), ...u16(deviceId), ...packed]);
}

export function parseFrame(b) {
  if (b.length < 3) return null;
  const msgId = readU16(b, 1);
  if (b[0] === F_SINGLE) return { kind: 'part', msgId, index: 0, total: 1, data: b.slice(3) };
  if (b[0] === F_PART && b.length > 5 && b[4] > 0 && b[3] < b[4]) return { kind: 'part', msgId, index: b[3], total: b[4], data: b.slice(5) };
  if (b[0] === F_RECEIPT && b.length >= 5) {
    const name = b.length > 5 ? decodePayload(b.slice(5)).text || '' : '';
    return { kind: 'receipt', msgId, deviceId: readU16(b, 3), name };
  }
  return null;
}

// Collects parts per message id, in any order, across repeats.
export class Assembler {
  constructor() { this.msgs = new Map(); }

  add(f) {
    let m = this.msgs.get(f.msgId);
    if (!m || m.total !== f.total) {
      m = { total: f.total, parts: new Array(f.total), got: 0, content: null, t: Date.now() };
      this.msgs.set(f.msgId, m);
    }
    m.t = Date.now();
    if (!m.parts[f.index]) { m.parts[f.index] = f.data; m.got++; }
    const fresh = !m.content && m.got === m.total;
    if (fresh) {
      const len = m.parts.reduce((s, p) => s + p.length, 0);
      m.content = new Uint8Array(len);
      let o = 0;
      for (const p of m.parts) { m.content.set(p, o); o += p.length; }
    }
    for (const [k, v] of this.msgs) if (Date.now() - v.t > 15 * 60 * 1000) this.msgs.delete(k);
    return { got: m.got, total: m.total, complete: !!m.content, fresh, content: m.content };
  }

  get(msgId) { return this.msgs.get(msgId); }
}

// ---------------------------------------------------------------- chat

// A chat message is content of its own type, so it can travel open (the public room) or sealed
// with a group's code (a private room):
//   [10][device id: 2][flags][reply-to message id: 2, if flag 1][name length][name][text]
// name and text are codec.js encodings.
export const CHAT = 10;

export function chatContent({ deviceId, name = '', text, replyTo = null }) {
  const n = name ? encodeText(name.slice(0, 16)) : new Uint8Array(0);
  const head = [CHAT, ...u16(deviceId), replyTo === null ? 0 : 1];
  if (replyTo !== null) head.push(...u16(replyTo));
  return Uint8Array.from([...head, n.length, ...n, ...encodeText(text)]);
}

export function parseChat(c) {
  if (c[0] !== CHAT || c.length < 6) return null;
  const deviceId = readU16(c, 1);
  let i = 4;
  let replyTo = null;
  if (c[3] & 1) { replyTo = readU16(c, i); i += 2; }
  const nl = c[i++];
  const name = nl ? decodePayload(c.slice(i, i + nl)).text || '' : '';
  i += nl;
  if (i >= c.length) return null;
  return { deviceId, name, replyTo, text: decodePayload(c.slice(i)).text ?? '' };
}

// ---------------------------------------------------------------- sealed messages

const SALT = new TextEncoder().encode('hams/sealed/v1');
const keyCache = new Map();

// one code -> an AES key and a one-byte hint, so a receiver only tries the codes that can match
export async function deriveCode(secret) {
  if (keyCache.has(secret)) return keyCache.get(secret);
  const subtle = globalThis.crypto.subtle;
  const base = await subtle.importKey('raw', new TextEncoder().encode(secret), 'PBKDF2', false, ['deriveBits']);
  const bits = new Uint8Array(await subtle.deriveBits({ name: 'PBKDF2', salt: SALT, iterations: 150000, hash: 'SHA-256' }, base, 264));
  const key = await subtle.importKey('raw', bits.slice(0, 32), 'AES-GCM', false, ['encrypt', 'decrypt']);
  const derived = { key, hint: bits[32] };
  keyCache.set(secret, derived);
  return derived;
}

const ivFrom = (short) => { const iv = new Uint8Array(12); iv.set(short); return iv; };

export async function seal(content, secret) {
  const { key, hint } = await deriveCode(secret);
  const short = globalThis.crypto.getRandomValues(new Uint8Array(8));
  const ct = new Uint8Array(await globalThis.crypto.subtle.encrypt({ name: 'AES-GCM', iv: ivFrom(short), tagLength: 64 }, key, content));
  return Uint8Array.from([SEALED, hint, ...short, ...ct]);
}

// tries each code; null if none opens it
export async function unseal(blob, secrets) {
  if (blob[0] !== SEALED || blob.length < 18) return null;
  for (const secret of secrets) {
    const { key, hint } = await deriveCode(secret);
    if (hint !== blob[1]) continue;
    try {
      const pt = await globalThis.crypto.subtle.decrypt({ name: 'AES-GCM', iv: ivFrom(blob.slice(2, 10)), tagLength: 64 }, key, blob.slice(10));
      return { content: new Uint8Array(pt), secret };
    } catch { /* hint collision: not this code */ }
  }
  return null;
}
