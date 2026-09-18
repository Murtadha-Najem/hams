import { buildPacket, Receiver, PROFILES, HEADER_PROFILE, airtime, MAX_PAYLOAD, bitsPerSecond } from './modem.js';
import { encodeText, decodePayload, textEncodingName } from './codec.js';

const $ = (id) => document.getElementById(id);
const store = {
  get(k, d) { try { const v = localStorage.getItem('hams.' + k); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('hams.' + k, JSON.stringify(v)); } catch { /* private mode: settings just do not persist */ } },
};

const SPEED_NAMES = ['متين', 'عادي', 'سريع'];
const BAND_NAMES = { U: 'فوق سمعي', A: 'مسموع' };
const profileName = (pid) => `${BAND_NAMES[PROFILES[pid].band]}، ${SPEED_NAMES[pid - HEADER_PROFILE[PROFILES[pid].band]]}`;

// ---------------------------------------------------------------- tabs

document.querySelectorAll('nav button').forEach((b) => b.addEventListener('click', () => showTab(b.dataset.tab)));
function showTab(name) {
  document.querySelectorAll('nav button').forEach((b) => b.setAttribute('aria-selected', b.dataset.tab === name));
  document.querySelectorAll('section[role="tabpanel"]').forEach((s) => s.classList.toggle('on', s.id === name));
  store.set('tab', name);
}
showTab(['send', 'recv', 'test'].includes(store.get('tab')) ? store.get('tab') : 'send');

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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ids this phone sent recently, so it does not "receive" its own broadcast
const ownIds = new Set();
function newId() {
  let id;
  do id = Math.floor(Math.random() * 256); while (ownIds.has(id));
  ownIds.add(id);
  setTimeout(() => ownIds.delete(id), 60000);
  return id;
}

// ---------------------------------------------------------------- send settings

const settings = { band: 'U', speed: 1, vol: 0.9, repeat: true, ...store.get('settings', {}) };
const currentPid = () => HEADER_PROFILE[settings.band] + settings.speed;

function bindSeg(el, key, parse) {
  const sync = () => el.querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', String(parse(b.dataset.v) === settings[key])));
  el.addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    settings[key] = parse(b.dataset.v);
    store.set('settings', settings);
    sync();
    updateSendMeta();
  });
  sync();
}
bindSeg($('bandSeg'), 'band', String);
bindSeg($('speedSeg'), 'speed', Number);
$('vol').value = settings.vol;
$('repeat').checked = settings.repeat;
$('vol').addEventListener('input', () => { settings.vol = +$('vol').value; store.set('settings', settings); });
$('repeat').addEventListener('change', () => { settings.repeat = $('repeat').checked; store.set('settings', settings); });

const NOTES = {
  U: 'ما ينسمع عند أغلب البالغين. يحتاج الموبايلين قريبين (لحد 2 إلى 3 متر) والسماعة مواجهة للمايك. بعض الموبايلات والابتوبات ما تلتقطه، جرّب صفحة الفحص.',
  A: 'ينسمع كصفير متقطع. أوثق من فوق السمعي ويشتغل على الابتوب، بس الحچي والضوضاء بالغرفة تأثر عليه.',
};

$('msg').value = store.get('draft', '');
$('msg').addEventListener('input', () => { store.set('draft', $('msg').value); updateSendMeta(); });

function describe(bytes, pid) {
  const t = airtime(bytes.length, pid);
  return `${bytes.length} بايت، مدة البث ${t.toFixed(1)} ثانية`;
}

function updateSendMeta() {
  const pid = currentPid();
  $('modeNote').textContent = `${NOTES[settings.band]} السرعة الصافية حوالي ${Math.round(bitsPerSecond(pid) / 8)} بايت بالثانية.`;
  const text = $('msg').value;
  const meta = $('msgMeta');
  if (!text) { meta.textContent = ''; meta.classList.remove('bad'); $('sendBtn').disabled = !transmitting; return; }
  const bytes = encodeText(text);
  const over = bytes.length > MAX_PAYLOAD;
  meta.classList.toggle('bad', over);
  meta.textContent = over
    ? `طويلة: ${bytes.length} بايت بعد الضغط، والحد ${MAX_PAYLOAD}.`
    : `${describe(bytes, pid)} (${textEncodingName(bytes)}، النص الأصلي ${new TextEncoder().encode(text).length} بايت)`;
  $('sendBtn').disabled = over && !transmitting;
}

// ---------------------------------------------------------------- transmit

let transmitting = false;
let stopRequested = false;

async function broadcast(bytes, statusEl, label) {
  if (transmitting) { stopBroadcast(); return; }
  await audio();
  const pid = currentPid();
  const id = newId();
  const packets = new Map();
  const packetFor = (n) => {
    const c = Math.min(15, n);
    if (!packets.has(c)) packets.set(c, buildPacket(bytes, pid, ctx.sampleRate, { id, amp: settings.vol, copy: c }));
    return packets.get(c);
  };
  transmitting = true;
  stopRequested = false;
  setSendButtons();
  let n = 0;
  try {
    do {
      n++;
      statusEl.className = 'status';
      statusEl.textContent = `يبث ${label} (${profileName(pid)})${settings.repeat ? `، المرة ${n}` : ''}`;
      await play(packetFor(n));
      if (settings.repeat && !stopRequested) await sleep(350);
    } while (settings.repeat && !stopRequested);
    statusEl.className = 'status ok';
    statusEl.textContent = `انتهى البث: ${n} ${n === 1 ? 'مرة' : 'مرات'}.`;
  } finally {
    transmitting = false;
    setSendButtons();
  }
}

function stopBroadcast() {
  stopRequested = true;
  if (playing) try { playing.stop(); } catch { /* already ended */ }
}

function setSendButtons() {
  const b = $('sendBtn');
  b.textContent = transmitting ? 'إيقاف البث' : 'إرسال';
  b.classList.toggle('stop', transmitting);
  updateSendMeta();
}

$('sendBtn').addEventListener('click', () => {
  const text = $('msg').value;
  if (!text && !transmitting) { $('sendStatus').className = 'status warn'; $('sendStatus').textContent = 'اكتب رسالة أولاً.'; return; }
  broadcast(transmitting ? null : encodeText(text), $('sendStatus'), 'الرسالة');
});

// ---------------------------------------------------------------- receive

let listening = null;
let wakeLock = null;

async function startListening() {
  await audio();
  if (!navigator.mediaDevices?.getUserMedia) throw new Error('المتصفح ما يسمح بالمايك هنا. افتح الصفحة عبر https أو localhost.');
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
  // decoding runs off the audio callback, so a slow Viterbi never drops microphone samples
  const pump = setInterval(() => {
    let budget = 8;
    while (queue.length && budget--) rx.push(queue.shift());
  }, 30);
  listening = { stream, src, proc, analyser, rx, pump, track: stream.getAudioTracks()[0] };
  try { wakeLock = await navigator.wakeLock?.request('screen'); } catch { wakeLock = null; }
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
}

$('listenBtn').addEventListener('click', async () => {
  if (listening) {
    stopListening();
    $('listenBtn').textContent = 'ابدأ الاستماع';
    $('listenBtn').classList.remove('stop');
    setRecvStatus('الاستماع متوقف.');
    return;
  }
  try {
    await startListening();
    $('listenBtn').textContent = 'أوقف الاستماع';
    $('listenBtn').classList.add('stop');
    setRecvStatus(`يستمع على ${listening.rx.bands.map((b) => BAND_NAMES[b]).join(' و')}.`);
    if (!listening.rx.bands.includes('U')) setRecvStatus('معدل العينات بهذا الجهاز واطي، فالاستلام على المسموع بس.', 'warn');
  } catch (e) {
    setRecvStatus(e.name === 'NotAllowedError' ? 'رفض المتصفح الوصول للمايك.' : e.message, 'bad');
  }
});

function setRecvStatus(text, cls = '') {
  $('recvStatus').className = 'status ' + cls;
  $('recvStatus').textContent = text;
}

let barTimer = null;
function progress(seconds) {
  const bar = $('recvBar');
  clearInterval(barTimer);
  const t0 = performance.now();
  bar.style.width = '0';
  barTimer = setInterval(() => {
    const f = Math.min(1, (performance.now() - t0) / 1000 / Math.max(seconds, 0.1));
    bar.style.width = (f * 100).toFixed(1) + '%';
    if (f >= 1) clearInterval(barTimer);
  }, 100);
}

function onRxEvent(e) {
  if (e.type === 'incoming') {
    if (ownIds.has(e.id)) return;
    setRecvStatus(`يستلم ${e.len} بايت (${profileName(e.pid)})...`);
    progress(e.seconds);
  } else if (e.type === 'failed') {
    if (ownIds.has(e.id)) return;
    $('recvBar').style.width = '0';
    setRecvStatus(`وصلت الرسالة بس ما انفكت (الإشارة ${e.snrDb.toFixed(0)} dB). ${e.heard > 1 ? `جمعت ${e.heard} نسخ لحد الآن، ` : ''}ننتظر التكرار الجاي.`, 'warn');
  } else if (e.type === 'repeat') {
    const el = document.querySelector(`[data-key="${e.key}"] .rep`);
    if (el) el.textContent = `سُمعت ${e.count} مرات`;
    $('recvBar').style.width = '0';
  }
}

const inbox = [];
function onPacket(pk) {
  $('recvBar').style.width = '100%';
  setTimeout(() => ($('recvBar').style.width = '0'), 600);
  const decoded = decodePayload(pk.bytes);
  const when = new Date();
  setRecvStatus(`وصلت رسالة (${pk.bytes.length} بايت).`, 'ok');
  if (navigator.vibrate) try { navigator.vibrate(80); } catch { /* ignore */ }
  const body = decoded.kind === 'text' ? decoded.text : Array.from(pk.bytes, (b) => b.toString(16).padStart(2, '0')).join(' ');
  inbox.unshift({ body, when, pk, text: decoded.kind === 'text' });
  renderInbox();
  addLog(pk, when);
}

function renderInbox() {
  const box = $('inbox');
  box.textContent = '';
  if (!inbox.length) { box.innerHTML = '<div class="empty">ماكو رسائل بعد.</div>'; return; }
  for (const m of inbox) {
    const d = document.createElement('div');
    d.className = 'msg';
    d.dataset.key = m.pk.key;
    const body = document.createElement('div');
    body.className = 'body';
    body.textContent = m.body;
    const foot = document.createElement('div');
    foot.className = 'foot';
    const info = document.createElement('span');
    info.textContent = `${m.when.toLocaleTimeString('ar-IQ', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}، ${profileName(m.pk.pid)}، ${attemptsText(m.pk)}، ${dbText(m.pk.snrs)}`;
    const rep = document.createElement('span');
    rep.className = 'rep';
    foot.append(info, rep);
    if (m.text) {
      const copy = document.createElement('button');
      copy.textContent = 'نسخ';
      copy.addEventListener('click', async () => {
        try { await navigator.clipboard.writeText(m.body); copy.textContent = 'انّسخت'; } catch { copy.textContent = 'ما انّسخت'; }
      });
      foot.append(copy);
    }
    d.append(body, foot);
    box.append(d);
  }
}

// live spectrum plus a light per band when a packet preamble is heard
function drawSpectrum() {
  const c = $('spec'), g = c.getContext('2d');
  const sc = $('sweepSpec'), sg = sc.getContext('2d');
  const css = getComputedStyle(document.documentElement);
  const tick = () => {
    if (!listening) return;
    const a = listening.analyser;
    const data = new Float32Array(a.frequencyBinCount);
    a.getFloatFrequencyData(data);
    const nyq = ctx.sampleRate / 2;
    paint(g, c, data, 0, 22050, nyq, css);
    paint(sg, sc, data, 14000, 22000, nyq, css, measure);
    if (measure) measureTick(data, nyq);
    const lv = listening.rx.levels();
    $('litU').classList.toggle('hot', (lv.U || 0) > 0.2);
    $('litA').classList.toggle('hot', (lv.A || 0) > 0.2);
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

function paint(g, c, data, fLo, fHi, nyq, css, m = null) {
  const W = c.width, H = c.height;
  g.clearRect(0, 0, W, H);
  const X =(f) => ((f - fLo) / (fHi - fLo)) * W;
  g.fillStyle = css.getPropertyValue('--soft');
  for (const [a, b] of [[18000, 19800], [2000, 4000]]) if (b > fLo && a < fHi) g.fillRect(X(Math.max(a, fLo)), 0, X(Math.min(b, fHi)) - X(Math.max(a, fLo)), H);
  const binHz = nyq / data.length;
  const y = (db) => H - Math.max(0, Math.min(1, (db + 120) / 100)) * H;
  if (m) {
    g.strokeStyle = css.getPropertyValue('--warn');
    g.beginPath();
    m.peak.forEach((db, i) => { const f = m.f0 + i * m.step; if (f <= fHi) { g.lineTo(X(f), y(db)); } });
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

// ---------------------------------------------------------------- frequency sweep test

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
    for (let i = 0; i < n; i++) {
      const env = Math.min(1, i / r, (n - 1 - i) / r);
      out[k * n + i] = settings.vol * env * Math.sin((2 * Math.PI * f * i) / fs);
    }
  });
  $('measureStatus').className = 'status';
  $('measureStatus').textContent = 'يشغّل المسح...';
  await play(out);
  $('measureStatus').textContent = 'انتهى المسح. النتيجة تطلع على الجهاز المستلم.';
});

$('measureBtn').addEventListener('click', async () => {
  try {
    if (!listening) {
      await startListening();
      $('listenBtn').textContent = 'أوقف الاستماع';
      $('listenBtn').classList.add('stop');
    }
  } catch (e) { $('measureStatus').className = 'status bad'; $('measureStatus').textContent = e.message; return; }
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
  let top = null, clear18 = 0, clear19 = 0;
  m.peak.forEach((p, i) => {
    const f = m.f0 + i * m.step;
    const margin = p - floor[i];
    if (margin >= 15) top = f;
    if (f >= 18000 && f <= 19800) { clear18++; if (margin >= 15) clear19++; }
  });
  const el = $('measureStatus');
  if (top === null) {
    el.className = 'status bad';
    el.textContent = 'ما وصل المسح بوضوح. قرّب الجهازين، ارفع الصوت، وتأكد إن الجهاز الثاني شغّل المسح خلال الوقت.';
  } else {
    const share = clear19 / clear18;
    const advice = share >= 0.9 ? 'فوق السمعي يشتغل بين هذين الجهازين. ابدأ بـ"عادي".'
      : share >= 0.5 ? 'فوق السمعي يشتغل جزئياً. استخدم "متين".'
      : 'فوق السمعي ما يشتغل بين هذين الجهازين. استخدم المسموع.';
    el.className = 'status ' + (share >= 0.9 ? 'ok' : share >= 0.5 ? 'warn' : 'bad');
    el.textContent = `أعلى تردد وصل بوضوح: ${(top / 1000).toFixed(2)} ألف هرتز. ${advice}`;
  }
}

// ---------------------------------------------------------------- experiment log

// attempts: the sender's repeat number that completed the message (counts copies this phone
// missed entirely); falls back to the copies heard when the sender does not count
const attempts = (pk) => pk.copy || pk.combined;
function attemptsText(pk) {
  const n = attempts(pk);
  const s = n === 1 ? 'من أول محاولة' : `احتاجت ${n}${pk.copy === 15 ? '+' : ''} محاولات`;
  return pk.combined > 1 ? `${s} (انجمعت ${pk.combined} نسخ)` : s;
}
const dbText = (snrs) => `الإشارة ${snrs.map((v) => v.toFixed(1)).join(' ثم ')} dB`;

$('expLabel').value = store.get('expLabel', '');
$('expLabel').addEventListener('input', () => store.set('expLabel', $('expLabel').value));

function logRows() { return store.get('log', []); }

function addLog(pk, when) {
  const rows = logRows();
  rows.unshift({
    t: when.toISOString(),
    label: $('expLabel').value.trim(),
    pid: pk.pid,
    bytes: pk.bytes.length,
    attempts: attempts(pk),
    heard: pk.combined,
    snrs: pk.snrs.map((v) => +v.toFixed(1)),
  });
  store.set('log', rows);
  renderLog();
}

const avg = (xs) => xs.reduce((s, v) => s + v, 0) / xs.length;

function table(headers, rows) {
  const t = document.createElement('table');
  const head = t.createTHead().insertRow();
  for (const h of headers) { const th = document.createElement('th'); th.textContent = h; head.append(th); }
  const body = t.createTBody();
  for (const r of rows) { const tr = body.insertRow(); for (const v of r) tr.insertCell().textContent = v; }
  const w = document.createElement('div');
  w.className = 'tablewrap';
  w.append(t);
  return w;
}

function renderLog() {
  const rows = logRows();
  $('logCount').textContent = rows.length ? `(${rows.length})` : '';
  $('logSummary').textContent = '';
  $('logTable').textContent = '';
  if (!rows.length) { $('logSummary').innerHTML = '<div class="empty">كل رسالة تنقرا تنسجل هنا.</div>'; return; }

  // one line per experiment and mode
  const groups = new Map();
  for (const r of rows) {
    const k = `${r.label}|${r.pid}`;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(r);
  }
  $('logSummary').append(table(
    ['التجربة', 'النمط', 'رسائل', 'من أول محاولة', 'متوسط المحاولات', 'متوسط الإشارة dB'],
    [...groups.values()].map((g) => {
      const first = g.filter((r) => r.attempts === 1).length;
      return [g[0].label || 'بدون وصف', profileName(g[0].pid), g.length, `${first} (${Math.round((100 * first) / g.length)}%)`,
        avg(g.map((r) => r.attempts)).toFixed(1), avg(g.map((r) => r.snrs[r.snrs.length - 1])).toFixed(1)];
    }),
  ));
  $('logTable').append(table(
    ['الوقت', 'التجربة', 'النمط', 'بايت', 'المحاولات', 'الإشارة dB'],
    rows.map((r) => [new Date(r.t).toLocaleTimeString('ar-IQ', { hour: '2-digit', minute: '2-digit', second: '2-digit' }),
      r.label, profileName(r.pid), r.bytes, r.attempts + (r.heard > 1 ? ` (${r.heard} نسخ)` : ''), r.snrs.join('، ')]),
  ));
}

$('logCsv').addEventListener('click', () => {
  const rows = logRows();
  if (!rows.length) return;
  const esc = (s) => `"${String(s).replace(/"/g, '""')}"`;
  const lines = ['time,experiment,band,speed,bytes,attempts,copies_combined,db_final,db_each'];
  for (const r of rows) {
    const p = PROFILES[r.pid];
    lines.push([r.t, esc(r.label), p.band === 'U' ? 'ultrasonic' : 'audible', ['robust', 'normal', 'fast'][r.pid - HEADER_PROFILE[p.band]],
      r.bytes, r.attempts, r.heard, r.snrs[r.snrs.length - 1], esc(r.snrs.join(' '))].join(','));
  }
  const blob = new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = `hams-log-${new Date().toISOString().slice(0, 10)}.csv`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 1000);
});

$('logClear').addEventListener('click', () => {
  if (!confirm('تمسح سجل التجارب من هذا الجهاز؟')) return;
  store.set('log', []);
  renderLog();
});

// ---------------------------------------------------------------- software self-test

$('selfTest').addEventListener('click', async () => {
  const out = $('selfStatus');
  out.className = 'status mono';
  out.textContent = 'يشتغل...';
  await sleep(30);
  const fs = ctx ? ctx.sampleRate : 48000;
  const pid = currentPid();
  const text = $('msg').value || 'السلام عليكم، هذا فحص لنظام همس 123';
  const bytes = encodeText(text);
  const lines = [];
  let seed = 7;
  const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
  const randn = () => Math.sqrt(-2 * Math.log(rnd() + 1e-12)) * Math.cos(2 * Math.PI * rnd());
  for (const noise of [0.002, 0.02, 0.06]) {
    const pk = buildPacket(bytes, pid, fs, { id: 200 });
    const y = new Float32Array(pk.length + fs);
    const delay = Math.round(0.3 * fs);
    for (let i = 0; i < pk.length; i++) {
      y[i + delay] += pk[i];
      // two echoes, 7 ms and 23 ms late
      if (i + delay + Math.round(0.007 * fs) < y.length) y[i + delay + Math.round(0.007 * fs)] += 0.5 * pk[i];
      if (i + delay + Math.round(0.023 * fs) < y.length) y[i + delay + Math.round(0.023 * fs)] += 0.3 * pk[i];
    }
    for (let i = 0; i < y.length; i++) y[i] += noise * randn();
    let got = null;
    const rx = new Receiver(fs, { onPacket: (p) => (got = p) });
    const t0 = performance.now();
    for (let i = 0; i < y.length; i += 4096) rx.push(y.subarray(i, i + 4096));
    const ms = performance.now() - t0;
    const ok = got && decodePayload(got.bytes).text === text;
    lines.push(`ضوضاء ${noise}: ${ok ? `نجح، الإشارة ${got.snrDb.toFixed(0)} dB` : 'فشل'} (${ms.toFixed(0)} ms)`);
  }
  out.textContent = `${profileName(pid)}، ${bytes.length} بايت، ${fs} هرتز\n` + lines.join('\n');
});

// ---------------------------------------------------------------- start

updateSendMeta();
renderInbox();
renderLog();
if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
