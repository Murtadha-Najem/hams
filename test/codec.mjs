// Round trips for every payload encoding.
import assert from 'node:assert/strict';
import { encodeText, decodePayload, textEncodingName } from '../codec.js';

const texts = [
  'مرحبا',
  'السلام عليكم، شلونك؟ الاجتماع الساعة 10:30 بالطابق 2',
  'گلبي چنت پڤژ',
  'Wi-Fi: Home_Guest / Pass#2026!',
  'https://example.com/a?b=1',
  'رمز الدخول ABC-123 للقاعة',
  'أرقام هندية ١٢٣ وإيموجي 👍',
  'a',
  'x'.repeat(8),
  'سطر\nسطر ثاني',
];
for (const t of texts) {
  const enc = encodeText(t);
  const dec = decodePayload(enc);
  assert.equal(dec.text, t, `round trip failed for ${JSON.stringify(t)}`);
  const utf8 = new TextEncoder().encode(t).length;
  console.log(`${String(enc.length).padStart(3)} bytes (UTF-8 ${String(utf8).padStart(3)})  ${textEncodingName(enc).padEnd(12)} ${JSON.stringify(t)}`);
}

// every padding length for both packed encodings
for (let n = 1; n <= 20; n++) {
  for (const t of ['ب'.repeat(n), 'q'.repeat(n)]) assert.equal(decodePayload(encodeText(t)).text, t);
}

console.log('codec: all round trips pass');
