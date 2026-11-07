/**
 * 大肥鱼 · 移动端单页原型（纯原生 ES module，无框架、无外部依赖）
 * ---------------------------------------------------------------------------
 * 页面：底部三个 Tab（聊天 / 说书 / 提醒），单页切换，不刷新。
 * 请求：所有 HTTP 请求统一走 api(path, opts)，base = '/whale-mobile/api'。
 * 鉴权：token 来自地址栏 ?token=…，存 localStorage（key: whale.token），
 *       有则带 Authorization: Bearer <token>。
 *
 * ── 关于 SSE「一条 data 被拆成多段到达」的处理（自检项 3）──────────────────
 * 网络传输、代理、甚至浏览器把 chunk 切分的方式都不保证「一个 data 事件正好一个 chunk」。
 * 例如服务器写了 `data: {"type":"delta","text":"鱼"}\n\n`，浏览器完全可能把它拆成
 *   chunk1 = 'data: {"type":"d'
 *   chunk2 = 'elta","text":"鱼"}\n\n'
 * 两次 read()。所以绝对不能「来一块就 JSON.parse 一块」。
 * 本文件的 createSSEParser() 做法是：
 *   1) 每个 chunk 解码后统一追加进同一个字符串 buffer；
 *   2) 只在 buffer 里寻找「完整事件边界」（\n\n 或 \r\n\r\n），切出一个完整事件块再解析，
 *      剩余不完整部分继续留在 buffer 里等下一块；
 *   3) 文本解码用 TextDecoder(..., {stream:true})，这样中文这类多字节 UTF-8 即使被
 *      切在两个 chunk 中间也不会解出乱码（这点和拆包是同一类问题的另一面）；
 *   4) 流结束时 flush()：有些服务器最后一条不带结尾空行，也能被解析掉。
 * 于是无论一条 data 被拆成 2 段、3 段还是被两个事件粘在一起到达，都能正确还原。
 */

/* ========================================================================== *
 * 常量与工具
 * ========================================================================== */

const API_BASE = '/whale-mobile/api';
const TOKEN_KEY = 'whale.token';
const VOICE_KEY = 'whale.voice.on';
const WELCOME_KEY = 'whale.welcome.open';
const TAB_KEY = 'whale.tab';
const TABS = ['chat', 'culture', 'remind'];
const DEFAULT_QUICK_SEC = 600; // 提醒默认选中「10 分钟后」

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

/** 创建元素的小工具 */
function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = String(text);
  return node;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** localStorage 包一层：隐私模式/配额满时读写可能抛错，不能因此白屏 */
const store = {
  get(key) {
    try { return localStorage.getItem(key); } catch { return null; }
  },
  set(key, value) {
    try { localStorage.setItem(key, String(value)); } catch { /* 忽略 */ }
  },
  del(key) {
    try { localStorage.removeItem(key); } catch { /* 忽略 */ }
  },
};

class ApiError extends Error {
  constructor(message, { status = 0, cause = null } = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    if (cause) this.cause = cause;
  }
}

/* ========================================================================== *
 * token：从 URL 读取 → 存本地 → 从地址栏抹掉
 * ========================================================================== */

function bootstrapToken() {
  let url;
  try { url = new URL(window.location.href); } catch { return; }
  const fromUrl = url.searchParams.get('token');
  if (!fromUrl) return;

  store.set(TOKEN_KEY, fromUrl);
  // 把 token 从地址栏去掉：避免截图、分享、历史记录里泄露；后续请求已从 localStorage 取
  url.searchParams.delete('token');
  try {
    window.history.replaceState({}, '', url.pathname + url.search + url.hash);
  } catch { /* 某些环境不允许改历史，忽略 */ }
}

function getToken() {
  return store.get(TOKEN_KEY) || '';
}

bootstrapToken();

/* ========================================================================== *
 * 连接状态点 / toast / 离线条
 * ========================================================================== */

function markConn(state) {
  const dot = $('#connDot');
  const text = $('#connText');
  const box = $('#conn');
  const map = {
    ok: { label: '已连接', aria: '连接状态：上一次请求成功' },
    fail: { label: '连接失败', aria: '连接状态：上一次请求失败' },
    idle: { label: '待连接', aria: '连接状态：待连接' },
  };
  const info = map[state] || map.idle;
  dot.dataset.state = state;
  text.textContent = info.label;
  box.setAttribute('aria-label', info.aria);
}

/** 顶部 toast（非阻塞，替代 alert） */
function toast(message, kind = 'info', timeout = 4200) {
  const host = $('#toastHost');
  if (!host) return;
  const node = el('div', 'toast' + (kind === 'error' ? ' toast--error' : ''), message);
  node.setAttribute('role', kind === 'error' ? 'alert' : 'status');
  host.append(node);
  requestAnimationFrame(() => node.classList.add('is-in'));

  let timer = null;
  const kill = () => {
    if (timer) clearTimeout(timer);
    node.classList.remove('is-in');
    setTimeout(() => node.remove(), 260);
  };
  timer = setTimeout(kill, timeout);
  node.addEventListener('click', kill);
}

/* ========================================================================== *
 * 语音朗读：调电脑端 chubby-whale 的 /api/chubby-whale/tts（edge-tts）
 * ========================================================================== */

// 默认开；只有用户明确关过（存了 '0'）才关
let voiceOn = store.get(VOICE_KEY) !== '0';
let ttsAudio = null;

function updateVoiceButton() {
  const btn = $('#voiceBtn');
  if (!btn) return;
  btn.textContent = voiceOn ? '🔊 语音开' : '🔇 语音';
  btn.setAttribute('aria-pressed', voiceOn ? 'true' : 'false');
}

function setupVoice() {
  const btn = $('#voiceBtn');
  if (!btn) return;
  updateVoiceButton();
  btn.addEventListener('click', () => {
    voiceOn = !voiceOn;
    store.set(VOICE_KEY, voiceOn ? '1' : '0');
    updateVoiceButton();
    if (!voiceOn && ttsAudio) {
      try { ttsAudio.pause(); } catch { /* 忽略 */ }
      setPetSpeaking(false);
    }
    if (voiceOn) {
      // 当场试一句：让用户立刻知道声音通不通
      toast('语音开了：本鱼会念给你听');
      speak('本鱼在手机上说话了，听到没');
    } else {
      toast('语音关了');
    }
  });
}

function setPetSpeaking(on) {
  const pet = $('#pet');
  if (pet) pet.classList.toggle('is-speaking', !!on);
}

function showPetBubble(text) {
  const bubble = $('#petBubble');
  if (!bubble) return;
  bubble.textContent = text;
  bubble.hidden = false;
  clearTimeout(showPetBubble.timer);
  showPetBubble.timer = setTimeout(() => { bubble.hidden = true; }, 3200);
}

async function speak(text) {
  if (!voiceOn) return;
  const said = String(text || '').replace(/\s+/g, ' ').trim();
  if (!said) return;
  // 只念前 300 字：手机听个声，不烧整段合成
  const piece = said.slice(0, 300);
  try {
    const res = await fetch('/api/chubby-whale/tts', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: piece, rate: '+0%' }),
    });
    if (!res.ok) {
      toast(res.status === 501 ? '电脑端没有安装 edge-tts，语音用不了' : `语音失败（${res.status}）`, 'error');
      return;
    }
    const buf = await res.arrayBuffer();
    await playAudioBuffer(buf);
  } catch (err) {
    setPetSpeaking(false);
    toast(`语音失败：${err && err.message ? err.message : '网络错误'}`, 'error');
  }
}

/** 正在朗读的 BufferSource（供「停」按钮用） */
let currentSpeech = null;

/** 停掉当前朗读 */
function stopSpeak() {
  try { currentSpeech?.stop(); } catch { /* 已结束 */ }
  currentSpeech = null;
  if (ttsAudio) {
    try { ttsAudio.pause(); ttsAudio.currentTime = 0; } catch { /* 忽略 */ }
  }
  setPetSpeaking(false);
}

/**
 * 播放音频字节。
 * 优先走已经解锁的 AudioContext（手机浏览器只在用户手势里允许出声，
 * 而 TTS 是异步拿到的，用 <audio>.play() 容易被判成自动播放而静音）；
 * AudioContext 用不了再退回 <audio>。
 */
async function playAudioBuffer(buf) {
  stopSpeak();
  if (audioCtx && audioCtx.state === 'running' && typeof audioCtx.decodeAudioData === 'function') {
    try {
      const data = await audioCtx.decodeAudioData(buf.slice(0));
      const src = audioCtx.createBufferSource();
      src.buffer = data;
      src.connect(audioCtx.destination);
      setPetSpeaking(true);
      currentSpeech = src;
      src.onended = () => {
        if (currentSpeech === src) currentSpeech = null;
        setPetSpeaking(false);
      };
      src.start(0);
      return;
    } catch {
      /* 解码失败就退回 <audio> */
    }
  }

  // 退化路径：<audio>（桌面浏览器通常没问题）
  ttsAudio = new Audio(URL.createObjectURL(new Blob([buf], { type: 'audio/mpeg' })));
  ttsAudio.addEventListener('playing', () => setPetSpeaking(true));
  ttsAudio.addEventListener('ended', () => setPetSpeaking(false));
  ttsAudio.addEventListener('error', () => setPetSpeaking(false));
  try {
    await ttsAudio.play();
  } catch {
    setPetSpeaking(false);
    toast('手机拦了自动播放：先点一下页面任意位置，再发消息', 'error');
  }
}

/* ========================================================================== *
 * 语音输入：录音 → 电脑端 /api/chubby-whale/asr（硅基流动）→ 文字 → 发送
 * ========================================================================== */

let micState = null; // { recorder, stream, chunks }

function setMicRecording(on) {
  const btn = $('#micBtn');
  if (!btn) return;
  btn.classList.toggle('is-recording', !!on);
  btn.setAttribute('aria-pressed', on ? 'true' : 'false');
  btn.textContent = on ? '⏺' : '🎤';
}

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const s = String(reader.result || '');
      resolve(s.slice(s.indexOf(',') + 1));
    };
    reader.onerror = () => reject(new Error('音频读取失败'));
    reader.readAsDataURL(blob);
  });
}

async function startRecording() {
  // 关键：浏览器只在「安全上下文」里给麦克风。手机用 http://192.168.x.x 打开时
  // navigator.mediaDevices 直接不存在——这不是手机不支持，是浏览器规定。
  if (typeof window !== 'undefined' && window.isSecureContext === false) {
    // http 页面：网页开不了麦，改用系统录音器（capture 输入不受安全上下文限制）
    pickAudioFile();
    return;
  }
  if (!navigator.mediaDevices || typeof MediaRecorder === 'undefined') {
    toast('这个浏览器不支持录音（换 Chrome / Edge 试试）', 'error');
    return;
  }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const chunks = [];
    const mime = MediaRecorder.isTypeSupported('audio/webm') ? 'audio/webm' : '';
    const recorder = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
    recorder.addEventListener('dataavailable', (ev) => { if (ev.data && ev.data.size) chunks.push(ev.data); });
    recorder.addEventListener('stop', async () => {
      try { stream.getTracks().forEach((t) => t.stop()); } catch { /* 忽略 */ }
      setMicRecording(false);
      const blob = new Blob(chunks, { type: chunks[0]?.type || 'audio/webm' });
      if (blob.size < 800) {
        toast('太短了，本鱼没听清');
        return;
      }
      await transcribeAndSend(blob);
    });
    recorder.start();
    micState = { recorder, stream, chunks };
    setMicRecording(true);
    toast('说吧，说完再点一下');
  } catch (err) {
    setMicRecording(false);
    toast(err && err.name === 'NotAllowedError' ? '没有麦克风权限：请在浏览器设置里允许' : `录音失败：${err.message}`, 'error');
  }
}

function stopRecording() {
  if (!micState) return;
  try { micState.recorder.stop(); } catch { /* 忽略 */ }
  micState = null;
}

async function transcribeAndSend(blob, format = 'webm') {
  const btn = $('#micBtn');
  if (btn) { btn.textContent = '…'; btn.disabled = true; }
  try {
    const audio = await blobToBase64(blob);
    const res = await fetch('/api/chubby-whale/asr', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ audio, format }),
    });
    if (!res.ok) {
      toast(res.status === 501 ? '电脑端没配语音识别 Key（硅基流动）' : `识别失败（${res.status}）`, 'error');
      return;
    }
    const data = await res.json();
    const text = String(data && data.text ? data.text : '').trim();
    if (!text) {
      toast('没听清，再说一遍？');
      return;
    }
    const input = $('#chatInput');
    input.value = text;
    sendChat();
  } catch (err) {
    toast(`识别失败：${err && err.message ? err.message : '网络错误'}`, 'error');
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '🎤'; }
  }
}

// http 页面（非安全上下文）时：浏览器不给网页开麦，
// 改用「系统录音器 / 选音频文件」——<input capture> 不受安全上下文限制。
function pickAudioFile() {
  const input = $('#micFile');
  if (!input) {
    toast('这个浏览器连录音器都不给用，换 Chrome 试试', 'error');
    return;
  }
  toast('当前是 http，网页开不了麦：用系统录音器录一段，录完自动识别', 'info', 6000);
  input.click();
}

/** 任意音频文件 → 16k 单声道 WAV（ASR 只收 webm/wav/mp3） */
function encodeWavFromAudioBuffer(buffer, targetRate = 16000) {
  const channels = buffer.numberOfChannels;
  const srcRate = buffer.sampleRate;
  const srcLen = buffer.length;
  const ratio = srcRate / targetRate;
  const outLen = Math.max(1, Math.floor(srcLen / ratio));
  const data = [];
  for (let c = 0; c < channels; c++) data.push(buffer.getChannelData(c));

  const samples = new Float32Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const pos = i * ratio;
    const i0 = Math.floor(pos);
    const i1 = Math.min(srcLen - 1, i0 + 1);
    const frac = pos - i0;
    let sum = 0;
    for (let c = 0; c < channels; c++) {
      sum += data[c][i0] * (1 - frac) + data[c][i1] * frac;
    }
    samples[i] = sum / channels;
  }

  const bytes = new ArrayBuffer(44 + outLen * 2);
  const view = new DataView(bytes);
  const writeStr = (off, s) => { for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i)); };
  writeStr(0, 'RIFF');
  view.setUint32(4, 36 + outLen * 2, true);
  writeStr(8, 'WAVE');
  writeStr(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, targetRate, true);
  view.setUint32(28, targetRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeStr(36, 'data');
  view.setUint32(40, outLen * 2, true);
  let off = 44;
  for (let i = 0; i < outLen; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(off, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    off += 2;
  }
  return new Blob([bytes], { type: 'audio/wav' });
}

async function audioFileToWav(file) {
  const arrayBuffer = await file.arrayBuffer();
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) throw new Error('这个浏览器不支持音频解码');
  const ctx = new AC();
  try {
    const decoded = await ctx.decodeAudioData(arrayBuffer.slice(0));
    return encodeWavFromAudioBuffer(decoded, 16000);
  } finally {
    try { await ctx.close(); } catch { /* 忽略 */ }
  }
}

function setupMic() {
  const btn = $('#micBtn');
  if (!btn) return;
  if (typeof window !== 'undefined' && window.isSecureContext === false) {
    btn.title = '当前是 http：点一下会用系统录音器（网页开不了麦）';
  }
  btn.addEventListener('click', () => {
    if (micState) stopRecording();
    else startRecording();
  });

  const fileInput = $('#micFile');
  if (fileInput) {
    fileInput.addEventListener('change', async () => {
      const file = fileInput.files && fileInput.files[0];
      fileInput.value = '';
      if (!file) return;
      try {
        const wav = await audioFileToWav(file);
        await transcribeAndSend(wav, 'wav');
      } catch (err) {
        toast(`音频处理失败：${err && err.message ? err.message : '未知错误'}`, 'error');
      }
    });
  }
}

/* ========================================================================== *
 * WebAudio：首次用户手势后才创建 AudioContext（规避自动播放限制）
 * ========================================================================== */

let audioCtx = null;

function unlockAudio() {
  try {
    if (audioCtx) {
      if (audioCtx.state === 'suspended') audioCtx.resume().catch(() => {});
      return;
    }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    audioCtx = new AC();
    if (audioCtx.state === 'suspended') audioCtx.resume().catch(() => {});
  } catch {
    audioCtx = null; // 环境不支持就静默降级，别影响提醒本身
  }
}

/** 短提示音：一声「叮」，约 0.4s */
function playBeep() {
  if (!audioCtx) return; // 没有用户手势过，就不响（避免被浏览器拦）
  try {
    const ctx = audioCtx;
    if (ctx.state === 'suspended') ctx.resume().catch(() => {});
    const t0 = ctx.currentTime;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(880, t0);
    osc.frequency.exponentialRampToValueAtTime(1320, t0 + 0.12);
    gain.gain.setValueAtTime(0.0001, t0);
    gain.gain.exponentialRampToValueAtTime(0.22, t0 + 0.012);
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.38);
    osc.connect(gain).connect(ctx.destination);
    osc.start(t0);
    osc.stop(t0 + 0.42);
  } catch { /* 播放失败不影响提醒展示 */ }
}

document.addEventListener('pointerdown', unlockAudio, { once: true, capture: true });
document.addEventListener('keydown', unlockAudio, { once: true, capture: true });

/* ========================================================================== *
 * 统一请求封装 api(path, opts)
 * ========================================================================== */

/** 把错误响应变成一句能看懂的中文 */
async function readError(res) {
  let detail = '';
  try {
    const text = await res.text();
    if (text) {
      try {
        const data = JSON.parse(text);
        const raw = data.message ?? data.error ?? data.detail ?? (typeof data === 'string' ? data : '');
        detail = typeof raw === 'string' ? raw : JSON.stringify(raw);
      } catch {
        detail = text.slice(0, 200);
      }
    }
  } catch { /* 读不到正文就算了 */ }

  const hints = {
    400: '请求参数有问题',
    401: '没有访问权限，可能是缺少或填错了 token（在地址后加 ?token=… 再打开一次）',
    403: '服务器拒绝了这次访问',
    404: '接口不存在，或者服务端版本不匹配',
    405: '这个接口不接受当前的请求方式',
    409: '状态冲突，刷新一下再试',
    413: '内容太长了，删减一些再试',
    422: '服务器没通过内容校验',
    429: '请求太频繁了，歇一会儿再试',
    500: '服务器内部出错了',
    502: '网关出错了',
    503: '服务暂时不可用',
    504: '网关超时了',
  };
  const hint = hints[res.status] || (res.status >= 500 ? '服务器开小差了' : '请求失败');
  const tail = detail ? `：${String(detail).trim()}` : '';
  return `${hint}（HTTP ${res.status}）${tail}`;
}

/**
 * 所有 API 请求的唯一入口。
 * @param {string} path   以 '/' 开头，拼在 /whale-mobile/api 之后
 * @param {{method?:string, body?:any, headers?:Record<string,string>,
 *          signal?:AbortSignal, raw?:boolean}} [opts]
 *        raw = true 时返回原始 Response（用于 SSE 流）
 */
async function api(path, opts = {}) {
  const { method = 'GET', body, headers = {}, signal, raw = false } = opts;
  const url = API_BASE + path;

  const init = {
    method,
    headers: { Accept: 'application/json', ...headers },
    credentials: 'same-origin', // 同源 cookie 也一并带上，服务端用哪种鉴权都行
    cache: 'no-store',
    signal,
  };
  if (signal) init.signal = signal;

  const token = getToken();
  if (token) init.headers.Authorization = `Bearer ${token}`;

  if (body !== undefined && body !== null) {
    init.headers['Content-Type'] = 'application/json; charset=utf-8';
    init.body = JSON.stringify(body);
  }

  let res;
  try {
    res = await fetch(url, init);
  } catch (err) {
    if (err && err.name === 'AbortError') throw err; // 主动中断，交给上层处理
    markConn('fail');
    throw new ApiError('网络似乎断了，本鱼联系不上服务器……检查下网络，或者服务有没有开着？', { cause: err });
  }

  if (!res.ok) {
    markConn('fail');
    throw new ApiError(await readError(res), { status: res.status });
  }

  markConn('ok');

  if (raw) return res;
  if (res.status === 204) return null;

  const text = await res.text();
  if (!text) return null;

  const type = res.headers.get('content-type') || '';
  if (type.includes('json') || /^[\s]*[[{"]/.test(text)) {
    try { return JSON.parse(text); } catch { /* 落到下面按纯文本处理 */ }
  }
  return { text };
}

/* ========================================================================== *
 * SSE 解析器（核心：按 buffer 边界切块，容忍任意拆分）
 * ========================================================================== */

/**
 * @param {(event: any) => void} onEvent 收到一个完整事件后的回调（已 JSON.parse）
 * @returns {{push: (chunk: string) => void, flush: () => void}}
 */
function createSSEParser(onEvent) {
  let buffer = '';

  /** 找 buffer 里最早出现的空行边界，兼容 \r\n\r\n / \n\n / \r\r */
  function findBoundary(s) {
    const marks = [['\r\n\r\n', 4], ['\n\n', 2], ['\r\r', 2]];
    let pos = -1;
    let len = 0;
    for (const [mark, size] of marks) {
      const i = s.indexOf(mark);
      if (i !== -1 && (pos === -1 || i < pos)) {
        pos = i;
        len = size;
      }
    }
    return pos === -1 ? null : { pos, len };
  }

  /** 解析一个完整事件块：取出所有 data: 行，拼起来当 JSON */
  function handleBlock(block) {
    if (!block) return;
    const dataLines = [];
    for (const line of block.split(/\r\n|\n|\r/)) {
      if (!line || line.startsWith(':')) continue; // 空行 / 注释 / 心跳
      const idx = line.indexOf(':');
      const field = idx === -1 ? line : line.slice(0, idx);
      let value = idx === -1 ? '' : line.slice(idx + 1);
      if (value.startsWith(' ')) value = value.slice(1); // 规范允许冒号后一个空格
      if (field === 'data') dataLines.push(value);
      // event: / id: / retry: 本原型用不上，忽略
    }
    if (!dataLines.length) return;

    const payload = dataLines.join('\n');
    if (payload === '[DONE]') {
      onEvent({ type: 'done', text: '' });
      return;
    }
    try {
      onEvent(JSON.parse(payload));
    } catch {
      // 不是 JSON（例如服务端心跳写成了 data: ping），忽略即可，别打断正常流程
      console.warn('[sse] 忽略非 JSON 数据块：', payload.slice(0, 120));
    }
  }

  return {
    push(chunk) {
      if (!chunk) return;
      buffer += chunk;
      let boundary = findBoundary(buffer);
      while (boundary) {
        const block = buffer.slice(0, boundary.pos);
        buffer = buffer.slice(boundary.pos + boundary.len);
        handleBlock(block);
        boundary = findBoundary(buffer);
      }
    },
    flush() {
      // 流结束：把没带结尾空行的最后一条也解析掉
      const rest = buffer;
      buffer = '';
      if (rest.trim()) handleBlock(rest);
    },
  };
}

/** 读一个 SSE Response，逐块喂给解析器 */
async function consumeStream(res, onEvent) {
  const parser = createSSEParser(onEvent);

  // 极少数环境拿不到 body 流：退化成「整段读完再解析」，结果一样
  if (!res.body || typeof res.body.getReader !== 'function') {
    parser.push(await res.text());
    parser.flush();
    return;
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder('utf-8');
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      // stream:true：多字节 UTF-8（中文）横跨两个 chunk 时也能正确解码
      parser.push(decoder.decode(value, { stream: true }));
    }
    parser.push(decoder.decode());
  } finally {
    parser.flush();
    try { reader.releaseLock(); } catch { /* 忽略 */ }
  }
}

/* ========================================================================== *
 * 滚动 / 消息 DOM 小工具
 * ========================================================================== */

const mainEl = $('#main');

function isNearBottom() {
  return mainEl.scrollHeight - mainEl.scrollTop - mainEl.clientHeight < 160;
}

function scrollToBottom(force = false) {
  if (!force && !isNearBottom()) return;
  requestAnimationFrame(() => {
    mainEl.scrollTop = mainEl.scrollHeight;
  });
}

/* ========================================================================== *
 * 1. 聊天
 * ========================================================================== */

const chat = {
  conversationId: null,
  streaming: false,
  abort: null,
};

/** 往聊天区加一条消息气泡，返回可更新的引用 */
function addMessage(role, text = '') {
  const list = $('#chatList');
  const wrap = el('div', `msg msg--${role}`);
  const bubble = el('div', 'msg__bubble');
  const textNode = el('span', 'msg__text', text);
  bubble.append(textNode);
  wrap.append(bubble);
  list.append(wrap);

  const item = { wrap, bubble, textNode, typing: null };

  // 清掉「还没有消息」之类的占位提示
  const placeholder = list.querySelector('.msg--placeholder');
  if (placeholder) placeholder.remove();

  scrollToBottom();
  return item;
}

/** 三点等待动画 */
function setTyping(item, on) {
  if (on) {
    if (item.typing) return;
    const box = el('span', 'typing');
    box.setAttribute('aria-label', '大肥鱼正在写');
    box.append(el('i'), el('i'), el('i'));
    item.bubble.append(box);
    item.typing = box;
  } else if (item.typing) {
    item.typing.remove();
    item.typing = null;
  }
}

/** 系统提示（灰色居中）或错误提示（红色） */
function addSystem(text, isError = false) {
  const list = $('#chatList');
  const wrap = el('div', 'msg msg--system' + (isError ? ' msg--error' : ''));
  const bubble = el('div', 'msg__bubble', text);
  if (isError) bubble.setAttribute('role', 'alert');
  wrap.append(bubble);
  list.append(wrap);
  scrollToBottom();
}

function updateChatUi() {
  const send = $('#chatSend');
  const hint = $('#chatHint');
  send.disabled = chat.streaming;
  send.textContent = chat.streaming ? '…' : '发送';
  $('#chatList').setAttribute('aria-busy', chat.streaming ? 'true' : 'false');

  if (chat.streaming) {
    hint.textContent = '本鱼正在写，等它嚼完…';
  } else if (chat.conversationId) {
    hint.textContent = `这段对话已记住（conversationId: ${String(chat.conversationId).slice(0, 12)}…）`;
  } else {
    hint.textContent = '还没开始聊，说点什么吧';
  }
}

function autoGrow(node) {
  node.style.height = 'auto';
  node.style.height = `${Math.min(node.scrollHeight, 120)}px`;
}

async function sendChat() {
  if (chat.streaming) return;
  const input = $('#chatInput');
  const text = input.value.trim();
  if (!text) return;

  input.value = '';
  autoGrow(input);

  addMessage('user', text);
  const reply = addMessage('assistant', '');
  setTyping(reply, true);

  chat.streaming = true;
  const controller = new AbortController();
  chat.abort = controller;
  updateChatUi();
  scrollToBottom(true);

  let streamed = '';
  let finished = false;
  let failed = false;

  try {
    const res = await api('/chat/stream', {
      method: 'POST',
      // 约定字段：text + conversationId（首次 conversationId 为 null）；done 事件会回填新的 conversationId
      body: { text, conversationId: chat.conversationId },
      headers: { Accept: 'text/event-stream' },
      raw: true,
      signal: controller.signal,
    });

    await consumeStream(res, (evt) => {
      if (!evt || typeof evt !== 'object') return;

      if (evt.type === 'delta') {
        const piece = typeof evt.text === 'string' ? evt.text : '';
        if (!piece) return;
        streamed += piece;
        setTyping(reply, false);
        reply.textNode.textContent = streamed;
        scrollToBottom();
        return;
      }

      if (evt.type === 'done') {
        finished = true;
        if (evt.conversationId !== undefined && evt.conversationId !== null) {
          chat.conversationId = evt.conversationId;
          updateChatUi();
        }
        if (!streamed && typeof evt.text === 'string') streamed = evt.text;
        if (streamed) {
          setTyping(reply, false);
          reply.textNode.textContent = streamed;
          speak(streamed);
          showPetBubble('本鱼说完了，吃口白饭先');
        }
        return;
      }

      if (evt.type === 'error') {
        failed = true;
        addSystem(`❌ ${evt.message || '服务器说出了问题'}`, true);
      }
      // 其它未知类型忽略
    });

    if (!finished && !failed && !streamed) {
      addSystem('回复好像断掉了，本鱼啥也没吃到……要不要再试一次？', true);
    } else if (!finished && streamed) {
      addSystem('（回答还没说完，连接就断了）', true);
    }
  } catch (err) {
    if (err && err.name === 'AbortError') {
      addSystem('这一轮回答被本鱼一口吞了（已中断）。');
    } else {
      addSystem(`❌ ${err && err.message ? err.message : '发送失败了，再试一次？'}`, true);
    }
  } finally {
    chat.streaming = false;
    chat.abort = null;
    setTyping(reply, false);
    // 一个字的空气泡别留在页面上
    if (!reply.textNode.textContent) reply.wrap.remove();
    updateChatUi();
    scrollToBottom(true);
  }
}

function newChat() {
  if (chat.abort) {
    try { chat.abort.abort(); } catch { /* 忽略 */ }
  }
  chat.conversationId = null;
  $('#chatList').replaceChildren();
  addSystem('开了个新对话：conversationId 已清空，之前的聊天记录本鱼收走了。');
  updateChatUi();
  toast('新对话开始，白饭管够');
}

function setupChat() {
  const form = $('#chatForm');
  const input = $('#chatInput');

  form.addEventListener('submit', (ev) => {
    ev.preventDefault();
    sendChat();
  });

  input.addEventListener('keydown', (ev) => {
    // 输入法组字过程中的 Enter 不算发送
    if (ev.key === 'Enter' && !ev.shiftKey && !ev.isComposing && ev.keyCode !== 229) {
      ev.preventDefault();
      if (typeof form.requestSubmit === 'function') form.requestSubmit();
      else form.dispatchEvent(new Event('submit', { cancelable: true }));
    }
  });

  input.addEventListener('input', () => autoGrow(input));

  $('#newChatBtn').addEventListener('click', newChat);

  const placeholder = el('div', 'msg msg--system msg--placeholder');
  placeholder.append(el('div', 'msg__bubble', '💬 说点什么吧，本鱼在这条小船上等着呢。'));
  $('#chatList').append(placeholder);

  updateChatUi();
}

/* ========================================================================== *
 * 2. 说书
 * ========================================================================== */

const storyState = {
  words: 800,
  loading: false,
  seq: 0, // 请求序号：避免慢请求后到把新结果覆盖掉
};

/** 把接口返回揉成 { id, title, content, words, createdAt } */
function normalizeStory(data) {
  const root = data && typeof data === 'object' ? data : {};
  const inner = root.story && typeof root.story === 'object' ? root.story : {};
  const plainText = typeof root.story === 'string' ? root.story : '';
  const content =
    root.content ?? root.body ?? root.text ?? root.storyText ??
    inner.content ?? inner.body ?? inner.text ??
    plainText ?? '';

  return {
    id: String(root.id ?? root.storyId ?? inner.id ?? ''),
    title: String(root.title ?? inner.title ?? '无题（本鱼懒得取名）'),
    content: String(content || ''),
    words: Number(root.words ?? root.wordCount ?? inner.words ?? 0) || 0,
    createdAt: String(root.createdAt ?? root.created_at ?? inner.createdAt ?? ''),
  };
}

/** 兼容 [] / {stories:[]} / {items:[]} / {data:{stories:[]}} 几种常见形状 */
function normalizeList(data, keys) {
  if (Array.isArray(data)) return data;
  if (data && typeof data === 'object') {
    for (const key of keys) {
      if (Array.isArray(data[key])) return data[key];
    }
    if (data.data && typeof data.data === 'object') {
      for (const key of keys) {
        if (Array.isArray(data.data[key])) return data.data[key];
      }
    }
  }
  return [];
}

function renderStory(story) {
  $('#storyTitle').textContent = story.title || '无题';
  const plain = story.content.replace(/\s+/g, '');
  const parts = [];
  if (story.requested) parts.push(`要求 ${story.requested} 字`);
  parts.push(`实际 ${plain.length} 字`);
  $('#storyMeta').textContent = parts.join(' · ');
  $('#storyBody').textContent = story.content;
  $('#storyResult').hidden = false;
  $('#storyResult').scrollIntoView({ block: 'start', behavior: 'smooth' });
  // 说书也念：先念开头 300 字，想听全文点「朗读」
  if (voiceOn) speak(story.content);
}

async function createStory() {
  if (storyState.loading) return;
  storyState.loading = true;

  const go = $('#storyGo');
  go.disabled = true;
  go.textContent = '憋着呢…';
  $('#storyResult').hidden = true;
  $('#storyLoading').hidden = false;
  scrollToBottom(true);

  try {
    const data = await api('/story', {
      method: 'POST',
      body: { topic: $('#storyTopic').value.trim(), words: storyState.words },
    });
    const story = normalizeStory(data);
    if (!story.content) throw new ApiError('服务器没返回正文（字段名可能不一样），故事没憋出来……');
    story.requested = storyState.words;
    renderStory(story);
    loadStories({ silent: true });
    toast('故事憋出来了！');
  } catch (err) {
    toast(err && err.message ? err.message : '讲故事失败了', 'error');
  } finally {
    storyState.loading = false;
    go.disabled = false;
    go.textContent = '讲一个';
    $('#storyLoading').hidden = true;
  }
}

function formatDateTime(ts) {
  // 兼容三种输入：毫秒数、纯数字字符串、ISO/日期字符串
  const numeric = typeof ts === 'number' ? ts : /^\d{10,}$/.test(String(ts ?? '')) ? Number(ts) : NaN;
  const d = new Date(Number.isFinite(numeric) ? numeric : ts);
  if (Number.isNaN(d.getTime())) return '时间不明';
  const pad = (n) => String(n).padStart(2, '0');
  const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const now = new Date();
  if (d.toDateString() === now.toDateString()) return `今天 ${hm}`;
  const year = d.getFullYear() === now.getFullYear() ? '' : `${d.getFullYear()}-`;
  return `${year}${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${hm}`;
}

function renderStoryList(items) {
  const list = $('#storyList');
  const empty = $('#storyEmpty');
  list.replaceChildren();

  if (!items.length) {
    empty.hidden = false;
    return;
  }
  empty.hidden = true;

  const frag = document.createDocumentFragment();
  items.forEach((raw, index) => {
    const story = normalizeStory(raw);
    const bodyId = `story-body-${story.id || `i${index}`}`;

    const li = el('li', 'list__item');

    const row = el('button', 'list__row');
    row.type = 'button';
    row.setAttribute('aria-expanded', 'false');
    row.setAttribute('aria-controls', bodyId);
    row.setAttribute('aria-label', `展开或收起故事：${story.title}`);

    const main = el('span', 'list__main');
    main.append(el('span', 'list__title', story.title));
    const metaParts = [];
    if (story.words) metaParts.push(`${story.words} 字`);
    if (story.createdAt) metaParts.push(formatDateTime(story.createdAt));
    main.append(el('span', 'list__meta', metaParts.join(' · ') || '（没有更多信息）'));

    const chev = el('span', 'list__chev');
    chev.setAttribute('aria-hidden', 'true');
    chev.textContent = '▾';

    row.append(main, chev);

    const body = el('div', 'list__body');
    body.id = bodyId;
    body.hidden = true;

    // 列表里已经带正文就不必再请求详情
    if (story.content) {
      body.textContent = story.content;
      body.dataset.loaded = '1';
    }

    row.addEventListener('click', () => toggleStory({ row, body, id: story.id, title: story.title }));
    li.append(row, body);
    frag.append(li);
  });

  list.append(frag);
}

async function toggleStory({ row, body, id, title }) {
  const open = row.getAttribute('aria-expanded') === 'true';
  if (open) {
    row.setAttribute('aria-expanded', 'false');
    body.hidden = true;
    return;
  }

  row.setAttribute('aria-expanded', 'true');
  body.hidden = false;

  if (body.dataset.loaded === '1') return;
  if (!id) {
    body.textContent = '❌ 这条历史没有 id，拿不到详情。';
    return;
  }

  body.textContent = '本鱼去翻书柜…';
  try {
    const data = await api(`/stories/${encodeURIComponent(id)}`);
    const story = normalizeStory(data);
    body.textContent = story.content || '详情里没有正文。';
    body.dataset.loaded = '1';
  } catch (err) {
    body.textContent = `❌ ${err && err.message ? err.message : '详情没拿到'}`;
  }
}

async function loadStories({ silent = false } = {}) {
  const seq = ++storyState.seq;
  const list = $('#storyList');
  const empty = $('#storyEmpty');

  if (!silent) {
    empty.hidden = true;
    list.replaceChildren();
    const li = el('li', 'list__item');
    li.append(el('p', 'list__meta', '加载历史故事…'));
    list.append(li);
  }

  try {
    const data = await api('/stories');
    if (seq !== storyState.seq) return; // 有更新的请求了，丢弃这次结果
    renderStoryList(normalizeList(data, ['stories', 'items', 'list']));
  } catch (err) {
    if (seq !== storyState.seq) return;
    list.replaceChildren();
    empty.hidden = true;
    const li = el('li', 'list__item');
    li.append(el('p', 'list__error', `❌ 历史故事没取到：${err && err.message ? err.message : '未知错误'}`));
    list.append(li);
  }
}

/* ========================================================================== *
 * 文化：说书 / 念诗 / 典故 / 成语 / 民间故事 / 对联 / 今日
 * 数据全部来自插件自身的 HTTP 接口（与桌面端同一套）
 * ========================================================================== */

async function cw(path) {
  const res = await fetch('/api/chubby-whale' + path, { headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(String(res.status));
  return res.json();
}
const cultureState = { kind: 'book', lastCouplet: '' };
let duilianCache = null;

function showCulturePane(kind) {
  const panes = { book: '#pane-book', daily: '#pane-daily' };
  const itemPane = $('#pane-item');
  if (kind === 'book') {
    $('#pane-book').hidden = false;
    itemPane.hidden = true;
    $('#pane-daily').hidden = true;
    return;
  }
  if (kind === 'daily') {
    $('#pane-book').hidden = true;
    itemPane.hidden = true;
    $('#pane-daily').hidden = false;
    return;
  }
  $('#pane-book').hidden = true;
  $('#pane-daily').hidden = true;
  itemPane.hidden = false;
}

function setCultureChip(kind) {
  $$('#cultureChips .chip').forEach((c) => {
    c.setAttribute('aria-selected', c.dataset.kind === kind ? 'true' : 'false');
  });
  cultureState.kind = kind;
  showCulturePane(kind);
}

async function loadBooks() {
  const sel = $('#bookSelect');
  if (!sel || sel.options.length > 0) return;
  try {
    const d = await cw('/story/books');
    const books = (d && d.books) || [];
    sel.replaceChildren();
    for (const b of books) {
      const o = document.createElement('option');
      o.value = b;
      o.textContent = b;
      sel.append(o);
    }
  } catch (err) {
    toast('书单加载失败：' + (err && err.message ? err.message : '网络错误'), 'error');
  }
}

function renderBookPiece(d) {
  if (!d || !d.ok) {
    toast('这一段没讲出来：' + ((d && d.error) || '未知错误'), 'error');
    return;
  }
  $('#bookText').textContent = d.text || '';
  $('#bookMeta').textContent = `${d.book || ''} · ${d.title || ''} · 第 ${d.piece || 1}/${d.total || '?'} 段`;
  $('#bookNext').disabled = !!d.isLast;
  if (voiceOn) speak(d.text || '');
}

async function bookStart() {
  const book = $('#bookSelect') && $('#bookSelect').value;
  if (!book) return;
  const btn = $('#bookStart');
  btn.disabled = true;
  btn.textContent = '讲着呢…';
  try {
    renderBookPiece(await cw(`/story/start?book=${encodeURIComponent(book)}`));
  } catch (err) {
    toast('说书失败：' + (err && err.message ? err.message : '网络错误'), 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = '开始讲';
  }
}

async function bookNext() {
  const btn = $('#bookNext');
  btn.disabled = true;
  try {
    renderBookPiece(await cw('/story/next'));
  } catch (err) {
    toast('下一段失败：' + (err && err.message ? err.message : '网络错误'), 'error');
  }
}

function renderItem(title, meta, text) {
  $('#itemTitle').textContent = title || '无题';
  $('#itemMeta').textContent = meta || '';
  $('#itemText').textContent = text || '';
  if (voiceOn) speak(text || '');
}

async function loadDuilian() {
  if (duilianCache) return duilianCache;
  try {
    const res = await fetch('duilian.json', { cache: 'force-cache' });
    if (!res.ok) throw new Error(String(res.status));
    const data = await res.json();
    duilianCache = Array.isArray(data && data.items) ? data.items : [];
  } catch {
    duilianCache = [];
  }
  return duilianCache;
}

async function pickCouplet() {
  const items = await loadDuilian();
  if (!items.length) {
    renderItem('对联', '', '对联库没加载出来……');
    return;
  }
  let pick = items[Math.floor(Math.random() * items.length)];
  for (let i = 0; i < 5 && items.length > 1 && pick.upper === cultureState.lastCouplet; i++) {
    pick = items[Math.floor(Math.random() * items.length)];
  }
  cultureState.lastCouplet = pick.upper;
  const meta = [pick.cat, pick.source].filter(Boolean).join(' · ');
  renderItem('对联', meta, `${pick.upper}\n${pick.lower}`);
}

async function loadCultureItem(kind) {
  try {
    if (kind === 'poem') {
      const d = await cw('/poem');
      const it = (d && d.item) || {};
      renderItem(`${it.title || '无题'}${it.author ? ' · ' + it.author : ''}`, it.dynasty || '', it.text || '');
      return;
    }
    if (kind === 'couplet') {
      await pickCouplet();
      return;
    }
    const d = await cw(`/culture?type=${encodeURIComponent(kind)}`);
    const it = (d && d.item) || {};
    if (!d || !d.ok || !it.title) {
      renderItem('没有内容', '', '这一类暂时没取到，换个类别试试。');
      return;
    }
    renderItem(it.title, it.src || '', it.text || '');
  } catch (err) {
    toast('加载失败：' + (err && err.message ? err.message : '网络错误'), 'error');
  }
}

async function loadDaily() {
  try {
    const d = await cw('/daily');
    const mk = d && d.ok ? `${d.date || ''}${d.source ? ' · ' + d.source : ''}` : '';
    $('#dailyMeta').textContent = mk;
    $('#dailyText').textContent = (d && d.text) || '今日一句没取到';
  } catch {
    $('#dailyText').textContent = '今日一句没取到';
  }
  try {
    const b = await cw('/briefing');
    $('#briefingText').textContent = (b && b.text) || '';
  } catch {
    $('#briefingText').textContent = '';
  }
}

function setupCulture() {
  const chips = $('#cultureChips');
  if (!chips) return;
  chips.addEventListener('click', (ev) => {
    const chip = ev.target.closest('.chip');
    if (!chip) return;
    const kind = chip.dataset.kind;
    setCultureChip(kind);
    if (kind === 'book') loadBooks();
    else if (kind === 'daily') loadDaily();
    else loadCultureItem(kind);
  });

  $('#bookStart')?.addEventListener('click', bookStart);
  $('#bookNext')?.addEventListener('click', bookNext);
  $('#bookSpeak')?.addEventListener('click', () => speak($('#bookText')?.textContent || ''));
  $('#bookStop')?.addEventListener('click', () => stopSpeak());

  $('#itemAgain')?.addEventListener('click', () => {
    const kind = cultureState.kind;
    if (kind === 'book' || kind === 'daily') return;
    loadCultureItem(kind);
  });
  $('#itemSpeak')?.addEventListener('click', () => {
    const t = `${$('#itemTitle')?.textContent || ''}。${$('#itemText')?.textContent || ''}`;
    speak(t);
  });
  $('#itemStop')?.addEventListener('click', () => stopSpeak());

  $('#dailySpeak')?.addEventListener('click', () => {
    const t = `${$('#dailyText')?.textContent || ''}。${$('#briefingText')?.textContent || ''}`;
    speak(t);
  });
  $('#dailyStop')?.addEventListener('click', () => stopSpeak());
  $('#dailyReload')?.addEventListener('click', loadDaily);

  setCultureChip('book');
  loadBooks();
}
function setupStory() {
  const form = $('#storyForm');
  form.addEventListener('submit', (ev) => {
    ev.preventDefault();
    createStory();
  });

  const seg = $('#storyWords');
  seg.addEventListener('click', (ev) => {
    const btn = ev.target.closest('button.seg__btn');
    if (!btn) return;
    storyState.words = Number(btn.dataset.words) || 800;
    $$('.seg__btn', seg).forEach((b) => {
      b.setAttribute('aria-checked', b === btn ? 'true' : 'false');
    });
  });

  $('#storyReload').addEventListener('click', () => loadStories());
  $('#storySpeak')?.addEventListener('click', () => {
    const text = $('#storyBody')?.textContent || '';
    if (!text.trim()) return;
    if (!voiceOn) {
      toast('语音开关是关的，先点上面的 🔊 语音开');
      return;
    }
    speak(text);
  });
  $('#storyStop')?.addEventListener('click', () => stopSpeak());
  loadStories({ silent: true });
}

/* ========================================================================== *
 * 3. 提醒
 * ========================================================================== */

const remindState = {
  quickSec: DEFAULT_QUICK_SEC,
  customMode: false,
  submitting: false,
  items: [],
};

/** 各种时间字段都认：ISO 字符串 / 秒 / 毫秒 */
function parseTime(value) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value < 1e12 ? value * 1000 : value;
  }
  if (typeof value === 'string' && value.trim()) {
    const str = value.trim();
    if (/^\d+$/.test(str)) {
      const n = Number(str);
      return n < 1e12 ? n * 1000 : n;
    }
    const t = Date.parse(str);
    if (Number.isFinite(t)) return t;
  }
  return null;
}

/** 推断这条提醒的触发时刻（毫秒） */
function reminderTarget(item) {
  const direct = [item.fireAt, item.at, item.dueAt, item.remindAt, item.triggerAt, item.when, item.time];
  for (const value of direct) {
    const t = parseTime(value);
    if (t) return t;
  }
  // 服务器只给 createdAt + inSeconds 的情况
  const base = parseTime(item.createdAt ?? item.created_at ?? item.createTime);
  const sec = Number(item.inSeconds ?? item.seconds ?? item.delaySeconds);
  if (base && Number.isFinite(sec)) return base + sec * 1000;
  // 或者直接给「还剩几秒」
  const remain = Number(item.remainingSeconds ?? item.remaining ?? item.leftSeconds);
  if (Number.isFinite(remain)) return Date.now() + remain * 1000;
  return null;
}

function formatRemain(ms) {
  if (!Number.isFinite(ms)) return '';
  const total = Math.max(0, Math.floor(ms / 1000));
  const days = Math.floor(total / 86400);
  const hours = Math.floor((total % 86400) / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  if (days > 0) return `${days}天${hours}小时`;
  if (hours > 0) return `${hours}小时${minutes}分`;
  if (minutes > 0) return `${minutes}分${secs}秒`;
  return `${secs}秒`;
}

function pad2(n) {
  return String(n).padStart(2, '0');
}

/** datetime-local 需要的本地时间字符串 */
function localInputValue(ts) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}T${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

function tickReminders() {
  const now = Date.now();
  for (const node of $$('.rem[data-target]', $('#remindList'))) {
    const target = Number(node.dataset.target);
    const out = node.querySelector('.rem__count');
    if (!out || !Number.isFinite(target)) continue;

    const left = target - now;
    if (left <= 0) {
      out.textContent = '已到点';
      node.dataset.state = 'due';
    } else {
      out.textContent = `还有 ${formatRemain(left)}`;
      if (node.dataset.state === 'due') delete node.dataset.state;
    }
  }
}

let countdownTimer = null;
function startCountdown() {
  if (countdownTimer) return;
  countdownTimer = setInterval(tickReminders, 1000); // 每秒刷新剩余时间
}

function resetCancel(btn, label) {
  btn.dataset.confirm = '0';
  btn.textContent = '取消';
  if (label) btn.setAttribute('aria-label', `取消提醒：${label}`);
}

async function cancelReminder(id, text) {
  try {
    await api(`/reminders/${encodeURIComponent(id)}`, { method: 'DELETE' });
    toast(`取消了：${text}`);
    await loadReminders({ silent: true });
  } catch (err) {
    toast(err && err.message ? err.message : '取消失败了', 'error');
  }
}

/**
 * 取消提醒：不用 confirm 阻塞对话框，改成「二次点击确认」。
 * 第一次点击进入待确认态（4 秒后自动回退），第二次点击才真的发 DELETE。
 */
function handleCancelClick(btn, id, text) {
  if (!id) {
    toast('这条提醒没有 id，删不掉……', 'error');
    return;
  }
  if (btn.dataset.confirm !== '1') {
    btn.dataset.confirm = '1';
    btn.textContent = '再点一次';
    btn.setAttribute('aria-label', `再点一次确认取消提醒：${text}`);
    setTimeout(() => {
      if (btn.isConnected) resetCancel(btn, text);
    }, 4000);
    toast('再点一次就取消这条提醒');
    return;
  }
  btn.dataset.confirm = '0';
  btn.textContent = '取消中…';
  btn.disabled = true;
  cancelReminder(id, text);
}

function renderReminders(items) {
  const list = $('#remindList');
  const empty = $('#remindEmpty');
  list.replaceChildren();
  remindState.items = items;

  if (!items.length) {
    empty.hidden = false;
    return;
  }
  empty.hidden = true;

  const frag = document.createDocumentFragment();
  for (const item of items) {
    const id = item && item.id !== undefined && item.id !== null ? String(item.id) : '';
    const text = String(
      (item && (item.text ?? item.title ?? item.content ?? item.message)) ?? '（没有内容）',
    );
    const target = reminderTarget(item || {});

    const li = el('li', 'rem');
    if (id) li.dataset.id = id;
    if (target) li.dataset.target = String(target);

    const body = el('div', 'rem__body');
    body.append(el('p', 'rem__text', text));

    const meta = el('p', 'rem__meta');
    meta.append(el('span', 'rem__time', target ? formatDateTime(target) : '时间不明'));
    if (target) meta.append(el('span', 'rem__count', `还有 ${formatRemain(target - Date.now())}`));
    body.append(meta);

    const cancel = el('button', 'btn btn--ghost rem__cancel', '取消');
    cancel.type = 'button';
    cancel.dataset.confirm = '0';
    cancel.setAttribute('aria-label', `取消提醒：${text}`);
    cancel.addEventListener('click', () => handleCancelClick(cancel, id, text));

    li.append(body, cancel);
    frag.append(li);
  }

  list.append(frag);
  tickReminders();
}

async function loadReminders({ silent = false } = {}) {
  const list = $('#remindList');
  const empty = $('#remindEmpty');

  if (!silent) {
    empty.hidden = true;
    list.replaceChildren();
    const li = el('li', 'list__item');
    li.append(el('p', 'list__meta', '加载提醒…'));
    list.append(li);
  }

  try {
    const data = await api('/reminders');
    renderReminders(normalizeList(data, ['reminders', 'items', 'list']));
  } catch (err) {
    list.replaceChildren();
    empty.hidden = true;
    const li = el('li', 'list__item');
    li.append(el('p', 'list__error', `❌ 提醒没取到：${err && err.message ? err.message : '未知错误'}`));
    list.append(li);
  }
}

async function createReminder() {
  if (remindState.submitting) return;

  const input = $('#remindText');
  const text = input.value.trim();
  if (!text) {
    toast('先写点要提醒什么呀', 'error');
    input.focus();
    return;
  }

  let body;
  if (remindState.customMode) {
    const value = $('#remindAt').value;
    if (!value) {
      toast('还没选时间呢', 'error');
      $('#remindAt').focus();
      return;
    }
    const ts = new Date(value).getTime();
    if (!Number.isFinite(ts)) {
      toast('这个时间看不懂，换一个试试', 'error');
      return;
    }
    if (ts <= Date.now() + 1000) {
      toast('时间得在未来呀', 'error');
      return;
    }
    // 自定义时间：字段为 at（ISO 字符串）
    body = { text, at: new Date(ts).toISOString() };
  } else {
    // 快捷时间：字段为 inSeconds
    body = { text, inSeconds: remindState.quickSec };
  }

  remindState.submitting = true;
  const go = $('#remindGo');
  go.disabled = true;
  go.textContent = '本鱼记着呢…';

  try {
    await api('/reminders', { method: 'POST', body });
    input.value = '';
    toast('记下了！到点本鱼会喊你');
    await loadReminders({ silent: true });
  } catch (err) {
    toast(err && err.message ? err.message : '提醒没设上', 'error');
  } finally {
    remindState.submitting = false;
    go.disabled = false;
    go.textContent = '设个提醒';
  }
}

function setupReminders() {
  const chips = $('#remindQuick');
  const customWrap = $('#customWrap');
  const atInput = $('#remindAt');

  chips.addEventListener('click', (ev) => {
    const btn = ev.target.closest('button.chip');
    if (!btn) return;

    if (btn.dataset.custom) {
      remindState.customMode = true;
      customWrap.hidden = false;
      atInput.min = localInputValue(Date.now() + 60 * 1000);
      if (!atInput.value) atInput.value = localInputValue(Date.now() + DEFAULT_QUICK_SEC * 1000);
    } else {
      remindState.customMode = false;
      remindState.quickSec = Number(btn.dataset.sec) || DEFAULT_QUICK_SEC;
      customWrap.hidden = true;
    }

    $$('button.chip', chips).forEach((b) => {
      b.setAttribute('aria-pressed', b === btn ? 'true' : 'false');
    });
    // 选了「自定义」后，时间输入框一出来就把焦点送过去
    if (remindState.customMode) atInput.focus({ preventScroll: true });
  });

  // 兜底：万一服务器回传的 fireAt 已过，至少把 min 卡在当前时间之后
  atInput.addEventListener('focus', () => {
    atInput.min = localInputValue(Date.now() + 60 * 1000);
  });

  $('#remindForm').addEventListener('submit', (ev) => {
    ev.preventDefault();
    createReminder();
  });

  $('#remindReload').addEventListener('click', () => loadReminders());

  loadReminders({ silent: true });
  startCountdown();
}

/* ========================================================================== *
 * 4. 提醒事件流（SSE）：GET /whale-mobile/api/events
 * ========================================================================== */

let eventsCtrl = null;
let eventsRunning = false;

/**
 * 用 fetch + 流读取订阅事件（而不是 EventSource）：
 * 这样能带上 Authorization 头，也不用把 token 塞进 URL 查询串。
 * 断线后按 1s→5s 退避重连，页面在后台也会继续挂着。
 */
async function runEvents(signal) {
  let attempt = 0;

  while (!signal.aborted) {
    try {
      const res = await api('/events', {
        raw: true,
        headers: { Accept: 'text/event-stream' },
        signal,
      });
      attempt = 0;

      await consumeStream(res, (evt) => {
        if (!evt || typeof evt !== 'object') return;

        if (evt.type === 'reminder') {
          const text = String(evt.text ?? evt.message ?? '有提醒到点了');
          toast(`⏰ ${text}`, 'info', 6000);
          playBeep();
          try { navigator.vibrate?.(200); } catch { /* 不支持震动就算了 */ }
          loadReminders({ silent: true }); // 到点后列表可能变化，顺手刷新
          return;
        }

        if (evt.type === 'error') {
          toast(`提醒通道出问题：${evt.message || '未知错误'}`, 'error');
        }
      });
    } catch (err) {
      if (signal.aborted) return;
      // 鉴权/接口不存在这类错误重试也没用，直接停下，别一直捶服务器
      const fatal = err instanceof ApiError && [401, 403, 404, 405].includes(err.status);
      if (fatal) {
        toast(`提醒通道连不上：${err.message}`, 'error', 8000);
        return;
      }
      // 连不上/断了：下面统一退避重连，不刷屏报错
      console.warn('[events] 连接中断，准备重连：', err && err.message);
    }

    if (signal.aborted) return;
    attempt = Math.min(attempt + 1, 5);
    const wait = attempt * 1000 + Math.floor(Math.random() * 400);
    await sleep(navigator.onLine === false ? 3000 : wait);
  }
}

function startEvents() {
  if (eventsRunning || typeof AbortController === 'undefined') return;
  eventsRunning = true;
  eventsCtrl = new AbortController();
  const ctrl = eventsCtrl;
  runEvents(ctrl.signal).finally(() => {
    if (eventsCtrl === ctrl) {
      eventsRunning = false;
      eventsCtrl = null;
    }
  });
}

function stopEvents() {
  if (!eventsCtrl) return;
  try { eventsCtrl.abort(); } catch { /* 忽略 */ }
}

/* ========================================================================== *
 * 5. Tab 切换
 * ========================================================================== */

function switchTab(name, { focus = false, initial = false } = {}) {
  const target = TABS.includes(name) ? name : 'chat';

  $$('.tab').forEach((btn) => {
    const on = btn.dataset.tab === target;
    btn.setAttribute('aria-selected', on ? 'true' : 'false');
    btn.tabIndex = on ? 0 : -1;
    if (on && focus) btn.focus({ preventScroll: true });
  });

  $$('.panel').forEach((panel) => {
    panel.hidden = panel.id !== `panel-${target}`;
  });

  store.set(TAB_KEY, target);
  mainEl.scrollTop = 0;

  // 用户切 Tab 时补一次数据；首次进入由各模块自己加载，避免重复请求
  if (!initial) {
    if (target === 'story') loadStories({ silent: true });
    if (target === 'remind') loadReminders({ silent: true });
  }
}

function setupTabs() {
  const bar = $('.tabbar');

  bar.addEventListener('click', (ev) => {
    const btn = ev.target.closest('button.tab');
    if (!btn) return;
    switchTab(btn.dataset.tab);
  });

  // 键盘：左右方向键 / Home / End 在 Tab 之间切换（标准 tablist 行为）
  bar.addEventListener('keydown', (ev) => {
    const current = document.activeElement;
    if (!current || !current.classList || !current.classList.contains('tab')) return;
    const index = TABS.indexOf(current.dataset.tab);
    if (index === -1) return;

    let next = null;
    if (ev.key === 'ArrowRight') next = (index + 1) % TABS.length;
    else if (ev.key === 'ArrowLeft') next = (index - 1 + TABS.length) % TABS.length;
    else if (ev.key === 'Home') next = 0;
    else if (ev.key === 'End') next = TABS.length - 1;

    if (next === null) return;
    ev.preventDefault();
    switchTab(TABS[next], { focus: true });
  });
}

/* ========================================================================== *
 * 6. 离线 / 在线
 * ========================================================================== */

function updateOfflineBar() {
  const bar = $('#offlineBar');
  if (!bar) return;
  bar.hidden = navigator.onLine !== false;
}

function setupConnectivity() {
  updateOfflineBar();

  window.addEventListener('online', () => {
    updateOfflineBar();
    toast('网络回来了，本鱼继续干活');
    startEvents();
    loadReminders({ silent: true });
    loadStories({ silent: true });
  });

  window.addEventListener('offline', () => {
    updateOfflineBar();
    stopEvents();
  });

  // 回到前台时刷新一次倒计时/列表，避免休眠后倒计时停住
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    tickReminders();
    loadReminders({ silent: true });
  });
}

/* ========================================================================== *
 * 7. 欢迎面板 / 初始化
 * ========================================================================== */

function setupWelcome() {
  const details = $('#welcome');
  if (!details) return;

  // 记住上次的展开/收起状态；第一次访问保持 HTML 里的 open
  const saved = store.get(WELCOME_KEY);
  if (saved === '0') details.open = false;
  details.addEventListener('toggle', () => {
    store.set(WELCOME_KEY, details.open ? '1' : '0');
  });

  const meta = $('#welcomeMeta');
  if (!meta) return;
  const token = getToken();
  const tokenLine = token
    ? `访问令牌：已保存到本机（localStorage.whale.token），长度 ${token.length}`
    : '访问令牌：还没有。若服务端要求鉴权，请求会返回 401；在地址后加 ?token=… 再打开一次即可。';
  meta.textContent = `${tokenLine}\n接口前缀：${API_BASE}`;
  meta.style.whiteSpace = 'pre-wrap';
}

/** 依赖自述：电脑端 dsh web（硬依赖）+ 伴生桌宠 dsh-chubby-whale（可选） */
async function loadDependencies() {
  const line = $('#depLine');
  if (!line) return;
  try {
    const data = await api('/health');
    const deps = data && data.dependencies ? data.dependencies : {};
    const web = deps.dshWeb && deps.dshWeb.ok ? '在线（这台电脑）' : '未知';
    const cw = deps.chubbyWhale;
    const pet = cw && cw.installed
      ? `已装 v${cw.version || '?'}（桌宠在电脑上）`
      : '未安装（不影响简版）';
    line.textContent = `依赖：电脑端 dsh web ${web} · 伴生桌宠 dsh-chubby-whale ${pet}`;
  } catch {
    line.textContent = '依赖：电脑端 dsh web 失联——本插件是宿主插件，电脑端不跑，这个页面就只剩空壳。';
  }
  line.hidden = false;
  line.style.whiteSpace = 'pre-wrap';
}

let installPrompt = null;
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  installPrompt = e;
});

function setupInstall() {
  const btn = $('#installBtn');
  if (!btn) return;
  btn.addEventListener('click', async () => {
    if (installPrompt) {
      try {
        installPrompt.prompt();
        const res = await installPrompt.userChoice;
        toast(res && res.outcome === 'accepted' ? '好嘞，桌面上见' : '那……想装了再点我');
      } catch { /* 忽略 */ }
      installPrompt = null;
      return;
    }
    toast('点浏览器右上角 ⋮（或分享）→「添加到主屏幕 / 添加到桌面」，桌面上就有本鱼了', 'info', 7000);
  });
}
function init() {
  markConn('idle');

  setupTabs();
  setupWelcome();
  loadDependencies();  // 依赖自述：电脑端 dsh web + 伴生桌宠
  setupChat();
  setupVoice();      // 语音朗读开关（调电脑端 edge-tts）
  setupInstall();    // 添加到桌面引导
  setupMic();        // 语音输入（调电脑端 ASR）
  setupCulture();    // 文化：说书/念诗/典故/成语/民故/对联/今日
  setupReminders();  // 内含提醒列表首屏加载 + 倒计时
  setupConnectivity();
  startEvents();

  // 恢复上次停留的 Tab；initial 模式不再重复拉数据
  const savedTab = store.get(TAB_KEY);
  switchTab(TABS.includes(savedTab) ? savedTab : 'chat', { initial: true });

  console.info('[大肥鱼] 移动端已启动，接口前缀：' + API_BASE);
}

init();

/**
 * 说明：本文件刻意不使用 alert / confirm 这类阻塞对话框。
 *  - 错误提示走 toast 或聊天区红色系统提示；
 *  - 取消提醒用「二次点击确认」（handleCancelClick）。
 */
