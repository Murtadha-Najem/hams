// Long messages, receipts and sealed messages, without sound.
import assert from 'node:assert/strict';
import { frameMessage, parseFrame, Assembler, receiptFrame, seal, unseal, PART_SIZE } from '../protocol.js';
import { encodeText, decodePayload } from '../codec.js';

// a short message is one frame
const short = encodeText('السلام عليكم');
const one = frameMessage(short, 4242);
assert.equal(one.frames.length, 1);
const f1 = parseFrame(one.frames[0]);
assert.equal(f1.msgId, 4242);
assert.equal(new Assembler().add(f1).complete, true);

// a long message splits, and reassembles in any order, with repeats mixed in
const long = encodeText('سطر طويل من الكلام العربي، '.repeat(40) + 'END');
const m = frameMessage(long, 7);
assert.ok(m.frames.length > 2, 'expected several parts');
assert.ok(m.frames.every((f) => f.length <= 255));
const asm = new Assembler();
const order = [...m.frames.keys()].reverse();
let last;
for (const i of [...order, 0, 1]) last = asm.add(parseFrame(m.frames[i]));
assert.equal(last.complete, true);
assert.equal(decodePayload(last.content).text, decodePayload(long).text);
console.log(`long message: ${long.length} bytes in ${m.frames.length} parts of up to ${PART_SIZE}`);

// a message missing one part never completes
const asm2 = new Assembler();
for (const f of m.frames.slice(1)) assert.equal(asm2.add(parseFrame(f)).complete, false);

// receipts carry who received it
const r = parseFrame(receiptFrame(7, 513, 'مرتضى'));
assert.deepEqual(r, { kind: 'receipt', msgId: 7, deviceId: 513, name: 'مرتضى' });
assert.equal(parseFrame(receiptFrame(7, 1)).name, '');

// sealed: opens with the right code, stays shut with the wrong ones
const blob = await seal(short, 'باب-الشرقي-2026');
assert.equal(blob.length, short.length + 18);
const opened = await unseal(blob, ['wrong', 'باب-الشرقي-2026']);
assert.equal(decodePayload(opened.content).text, 'السلام عليكم');
assert.equal(opened.secret, 'باب-الشرقي-2026');
assert.equal(await unseal(blob, ['wrong', 'also wrong']), null);
const tampered = Uint8Array.from(blob);
tampered[12] ^= 1;
assert.equal(await unseal(tampered, ['باب-الشرقي-2026']), null);
console.log(`sealed: +18 bytes, opens with the right code only, rejects tampering`);
console.log('protocol: all checks pass');
