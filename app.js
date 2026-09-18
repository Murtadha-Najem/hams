import { buildPacket, Receiver, PROFILES, profileId, airtime, bitsPerSecond } from './modem.js';
import { frameMessage, parseFrame, receiptFrame, Assembler, seal, unseal, SEALED, randomId16, chatContent, parseChat, MAX_CONTENT } from './protocol.js';

const $ = (id) => document.getElementById(id);
const store = {
  get(k, d) { try { const v = localStorage.getItem('hams.' + k); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('hams.' + k, JSON.stringify(v)); } catch { /* private mode: nothing persists */ } },
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const hhmm = (t) => new Date(t).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });

const MODE_NAMES = { U: 'Inaudible', A: 'Audible' };
const SPEED_NAMES = ['robust', 'normal'];
const profileName = (pid) => `${MODE_NAMES[PROFILES[pid].band]}, ${SPEED_NAMES[PROFILES[pid].speed]}`;

// Receipts. After the last part of each round the sender falls silent for RECEIPT_SLOTS slots;
// every device that can read the message answers in one slot picked at random, so a few
// receivers rarely collide, and a collision is retried on the next round.
const RECEIPT_SLOTS = 3;
const RECEIPT_BYTES = 17;
const slotSeconds = (pid) => airtime(RECEIPT_BYTES, pid) + 0.15;
const CHAT_ROUNDS = 5;

// Packet ids: message packets use 0 to 447, receipts 448 to 511, so someone else's receipt never
// shares an id with the packets this device is sending and is never mistaken for an echo.
const ownIds = new Set();
function newId(receipt = false) {
  let id;
  do id = receipt ? 448 + Math.floor(Math.random() * 64) : Math.floor(Math.random() * 448); while (ownIds.has(id));
  ownIds.add(id);
  return id;
}
const releaseIds = (ids) => setTimeout(() => ids.forEach((i) => ownIds.delete(i)), 30000);

// ---------------------------------------------------------------- saved state

const settings = { band: 'U', speed: 1, vol: 0.9, ...store.get('settings', {}) };
if (!(settings.speed in SPEED_NAMES)) settings.speed = 1;
const saveSettings = () => store.set('settings', settings);
const currentPid = () => profileId(settings.band, settings.speed);

let deviceId = store.get('device', null);
if (deviceId === null) { deviceId = randomId16(); store.set('device', deviceId); }
let myName = store.get('name', '');
let groups = store.get('codes', []); // [{ label, secret }], each one a private room

// rooms: 'public', or 'g:<label>' for a group. Each holds its messages, newest last.
const chats = store.get('chat', {});
for (const list of Object.values(chats)) for (const m of list) if (m.mine && ['queued', 'sending'].includes(m.status)) m.status = 'failed';
const saveChats = () => {
  for (const k of Object.keys(chats)) if (chats[k].length > 300) chats[k] = chats[k].slice(-300);
  store.set('chat', chats);
};
const roomList = () => ['public', ...groups.map((g) => 'g:' + g.label)];
const groupOf = (room) => (room === 'public' ? null : groups.find((g) => 'g:' + g.label === room) || null);
const roomTitle = (room) => (room === 'public' ? 'Public' : room.slice(2));
let room = roomList().includes(store.get('room')) ? store.get('room') : 'public';
const unread = {};

// ---------------------------------------------------------------- light and dark

function renderTheme() {
  const dark = document.documentElement.dataset.theme === 'dark';
  $('themeBtn').querySelector('use').setAttribute('href', dark ? '#i-sun' : '#i-moon');
  $('themeBtn').setAttribute('aria-label', dark ? 'Light mode' : 'Dark mode');
  $('themeColor').content = dark ? '#121110' : '#f3eee5';
}
$('themeBtn').addEventListener('click', () => {
  const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
  document.documentElement.dataset.theme = next;
  store.set('theme', next);
  renderTheme();
});

// ---------------------------------------------------------------- audio

let ctx = null;
async function audio() {
  if (!ctx) ctx = new (window.AudioContext || window.webkitAudioContext)({ latencyHint: 'interactive' });
  if (ctx.state === 'suspended') await ctx.resume().catch(() => {});
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
let micProblem = '';

async function startListening() {
  if (listening) return listening;
  await audio();
  if (!navigator.mediaDevices?.getUserMedia) throw new Error('This browser blocks the microphone here. Open the page over https.');
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
  micProblem = '';
  try { wakeLock = await navigator.wakeLock?.request('screen'); } catch { wakeLock = null; }
  showDeviceInfo();
  drawSpectrum();
  renderState();
  return listening;
}

// a screen lock releases the wake lock; take it back when the page is visible again
document.addEventListener('visibilitychange', async () => {
  if (document.visibilityState === 'visible' && listening) try { wakeLock = await navigator.wakeLock?.request('screen'); } catch { /* ignore */ }
});

const micError = (e) => (e.name === 'NotAllowedError' ? 'Microphone access was refused.' : e.message);

async function tryListen() {
  try { await startListening(); } catch (e) { micProblem = micError(e); }
  renderState();
}

// ---------------------------------------------------------------- the strip above the composer

let activity = null; // { text, until } from the transmitter or the receiver
function setActivity(text, seconds = 3) { activity = { text, until: Date.now() + seconds * 1000 }; renderState(); }
setInterval(() => { if (activity && Date.now() > activity.until) { activity = null; renderState(); } }, 500);

function renderState() {
  const on = !!listening && ctx?.state === 'running';
  $('live').classList.toggle('on', on);
  $('liveText').textContent = on ? 'Listening' : 'Not listening';
  const box = $('state');
  box.textContent = '';
  if (activity) { box.textContent = activity.text; return; }
  if (on) { box.textContent = profileName(currentPid()); return; }
  const span = el('span', micProblem ? 'bad' : '', micProblem || (listening ? 'Tap anywhere to start the sound.' : 'Not listening yet.'));
  const b = el('button', '', 'Start listening');
  b.addEventListener('click', async () => { await audio(); await tryListen(); });
  box.append(span, b);
}

// ---------------------------------------------------------------- receiving

const assembler = new Assembler();
const ownMsgIds = new Set();
const seen = new Map(); // msgId -> { state: 'opening' | 'readable' | 'foreign', lastReceipt }

function onRxEvent(e) {
  if (ownIds.has(e.id)) return;
  if (e.type === 'incoming') {
    // something is arriving: a sender waiting for receipts keeps listening until it is decoded
    if (sending) sending.busyUntil = Math.max(sending.busyUntil, Date.now() + e.seconds * 1000 + 400);
    else setActivity('Receiving...', e.seconds + 1);
  } else if (e.type === 'failed' && !sending) {
    setActivity('Heard a message, waiting for a clearer copy...', 4);
  }
}

function onPacket(pk) {
  const f = parseFrame(pk.bytes);
  if (!f) return;
  if (f.kind === 'receipt') { onReceipt(f); return; }
  if (ownMsgIds.has(f.msgId)) return;
  const st = assembler.add(f);
  if (!st.complete) { setActivity(`Receiving a long message, part ${st.got} of ${st.total}...`, 6); return; }
  if (st.fresh) openMessage(f.msgId, st.content, pk);
  if (pk.w) answerWindow(f.msgId, pk.pid);
}

async function openMessage(msgId, content, pk) {
  const s = { state: 'opening', lastReceipt: 0 };
  seen.set(msgId, s);
  let group = null;
  if (content[0] === SEALED) {
    const r = await unseal(content, groups.map((g) => g.secret));
    if (!r) { s.state = 'foreign'; return; } // another group's message: ignore without a trace
    content = r.content;
    group = groups.find((g) => g.secret === r.secret);
  }
  const chat = parseChat(content);
  if (!chat) { s.state = 'foreign'; return; }
  s.state = 'readable';
  const key = group ? 'g:' + group.label : 'public';
  const list = (chats[key] ||= []);
  if (!list.some((m) => m.id === msgId && m.dev === chat.deviceId)) {
    list.push({ id: msgId, dev: chat.deviceId, name: chat.name, text: chat.text, replyTo: chat.replyTo, t: Date.now(), mine: false });
    saveChats();
    if (key !== room) unread[key] = (unread[key] || 0) + 1;
    if (navigator.vibrate) try { navigator.vibrate(60); } catch { /* ignore */ }
    activity = null;
    renderRooms();
    if (key === room) renderThread(true);
    else renderState();
  }
  if (pk.w) answerWindow(msgId, pk.pid);
}

// The packet just decoded closed a round: its sender is listening for receipts right now.
async function answerWindow(msgId, pid) {
  const s = seen.get(msgId);
  if (!s || s.state !== 'readable' || sending) return;
  if (Date.now() - s.lastReceipt < 2500) return;
  s.lastReceipt = Date.now();
  const slot = Math.floor(Math.random() * RECEIPT_SLOTS);
  await sleep(50 + slot * slotSeconds(pid) * 1000);
  if (sending) return;
  const id = newId(true);
  await play(buildPacket(receiptFrame(msgId, deviceId, myName), pid, ctx.sampleRate, { id, amp: settings.vol }));
  releaseIds([id]);
}

function onReceipt(f) {
  if (!sending || f.msgId !== sending.msgId || f.deviceId === deviceId) return;
  if (!sending.receipts.has(f.deviceId)) {
    sending.receipts.set(f.deviceId, f.name);
    sending.hooks.receipt?.(sending, f);
  }
}

// ---------------------------------------------------------------- the transmitter
// One speaker, one broadcast at a time. need > 0 ends each round with a receipt window;
// fullWindow listens to the end of that window, so every receiver's answer is counted and the
// next message does not talk over the last ones.

let sending = null;

async function broadcast(content, { need, maxRounds, msgId: reuse, fullWindow = false, hooks = {} }) {
  await audio();
  if (need > 0) await startListening();
  while (sending) await sleep(150);
  const pid = currentPid();
  const { msgId, frames } = frameMessage(content, reuse);
  ownMsgIds.add(msgId);
  const ids = frames.map(() => newId());
  const packets = frames.map((f, i) => buildPacket(f, pid, ctx.sampleRate, { id: ids[i], amp: settings.vol, window: need > 0 && i === frames.length - 1 }));
  const job = sending = { msgId, need, receipts: new Map(), stop: false, busyUntil: 0, round: 0, hooks };
  const windowMs = (RECEIPT_SLOTS * slotSeconds(pid) + 1.0) * 1000;
  try {
    while (!job.stop && job.round < maxRounds) {
      job.round++;
      for (let i = 0; i < packets.length && !job.stop; i++) {
        hooks.part?.(job, i, packets.length);
        await play(packets[i]);
        if (i < packets.length - 1) await sleep(120);
      }
      if (job.stop) break;
      hooks.roundDone?.(job);
      if (need > 0) {
        hooks.wait?.(job);
        const until = Date.now() + windowMs;
        while (!job.stop && (fullWindow || job.receipts.size < need) && Date.now() < Math.max(until, job.busyUntil)) await sleep(100);
        if (job.receipts.size >= need) break;
      } else {
        await sleep(400);
      }
    }
  } finally {
    releaseIds(ids);
    setTimeout(() => ownMsgIds.delete(msgId), 10 * 60 * 1000);
    sending = null;
  }
  return job;
}

// ---------------------------------------------------------------- chat: sending

const outbox = [];
let pumping = false;
let replying = null; // the message being replied to

function sendChat(text) {
  const msg = { id: randomId16(), dev: deviceId, name: myName, text, replyTo: replying?.id ?? null, t: Date.now(), mine: true, status: 'queued', by: [] };
  (chats[room] ||= []).push(msg);
  saveChats();
  setReply(null);
  renderThread(true);
  enqueue(room, msg);
}

function enqueue(key, msg) {
  msg.status = 'queued';
  outbox.push({ key, msg });
  pump();
}

async function pump() {
  if (pumping) return;
  pumping = true;
  while (outbox.length) {
    const { key, msg } = outbox.shift();
    await transmit(key, msg);
  }
  pumping = false;
  renderState();
}

async function transmit(key, msg) {
  const update = () => { saveChats(); if (key === room) renderThread(); };
  const group = groupOf(key);
  if (key !== 'public' && !group) { msg.status = 'failed'; update(); return; }
  try {
    let content = chatContent({ deviceId, name: myName, text: msg.text, replyTo: msg.replyTo });
    if (group) content = await seal(content, group.secret);
    if (content.length > MAX_CONTENT) throw new Error('That message is too long to send by sound.');
    msg.status = 'sending';
    update();
    const job = await broadcast(content, {
      need: 1, maxRounds: CHAT_ROUNDS, msgId: msg.id, fullWindow: true,
      hooks: {
        part: (j, i, n) => setActivity(`Sending${n > 1 ? ` part ${i + 1} of ${n}` : ''}${j.round > 1 ? `, try ${j.round}` : ''}...`, 30),
        roundDone: () => { if (msg.status === 'sending') { msg.status = 'sent'; update(); } },
        wait: () => setActivity('Waiting for someone to confirm...', 30),
        receipt: (j, f) => {
          msg.status = 'delivered';
          const who = f.name || `device ${f.deviceId}`;
          if (!msg.by.includes(who)) msg.by.push(who);
          update();
        },
      },
    });
    if (!job.receipts.size) msg.status = 'failed';
  } catch (e) {
    msg.status = 'failed';
    micProblem = e.name === 'NotAllowedError' ? micError(e) : e.message;
  }
  activity = null;
  update();
  renderState();
}

// ---------------------------------------------------------------- chat: drawing

function use(id, cls = '') {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  if (cls) svg.setAttribute('class', cls);
  const u = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  u.setAttribute('href', '#' + id);
  svg.append(u);
  return svg;
}
function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}
const nameColor = (dev) => `var(--n${dev % 6})`;
const displayName = (m) => (m.mine ? 'You' : m.name || `Device ${m.dev}`);

function renderRooms() {
  const box = $('rooms');
  box.textContent = '';
  for (const key of roomList()) {
    const b = el('button', 'room');
    b.setAttribute('role', 'tab');
    b.setAttribute('aria-selected', String(key === room));
    b.append(use(key === 'public' ? 'i-hash' : 'i-lock'), document.createTextNode(roomTitle(key)));
    if (unread[key]) b.append(el('span', 'count', String(unread[key])));
    b.addEventListener('click', () => {
      room = key;
      store.set('room', key);
      unread[key] = 0;
      selected = null;
      setReply(null);
      renderRooms();
      (chats[key] || []).forEach((m) => drawn.add(`${m.dev}:${m.id}`));
      renderThread(true);
    });
    box.append(b);
  }
  const add = el('button', 'room add', '+ New group');
  add.addEventListener('click', () => openSheet('newGroup'));
  box.append(add);
  $('roomInfo').textContent = room === 'public'
    ? 'Anyone nearby with Hams open can read this room.'
    : 'Encrypted with the group code. Only members can read it.';
}

let selected = null; // `${dev}:${id}` of the bubble showing its actions
const drawn = new Set(); // bubbles already on screen, so only new ones animate in

function renderThread(toBottom = false) {
  const box = $('thread');
  const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 80;
  box.textContent = '';
  const list = chats[room] || [];
  if (!list.length) {
    const e = el('div', 'empty');
    e.append(use('i-wave'), el('b', '', room === 'public' ? 'No messages yet' : `Nothing in ${roomTitle(room)} yet`),
      document.createTextNode(room === 'public'
        ? 'Messages travel by sound to everyone in the room with Hams open. Say hello.'
        : 'Only devices with this group\'s code will see what you write here.'));
    box.append(e);
    renderState();
    return;
  }
  let prev = null;
  for (const m of list) {
    const key = `${m.dev}:${m.id}`;
    const sameRun = prev && prev.dev === m.dev && prev.mine === m.mine && m.t - prev.t < 3 * 60 * 1000;
    const row = el('div', 'm' + (m.mine ? ' mine' : '') + (sameRun ? '' : ' gap') + (drawn.has(key) ? '' : ' new'));
    drawn.add(key);
    if (!m.mine && !sameRun) {
      const w = el('div', 'who', displayName(m));
      w.style.color = nameColor(m.dev);
      row.append(w);
    }
    const bub = el('div', 'bubble');
    if (m.replyTo !== null && m.replyTo !== undefined) {
      const orig = [...list].reverse().find((x) => x.id === m.replyTo);
      const q = el('div', 'quote');
      q.append(el('b', '', orig ? displayName(orig) : 'Reply'), el('span', '', orig ? orig.text : 'A message this device did not receive'));
      bub.append(q);
    }
    const t = el('div', 'text', m.text);
    t.dir = 'auto';
    bub.append(t);
    const meta = el('div', 'meta', hhmm(m.t));
    if (m.mine) meta.append(tick(m.status));
    bub.append(meta);
    bub.addEventListener('click', () => { selected = selected === key ? null : key; renderThread(); });
    row.append(bub);
    if (selected === key) row.append(actions(m));
    box.append(row);
    prev = m;
  }
  if (toBottom || nearBottom) box.scrollTop = box.scrollHeight;
  renderState();
}

function tick(status) {
  if (status === 'queued' || status === 'sending') return use('i-clock', 'tick');
  if (status === 'sent') return use('i-tick', 'tick');
  if (status === 'delivered') return use('i-ticks', 'tick done');
  return use('i-fail', 'tick fail');
}

function actions(m) {
  const bar = el('div', 'actions');
  const reply = el('button', '', 'Reply');
  reply.addEventListener('click', (e) => { e.stopPropagation(); selected = null; setReply(m); renderThread(); $('input').focus(); });
  const copy = el('button', '', 'Copy');
  copy.addEventListener('click', async (e) => {
    e.stopPropagation();
    try { await navigator.clipboard.writeText(m.text); copy.textContent = 'Copied'; } catch { copy.textContent = 'Could not copy'; }
  });
  bar.append(reply, copy);
  if (m.mine) {
    if (m.status === 'failed') {
      const again = el('button', 'bad', 'Not delivered. Send again');
      again.addEventListener('click', (e) => { e.stopPropagation(); selected = null; enqueue(room, m); renderThread(); });
      bar.append(again);
    } else if (m.status === 'delivered') {
      bar.append(el('span', '', `Received by ${m.by.join(', ')}`));
    } else if (m.status === 'sent') {
      bar.append(el('span', '', 'Sent, nobody has confirmed yet'));
    } else {
      bar.append(el('span', '', 'Waiting to send'));
    }
  }
  return bar;
}

function setReply(m) {
  replying = m;
  $('replying').hidden = !m;
  if (m) { $('replyName').textContent = displayName(m); $('replyText').textContent = m.text; }
}
$('replyCancel').addEventListener('click', () => setReply(null));

// ---------------------------------------------------------------- composer

const input = $('input');
function fit() { input.style.height = 'auto'; input.style.height = Math.min(input.scrollHeight + 2, 132) + 'px'; }
input.addEventListener('input', () => { $('sendBtn').disabled = !input.value.trim(); fit(); });
input.addEventListener('keydown', (e) => {
  // Enter sends on a keyboard; on a phone it stays a new line
  if (e.key === 'Enter' && !e.shiftKey && matchMedia('(pointer: fine)').matches) { e.preventDefault(); submit(); }
});
$('sendBtn').addEventListener('click', submit);
function submit() {
  const text = input.value.trim();
  if (!text) return;
  input.value = '';
  $('sendBtn').disabled = true;
  fit();
  sendChat(text);
}

// ---------------------------------------------------------------- sheets

function openSheet(id) {
  $(id).hidden = false;
  if (id === 'settings') renderSettings();
  if (id === 'newGroup') {
    $('groupName').value = '';
    $('groupCode').value = '';
    $('groupMeta').textContent = '';
    setTimeout(() => $('groupName').focus(), 50);
  }
}
const closeSheet = (id) => { $(id).hidden = true; };
document.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', () => closeSheet(b.dataset.close)));
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') ['newGroup', 'settings'].forEach(closeSheet); });
$('openSettings').addEventListener('click', () => openSheet('settings'));

// welcome: a name is required before anything else
const welcomeName = $('welcomeName');
welcomeName.addEventListener('input', () => { $('joinBtn').disabled = !welcomeName.value.trim(); });
welcomeName.addEventListener('keydown', (e) => { if (e.key === 'Enter' && welcomeName.value.trim()) $('joinBtn').click(); });
$('joinBtn').addEventListener('click', async () => {
  myName = welcomeName.value.trim().slice(0, 16);
  store.set('name', myName);
  closeSheet('welcome');
  await tryListen();
});

$('groupAdd').addEventListener('click', () => {
  const label = $('groupName').value.trim(), secret = $('groupCode').value;
  const meta = $('groupMeta');
  meta.className = 'status bad';
  if (!label || !secret) { meta.textContent = 'Give the group a name and a code.'; return; }
  if (groups.some((g) => g.label === label)) { meta.textContent = 'There is already a group with that name.'; return; }
  groups.push({ label, secret });
  store.set('codes', groups);
  room = 'g:' + label;
  store.set('room', room);
  closeSheet('newGroup');
  renderRooms();
  renderThread(true);
  if (!$('settings').hidden) renderSettings();
});

// ---------------------------------------------------------------- settings

$('devNum').textContent = deviceId;
$('myName').addEventListener('input', () => {
  const v = $('myName').value.trim();
  if (v) { myName = v.slice(0, 16); store.set('name', myName); }
});
$('settingsNewGroup').addEventListener('click', () => openSheet('newGroup'));

function bindPick(box, get, set) {
  const sync = () => box.querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.v === String(get()))));
  box.addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    set(b.dataset.v);
    saveSettings();
    sync();
    renderSettings();
    renderState();
  });
  sync();
}
bindPick($('bandSeg'), () => settings.band, (v) => { settings.band = v; });
bindPick($('speedSeg'), () => settings.speed, (v) => { settings.speed = +v; });
$('vol').value = settings.vol;
$('vol').addEventListener('input', () => { settings.vol = +$('vol').value; saveSettings(); });

function renderSettings() {
  $('myName').value = myName;
  const pid = currentPid();
  $('modeNote').textContent = (settings.band === 'U'
    ? 'Above what most adults hear. Keep devices in the same room, speaker facing the microphone.'
    : 'A soft chirping sound. More reliable on weak hardware, but talking nearby gets in the way.')
    + ` About ${Math.round(bitsPerSecond(pid) / 8)} bytes a second. Any device can read either mode.`;
  const box = $('groupList');
  box.textContent = '';
  if (!groups.length) box.append(el('p', 'note', 'No groups yet.'));
  groups.forEach((g, i) => {
    const row = el('div', 'item');
    const del = el('button', '', 'Remove');
    del.addEventListener('click', () => {
      if (!confirm(`Remove the group "${g.label}"? Its messages will stop showing on this device.`)) return;
      groups.splice(i, 1);
      store.set('codes', groups);
      if (room === 'g:' + g.label) { room = 'public'; store.set('room', room); }
      renderSettings();
      renderRooms();
      renderThread(true);
    });
    row.append(use('i-lock'), el('b', '', g.label), el('span', 'sp'), del);
    box.append(row);
  });
}

function showDeviceInfo() {
  const s = listening.track.getSettings ? listening.track.getSettings() : {};
  const onOff = (v) => (v === undefined ? 'unknown' : v ? 'on' : 'off');
  const rows = [
    ['Sample rate', `${ctx.sampleRate} Hz${ctx.sampleRate < 40000 ? ' (too low for the inaudible mode)' : ''}`],
    ['Echo cancellation', onOff(s.echoCancellation)],
    ['Noise suppression', onOff(s.noiseSuppression)],
    ['Auto gain', onOff(s.autoGainControl)],
    ['Microphone', listening.track.label || 'unknown'],
  ];
  const dl = $('devInfo');
  dl.textContent = '';
  for (const [k, v] of rows) dl.append(el('dt', '', k), el('dd', '', v));
}

// ---------------------------------------------------------------- two-device frequency test

let measure = null;
const SWEEP = { f0: 15000, f1: 21500, step: 250, tone: 0.12 };

function drawSpectrum() {
  const c = $('sweepSpec'), g = c.getContext('2d');
  const frame = () => {
    if (!listening) return;
    if (!$('settings').hidden) {
      const css = getComputedStyle(document.documentElement);
      const data = new Float32Array(listening.analyser.frequencyBinCount);
      listening.analyser.getFloatFrequencyData(data);
      const nyq = ctx.sampleRate / 2;
      paint(g, c, data, 14000, 22000, nyq, css, measure);
      if (measure) measureTick(data, nyq);
    }
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
}

function paint(g, c, data, fLo, fHi, nyq, css, m) {
  const W = c.width, H = c.height;
  g.clearRect(0, 0, W, H);
  const X = (f) => ((f - fLo) / (fHi - fLo)) * W;
  const binHz = nyq / data.length;
  const y = (db) => H - Math.max(0, Math.min(1, (db + 120) / 100)) * H;
  g.fillStyle = css.getPropertyValue('--accent');
  g.fillRect(X(18000), H - 2, X(19800) - X(18000), 2);
  if (m) {
    g.strokeStyle = css.getPropertyValue('--muted');
    g.setLineDash([3, 3]);
    g.beginPath();
    m.peak.forEach((db, i) => g.lineTo(X(m.f0 + i * m.step), y(db)));
    g.stroke();
    g.setLineDash([]);
  }
  const i0 = Math.floor(fLo / binHz), i1 = Math.min(data.length - 1, Math.ceil(fHi / binHz));
  const stride = Math.max(1, Math.floor((i1 - i0) / W));
  g.beginPath();
  g.moveTo(X(i0 * binHz), H);
  for (let i = i0; i <= i1; i += stride) {
    let mx = -Infinity;
    for (let j = i; j < i + stride && j <= i1; j++) mx = Math.max(mx, data[j]);
    g.lineTo(X(i * binHz), y(mx));
  }
  g.lineTo(X(i1 * binHz), H);
  g.closePath();
  g.fillStyle = css.getPropertyValue('--line');
  g.fill();
  g.strokeStyle = css.getPropertyValue('--ink');
  g.lineWidth = 1;
  g.stroke();
}

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
  $('measureStatus').textContent = 'Playing the sweep...';
  await play(out);
  $('measureStatus').textContent = 'Sweep done. The result shows on the receiving device.';
});

$('measureBtn').addEventListener('click', async () => {
  try { await startListening(); } catch (e) { $('measureStatus').className = 'status bad'; $('measureStatus').textContent = micError(e); return; }
  const bins = Math.floor((SWEEP.f1 - SWEEP.f0) / SWEEP.step) + 1;
  measure = { f0: SWEEP.f0, step: SWEEP.step, peak: new Array(bins).fill(-140), floor: new Array(bins).fill(0), nFloor: 0, t0: performance.now() };
  $('measureStatus').className = 'status';
  $('measureStatus').textContent = 'Measuring the background for 2 seconds...';
  setTimeout(() => { if (measure) $('measureStatus').textContent = 'Ready. Play the sweep on the other device now (12 seconds).'; }, 2000);
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
    if (p - floor[i] >= 15) top = f;
    if (f >= 18000 && f <= 19800) { inBand++; if (p - floor[i] >= 15) clear++; }
  });
  const out = $('measureStatus');
  if (top === null) {
    out.className = 'status bad';
    out.textContent = 'The sweep did not come through. Move the devices closer, turn the volume up, and play the sweep within the 12 seconds.';
    return;
  }
  const share = clear / inBand;
  out.className = 'status ' + (share >= 0.9 ? 'ok' : share >= 0.5 ? 'warn' : 'bad');
  out.textContent = `Highest clear frequency: ${(top / 1000).toFixed(2)} kHz. ` + (share >= 0.9 ? 'Inaudible works between these devices, and Normal is fine.'
    : share >= 0.5 ? 'Inaudible partly works here. Use Robust.' : 'Inaudible does not work between these devices. Use Audible.');
}

// ---------------------------------------------------------------- self-test without sound

$('selfTest').addEventListener('click', async () => {
  const out = $('selfStatus');
  out.className = 'status mono';
  out.textContent = 'Running...';
  await sleep(30);
  const fs = ctx ? ctx.sampleRate : 48000;
  const pid = currentPid();
  const text = 'Hello from Hams, مرحبا 123';
  let seed = 7;
  const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
  const randn = () => Math.sqrt(-2 * Math.log(rnd() + 1e-12)) * Math.cos(2 * Math.PI * rnd());
  const { frames } = frameMessage(chatContent({ deviceId, name: myName, text }));
  const lines = [];
  for (const noise of [0.002, 0.02, 0.06]) {
    const pks = frames.map((f, i) => buildPacket(f, pid, fs, { id: i }));
    const y = new Float32Array(pks.reduce((s, p) => s + p.length, 0) + 2 * fs);
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
    const rx = new Receiver(fs, { onPacket: (p) => { const f = parseFrame(p.bytes); if (f?.kind === 'part') { const s = asm.add(f); if (s.complete) done = s.content; } } });
    const t0 = performance.now();
    for (let i = 0; i < y.length; i += 4096) rx.push(y.subarray(i, i + 4096));
    const ok = done && parseChat(done)?.text === text;
    lines.push(`noise ${noise}: ${ok ? 'decoded' : 'FAILED'} (${(performance.now() - t0).toFixed(0)} ms)`);
  }
  out.textContent = `${profileName(pid)}, ${fs} Hz\n` + lines.join('\n');
});

// ---------------------------------------------------------------- start

renderTheme();
renderRooms();
for (const list of Object.values(chats)) for (const m of list) drawn.add(`${m.dev}:${m.id}`);
renderThread(true);
fit();
if (!myName) {
  $('welcome').hidden = false;
  setTimeout(() => welcomeName.focus(), 100);
} else {
  // pick the microphone back up without a prompt when permission is already granted; the
  // browser still wants one tap before sound flows, so resume on the first one
  navigator.permissions?.query({ name: 'microphone' }).then((p) => { if (p.state === 'granted') tryListen(); }).catch(() => {});
  document.addEventListener('pointerdown', async () => { if (ctx && ctx.state !== 'running') { await ctx.resume().catch(() => {}); renderState(); } }, { once: true });
}
if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
