// End to end through the simulated room: a long sealed message goes out in parts, the receiver
// reassembles and opens it, sees the answer-window flag, and its receipt makes it back.
import assert from 'node:assert/strict';
import { buildPacket, Receiver, profileId } from '../modem.js';
import { encodeText, decodePayload } from '../codec.js';
import { frameMessage, parseFrame, Assembler, receiptFrame, seal, unseal } from '../protocol.js';
import { room, resample } from './sim.mjs';

const fs = 48000;
let seed = 99;
const randn = () => {
  const r = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
  return Math.sqrt(-2 * Math.log(r() + 1e-12)) * Math.cos(2 * Math.PI * r());
};

// packets with gaps, through reverb, a clock offset, and noise
function air(packets, gap = 0.12, noise = 0.01) {
  const parts = [new Float32Array(Math.round(0.3 * fs))];
  for (const p of packets) { parts.push(p, new Float32Array(Math.round(gap * fs))); }
  parts.push(new Float32Array(fs));
  const x = new Float32Array(parts.reduce((s, p) => s + p.length, 0));
  let o = 0;
  for (const p of parts) { x.set(p, o); o += p.length; }
  const y = resample(room(x, fs, { rt60: 0.35, drr: 3, tiltDb: 8, band: 'U' }), 1 + 40e-6);
  for (let i = 0; i < y.length; i++) y[i] += noise * randn();
  return y;
}

function listen(y, onPacket) {
  const rx = new Receiver(fs, { onPacket });
  for (let i = 0; i < y.length; i += 4096) rx.push(y.subarray(i, i + 4096));
}

const pid = profileId('U', 1);
const text = 'اجتماع الفريق انتقل للقاعة الثانية بالطابق الثالث، الساعة 10:30. '.repeat(6) + 'الرمز 4471';
const content = await seal(encodeText(text), 'نخلة-17');
const { msgId, frames } = frameMessage(content);
console.log(`sealed message: ${content.length} bytes, ${frames.length} parts`);
const packets = frames.map((f, i) => buildPacket(f, pid, fs, { id: 10 + i, window: i === frames.length - 1 }));

// receiver side
const asm = new Assembler();
let complete = null, windowSeen = false;
listen(air(packets), (pk) => {
  const f = parseFrame(pk.bytes);
  if (f?.kind !== 'part') return;
  const st = asm.add(f);
  if (st.complete) complete = st.content;
  if (pk.w) windowSeen = true;
});
assert.ok(complete, 'message did not reassemble');
assert.ok(windowSeen, 'answer-window flag not seen');
assert.equal(await unseal(complete, ['wrong code']), null);
const opened = await unseal(complete, ['wrong code', 'نخلة-17']);
assert.equal(decodePayload(opened.content).text, text);
console.log('receiver: reassembled, window flag seen, opened with the right code only');

// the receipt, back to the sender
let receipt = null;
listen(air([buildPacket(receiptFrame(msgId, 31337, 'علي'), pid, fs, { id: 470 })]), (pk) => { receipt = parseFrame(pk.bytes); });
assert.deepEqual(receipt, { kind: 'receipt', msgId, deviceId: 31337, name: 'علي' });
console.log('sender: receipt decoded from device 31337 (علي)');
console.log('flow: all checks pass');
