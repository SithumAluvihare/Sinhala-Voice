// Sinhala Voice: English speech -> Sinhala speech using the Gemini Live API.
// Everything runs in the browser. The user's API key goes only to Google.

const DEFAULTS = {
  model: 'gemini-3.5-live-translate-preview',
  target: 'si',
};

const WS_URL =
  'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent';

const KEYS = {
  apiKey: 'sv.apiKey',
  model: 'sv.model',
  target: 'sv.target',
  speak: 'sv.speak',
  volume: 'sv.volume',
  source: 'sv.source',
  origMode: 'sv.origMode',
};

const CAN_CAPTURE_TAB = Boolean(navigator.mediaDevices?.getDisplayMedia);
// Chrome/Edge can silence a captured tab; we then replay it ourselves at a lower volume.
const CAN_DUCK_ORIGINAL = Boolean(navigator.mediaDevices?.getSupportedConstraints?.().suppressLocalAudioPlayback);

const OUTPUT_RATE_DEFAULT = 24000;
const MAX_RETRIES = 5;
const TURN_IDLE_MS = 3500;   // close a transcript card after this much quiet
const DRAIN_MS = 4000;       // keep an old session open this long after switching, to catch its last words
const KEY_TEST_MS = 10000;

// How loud the original tab plays, and how far it dips while Sinhala is speaking.
const ORIGINAL_LEVELS = {
  duck: { base: 0.3, whileSpeaking: 0.08 },
  full: { base: 1, whileSpeaking: 1 },
  off: { base: 0, whileSpeaking: 0 },
};

// Lag meter: the smallest Sinhala backlog over this window. If the queue never
// empties for this long, the translation really is falling behind.
const LAG_WINDOW_S = 5;
const LAG_BEHIND_S = 1.5;
const LAG_FAR_S = 4;

// ---------- storage (never throws) ----------
const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* ignore */ } },
  del(k) { try { localStorage.removeItem(k); } catch { /* ignore */ } },
};

// ---------- DOM ----------
const $ = (id) => document.getElementById(id);
const el = {
  installBtn: $('installBtn'),
  keyCard: $('keyCard'),
  keyForm: $('keyForm'),
  keyInput: $('keyInput'),
  keySave: $('keySave'),
  toggleKey: $('toggleKey'),
  rememberKey: $('rememberKey'),
  keyStatus: $('keyStatus'),
  keyMsg: $('keyMsg'),
  keyHelp: $('keyHelp'),
  changeKey: $('changeKey'),
  forgetKey: $('forgetKey'),
  micBtn: $('micBtn'),
  micLabel: $('micLabel'),
  status: $('status'),
  lag: $('lag'),
  lagText: $('lagText'),
  speakOut: $('speakOut'),
  volume: $('volume'),
  srcTab: $('srcTab'),
  srcMic: $('srcMic'),
  origWrap: $('origWrap'),
  origMode: $('origMode'),
  tip: $('tip'),
  transcript: $('transcript'),
  txEmpty: $('txEmpty'),
  copyTx: $('copyTx'),
  clearTx: $('clearTx'),
  modelInput: $('modelInput'),
  targetInput: $('targetInput'),
  resetAdvanced: $('resetAdvanced'),
};

// ---------- app state ----------
let apiKey = store.get(KEYS.apiKey) || '';
let keyRemembered = Boolean(apiKey);

const s = {
  running: false,
  starting: false,
  startError: null,
  sourceKind: 'mic',
  // Live API sessions: `active` receives our audio; `next` is a replacement
  // being prepared so we can switch without a gap.
  active: null,
  next: null,
  retries: 0,
  reconnectTimer: null,
  ctx: null,
  stream: null,
  source: null,
  worklet: null,
  sink: null,
  outGain: null,
  origGain: null,
  origTarget: -1,
  nextTime: 0,
  playing: new Set(),
  backlogSamples: [],
  tickTimer: null,
  wakeLock: null,
  turn: null,
  turnTimer: null,
  level: 0,
};

// ---------- UI helpers ----------
function setStatus(text, kind = '') {
  el.status.textContent = text;
  el.status.className = 'status' + (kind ? ' ' + kind : '');
}

function showLiveStatus() {
  setStatus(s.sourceKind === 'tab'
    ? 'Translating the shared tab. Play your video'
    : 'Listening. Speak in English', 'live');
}

function setMicUi(active) {
  el.micBtn.setAttribute('aria-pressed', String(active));
  el.micLabel.textContent = active ? 'Stop translating' : 'Start translating';
}

function setLevel(rms) {
  // Smooth the level so the ring doesn't flicker.
  const target = Math.min(1, rms * 7);
  s.level = target > s.level ? target : s.level * 0.8 + target * 0.2;
  el.micBtn.style.setProperty('--level', s.level.toFixed(3));
}

function setKeyMsg(text, kind = '') {
  el.keyMsg.textContent = text;
  el.keyMsg.className = 'key-msg' + (kind ? ' ' + kind : '');
  el.keyMsg.hidden = !text;
}

function renderKeyCard() {
  const hasKey = Boolean(apiKey);
  el.keyCard.classList.toggle('collapsed', hasKey);
  el.keyStatus.hidden = !hasKey;
  el.keyStatus.textContent = keyRemembered ? 'Saved on this device' : 'Active for this visit';
  el.changeKey.hidden = !hasKey;
  el.forgetKey.hidden = !hasKey;
  if (!hasKey) {
    el.keyInput.value = '';
    el.keyHelp.open = true; // first run: show the steps
  }
}

// ---------- settings ----------
function getModel() { return (store.get(KEYS.model) || DEFAULTS.model).trim(); }
function getTarget() { return (store.get(KEYS.target) || DEFAULTS.target).trim(); }

el.modelInput.value = getModel();
el.targetInput.value = getTarget();
el.speakOut.checked = store.get(KEYS.speak) !== '0';
el.volume.value = store.get(KEYS.volume) || '1';

el.modelInput.addEventListener('change', () => {
  const v = el.modelInput.value.trim().replace(/^models\//, '');
  if (v && v !== DEFAULTS.model) store.set(KEYS.model, v); else store.del(KEYS.model);
  el.modelInput.value = getModel();
  if (s.running) setStatus('Model change applies next time you start', 'live');
});

el.targetInput.addEventListener('change', () => {
  const v = el.targetInput.value.trim();
  if (v && v !== DEFAULTS.target) store.set(KEYS.target, v); else store.del(KEYS.target);
  el.targetInput.value = getTarget();
  if (s.running) setStatus('Language change applies next time you start', 'live');
});

el.resetAdvanced.addEventListener('click', () => {
  store.del(KEYS.model);
  store.del(KEYS.target);
  el.modelInput.value = getModel();
  el.targetInput.value = getTarget();
});

el.speakOut.addEventListener('change', () => {
  store.set(KEYS.speak, el.speakOut.checked ? '1' : '0');
  if (!el.speakOut.checked) stopPlayback();
});

el.volume.addEventListener('input', () => {
  store.set(KEYS.volume, el.volume.value);
  if (s.outGain) s.outGain.gain.value = Number(el.volume.value);
});

// ---------- audio source: another browser tab, or the microphone ----------
function getSource() {
  return el.srcTab.checked && CAN_CAPTURE_TAB ? 'tab' : 'mic';
}

function renderSource() {
  const tab = getSource() === 'tab';
  el.origWrap.hidden = !tab || !CAN_DUCK_ORIGINAL;
  el.tip.textContent = tab
    ? 'Press the button, pick the tab with your video (e.g. YouTube) and turn on "Share tab audio". Works in Chrome and Edge on a computer.'
    : 'Tip: use headphones so the translated voice isn\'t picked up by your mic.';
}

function setSourceLocked(locked) {
  el.srcTab.disabled = locked || !CAN_CAPTURE_TAB;
  el.srcMic.disabled = locked;
}

if (CAN_CAPTURE_TAB && store.get(KEYS.source) !== 'mic') el.srcTab.checked = true;
else el.srcMic.checked = true;
el.origMode.value = ORIGINAL_LEVELS[store.get(KEYS.origMode)] ? store.get(KEYS.origMode) : 'duck';
setSourceLocked(false);
if (!CAN_CAPTURE_TAB) el.srcTab.parentElement.title = 'Tab audio capture needs Chrome or Edge on a computer';
renderSource();

for (const radio of [el.srcTab, el.srcMic]) {
  radio.addEventListener('change', () => {
    store.set(KEYS.source, getSource());
    renderSource();
  });
}

el.origMode.addEventListener('change', () => {
  store.set(KEYS.origMode, el.origMode.value);
  s.origTarget = -1; // re-apply on the next tick
  tick();
});

async function getTabStream() {
  const stream = await navigator.mediaDevices.getDisplayMedia({
    // Browsers require video to share a tab. `displaySurface: 'browser'`
    // opens the picker on the tab list. We disable the video below.
    video: { displaySurface: 'browser' },
    audio: {
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
      // Silence the original tab; we replay it ourselves so we can control its volume.
      suppressLocalAudioPlayback: CAN_DUCK_ORIGINAL,
    },
    preferCurrentTab: false,
    selfBrowserSurface: 'exclude',
    surfaceSwitching: 'include',
    systemAudio: 'include',
  });
  if (!stream.getAudioTracks().length) {
    stream.getTracks().forEach((t) => t.stop());
    const err = new Error('No audio shared');
    err.name = 'NoAudioError';
    throw err;
  }
  stream.getVideoTracks().forEach((t) => { t.enabled = false; });
  return stream;
}

function getMicStream() {
  return navigator.mediaDevices.getUserMedia({
    audio: {
      channelCount: 1,
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    },
  });
}

// ---------- base64 <-> PCM ----------
function bytesToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  }
  return btoa(bin);
}

function base64Pcm16ToFloat32(b64) {
  const bin = atob(b64);
  const n = bin.length >> 1;
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let v = bin.charCodeAt(2 * i) | (bin.charCodeAt(2 * i + 1) << 8); // little-endian
    if (v >= 0x8000) v -= 0x10000;
    out[i] = v / 0x8000;
  }
  return out;
}

// ---------- playback ----------
function playPcm(b64, mimeType) {
  if (!el.speakOut.checked || !s.ctx || s.ctx.state === 'closed') return;
  const rate = Number((/rate=(\d+)/.exec(mimeType || '') || [])[1]) || OUTPUT_RATE_DEFAULT;
  const samples = base64Pcm16ToFloat32(b64);
  if (!samples.length) return;

  const buffer = s.ctx.createBuffer(1, samples.length, rate);
  buffer.copyToChannel(samples, 0);
  const src = s.ctx.createBufferSource();
  src.buffer = buffer;
  src.connect(s.outGain);

  // Queue chunks back to back. A small lead avoids clicks on the first chunk.
  const startAt = Math.max(s.ctx.currentTime + 0.03, s.nextTime);
  src.start(startAt);
  s.nextTime = startAt + buffer.duration;
  s.playing.add(src);
  src.onended = () => s.playing.delete(src);
}

function stopPlayback() {
  for (const src of s.playing) {
    try { src.stop(); } catch { /* already stopped */ }
  }
  s.playing.clear();
  s.nextTime = 0;
}

// ---------- ducking + lag meter (runs while translating) ----------
function tick() {
  const ctx = s.ctx;
  if (!ctx || ctx.state === 'closed') return;
  const now = ctx.currentTime;
  const backlog = Math.max(0, s.nextTime - now);
  const speaking = backlog > 0.02;

  // Lower the original tab while Sinhala is speaking.
  if (s.origGain) {
    const lv = ORIGINAL_LEVELS[el.origMode.value] || ORIGINAL_LEVELS.duck;
    const target = speaking ? lv.whileSpeaking : lv.base;
    if (target !== s.origTarget) {
      s.origTarget = target;
      // Dip fast, come back up gently.
      s.origGain.gain.setTargetAtTime(target, now, speaking ? 0.06 : 0.35);
    }
  }

  // Lag: smallest backlog over the last few seconds.
  s.backlogSamples.push([now, backlog]);
  while (s.backlogSamples.length && now - s.backlogSamples[0][0] > LAG_WINDOW_S) s.backlogSamples.shift();
  const lag = Math.min(...s.backlogSamples.map((x) => x[1]));
  renderLag(lag);
}

function renderLag(lag) {
  if (!s.running || !s.active || s.active.state !== 'ready') {
    el.lag.hidden = true;
    return;
  }
  el.lag.hidden = false;
  if (lag < LAG_BEHIND_S) {
    el.lag.dataset.state = 'ok';
    el.lagText.textContent = 'Translation is keeping up';
  } else {
    const secs = (Math.round(lag * 2) / 2).toFixed(1);
    if (lag < LAG_FAR_S) {
      el.lag.dataset.state = 'behind';
      el.lagText.textContent = `Translation is ${secs} s behind`;
    } else {
      el.lag.dataset.state = 'far';
      el.lagText.textContent = s.sourceKind === 'tab'
        ? `Translation is ${secs} s behind. Slow the video to 0.75× or 0.9× (YouTube ⚙ → Playback speed) to let it catch up`
        : `Translation is ${secs} s behind. Pause between sentences to let it catch up`;
    }
  }
}

// ---------- transcript ----------
function nearBottom() {
  const t = el.transcript;
  return t.scrollHeight - t.scrollTop - t.clientHeight < 60;
}

function ensureTurn() {
  if (s.turn) return s.turn;
  const card = document.createElement('div');
  card.className = 'turn live';
  const en = document.createElement('p');
  en.className = 'en';
  en.lang = 'en';
  const si = document.createElement('p');
  si.className = 'si';
  si.lang = getTarget();
  card.append(en, si);
  el.transcript.append(card);
  el.txEmpty.hidden = true;
  s.turn = { card, en, si };
  return s.turn;
}

function appendTranscript(kind, text) {
  if (!text) return;
  const stick = nearBottom();
  const turn = ensureTurn();
  turn[kind].textContent += text;
  if (stick) el.transcript.scrollTop = el.transcript.scrollHeight;

  clearTimeout(s.turnTimer);
  s.turnTimer = setTimeout(finishTurn, TURN_IDLE_MS);
}

function finishTurn() {
  clearTimeout(s.turnTimer);
  if (!s.turn) return;
  const { card, en, si } = s.turn;
  en.textContent = en.textContent.trim();
  si.textContent = si.textContent.trim();
  if (!en.textContent && !si.textContent) card.remove();
  else card.classList.remove('live');
  s.turn = null;
}

el.clearTx.addEventListener('click', () => {
  finishTurn();
  el.transcript.querySelectorAll('.turn').forEach((n) => n.remove());
  el.txEmpty.hidden = false;
});

el.copyTx.addEventListener('click', async () => {
  const text = [...el.transcript.querySelectorAll('.turn')]
    .map((t) => [t.querySelector('.en').textContent, t.querySelector('.si').textContent]
      .filter(Boolean).join('\n'))
    .join('\n\n');
  if (!text) return;
  try {
    await navigator.clipboard.writeText(text);
    el.copyTx.textContent = 'Copied';
  } catch {
    el.copyTx.textContent = 'Copy failed';
  }
  setTimeout(() => { el.copyTx.textContent = 'Copy'; }, 1500);
});

// ---------- Live API ----------
function setupMessage() {
  return {
    setup: {
      model: `models/${getModel()}`,
      inputAudioTranscription: {},
      outputAudioTranscription: {},
      generationConfig: {
        responseModalities: ['AUDIO'],
        translationConfig: {
          targetLanguageCode: getTarget(),
          // false = stay silent when someone already speaks the target language
          echoTargetLanguage: false,
        },
      },
    },
  };
}

function socketUrl(key) {
  return `${WS_URL}?key=${encodeURIComponent(key)}`;
}

async function parseMessage(ev) {
  try {
    const text = typeof ev.data === 'string' ? ev.data : await ev.data.text();
    return JSON.parse(text);
  } catch {
    return null;
  }
}

// Turn a WebSocket close into something a person can act on.
function classifyClose(ev) {
  const reason = (ev.reason || '').trim();
  if (/api.?key|unauthenticated|credential|permission denied/i.test(reason)) {
    return { fatal: true, kind: 'key', message: 'Google rejected this API key. Check it, or create a new one in Google AI Studio.' };
  }
  if (/not found|not supported|unsupported|model/i.test(reason)) {
    return { fatal: true, kind: 'model', message: `Model problem: ${reason}. Check the model name in Advanced settings.` };
  }
  if (/quota|exhausted|rate.?limit/i.test(reason)) {
    return { fatal: true, kind: 'quota', message: 'Your API quota is used up for now. Try again later or check your limits in Google AI Studio.' };
  }
  if (/billing/i.test(reason) || ev.code === 1007 || ev.code === 1008) {
    return { fatal: true, kind: 'other', message: `Google refused the connection${reason ? `: ${reason}` : ` (code ${ev.code})`}.` };
  }
  return { fatal: false, kind: 'network', message: reason ? `Connection closed: ${reason}` : '' };
}

// One Live API connection. state: connecting -> ready -> (draining) -> closed
function openSession() {
  const ws = new WebSocket(socketUrl(apiKey));
  const sess = { ws, state: 'connecting' };

  ws.onopen = () => {
    if (sess.state === 'connecting') ws.send(JSON.stringify(setupMessage()));
  };

  ws.onmessage = async (ev) => {
    const msg = await parseMessage(ev);
    if (!msg || sess.state === 'closed') return;

    if (msg.setupComplete) {
      sess.state = 'ready';
      onSessionReady(sess);
      return;
    }
    if (msg.goAway) {
      // This session will end soon. Prepare a replacement now.
      if (sess === s.active) prepareNextSession();
      return;
    }
    if (msg.serverContent && s.running) handleContent(msg.serverContent);
  };

  ws.onclose = (ev) => {
    const prev = sess.state;
    sess.state = 'closed';
    onSessionClosed(sess, ev, prev);
  };

  return sess;
}

function closeSession(sess, why = 'done') {
  if (!sess || sess.state === 'closed') return;
  sess.state = 'closed';
  try { sess.ws.close(1000, why); } catch { /* ignore */ }
}

function prepareNextSession() {
  if (!s.running || s.next) return;
  s.next = openSession();
}

function onSessionReady(sess) {
  if (sess === s.next) {
    // Switch audio to the new session; let the old one finish its last words.
    const old = s.active;
    s.active = sess;
    s.next = null;
    if (old && old.state !== 'closed') {
      old.state = 'draining';
      setTimeout(() => closeSession(old, 'replaced'), DRAIN_MS);
    }
  }
  if (sess === s.active) {
    s.retries = 0;
    if (s.running) showLiveStatus();
  }
}

function onSessionClosed(sess, ev, prev) {
  if (prev === 'closed' || prev === 'draining') return; // we closed it, or it was retired

  const info = classifyClose(ev);

  if (sess === s.next) {
    s.next = null;
    if (info.fatal && s.running) failFatal(info.message);
    return; // the active session is still working
  }
  if (sess !== s.active) return;
  s.active = null;

  if (s.starting) {
    // Still waiting on the share picker; start() decides what to do.
    if (info.fatal) s.startError = info.message;
    return;
  }
  if (!s.running) return;
  if (info.fatal) { failFatal(info.message); return; }

  // A replacement was already on its way; promote it.
  if (s.next) {
    s.active = s.next;
    s.next = null;
    if (s.active.state === 'ready') onSessionReady(s.active);
    else setStatus('Reconnecting…');
    return;
  }

  if (s.retries >= MAX_RETRIES) {
    failFatal(info.message || 'Lost connection to Gemini. Check your internet and try again.');
    return;
  }
  s.retries++;
  const delay = Math.min(8000, 400 * 2 ** (s.retries - 1));
  setStatus('Connection dropped. Reconnecting…');
  clearTimeout(s.reconnectTimer);
  s.reconnectTimer = setTimeout(() => {
    if (s.running && !s.active) s.active = openSession();
  }, delay);
}

function failFatal(message) {
  stop();
  setStatus(message, 'error');
}

function handleContent(sc) {
  if (sc.interrupted) stopPlayback();

  if (sc.inputTranscription?.text) appendTranscript('en', sc.inputTranscription.text);
  if (sc.outputTranscription?.text) appendTranscript('si', sc.outputTranscription.text);

  const parts = sc.modelTurn?.parts;
  if (parts) {
    for (const p of parts) {
      if (p.inlineData?.data) playPcm(p.inlineData.data, p.inlineData.mimeType);
    }
  }

  if (sc.turnComplete) finishTurn();
}

// ---------- key check ----------
// Opens a session with the key, waits for Google to accept the setup, then closes it.
function testKey(key) {
  return new Promise((resolve) => {
    let done = false;
    let ws;
    const finish = (result) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { ws?.close(1000, 'key check'); } catch { /* ignore */ }
      resolve(result);
    };
    const timer = setTimeout(() => finish({ ok: null }), KEY_TEST_MS);
    try {
      ws = new WebSocket(socketUrl(key));
    } catch {
      finish({ ok: null });
      return;
    }
    ws.onopen = () => ws.send(JSON.stringify(setupMessage()));
    ws.onmessage = async (ev) => {
      const msg = await parseMessage(ev);
      if (msg?.setupComplete) finish({ ok: true });
    };
    ws.onclose = (ev) => {
      const info = classifyClose(ev);
      finish(info.fatal ? { ok: false, ...info } : { ok: null });
    };
  });
}

el.keyForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const value = el.keyInput.value.trim();
  if (value.length < 20 || /\s/.test(value)) {
    setKeyMsg('That doesn\'t look like a full API key. Copy it again from Google AI Studio.', 'error');
    el.keyInput.focus();
    return;
  }

  el.keySave.disabled = true;
  el.keySave.textContent = 'Checking…';
  setKeyMsg('Checking your key with Google…');
  const result = await testKey(value);
  el.keySave.disabled = false;
  el.keySave.textContent = 'Save';

  if (result.ok === false && result.kind === 'key') {
    setKeyMsg(result.message, 'error');
    el.keyInput.focus();
    return;
  }

  apiKey = value;
  keyRemembered = el.rememberKey.checked;
  if (keyRemembered) store.set(KEYS.apiKey, apiKey);
  else store.del(KEYS.apiKey);
  el.keyInput.value = '';
  el.keyInput.type = 'password';
  el.toggleKey.textContent = 'Show';
  setKeyMsg('');
  renderKeyCard();

  if (result.ok === true) setStatus('Key works. Press the button to start', 'live');
  else if (result.ok === false) setStatus(`Key saved, but: ${result.message}`, 'error');
  else setStatus('Key saved. Couldn\'t reach Google to check it, but you can try starting');
});

el.toggleKey.addEventListener('click', () => {
  const show = el.keyInput.type === 'password';
  el.keyInput.type = show ? 'text' : 'password';
  el.toggleKey.textContent = show ? 'Hide' : 'Show';
  el.toggleKey.setAttribute('aria-label', show ? 'Hide key' : 'Show key');
});

el.changeKey.addEventListener('click', () => {
  el.keyCard.classList.remove('collapsed');
  el.rememberKey.checked = keyRemembered || !apiKey;
  el.keyInput.focus();
});

el.forgetKey.addEventListener('click', () => {
  if (s.running) stop();
  apiKey = '';
  keyRemembered = false;
  store.del(KEYS.apiKey);
  setKeyMsg('');
  renderKeyCard();
  setStatus('Key removed from this browser');
});

// ---------- capture ----------
function onAudioChunk(ev) {
  const { pcm, rms } = ev.data;
  setLevel(rms);
  const sess = s.active;
  if (!s.running || !sess || sess.state !== 'ready' || sess.ws.readyState !== WebSocket.OPEN) return;
  if (sess.ws.bufferedAmount > 512 * 1024) return; // network is backed up, drop audio
  sess.ws.send(JSON.stringify({
    realtimeInput: {
      audio: { data: bytesToBase64(pcm), mimeType: 'audio/pcm;rate=16000' },
    },
  }));
}

async function start() {
  if (s.running || s.starting) return;
  if (!apiKey) {
    setStatus('Add your Gemini API key first.', 'error');
    el.keyCard.classList.remove('collapsed');
    el.keyHelp.open = true;
    el.keyInput.focus();
    return;
  }
  if (!navigator.mediaDevices?.getUserMedia || !window.AudioWorkletNode) {
    setStatus('This browser can\'t capture audio. Try the latest Chrome or Edge.', 'error');
    return;
  }

  const source = getSource();
  s.sourceKind = source;
  s.starting = true;
  s.startError = null;
  s.retries = 0;
  el.micBtn.disabled = true;
  setSourceLocked(true);
  setStatus(source === 'tab'
    ? 'Choose the tab to translate and turn on "Share tab audio"…'
    : 'Starting microphone…');

  // Connect to Google while the picker / permission prompt is open.
  s.active = openSession();

  try {
    s.stream = source === 'tab' ? await getTabStream() : await getMicStream();
    if (s.startError) {
      const err = new Error(s.startError);
      err.name = 'ConnectError';
      throw err;
    }

    s.ctx = new AudioContext({ latencyHint: 'interactive' });
    await s.ctx.resume();
    await s.ctx.audioWorklet.addModule('pcm-capture.js');

    s.source = s.ctx.createMediaStreamSource(s.stream);
    s.worklet = new AudioWorkletNode(s.ctx, 'pcm-capture');
    s.worklet.port.onmessage = onAudioChunk;
    // Keep the worklet pulled by the graph without making the input audible.
    s.sink = s.ctx.createGain();
    s.sink.gain.value = 0;
    s.source.connect(s.worklet).connect(s.sink).connect(s.ctx.destination);

    s.outGain = s.ctx.createGain();
    s.outGain.gain.value = Number(el.volume.value);
    s.outGain.connect(s.ctx.destination);

    // Tab mode: the browser silenced the tab, so replay the original here at our chosen volume.
    if (source === 'tab' && CAN_DUCK_ORIGINAL) {
      s.origGain = s.ctx.createGain();
      s.origGain.gain.value = (ORIGINAL_LEVELS[el.origMode.value] || ORIGINAL_LEVELS.duck).base;
      s.origTarget = s.origGain.gain.value;
      s.source.connect(s.origGain).connect(s.ctx.destination);
    }

    // Mic unplugged, or the user pressed the browser's "Stop sharing" bar.
    s.stream.getAudioTracks()[0]?.addEventListener('ended', () => {
      if (!s.running) return;
      stop();
      if (source === 'tab') setStatus('Tab sharing ended. Press the button to share again');
      else setStatus('Microphone disconnected.', 'error');
    });

    s.running = true;
    s.backlogSamples = [];
    s.tickTimer = setInterval(tick, 150);
    setMicUi(true);
    requestWakeLock();

    if (!s.active) s.active = openSession(); // early connection dropped; try again
    if (s.active.state === 'ready') showLiveStatus();
    else setStatus('Connecting…');
  } catch (err) {
    closeSession(s.active, 'start failed');
    s.active = null;
    teardownAudio();
    setMicUi(false);
    setSourceLocked(false);
    if (err?.name === 'ConnectError') {
      setStatus(err.message, 'error');
    } else if (err?.name === 'NoAudioError') {
      setStatus('No sound was shared. Pick a browser tab and turn on "Share tab audio".', 'error');
    } else if (err?.name === 'NotAllowedError' && source === 'tab') {
      setStatus('Sharing was cancelled.');
    } else if (err?.name === 'NotAllowedError') {
      setStatus('Microphone access was blocked. Allow it in your browser\'s site settings.', 'error');
    } else if (err?.name === 'NotFoundError') {
      setStatus('No microphone found.', 'error');
    } else {
      setStatus(`Couldn't start: ${err?.message || err}`, 'error');
    }
  } finally {
    s.starting = false;
    el.micBtn.disabled = false;
  }
}

function teardownAudio() {
  clearInterval(s.tickTimer);
  s.tickTimer = null;
  stopPlayback();
  try { s.source?.disconnect(); } catch { /* ignore */ }
  try { s.worklet?.disconnect(); } catch { /* ignore */ }
  if (s.worklet) s.worklet.port.onmessage = null;
  s.stream?.getTracks().forEach((t) => t.stop());
  if (s.ctx && s.ctx.state !== 'closed') s.ctx.close().catch(() => {});
  s.ctx = s.stream = s.source = s.worklet = s.sink = s.outGain = s.origGain = null;
  s.origTarget = -1;
  s.level = 0;
  el.micBtn.style.setProperty('--level', '0');
  el.lag.hidden = true;
}

function stop() {
  s.running = false;
  clearTimeout(s.reconnectTimer);
  closeSession(s.active, 'user stopped');
  closeSession(s.next, 'user stopped');
  s.active = s.next = null;
  teardownAudio();
  finishTurn();
  releaseWakeLock();
  setMicUi(false);
  setSourceLocked(false);
  setStatus('Stopped. Press the button to start again');
}

el.micBtn.addEventListener('click', () => (s.running ? stop() : start()));

// Space bar toggles when focus isn't in a form control.
document.addEventListener('keydown', (e) => {
  if (e.code !== 'Space' || e.repeat) return;
  const tag = document.activeElement?.tagName;
  if (['INPUT', 'TEXTAREA', 'BUTTON', 'SUMMARY', 'SELECT'].includes(tag)) return;
  e.preventDefault();
  s.running ? stop() : start();
});

// ---------- keep the screen on while translating (phones) ----------
async function requestWakeLock() {
  try {
    const lock = await navigator.wakeLock?.request('screen');
    if (!lock) return;
    s.wakeLock = lock;
    // The browser drops the lock when the tab is hidden; forget it so we re-request.
    lock.addEventListener('release', () => { if (s.wakeLock === lock) s.wakeLock = null; });
  } catch { s.wakeLock = null; }
}
function releaseWakeLock() {
  s.wakeLock?.release().catch(() => {});
  s.wakeLock = null;
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && s.running && !s.wakeLock) requestWakeLock();
});

// ---------- installable app (PWA) ----------
let installPrompt = null;
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  installPrompt = e;
  el.installBtn.hidden = false;
});
el.installBtn.addEventListener('click', async () => {
  if (!installPrompt) return;
  installPrompt.prompt();
  await installPrompt.userChoice.catch(() => {});
  installPrompt = null;
  el.installBtn.hidden = true;
});
window.addEventListener('appinstalled', () => { el.installBtn.hidden = true; });

if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  navigator.serviceWorker.register('sw.js').catch(() => { /* app still works without it */ });
}

// ---------- init ----------
renderKeyCard();
if (!apiKey) setStatus('Add your API key above, then press the button');
