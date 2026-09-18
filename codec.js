// What goes inside a packet. Sound carries a few dozen bytes a second, so every byte is earned:
// Arabic text is packed at 6 bits a character instead of UTF-8's 16, and plain ASCII at 7.

const T_UTF8 = 1, T_AR6 = 2, T_ASCII7 = 3;

// 62 characters at 6 bits; code 62 escapes to one 7-bit ASCII character, 63 to one UTF-16 unit
const AR6 = ' ابتثجحخدذرزسشصضطظعغفقكلمنهويءآأإؤئةىگچپڤژ0123456789.،؟!:-/()\n';
const AR6_INDEX = new Map([...AR6].map((c, i) => [c, i]));
const ESC_ASCII = 62, ESC_UNI = 63;

class BitWriter {
  constructor() { this.bytes = []; this.acc = 0; this.n = 0; }
  put(v, w) {
    for (let i = w - 1; i >= 0; i--) {
      this.acc = (this.acc << 1) | ((v >> i) & 1);
      if (++this.n === 8) { this.bytes.push(this.acc); this.acc = 0; this.n = 0; }
    }
  }
  // pad with ones: a reader that runs out of whole symbols stops there
  finish() {
    if (this.n) this.bytes.push(((this.acc << (8 - this.n)) | ((1 << (8 - this.n)) - 1)) & 255);
    return this.bytes;
  }
}

class BitReader {
  constructor(bytes, start = 0) { this.b = bytes; this.pos = start * 8; }
  left() { return this.b.length * 8 - this.pos; }
  get(w) {
    let v = 0;
    for (let i = 0; i < w; i++, this.pos++) v = (v << 1) | ((this.b[this.pos >> 3] >> (7 - (this.pos & 7))) & 1);
    return v;
  }
}

function writeAr6(bw, str) {
  for (const ch of str) {
    const i = AR6_INDEX.get(ch);
    if (i !== undefined) bw.put(i, 6);
    else if (ch.charCodeAt(0) < 127 && ch.length === 1) { bw.put(ESC_ASCII, 6); bw.put(ch.charCodeAt(0), 7); }
    else for (let j = 0; j < ch.length; j++) { bw.put(ESC_UNI, 6); bw.put(ch.charCodeAt(j), 16); }
  }
}

function readAr6(br) {
  let s = '';
  while (br.left() >= 6) {
    const i = br.get(6);
    if (i === ESC_ASCII) { if (br.left() < 7) break; s += String.fromCharCode(br.get(7)); }
    else if (i === ESC_UNI) { if (br.left() < 16) break; s += String.fromCharCode(br.get(16)); }
    else s += AR6[i];
  }
  return s;
}

// the smallest of the three text encodings
export function encodeText(str) {
  const options = [];
  const utf8 = new TextEncoder().encode(str);
  options.push(Uint8Array.from([T_UTF8, ...utf8]));
  const ar = new BitWriter();
  writeAr6(ar, str);
  options.push(Uint8Array.from([T_AR6, ...ar.finish()]));
  if ([...str].every((c) => c.charCodeAt(0) < 127 && c.length === 1)) {
    const bw = new BitWriter();
    for (const c of str) bw.put(c.charCodeAt(0), 7);
    options.push(Uint8Array.from([T_ASCII7, ...bw.finish()]));
  }
  return options.reduce((a, b) => (b.length < a.length ? b : a));
}

export function textEncodingName(bytes) {
  return { [T_UTF8]: 'UTF-8', [T_AR6]: 'عربي مضغوط', [T_ASCII7]: 'لاتيني مضغوط' }[bytes[0]] || '';
}

export function decodePayload(bytes) {
  switch (bytes[0]) {
    case T_UTF8: return { kind: 'text', text: new TextDecoder().decode(bytes.subarray(1)) };
    case T_AR6: return { kind: 'text', text: readAr6(new BitReader(bytes, 1)) };
    case T_ASCII7: {
      const br = new BitReader(bytes, 1);
      let s = '';
      while (br.left() >= 7) { const c = br.get(7); if (c === 127) break; s += String.fromCharCode(c); }
      return { kind: 'text', text: s };
    }
    default: return { kind: 'raw', bytes };
  }
}
