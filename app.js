import { buildPacket, Receiver, PROFILES, profileId, airtime, bitsPerSecond } from './modem.js';
import { encodeText, decodePayload } from './codec.js';
import { frameMessage, parseFrame, receiptFrame, Assembler, seal, unseal, SEALED, MAX_CONTENT, randomId16 } from './protocol.js';

const $ = (id) => document.getElementById(id);
const store = {
  get(k, d) { try { const v = localStorage.getItem('hams.' + k); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('hams.' + k, JSON.stringify(v)); } catch { /* private mode: nothing persists */ } },
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const SPEED_NAMES = ['متين', 'عادي'];
const BAND_NAMES = { U: 'فوق سمعي', A: 'مسموع' };
const profileName = (pid) => `${BAND_NAMES[PROFILES[pid].band]}، ${SPEED_NAMES[PROFILES[pid].speed]}`;

// Receipt timing. After the last part of each round the sender falls silent for RECEIPT_SLOTS
// slots; each receiver that can read the message answers in one slot picked at random, so a
// few receivers rarely collide, and a collision is simply retried on the next round.
const RECEIPT_SLOTS = 3;
const RECEIPT_BYTES = 17;
const slotSeconds = (pid) => airtime(RECEIPT_BYTES, pid) + 0.15;
const MAX_ROUNDS = 30;

// Packet ids: this device's message packets use 0 to 447, receipts 448 to 511, so a receipt from
// someone else never shares an id with the packets being sent and is never mistaken for an echo.
const ownIds = new Set();
function newId(receipt = false) {
  let id;
  do id = receipt ? 448 + Math.floor(Math.random() * 64) : Math.floor(Math.random() * 448); while (ownIds.has(id));
  ownIds.add(id);
  return id;
}
const releaseIds = (ids) => setTimeout(() => ids.forEach((i) => ownIds.delete(i)), 30000);

// ---------------------------------------------------------------- saved state

const settings = { band: 'U', speed: 1, vol: 0.9, need: 1, receipts: true, ...store.get('settings', {}) };
if (!(settings.speed in SPEED_NAMES)) settings.speed = 1;
const saveSettings = () => store.set('settings', settings);
const currentPid = () => profileId(settings.band, settings.speed);

let deviceId = store.get('device', null);
if (deviceId === null) { deviceId = randomId16(); store.set('device', deviceId); }
let codes = store.get('codes', []); // [{ label, secret }]

// ---------------------------------------------------------------- tabs

document.querySelectorAll('nav button').forEach((b) => b.addEventListener('click', () => showTab(b.dataset.tab)));
function showTab(name) {
  document.querySelectorAll('nav button').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.tab === name)));
  document.querySelectorAll('section[role="tabpanel"]').forEach((s) => s.classList.toggle('on', s.id === name));
  if (name === 'inbox') { unread = 0; renderBadge(); }
  store.set('tab', name);
}

// ---------------------------------------------------------------- audio

let ctx = null;
async function audio() {
  if (!ctx) ctx = new (window.AudioContext || window.webkitAudioContext)({ latencyHint: 'interactive' });
  if (ctx.state === 'suspended') await ctx.resume();
  return ctx;
}

let playing = null;
function play(samples) {
  const buf = ctx.createBuffer(1, samples.length, ctx.sampleRate);
  buf.copyToChannel(samples, 0);
  const src = ctx.createBufferSource();
  src.buffer = buf;
  src.connect(ctx.destination);
  return new Promise((resolve) => {
    src.onended = () => { if (playing === src) playing = null; resolve(); };
    playing = src;
    src.start();
  });
}

// ---------------------------------------------------------------- listening

let listening = null;
let wakeLock = null;

async function startListening() {
  if (listening) return listening;
  await audio();
  if (!navigator.mediaDevices?.getUserMedia) throw new Error('المتصفح ما يسمح بالمايك هنا. افتح الصفحة عبر https.');
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 1 },
  });
  const src = ctx.createMediaStreamSource(stream);
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 8192;
  analyser.smoothingTimeConstant = 0.2;
  src.connect(analyser);
  const proc = ctx.createScriptProcessor(4096, 1, 1);
  const queue = [];
  proc.onaudioprocess = (e) => queue.push(Float32Array.from(e.inputBuffer.getChannelData(0)));
  const mute = ctx.createGain();
  mute.gain.value = 0;
  src.connect(proc);
  proc.connect(mute);
  mute.connect(ctx.destination);
  const rx = new Receiver(ctx.sampleRate, { onPacket, onEvent: onRxEvent, ignoreIds: ownIds });
  // decoding runs off the audio callback, so a slow decode never drops microphone samples
  const pump = setInterval(() => {
    let budget = 8;
    while (queue.length && budget--) rx.push(queue.shift());
  }, 30);
  listening = { stream, src, proc, analyser, rx, pump, track: stream.getAudioTracks()[0] };
  try { wakeLock = await navigator.wakeLock?.request('screen'); } catch { wakeLock = null; }
  renderListening();
  showDeviceInfo();
  drawSpectrum();
  return listening;
}

function stopListening() {
  if (!listening) return;
  clearInterval(listening.pump);
  listening.proc.disconnect();
  listening.src.disconnect();
  listening.stream.getTracks().forEach((t) => t.stop());
  listening = null;
  try { wakeLock?.release(); } catch { /* ignore */ }
  wakeLock = null;
  renderListening();
}

function renderListening() {
  $('live').classList.toggle('on', !!listening);
  $('live').textContent = listening ? 'يستمع' : 'ما يستمع';
  $('listenBtn').textContent = listening ? 'أوقف الاستماع' : 'ابدأ الاستماع';
  $('listenBtn').classList.toggle('stop', !!listening);
  if (!listening) setRecvStatus('الاستماع متوقف.');
  else if (!listening.rx.bands.includes('U')) setRecvStatus('معدل العينات بهذا الجهاز واطي، فيلتقط المسموع بس.', 'warn');
  else setRecvStatus('يستمع. أي رسالة توصل تظهر هنا.');
}

const micError = (e) => (e.name === 'NotAllowedError' ? 'رفض المتصفح الوصول للمايك.' : e.message);

$('listenBtn').addEventListener('click', async () => {
  if (listening) { stopListening(); return; }
  try { await startListening(); } catch (e) { setRecvStatus(micError(e), 'bad'); }
});

function setRecvStatus(text, cls = '') {
  $('recvStatus').className = 'status ' + cls;
  $('recvStatus').textContent = text;
}

const barTimers = new Map();
function progressBar(el, seconds) {
  clearInterval(barTimers.get(el));
  const t0 = performance.now();
  el.style.width = '0';
  const t = setInterval(() => {
    const f = Math.min(1, (performance.now() - t0) / 1000 / Math.max(seconds, 0.1));
    el.style.width = (f * 100).toFixed(1) + '%';
    if (f >= 1) clearInterval(t);
  }, 100);
  barTimers.set(el, t);
}

function onRxEvent(e) {
  if (e.type === 'incoming') {
    if (ownIds.has(e.id)) return;
    // something is arriving: a sender waiting for receipts keeps listening until it is decoded
    if (sending) sending.busyUntil = Math.max(sending.busyUntil, Date.now() + e.seconds * 1000 + 400);
    progressBar($('recvBar'), e.seconds);
  } else if (e.type === 'failed' && !ownIds.has(e.id)) {
    $('recvBar').style.width = '0';
    setRecvStatus('وصلت إشارة بس ما انفكت بعد. تنجمع ويا التكرار الجاي.', 'warn');
  }
}

// ---------------------------------------------------------------- receiving messages

const assembler = new Assembler();
const ownMsgIds = new Set();
const seen = new Map(); // msgId -> { state: 'opening' | 'readable' | 'foreign', lastReceipt, card }
const messages = [];
let unread = 0;

function onPacket(pk) {
  const f = parseFrame(pk.bytes);
  if (!f) return;
  if (f.kind === 'receipt') { onReceipt(f); return; }
  if (ownMsgIds.has(f.msgId)) return;
  const st = assembler.add(f);
  if (!st.complete) {
    setRecvStatus(`يستلم رسالة طويلة: ${st.got} من ${st.total} أجزاء.`);
    $('recvBar').style.width = `${(100 * st.got) / st.total}%`;
    return;
  }
  if (st.fresh) openMessage(f.msgId, st.content, pk);
  if (pk.w) answerWindow(f.msgId, pk.pid);
}

async function openMessage(msgId, content, pk) {
  const s = { state: 'opening', lastReceipt: 0 };
  seen.set(msgId, s);
  let code = null;
  if (content[0] === SEALED) {
    const r = await unseal(content, codes.map((c) => c.secret));
    if (!r) { s.state = 'foreign'; return; } // not for us: ignore without a trace
    content = r.content;
    code = codes.find((c) => c.secret === r.secret)?.label || 'رمز';
  }
  s.state = 'readable';
  const d = decodePayload(content);
  const text = d.kind === 'text' ? d.text : Array.from(content, (b) => b.toString(16).padStart(2, '0')).join(' ');
  const m = { msgId, text, when: new Date(), pid: pk.pid, code, receipted: false };
  messages.unshift(m);
  s.message = m;
  setRecvStatus('وصلت رسالة.', 'ok');
  $('recvBar').style.width = '0';
  if (navigator.vibrate) try { navigator.vibrate(80); } catch { /* ignore */ }
  if (!$('inbox').classList.contains('on')) { unread++; renderBadge(); }
  renderMessages();
  if (pk.w) answerWindow(msgId, pk.pid);
}

// The packet just decoded was the last of a round: its sender is now listening for receipts.
async function answerWindow(msgId, pid) {
  const s = seen.get(msgId);
  if (!settings.receipts || !s || s.state !== 'readable' || sending) return;
  if (Date.now() - s.lastReceipt < 2500) return;
  s.lastReceipt = Date.now();
  const slot = Math.floor(Math.random() * RECEIPT_SLOTS);
  await sleep(50 + slot * slotSeconds(pid) * 1000);
  if (sending) return;
  const id = newId(true);
  await play(buildPacket(receiptFrame(msgId, deviceId, $('myName').value.trim()), pid, ctx.sampleRate, { id, amp: settings.vol }));
  releaseIds([id]);
  if (s.message && !s.message.receipted) { s.message.receipted = true; renderMessages(); }
}

function renderBadge() {
  $('badge').textContent = unread;
  $('badge').classList.toggle('on', unread > 0);
}

function renderMessages() {
  const box = $('messages');
  box.textContent = '';
  if (!messages.length) { box.innerHTML = '<div class="empty">ماكو رسائل بعد.</div>'; return; }
  for (const m of messages) {
    const d = document.createElement('div');
    d.className = 'msg';
    const body = document.createElement('div');
    body.className = 'body';
    body.textContent = m.text;
    const foot = document.createElement('div');
    foot.className = 'foot';
    if (m.code) { const c = document.createElement('span'); c.className = 'chip lock'; c.textContent = `محمية: ${m.code}`; foot.append(c); }
    const info = document.createElement('span');
    info.textContent = `${m.when.toLocaleTimeString('ar-IQ', { hour: '2-digit', minute: '2-digit' })}، ${profileName(m.pid)}${m.receipted ? '، انبعث تأكيد الاستلام' : ''}`;
    const sp = document.createElement('span');
    sp.className = 'sp';
    const copy = document.createElement('button');
    copy.textContent = 'نسخ';
    copy.addEventListener('click', async () => {
      try { await navigator.clipboard.writeText(m.text); copy.textContent = 'انّسخت'; } catch { copy.textContent = 'ما انّسخت'; }
    });
    foot.append(info, sp, copy);
    d.append(body, foot);
    box.append(d);
  }
}

// ---------------------------------------------------------------- sending

let sending = null;

function bindSeg(el, get, set) {
  const sync = () => el.querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.v === String(get()))));
  el.addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    set(b.dataset.v);
    sync();
    renderSendForm();
  });
  sync();
}

let privacy = 'public';
bindSeg($('privSeg'), () => privacy, (v) => { privacy = v; });
bindSeg($('bandSeg'), () => settings.band, (v) => { settings.band = v; saveSettings(); });
bindSeg($('speedSeg'), () => settings.speed, (v) => { settings.speed = +v; saveSettings(); });
$('vol').value = settings.vol;
$('vol').addEventListener('input', () => { settings.vol = +$('vol').value; saveSettings(); });
$('needPlus').addEventListener('click', () => { settings.need = Math.min(9, settings.need + 1); saveSettings(); renderSendForm(); });
$('needMinus').addEventListener('click', () => { settings.need = Math.max(0, settings.need - 1); saveSettings(); renderSendForm(); });
$('msg').value = store.get('draft', '');
$('msg').addEventListener('input', () => { store.set('draft', $('msg').value); renderSendForm(); });
$('codePick').addEventListener('change', renderSendForm);

const NOTES = {
  U: 'ما ينسمع عند أغلب البالغين. يحتاج الجهازين بنفس الغرفة، والسماعة مواجهة للمايك.',
  A: 'ينسمع كصفير متقطع. أوثق على الأجهزة الضعيفة، بس الحچي والضوضاء تأثر عليه.',
};

function roundSeconds(bytes, pid) {
  const parts = Math.max(1, Math.ceil(bytes / (bytes <= 252 ? 252 : 120)));
  const per = bytes <= 252 ? bytes + 3 : 125;
  return { parts, seconds: parts * airtime(per, pid) + (parts - 1) * 0.12 };
}

function renderSendForm() {
  const pid = currentPid();
  $('needOut').textContent = settings.need;
  $('needText').textContent = settings.need === 0
    ? 'بدون تأكيد: يكرر البث لحد ما توقفه.'
    : `يوقف لما ${settings.need === 1 ? 'جهاز واحد يأكد' : `${settings.need} أجهزة تأكد`} الاستلام.`;
  $('modeNote').textContent = `${NOTES[settings.band]} السرعة حوالي ${Math.round(bitsPerSecond(pid) / 8)} بايت بالثانية.`;
  $('howSummary').textContent = profileName(pid);

  const sealed = privacy === 'sealed';
  $('sealBox').hidden = !sealed;
  const pick = $('codePick');
  const chosen = pick.value;
  pick.textContent = '';
  for (const c of codes) { const o = document.createElement('option'); o.value = c.label; o.textContent = c.label; pick.append(o); }
  if (codes.some((c) => c.label === chosen)) pick.value = chosen;
  $('sealNote').textContent = codes.length
    ? 'تنشفر الرسالة، وبس الأجهزة اللي عندها نفس الرمز تگدر تقراها. البقية يتجاهلونها.'
    : 'ماكو رموز محفوظة. أضف رمز من الإعدادات، ونفس الرمز لازم يكون عند المستلم.';

  const text = $('msg').value;
  const meta = $('msgMeta');
  meta.classList.remove('bad');
  $('sendBtn').disabled = false;
  if (sending) return;
  if (!text) { meta.textContent = ''; return; }
  const bytes = encodeText(text).length + (sealed ? 18 : 0);
  if (bytes > MAX_CONTENT) {
    meta.classList.add('bad');
    meta.textContent = `طويلة: ${bytes} بايت بعد الضغط، والحد ${MAX_CONTENT}.`;
    $('sendBtn').disabled = true;
    return;
  }
  const r = roundSeconds(bytes, pid);
  meta.textContent = `${bytes} بايت${r.parts > 1 ? `، ${r.parts} أجزاء` : ''}، البث مرة وحدة ياخذ ${r.seconds.toFixed(1)} ثانية`;
  if (sealed && !codes.length) $('sendBtn').disabled = true;
}

function setSendStatus(text, cls = '') {
  $('sendStatus').className = 'status ' + cls;
  $('sendStatus').textContent = text;
}

function renderReceipts(receipts = sending?.receipts) {
  const box = $('receipts');
  box.textContent = '';
  if (!receipts) return;
  for (const [dev, name] of receipts) {
    const c = document.createElement('span');
    c.className = 'chip';
    c.textContent = `وصلت: ${name || 'جهاز ' + dev}`;
    box.append(c);
  }
}

function onReceipt(f) {
  if (!sending || f.msgId !== sending.msgId || f.deviceId === deviceId) return;
  if (!sending.receipts.has(f.deviceId)) {
    sending.receipts.set(f.deviceId, f.name);
    renderReceipts();
  }
}

$('sendBtn').addEventListener('click', async () => {
  if (sending) { sending.stop = true; if (playing) try { playing.stop(); } catch { /* ended */ } return; }
  const text = $('msg').value;
  if (!text) { $('sendPanel').classList.add('on'); setSendStatus('اكتب رسالة أولاً.', 'warn'); return; }
  try { await send(text); } catch (e) { setSendStatus(e.message, 'bad'); sending = null; renderSendButton(); }
});

function renderSendButton() {
  $('sendBtn').textContent = sending ? 'إيقاف البث' : 'إرسال';
  $('sendBtn').classList.toggle('stop', !!sending);
  renderSendForm();
}

async function send(text) {
  await audio();
  const pid = currentPid();
  let content = encodeText(text);
  if (privacy === 'sealed') {
    const c = codes.find((x) => x.label === $('codePick').value);
    if (!c) throw new Error('اختار رمز للرسالة المحمية.');
    content = await seal(content, c.secret);
  }
  const need = settings.need;
  $('sendPanel').classList.add('on');
  if (need > 0) {
    try { await startListening(); } catch (e) { throw new Error(`تأكيد الاستلام يحتاج المايك: ${micError(e)}`); }
  }
  const { msgId, frames } = frameMessage(content);
  ownMsgIds.add(msgId);
  const ids = frames.map(() => newId());
  const packets = frames.map((f, i) => buildPacket(f, pid, ctx.sampleRate, { id: ids[i], amp: settings.vol, window: need > 0 && i === frames.length - 1 }));
  sending = { msgId, need, receipts: new Map(), stop: false, busyUntil: 0 };
  renderSendButton();
  renderReceipts();
  const windowMs = (RECEIPT_SLOTS * slotSeconds(pid) + 1.0) * 1000;
  let round = 0;
  try {
    while (!sending.stop && round < (need > 0 ? MAX_ROUNDS : Infinity)) {
      round++;
      for (let i = 0; i < packets.length && !sending.stop; i++) {
        setSendStatus(`يبث${packets.length > 1 ? ` الجزء ${i + 1} من ${packets.length}` : ''}، الجولة ${round}`);
        progressBar($('sendBar'), packets[i].length / ctx.sampleRate);
        await play(packets[i]);
        if (i < packets.length - 1) await sleep(120);
      }
      if (sending.stop) break;
      if (need > 0) {
        setSendStatus(`ينتظر تأكيد الاستلام (${sending.receipts.size} من ${need})`);
        $('sendBar').style.width = '0';
        const until = Date.now() + windowMs;
        while (!sending.stop && sending.receipts.size < need && Date.now() < Math.max(until, sending.busyUntil)) await sleep(100);
        if (sending.receipts.size >= need) break;
      } else {
        await sleep(400);
      }
    }
    const got = sending.receipts.size;
    if (need > 0 && got >= need) setSendStatus(`وصلت. أكد الاستلام ${got === 1 ? 'جهاز واحد' : `${got} أجهزة`}، والبث توقف.`, 'ok');
    else if (need > 0 && !sending.stop) setSendStatus(`توقف البث بعد ${round} جولة، وأكد الاستلام ${got} من ${need}.`, 'warn');
    else setSendStatus(`توقف البث بعد ${round} ${round === 1 ? 'جولة' : 'جولات'}${need > 0 ? `، وأكد الاستلام ${got} من ${need}` : ''}.`);
  } finally {
    $('sendBar').style.width = '0';
    releaseIds(ids);
    setTimeout(() => ownMsgIds.delete(msgId), 10 * 60 * 1000);
    const { receipts } = sending;
    sending = null;
    renderSendButton();
    renderReceipts(receipts); // keep the names on screen after the broadcast ends
  }
}

// ---------------------------------------------------------------- settings

$('devNum').textContent = deviceId;
$('myName').value = store.get('name', '');
$('myName').addEventListener('input', () => store.set('name', $('myName').value));
$('autoReceipt').checked = settings.receipts;
$('autoReceipt').addEventListener('change', () => { settings.receipts = $('autoReceipt').checked; saveSettings(); });

function renderCodes() {
  const box = $('codeList');
  box.textContent = '';
  codes.forEach((c, i) => {
    const d = document.createElement('div');
    d.className = 'code';
    const b = document.createElement('b'); b.textContent = c.label;
    const s = document.createElement('span'); s.textContent = '•'.repeat(Math.min(8, c.secret.length));
    const sp = document.createElement('span'); sp.className = 'sp';
    const del = document.createElement('button'); del.textContent = 'حذف';
    del.addEventListener('click', () => {
      if (!confirm(`تحذف الرمز "${c.label}"؟ الرسائل المحمية بي ما راح تنفك بعدها على هذا الجهاز.`)) return;
      codes.splice(i, 1);
      store.set('codes', codes);
      renderCodes();
      renderSendForm();
    });
    d.append(b, s, sp, del);
    box.append(d);
  });
}

$('codeAdd').addEventListener('click', () => {
  const label = $('codeLabel').value.trim(), secret = $('codeSecret').value;
  const meta = $('codeMeta');
  meta.classList.remove('bad');
  if (!label || !secret) { meta.classList.add('bad'); meta.textContent = 'اكتب اسم للرمز والرمز نفسه.'; return; }
  if (codes.some((c) => c.label === label)) { meta.classList.add('bad'); meta.textContent = 'اكو رمز بنفس الاسم.'; return; }
  codes.push({ label, secret });
  store.set('codes', codes);
  $('codeLabel').value = '';
  $('codeSecret').value = '';
  meta.textContent = secret.length < 8 ? 'انضاف. نصيحة: الرمز الأطول من 8 حروف أصعب على التخمين.' : 'انضاف.';
  renderCodes();
  renderSendForm();
});

// ---------------------------------------------------------------- spectrum, sweep test, device info

function drawSpectrum() {
  const c = $('spec'), g = c.getContext('2d');
  const sc = $('sweepSpec'), sg = sc.getContext('2d');
  const tick = () => {
    if (!listening) return;
    const css = getComputedStyle(document.documentElement);
    const a = listening.analyser;
    const data = new Float32Array(a.frequencyBinCount);
    a.getFloatFrequencyData(data);
    const nyq = ctx.sampleRate / 2;
    paint(g, c, data, 0, 22050, nyq, css);
    paint(sg, sc, data, 14000, 22000, nyq, css, measure);
    if (measure) measureTick(data, nyq);
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

function paint(g, c, data, fLo, fHi, nyq, css, m = null) {
  const W = c.width, H = c.height;
  g.clearRect(0, 0, W, H);
  const X = (f) => ((f - fLo) / (fHi - fLo)) * W;
  g.fillStyle = css.getPropertyValue('--accent-soft');
  for (const [a, b] of [[18000, 19800], [2000, 4000]]) if (b > fLo && a < fHi) g.fillRect(X(Math.max(a, fLo)), 0, X(Math.min(b, fHi)) - X(Math.max(a, fLo)), H);
  const binHz = nyq / data.length;
  const y = (db) => H - Math.max(0, Math.min(1, (db + 120) / 100)) * H;
  if (m) {
    g.strokeStyle = css.getPropertyValue('--warn');
    g.beginPath();
    m.peak.forEach((db, i) => { const f = m.f0 + i * m.step; if (f <= fHi) g.lineTo(X(f), y(db)); });
    g.stroke();
  }
  g.strokeStyle = css.getPropertyValue('--accent');
  g.lineWidth = 1.5;
  g.beginPath();
  const i0 = Math.floor(fLo / binHz), i1 = Math.min(data.length - 1, Math.ceil(fHi / binHz));
  const stride = Math.max(1, Math.floor((i1 - i0) / W));
  for (let i = i0; i <= i1; i += stride) {
    let mx = -Infinity;
    for (let j = i; j < i + stride && j <= i1; j++) mx = Math.max(mx, data[j]);
    g.lineTo(X(i * binHz), y(mx));
  }
  g.stroke();
}

function showDeviceInfo() {
  const s = listening.track.getSettings ? listening.track.getSettings() : {};
  const yes = (v) => (v === undefined ? 'غير معروف' : v ? 'شغّال' : 'مطفي');
  const rows = [
    ['معدل العينات', `${ctx.sampleRate} هرتز${ctx.sampleRate < 40000 ? ' (واطي، فوق السمعي ما يشتغل)' : ''}`],
    ['إلغاء الصدى', yes(s.echoCancellation)],
    ['تنقية الضوضاء', yes(s.noiseSuppression)],
    ['التحكم التلقائي بالصوت', yes(s.autoGainControl)],
    ['المايك', listening.track.label || 'غير معروف'],
  ];
  const dl = $('devInfo');
  dl.textContent = '';
  for (const [k, v] of rows) {
    const dt = document.createElement('dt'); dt.textContent = k;
    const dd = document.createElement('dd'); dd.textContent = v;
    dl.append(dt, dd);
  }
}

let measure = null;
const SWEEP = { f0: 15000, f1: 21500, step: 250, tone: 0.12 };

$('sweepBtn').addEventListener('click', async () => {
  await audio();
  const fs = ctx.sampleRate;
  const n = Math.round(SWEEP.tone * fs), r = Math.round(0.01 * fs);
  const freqs = [];
  for (let f = SWEEP.f0; f <= Math.min(SWEEP.f1, fs / 2 - 200); f += SWEEP.step) freqs.push(f);
  const out = new Float32Array(freqs.length * n);
  freqs.forEach((f, k) => {
    for (let i = 0; i < n; i++) out[k * n + i] = settings.vol * Math.min(1, i / r, (n - 1 - i) / r) * Math.sin((2 * Math.PI * f * i) / fs);
  });
  $('measureStatus').className = 'status';
  $('measureStatus').textContent = 'يشغّل المسح...';
  await play(out);
  $('measureStatus').textContent = 'انتهى المسح. النتيجة تطلع على الجهاز المستلم.';
});

$('measureBtn').addEventListener('click', async () => {
  try { await startListening(); } catch (e) { $('measureStatus').className = 'status bad'; $('measureStatus').textContent = micError(e); return; }
  const bins = Math.floor((SWEEP.f1 - SWEEP.f0) / SWEEP.step) + 1;
  measure = { f0: SWEEP.f0, step: SWEEP.step, peak: new Array(bins).fill(-140), floor: new Array(bins).fill(0), nFloor: 0, t0: performance.now() };
  $('measureStatus').className = 'status';
  $('measureStatus').textContent = 'يقيس الضوضاء ثانيتين، بعدها شغّل المسح على الجهاز الثاني...';
  setTimeout(() => { if (measure) $('measureStatus').textContent = 'جاهز. شغّل المسح على الجهاز الثاني الآن (عندك 12 ثانية).'; }, 2000);
  setTimeout(finishMeasure, 14000);
});

function measureTick(data, nyq) {
  const binHz = nyq / data.length;
  const quiet = performance.now() - measure.t0 < 2000;
  measure.peak.forEach((_, i) => {
    const f = measure.f0 + i * measure.step;
    let mx = -140;
    for (let j = Math.floor((f - 60) / binHz); j <= Math.ceil((f + 60) / binHz); j++) if (data[j] !== undefined) mx = Math.max(mx, data[j]);
    if (quiet) measure.floor[i] += mx;
    else measure.peak[i] = Math.max(measure.peak[i], mx);
  });
  if (quiet) measure.nFloor++;
}

function finishMeasure() {
  if (!measure) return;
  const m = measure;
  measure = null;
  const floor = m.floor.map((v) => v / Math.max(1, m.nFloor));
  let top = null, inBand = 0, clear = 0;
  m.peak.forEach((p, i) => {
    const f = m.f0 + i * m.step;
    const margin = p - floor[i];
    if (margin >= 15) top = f;
    if (f >= 18000 && f <= 19800) { inBand++; if (margin >= 15) clear++; }
  });
  const el = $('measureStatus');
  if (top === null) {
    el.className = 'status bad';
    el.textContent = 'ما وصل المسح بوضوح. قرّب الجهازين، ارفع الصوت، وتأكد إن الجهاز الثاني شغّل المسح خلال الوقت.';
    return;
  }
  const share = clear / inBand;
  const advice = share >= 0.9 ? 'فوق السمعي يشتغل بين هذين الجهازين، و"عادي" مناسب.'
    : share >= 0.5 ? 'فوق السمعي يشتغل جزئياً. استخدم "متين".'
    : 'فوق السمعي ما يشتغل بين هذين الجهازين. استخدم المسموع.';
  el.className = 'status ' + (share >= 0.9 ? 'ok' : share >= 0.5 ? 'warn' : 'bad');
  el.textContent = `أعلى تردد وصل بوضوح: ${(top / 1000).toFixed(2)} ألف هرتز. ${advice}`;
}

// ---------------------------------------------------------------- software self-test

$('selfTest').addEventListener('click', async () => {
  const out = $('selfStatus');
  out.className = 'status mono';
  out.textContent = 'يشتغل...';
  await sleep(30);
  const fs = ctx ? ctx.sampleRate : 48000;
  const pid = currentPid();
  const text = $('msg').value || 'السلام عليكم، هذا فحص لنظام همس 123';
  let seed = 7;
  const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
  const randn = () => Math.sqrt(-2 * Math.log(rnd() + 1e-12)) * Math.cos(2 * Math.PI * rnd());
  const { frames } = frameMessage(encodeText(text));
  const lines = [];
  for (const noise of [0.002, 0.02, 0.06]) {
    const pks = frames.map((f, i) => buildPacket(f, pid, fs, { id: i }));
    const total = pks.reduce((s, p) => s + p.length, 0) + fs;
    const y = new Float32Array(total + fs);
    let o = Math.round(0.3 * fs);
    for (const pk of pks) {
      for (let i = 0; i < pk.length; i++) {
        y[o + i] += pk[i];
        y[o + i + Math.round(0.007 * fs)] += 0.5 * pk[i]; // echoes at 7 ms and 23 ms
        y[o + i + Math.round(0.023 * fs)] += 0.3 * pk[i];
      }
      o += pk.length + Math.round(0.12 * fs);
    }
    for (let i = 0; i < y.length; i++) y[i] += noise * randn();
    const asm = new Assembler();
    let done = null;
    const rx = new Receiver(fs, { onPacket: (p) => { const f = parseFrame(p.bytes); if (f && f.kind === 'part') { const s = asm.add(f); if (s.complete) done = s.content; } } });
    const t0 = performance.now();
    for (let i = 0; i < y.length; i += 4096) rx.push(y.subarray(i, i + 4096));
    const ok = done && decodePayload(done).text === text;
    lines.push(`ضوضاء ${noise}: ${ok ? 'نجح' : 'فشل'} (${(performance.now() - t0).toFixed(0)} ms)`);
  }
  out.textContent = `${profileName(pid)}، ${frames.length} ${frames.length === 1 ? 'جزء' : 'أجزاء'}، ${fs} هرتز\n` + lines.join('\n');
});

// ---------------------------------------------------------------- start

showTab(['send', 'inbox', 'settings'].includes(store.get('tab')) ? store.get('tab') : 'send');
renderCodes();
renderSendForm();
renderMessages();
if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
