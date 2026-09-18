import { scene, payloadOf, same } from './sim.mjs';
import { Receiver } from '../modem.js';
const [pid, snr, copies, trials, fsRx = 48000] = process.argv.slice(2).map(Number);
for (let t = 0; t < trials; t++) {
  const p = payloadOf(48);
  const payloads = Array(copies).fill(p);
  const y = scene({ pid, payloads, snrDb: snr, fsRx });
  const ev = [];
  let ok = false;
  const rx = new Receiver(fsRx, { onPacket: (g) => { ok = same(g.bytes, p); ev.push('OK' + g.combined); }, onEvent: (e) => ev.push(e.type === 'failed' ? `fail(h${e.heard},${e.snrDb.toFixed(1)})` : e.type === 'incoming' ? 'hdr' : e.type) });
  for (let i = 0; i < y.length; i += 4096) rx.push(y.subarray(i, i + 4096));
  console.log(t, ok, ev.join(' '));
}
