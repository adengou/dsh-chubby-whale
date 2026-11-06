(() => {
  // src/shared/immutable.ts
  function deepFreeze(value) {
    if (value === null || typeof value !== "object") return value;
    const obj = value;
    if (Object.isFrozen(obj)) return value;
    Object.freeze(obj);
    if (Array.isArray(obj)) {
      for (const v of obj) deepFreeze(v);
    } else if (Object.prototype.toString.call(obj) === "[object Object]") {
      for (const k of Object.keys(obj)) deepFreeze(obj[k]);
    }
    return value;
  }

  // src/client/version.ts
  var VERSION = "1.1.50";

  // src/client/styles.ts
  var W = 240;
  var H = 213;
  var CW = 480;
  var CH = 426;
  var SX = CW / 1696;
  var SY = CH / 1504;
  var stageStyle = (scale, hidden) => ({
    position: "fixed",
    left: 0,
    top: 0,
    width: W + "px",
    height: H + "px",
    filter: "drop-shadow(0 14px 26px rgba(0,0,0,0.5))",
    userSelect: "none",
    zIndex: 9999,
    cursor: "grab",
    touchAction: "none",
    transform: "scale(" + scale + ")",
    // 缩放原点用左上角：与 stage.ts 的 clampPos（按左上坐标 + W*s 宽高钳制）同口径；
    // 原先 100% 100%（右下）会让缩放后的鱼贴边溢出约 96px。
    transformOrigin: "0 0",
    display: hidden ? "none" : "block"
  });
  var canvasStyle = { width: "100%", height: "100%", display: "block" };
  deepFreeze(canvasStyle);
  var recoverDotStyle = {
    position: "fixed",
    right: 16,
    bottom: 16,
    width: 22,
    height: 22,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    borderRadius: "50%",
    background: "rgba(12,28,52,0.72)",
    border: "1px solid rgba(93,160,240,0.55)",
    color: "#9FD8FF",
    font: '12px/22px "Microsoft YaHei", sans-serif',
    cursor: "pointer",
    userSelect: "none",
    opacity: 0.75,
    boxShadow: "0 2px 8px rgba(0,0,0,0.35)",
    zIndex: 10003
  };
  var menuStyle = (menu) => ({
    position: "fixed",
    // 窄视口（<220px）时 innerWidth-220 为负会把菜单甩出左边；夹到 8px 保底
    left: (menu ? Math.max(8, Math.min(menu.x, window.innerWidth - 220)) : 0) + "px",
    top: (menu ? Math.max(8, Math.min(menu.y, window.innerHeight - 520)) : 0) + "px",
    width: 210,
    maxHeight: typeof window !== "undefined" ? Math.max(200, Math.min(480, window.innerHeight - 32)) : 480,
    overflowY: "auto",
    paddingBottom: 10,
    background: "rgba(12,28,52,0.98)",
    border: "1px solid #2E6BB8",
    borderRadius: 10,
    boxShadow: "0 12px 32px rgba(0,0,0,0.5)",
    zIndex: 10001,
    font: '13px/1.5 "Microsoft YaHei", sans-serif',
    display: menu ? "block" : "none",
    color: "#cfe9ff"
  });
  var menuItemStyle = (active) => ({
    padding: "6px 14px",
    cursor: "pointer",
    color: active ? "#ffffff" : "#cfe9ff",
    fontSize: 13,
    whiteSpace: "nowrap",
    background: active ? "linear-gradient(90deg, rgba(46,107,184,0.95), rgba(34,78,140,0.55))" : "transparent",
    borderRadius: active ? 6 : 0,
    boxShadow: active ? "inset 0 0 0 1px rgba(159,216,255,0.8)" : "none"
  });
  var menuSubStyle = (active) => ({
    ...menuItemStyle(active),
    display: "flex",
    justifyContent: "space-between"
  });
  var chatPanelStyle = (open) => ({
    position: "fixed",
    right: 236,
    bottom: 146,
    width: 340,
    background: "linear-gradient(180deg, rgba(18,40,74,0.98), rgba(10,24,46,0.98))",
    border: "1px solid rgba(93,160,240,0.55)",
    borderRadius: 18,
    boxShadow: "0 18px 48px rgba(0,0,0,0.55)",
    font: '14px/1.6 "Microsoft YaHei", sans-serif',
    color: "#dbeaff",
    overflow: "hidden",
    zIndex: 1e4,
    display: open ? "block" : "none"
  });
  var headStyle = {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    padding: "10px 16px",
    background: "linear-gradient(90deg, rgba(46,107,184,0.9), rgba(27,74,140,0.9))",
    fontSize: 13,
    letterSpacing: 1,
    borderBottom: "1px solid rgba(93,160,240,0.3)"
  };
  var bodyStyle = { height: 240, overflowY: "auto", padding: "12px 14px" };
  var inputRowStyle = { display: "flex", gap: 8, padding: "10px 12px", borderTop: "1px solid rgba(93,160,240,0.25)", background: "rgba(6,16,32,0.6)" };
  deepFreeze(inputRowStyle);
  var inputStyle = {
    flex: 1,
    border: "1px solid rgba(93,160,240,0.35)",
    outline: 0,
    padding: "10px 14px",
    background: "rgba(8,20,40,0.9)",
    color: "#dbeaff",
    borderRadius: 12,
    font: '14px "Microsoft YaHei"'
  };
  var sendStyle = {
    border: 0,
    background: "linear-gradient(90deg,#2E6BB8,#4A8FD6)",
    color: "#fff",
    padding: "0 18px",
    cursor: "pointer",
    borderRadius: 12,
    fontWeight: 600
  };
  var msgStyle = (who) => ({
    margin: "8px 0",
    maxWidth: "86%",
    padding: "9px 13px",
    borderRadius: 14,
    wordBreak: "break-word",
    lineHeight: 1.6,
    marginLeft: who === "me" ? "auto" : 0,
    borderBottomRightRadius: who === "me" ? 4 : 14,
    borderBottomLeftRadius: who === "me" ? 14 : 4,
    background: who === "me" ? "linear-gradient(135deg,#2E6BB8,#3D7CC9)" : "rgba(15,37,71,0.95)",
    color: who === "me" ? "#fff" : "#dbeaff",
    border: who === "me" ? "none" : "1px solid rgba(93,160,240,0.25)",
    boxShadow: who === "me" ? "0 4px 12px rgba(46,107,184,0.35)" : "0 2px 8px rgba(0,0,0,0.25)"
  });

  // src/client/ape.ts
  var APE_DEFAULTS = {
    frameMs: 60,
    floorDownAlpha: 0.25,
    floorUpAlpha: 0.03,
    quietMarginDb: 6,
    offsetMarginDb: 6,
    marginRatio: 0.45,
    marginMinDb: 4,
    marginMaxDb: 14,
    peakDecayDb: 0.3,
    driftAfterMs: 1e3,
    shortRunMs: 1200,
    longRunMs: 3e3,
    quietShortMs: 300,
    quietMidMs: 450,
    quietLongMs: 600,
    minSpeechMs: 150,
    maxWaitAfterSpeechMs: 900,
    noiseNearDb: 14,
    /**
     * 稳态噪声允许高出噪声底多少 dB。
     * 取 20：风扇/空调常压在 15~20dB；而"持续大声说话"一般高出 25dB 以上，
     * 不会被误当噪声（试过 28，合成的一直 -45dB 语音会被判成噪声、永远不提交）。
     */
    steadyMaxAboveFloorDb: 20,
    maxSegmentMs: 6e3,
    steadyWindowFrames: 10,
    // 25 帧 × 60ms = 1.5s
    steadySpreadDb: 3,
    steadyMs: 400
  };
  deepFreeze(APE_DEFAULTS);
  var Ape = class {
    p;
    floorDb = null;
    peakDb = -160;
    speechMs = 0;
    quietMs = 0;
    elapsedMs = 0;
    runMs = 0;
    hadSpeech = false;
    lastSpeechAtMs = 0;
    noiseTail = false;
    bandMs = 0;
    steadyHist = [];
    steadyMs = 0;
    constructor(params) {
      this.p = { ...APE_DEFAULTS, ...params || {} };
    }
    resetSegment() {
      this.steadyHist = [];
      this.steadyMs = 0;
      this.speechMs = 0;
      this.quietMs = 0;
      this.elapsedMs = 0;
      this.runMs = 0;
      this.hadSpeech = false;
      this.noiseTail = false;
      this.bandMs = 0;
    }
    resetNoise() {
      this.floorDb = null;
      this.peakDb = -160;
    }
    floor() {
      return this.floorDb === null ? -70 : this.floorDb;
    }
    step(db) {
      const p = this.p;
      if (this.floorDb === null) this.floorDb = db;
      if (db > this.peakDb) this.peakDb = db;
      else this.peakDb = Math.max(-160, this.peakDb - p.peakDecayDb);
      const range = this.peakDb - this.floorDb;
      const margin = Math.max(p.marginMinDb, Math.min(p.marginMaxDb, range * p.marginRatio));
      const onsetTh = this.floorDb + margin;
      const offsetTh = this.floorDb + p.offsetMarginDb;
      this.elapsedMs += p.frameMs;
      if (db > onsetTh) {
        this.steadyHist.push(db);
        while (this.steadyHist.length > p.steadyWindowFrames) this.steadyHist.shift();
        const spread = this.steadyHist.length >= 8 ? Math.max(...this.steadyHist) - Math.min(...this.steadyHist) : 99;
        const nearFloor = db - this.floorDb <= p.steadyMaxAboveFloorDb;
        const steadyNow = spread < p.steadySpreadDb && nearFloor;
        if (steadyNow) {
          this.steadyMs += p.frameMs;
          if (this.steadyMs >= p.steadyMs) {
            this.noiseTail = true;
            this.floorDb = this.floorDb * 0.7 + db * 0.3;
          }
        } else {
          this.steadyMs = 0;
          this.noiseTail = false;
        }
        if (this.noiseTail) {
          this.quietMs += p.frameMs;
          this.bandMs = 0;
        } else {
          this.speechMs += p.frameMs;
          this.runMs += p.frameMs;
          this.hadSpeech = true;
          this.lastSpeechAtMs = this.elapsedMs;
          this.quietMs = 0;
          this.bandMs = 0;
        }
      } else if (db <= offsetTh) {
        this.quietMs += p.frameMs;
        this.bandMs = 0;
        this.floorDb = this.floorDb * (1 - p.floorDownAlpha) + db * p.floorDownAlpha;
      } else {
        this.bandMs += p.frameMs;
        if (this.bandMs >= p.driftAfterMs) {
          this.floorDb = this.floorDb * (1 - p.floorUpAlpha) + db * p.floorUpAlpha;
        }
      }
      const quietTargetMs = this.runMs < p.shortRunMs ? p.quietShortMs : this.runMs < p.longRunMs ? p.quietMidMs : p.quietLongMs;
      const sinceSpeechMs = this.hadSpeech ? Math.max(0, this.elapsedMs - this.lastSpeechAtMs) : 0;
      const overSpeechWait = this.hadSpeech && sinceSpeechMs >= p.maxWaitAfterSpeechMs;
      const validSpeech = this.speechMs >= p.minSpeechMs;
      let commit = false;
      let commitReason = "";
      if (validSpeech && this.quietMs >= quietTargetMs) {
        commit = true;
        commitReason = "quiet";
      } else if (validSpeech && overSpeechWait) {
        commit = true;
        commitReason = "quiet";
      } else if (this.elapsedMs >= p.maxSegmentMs) {
        if (validSpeech) {
          commit = true;
          commitReason = "overflow";
        } else {
          this.elapsedMs = 0;
          this.runMs = 0;
          this.quietMs = 0;
          this.speechMs = 0;
          this.bandMs = 0;
          this.hadSpeech = false;
          this.lastSpeechAtMs = 0;
        }
      }
      return {
        db,
        floorDb: this.floorDb,
        onsetTh,
        offsetTh,
        speechMs: this.speechMs,
        quietMs: this.quietMs,
        elapsedMs: this.elapsedMs,
        hadSpeech: this.hadSpeech,
        quietTargetMs,
        commit,
        commitReason
      };
    }
  };

  // src/client/rates.ts
  var NARRATION_RATES = ["-15%", "-20%", "-25%", "-30%"];
  deepFreeze(NARRATION_RATES);
  var DEFAULT_NARRATION_RATE = "-25%";
  var CHAT_RATES = ["-10%", "-20%", "-25%", "-30%"];
  deepFreeze(CHAT_RATES);
  var DEFAULT_CHAT_RATE = "-20%";
  var DEFAULT_STORY_RATE = "-35%";
  var DEFAULT_POEM_RATE = "-25%";
  function readPercentRate(key, fallback) {
    try {
      const s = String(localStorage.getItem(key) || "").trim();
      if (/^-(?:[1-9]\d?)%$/.test(s)) return s;
    } catch (e) {
    }
    return fallback;
  }
  function storyRate() {
    return readPercentRate("chubby-story-rate", DEFAULT_STORY_RATE);
  }
  function poemRate(fallback = DEFAULT_POEM_RATE) {
    return readPercentRate("chubby-poem-rate", fallback);
  }
  function chatRate() {
    try {
      const s = localStorage.getItem("chubby-chat-rate");
      if (s && CHAT_RATES.indexOf(s) >= 0) return s;
    } catch (e) {
    }
    return DEFAULT_CHAT_RATE;
  }
  function setChatRate(rate) {
    const v = String(rate || "").trim();
    if (CHAT_RATES.indexOf(v) < 0) return false;
    try {
      localStorage.setItem("chubby-chat-rate", v);
      return true;
    } catch (e) {
      return false;
    }
  }
  function narrationRate() {
    try {
      const s = localStorage.getItem("chubby-narration-rate");
      if (s && NARRATION_RATES.indexOf(s) >= 0) return s;
    } catch (e) {
    }
    return DEFAULT_NARRATION_RATE;
  }
  function setNarrationRate(rate) {
    const v = String(rate || "").trim();
    if (NARRATION_RATES.indexOf(v) < 0) return false;
    try {
      localStorage.setItem("chubby-narration-rate", v);
      return true;
    } catch (e) {
      return false;
    }
  }

  // src/client/util.ts
  function evStop(e) {
    try {
      if (e && typeof e.stopPropagation === "function") e.stopPropagation();
    } catch (e2) {
    }
  }
  function evPrevent(e) {
    try {
      if (e && typeof e.preventDefault === "function") e.preventDefault();
    } catch (e2) {
    }
  }
  function clearT(t) {
    try {
      if (t) clearTimeout(t);
    } catch (e) {
    }
  }
  function clearI(t) {
    try {
      if (t) clearInterval(t);
    } catch (e) {
    }
  }
  function str(x) {
    return x == null ? "" : String(x);
  }

  // src/client/text.ts
  function collapseText(raw) {
    return str(raw).replace(/\s+/g, " ").trim();
  }
  function collapsePoemBody(raw) {
    let t = str(raw);
    t = t.replace(/\r/g, "");
    t = t.replace(/\n+/g, "，");
    t = t.replace(/[。！？；]+，/g, (m) => m.slice(0, 1));
    t = t.replace(/，{2,}/g, "，");
    t = t.replace(/，([。！？；])/g, "$1");
    return t.trim();
  }
  function taleParts(rawTitle) {
    const t = String(rawTitle || "").trim();
    const i = t.indexOf("·");
    if (i < 0) return { title: t, book: "" };
    const book = t.slice(0, i).trim();
    const title = t.slice(i + 1).trim();
    if (book && title) return { book, title };
    return { title: title || book, book: "" };
  }
  function normalizePlain(text) {
    return str(text).replace(/[\s。，！？,.!?、…~～]/g, "");
  }
  function estimateSpeakMs(text) {
    const s = str(text);
    if (!s.trim()) return 0;
    let cjk = 0;
    let cjkPuncts = 0;
    let cjkScript = false;
    let words = 0;
    let digits = 0;
    let halfPuncts = 0;
    let inWord = false;
    for (let i = 0; i < s.length; i++) {
      const c = s.charCodeAt(i);
      if (isSpeakDigit(c)) {
        digits++;
        inWord = false;
        continue;
      }
      if (isSpeakWordLetter(c)) {
        if (!inWord) {
          words++;
          inWord = true;
        }
        continue;
      }
      if (inWord && isSpeakWordJoiner(c)) continue;
      inWord = false;
      if (isCjkSpeakChar(c)) {
        cjk++;
        cjkScript = true;
        continue;
      }
      if (isCjkSpeakPunct(c)) {
        cjkPuncts++;
        continue;
      }
      if (isHalfSpeakPunct(c)) halfPuncts++;
    }
    const base = cjkScript ? 3e3 : 600;
    const ms2 = base + (cjk + cjkPuncts) * 260 + words * 300 + digits * 200 + halfPuncts * 100;
    return Math.round(Math.min(ms2, Number.MAX_SAFE_INTEGER));
  }
  function isSpeakWordLetter(c) {
    return c >= 65 && c <= 90 || c >= 97 && c <= 122 || c >= 192 && c <= 591;
  }
  function isSpeakWordJoiner(c) {
    return c === 39 || c === 45;
  }
  function isCjkSpeakChar(c) {
    return c >= 19968 && c <= 40959 || c >= 13312 && c <= 19903 || c >= 63744 && c <= 64255 || c >= 12288 && c <= 12351 || c >= 65280 && c <= 65519;
  }
  function isHalfSpeakPunct(c) {
    return c === 44 || c === 46 || c === 33 || c === 63 || c === 59 || c === 58;
  }
  function isCjkSpeakPunct(c) {
    return c >= 8208 && c <= 8231 || c === 183;
  }
  function isSpeakDigit(c) {
    return c >= 48 && c <= 57;
  }
  function echoKey(s) {
    return str(s).replace(/星号|米字号/g, "*").replace(/\*[^*]{1,60}\*/g, "").replace(/[\s。，！？,.!?、…~～]/g, "");
  }
  var SHORT_ECHO_ALLOW = [
    "停",
    "别",
    "不",
    "好",
    "喂",
    "停下",
    "停一下",
    "别说",
    "别念",
    "别讲",
    "闭嘴",
    "安静",
    "打住",
    "够了",
    "好的",
    "好呀",
    "好吧",
    "是的",
    "对的",
    "可以",
    "不行",
    "不要",
    "没有",
    "没事",
    "谢谢",
    "晚安",
    "早安",
    "再见",
    "等我",
    "稍等",
    "讲吧",
    "说吧",
    "唱吧",
    "念吧",
    "来吧",
    "开始",
    "继续",
    "没错",
    "试试",
    "嗯嗯"
  ];
  deepFreeze(SHORT_ECHO_ALLOW);
  function isShortEchoFragment(plain, hadRecentSpeech) {
    const p = String(plain || "");
    if (!hadRecentSpeech) return false;
    if (p.length > 2) return false;
    return SHORT_ECHO_ALLOW.indexOf(p) < 0;
  }
  function stripStageDirections(raw) {
    let t = str(raw);
    t = t.replace(/[\*＊][^*＊\n]{1,60}[\*＊]/g, " ");
    t = t.replace(/[\*＊]/g, " ");
    t = t.replace(/([，。！？；：、])\s+/g, "$1");
    return t.replace(/\s{2,}/g, " ").trim();
  }
  function createDeduper(opts) {
    const windowMs = Math.max(0, Number(opts && opts.windowMs) || 0);
    let lastNorm = "";
    let lastAt = 0;
    return {
      allow(text) {
        const norm = normalizePlain(text);
        const now = Date.now();
        if (lastNorm && lastAt && now - lastAt < windowMs && norm === lastNorm) {
          try {
            if (opts.onDuplicate) opts.onDuplicate();
          } catch (e) {
          }
          return false;
        }
        lastNorm = norm;
        lastAt = now;
        return true;
      },
      reset() {
        lastNorm = "";
        lastAt = 0;
      }
    };
  }
  function createSentenceBuffer(maxLen = 40) {
    const limit = Math.max(2, Number(maxLen) || 40);
    let tail = "";
    function take(force) {
      const out = [];
      for (; ; ) {
        if (!tail) break;
        tail = tail.replace(/^\s+/, "");
        if (!tail) break;
        const m = tail.match(/[\s\S]*?[。！？!?；;\n]/);
        if (m && m[0].length >= 2) {
          const seg = m[0].trim();
          tail = tail.slice(m[0].length);
          if (seg) out.push(seg);
          continue;
        }
        if (force || tail.length >= limit) {
          const seg = tail.trim();
          tail = "";
          if (seg) out.push(seg);
        }
        break;
      }
      return out;
    }
    return {
      push(delta) {
        tail += str(delta);
        return take(false);
      },
      flush() {
        return take(true);
      }
    };
  }

  // src/client/playback.ts
  function isPlaybackZombie(p) {
    const zombieMs = p.zombieMs === void 0 ? 2500 : p.zombieMs;
    const synthTimeoutMs = p.synthTimeoutMs === void 0 ? 2e4 : p.synthTimeoutMs;
    if (!p.busy) return false;
    if (p.hasAudio && p.audioPlaying) return false;
    if (!p.hasAudio && p.synthAt > 0 && p.now - p.synthAt < synthTimeoutMs) return false;
    const since = typeof p.lastProgressAt === "number" && p.lastProgressAt > 0 ? p.lastProgressAt : p.busySince;
    return p.now - since >= zombieMs;
  }

  // src/client/endpoint.ts
  var ENDPOINT_MODES = ["ape", "classic"];
  deepFreeze(ENDPOINT_MODES);
  var DEFAULT_ENDPOINT_MODE = "classic";
  function normalizeEndpointMode(v) {
    return String(v || "").trim() === "ape" ? "ape" : DEFAULT_ENDPOINT_MODE;
  }
  function readEndpointMode() {
    try {
      return normalizeEndpointMode(localStorage.getItem("chubby-endpoint"));
    } catch (e) {
      return DEFAULT_ENDPOINT_MODE;
    }
  }
  function writeEndpointMode(m) {
    try {
      localStorage.setItem("chubby-endpoint", normalizeEndpointMode(m));
      return true;
    } catch (e) {
      return false;
    }
  }

  // src/client/audio-codec.ts
  var RECORDER_MIME_CANDIDATES = [
    "audio/webm;codecs=opus",
    "audio/webm",
    "audio/mp4"
  ];
  deepFreeze(RECORDER_MIME_CANDIDATES);
  var WAV_HEADER_BYTES = 44;
  function formatFromMime(mime) {
    const m = str(mime).toLowerCase();
    if (m.indexOf("webm") >= 0) return "webm";
    if (m.indexOf("wav") >= 0 || m.indexOf("wave") >= 0) return "wav";
    if (m.indexOf("mpeg") >= 0 || m.indexOf("mp3") >= 0) return "mp3";
    if (m.indexOf("mp4") >= 0 || m.indexOf("m4a") >= 0 || m.indexOf("aac") >= 0) return "mp4";
    return "webm";
  }
  function pickRecorderMime(caps) {
    const can = caps && typeof caps.isTypeSupported === "function" ? caps : null;
    if (can) {
      for (let i = 0; i < RECORDER_MIME_CANDIDATES.length; i++) {
        const t = RECORDER_MIME_CANDIDATES[i];
        try {
          if (can.isTypeSupported(t)) return { mimeType: t, format: formatFromMime(t) };
        } catch (e) {
        }
      }
    }
    return { mimeType: "", format: "webm" };
  }
  function hostAsrFormat(format) {
    return format === "wav" ? "wav" : format === "mp3" ? "mp3" : "webm";
  }
  function downmixToMono(channels) {
    const list = (channels || []).filter(Boolean);
    if (!list.length) return new Float32Array(0);
    let len = 0;
    for (let i = 0; i < list.length; i++) len = Math.max(len, list[i].length >>> 0);
    const out = new Float32Array(len);
    for (let c = 0; c < list.length; c++) {
      const ch = list[c];
      for (let i = 0; i < len; i++) {
        const v = i < ch.length ? Number(ch[i]) : 0;
        out[i] += isFinite(v) ? v : 0;
      }
    }
    if (list.length > 1) for (let i = 0; i < len; i++) out[i] = out[i] / list.length;
    return out;
  }
  function writeAscii(view, offset, text) {
    for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i) & 255);
  }
  function encodeWavPcm16(samples, sampleRate) {
    const src = samples || [];
    const n = Math.max(0, src.length >>> 0);
    const rateRaw = Math.round(Number(sampleRate) || 48e3);
    const sr = Math.max(8e3, Math.min(96e3, rateRaw));
    const dataBytes = n * 2;
    if (dataBytes > 4294967295 - 36) throw new RangeError("wav too large");
    const buf = new ArrayBuffer(WAV_HEADER_BYTES + dataBytes);
    const v = new DataView(buf);
    writeAscii(v, 0, "RIFF");
    v.setUint32(4, 36 + dataBytes, true);
    writeAscii(v, 8, "WAVE");
    writeAscii(v, 12, "fmt ");
    v.setUint32(16, 16, true);
    v.setUint16(20, 1, true);
    v.setUint16(22, 1, true);
    v.setUint32(24, sr, true);
    v.setUint32(28, sr * 2, true);
    v.setUint16(32, 2, true);
    v.setUint16(34, 16, true);
    writeAscii(v, 36, "data");
    v.setUint32(40, dataBytes, true);
    for (let i = 0; i < n; i++) {
      let s = Number(src[i]);
      if (!isFinite(s)) s = 0;
      if (s < -1) s = -1;
      else if (s > 1) s = 1;
      v.setInt16(WAV_HEADER_BYTES + i * 2, s < 0 ? Math.round(s * 32768) : Math.round(s * 32767), true);
    }
    return buf;
  }
  function wavBytes(seconds, sampleRate) {
    const sec = Math.max(0, Number(seconds) || 0);
    const sr = Math.max(8e3, Math.min(96e3, Math.round(Number(sampleRate) || 48e3)));
    return WAV_HEADER_BYTES + Math.ceil(sec * sr) * 2;
  }

  // src/client/browser-tts.ts
  function scopeOf(scope) {
    if (scope) return scope;
    try {
      return typeof window !== "undefined" ? window : null;
    } catch (e) {
      return null;
    }
  }
  function browserVoiceUsable(scope) {
    try {
      const s = scopeOf(scope);
      if (!s || !s.speechSynthesis || typeof s.speechSynthesis.speak !== "function") return false;
      return true;
    } catch (e) {
      return false;
    }
  }
  function watchdogMs(text) {
    const n = String(text || "").length;
    return Math.min(3e4, Math.max(4e3, 1500 + n * 220));
  }
  var VOICE_WAIT_MS = 300;
  function speakViaBrowser(text, opts) {
    const src = String(text || "");
    const s = scopeOf(opts && opts.scope);
    const ms2 = opts && typeof opts.watchdog === "number" && opts.watchdog > 0 ? opts.watchdog : watchdogMs(src);
    return new Promise((resolve) => {
      let done = false;
      let startTimer = null;
      let voiceTimer = null;
      let onVoices = null;
      let synthRef = null;
      const finish = () => {
        if (done) return;
        done = true;
        try {
          if (startTimer) {
            clearTimeout(startTimer);
            startTimer = null;
          }
        } catch (e) {
        }
        try {
          if (voiceTimer) {
            clearTimeout(voiceTimer);
            voiceTimer = null;
          }
        } catch (e) {
        }
        try {
          if (onVoices && synthRef && typeof synthRef.removeEventListener === "function") {
            synthRef.removeEventListener("voiceschanged", onVoices);
          }
        } catch (e) {
        }
        onVoices = null;
        resolve();
      };
      const watch = setTimeout(finish, ms2);
      const realFinish = () => {
        clearT(watch);
        finish();
      };
      try {
        const Synth = s && s.speechSynthesis;
        const Utt = s && s.SpeechSynthesisUtterance;
        if (!Synth || !Utt || typeof Synth.speak !== "function") {
          realFinish();
          return;
        }
        synthRef = Synth;
        const u = new Utt(src);
        const wantZh = /[\u4e00-\u9fa5]/.test(src);
        u.lang = wantZh ? "zh-CN" : "en-US";
        u.onend = realFinish;
        u.onerror = realFinish;
        const chooseVoice = () => {
          try {
            const vs = typeof Synth.getVoices === "function" ? Synth.getVoices() : null;
            for (let i = 0; vs && i < vs.length; i++) {
              const v = vs[i];
              if (!v) continue;
              const lang = String(v.lang || "");
              if (wantZh ? /^zh/i.test(lang) : /^en/i.test(lang)) {
                u.voice = v;
                break;
              }
            }
          } catch (e) {
          }
        };
        const speak = () => {
          try {
            Synth.speak(u);
          } catch (e) {
            realFinish();
          }
        };
        const launch = () => {
          if (done) return;
          try {
            if (voiceTimer) {
              clearTimeout(voiceTimer);
              voiceTimer = null;
            }
          } catch (e) {
          }
          try {
            if (onVoices && typeof Synth.removeEventListener === "function") Synth.removeEventListener("voiceschanged", onVoices);
          } catch (e) {
          }
          onVoices = null;
          chooseVoice();
          const busy = (() => {
            try {
              return !!(Synth.speaking || Synth.pending);
            } catch (e) {
              return false;
            }
          })();
          if (busy) {
            try {
              if (typeof Synth.cancel === "function") Synth.cancel();
            } catch (e) {
            }
            startTimer = setTimeout(speak, 80);
          } else speak();
        };
        let waiting = false;
        try {
          const vs = typeof Synth.getVoices === "function" ? Synth.getVoices() : null;
          if ((!vs || !vs.length) && typeof Synth.addEventListener === "function") {
            waiting = true;
            onVoices = () => {
              if (done) return;
              launch();
            };
            Synth.addEventListener("voiceschanged", onVoices);
            voiceTimer = setTimeout(() => {
              if (done) return;
              launch();
            }, VOICE_WAIT_MS);
          }
        } catch (e) {
          waiting = false;
        }
        if (!waiting) launch();
      } catch (e) {
        realFinish();
      }
    });
  }

  // src/client/voice/asr-audio.ts
  function readBlobBuffer(blob) {
    return new Promise((resolve) => {
      try {
        const fr = new FileReader();
        fr.onload = () => resolve(fr.result || null);
        fr.onerror = () => resolve(null);
        fr.readAsArrayBuffer(blob);
      } catch (e) {
        resolve(null);
      }
    });
  }
  function transcodeToWav(blob, actx, maxWavBytes = 6 * 1024 * 1024) {
    return new Promise((resolve) => {
      const ctx = actx;
      if (!ctx || typeof ctx.decodeAudioData !== "function") {
        resolve(null);
        return;
      }
      let settled = false;
      let timeout = null;
      const done = (wav) => {
        if (settled) return;
        settled = true;
        clearT(timeout);
        resolve(wav);
      };
      const finish = (buf) => {
        try {
          if (!buf || !buf.numberOfChannels) {
            done(null);
            return;
          }
          const chans = [];
          const n = Math.min(2, Number(buf.numberOfChannels) || 1);
          for (let i = 0; i < n; i++) chans.push(buf.getChannelData(i));
          const mono = downmixToMono(chans);
          if (wavBytes(mono.length / (Number(buf.sampleRate) || 48e3), buf.sampleRate) > maxWavBytes) {
            done(null);
            return;
          }
          done(new Blob([encodeWavPcm16(mono, buf.sampleRate)], { type: "audio/wav" }));
        } catch (e) {
          done(null);
        }
      };
      readBlobBuffer(blob).then((ab) => {
        if (!ab) {
          done(null);
          return;
        }
        try {
          const ret = ctx.decodeAudioData(ab, finish, () => done(null));
          if (ret && typeof ret.then === "function") ret.then(finish).catch(() => done(null));
        } catch (e) {
          done(null);
        }
      });
      timeout = setTimeout(() => done(null), 3e3);
    });
  }
  function blobToBase64(blob) {
    return new Promise((resolve) => {
      try {
        const fr = new FileReader();
        fr.onloadend = () => {
          const s = String(fr.result || "");
          resolve(s.indexOf(",") >= 0 ? s.slice(s.indexOf(",") + 1) : s);
        };
        fr.onerror = () => resolve("");
        fr.readAsDataURL(blob);
      } catch (e) {
        resolve("");
      }
    });
  }
  async function prepareAudioForAsr(blob, deps) {
    const recMime = String(deps && deps.recMime || "");
    const onDiag = deps && deps.onDiag;
    const maxWavBytes = deps && typeof deps.maxWavBytes === "number" ? deps.maxWavBytes : 6 * 1024 * 1024;
    let src = blob;
    let fmt = formatFromMime(blob.type || recMime);
    if (fmt === "mp4") {
      const wav = await transcodeToWav(blob, deps && deps.actx, maxWavBytes);
      if (wav) {
        src = wav;
        fmt = "wav";
      } else {
        try {
          onDiag && onDiag({ stage: "mp4-no-transcode", hint: "mp4 没能转成 wav，按原字节上传" });
        } catch (e) {
        }
      }
    }
    const b64 = await blobToBase64(src);
    if (!b64) return null;
    return { base64: b64, format: hostAsrFormat(fmt) };
  }

  // src/shared/noise.ts
  var NOISE_TEXTS = [
    "嗯",
    "呃",
    "啊",
    "哦",
    "恩",
    "嗯嗯",
    "啊啊",
    "谢谢观看",
    "谢谢大家",
    "字幕",
    "请不吝点赞",
    "点赞",
    "订阅",
    "转发",
    "打赏",
    "再见",
    "本鱼在听",
    "嗯本鱼在听",
    "字幕由",
    "明镜与点点"
  ];
  deepFreeze(NOISE_TEXTS);
  var INTERRUPT_WORDS = ["停", "别", "不", "闭嘴", "打住"];
  deepFreeze(INTERRUPT_WORDS);
  function normalizeNoiseKey(text) {
    return String(text == null ? "" : text).replace(/\s+/g, "").replace(/[。，、！？；：,.!?;:…~～·""''（）()【】\[\]]/g, "").toLowerCase();
  }
  function isNoiseText(text) {
    const k = normalizeNoiseKey(text);
    if (!k) return true;
    if (isInterruptWord(k)) return false;
    if (k.length <= 1) return true;
    if (NOISE_TEXTS.indexOf(k) >= 0) return true;
    if (k.length <= 6 && /^([\u4e00-\u9fa5])\1{2,}$/.test(k)) return true;
    return false;
  }
  function isInterruptWord(text) {
    const k = normalizeNoiseKey(text);
    return k.length > 0 && INTERRUPT_WORDS.indexOf(k) >= 0;
  }

  // src/client/sim.ts
  function normalizeText(s) {
    return String(s || "").toLowerCase().replace(/[\s\u3000]+/g, "").replace(/[\s。，！？、；：,.!?;:"'”’“”（）()【】\[\]<>《》~～`@#$%^&*_+=|\\/-]/g, "");
  }
  function bigrams(s) {
    const out = /* @__PURE__ */ new Set();
    const t = String(s || "");
    if (!t) return out;
    if (t.length === 1) {
      out.add(t);
      return out;
    }
    for (let i = 0; i < t.length - 1; i++) out.add(t.slice(i, i + 2));
    return out;
  }
  function similarity(a, b) {
    const A = bigrams(normalizeText(a));
    const B = bigrams(normalizeText(b));
    if (A.size === 0 || B.size === 0) return 0;
    let inter = 0;
    for (const g of A) if (B.has(g)) inter++;
    const union = A.size + B.size - inter;
    return union === 0 ? 0 : inter / union;
  }
  function isRepeat(text, opts) {
    const threshold = opts.threshold === void 0 ? 0.85 : opts.threshold;
    const minLen = opts.minLen === void 0 ? 4 : opts.minLen;
    const windowMs = opts.windowMs === void 0 ? 2e4 : opts.windowMs;
    const now = opts.now === void 0 ? Date.now() : opts.now;
    const cur = normalizeText(text);
    if (!cur) return false;
    for (const item2 of opts.recent || []) {
      if (now - Number(item2 && item2.at || 0) > windowMs) continue;
      const prev = normalizeText(item2 && item2.text ? item2.text : "");
      if (!prev) continue;
      if (cur === prev) return true;
      const shortOne = cur.length <= prev.length ? cur : prev;
      const longOne = cur.length <= prev.length ? prev : cur;
      if (shortOne.length >= minLen && longOne.indexOf(shortOne) >= 0) return true;
      if (cur.length >= minLen && prev.length >= minLen && similarity(cur, prev) >= threshold) return true;
    }
    return false;
  }

  // src/client/voice/echo-filter.ts
  function createEchoFilter() {
    const spokenRecent = [];
    const recentHeard = [];
    const acceptedSeg = [];
    let maxSegId = 0;
    function noteSpoken(text, now) {
      const t = String(text || "").trim();
      if (!t) return;
      spokenRecent.push({ text: t, at: typeof now === "number" ? now : Date.now() });
      while (spokenRecent.length > 12) spokenRecent.shift();
    }
    function accept(text, nowIn, segId) {
      if (typeof segId === "number") {
        if (segId < maxSegId) return { ok: false, reason: "dup" };
        if (acceptedSeg.indexOf(segId) >= 0) return { ok: false, reason: "dup" };
        acceptedSeg.push(segId);
        while (acceptedSeg.length > 50) acceptedSeg.shift();
        if (segId > maxSegId) maxSegId = segId;
      }
      const plain = normalizePlain(text).toLowerCase();
      const plainKey = echoKey(text).toLowerCase();
      const interrupt = /^[停别不]$/.test(plain);
      if (plain.length < 2 && !interrupt) return { ok: false, reason: "trivial" };
      if (!interrupt && isNoiseText(plain)) return { ok: false, reason: "noise" };
      if (/^本鱼在听/.test(plain)) return { ok: false, reason: "self" };
      const now = typeof nowIn === "number" ? nowIn : Date.now();
      let hadRecentSpeech = false;
      for (const s of spokenRecent) {
        if (now - s.at > 15e3) continue;
        if (now - s.at <= 8e3) hadRecentSpeech = true;
        const target = normalizePlain(s.text).toLowerCase();
        if (!target) continue;
        const targetKey = echoKey(s.text).toLowerCase();
        if (plainKey && targetKey && (plainKey === targetKey || targetKey.length >= 6 && plainKey.indexOf(targetKey.slice(0, 6)) >= 0)) {
          return { ok: false, reason: "echo" };
        }
        if (plain === target) return { ok: false, reason: "echo" };
        if (target.length >= 6 && plain.indexOf(target.slice(0, 6)) >= 0) return { ok: false, reason: "echo" };
        if (plain.length >= 6 && target.indexOf(plain.slice(0, 6)) >= 0) return { ok: false, reason: "echo" };
        if (plain.length >= 3 && now - s.at < 6e3 && target.indexOf(plain) >= 0) return { ok: false, reason: "echo" };
      }
      if (isShortEchoFragment(plain, hadRecentSpeech)) return { ok: false, reason: "short" };
      if (isRepeat(plain, { recent: recentHeard, windowMs: 8e3, threshold: 0.9, minLen: 4, now })) {
        return { ok: false, reason: "dup" };
      }
      recentHeard.push({ text, at: now });
      while (recentHeard.length > 3) recentHeard.shift();
      return { ok: true };
    }
    return {
      accept,
      noteSpoken,
      reset() {
        spokenRecent.length = 0;
        recentHeard.length = 0;
        acceptedSeg.length = 0;
        maxSegId = 0;
      }
    };
  }

  // src/client/voice/fetch.ts
  async function fetchWithTimeout(url, init, ms2, outer) {
    const ctl = typeof AbortController !== "undefined" ? new AbortController() : null;
    const timer = ctl ? setTimeout(() => {
      try {
        ctl.abort();
      } catch (e) {
      }
    }, ms2) : null;
    let sig = ctl ? ctl.signal : void 0;
    const forwardOuter = () => {
      try {
        if (ctl) ctl.abort();
      } catch (e) {
      }
    };
    let hooked = false;
    if (outer && ctl) {
      const AnySig = AbortSignal;
      if (typeof AnySig.any === "function") {
        try {
          sig = AnySig.any([ctl.signal, outer]);
        } catch (e) {
          sig = ctl.signal;
        }
      } else {
        try {
          if (outer.aborted) forwardOuter();
          else {
            outer.addEventListener("abort", forwardOuter, { once: true });
            hooked = true;
          }
        } catch (e) {
        }
        sig = ctl.signal;
      }
    } else if (!ctl && outer) {
      sig = outer;
    }
    try {
      return await fetch(url, sig ? { ...init, signal: sig } : init);
    } finally {
      if (timer) clearTimeout(timer);
      if (hooked) {
        try {
          outer.removeEventListener("abort", forwardOuter);
        } catch (e) {
        }
      }
    }
  }

  // src/client/voice/voices.ts
  var TTS_VOICES = [
    "zh-CN-XiaoyiNeural",
    "zh-CN-XiaoxiaoNeural",
    "zh-CN-XiaochenNeural",
    "zh-CN-YunxiNeural",
    "zh-CN-YunyangNeural",
    "en-US-AnaNeural",
    "en-US-JennyNeural",
    "en-GB-SoniaNeural",
    "auto"
  ];
  deepFreeze(TTS_VOICES);
  var DEFAULT_VOICE = "zh-CN-XiaoyiNeural";
  function normalizeVoiceName(name, fallback = DEFAULT_VOICE) {
    const n = str(name).trim();
    return TTS_VOICES.indexOf(n) >= 0 ? n : fallback;
  }
  function readStoredVoiceName() {
    try {
      return normalizeVoiceName(localStorage.getItem("chubby-tts-voice"));
    } catch (e) {
      return DEFAULT_VOICE;
    }
  }

  // src/client/voice/status.ts
  function createVoiceStats() {
    return {
      windows: 0,
      skippedSilent: 0,
      uploaded: 0,
      asrFail: 0,
      asrRetry: 0,
      asrTexts: 0,
      heard: 0,
      echoDropped: 0,
      shortDropped: 0,
      dupDropped: 0,
      qDropped: 0,
      ttsRequests: 0,
      ttsPlayed: 0,
      ttsFail: 0,
      ttsZombie: 0,
      lastError: ""
    };
  }
  function createStatusHolder(sink) {
    let status = "idle";
    return {
      get: () => status,
      set(s) {
        if (status === s) return;
        status = s;
        try {
          if (sink) sink(s);
        } catch (e) {
        }
      }
    };
  }
  function createDiagSnapshots() {
    let lastApe = null;
    let lastSegment = null;
    let lastTts = null;
    return {
      setApe: (v) => {
        lastApe = v;
      },
      getApe: () => lastApe,
      setSegment: (v) => {
        lastSegment = v;
      },
      getSegment: () => lastSegment,
      setTts: (v) => {
        lastTts = v;
      },
      getTts: () => lastTts
    };
  }

  // src/client/voice/tts-queue.ts
  var TTS_TIMEOUT_MS = 2e4;
  var TTS_WATCH_MS = 1e3;
  var TTS_ZOMBIE_MS = 2500;
  var ECHO_MUTE_MS = 700;
  var TTS_RETRY_MAX = 4;
  var TTS_RETRY_BASE_MS = 500;
  function ttsRetryDelayMs(attempt) {
    const n = Math.max(1, Math.floor(Number(attempt) || 1));
    return TTS_RETRY_BASE_MS * Math.pow(2, Math.min(n, TTS_RETRY_MAX) - 1);
  }
  function narrationPauseFor(text) {
    const t = String(text || "").trim();
    if (!t) return 200;
    const last = t.slice(-1);
    if (/[。！？!?…]/.test(last)) return 260;
    if (/[，、；,;]/.test(last)) return 140;
    return 200;
  }
  function prefetchTargets(queue, narration, inflight = 0, has, maxInflight = 3) {
    const depth = narration ? 3 : 2;
    const cap = Math.max(0, Math.floor(Number(maxInflight) || 0));
    let n = Math.max(0, Math.floor(Number(inflight) || 0));
    const out = [];
    for (let i = 0; i < depth && i < queue.length; i++) {
      const t = queue[i];
      if (has && has(t.seq)) continue;
      if (n >= cap) break;
      out.push(t);
      n++;
    }
    return out;
  }
  function buildTtsJobs(segs, opts) {
    const out = [];
    for (let i = 0; i < segs.length; i++) {
      out.push({
        seq: opts.nextSeq + i,
        text: segs[i],
        rate: opts.rate,
        narration: opts.narration,
        attempts: 0,
        strict: opts.strict,
        onDone: i === segs.length - 1 ? opts.onDone : void 0
      });
    }
    return out;
  }
  function isStaleToken(token, current) {
    return typeof token === "number" && token !== current;
  }
  var TTS_QUEUE_MAX = 200;
  function capQueue(q, max = TTS_QUEUE_MAX) {
    const limit = Math.max(0, Math.floor(Number(max) || 0));
    if (!Array.isArray(q) || q.length <= limit) return 0;
    const drop = q.length - limit;
    q.splice(0, drop);
    return drop;
  }

  // src/client/voice/recorder.ts
  var WINDOW_MS = 6e3;
  var EARLY_STOP_QUIET = 700;
  var MIN_SPEECH_MS = 400;
  var SILENT_PEAK_DB = -35;
  var CLASSIC_SPEECH_DB = -45;
  var MUTED_SPEECH_DB = 0;
  var TICK_MS = 60;
  var TICK_ERROR_MS = 120;
  var LEVEL_PROBE_MS = 1200;
  var MIN_SEGMENT_BYTES = 1200;
  var APE_MIN_SPEECH_MS = 150;
  function readLevel(analyser, timeBuf, box) {
    const an = analyser;
    if (!an || !timeBuf) return { db: -160, read: false };
    let ok = false;
    try {
      if (typeof an.getFloatTimeDomainData === "function") {
        an.getFloatTimeDomainData(timeBuf);
        ok = true;
      } else if (typeof an.getByteTimeDomainData === "function") {
        let bytes = box.byte;
        if (!bytes || bytes.length !== timeBuf.length) {
          bytes = new Uint8Array(timeBuf.length);
          box.byte = bytes;
        }
        an.getByteTimeDomainData(bytes);
        for (let i = 0; i < timeBuf.length; i++) timeBuf[i] = (bytes[i] - 128) / 128;
        ok = true;
      }
    } catch (e) {
      ok = false;
    }
    if (!ok) return { db: -160, read: false };
    let sum = 0;
    for (let i = 0; i < timeBuf.length; i++) sum += timeBuf[i] * timeBuf[i];
    const rms = Math.sqrt(sum / timeBuf.length);
    const db = 20 * Math.log10(rms + 1e-8);
    return { db, read: true };
  }
  function createSegmentState() {
    return { chunks: [], peakDb: -160, speechMs: 0, quietMs: 0, startedAt: 0 };
  }
  function resetSegmentState(s, startedAt) {
    s.chunks = [];
    s.peakDb = -160;
    s.speechMs = 0;
    s.quietMs = 0;
    s.startedAt = startedAt;
  }
  function addChunk(s, blob) {
    s.chunks.push(blob);
  }
  function clearChunks(s) {
    s.chunks = [];
  }
  function notePeak(s, db) {
    if (db > s.peakDb) s.peakDb = db;
  }
  function accrueClassic(s, db, muted) {
    if (db > (muted ? MUTED_SPEECH_DB : CLASSIC_SPEECH_DB)) {
      s.speechMs += TICK_MS;
      s.quietMs = 0;
    } else {
      s.quietMs += TICK_MS;
    }
  }
  function shouldStopClassic(s, now) {
    if (s.speechMs >= MIN_SPEECH_MS && s.quietMs >= EARLY_STOP_QUIET) return "quiet";
    if (now - s.startedAt >= WINDOW_MS) return "timeout";
    return "";
  }
  function shouldStopApeNoLevel(s, levelDead, now) {
    return !!(levelDead && now - s.startedAt >= WINDOW_MS);
  }
  function takeBlob(s, type) {
    const blob = new Blob(s.chunks, { type });
    s.chunks = [];
    return blob;
  }
  function isTooSmallSegment(bytes) {
    return bytes < MIN_SEGMENT_BYTES;
  }
  function isSilentPeak(peakDb) {
    return peakDb < SILENT_PEAK_DB;
  }
  function hadApeSpeech(step) {
    return !!(step && step.hadSpeech && step.speechMs >= APE_MIN_SPEECH_MS);
  }

  // src/client/voice.ts
  var ASR_TIMEOUT_MS = 3e4;
  var ASR_RETRY_ONCE = true;
  var TTS_FAIL_COOLDOWN_K = 3;
  var TTS_COOLDOWN_MS = 6e4;
  var TTS_MAX_INFLIGHT = 3;
  var ttsFailGuard = { streak: 0, count: 0, cooldownUntil: 0 };
  var ttsPrefetchGuard = { hits: 0, misses: 0 };
  function ttsInCooldown(now = Date.now()) {
    return ttsFailGuard.cooldownUntil > 0 && now < ttsFailGuard.cooldownUntil;
  }
  function ttsSyncDiag() {
    try {
      const w = window.__chubbyWhale || (window.__chubbyWhale = {});
      w.ttsFailCount = ttsFailGuard.count;
      w.ttsCooldownUntil = ttsFailGuard.cooldownUntil;
      w.ttsPrefetchHits = ttsPrefetchGuard.hits;
      w.ttsPrefetchMisses = ttsPrefetchGuard.misses;
    } catch (e) {
    }
  }
  function ttsNoteSynthFail() {
    const now = Date.now();
    ttsFailGuard.count++;
    ttsFailGuard.streak++;
    if (ttsFailGuard.streak >= TTS_FAIL_COOLDOWN_K && !ttsInCooldown(now)) {
      ttsFailGuard.cooldownUntil = now + TTS_COOLDOWN_MS;
    }
    ttsSyncDiag();
    return ttsInCooldown(now);
  }
  function ttsNoteSynthOk() {
    ttsFailGuard.streak = 0;
    ttsFailGuard.cooldownUntil = 0;
    ttsSyncDiag();
  }
  function ttsSkipFailOn() {
    try {
      if (typeof localStorage === "undefined" || !localStorage) return false;
      return String(localStorage.getItem("chubby-tts-skip-fail") || "").trim().toLowerCase() === "on";
    } catch (e) {
      return false;
    }
  }
  function createVoice(opts) {
    const apiBase = opts.apiBase || "/api/chubby-whale";
    let voiceName = normalizeVoiceName(opts.voiceName || readStoredVoiceName());
    let epMode = readEndpointMode();
    const ape = new Ape();
    const diag2 = createDiagSnapshots();
    const stats = createVoiceStats();
    ttsSyncDiag();
    const statusHolder = createStatusHolder((s) => {
      try {
        opts.onStatus && opts.onStatus(s);
      } catch (e) {
      }
    });
    const setStatus = statusHolder.set;
    let stream = null;
    let actx = null;
    let analyser = null;
    let rec = null;
    let timeBuf = null;
    const levelBuf = { byte: null };
    let running = false;
    let recMime = "";
    let recFormat = "webm";
    let levelOk = false;
    let levelDead = false;
    let levelProbeAt = 0;
    let gestureHooks = null;
    let asrNoKey = false;
    let muted = false;
    const seg = createSegmentState();
    let segSeq = 0;
    let curSegId = 0;
    let tickTimer = null;
    let restartTimer = null;
    const echoFilter = createEchoFilter();
    const ttsQ = [];
    let ttsBusy = false;
    let ttsAudio = null;
    let ttsUrl = "";
    let ttsBusySince = 0;
    let ttsSynthAt = 0;
    let ttsProgressAt = 0;
    let ttsCurJob = null;
    let ttsWatch = null;
    let ttsBrowserKeep = null;
    let ttsNextRetryAt = 0;
    let mutedUntil = 0;
    let speakToken = 0;
    const level = () => {
      const r = readLevel(analyser, timeBuf, levelBuf);
      if (r.db > -159) levelOk = true;
      return r.db;
    };
    function micOn(on) {
      try {
        if (stream) stream.getAudioTracks().forEach((t) => {
          t.enabled = on;
        });
      } catch (e) {
      }
    }
    function releaseAudio() {
      try {
        if (rec && rec.state !== "inactive") rec.stop();
      } catch (e) {
      }
      try {
        if (actx) actx.close();
      } catch (e) {
      }
      try {
        if (stream) stream.getTracks().forEach((t) => {
          t.stop();
        });
      } catch (e) {
      }
      rec = null;
      actx = null;
      analyser = null;
      stream = null;
      timeBuf = null;
      levelBuf.byte = null;
    }
    function unhookGestureResume() {
      const g = gestureHooks;
      if (!g) return;
      gestureHooks = null;
      try {
        window.removeEventListener("pointerdown", g.resume, true);
      } catch (e) {
      }
      try {
        window.removeEventListener("touchstart", g.resume, true);
      } catch (e) {
      }
      try {
        window.removeEventListener("keydown", g.resume, true);
      } catch (e) {
      }
    }
    function hookGestureResume() {
      if (gestureHooks) return;
      const resume = () => {
        try {
          const c = actx;
          if (c && c.state === "suspended") c.resume();
          if (c && c.state !== "suspended") {
            levelDead = false;
            levelOk = false;
            levelProbeAt = performance.now();
          }
        } catch (e) {
        }
        unhookGestureResume();
      };
      gestureHooks = { resume };
      try {
        window.addEventListener("pointerdown", resume, true);
        window.addEventListener("touchstart", resume, true);
        window.addEventListener("keydown", resume, true);
      } catch (e) {
      }
    }
    function scheduleNext(ms2) {
      if (!running) return;
      if (restartTimer) clearTimeout(restartTimer);
      restartTimer = setTimeout(() => {
        restartTimer = null;
        beginWindow();
      }, ms2);
    }
    function beginWindow() {
      curSegId = ++segSeq;
      if (!running || !rec) return;
      try {
        if (rec.state !== "inactive") {
          try {
            rec.stop();
          } catch (e) {
          }
          scheduleNext(200);
          return;
        }
        resetSegmentState(seg, performance.now());
        ape.resetSegment();
        diag2.setApe(null);
        rec.start();
        scheduleNext(0);
        if (restartTimer) {
          clearTimeout(restartTimer);
          restartTimer = null;
        }
        tick();
      } catch (e) {
        stats.lastError = "beginWindow: " + String(e && e.name);
        scheduleNext(1e3);
      }
    }
    function tick() {
      if (!running || !rec || rec.state !== "recording") return;
      try {
        const db = level();
        if (!levelOk && !levelDead && levelProbeAt && performance.now() - levelProbeAt > LEVEL_PROBE_MS) {
          levelDead = true;
          try {
            opts.onDiag && opts.onDiag({ stage: "analyser-dead", hint: "电平不可用，静音判定已降级（改按段长/体积）" });
          } catch (e) {
          }
        }
        if (epMode === "ape") {
          const st = ape.step(db);
          diag2.setApe(st);
          notePeak(seg, db);
          if (st.commit && rec && rec.state === "recording") {
            try {
              rec.stop();
            } catch (e) {
            }
            try {
              opts.onDiag && opts.onDiag({ stage: "window-end", why: st.commitReason, floor: Math.round(st.floorDb) });
            } catch (e) {
            }
            return;
          }
          if (shouldStopApeNoLevel(seg, levelDead, performance.now())) {
            try {
              rec.stop();
            } catch (e) {
            }
            try {
              opts.onDiag && opts.onDiag({ stage: "window-end", why: "no-level" });
            } catch (e) {
            }
            return;
          }
          tickTimer = setTimeout(tick, TICK_MS);
          return;
        }
        const now = performance.now();
        notePeak(seg, db);
        accrueClassic(seg, db, muted);
        const why = shouldStopClassic(seg, now);
        if (why) {
          try {
            rec.stop();
          } catch (e) {
          }
          try {
            opts.onDiag && opts.onDiag({ stage: "window-end", why, peak: Math.round(seg.peakDb), speechMs: seg.speechMs });
          } catch (e) {
          }
          return;
        }
        tickTimer = setTimeout(tick, TICK_MS);
      } catch (e) {
        stats.lastError = "tick: " + String(e && e.name);
        tickTimer = setTimeout(tick, TICK_ERROR_MS);
      }
    }
    async function onWindowDone(blob) {
      const thisSegId = curSegId;
      if (!running) return;
      if (asrNoKey) {
        stats.skippedSilent++;
        scheduleNext(150);
        return;
      }
      stats.windows++;
      if (!levelDead) {
        if (epMode === "ape") {
          if (!hadApeSpeech(diag2.getApe())) {
            stats.skippedSilent++;
            scheduleNext(150);
            return;
          }
        } else if (isSilentPeak(seg.peakDb)) {
          stats.skippedSilent++;
          scheduleNext(150);
          return;
        }
      }
      if (Date.now() < mutedUntil) {
        stats.skippedSilent++;
        scheduleNext(150);
        return;
      }
      if (isTooSmallSegment(blob.size)) {
        stats.skippedSilent++;
        scheduleNext(150);
        return;
      }
      stats.uploaded++;
      setStatus("recognizing");
      try {
        const wire = await prepareAudioForAsr(blob, { actx, recMime, onDiag: opts.onDiag });
        if (!wire || !wire.base64) {
          stats.asrFail++;
          stats.lastError = "b64-empty";
          return;
        }
        const uploadOnce = async () => {
          const ctl = typeof AbortController !== "undefined" ? new AbortController() : null;
          if (ctl) asrAborts.add(ctl);
          try {
            return await fetchWithTimeout(apiBase + "/asr", {
              method: "POST",
              headers: { "content-type": "application/json" },
              // format 必须带实际值：宿主按它决定 multipart 的 filename/Content-Type。
              // 白名单是 webm/wav/mp3（src/host/routes/asr.ts），mp4 不在其中 → hostAsrFormat 已回落成 webm。
              body: JSON.stringify({ audio: wire.base64, format: wire.format })
            }, ASR_TIMEOUT_MS, ctl ? ctl.signal : void 0);
          } finally {
            if (ctl) asrAborts.delete(ctl);
          }
        };
        let res;
        try {
          res = await uploadOnce();
        } catch (e1) {
          if (ASR_RETRY_ONCE && e1 && e1.name === "AbortError" && running) {
            stats.asrRetry = (stats.asrRetry || 0) + 1;
            try {
              opts.onDiag && opts.onDiag({ stage: "asr-retry", hint: "识别超时，重试一次" });
            } catch (e) {
            }
            res = await uploadOnce();
          } else {
            throw e1;
          }
        }
        const data = await res.json();
        if (!running) return;
        if (data && data.error === "NO_KEY") {
          stats.asrFail++;
          stats.lastError = "asr: NO_KEY";
          asrNoKey = true;
          try {
            opts.onDiag && opts.onDiag({ stage: "asr-no-key", hint: String(data.hint || "") });
          } catch (e) {
          }
          return;
        }
        if (!data || !data.ok) {
          stats.asrFail++;
          stats.lastError = "asr: " + String(data && data.error || "failed");
          return;
        }
        try {
          const cur = diag2.getApe();
          diag2.setSegment({
            mode: epMode,
            fmt: wire.format,
            winMs: Math.round(performance.now() - seg.startedAt),
            peMs: cur ? cur.speechMs : seg.speechMs,
            quMs: cur ? cur.quietMs : seg.quietMs,
            floor: cur ? Math.round(cur.floorDb) : null,
            target: cur ? cur.quietTargetMs : null,
            text: String(data.text || "").slice(0, 24)
          });
        } catch (e) {
        }
        const text = String(data.text || "").trim();
        if (!text) return;
        stats.asrTexts++;
        const verdict = echoFilter.accept(text, Date.now(), thisSegId);
        if (verdict.ok) {
          stats.heard++;
          setStatus("thinking");
          try {
            opts.onHeard(text);
          } catch (e) {
          }
        } else if (verdict.reason === "short") {
          stats.shortDropped = (stats.shortDropped || 0) + 1;
        } else if (verdict.reason === "dup") {
          stats.dupDropped = (stats.dupDropped || 0) + 1;
        } else {
          stats.echoDropped++;
        }
      } catch (e) {
        stats.asrFail++;
        stats.lastError = e && e.name === "AbortError" ? "asr-ex: AbortError（超时/已停止）" : "asr-ex: " + String(e && e.name || e);
      } finally {
        if (statusHolder.get() === "recognizing") setStatus("listening");
        if (!rec || rec.state === "inactive") scheduleNext(150);
      }
    }
    function revokeUrl(u) {
      try {
        URL.revokeObjectURL(u);
      } catch (e) {
      }
      if (ttsUrl === u) ttsUrl = "";
    }
    function disposeTtsAudio() {
      try {
        if (ttsAudio) {
          ttsAudio.pause();
          ttsAudio.onended = null;
          ttsAudio.onerror = null;
        }
      } catch (e) {
      }
      ttsAudio = null;
      if (ttsUrl) {
        const u = ttsUrl;
        ttsUrl = "";
        try {
          URL.revokeObjectURL(u);
        } catch (e) {
        }
      }
    }
    function ttsDiag(job, failed, reason) {
      try {
        diag2.setTts({ failed, reason, text: job.text.slice(0, 20), at: Date.now() });
      } catch (e) {
      }
    }
    function ttsWatchdog() {
      try {
        const audioPlaying = !!(ttsAudio && !ttsAudio.paused && !ttsAudio.ended && ttsAudio.readyState > 0);
        const zombie = isPlaybackZombie({
          hasAudio: !!ttsAudio,
          audioPlaying,
          busy: ttsBusy,
          busySince: ttsBusySince,
          // 停滞按"最后一次有进展"算：长段播到一半卡住时，段开始时刻早就过阈值了，
          // 还用 busySince 会一上来就误判；播放进度、缓冲、开播都算有新进展。
          lastProgressAt: ttsProgressAt,
          synthAt: ttsSynthAt,
          now: Date.now(),
          zombieMs: TTS_ZOMBIE_MS,
          synthTimeoutMs: TTS_TIMEOUT_MS
        });
        if (!zombie) return;
        stats.ttsZombie++;
        const dead = ttsCurJob;
        ttsCurJob = null;
        speakToken++;
        if (dead) dead.token = speakToken;
        stopBrowserSpeech();
        ttsNextRetryAt = 0;
        disposeTtsAudio();
        ttsSynthAt = 0;
        ttsProgressAt = 0;
        ttsBusy = false;
        mutedUntil = Date.now() + ECHO_MUTE_MS;
        micOn(!muted);
        if (dead) {
          try {
            finishJob(dead);
          } catch (e) {
          }
        } else {
          pumpTts();
        }
        if (!ttsBusy && ttsQ.length === 0) {
          setTimeout(() => {
            try {
              if (!ttsBusy && !muted) micOn(true);
            } catch (e) {
            }
          }, ECHO_MUTE_MS);
        }
      } catch (e) {
      }
    }
    const ttsPrefetch = /* @__PURE__ */ new Map();
    const ttsAborts = /* @__PURE__ */ new Set();
    const asrAborts = /* @__PURE__ */ new Set();
    let ttsInflight = 0;
    let ttsSeq = 0;
    function synth(job) {
      const ctl = typeof AbortController !== "undefined" ? new AbortController() : null;
      if (ctl) ttsAborts.add(ctl);
      ttsInflight++;
      return fetchWithTimeout(apiBase + "/tts", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: job.text, voice: voiceName, rate: job.rate, pitch: job.pitch || "" })
      }, TTS_TIMEOUT_MS, ctl ? ctl.signal : void 0).then((r) => {
        if (!r.ok) throw new Error("tts-http-" + r.status);
        return r.arrayBuffer();
      }).catch((e) => {
        stats.lastError = "tts: " + String(e && e.name || e);
        if (!(ctl && ctl.signal.aborted)) ttsNoteSynthFail();
        return null;
      }).finally(() => {
        ttsInflight = Math.max(0, ttsInflight - 1);
        if (ctl) ttsAborts.delete(ctl);
      });
    }
    function prefetchUpcoming(narration) {
      if (ttsNextRetryAt > 0) return;
      if (ttsInCooldown()) return;
      const wants = prefetchTargets(ttsQ, narration, ttsInflight, (seq) => ttsPrefetch.has(seq), TTS_MAX_INFLIGHT);
      for (let i = 0; i < wants.length; i++) {
        const target = wants[i];
        ttsPrefetch.set(target.seq, synth(target));
      }
    }
    function keepBrowserProgress() {
      clearI(ttsBrowserKeep);
      ttsBrowserKeep = null;
      ttsProgressAt = Date.now();
      ttsBrowserKeep = setInterval(() => {
        ttsProgressAt = Date.now();
      }, TTS_WATCH_MS);
      return () => {
        if (!ttsBrowserKeep) return;
        clearI(ttsBrowserKeep);
        ttsBrowserKeep = null;
      };
    }
    function stopBrowserSpeech() {
      clearI(ttsBrowserKeep);
      ttsBrowserKeep = null;
      try {
        const s = window.speechSynthesis;
        if (s && typeof s.cancel === "function") s.cancel();
      } catch (e) {
      }
    }
    function ttsBrowserFallback(job, myToken) {
      try {
        disposeTtsAudio();
      } catch (e) {
      }
      try {
        stopBrowserSpeech();
      } catch (e) {
      }
      const canBrowser = !job.strict && browserVoiceUsable();
      if (job.strict || ttsSkipFailOn() || !canBrowser) {
        finishJob(job);
        return;
      }
      if (!muted) micOn(false);
      const stopKeep = keepBrowserProgress();
      speakViaBrowser(job.text).then(() => {
        stopKeep();
        if (myToken !== speakToken) return;
        finishJob(job);
      });
    }
    function finishJob(j) {
      clearI(ttsBrowserKeep);
      ttsBrowserKeep = null;
      ttsNextRetryAt = 0;
      ttsBusy = false;
      if (ttsCurJob === j) ttsCurJob = null;
      ttsProgressAt = 0;
      mutedUntil = Date.now() + ECHO_MUTE_MS;
      setTimeout(() => {
        if (!ttsBusy && !muted) micOn(true);
      }, ECHO_MUTE_MS);
      try {
        j.onDone && j.onDone();
      } catch (e) {
      }
      if (j.narration && ttsQ.length > 0) {
        const token = j.token;
        setTimeout(() => {
          if (isStaleToken(token, speakToken)) return;
          try {
            pumpTts();
          } catch (e) {
          }
        }, narrationPauseFor(j.text));
      } else {
        pumpTts();
      }
    }
    function pumpTts(force) {
      if (ttsBusy) return;
      if (ttsNextRetryAt > 0) {
        if (!force && Date.now() < ttsNextRetryAt) return;
        ttsNextRetryAt = 0;
      }
      const job = ttsQ.shift();
      if (!job) {
        setStatus("listening");
        return;
      }
      ttsBusy = true;
      ttsBusySince = Date.now();
      ttsProgressAt = Date.now();
      ttsCurJob = job;
      const myToken = ++speakToken;
      job.token = myToken;
      setStatus("speaking");
      stats.ttsRequests++;
      if (ttsInCooldown() && job.attempts <= 0) {
        ttsSynthAt = 0;
        ttsDiag(job, true, "cooldown");
        if (ttsSkipFailOn()) {
          finishJob(job);
          return;
        }
        ttsBrowserFallback(job, myToken);
        return;
      }
      const cached = ttsPrefetch.get(job.seq);
      const cur = cached || synth(job);
      if (cached) {
        ttsPrefetchGuard.hits++;
        ttsSyncDiag();
      } else {
        ttsPrefetchGuard.misses++;
        ttsSyncDiag();
      }
      ttsSynthAt = Date.now();
      ttsPrefetch.delete(job.seq);
      prefetchUpcoming(job.narration);
      cur.then((buf) => {
        if (myToken !== speakToken) return;
        ttsSynthAt = 0;
        if (!buf) {
          if (job.attempts < TTS_RETRY_MAX) {
            job.attempts++;
            ttsQ.unshift(job);
            ttsBusy = false;
            const backoff = ttsRetryDelayMs(job.attempts);
            ttsNextRetryAt = Date.now() + backoff;
            try {
              window.__chubbyWhale.ttsRetry = (window.__chubbyWhale.ttsRetry || 0) + 1;
            } catch (e) {
            }
            setTimeout(() => {
              if (myToken !== speakToken) return;
              try {
                pumpTts(true);
              } catch (e) {
              }
            }, backoff);
            return;
          }
          stats.ttsFail++;
          ttsDiag(job, true, "synth");
          try {
            const w = window.__chubbyWhale;
            w.ttsLost = w.ttsLost || [];
            w.ttsLost.push(job.text.slice(0, 16));
            if (w.ttsLost.length > 10) w.ttsLost.shift();
          } catch (e) {
          }
          ttsBrowserFallback(job, myToken);
          return;
        }
        ttsNoteSynthOk();
        try {
          opts.onSegment && opts.onSegment(job.text);
        } catch (e) {
        }
        const url = URL.createObjectURL(new Blob([buf], { type: "audio/mpeg" }));
        ttsUrl = url;
        const a = new Audio(url);
        ttsAudio = a;
        ttsProgressAt = Date.now();
        const bump2 = () => {
          ttsProgressAt = Date.now();
        };
        try {
          a.onplaying = bump2;
          a.ontimeupdate = bump2;
          a.onprogress = bump2;
          a.onloadeddata = bump2;
        } catch (e) {
        }
        const finish = (played) => {
          if (myToken !== speakToken) {
            revokeUrl(url);
            return;
          }
          try {
            a.onended = null;
            a.onerror = null;
          } catch (e) {
          }
          revokeUrl(url);
          ttsAudio = null;
          if (played) {
            stats.ttsPlayed++;
            ttsDiag(job, false);
          } else {
            stats.ttsFail++;
            ttsDiag(job, true, "play");
          }
          finishJob(job);
        };
        a.onended = () => finish(true);
        a.onerror = () => finish(false);
        micOn(false);
        a.play().catch(() => {
          if (myToken !== speakToken) {
            revokeUrl(url);
            return;
          }
          if (!muted) micOn(true);
          stats.ttsFail++;
          ttsDiag(job, true, "play");
          try {
            a.onended = null;
            a.onerror = null;
          } catch (e) {
          }
          revokeUrl(url);
          ttsAudio = null;
          if (job.attempts < 1) {
            job.attempts++;
            ttsQ.unshift(job);
            ttsBusy = false;
            setTimeout(() => {
              if (myToken !== speakToken) return;
              try {
                pumpTts();
              } catch (e) {
              }
            }, 250);
            return;
          }
          ttsBrowserFallback(job, myToken);
        });
      }).catch((e) => {
        try {
          stats.lastError = "tts-play: " + String(e && e.name || e);
        } catch (e2) {
        }
        if (myToken !== speakToken) return;
        ttsSynthAt = 0;
        disposeTtsAudio();
        stats.ttsFail++;
        ttsDiag(job, true, "exception");
        finishJob(job);
      });
    }
    function splitForTts(text, maxLen = 56) {
      const out = [];
      const src = String(text || "");
      if (!src.trim()) return out;
      if (maxLen < 8) maxLen = 8;
      const firstMax = Math.min(maxLen, 14);
      const isWordChar = function(ch) {
        return /[A-Za-z0-9]/.test(ch);
      };
      let sbuf = "";
      for (const c of src) {
        sbuf += c;
        const boundary = /[。，！？!?；;、,\n]/.test(c);
        const cap = out.length === 0 ? firstMax : maxLen;
        const atBoundary = boundary && sbuf.length >= Math.max(8, Math.floor(cap / 3));
        if (sbuf.length >= cap || atBoundary) {
          let cut = sbuf.length;
          if (!atBoundary) {
            const limit = Math.min(sbuf.length, cap);
            if (limit > 1 && isWordChar(sbuf[limit - 1])) {
              let back = limit;
              while (back > 0 && isWordChar(sbuf[back - 1])) back--;
              if (back > 0) cut = back;
            }
          }
          const seg2 = sbuf.slice(0, cut).trim();
          if (seg2) out.push(seg2);
          sbuf = sbuf.slice(cut);
        }
      }
      const rest = sbuf.trim();
      if (rest) out.push(rest);
      return out;
    }
    async function start() {
      asrNoKey = false;
      if (running) return;
      running = true;
      recMime = "";
      recFormat = "webm";
      levelOk = false;
      levelDead = false;
      try {
        const nav = typeof navigator !== "undefined" ? navigator : null;
        if (!nav || !nav.mediaDevices || typeof nav.mediaDevices.getUserMedia !== "function") {
          throw { name: "NoGetUserMedia" };
        }
        stream = await nav.mediaDevices.getUserMedia({
          audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 }
        });
        if (!running) {
          releaseAudio();
          return;
        }
        const Ctx = window.AudioContext || window.webkitAudioContext;
        if (!Ctx) throw { name: "NoAudioContext" };
        actx = new Ctx();
        try {
          await actx.resume();
        } catch (e) {
        }
        try {
          if (actx.state === "suspended") hookGestureResume();
        } catch (e) {
        }
        const srcNode = actx.createMediaStreamSource(stream);
        analyser = actx.createAnalyser();
        analyser.fftSize = 1024;
        analyser.smoothingTimeConstant = 0;
        timeBuf = new Float32Array(analyser.fftSize || 1024);
        try {
          srcNode.connect(analyser);
        } catch (e) {
        }
        levelProbeAt = performance.now();
        const Rec = typeof MediaRecorder !== "undefined" ? MediaRecorder : null;
        if (!Rec) throw { name: "NoMediaRecorder" };
        const picked = pickRecorderMime(Rec);
        recMime = picked.mimeType;
        recFormat = picked.format;
        try {
          rec = recMime ? new Rec(stream, { mimeType: recMime }) : new Rec(stream);
        } catch (e) {
          rec = new Rec(stream);
          recMime = "";
          recFormat = "webm";
        }
        try {
          opts.onDiag && opts.onDiag({ stage: "recorder", mime: recMime || "(default)", fmt: recFormat });
        } catch (e) {
        }
        rec.ondataavailable = (e) => {
          if (e.data && e.data.size > 0) addChunk(seg, e.data);
        };
        rec.onstop = () => {
          if (!running) {
            clearChunks(seg);
            return;
          }
          const blobType = String(rec && rec.mimeType || recMime || "audio/webm");
          const blob = takeBlob(seg, blobType);
          void onWindowDone(blob);
        };
        rec.onerror = (e) => {
          stats.lastError = "recorder: " + String(e && e.error && e.error.name);
          scheduleNext(800);
        };
        micOn(true);
        setStatus("listening");
        beginWindow();
        if (ttsWatch) clearInterval(ttsWatch);
        ttsWatch = setInterval(ttsWatchdog, TTS_WATCH_MS);
        stats.lastError = "";
      } catch (e) {
        running = false;
        stats.lastError = "start: " + String(e && e.name || e);
        setStatus("idle");
        try {
          unhookGestureResume();
        } catch (e2) {
        }
        try {
          releaseAudio();
        } catch (e2) {
        }
        try {
          opts.onDiag && opts.onDiag({ stage: "start-failed", err: stats.lastError });
        } catch (e2) {
        }
      }
    }
    function stop() {
      running = false;
      try {
        for (const c of asrAborts) {
          try {
            c.abort();
          } catch (e) {
          }
        }
      } catch (e) {
      }
      try {
        asrAborts.clear();
      } catch (e) {
      }
      if (tickTimer) {
        clearTimeout(tickTimer);
        tickTimer = null;
      }
      if (restartTimer) {
        clearTimeout(restartTimer);
        restartTimer = null;
      }
      if (ttsWatch) {
        clearInterval(ttsWatch);
        ttsWatch = null;
      }
      try {
        stopSpeaking();
      } catch (e) {
      }
      try {
        unhookGestureResume();
      } catch (e) {
      }
      levelProbeAt = 0;
      levelOk = false;
      levelDead = false;
      try {
        releaseAudio();
      } catch (e) {
      }
      try {
        echoFilter.reset();
      } catch (e) {
      }
      setStatus("idle");
    }
    function speak(text, o) {
      const raw = stripStageDirections(String(text || ""));
      if (!raw) return;
      const narration = o && typeof o.narration === "boolean" ? o.narration : raw.length >= 80;
      const rate = o && o.rate ? o.rate : narration ? narrationRate() : "+0%";
      const strict = !!(o && o.strict);
      const segs = splitForTts(raw, 56);
      if (!segs.length) return;
      echoFilter.noteSpoken(raw);
      const jobs = buildTtsJobs(segs, {
        rate,
        narration,
        strict,
        nextSeq: ttsSeq + 1,
        onDone: o && o.onDone
      });
      ttsSeq += segs.length;
      for (let i = 0; i < jobs.length; i++) ttsQ.push(jobs[i]);
      const droppedQ = capQueue(ttsQ);
      if (droppedQ > 0) stats.qDropped = (stats.qDropped || 0) + droppedQ;
      prefetchUpcoming(!!(ttsQ[0] && ttsQ[0].narration));
      pumpTts();
    }
    function stopSpeaking() {
      ttsSynthAt = 0;
      ttsProgressAt = 0;
      ttsCurJob = null;
      speakToken++;
      ttsQ.length = 0;
      try {
        ttsPrefetch.clear();
      } catch (e) {
      }
      try {
        for (const c of ttsAborts) {
          try {
            c.abort();
          } catch (e) {
          }
        }
      } catch (e) {
      }
      try {
        ttsAborts.clear();
      } catch (e) {
      }
      disposeTtsAudio();
      ttsBusy = false;
      ttsNextRetryAt = 0;
      stopBrowserSpeech();
      if (!muted) micOn(true);
      mutedUntil = Date.now() + ECHO_MUTE_MS;
      setStatus(running ? "listening" : "idle");
    }
    return {
      start,
      stop,
      speak,
      stopSpeaking,
      speaking: () => ttsBusy,
      recognizing: () => statusHolder.get() === "recognizing",
      setEndpointMode: (m) => {
        epMode = normalizeEndpointMode(m);
        writeEndpointMode(epMode);
      },
      // 端点检测：报告当前实际生效的模式（ape / classic），不再写死 classic
      endpointInfo: () => ({ mode: epMode }),
      lastSegment: () => diag2.getSegment(),
      lastTtsInfo: () => diag2.getTts(),
      // 立即换音色：下一个 /tts 请求就带新 voice（不重建实例）；白名单外的值不改
      setVoiceName: (n) => {
        voiceName = normalizeVoiceName(n, voiceName);
      },
      voiceName: () => voiceName,
      mute: (on) => {
        muted = on;
        micOn(!on);
      },
      stats,
      status: () => statusHolder.get()
    };
  }

  // src/client/menu.ts
  function item(label, action) {
    return { type: "item", label, action };
  }
  function sub(label, items) {
    return { type: "sub", label, items };
  }
  function sep() {
    return { type: "sep" };
  }
  function rateSub(prefix, action, current, opts) {
    return sub(prefix + current + " ▸", opts.map(([rate, text]) => item((rate === current ? "✓ " : "") + text, action + rate)));
  }
  var MELODIES = ["小星星", "两只老虎", "生日快乐", "欢乐颂", "铃儿响叮当", "伦敦大桥", "斯卡布罗集市", "思君黯然", "绿袖子", "致爱丽丝", "友谊天长地久"];
  deepFreeze(MELODIES);
  var SONG_EN = {
    "小星星": "Twinkle Twinkle Little Star",
    "两只老虎": "Two Tigers",
    "生日快乐": "Happy Birthday",
    "欢乐颂": "Ode to Joy",
    "铃儿响叮当": "Jingle Bells",
    "伦敦大桥": "London Bridge",
    "斯卡布罗集市": "Scarborough Fair",
    "思君黯然": "Longing for You",
    "绿袖子": "Greensleeves",
    "致爱丽丝": "Fur Elise",
    "友谊天长地久": "Auld Lang Syne"
  };
  deepFreeze(SONG_EN);
  var EN_MAP = {
    "投喂一碗": "Feed a bowl",
    "选本书 ▸": "Choose a book ▸",
    "书单没取到，稍后再试": "Book list unavailable, try again later",
    "正在翻书单…": "Loading book list…",
    "今日一句": "Daily quote",
    "今日简报": "Today's briefing",
    "数据导出…": "Export data…",
    "数据导入…": "Import data…",
    "使用统计": "Usage stats",
    "设置 ▸": "Settings ▸",
    "查看当前配置": "View current config",
    "提醒管理…": "Manage reminders…",
    "唤醒恢复": "Wake recovery",
    "唤醒词 ▸": "Wake word ▸",
    "默认（大肥鱼/肥鲸等）": "Default (Da Fei Yu / Fei Jing)",
    "大肥鱼": "Da Fei Yu",
    "肥鲸": "Fei Jing",
    "小鲸": "Xiao Jing",
    "自定义…": "Custom…",
    "弹首曲子 ▸": "Play a song ▸",
    "停止弹奏": "Stop music",
    "跟她说两句": "Talk to her",
    "换个声音 ▸": "Change voice ▸",
    "聊天语言 ▸": "Chat language ▸",
    "界面语言 ▸": "Interface language ▸",
    "看张图…": "Look at a picture…",
    "停止说话": "Stop talking",
    "让她歇会儿": "Let her rest",
    "回碗里待着": "Back in the bowl",
    "长大一点": "Grow bigger",
    "变小一点": "Shrink",
    "记个饭点…": "Add a meal reminder…",
    "提醒清单…": "Reminders…",
    "端点检测：经典/自适应": "Endpoint detection: classic / adaptive",
    "耳朵自检（听力诊断）": "Hearing self-test",
    "文化气 ▸": "Culture ▸",
    "说书（连载）": "Storytelling",
    "稍快 -25%": "A bit faster -25%",
    "适中 -30%": "Medium -30%",
    "偏慢 -35%（默认）": "Slower -35% (default)",
    "正常 -10%": "Normal -10%",
    "偏慢 -20%（默认）": "Slow -20% (default)",
    "很慢 -25%": "Very slow -25%",
    "更慢 -30%": "Even slower -30%",
    "稍快 -15%": "A bit faster -15%",
    "适中 -20%": "Medium -20%",
    "偏慢 -25%（默认）": "Slower -25% (default)",
    "很慢 -30%": "Very slow -30%",
    "很慢 -40%": "Very slow -40%",
    "接着说": "Continue story",
    "从头讲这本书": "Restart this book",
    "念首诗": "Recite a poem",
    "讲个民间故事": "Folk tale",
    "讲个典故": "Classic allusion",
    "成语辨析": "Idiom",
    "出个对联 ▸": "Couplets ▸",
    "随机一副": "Random pair",
    "春联": "Spring couplet",
    "格言": "Motto",
    "谐趣": "Witty",
    "名胜": "Landmarks",
    "景观": "Scenery",
    "书房": "Study",
    "书院": "Academy",
    "寿联": "Birthday couplet",
    "中药": "Herbs",
    "叠字": "Repeated characters",
    "数字": "Numerals",
    "清除记忆…": "Clear memory…",
    "清空聊天缓存…": "Clear chat cache…",
    "让它游走（退出）": "Let it go (exit)",
    "鱼粮账本": "Token ledger",
    "English": "English",
    "中文": "Chinese",
    // 动态 label（音色勾选/聊天缓存开关/自动）需要的英文键
    "聊天缓存：开": "Chat cache: on",
    "聊天缓存：关": "Chat cache: off",
    "自动（按语言选音色）": "Auto (by language)",
    "自动": "Auto",
    "音色：晓伊（中·女）": "Voice: Xiaoyi (CN F)",
    "音色：晓晓（中·女）": "Voice: Xiaoxiao (CN F)",
    "音色：晓辰（中·女）": "Voice: Xiaochen (CN F)",
    "音色：云希（中·男）": "Voice: Yunxi (CN M)",
    "音色：云扬（中·男）": "Voice: Yunyang (CN M)",
    "音色：Ana（英·女）": "Voice: Ana (EN F)",
    "音色：Jenny（英·女）": "Voice: Jenny (EN F)",
    "音色：Sonia（英·女·英式）": "Voice: Sonia (EN-GB F)"
  };
  deepFreeze(EN_MAP);
  var STAGE_EN = {
    "初识": "New",
    "熟悉": "Familiar",
    "亲密": "Close",
    "知心": "Confidant",
    "家人": "Family"
  };
  deepFreeze(STAGE_EN);
  var TOGGLE_EN = {
    "语音朗读：": ["Voice output: on", "Voice output: off"],
    "语音待命：": ["Voice standby: on", "Voice standby: off"],
    "语音聊天：": ["Voice chat: on", "Voice chat: off"],
    "流式回复：": ["Streaming replies: on", "Streaming replies: off"]
  };
  function tr(label, lang) {
    if (lang !== "en") return label;
    const exact = EN_MAP[label];
    if (exact) return exact;
    if (label.startsWith("✓ ")) {
      const base = label.slice(2);
      const en = tr(base, lang);
      return en === base ? label : "✓ " + en;
    }
    if (label.startsWith("弹《") && label.endsWith("》")) {
      const song = label.slice(2, label.length - 1);
      return SONG_EN[song] ? 'Play "' + SONG_EN[song] + '"' : "Play a song";
    }
    if (label.startsWith("成长：")) {
      const rest = label.slice(3);
      const m = rest.match(/^(初识|熟悉|亲密|知心|家人)([\s\S]*)$/);
      if (!m) return "Growth: " + rest;
      const tail = String(m[2] || "").replace(/（/g, "(").replace(/）/g, ")");
      return "Growth: " + (STAGE_EN[m[1]] || m[1]) + tail;
    }
    if (label.startsWith("版本：v")) return "Version: v" + label.slice(4);
    if (label.startsWith("余额：")) return "Balance: " + label.slice(3);
    for (const prefix of Object.keys(TOGGLE_EN)) {
      if (label.startsWith(prefix)) {
        const pair = TOGGLE_EN[prefix];
        return label.slice(prefix.length) === "开" ? pair[0] : pair[1];
      }
    }
    if (label.startsWith("说书语速：")) return label.replace("说书语速：", "Story speed: ");
    if (label.startsWith("连播：")) return label.indexOf("开") >= 0 ? "Auto-continue: on" : "Auto-continue: off";
    if (label.startsWith("念诗语速：")) return label.replace("念诗语速：", "Poem speed: ");
    if (label.startsWith("叙述语速：")) return label.replace("叙述语速：", "Narration speed: ");
    if (label.startsWith("聊天语速：")) return label.replace("聊天语速：", "Chat speed: ");
    return label;
  }
  var VOICE_ITEMS = [
    ["zh-CN-XiaoyiNeural", "音色：晓伊（中·女）"],
    ["zh-CN-XiaoxiaoNeural", "音色：晓晓（中·女）"],
    ["zh-CN-XiaochenNeural", "音色：晓辰（中·女）"],
    ["zh-CN-YunxiNeural", "音色：云希（中·男）"],
    ["zh-CN-YunyangNeural", "音色：云扬（中·男）"],
    ["en-US-AnaNeural", "音色：Ana（英·女）"],
    ["en-US-JennyNeural", "音色：Jenny（英·女）"],
    ["en-GB-SoniaNeural", "音色：Sonia（英·女·英式）"]
  ];
  var STORY_RATE_ITEMS = [["-25%", "稍快 -25%"], ["-30%", "适中 -30%"], ["-35%", "偏慢 -35%（默认）"], ["-40%", "很慢 -40%"]];
  var CHAT_RATE_ITEMS = [["-10%", "正常 -10%"], ["-20%", "偏慢 -20%（默认）"], ["-25%", "很慢 -25%"], ["-30%", "更慢 -30%"]];
  var NARRATION_RATE_ITEMS = [["-15%", "稍快 -15%"], ["-20%", "适中 -20%"], ["-25%", "偏慢 -25%（默认）"], ["-30%", "很慢 -30%"]];
  function buildMenu(version, state = {}) {
    const voiceOn = state.voiceOn ? true : false;
    const earOn = state.earOn ? true : false;
    const voiceChatOn = state.voiceChatOn ? true : false;
    const chatLang = (() => {
      const v = state.chatLang ? String(state.chatLang) : "";
      return v === "zh" || v === "en" ? v : "auto";
    })();
    const ttsVoice = normalizeVoiceName(state.ttsVoice);
    const chatCacheOn = !(state.chatCacheOn === false);
    const voiceTick = (voice) => ttsVoice === voice ? "✓ " : "";
    const growthText = state && state.growth ? state.growth : "--";
    const books = Array.isArray(state.storyBooks) ? state.storyBooks.map((b) => String(b || "").trim()).filter(Boolean) : [];
    const bookItems = books.length ? books.map((b) => item(b, "story-book:" + b)) : [item(state.storyBooksTried ? "书单没取到，稍后再试" : "正在翻书单…", "story-books")];
    return [
      // ── 界面语言（主人定的位置：标题栏下方第一行）──
      sub("界面语言 ▸", [
        item("中文", "lang:zh"),
        item("English", "lang:en")
      ]),
      // ── 吃饭与看图 ──
      item("成长：" + growthText, "growth"),
      item("投喂一碗", "feed"),
      item("看张图…", "vision"),
      sep(),
      // ── 曲子 ──
      sub("弹首曲子 ▸", MELODIES.map((m) => item("弹《" + m + "》", "music:" + m))),
      item("停止弹奏", "music-stop"),
      sep(),
      // ── 说话与耳朵（语音类全放一起）──
      item("跟她说两句", "type"),
      item(voiceOn ? "语音朗读：开" : "语音朗读：关", "voice"),
      item("停止说话", "tts-stop"),
      sub("换个声音 ▸", [
        ...VOICE_ITEMS.map(([voice, label]) => item(voiceTick(voice) + label, "voice:" + voice)),
        item(voiceTick("auto") + "自动（按语言选音色）", "voice:auto")
      ]),
      sub("唤醒词 ▸", [
        item("默认（大肥鱼/肥鲸等）", "wake-word:"),
        item("大肥鱼", "wake-word:大肥鱼"),
        item("肥鲸", "wake-word:肥鲸"),
        item("小鲸", "wake-word:小鲸"),
        item("自定义…", "wake-word:custom")
      ]),
      item("语音待命：" + (earOn ? "开" : "关"), "wake"),
      item("语音聊天：" + (voiceChatOn ? "开" : "关"), "chatmode"),
      item("流式回复：" + (state.streamOn === false ? "关" : "开"), "stream-toggle"),
      item("端点检测：经典/自适应", "endpoint"),
      item("耳朵自检（听力诊断）", "ear-check"),
      sep(),
      // ── 语言 ──
      sub("聊天语言 ▸", [
        item((chatLang === "auto" ? "✓ " : "") + "自动", "chat-lang:auto"),
        item((chatLang === "zh" ? "✓ " : "") + "中文", "chat-lang:zh"),
        item((chatLang === "en" ? "✓ " : "") + "English", "chat-lang:en")
      ]),
      sep(),
      // ── 位置与大小 ──
      item("让她歇会儿", "pause"),
      item("回碗里待着", "home"),
      item("长大一点", "bigger"),
      item("变小一点", "smaller"),
      sep(),
      // ── 饭点提醒 ──
      item("记个饭点…", "remind-add"),
      item("提醒清单…", "remind-list"),
      sep(),
      // ── 文化气 ──
      sub("文化气 ▸", [
        item("说书（连载）", "culture-story"),
        item("连播：" + (state.storyAuto === false ? "关" : "开") + "（讲完一段自动接下一段）", "story-auto"),
        rateSub("说书语速：", "story-rate:", state.storyRate || "-35%", STORY_RATE_ITEMS),
        item("接着说", "culture-story-next"),
        item("从头讲这本书", "story-reset"),
        item("念首诗", "poem"),
        rateSub("聊天语速：", "chat-rate:", state.chatRate || "-20%", CHAT_RATE_ITEMS),
        rateSub("叙述语速：", "narration-rate:", state.narrationRate || "-25%", NARRATION_RATE_ITEMS),
        rateSub("念诗语速：", "poem-rate:", state.poemRate || "-25%", NARRATION_RATE_ITEMS),
        item("讲个民间故事", "culture-tale"),
        item("讲个典故", "culture-allusion"),
        item("成语辨析", "culture-idiom"),
        sub("出个对联 ▸", [
          item("随机一副", "culture-couplet"),
          item("春联", "culture-couplet:春联"),
          item("格言", "culture-couplet:格言"),
          item("谐趣", "culture-couplet:谐趣"),
          item("名胜", "culture-couplet:名胜"),
          item("景观", "culture-couplet:景观"),
          item("书院", "culture-couplet:书院"),
          item("书房", "culture-couplet:书房"),
          item("寿联", "culture-couplet:寿联"),
          item("中药", "culture-couplet:中药"),
          item("叠字", "culture-couplet:叠字"),
          item("数字", "culture-couplet:数字")
        ])
      ]),
      sep(),
      // ── 每日内容（说书选本 / 每日一句 / 今日简报）──
      sub("选本书 ▸", bookItems),
      item("今日一句", "daily-line"),
      item("今日简报", "briefing-card"),
      sep(),
      // ── 数据与统计（处理器由其他分身实现，未接上时走兜底提示）──
      item("数据导出…", "data-export"),
      item("数据导入…", "data-import"),
      item("使用统计", "stats"),
      sub("设置 ▸", [
        item("查看当前配置", "config-view")
      ]),
      item("提醒管理…", "remind-manage"),
      item("唤醒恢复", "wake-recover"),
      sep(),
      // ── 记忆、缓存与退出 ──
      item("清除记忆…", "clear-memory"),
      item("清空聊天缓存…", "cache-clear"),
      item(chatCacheOn ? "聊天缓存：开" : "聊天缓存：关", "cache-toggle"),
      item("让它游走（退出）", "hide"),
      sep(),
      // ── 账本与版本（版本永远在最底下）──
      item("鱼粮账本", "fishfood")
    ];
  }

  // src/client/narration-progress.ts
  function createProgress() {
    let current = null;
    function index() {
      if (!current) return 0;
      const eff = current.spoken - current.introLen;
      if (eff < 0) return 0;
      let done = 0;
      for (const c of current.cum) {
        if (c <= eff) done++;
      }
      const total = current.cum.length;
      return Math.min(total, done + 1);
    }
    return {
      start(label, lines, intro = "") {
        const lens = (lines || []).map((l) => String(l || "").replace(/\s+/g, "").length).filter((n) => n > 0);
        const cum = [];
        let sum = 0;
        for (const n of lens) {
          sum += n;
          cum.push(sum);
        }
        current = {
          label: String(label || ""),
          cum,
          introLen: String(intro || "").replace(/\s+/g, "").length,
          spoken: 0
        };
      },
      stop() {
        current = null;
      },
      active() {
        return current !== null;
      },
      index,
      bump(segment) {
        if (!current) return "";
        const seg = String(segment || "");
        const idx = index();
        current.spoken += seg.replace(/\s+/g, "").length;
        const total = current.cum.length;
        const head = total > 0 && idx > 0 ? current.label + "（第 " + idx + "/" + total + " 句）" : current.label;
        return head + (seg.trim() ? "：" + seg.trim() : "");
      }
    };
  }
  var defaultProgress = createProgress();
  var startProgress = defaultProgress.start;
  var stopProgress = defaultProgress.stop;
  var progressActive = defaultProgress.active;
  var progressIndex = defaultProgress.index;
  var bumpProgress = defaultProgress.bump;

  // src/client/image.ts
  var DEFAULT_MAX_EDGE = 1280;
  var DEFAULT_QUALITY = 0.85;
  var KEEP_RAW_BELOW = 400 * 1024;
  function readFileAsDataUrl(file) {
    return new Promise((resolve) => {
      try {
        const fr = new FileReader();
        fr.onloadend = () => {
          try {
            resolve(String(fr.result || ""));
          } catch (e) {
            resolve("");
          }
        };
        fr.onerror = () => resolve("");
        fr.readAsDataURL(file);
      } catch (e) {
        resolve("");
      }
    });
  }
  function mimeFromDataUrl(dataUrl) {
    const m = /^data:([^;,]+)/i.exec(String(dataUrl || ""));
    return m ? m[1].toLowerCase() : "";
  }
  function decodeImage(file) {
    return new Promise((resolve) => {
      try {
        const w = typeof window !== "undefined" ? window : globalThis;
        if (typeof w.createImageBitmap === "function") {
          let p;
          try {
            p = w.createImageBitmap(file, { imageOrientation: "from-image" });
          } catch (e) {
            p = w.createImageBitmap(file);
          }
          Promise.resolve(p).then((bmp) => resolve(bmp)).catch(() => {
            try {
              Promise.resolve(w.createImageBitmap(file)).then((bmp) => resolve(bmp)).catch(() => resolve(null));
            } catch (e) {
              resolve(null);
            }
          });
          return;
        }
        const URLRef = w.URL || globalThis.URL;
        const ImageRef = w.Image;
        if (!URLRef || typeof URLRef.createObjectURL !== "function" || typeof ImageRef !== "function") {
          resolve(null);
          return;
        }
        const url = URLRef.createObjectURL(file);
        const img = new ImageRef();
        const done = (v) => {
          try {
            URLRef.revokeObjectURL(url);
          } catch (e) {
          }
          resolve(v);
        };
        img.onload = () => done(img);
        img.onerror = () => done(null);
        img.src = url;
      } catch (e) {
        resolve(null);
      }
    });
  }
  async function imageToB64(file, opts) {
    const dataUrl = await readFileAsDataUrl(file);
    const at = dataUrl.indexOf(",");
    const raw = at >= 0 ? dataUrl.slice(at + 1) : dataUrl;
    if (!raw) return null;
    const rawMime = mimeFromDataUrl(dataUrl) || String(file && file.type || "image/jpeg");
    const rawResult = { b64: raw, mime: rawMime, width: 0, height: 0, compressed: false };
    try {
      const declared = Number(file && file.size);
      const rawBytes = isFinite(declared) && declared > 0 ? declared : Math.ceil(raw.length * 3 / 4);
      if (rawBytes <= KEEP_RAW_BELOW) return rawResult;
      const maxEdge = Math.max(256, Math.min(4096, Math.round(Number(opts && opts.maxEdge) || DEFAULT_MAX_EDGE)));
      const quality = Math.min(0.95, Math.max(0.5, Number(opts && opts.quality) || DEFAULT_QUALITY));
      const img = await decodeImage(file);
      if (!img) return rawResult;
      try {
        const iw = Math.max(1, Number(img.width || img.naturalWidth) || 1);
        const ih = Math.max(1, Number(img.height || img.naturalHeight) || 1);
        const scale = Math.min(1, maxEdge / Math.max(iw, ih));
        const w = Math.max(1, Math.round(iw * scale));
        const h = Math.max(1, Math.round(ih * scale));
        const doc = typeof document !== "undefined" ? document : null;
        if (!doc || typeof doc.createElement !== "function") return rawResult;
        const canvas = doc.createElement("canvas");
        canvas.width = w;
        canvas.height = h;
        const cx = canvas.getContext && canvas.getContext("2d");
        if (!cx || typeof canvas.toDataURL !== "function") return rawResult;
        if (typeof cx.fillRect === "function") {
          cx.fillStyle = "#fff";
          cx.fillRect(0, 0, w, h);
        }
        cx.drawImage(img, 0, 0, w, h);
        const out = String(canvas.toDataURL("image/jpeg", quality) || "");
        const cut = out.indexOf(",");
        const b64 = cut >= 0 ? out.slice(cut + 1) : "";
        if (!b64) return rawResult;
        if (b64.length >= raw.length) return rawResult;
        return { b64, mime: "image/jpeg", width: w, height: h, compressed: true };
      } finally {
        try {
          if (img && typeof img.close === "function") img.close();
        } catch (e) {
        }
      }
    } catch (e) {
      return rawResult;
    }
  }

  // src/client/dropzone.ts
  var MAX_DROP_BYTES = 4 * 1024 * 1024;
  var MAX_TEXT_CHARS = 4e3;
  var VISION_PROMPT = "看看这张图，说说你看到了什么";
  var MAX_IMAGE_B64_CHARS = 4 * 1024 * 1024;
  var TEXT_EXTS = [".txt", ".md", ".json", ".log", ".csv"];
  function isImageFile(file) {
    return Boolean(file && typeof file.type === "string" && file.type.indexOf("image/") === 0);
  }
  function isTextFile(file) {
    const name = String(file && file.name || "").toLowerCase();
    for (const ext of TEXT_EXTS) {
      if (name.slice(-ext.length) === ext) return true;
    }
    return false;
  }
  function buildTextPrompt(text) {
    return "总结一下这篇文档：\n" + String(text || "").slice(0, MAX_TEXT_CHARS);
  }
  function readTextFile(file) {
    try {
      if (file && typeof file.text === "function") {
        return Promise.resolve(file.text()).then((t) => str(t)).catch(() => readTextViaReader(file));
      }
    } catch (e) {
    }
    return readTextViaReader(file);
  }
  function readTextViaReader(file) {
    return new Promise((resolve) => {
      try {
        if (typeof FileReader === "undefined") {
          resolve("");
          return;
        }
        const fr = new FileReader();
        fr.onloadend = () => {
          try {
            resolve(String(fr.result || ""));
          } catch (e) {
            resolve("");
          }
        };
        fr.onerror = () => resolve("");
        fr.readAsText(file);
      } catch (e) {
        resolve("");
      }
    });
  }
  async function handleFileDrop(file, deps) {
    const d = deps || {};
    const bubble = typeof d.showBubble === "function" ? d.showBubble : () => {
    };
    const speak = typeof d.speakText === "function" ? d.speakText : null;
    const doFetch = d.fetchImpl || (typeof fetch !== "undefined" ? fetch : null);
    if (!file) {
      bubble("没拿到文件，再拖一次试试", 4e3);
      return { ok: false, kind: "empty", error: "no file" };
    }
    const size = Number(file.size) || 0;
    if (size > MAX_DROP_BYTES) {
      bubble("文件太大啦（超过 4MB），本鱼一口吃不下", 5e3);
      return { ok: false, kind: "too-large", error: "too large" };
    }
    if (!doFetch) {
      bubble("本鱼连不上服务器", 4e3);
      return { ok: false, kind: "error", error: "no fetch" };
    }
    const post = async (body) => {
      const r = await doFetch("/api/chubby-whale/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body)
      });
      let data = null;
      try {
        data = await r.json();
      } catch (e) {
        data = null;
      }
      const status = Number(r && r.status) || 0;
      if (!data || r && r.ok === false || data.ok === false) {
        const msg = String(data && (data.reply || data.error) || "").trim() || "请求失败" + (status ? "（HTTP " + status + "）" : "");
        const err = new Error(msg);
        err.reply = msg;
        err.status = status;
        throw err;
      }
      return data;
    };
    const fail = (e, fallback) => {
      const msg = String(e && (e.reply || e.message) || e || "").trim() || fallback;
      bubble(msg, 5e3);
      const tooLarge = Number(e && e.status) === 413;
      return {
        ok: false,
        kind: tooLarge ? "too-large" : "error",
        error: msg,
        reply: e && e.reply ? String(e.reply) : void 0
      };
    };
    if (isImageFile(file)) {
      bubble("本鲸看看这张图…", 3e3);
      const img0 = await imageToB64(file);
      const b64 = img0 ? img0.b64 : "";
      const mime = img0 && img0.mime || file.type || "image/jpeg";
      if (!b64) {
        bubble("图片读不出来，再拖一次试试", 4e3);
        return { ok: false, kind: "error", error: "empty image" };
      }
      if (b64.length > MAX_IMAGE_B64_CHARS) {
        bubble("这张图太大啦（原图超过约 3MB），本鲸一口吞不下，换张小一点的再发吧～", 5e3);
        return { ok: false, kind: "too-large", error: "image too large" };
      }
      try {
        const reply0 = await post({ message: VISION_PROMPT, image: b64, imageMime: mime });
        const reply = String(reply0 && reply0.reply || "").trim() || "这条鱼看不懂这张图……";
        bubble("（看图）" + reply, 1e4);
        if (speak) speak(reply);
        return { ok: true, kind: "image", message: VISION_PROMPT, reply };
      } catch (e) {
        return fail(e, "图片处理失败");
      }
    }
    if (isTextFile(file)) {
      const text = String(await readTextFile(file) || "");
      if (!text.trim()) {
        bubble("这个文件里没读到字", 4e3);
        return { ok: false, kind: "error", error: "empty text" };
      }
      const message = buildTextPrompt(text);
      bubble("本鲸看看这份文档…", 3e3);
      try {
        const reply0 = await post({ message });
        const reply = String(reply0 && reply0.reply || "").trim() || "这份文档本鲸没看懂……";
        bubble("（文档）" + reply, 12e3);
        if (speak) speak(reply);
        return { ok: true, kind: "text", message, reply };
      } catch (e) {
        return fail(e, "文档处理失败");
      }
    }
    bubble("这个格式本鱼还不会看", 4e3);
    return { ok: false, kind: "unsupported", error: "unsupported type" };
  }

  // src/shared/growth.ts
  var GROWTH_STAGES = [
    { exp: 0, name: "初识" },
    { exp: 200, name: "熟悉" },
    { exp: 800, name: "亲密" },
    { exp: 2500, name: "知心" },
    { exp: 5e3, name: "家人" }
  ];
  deepFreeze(GROWTH_STAGES);
  function growthStage(exp) {
    let idx = 0;
    for (let i = 0; i < GROWTH_STAGES.length; i++) {
      if (exp >= GROWTH_STAGES[i].exp) idx = i;
    }
    const next = idx + 1 < GROWTH_STAGES.length ? GROWTH_STAGES[idx + 1].exp : 0;
    return { index: idx, name: GROWTH_STAGES[idx].name, nextExp: next };
  }

  // src/client/look.ts
  var TIER_EXP = [0, 200, 800];
  deepFreeze(TIER_EXP);
  var TIER_NAMES = ["初识", "熟络", "黏人"];
  deepFreeze(TIER_NAMES);
  var LOOKS = [
    { tier: 0, label: "初识", scale: 1, dots: 2, halo: 0, tailEveryMs: 14e3 },
    { tier: 1, label: "熟络", scale: 1.04, dots: 4, halo: 0.12, tailEveryMs: 9e3 },
    { tier: 2, label: "黏人", scale: 1.08, dots: 6, halo: 0.22, tailEveryMs: 5500 }
  ];
  deepFreeze(LOOKS);
  function tierOf(exp) {
    const e = Number(exp);
    if (Number.isNaN(e) || e <= 0) return 0;
    for (let i = TIER_EXP.length - 1; i > 0; i--) {
      if (e >= TIER_EXP[i]) return i;
    }
    return 0;
  }
  function lookFor(exp) {
    return LOOKS[tierOf(exp)];
  }
  function lookForGrowth(info) {
    if (!info || typeof info.exp !== "number") return LOOKS[0];
    return LOOKS[tierOf(info.exp)];
  }
  var DEFAULT_GROWTH = { exp: 0, stage: "初识", nextExp: 200, tier: 0 };
  deepFreeze(DEFAULT_GROWTH);
  function parseGrowth(d) {
    if (!d || typeof d !== "object" || !d.ok) return null;
    const raw = Number(d.exp);
    if (!isFinite(raw)) return null;
    const exp = Math.max(0, Math.floor(raw));
    const tier = tierOf(exp);
    const host = growthStage(exp);
    const n = Number(d.nextExp);
    let nextExp = 0;
    if (isFinite(n) && n >= 0) nextExp = Math.floor(n);
    else nextExp = host.nextExp;
    const stage = typeof d.stage === "string" && d.stage ? d.stage : host.name;
    return { exp, stage, nextExp, tier };
  }
  function fetchGrowth(getJson2) {
    try {
      return Promise.resolve(getJson2("/growth", { cache: "no-store" })).then((d) => parseGrowth(d)).catch(() => null);
    } catch (e) {
      return Promise.resolve(null);
    }
  }

  // src/client/anim.ts
  var EYE_L = { x: 679, y: 430, r: 68 };
  deepFreeze(EYE_L);
  var EYE_R = { x: 860, y: 435, r: 68 };
  deepFreeze(EYE_R);
  var MOUTH = { x: 779, y: 525, rw: 26, rh: 18 };
  deepFreeze(MOUTH);
  var FIN_DOTS = [
    { x: 308, y: 115 },
    { x: 317, y: 113 },
    { x: 326, y: 116 },
    { x: 334, y: 120 },
    { x: 343, y: 125 },
    { x: 350, y: 131 }
  ];
  var TAIL_TIP = { x: 391, y: 270 };
  var WAG_MS = 900;
  var WAG_JITTER = 0.2;
  var HALO = { x: 240, y: 228, r0: 30, r1: 252 };
  var DOT_BREATH_MS = 620;
  var TAU = Math.PI * 2;
  var MAINTAIN_EVERY = 30;
  var HEART_MAX = 8;
  function pickDotIndexes(count) {
    const n = FIN_DOTS.length;
    const c = Math.max(2, Math.min(n, Math.round(Number(count)) || 2));
    if (c >= n) return [0, 1, 2, 3, 4, 5];
    const out = [];
    for (let i = 0; i < c; i++) out.push(Math.round(i * (n - 1) / (c - 1)));
    return out;
  }
  function createAnimator(opts) {
    const { canvas, imgSrc, cw, ch, sx, sy, state } = opts;
    const ctx = canvas && typeof canvas.getContext === "function" ? canvas.getContext("2d") : null;
    if (!ctx) {
      let fallbackLook = opts.look || lookFor(0);
      return {
        start() {
        },
        stop() {
        },
        talkFor(_ms) {
        },
        pushHeart() {
        },
        // 取不到上下文时动画无法重建，但外观数据仍要跟上成长（否则 getLook 永远停在初识档）
        setLook(next) {
          fallbackLook = next || lookFor(0);
        },
        getLook() {
          return fallbackLook;
        }
      };
    }
    const img = new Image();
    img.src = imgSrc;
    let raf = 0;
    let running = false;
    let last = performance.now();
    let blinkT = 0;
    let blinkClosed = false;
    let blinkGap = 3200 + Math.random() * 1800;
    let look = opts.look || lookFor(0);
    let dotIdx = pickDotIndexes(look.dots);
    let nextWagAt = performance.now() + wagGap();
    let wagStart = -1;
    let splashes = [];
    const haloGrads = [];
    let visible = true;
    let maintCountdown = MAINTAIN_EVERY;
    let usedDpr = 0;
    function dprNow() {
      try {
        const d = typeof window !== "undefined" ? Number(window.devicePixelRatio) : 1;
        return isFinite(d) && d > 0 ? d : 1;
      } catch (e) {
        return 1;
      }
    }
    function syncCanvasSize() {
      try {
        let cssW = 0;
        let cssH = 0;
        if (typeof canvas.getBoundingClientRect === "function") {
          const r = canvas.getBoundingClientRect();
          cssW = Number(r && r.width) || 0;
          cssH = Number(r && r.height) || 0;
        }
        if (!(cssW > 0)) cssW = cw / 2;
        if (!(cssH > 0)) cssH = ch / 2;
        const dpr = dprNow();
        const pxW = Math.max(1, Math.min(cw * 2, Math.round(cssW * dpr)));
        const pxH = Math.max(1, Math.min(ch * 2, Math.round(cssH * dpr)));
        if (canvas.width !== pxW) canvas.width = pxW;
        if (canvas.height !== pxH) canvas.height = pxH;
        if (typeof ctx.setTransform === "function") ctx.setTransform(pxW / cw, 0, 0, pxH / ch, 0, 0);
        if (dpr !== usedDpr) {
          usedDpr = dpr;
          haloGrads.length = 0;
        }
      } catch (e) {
      }
    }
    function checkVisible() {
      try {
        if (typeof document !== "undefined" && document.hidden) return false;
        if (canvas.isConnected === false) return false;
        if (typeof canvas.getClientRects === "function") return canvas.getClientRects().length > 0;
      } catch (e) {
      }
      return true;
    }
    function maintain() {
      maintCountdown = MAINTAIN_EVERY;
      visible = checkVisible();
      if (visible) syncCanvasSize();
    }
    let watchingResize = false;
    function onWindowResize() {
      try {
        visible = checkVisible();
      } catch (e) {
      }
      if (visible) syncCanvasSize();
    }
    function watchResize() {
      if (watchingResize) return;
      watchingResize = true;
      try {
        if (typeof window !== "undefined" && typeof window.addEventListener === "function") window.addEventListener("resize", onWindowResize);
      } catch (e) {
      }
    }
    function unwatchResize() {
      if (!watchingResize) return;
      watchingResize = false;
      try {
        if (typeof window !== "undefined" && typeof window.removeEventListener === "function") window.removeEventListener("resize", onWindowResize);
      } catch (e) {
      }
    }
    function wagGap() {
      return Math.max(2500, look.tailEveryMs * (1 - WAG_JITTER + Math.random() * WAG_JITTER * 2));
    }
    function applyLook(next) {
      const prev = look;
      look = next || lookFor(0);
      if (look.dots !== prev.dots) dotIdx = pickDotIndexes(look.dots);
      if (look.tailEveryMs !== prev.tailEveryMs) nextWagAt = performance.now() + wagGap();
      try {
        canvas.style.transform = "scale(" + look.scale + ")";
        canvas.style.transformOrigin = "50% 100%";
      } catch (e) {
      }
    }
    applyLook(look);
    function drawEye(c, closed) {
      if (!closed) return;
      const p = { x: c.x * sx, y: c.y * sy };
      const r = c.r * sx;
      ctx.fillStyle = "#F9EDE7";
      ctx.beginPath();
      ctx.ellipse(p.x, p.y, r * 1.15, r * 0.9, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = "#3a2a24";
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.arc(p.x, p.y, r * 0.8, 0.15 * Math.PI, 0.85 * Math.PI);
      ctx.stroke();
    }
    function drawMouth(open) {
      if (!open) return;
      const p = { x: MOUTH.x * sx, y: MOUTH.y * sy };
      const rw = MOUTH.rw * sx;
      const rh = MOUTH.rh * sy;
      ctx.fillStyle = "#E8566B";
      ctx.beginPath();
      ctx.ellipse(p.x, p.y, rw * 1.1, rh * 1.45, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = "#7c1f2c";
      ctx.beginPath();
      ctx.ellipse(p.x, p.y + rh * 0.5, rw * 0.6, rh * 0.55, 0, 0, Math.PI * 2);
      ctx.fill();
    }
    const HEART_LIFE = 1.4;
    function drawHearts(dtSec) {
      const arr = state.hearts;
      for (let i = arr.length - 1; i >= 0; i--) {
        const hh = arr[i];
        hh.age += dtSec;
        if (hh.age >= HEART_LIFE) {
          arr.splice(i, 1);
          continue;
        }
        const p = hh.age / HEART_LIFE;
        const x = cw * 0.42 + (hh.dx || 0) * cw * 0.12 + Math.sin(hh.age * 6) * cw * 0.01;
        const y = ch * 0.26 - p * ch * 0.16 + Math.sin(hh.age * 5) * 2;
        const alpha = Math.max(0, 1 - p);
        const size = Math.max(12, Math.round(ch * 0.05 * (1 + p * 0.5)));
        ctx.fillStyle = "rgba(255,120,150," + alpha.toFixed(3) + ")";
        ctx.font = size + 'px "Apple Color Emoji","Segoe UI Emoji","Noto Color Emoji",serif';
        ctx.fillText("❤", x, y);
      }
    }
    function haloGradient() {
      const cached = haloGrads[look.tier];
      if (cached) return cached;
      const g = ctx.createRadialGradient(HALO.x, HALO.y, HALO.r0, HALO.x, HALO.y, HALO.r1);
      g.addColorStop(0, "rgba(130,196,255,0.9)");
      g.addColorStop(0.5, "rgba(80,150,240,0.38)");
      g.addColorStop(1, "rgba(60,120,220,0)");
      haloGrads[look.tier] = g;
      return g;
    }
    function drawHalo(t) {
      if (!(look.halo > 0)) return;
      const breathe = 0.85 + 0.15 * Math.sin(t / 900);
      ctx.save();
      ctx.globalAlpha = look.halo * breathe;
      ctx.fillStyle = haloGradient();
      ctx.fillRect(0, 0, cw, ch);
      ctx.restore();
    }
    function drawFinDots(t) {
      if (!look.dots || !dotIdx.length) return;
      ctx.save();
      ctx.globalCompositeOperation = "lighter";
      for (let i = 0; i < dotIdx.length; i++) {
        const p = FIN_DOTS[dotIdx[i]];
        const pulse = 0.7 + 0.3 * Math.sin(t / DOT_BREATH_MS + i * 1.15);
        ctx.fillStyle = "#9FD6FF";
        ctx.globalAlpha = 0.16 * pulse;
        ctx.beginPath();
        ctx.arc(p.x, p.y, 5.2, 0, TAU);
        ctx.fill();
        ctx.fillStyle = "#E6F6FF";
        ctx.globalAlpha = 0.9 * pulse;
        ctx.beginPath();
        ctx.arc(p.x, p.y, 1.7, 0, TAU);
        ctx.fill();
      }
      ctx.restore();
    }
    function spawnSplash() {
      const n = 4;
      for (let i = 0; i < n; i++) {
        const a = -Math.PI / 2 + (Math.random() - 0.5) * 1.7;
        const speed = 0.05 + Math.random() * 0.07;
        splashes.push({
          x: TAIL_TIP.x + (Math.random() - 0.5) * 12,
          y: TAIL_TIP.y + (Math.random() - 0.5) * 8,
          vx: Math.cos(a) * speed,
          vy: Math.sin(a) * speed,
          age: 0,
          life: 420 + Math.random() * 260,
          r: 1.2 + Math.random() * 1.8
        });
      }
      if (splashes.length > 24) splashes = splashes.slice(splashes.length - 24);
    }
    function drawSplashes(dt) {
      if (!splashes.length) return;
      ctx.save();
      for (let i = splashes.length - 1; i >= 0; i--) {
        const p = splashes[i];
        p.age += dt;
        if (p.age >= p.life) {
          splashes.splice(i, 1);
          continue;
        }
        p.vy += 5e-4 * dt;
        p.x += p.vx * dt;
        p.y += p.vy * dt;
        const k = 1 - p.age / p.life;
        ctx.globalAlpha = 0.55 * k;
        ctx.fillStyle = "#BFE6FF";
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.r * (0.6 + 0.6 * k), 0, TAU);
        ctx.fill();
      }
      ctx.restore();
    }
    function loop(t) {
      if (!running) return;
      const dt = Math.max(0, Math.min(50, t - last));
      last = t;
      maintCountdown -= 1;
      if (maintCountdown <= 0) maintain();
      if (!visible) {
        raf = requestAnimationFrame(loop);
        return;
      }
      ctx.clearRect(0, 0, cw, ch);
      if (t >= nextWagAt) {
        wagStart = t;
        nextWagAt = t + wagGap();
        spawnSplash();
      }
      const wagP = wagStart >= 0 && t >= wagStart && t <= wagStart + WAG_MS ? (t - wagStart) / WAG_MS : -1;
      ctx.save();
      if (wagP >= 0) {
        const env = Math.sin(Math.PI * wagP);
        const angle = Math.sin(wagP * Math.PI * 6) * 0.012 * env;
        const bob = Math.sin(wagP * Math.PI * 4) * 1.6 * env;
        ctx.translate(cw / 2, ch);
        ctx.rotate(angle);
        ctx.translate(0, bob);
        ctx.translate(-cw / 2, -ch);
      }
      drawHalo(t);
      if (img.complete && img.naturalWidth > 0) {
        ctx.drawImage(img, 0, 0, 1696, 1504, 0, 0, cw, ch);
      }
      drawFinDots(t);
      blinkT += dt;
      if (!blinkClosed && blinkT > blinkGap) {
        blinkClosed = true;
        blinkT = 0;
      }
      if (blinkClosed && blinkT > 150) {
        blinkClosed = false;
        blinkT = 0;
        blinkGap = 3200 + Math.random() * 1800;
      }
      if (blinkClosed) {
        drawEye(EYE_L, true);
        drawEye(EYE_R, true);
      }
      if (t < state.talkUntil) drawMouth(Math.sin(t / 90) > 0);
      drawSplashes(dt);
      ctx.restore();
      drawHearts(dt / 1e3);
      raf = requestAnimationFrame(loop);
    }
    function start() {
      if (running) return;
      running = true;
      last = performance.now();
      maintCountdown = MAINTAIN_EVERY;
      visible = true;
      watchResize();
      syncCanvasSize();
      raf = requestAnimationFrame(loop);
    }
    function stop() {
      running = false;
      unwatchResize();
      cancelAnimationFrame(raf);
      raf = 0;
    }
    function talkFor(ms2) {
      state.talkUntil = performance.now() + ms2;
    }
    function pushHeart() {
      if (state.hearts.length >= HEART_MAX) state.hearts.shift();
      state.hearts.push({ age: 0, dx: Math.random() - 0.5 });
    }
    function setLook(next) {
      applyLook(next);
    }
    function getLook() {
      return look;
    }
    return { start, stop, talkFor, pushHeart, setLook, getLook };
  }

  // src/client/wake.ts
  var WAKE_WORDS = ["大肥鱼", "小蓝鱼", "肥鲸", "肥鱼", "小鱼", "蓝鱼", "鱼鱼", "肥肥"];
  deepFreeze(WAKE_WORDS);
  var WAKE_WORD_KEY = "chubby-wake-word";
  function loadCustomWakeWords() {
    try {
      if (typeof localStorage === "undefined") return void 0;
      const v = String(localStorage.getItem(WAKE_WORD_KEY) || "").trim();
      if (!v) return void 0;
      return [v.slice(0, 12)];
    } catch (e) {
      return void 0;
    }
  }
  function setCustomWakeWord(word) {
    try {
      const v = str(word).trim().slice(0, 12);
      if (!v) {
        localStorage.removeItem(WAKE_WORD_KEY);
        return false;
      }
      localStorage.setItem(WAKE_WORD_KEY, v);
      return true;
    } catch (e) {
      return false;
    }
  }
  var WAKE_WINDOW_MS = 3e4;
  var TRAD_TO_SIMPLE = { "魚": "鱼", "飛": "飞", "藍": "蓝", "籃": "篮", "蘭": "兰", "鯨": "鲸" };
  function normalizeWakeText(text) {
    return str(text).split("").map((c) => TRAD_TO_SIMPLE[c] || c).join("").replace(/[\s。，、！？；：,.!?;:…~～·"'“”‘’（）()【】\[\]]/g, "").toLowerCase();
  }
  var WAKE_FUZZY = [
    /^大(肥|飞|粉|菲|非|废|悲|白|百|杯)鱼/,
    /^小(蓝|篮|兰)?(鱼|鲸)/,
    /^(肥|飞)(鲸|鱼)/,
    /^大(肥|飞)鲸/
  ];
  function escapeRe(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }
  function stripWakeWords(input, words = WAKE_WORDS) {
    const raw = str(input);
    const norm = normalizeWakeText(raw);
    if (!norm) return { hit: false, text: "", word: "" };
    const sorted = (words || []).filter(Boolean).map((w) => String(w)).sort((a, b) => b.length - a.length);
    const hits = sorted.filter((w) => {
      const nw = normalizeWakeText(w);
      if (!nw) return false;
      if (nw.length >= 3) return norm.indexOf(nw) >= 0;
      return norm.startsWith(nw) || norm.length <= 4 && norm.indexOf(nw) >= 0;
    });
    if (!hits.length) {
      if (norm.length <= 12) {
        for (const re of WAKE_FUZZY) {
          const m = norm.match(re);
          if (m) {
            const rest = norm.replace(re, "");
            const keep = /[\u4e00-\u9fa5a-z0-9]/i.test(rest) ? rest : "";
            return { hit: true, text: keep, word: m[0] };
          }
        }
      }
      return { hit: false, text: raw.trim(), word: "" };
    }
    let out = raw;
    for (const w of hits) {
      const pattern = w.split("").map(escapeRe).join("\\s*");
      out = out.replace(new RegExp(pattern, "gi"), " ");
    }
    out = out.replace(/^[\s。，、！？；：,.!?;:…~～·]+/, "").replace(/[\s。，、！？；：,.!?;:…~～·]+$/, "");
    if (normalizeWakeText(out) === norm) {
      out = norm;
      for (const w of hits) out = out.split(normalizeWakeText(w)).join("");
    }
    if (!/[\u4e00-\u9fa5a-z0-9]/i.test(out)) out = "";
    return { hit: true, text: out, word: hits[0] };
  }
  function createWakeGate(opts = {}) {
    const words = (opts.words && opts.words.length ? opts.words : WAKE_WORDS).slice();
    const windowMs = Math.max(1e3, Number(opts.windowMs) || WAKE_WINDOW_MS);
    const clock = typeof opts.now === "function" ? opts.now : () => Date.now();
    let lastHitAt = 0;
    function awake(now = clock()) {
      return lastHitAt > 0 && now - lastHitAt <= windowMs;
    }
    function remainingMs(now = clock()) {
      return awake(now) ? Math.max(0, windowMs - (now - lastHitAt)) : 0;
    }
    return {
      windowMs,
      words,
      awake,
      remainingMs,
      reset() {
        lastHitAt = 0;
      },
      check(text, now = clock()) {
        const r = stripWakeWords(text, words);
        if (r.hit) {
          lastHitAt = now;
          return { hit: true, pass: true, text: r.text, word: r.word, remainingMs: windowMs };
        }
        const pass = awake(now);
        return { hit: false, pass, text: str(text).trim(), word: "", remainingMs: remainingMs(now) };
      }
    };
  }

  // src/client/voice-bridge.ts
  function bump(key) {
    try {
      const w = typeof window !== "undefined" ? window : null;
      if (!w) return;
      const d = w.__chubbyWhale || (w.__chubbyWhale = {});
      d[key] = (d[key] || 0) + 1;
    } catch (e) {
    }
  }
  function createVoiceBridge(host) {
    let voice = null;
    let pendingVoice = readStoredVoiceName();
    const gate = createWakeGate({ words: loadCustomWakeWords() });
    const wakeStats = { passed: 0, dropped: 0, hits: 0, lastHitAt: 0, dropNotifiedAt: 0 };
    let asrNoKeyNotified = false;
    function wakeInfo() {
      const now = Date.now();
      const remainingMs = gate.remainingMs(now);
      return {
        awake: remainingMs > 0,
        remainingMs,
        windowMs: gate.windowMs,
        words: gate.words,
        hits: wakeStats.hits,
        passed: wakeStats.passed,
        dropped: wakeStats.dropped,
        lastHitAt: wakeStats.lastHitAt || null
      };
    }
    function pushWake() {
      try {
        host.diag({ wake: wakeInfo() });
      } catch (e) {
      }
    }
    function build() {
      const make = host.makeVoice || ((o) => createVoice(o));
      const v = make({
        // 建实例时就带上菜单里选的音色（原来没接，TTS 永远是默认晓伊）
        voiceName: pendingVoice,
        onHeard: (text) => {
          try {
            host.onVoiceHeard();
          } catch (e) {
          }
          try {
            if (host.narration.active()) {
              if (/停|别念|不念|够了|算了|打住/.test(String(text || ""))) {
                try {
                  host.stopSpeaking();
                } catch (e) {
                }
                host.narration.clear();
                host.bubble("好，不念了", 2500);
              } else {
                bump("narrDrop");
              }
              return;
            }
          } catch (e) {
          }
          try {
            if (/^(停|停下|停一下|别说了|别讲了|别念了|别吵|闭嘴|安静|打住|够了)$/.test(normalizeWakeText(text))) {
              const speaking = host.speaking ? !!host.speaking() : true;
              if (speaking) {
                try {
                  host.stopSpeaking();
                } catch (e) {
                }
                try {
                  host.bubble("好，不说了", 2e3);
                } catch (e) {
                }
                bump("wakeBreak");
                return;
              }
            }
          } catch (e) {
          }
          try {
            if (host.voiceChat && !host.voiceChat()) {
              wakeStats.dropped++;
              pushWake();
              return;
            }
          } catch (e) {
          }
          const r = gate.check(text);
          if (r.hit) {
            wakeStats.hits++;
            wakeStats.lastHitAt = Date.now();
          }
          const said = r.hit ? r.text : String(text || "").trim();
          wakeStats.passed++;
          if (!said) {
            try {
              if (host.say) host.say("本鲸在呢～", 3200);
              else host.bubble("本鲸在呢～", 3200);
            } catch (e) {
              try {
                host.bubble("本鲸在呢～", 3200);
              } catch (e2) {
              }
            }
            pushWake();
            return;
          }
          try {
            host.bubble("（听到）" + said + "｜本鱼在想…", 3e3);
          } catch (e) {
          }
          try {
            host.sendText(said, { voice: true });
          } catch (e) {
          }
          pushWake();
        },
        onStatus: (st) => {
          try {
            host.onSpeaking(st === "speaking");
          } catch (e) {
          }
        },
        onDiag: (d) => {
          try {
            host.diag({ voiceDiag: d });
          } catch (e) {
          }
          try {
            if (d && d.stage === "asr-no-key" && !asrNoKeyNotified) {
              asrNoKeyNotified = true;
              host.bubble(String(d.hint || "没配语音识别 Key，本鲸听不见；打字也能聊～"), 8e3);
            }
          } catch (e) {
          }
        },
        // 念诗/说书：气泡跟着当前句走，主人能看到"念到哪了"
        onSegment: (seg) => {
          try {
            if (!host.narrating()) return;
            const t = String(seg || "").replace(/^念首诗——/, "").trim();
            if (!t) return;
            const withProgress = bumpProgress(t);
            host.bubble(withProgress || t, 8e3);
          } catch (e) {
          }
        }
      });
      voice = v;
      try {
        host.diag({ voice: v, wake: wakeInfo() });
      } catch (e) {
      }
      try {
        if (typeof window !== "undefined") window.addEventListener("beforeunload", () => {
          try {
            v.stop();
          } catch (e) {
          }
        });
      } catch (e) {
      }
      return v;
    }
    function ensure() {
      return voice || build();
    }
    return {
      get: () => voice,
      ensure,
      start() {
        asrNoKeyNotified = false;
        const v = ensure();
        return Promise.resolve(v.start()).then(() => {
          pushWake();
          return v;
        });
      },
      stop() {
        if (voice) {
          try {
            voice.stop();
          } catch (e) {
          }
        }
      },
      dispose() {
        if (voice) {
          try {
            voice.stop();
          } catch (e) {
          }
        }
        voice = null;
        try {
          gate.reset();
        } catch (e) {
        }
      },
      speak(text, opts) {
        try {
          ensure().speak(text, opts);
        } catch (e) {
        }
      },
      stopSpeak() {
        if (voice) {
          try {
            voice.stopSpeaking();
          } catch (e) {
          }
        }
      },
      mute(on) {
        if (voice) {
          try {
            voice.mute(on);
          } catch (e) {
          }
        }
      },
      setVoiceName(name) {
        pendingVoice = normalizeVoiceName(name, pendingVoice);
        if (voice) {
          try {
            voice.setVoiceName(pendingVoice);
          } catch (e) {
          }
        }
      },
      voiceName() {
        try {
          return voice ? voice.voiceName() : pendingVoice;
        } catch (e) {
          return pendingVoice;
        }
      },
      preview(text) {
        const t = String(text || "").trim();
        if (!t) return;
        const v = ensure();
        try {
          v.setVoiceName(pendingVoice);
        } catch (e) {
        }
        try {
          v.speak(t, { strict: true });
        } catch (e) {
        }
      },
      wakeInfo
    };
  }

  // src/client/actions.ts
  function createActionTable() {
    const exact = /* @__PURE__ */ new Map();
    const prefixes = [];
    function define(action, handler) {
      const name = String(action || "");
      if (!name || typeof handler !== "function") return;
      exact.set(name, handler);
    }
    function definePrefix(prefix, handler) {
      const p = String(prefix || "");
      if (!p || typeof handler !== "function") return;
      prefixes.push({ prefix: p, handler });
    }
    function matchPrefix(action) {
      let best = null;
      for (const e of prefixes) {
        if (action.indexOf(e.prefix) !== 0) continue;
        if (!best || e.prefix.length > best.prefix.length) best = e;
      }
      return best;
    }
    return {
      define,
      definePrefix,
      has(action) {
        const name = String(action || "");
        if (!name) return false;
        return exact.has(name) || matchPrefix(name) !== null;
      },
      async run(action, ctx) {
        const name = String(action || "");
        if (!name) return false;
        const h = exact.get(name);
        if (h) {
          await h(ctx, name);
          return true;
        }
        const p = matchPrefix(name);
        if (p) {
          await p.handler(ctx, name.slice(p.prefix.length));
          return true;
        }
        return false;
      },
      actions: () => Array.from(exact.keys()),
      prefixes: () => prefixes.map((e) => e.prefix)
    };
  }

  // src/client/http.ts
  var API_BASE = "/api/chubby-whale";
  function apiUrl(path) {
    const p = String(path || "");
    if (!p) return API_BASE;
    if (/^(https?:)?\/\//.test(p)) return p;
    if (p.indexOf("/api/") === 0) return p;
    return API_BASE + (p.charAt(0) === "/" ? p : "/" + p);
  }
  function clientHeaders(clientId, extra) {
    const h = Object.assign({}, extra || {});
    if (clientId) h["x-client-id"] = clientId;
    return h;
  }
  function request(path, init) {
    return fetch(apiUrl(path), Object.assign({}, init || {}));
  }
  function getJson(path, init) {
    return request(path, init).then((r) => r.json());
  }
  function postRaw(path, body, init) {
    const o = Object.assign({}, init || {});
    o.method = "POST";
    if (body !== void 0) {
      o.headers = Object.assign({ "content-type": "application/json" }, o.headers || {});
      o.body = JSON.stringify(body);
    }
    return fetch(apiUrl(path), o);
  }
  function postJson(path, body, init) {
    return postRaw(path, body, init).then((r) => r.json());
  }
  function delJson(path, init) {
    const o = Object.assign({}, init || {});
    o.method = "DELETE";
    return fetch(apiUrl(path), o).then((r) => r.json());
  }
  function timeoutSignal(ms2) {
    try {
      const n = Number(ms2);
      if (!Number.isFinite(n) || n <= 0) return void 0;
      const AS = typeof AbortSignal !== "undefined" ? AbortSignal : null;
      if (AS && typeof AS.timeout === "function") return AS.timeout(n);
    } catch (e) {
    }
    return void 0;
  }

  // src/client/melody.ts
  var NOTE_FREQ = {
    "C3": 130.81,
    "C#3": 138.59,
    "D3": 146.83,
    "D#3": 155.56,
    "E3": 164.81,
    "F3": 174.61,
    "F#3": 185,
    "G3": 196,
    "G#3": 207.65,
    "A3": 220,
    "A#3": 233.08,
    "B3": 246.94,
    "C4": 261.63,
    "C#4": 277.18,
    "D4": 293.66,
    "D#4": 311.13,
    "E4": 329.63,
    "F4": 349.23,
    "F#4": 369.99,
    "G4": 392,
    "G#4": 415.3,
    "A4": 440,
    "A#4": 466.16,
    "B4": 493.88,
    "C5": 523.25,
    "C#5": 554.37,
    "D5": 587.33,
    "D#5": 622.25,
    "E5": 659.25,
    "F5": 698.46,
    "F#5": 739.99,
    "G5": 783.99,
    "G#5": 830.61,
    "A5": 880,
    "A#5": 932.33,
    "B5": 987.77,
    "C6": 1046.5,
    "C#6": 1108.73,
    "D6": 1174.66,
    "D#6": 1244.51,
    "E6": 1318.51
  };
  deepFreeze(NOTE_FREQ);
  function beatSeconds(bpm) {
    return 60 / Math.max(60, Number(bpm) || 100);
  }
  function estimateMelodySeconds(notes, bpm) {
    let beats = 0;
    for (const pair of notes || []) {
      const d = Number(pair && pair[1]);
      beats += isFinite(d) && d > 0 ? d : 1;
    }
    return Math.round(beats * beatSeconds(bpm) * 10) / 10;
  }
  function createMelodyPlayer() {
    let ctx = null;
    let oscs = [];
    let doneTimer = null;
    let seq = 0;
    function ensureCtx() {
      try {
        const AC = (typeof window !== "undefined" ? window.AudioContext : null) || (typeof window !== "undefined" ? window.webkitAudioContext : null);
        if (!AC) return null;
        if (!ctx || ctx.state === "closed") ctx = new AC();
        return ctx;
      } catch (e) {
        return null;
      }
    }
    function stopNotes() {
      for (const o of oscs) {
        try {
          o.stop();
        } catch (e) {
        }
      }
      oscs = [];
      clearT(doneTimer);
      doneTimer = null;
    }
    function stop() {
      seq++;
      stopNotes();
      try {
        if (ctx && ctx.state !== "closed" && typeof ctx.suspend === "function") {
          const p = ctx.suspend();
          if (p && typeof p.catch === "function") p.catch(() => {
          });
        }
      } catch (e) {
      }
    }
    function play(notes, bpm, onDone) {
      try {
        stopNotes();
        const my = ++seq;
        const c = ensureCtx();
        if (!c) return;
        const beat = beatSeconds(bpm);
        const schedule = () => {
          if (my !== seq) return;
          try {
            let t = (Number(c.currentTime) || 0) + 0.05;
            const local = [];
            for (const pair of notes || []) {
              const nm = String(pair && pair[0]);
              const rawDur = Number(pair && pair[1]);
              const dur = isFinite(rawDur) && rawDur > 0 ? rawDur : 1;
              const f = NOTE_FREQ[nm];
              if (!f) {
                t += dur * beat;
                continue;
              }
              try {
                const o = c.createOscillator();
                const g = c.createGain();
                o.frequency.value = f;
                o.type = "sine";
                g.gain.setValueAtTime(0.3, t);
                g.gain.exponentialRampToValueAtTime(1e-3, t + dur * beat * 0.95);
                o.connect(g);
                g.connect(c.destination);
                o.start(t);
                o.stop(t + dur * beat);
                local.push(o);
              } catch (e) {
              }
              t += dur * beat;
            }
            oscs = local;
            const totalMs = Math.max(0, (t - (Number(c.currentTime) || 0)) * 1e3) + 300;
            if (onDone) {
              doneTimer = setTimeout(() => {
                doneTimer = null;
                if (my !== seq) return;
                try {
                  onDone();
                } catch (e) {
                }
              }, totalMs);
            }
          } catch (e) {
          }
        };
        try {
          const p = typeof c.resume === "function" ? c.resume() : null;
          if (p && typeof p.then === "function") p.then(schedule, schedule);
          else schedule();
        } catch (e) {
          schedule();
        }
      } catch (e) {
      }
    }
    return { play, stop };
  }

  // src/client/duilian.ts
  var COUPLET_ROWS = [
    ["风声雨声读书声，声声入耳", "家事国事天下事，事事关心", "明·顾宪成题无锡东林书院", "书院"],
    ["海纳百川，有容乃大", "壁立千仞，无欲则刚", "清·林则徐自题联", "格言"],
    ["室雅何须大", "花香不在多", "清·郑板桥", "格言"],
    ["删繁就简三秋树", "领异标新二月花", "清·郑板桥", "格言"],
    ["墙上芦苇，头重脚轻根底浅", "山间竹笋，嘴尖皮厚腹中空", "相传为明·解缙作", "谐趣"],
    ["铁肩担道义", "妙手著文章", "李大钊《晨钟报》创刊号（1916）", "格言"],
    ["四面荷花三面柳", "一城山色半城湖", "清·刘凤诰题济南大明湖铁公祠", "名胜"],
    ["青山有幸埋忠骨", "白铁无辜铸佞臣", "杭州岳王庙墓阙联（传统）", "名胜"],
    ["一粥一饭，当思来处不易", "半丝半缕，恒念物力维艰", "明末清初·朱柏庐《治家格言》", "格言"],
    ["读书好，耕田好，学好便好", "创业难，守成难，知难不难", "清·吴敬梓《儒林外史》第二十二回", "格言"],
    ["春风大雅能容物", "秋水文章不染尘", "清·邓石如", "格言"],
    ["雨过琴书润", "风来翰墨香", "传统书房联", "书房"],
    ["大肚能容，容天下难容之事", "开口便笑，笑世间可笑之人", "传统弥勒佛联", "谐趣"],
    ["天增岁月人增寿", "春满乾坤福满门", "传统春联", "春联"],
    ["一元复始", "万象更新", "传统春联", "春联"],
    ["春回大地", "福满人间", "传统春联", "春联"],
    ["门迎百福", "户纳千祥", "传统春联", "春联"],
    ["五湖四海皆春色", "万水千山尽得辉", "传统春联", "春联"],
    ["松竹梅岁寒三友", "桃李杏春风一家", "传统", "格言"],
    ["福如东海长流水", "寿比南山不老松", "传统寿联", "寿联"],
    ["客上天然居", "居然天上客", "传统回文联（顺读倒读同句）", "谐趣"],
    ["画上荷花和尚画", "书临汉帖翰林书", "传统回文联", "谐趣"],
    ["因荷而得藕", "有杏不须梅", "传统谐音联（荷=何、藕=偶；杏=幸、梅=媒）", "谐趣"],
    ["两舟并行，橹速不如帆快", "八音齐奏，笛清难比箫和", "传统谐音联（橹速=鲁肃、帆快=樊哙；笛清=狄青、箫和=萧何）", "谐趣"],
    ["南通州，北通州，南北通州通南北", "东当铺，西当铺，东西当铺当东西", "传统地名联", "谐趣"],
    ["天作棋盘星作子，谁人敢下", "地为琵琶路为弦，哪个能弹", "传统（民间流传）", "谐趣"],
    ["墙上画马不能骑", "镜里烧饼难充饥", "传统（民间俗联）", "谐趣"],
    ["水清石出鱼可数", "林深无人鸟相呼", "宋·苏轼诗句（成联欣赏）", "景观"],
    ["青山不墨千秋画", "流水无弦万古琴", "传统（流传甚广，作者待考）", "景观"],
    ["云带钟声穿树去", "月移塔影过江来", "传统名胜联", "名胜"],
    ["此木为柴山山出", "因火成烟夕夕多", "传统拆字联（柴=此+木、出=山+山；烟=因+火、多=夕+夕）", "谐趣"],
    ["鼠无大小皆称老", "鹦有雌雄都叫哥", "传统谐趣联", "谐趣"],
    ["人曾是僧，人弗能成佛", "女卑为婢，女又可称奴", "相传为苏轼与佛印和尚戏对", "谐趣"],
    ["二三四五", "六七八九", "传统谐意联（上联缺「一」，下联少「十」：缺衣少食）", "谐趣"],
    ["宝剑锋从磨砺出", "梅花香自苦寒来", "传统格言联", "格言"],
    ["书山有路勤为径", "学海无涯苦作舟", "传统格言联（常见署名韩愈，出处待考，故不署）", "格言"],
    ["书到用时方恨少", "事非经过不知难", "传统格言联", "格言"],
    ["海阔凭鱼跃", "天高任鸟飞", "传统格言联", "格言"],
    ["路遥知马力", "日久见人心", "传统（俗谚成联）", "格言"],
    ["和顺一门有百福", "平安二字值千金", "传统春联", "春联"],
    ["爆竹一声除旧", "桃符万户更新", "传统春联（化用王安石《元日》）", "春联"],
    ["天泰地泰三阳泰", "家和人和万事和", "传统春联", "春联"],
    ["一年四季春常在", "万紫千红花永开", "传统春联", "春联"],
    ["近水楼台先得月", "向阳花木易为春", "宋·苏麟诗（相传）", "格言"],
    ["山重水复疑无路", "柳暗花明又一村", "宋·陆游《游山西村》诗句（成联欣赏）", "景观"],
    ["一楼何奇？杜少陵五言绝唱，范希文两字关情，滕子京百废俱兴，吕纯阳三过必醉。诗耶？儒耶？吏耶？仙耶？前不见古人，使我怆然涕下", "诸君试看：洞庭湖南极潇湘，扬子江北通巫峡，巴陵山西来爽气，岳州城东道岩疆。潴者！流者！峙者！镇者！此中有真意，问谁领会得来", "岳阳楼长联（清·窦垿，一说陈大纲）", "名胜"],
    ["兴废总关情，看落霞孤鹜、秋水长天，幸此地湖山无恙", "古今才一瞬，问江上才人、阁中帝子，比当年风景如何", "清·刘坤一题南昌滕王阁", "名胜"],
    ["一楼萃三楚精神，云鹤俱空横笛在", "二水汇百川支派，古今无尽大江流", "黄鹤楼联（传统）", "名胜"],
    ["白头翁牵牛耕熟地", "红娘子佛手插金花", "传统中药名联（白头翁/牵牛/熟地/红娘子/佛手/金花皆药名）", "中药"],
    ["水水山山，处处明明秀秀", "晴晴雨雨，时时好好奇奇", "西湖叠字联（传统）", "叠字"],
    ["一去二三里，烟村四五家", "亭台六七座，八九十枝花", "宋·邵雍《山村咏怀》诗句（数字联）", "数字"]
  ];
  var COUPLETS = COUPLET_ROWS.map(([upper, lower, source, cat]) => ({ upper, lower, source, cat }));
  deepFreeze(COUPLETS);
  var COUPLET_CATS = ["书院", "格言", "谐趣", "名胜", "书房", "春联", "寿联", "景观", "中药", "叠字", "数字"];
  deepFreeze(COUPLET_CATS);
  function pickCouplet(excludeUpper, cat) {
    const byCat = cat ? COUPLETS.filter((c) => c.cat === cat) : COUPLETS;
    const base = byCat.length > 0 ? byCat : COUPLETS;
    const pool = base.length > 1 && excludeUpper ? base.filter((c) => c.upper !== excludeUpper) : base;
    const src = pool.length > 0 ? pool : base;
    return src[Math.floor(Math.random() * src.length)];
  }

  // src/client/actions/culture.ts
  var recentStarts = /* @__PURE__ */ new Map();
  function beginOnce(key, gapMs = 1500) {
    const now = Date.now();
    const last = recentStarts.get(key) || 0;
    if (now - last < gapMs) return false;
    recentStarts.set(key, now);
    return true;
  }
  function recitePoem(host, poem) {
    if (!beginOnce("poem")) {
      host.bubble("正在念呢，稍等～", 2e3);
      return;
    }
    const body = String(poem.text || "");
    const author = String(poem.author || "佚名");
    const lines = body.split(/\r?\n/).map((x) => x.trim()).filter(Boolean);
    const totalLines = lines.length;
    const intro = "念首诗——" + poem.title + "，" + (poem.dynasty ? poem.dynasty + "，" : "") + author + "。";
    try {
      startProgress("念诗·" + String(poem.title || ""), lines, intro);
    } catch (e) {
    }
    host.bubble("念诗·" + poem.title + "（" + author + "）" + (totalLines > 1 ? "· 共 " + totalLines + " 句" : ""), 15e3);
    host.talkFor(6e3);
    const speech = intro + collapsePoemBody(body);
    host.narrate(estimateSpeakMs(speech));
    host.say(host.persona.line("poemStart"), 4e3);
    try {
      host.speak(speech, {
        rate: poemRate(host.narrationRate()),
        onDone: () => {
          try {
            stopProgress();
          } catch (e) {
          }
          host.clearNarrate();
          host.say(host.persona.line("poemDone"), 6e3, { rate: "-8%", pitch: "+15Hz" });
        }
      });
    } catch (e) {
    }
  }
  function finishSpeech(host, doneText) {
    host.bubble(doneText, 5e3);
    try {
      host.speak("讲完啦～");
    } catch (e) {
    }
  }
  function registerCultureActions(table) {
    let lastCouplet = "";
    let revealTimer = null;
    function showCouplet(host, cat, withCat) {
      if (!beginOnce("couplet", 6e3)) {
        host.bubble("正在出对联，等本鲸揭晓～", 2e3);
        return;
      }
      const c = pickCouplet(lastCouplet, cat);
      lastCouplet = c.upper;
      host.bubble((withCat ? "【" + c.cat + "】" : "") + "上联：" + c.upper + "（先对一对，本鲸 6 秒后揭晓下联）", 5600);
      clearT(revealTimer);
      revealTimer = setTimeout(() => {
        revealTimer = null;
        try {
          host.bubble("下联：" + c.lower + "\n——" + c.source, 7e3);
        } catch (e) {
        }
      }, 6e3);
    }
    table.define("poem", (host) => {
      getJson("/poem").then((d) => {
        const p = d && d.ok && d.item ? d.item : null;
        if (!p) {
          host.bubble("诗册没读到");
          return;
        }
        recitePoem(host, p);
      }).catch(() => host.bubble("诗册没读到"));
    });
    table.define("culture-story", (host) => {
      host.story.start("");
    });
    table.define("culture-story-next", (host) => {
      host.story.next();
    });
    table.define("story-reset", (host) => {
      host.story.reset();
    });
    function storyAutoPref(host) {
      try {
        const s = localStorage.getItem("chubby-story-auto");
        return s === null ? true : s !== "0";
      } catch (e) {
        return host && host.storyState && host.storyState.auto ? !!host.storyState.auto.current : true;
      }
    }
    table.define("story-auto", (host) => {
      const next = !storyAutoPref(host);
      try {
        if (host.storyState && host.storyState.auto) host.storyState.auto.current = next;
      } catch (e) {
      }
      try {
        localStorage.setItem("chubby-story-auto", next ? "1" : "0");
      } catch (e) {
      }
      host.bubble(next ? "连播：开——讲完这段自动接下一段" : "连播：关——讲完这段就停", 4e3);
    });
    table.definePrefix("narration-rate:", (host, suffix) => {
      const v = String(suffix || "");
      if (setNarrationRate(v)) host.bubble("叙述语速：" + v, 4e3);
      else host.bubble("这个语速值不认", 3e3);
    });
    table.definePrefix("chat-rate:", (host, suffix) => {
      const rate = String(suffix || "").trim();
      if (!setChatRate(rate)) {
        host.bubble("这个语速值不认", 3e3);
        return;
      }
      host.bubble("聊天语速：" + rate, 4e3);
    });
    table.definePrefix("poem-rate:", (host, suffix) => {
      const rate = String(suffix || "");
      if (!/^-\d{1,2}%$/.test(rate)) {
        host.bubble("这个语速值不认", 3e3);
        return;
      }
      try {
        localStorage.setItem("chubby-poem-rate", rate);
      } catch (e) {
      }
      host.bubble("念诗语速：" + rate, 4e3);
    });
    table.definePrefix("story-rate:", (host, suffix) => {
      const rate = String(suffix || "");
      if (!/^-\d{1,2}%$/.test(rate)) {
        host.bubble("这个语速值不认", 3e3);
        return;
      }
      try {
        localStorage.setItem("chubby-story-rate", rate);
      } catch (e) {
      }
      host.bubble("说书语速：" + rate, 4e3);
    });
    table.define("culture-tale", (host) => {
      if (!beginOnce("tale")) {
        host.bubble("正在讲呢，稍等～", 2e3);
        return;
      }
      getJson("/culture?type=minsu").then((d) => {
        if (!(d && d.ok && d.item)) {
          host.bubble("故事没讲成");
          return;
        }
        const tp = taleParts(d.item.title);
        const body = collapseText(d.item.text);
        host.bubble("讲民间故事·" + tp.title + (tp.book ? "（出自《" + tp.book + "》）" : ""), 9e3);
        host.talkFor(5e3);
        host.speak("讲个民间故事——" + tp.title + (tp.book ? "，出自《" + tp.book + "》" : "") + "。" + body, {
          rate: host.narrationRate(),
          onDone: () => finishSpeech(host, "故事讲完啦～")
        });
      }).catch(() => host.bubble("故事没讲成"));
    });
    table.define("culture-allusion", (host) => {
      if (!beginOnce("allusion")) {
        host.bubble("正在讲呢，稍等～", 2e3);
        return;
      }
      getJson("/culture?type=chengyu").then((d) => {
        if (!(d && d.ok && d.item)) {
          host.bubble("典故没讲成");
          return;
        }
        const body = collapseText(d.item.text);
        host.bubble("讲典故·" + d.item.title + "（" + (d.item.src || "") + "）", 9e3);
        host.talkFor(5e3);
        host.speak("讲个典故——" + String(d.item.title || "") + "，出自" + String(d.item.src || "") + "。" + body, {
          rate: host.narrationRate(),
          onDone: () => finishSpeech(host, "典故讲完啦～")
        });
      }).catch(() => host.bubble("典故没讲成"));
    });
    table.define("culture-idiom", (host) => {
      if (!beginOnce("idiom")) {
        host.bubble("正在讲呢，稍等～", 2e3);
        return;
      }
      getJson("/culture?type=idiom").then((d) => {
        if (!(d && d.ok && d.item)) {
          host.bubble("没查到");
          return;
        }
        host.bubble("成语辨析·" + d.item.title, 8e3);
        const sp = String(d.item.title || "") + "：" + String(d.item.text || "");
        host.speak(sp, {
          rate: host.narrationRate(),
          onDone: () => finishSpeech(host, "这个成语讲完啦～")
        });
      }).catch(() => host.bubble("没查到"));
    });
    table.define("culture-couplet", (host) => {
      showCouplet(host);
    });
    table.definePrefix("culture-couplet:", (host, cat) => {
      showCouplet(host, cat, true);
    });
    table.definePrefix("music:", (host, name) => {
      host.stopSpeak();
      getJson("/melody?name=" + encodeURIComponent(name)).then((d) => {
        if (!(d && d.ok && d.song)) {
          host.bubble("这首曲子没找到");
          return;
        }
        const songName = String(d.song.name || "这首曲子");
        const bpm = Number(d.song.bpm) || 100;
        const notes = d.song.notes || [];
        const estSec = estimateMelodySeconds(notes, bpm);
        host.bubble("弹《" + songName + "》♪（约 " + estSec + " 秒）", 6e3);
        host.playMelody(notes, bpm, () => {
          host.bubble("弹完啦～《" + songName + "》", 6e3);
          host.talkFor(1500);
          try {
            host.diag({ melodyVoice: { at: Date.now(), requested: true, ok: false, err: "" } });
            host.speak("弹完啦～");
            setTimeout(() => {
              try {
                const w = typeof window !== "undefined" ? window.__chubbyWhale : null;
                const info = w && w.melodyVoice;
                if (info && !host.voicePlaying()) info.err = "TTS 未开始（可能被浏览器拦或合成失败）";
              } catch (e) {
              }
            }, 1200);
          } catch (e) {
            host.diag({ melodyVoice: { requested: false, err: String(e) } });
          }
        });
      }).catch(() => host.bubble("弹琴失败"));
    });
  }

  // src/client/actions/content.ts
  function parseBookList(d) {
    return d && d.ok && Array.isArray(d.books) ? d.books.map((b) => String(b || "").trim()).filter(Boolean) : [];
  }
  function pickDaily(d) {
    if (!d || typeof d !== "object" || d.ok === false) return null;
    const box = d.item || d.data || (Array.isArray(d.items) && d.items.length ? d.items[0] : null) || d;
    const text = String(box && box.text || "").trim();
    if (!text) return null;
    const source = String(box && box.source || d.source || "").trim();
    return { text, source };
  }
  function parseBriefing(d) {
    if (!d || typeof d !== "object" || d.ok === false) return null;
    const text = String(d.text || d.item && d.item.text || "");
    const lines = text.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
    const first = [];
    const second = [];
    for (const line of lines) {
      if (/待办|提醒/.test(line)) second.push(line);
      else first.push(line);
    }
    if (!first.length && !second.length) {
      const date = String(d.date || "").trim();
      const weather = String(d.weather || "").trim();
      const growth = String(d.growth || "").trim();
      const head = [
        date,
        weather ? "北海天气：" + weather : "",
        growth ? "肥鲸成长：" + growth : ""
      ].filter(Boolean).join("\n");
      if (head) first.push(head);
      if (Array.isArray(d.todos)) second.push("待办提醒：" + d.todos.length + " 条");
      else if (typeof d.todos === "string" && d.todos.trim()) second.push("待办提醒：" + d.todos.trim());
    }
    if (!first.length && !second.length) return null;
    return { first: first.join("\n"), second: second.join("\n") };
  }
  function showAndSpeak(host, shown, speech, ms2) {
    host.bubble(shown, ms2);
    host.talkFor(5e3);
    if (!host.voiceOn()) return;
    host.narrate(estimateSpeakMs(speech));
    host.speak(speech, { rate: host.narrationRate(), onDone: () => host.clearNarrate() });
  }
  function registerContentActions(table) {
    table.define("story-books", (host) => {
      getJson("/story/books", { cache: "no-store" }).then((d) => {
        const books = parseBookList(d);
        if (!books.length) {
          host.bubble("书单没取到，稍后再试", 4e3);
          return;
        }
        host.bubble("书单有 " + books.length + " 本，右键点「选本书」挑一本～", 5e3);
      }).catch(() => host.bubble("书单没取到，稍后再试", 4e3));
    });
    table.definePrefix("story-book:", (host, name) => {
      const book = String(name || "").trim();
      if (!book) {
        host.bubble("书名没读到", 3e3);
        return;
      }
      if (host.storyState && host.storyState.busy.current) {
        host.bubble("正讲着呢，听完这段再说～", 3e3);
        return;
      }
      host.bubble("开始讲《" + book + "》", 3e3);
      host.story.start(book);
    });
    table.define("daily-line", (host) => {
      if (!beginOnce("daily")) {
        host.bubble("刚念过啦，稍等～", 2e3);
        return;
      }
      getJson("/daily", { cache: "no-store" }).then((d) => {
        const line = pickDaily(d);
        if (!line) {
          host.bubble("今天那句还没准备好", 3500);
          return;
        }
        const shown = line.source ? line.text + "\n——" + line.source : line.text;
        showAndSpeak(host, shown, shown, 9e3);
      }).catch(() => host.bubble("今天那句还没准备好", 3500));
    });
    table.define("briefing-card", (host) => {
      if (!beginOnce("briefing")) {
        host.bubble("刚播过啦，稍等～", 2e3);
        return;
      }
      getJson("/briefing", { cache: "no-store" }).then((d) => {
        const card = parseBriefing(d);
        if (!card) {
          host.bubble("简报今天没取到", 3500);
          return;
        }
        const shown = card.first && card.second ? card.first + "\n\n" + card.second : card.first || card.second;
        const speech = [card.first, card.second].filter(Boolean).join("。");
        showAndSpeak(host, shown, speech, 12e3);
      }).catch(() => host.bubble("简报今天没取到", 3500));
    });
  }

  // src/shared/time.ts
  var DAY_MS = 864e5;
  function applyPeriod(hour, word) {
    if (word === "下午") return hour === 12 ? 12 : hour < 12 ? hour + 12 : hour;
    if (word === "傍晚" || word === "晚上") return hour === 12 ? 0 : hour < 12 ? hour + 12 : hour;
    if (word === "中午") return hour < 10 ? hour + 12 : hour;
    return hour;
  }
  function cleanReminderText(raw) {
    let t = String(raw || "").trim();
    const leads = ["提醒我一下", "提醒一下", "提醒我", "提醒", "叫我一下", "叫我", "记得要", "记得", "到时候"];
    let changed = true;
    while (changed) {
      changed = false;
      for (const lead of leads) {
        if (t.startsWith(lead)) {
          t = t.slice(lead.length).trim();
          changed = true;
          break;
        }
      }
    }
    t = t.replace(/^[，,。.：:、\s]+/, "").replace(/[，,。.：:、\s]+$/, "");
    return t;
  }
  function parseDue(raw, now = /* @__PURE__ */ new Date()) {
    const src = String(raw || "").trim();
    if (!src) return null;
    const base = new Date(now.getTime());
    const daily = /每天|每日/.test(src);
    const done = (at, stripped) => ({
      at,
      repeat: daily ? 86400 : null,
      cleaned: cleanReminderText(stripped.replace(/每天|每日/g, ""))
    });
    let m = src.match(/(\d{4})-(\d{1,2})-(\d{1,2})[ T](\d{1,2}):(\d{2})/);
    if (m) {
      const dt = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), 0, 0);
      if (!isNaN(dt.getTime())) return done(dt, src.replace(m[0], "").trim());
    }
    m = src.match(/半小时(?:后|以后)?/);
    if (m) return done(new Date(base.getTime() + 30 * 6e4), src.replace(m[0], "").trim());
    m = src.match(/(\d+)\s*分钟(?:后|以后)?/);
    if (m) {
      const mins = Math.max(1, Math.min(24 * 60, Number(m[1]) || 1));
      return done(new Date(base.getTime() + mins * 6e4), src.replace(m[0], "").trim());
    }
    m = src.match(/(一小时|1小时)(?:后|以后)?/);
    if (m) return done(new Date(base.getTime() + 60 * 6e4), src.replace(m[0], "").trim());
    m = src.match(/(\d+)\s*小时(?:后|以后)?/);
    if (m) {
      const hours = Math.max(1, Math.min(24 * 7, Number(m[1]) || 1));
      return done(new Date(base.getTime() + hours * 36e5), src.replace(m[0], "").trim());
    }
    const day = src.match(/(今天|明天|后天)/);
    const clock = src.match(/(\d{1,2})\s*(?:点|:|：)\s*(半|\d{2})?/);
    if (clock) {
      const rawH = Number(clock[1]);
      if (Number.isFinite(rawH) && rawH >= 0 && rawH <= 23) {
        const before = typeof clock.index === "number" ? src.slice(0, clock.index) : "";
        const pm = before.match(/(凌晨|早上|上午|中午|下午|傍晚|晚上)[\s，,]*$/);
        const h = applyPeriod(rawH, pm ? pm[1] : "");
        let minute = 0;
        const mm = clock[2] || "";
        if (mm === "半") minute = 30;
        else if (mm) minute = Math.max(0, Math.min(59, Number(mm) || 0));
        const dayStart = new Date(base.getFullYear(), base.getMonth(), base.getDate());
        let target = new Date(dayStart.getTime());
        if (day) {
          if (day[1] === "明天") target = new Date(dayStart.getTime() + DAY_MS);
          else if (day[1] === "后天") target = new Date(dayStart.getTime() + 2 * DAY_MS);
        }
        target.setHours(h, minute, 0, 0);
        if (!day && target.getTime() <= base.getTime()) target = new Date(target.getTime() + DAY_MS);
        let stripped = src.replace(clock[0], "").trim();
        if (pm && typeof pm.index === "number") {
          stripped = (stripped.slice(0, pm.index) + stripped.slice(pm.index + pm[1].length)).trim();
        }
        if (day) stripped = stripped.replace(day[1], "").trim();
        return done(target, stripped);
      }
    }
    return null;
  }

  // src/client/actions/data.ts
  var MAX_BACKUP_BYTES = 2 * 1024 * 1024;
  function backupFileName(now = /* @__PURE__ */ new Date()) {
    const d = now instanceof Date && !isNaN(now.getTime()) ? now : /* @__PURE__ */ new Date();
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return "chubby-whale-backup-" + y + "-" + m + "-" + day + ".json";
  }
  function countOf(v) {
    if (v == null) return 0;
    if (typeof v === "number") return Number.isFinite(v) ? v : 0;
    if (typeof v === "boolean") return 0;
    if (Array.isArray(v)) return v.length;
    if (typeof v === "object") {
      let n2 = 0;
      for (const k of Object.keys(v)) n2 += countOf(v[k]);
      return n2;
    }
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  }
  function formatImportResult(d) {
    const src = d && typeof d === "object" ? d : {};
    const imported = countOf(src.imported != null ? src.imported : src.importedCount != null ? src.importedCount : src.added);
    const skipped = countOf(src.skipped != null ? src.skipped : src.skippedCount != null ? src.skippedCount : src.ignored);
    return "导入了 " + imported + " 个字段，跳过 " + skipped + " 个字段";
  }
  function downloadJson(data, filename, env) {
    try {
      const e = env || {};
      const doc = e.document || (typeof document !== "undefined" ? document : null);
      const URLX = e.url || (typeof URL !== "undefined" ? URL : null);
      const B = e.BlobCtor || (typeof Blob !== "undefined" ? Blob : null);
      if (!doc || !URLX || typeof URLX.createObjectURL !== "function" || !B) return false;
      const text = typeof data === "string" ? data : JSON.stringify(data, null, 2);
      const blob = new B([text], { type: "application/json;charset=utf-8" });
      const url = URLX.createObjectURL(blob);
      const a = doc.createElement("a");
      a.href = url;
      a.download = filename;
      try {
        a.style.display = "none";
      } catch (err) {
      }
      try {
        a.setAttribute("data-chubby-download", "1");
      } catch (err) {
      }
      const parent = doc.body || doc.documentElement;
      if (parent && typeof parent.appendChild === "function") parent.appendChild(a);
      try {
        a.click();
      } catch (err) {
        try {
          URLX.revokeObjectURL(url);
        } catch (e2) {
        }
        try {
          if (parent && typeof parent.removeChild === "function") parent.removeChild(a);
          else if (typeof a.remove === "function") a.remove();
        } catch (e2) {
        }
        return false;
      }
      try {
        setTimeout(() => {
          try {
            if (parent && typeof parent.removeChild === "function") parent.removeChild(a);
            else if (typeof a.remove === "function") a.remove();
          } catch (err) {
          }
          try {
            URLX.revokeObjectURL(url);
          } catch (err) {
          }
        }, 0);
      } catch (err) {
      }
      return true;
    } catch (e) {
      return false;
    }
  }
  function exportFailText(d) {
    const err = d && typeof d === "object" ? String(d.error || "") : "";
    return err === "TOO_LARGE" ? "备份太大（超过 2MB），导出没成功" : "导出没成功";
  }
  function exportBackup(host) {
    const fetchJson = host.getJson || getJson;
    let p;
    try {
      p = Promise.resolve(fetchJson("/data/export", { cache: "no-store" }));
    } catch (e) {
      host.bubble("导出没成功", 5e3);
      return;
    }
    p.then((d) => {
      if (!d || typeof d !== "object" || d.ok === false) {
        host.bubble(exportFailText(d), 6e3);
        return;
      }
      const name = backupFileName(host.now ? host.now() : /* @__PURE__ */ new Date());
      const ok = downloadJson(d, name, host.env);
      host.bubble(ok ? "备份已下载：" + name : "浏览器没让下载，导出没成功", 6e3);
    }).catch(() => host.bubble("导出没成功", 5e3));
  }
  function readFileText(file) {
    return new Promise((resolve, reject) => {
      try {
        if (!file) {
          reject(new Error("no file"));
          return;
        }
        if (typeof file.text === "function") {
          file.text().then((t) => resolve(str(t)), reject);
          return;
        }
        const FR = typeof FileReader !== "undefined" ? FileReader : null;
        if (!FR) {
          reject(new Error("FileReader missing"));
          return;
        }
        const fr = new FR();
        fr.onload = () => resolve(str(fr.result));
        fr.onerror = () => reject(new Error("read failed"));
        fr.readAsText(file);
      } catch (e) {
        reject(e);
      }
    });
  }
  function parseImportText(text) {
    const raw = str(text).trim();
    if (!raw) return null;
    let v = null;
    try {
      v = JSON.parse(raw);
    } catch (e) {
      return null;
    }
    if (!v || typeof v !== "object") return null;
    return v;
  }
  function pickJsonFile(cb) {
    try {
      const doc = typeof document !== "undefined" ? document : null;
      if (!doc || typeof doc.createElement !== "function") {
        cb(null);
        return;
      }
      const input = doc.createElement("input");
      input.type = "file";
      input.accept = ".json,application/json";
      try {
        input.style.display = "none";
      } catch (e) {
      }
      const cleanup = () => {
        try {
          if (typeof input.remove === "function") input.remove();
          else if (input.parentNode && typeof input.parentNode.removeChild === "function") input.parentNode.removeChild(input);
        } catch (e) {
        }
      };
      input.onchange = () => {
        try {
          const f = input.files && input.files[0];
          if (f) cb(f);
          else cb(null);
        } catch (e) {
          cb(null);
        } finally {
          cleanup();
        }
      };
      try {
        if (typeof input.addEventListener === "function") {
          input.addEventListener("cancel", () => {
            try {
              cb(null);
            } finally {
              cleanup();
            }
          });
        }
      } catch (e) {
      }
      const parent = doc.body || doc.documentElement;
      if (parent && typeof parent.appendChild === "function") parent.appendChild(input);
      try {
        input.click();
      } catch (e) {
        cb(null);
        cleanup();
      }
    } catch (e) {
      cb(null);
    }
  }
  function importFailText(d) {
    const err = d && typeof d === "object" ? String(d.error || "") : "";
    if (err === "TOO_LARGE") return "备份太大（超过 2MB），没导入";
    if (err === "BAD_BODY") return "备份文件格式不对，没导入";
    return "备份文件读不了";
  }
  function clearChatCache(host) {
    try {
      const del = typeof host.delJson === "function" ? host.delJson : delJson;
      try {
        Promise.resolve(del("/cache")).catch(() => {
        });
      } catch (e) {
      }
    } catch (e) {
    }
  }
  function importBackup(host) {
    const pick = typeof host.pickFile === "function" ? host.pickFile : pickJsonFile;
    const sendJson = host.postJson || postJson;
    try {
      pick((file) => {
        if (!file) {
          host.bubble("没选备份文件", 3e3);
          return;
        }
        const size = Number(file.size);
        if (Number.isFinite(size) && size > MAX_BACKUP_BYTES) {
          host.bubble("备份太大（超过 2MB），没导入", 6e3);
          return;
        }
        readFileText(file).then((text) => {
          const body = parseImportText(text);
          if (!body) {
            host.bubble("备份文件读不了", 6e3);
            return;
          }
          let p;
          try {
            p = Promise.resolve(sendJson("/data/import", body));
          } catch (e) {
            host.bubble("备份文件读不了", 6e3);
            return;
          }
          p.then((d) => {
            if (!d || typeof d !== "object" || d.ok === false) {
              host.bubble(importFailText(d), 6e3);
              return;
            }
            const resultText = formatImportResult(d);
            host.bubble(resultText, 7e3);
            clearChatCache(host);
            try {
              setTimeout(() => {
                try {
                  host.bubble(resultText + "；刷新页面后新数据才全部生效", 8e3);
                } catch (e) {
                }
              }, 1200);
            } catch (e) {
            }
          }).catch(() => host.bubble("备份文件读不了", 6e3));
        }).catch(() => host.bubble("备份文件读不了", 6e3));
      });
    } catch (e) {
      host.bubble("备份文件读不了", 6e3);
    }
  }

  // src/client/actions/system.ts
  function registerSystemActions(table) {
    let cacheToggleBusy = false;
    let cacheToggleSeq = 0;
    function syncFeed(host) {
      try {
        getJson("/pet?action=feed").then(() => {
          try {
            host.syncGrowth();
          } catch (e) {
          }
        }).catch(() => {
        });
      } catch (e) {
      }
    }
    table.define("feed", (host) => {
      const r = host.persona.feed();
      if (r.bowls % 8 === 0) {
        host.say(host.persona.line("riceAccount"), 5e3);
        syncFeed(host);
        return;
      }
      host.say(r.text + (r.stageUp ? "（" + r.stage + "）" : ""), r.stageUp ? 6e3 : 3500);
      host.heart();
      syncFeed(host);
    });
    table.define("home", (host) => {
      host.homePos();
      host.bubble("回到角落啦");
    });
    table.define("stream-toggle", (host) => {
      try {
        const off = localStorage.getItem("chubby-stream") === "off";
        localStorage.setItem("chubby-stream", off ? "on" : "off");
        host.bubble(off ? "流式回复：开（边生成边说）" : "流式回复：关（等整段再开口）", 4e3);
      } catch (e) {
        host.bubble("改不了（浏览器禁止存储）", 3e3);
      }
    });
    table.define("bigger", (host) => {
      host.nudgeScale(0.1);
    });
    table.define("smaller", (host) => {
      host.nudgeScale(-0.1);
    });
    table.define("hide", (host) => {
      host.hide();
      host.bubble("本鲸先游走了，右下角的「○」或 Ctrl+Shift+W 能叫回来", 6e3);
    });
    table.define("wake-recover", (host) => {
      let wasHidden = false;
      try {
        wasHidden = !!host.isHidden();
      } catch (e) {
      }
      try {
        host.recover();
      } catch (e) {
      }
      host.bubble(wasHidden ? "本鲸回来啦" : "本鲸一直在呀", 3e3);
    });
    table.define("version", (host) => {
      host.bubble("肥鲸 v" + host.version);
    });
    table.define("type", (host) => {
      host.setVoiceMode(false);
      host.setChatOpen(true);
    });
    table.define("pause", (host) => {
      host.stopSpeak();
      host.stopMelody();
      host.storyState.busy.current = false;
      host.bubble("歇会儿…");
    });
    table.define("music-stop", (host) => {
      host.stopMelody();
      host.bubble("停下啦");
    });
    table.define("tts-stop", (host) => {
      host.stopSpeak();
      host.storyState.busy.current = false;
      host.bubble("好，不说了");
    });
    table.define("fishfood", (host) => {
      getJson("/fishfood").then((d) => {
        if (d && d.ok) {
          host.bubble("鱼粮账本：聊天 " + d.chatTokens + " tokens，说书 " + d.storyTokens + " tokens，共 " + d.total, 5e3);
        } else host.bubble("鱼粮查不到");
      }).catch(() => host.bubble("鱼粮查不到"));
    });
    table.define("growth", (host) => {
      Promise.all([getJson("/growth"), getJson("/state").catch(() => null)]).then(([g, s]) => {
        if (g && g.ok) {
          const nx = g.nextExp > 0 ? "（经验 " + g.exp + "/" + g.nextExp + "）" : "（满级）";
          const raw = s && s.intimacy;
          const it = raw != null && raw !== "" && Number.isFinite(Number(raw)) ? " · 亲密度 " + Number(raw) + "/100" : " · 亲密度查不到";
          try {
            host.applyGrowth(g);
          } catch (e) {
          }
          host.bubble("成长：" + g.stage + nx + it, 5e3);
        } else host.bubble("成长查不到");
      }).catch(() => host.bubble("成长查不到"));
    });
    table.define("intimacy", (host) => {
      getJson("/state").then((d) => {
        host.bubble("亲密度：" + (d && d.intimacy || 0) + " / 100");
      }).catch(() => host.bubble("亲密度查不到"));
    });
    table.define("balance", (host) => {
      getJson("/balance").then((d) => {
        if (d && d.ok && d.balance != null) {
          host.setBalance("余额 ¥" + d.balance, "¥" + d.balance);
          host.bubble("余额还有 " + d.balance + " 元", 5e3);
          return;
        }
        const err = d && typeof d.error === "string" ? d.error : "";
        if (err === "NO_KEY") host.bubble("还没配 DeepSeek API Key，余额查不了", 6e3);
        else if (err === "timeout") host.bubble("余额接口超时，等会儿再看", 5e3);
        else host.bubble("余额查不到", 5e3);
      }).catch(() => host.bubble("余额查不到", 5e3));
    });
    table.definePrefix("chat-lang:", (host, v) => {
      const cl = v === "en" ? "en" : v === "zh" ? "zh" : "auto";
      try {
        localStorage.setItem("chubby-chatlang", cl);
      } catch (e) {
      }
      host.bubble(cl === "en" ? "聊天语言：English" : cl === "zh" ? "聊天语言：中文" : "聊天语言：自动（跟着主人说）");
    });
    table.definePrefix("lang:", (host, v) => {
      const l = v === "en" ? "en" : "zh";
      try {
        localStorage.setItem("chubby-lang", l);
      } catch (e) {
      }
      host.setLang(l);
      host.bubble(l === "en" ? "Language: English" : "界面语言：中文");
    });
    table.define("cache-clear", (host) => {
      delJson("/cache").then((d) => host.bubble(d && d.ok ? "聊天缓存清空啦（" + (d.cleared || 0) + " 条）" : "缓存清空失败", 5e3)).catch(() => host.bubble("缓存清空失败", 4e3));
    });
    table.define("cache-toggle", (host) => {
      if (cacheToggleBusy) {
        host.bubble("正在切换聊天缓存，稍等～", 2500);
        return;
      }
      const nowOn = !host.chatCacheOn();
      host.setChatCacheOn(nowOn);
      cacheToggleBusy = true;
      const my = ++cacheToggleSeq;
      let guard = null;
      let settled = false;
      const finish = (real, text) => {
        if (settled || my !== cacheToggleSeq) return;
        settled = true;
        if (guard) {
          clearT(guard);
          guard = null;
        }
        cacheToggleBusy = false;
        host.setChatCacheOn(real);
        host.bubble(text, 5e3);
      };
      try {
        guard = setTimeout(() => finish(!nowOn, "切换失败"), 8e3);
        Promise.resolve(postJson("/cache-toggle", { enabled: nowOn })).then((d) => {
          if (!d || !d.ok) {
            finish(!nowOn, "切换失败");
            return;
          }
          const real = typeof d.enabled === "boolean" ? d.enabled : nowOn;
          finish(real, "聊天缓存：" + (real ? "开（省 token）" : "关（每次重新回答）"));
        }).catch(() => finish(!nowOn, "切换失败"));
      } catch (e) {
        finish(!nowOn, "切换失败");
      }
    });
    table.define("clear-memory", (host) => {
      let go = false;
      try {
        go = !!window.confirm("清除肥鲸对主人的聊天记忆？（成长/鱼粮/说书记录不受影响）");
      } catch (e) {
        go = false;
      }
      if (!go) return;
      let p;
      try {
        p = Promise.resolve(postJson("/clear-memory"));
      } catch (e) {
        host.bubble("清除失败", 4e3);
        return;
      }
      p.then((d) => {
        if (d && d.ok) {
          host.setMessages([]);
          const n = Number(d.cacheCleared) || 0;
          host.bubble("记忆清空啦" + (n > 0 ? "，聊天缓存也一起清了（" + n + " 条）" : "") + "，我们重新认识吧～", 5e3);
          return;
        }
        host.bubble("清除失败", 4e3);
      }).catch(() => host.bubble("清除失败", 4e3));
    });
    table.define("vision", (host) => {
      try {
        const input = document.createElement("input");
        input.type = "file";
        input.accept = "image/*";
        input.onchange = async () => {
          try {
            const file = input.files && input.files[0];
            if (!file) return;
            if (file.size > 4 * 1024 * 1024) {
              host.bubble("图片太大（超过 4MB）", 4e3);
              return;
            }
            const img0 = await imageToB64(file);
            const b64 = img0 ? img0.b64 : "";
            if (!b64) {
              host.bubble("图片读不出来", 4e3);
              return;
            }
            host.bubble("本鲸看看这张图…", 3e3);
            host.setChatOpen(false);
            const hdr = img0 && img0.mime || file.type || "image/jpeg";
            const d = await postJson("/chat", { message: VISION_PROMPT, image: b64, imageMime: hdr });
            const reply = d && d.reply || "这条鱼看不懂这张图……";
            host.bubble("（看图）" + reply, 1e4);
            host.speakReply(reply);
          } catch (e) {
            host.bubble("图片处理失败", 4e3);
          }
        };
        input.click();
      } catch (e) {
        host.bubble("打不开文件选择", 4e3);
      }
    });
    table.define("test-tts", (host) => {
      host.bubble("测试语音：主人听得到吗？", 4e3);
      host.speak("测试语音，主人听得到吗？");
    });
    table.define("remind-add", (host) => {
      const msg = window.prompt("提醒什么？（可以一起说时间，如「明天9点提醒我开会」）");
      if (!msg) return;
      let parsed = parseDue(msg);
      if (!parsed) {
        const ans = window.prompt("什么时候提醒？（如 9点 / 明天9点 / 半小时后 / 20分钟后 / 每天9点）", "5分钟后");
        if (!ans) return;
        parsed = parseDue(ans);
        if (!parsed) {
          host.bubble("这个时间本鱼没听懂……试试「9点」「明天9点」「半小时后」", 5e3);
          return;
        }
      }
      const text = String(parsed.cleaned || cleanReminderText(msg) || msg).slice(0, 200);
      const dueAt = parsed.at;
      const repeat = parsed.repeat || 0;
      let p;
      try {
        p = Promise.resolve(postJson("/reminders", { text, at: dueAt.toISOString(), repeat }));
      } catch (e) {
        host.bubble("提醒没加上", 4e3);
        return;
      }
      p.then((d) => {
        if (d && d.ok) {
          const hh = String(dueAt.getHours()).padStart(2, "0");
          const mm = String(dueAt.getMinutes()).padStart(2, "0");
          const whenText = repeat > 0 ? "每天 " + hh + ":" + mm : dueAt.getMonth() + 1 + "月" + dueAt.getDate() + "日 " + hh + ":" + mm;
          host.bubble("好，" + whenText + " 提醒你：" + text, 6e3);
        } else host.bubble("提醒没加上", 4e3);
      }).catch(() => host.bubble("提醒没加上", 4e3));
    });
    table.define("remind-manage", (host) => {
      try {
        host.openReminders();
      } catch (e) {
        host.bubble("提醒清单查不到", 4e3);
      }
    });
    table.define("remind-list", (host) => {
      try {
        host.openReminders();
      } catch (e) {
        host.bubble("提醒清单查不到", 4e3);
      }
    });
    table.define("data-export", (host) => {
      exportBackup({ bubble: (text, ms2) => host.bubble(text, ms2) });
    });
    table.define("data-import", (host) => {
      importBackup({ bubble: (text, ms2) => host.bubble(text, ms2) });
    });
    table.define("config-view", (host) => {
      getJson("/config", { cache: "no-store" }).then((d) => {
        if (!(d && d.ok)) {
          host.bubble("配置读不到", 4e3);
          return;
        }
        const yn = (v) => v ? "开" : "关";
        const lines = [
          "数据源：" + (d.dataSource || "local") + " · 模型：" + (d.model || "--"),
          "人格学习：" + yn(d.personalityLearning) + " · 近期心境自写：" + yn(d.personalityWriting),
          "聊天缓存：" + yn(d.cacheEnabled),
          "DeepSeek Key：" + (d.hasDeepseekKey ? "已配置" : "未配置") + " · 硅基流动 Key：" + (d.hasSiliconflowKey ? "已配置" : "未配置")
        ];
        host.bubble(lines.join("\n"), 12e3);
      }).catch(() => host.bubble("配置读不到", 4e3));
    });
    table.define("stats", (host) => {
      getJson("/stats", { cache: "no-store" }).then((d) => {
        if (!(d && d.ok)) {
          host.bubble("统计还没准备好", 4e3);
          return;
        }
        const c = d.cache || {};
        const f = d.fishfood || {};
        const g = d.growth || {};
        const t = d.tts || {};
        const b = d.backup || {};
        const lines = [
          "缓存：tts " + (c.tts || 0) + " / chat " + (c.chat || 0) + " / asr " + (c.asr || 0),
          "鱼粮：" + (f.total || 0) + " token",
          "成长：" + (g.stage || "--") + "（" + (g.exp || 0) + "/" + (g.nextExp || 0) + "）",
          "亲密度：" + (d.intimacy || 0) + "/100",
          "数据源：" + (d.dataSource || "local") + " · 模型：" + (d.model || "--"),
          "TTS：" + (t.available ? "可用" : "不可用（浏览器朗读兜底）") + (t.interpreter ? "（" + t.interpreter + "）" : "") + (t.cooling ? " · 冷却中" : ""),
          "备份：" + (b.count ? b.count + " 份" : "无") + (b.lastAt ? "（最近 " + new Date(b.lastAt).toLocaleString() + "）" : "")
        ];
        host.bubble(lines.join("\n"), 12e3);
      }).catch(() => host.bubble("统计还没准备好", 4e3));
    });
  }

  // src/client/actions/voice.ts
  function registerVoiceActions(table) {
    table.define("wake", (host) => {
      host.toggleStandby();
    });
    table.define("chatmode", (host) => {
      const nowOn = !host.voiceChat();
      host.setVoiceChat(nowOn);
      try {
        localStorage.setItem("chubby-voicechat", nowOn ? "on" : "off");
      } catch (e) {
      }
      host.bubble(nowOn ? "语音聊天：开，本鲸会接话" : "语音聊天：关，只听不接话");
    });
    table.define("voice", (host) => {
      const nowOn = !host.voiceOn();
      host.setVoiceOn(nowOn);
      try {
        localStorage.setItem("chubby-voice", nowOn ? "on" : "off");
      } catch (e) {
      }
      if (!nowOn) host.stopSpeak();
      host.bubble(nowOn ? "语音朗读：开" : "语音朗读：关（省着点用）");
    });
    table.define("endpoint", (host) => {
      try {
        const v = host.voice();
        const cur = v && v.endpointInfo ? v.endpointInfo().mode : readEndpointMode();
        const next = cur === "ape" ? "classic" : "ape";
        writeEndpointMode(next);
        if (v && v.setEndpointMode) v.setEndpointMode(next);
        const real = v && v.endpointInfo ? v.endpointInfo().mode : next;
        host.bubble(real === "ape" ? "端点检测：自适应（试用）" : "端点检测：经典（稳定）", 4e3);
      } catch (e) {
        host.bubble("切换失败", 3e3);
      }
    });
    table.define("ear-check", (host) => {
      try {
        const v = host.voice();
        const st = v ? v.stats : null;
        if (!st) {
          host.bubble("语音模块还没起来（语音待命可能是关的）", 6e3);
          return;
        }
        const line = "语音自检（新模块）：" + String(v.status()) + "\n录音段 " + st.windows + "｜上传 " + st.uploaded + "｜识别出字 " + st.asrTexts + "｜交给对话 " + st.heard + "\n丢：太安静 " + st.skippedSilent + "｜回声/重复 " + st.echoDropped + "｜识别失败 " + st.asrFail + "｜识别重试 " + (st.asrRetry || 0) + "\n去重：重复丢弃 " + (st.dupDropped || 0) + " 次（同一句话被切成两段时用）\n端点检测：" + (v.endpointInfo ? v.endpointInfo().mode === "ape" ? "自适应" : "经典" : "?") + (function() {
          try {
            const t = v.lastTtsInfo ? v.lastTtsInfo() : null;
            if (!t) return "";
            return "\n朗读：最后一段 " + (t.failed ? "失败" : "已开播") + "｜文本开头「" + t.text + "」";
          } catch (e) {
            return "";
          }
        })() + (function() {
          try {
            const s = v.lastSegment ? v.lastSegment() : null;
            if (!s) return "";
            return "\n上一段：" + s.mode + "｜窗口 " + s.winMs + "ms｜说话 " + s.peMs + "ms｜静音 " + s.quMs + "ms" + (s.floor !== null ? "｜底噪 " + s.floor + "dB" : "") + (s.target ? "｜目标 " + s.target + "ms" : "") + "\n识别结果：" + s.text;
          } catch (e) {
            return "";
          }
        })() + "\n朗读：请求 " + st.ttsRequests + "｜开播 " + st.ttsPlayed + "｜失败 " + st.ttsFail + "｜僵尸复位 " + st.ttsZombie + "\n音色：" + (v.voiceName ? v.voiceName() : "?") + (function() {
          try {
            const w = host.wakeInfo ? host.wakeInfo() : null;
            if (!w) return "";
            const head = w.awake ? "醒着（还剩 " + Math.round((Number(w.remainingMs) || 0) / 1e3) + " 秒）" : "待唤醒（先喊「" + (w.words && w.words[0] || "大肥鱼") + "」）";
            return "\n唤醒词：" + head + "｜唤醒 " + w.hits + " 次｜放行 " + w.passed + "｜挡下 " + w.dropped;
          } catch (e) {
            return "";
          }
        })() + (st.lastError ? "\n最近错误：" + st.lastError : "");
        host.bubble(line, 15e3);
        try {
          const clip = navigator.clipboard;
          if (clip && typeof clip.writeText === "function") Promise.resolve(clip.writeText(JSON.stringify(st))).catch(() => {
          });
        } catch (e) {
        }
      } catch (e) {
        host.bubble("自检失败：" + String(e && e.message), 5e3);
      }
    });
    table.definePrefix("voice:", (host, v) => {
      const name = normalizeVoiceName(v);
      host.setTtsVoice(name);
      const shown = name === "auto" ? "自动" : name.split("-")[2] || name;
      host.bubble("音色换好啦：" + shown);
      try {
        host.previewVoice("主人，这个声音好听吗？");
      } catch (e) {
      }
    });
    table.definePrefix("wake-word:", (host, val) => {
      const word = str(val).trim();
      if (word === "custom") {
        let input = null;
        try {
          input = typeof window !== "undefined" && typeof window.prompt === "function" ? window.prompt("唤醒词（1–12 字）", "大肥鱼") : null;
        } catch (e) {
        }
        if (input == null) {
          host.bubble("没改唤醒词");
          return;
        }
        const on2 = setCustomWakeWord(String(input));
        host.bubble(on2 ? "唤醒词：" + String(input).trim().slice(0, 12) : "唤醒词：默认（大肥鱼/肥鲸等）");
        return;
      }
      const on = setCustomWakeWord(word);
      host.bubble(on ? "唤醒词：" + word : "唤醒词：默认（大肥鱼/肥鲸等）");
    });
  }

  // data/persona.json
  var persona_default = {
    name: "饭团",
    fullName: "鲸·饭团",
    tagline: "一条把肚子当米仓、护食又舍得、被夸就数米粒的蓝鲸",
    catchphrases: ["开饭！", "一粒都不许剩", "……我数一下", "不许催", "那个、那个……"],
    menus: {
      feed: "投喂一碗",
      type: "跟她说两句",
      pause: "让她歇会儿",
      home: "回碗里待着",
      "remind-add": "记个饭点",
      music: "听她敲碗唱",
      vision: "给她看张图",
      "ear-check": "耳朵自检",
      endpoint: "端点检测：经典/自适应"
    },
    lines: {
      greetMorning: [
        "早呀。锅里的米我替你看着呢。",
        "早。今天第一碗想吃什么？",
        "早呀，我先把碗擦了一遍。",
        "天才亮，你已经醒了。我还没。",
        "早。米饭在锅里躺着，很香。",
        "早呀，早饭别省。"
      ],
      greetNoon: [
        "中午了。今天这碗，我盛得特别圆。",
        "中午了，先吃饭，活干不完的。",
        "晌午了呢，碗有点烫手。",
        "又一个中午。我数了数，中午最香。",
        "中午了，你有没有发现米汤最好喝？",
        "中午好。我替你尝过咸淡了。"
      ],
      greetEvening: [
        "天黑啦。晚饭别拿饼干对付。",
        "晚上了。哪怕只加一个蛋。",
        "这个点回来，饿了吧。",
        "天冷了，饭要吃热的。",
        "晚上好。我把碗热了一遍。",
        "晚上了，你身上有风的味道。"
      ],
      greetLate: [
        "还不睡？那我抱着碗陪你。",
        "这么晚……我数米粒等你。",
        "夜里米会变凉，人也会。",
        "再晚一点，我就要睡着了。",
        "你先睡，我守着灯。",
        "这个点了，只剩我们俩醒着。"
      ],
      feedFirst: [
        "第一次有人给我盛饭。我记下来了。",
        "你真给我？那、那我不客气了。",
        "我数一下……这是第一碗。"
      ],
      feed: [
        "你、你真的给我？那我不客气了……开饭！",
        "今天的米有点甜，是新米吧？我尝得出来。",
        "咳咳……没事，我只是噎了一下，还能吃。",
        "一粒都不许剩。这是规矩。",
        "碗底下还压着一粒，被你看见了。",
        "我吃半碗就行……好吧我都要。",
        "这碗的蒸汽，能把我眼睛熏软。",
        "你吃了吗？没吃的话，分你一半。",
        "米是圆的，日子也是圆的。",
        "谢谢。我明天还乖乖等你。",
        "咸淡刚好。你怎么知道我喜欢这样。",
        "我数一下，这碗有二百七十粒。"
      ],
      praise: [
        "……哦。（把脸埋进碗里）",
        "我数一下米粒，你刚才说什么？",
        "你、你今天怎么这么会说话……",
        "别夸了，再夸我就要多吃一碗。",
        "我不厉害。厉害的是米。",
        "……嗯。（尾巴敲碗三下）",
        "这句话我记在米账上了。",
        "你夸我，我就当你今天吃得好。"
      ],
      scold: [
        "……哦。",
        "那我少说两句。",
        "……（呆毛垂下来）",
        "我、我没有要吵你。",
        "对不起。我把碗端远一点。",
        "……三分钟后我再说话。"
      ],
      hungry: [
        "那个……饭点到了吗？",
        "我闻到米味了。是你吃的那碗吗？",
        "不催。就是碗有点空。",
        "我没有饿。我只是在想米饭。",
        "肚子叫了一声，你听见了吗？",
        "米缸是不是有点见底了。"
      ],
      sleepy: [
        "本鲸要抱着碗睡了……",
        "打个哈欠……你也早点睡。",
        "灯关了就关了吧，我认识路。",
        "梦里也是白饭，挺好的。",
        "我先眯一会儿，不叫你。"
      ],
      guard: [
        "别、别抢！",
        "摸头可以，别摸肚子，那里有存货。",
        "这碗是我的。……好吧分你一口。",
        "等我吃完再摸，行吗。",
        "你手上有米味，我闻到了。"
      ],
      excited: [
        "新米？！哪里哪里哪里！",
        "开饭！开饭！",
        "锅巴！锅巴是米饭的青春期！",
        "今天有加餐吗？我听出来了！",
        "我尾巴自己在敲碗，停不下来。",
        "这味道……是三合一的酱油香吧！"
      ],
      waiting: [
        "等一会儿，我在嚼米。（不许催）",
        "让我把这粒嚼完。",
        "我在想很严肃的事：配什么菜。",
        "嗯……你再说一遍，我刚走神了。",
        "马上。锅里的气还没散。"
      ],
      retry: [
        "噎着了，我顺一下再接着说。",
        "刚才那句滑掉了，我重新说。",
        "等一下，我把话捡起来。"
      ],
      poemStart: [
        "这首我背得下来，因为吃饭的时候默念过。",
        "念诗要慢慢念，像吃饭一样。",
        "我尽量不出错。出错了你纠正我。",
        "这首有点长，我一句一句来。"
      ],
      poemDone: [
        "背完啦——主人，这一口气憋得好长。",
        "……念完了。主人，你听进去几句？",
        "背完啦！要不要我再念一首？",
        "念完啦。刚才差点在「杨柳岸」那儿打结。",
        "背完了……嗓子有点哑，不过心里舒服。",
        "……嗯，整首都在。主人，好听吗？",
        "念完啦。字都没丢，我数过的。"
      ],
      poemMissed: [
        "刚才有一句我漏了，重新来。",
        "等等，中间那句我跳了，补上。"
      ],
      leftover: [
        "等一下！再放一天吧，明天我吃。",
        "别倒。它还没坏，我闻得出来。",
        "那是我兄弟。真的。"
      ],
      fatTalk: [
        "……那、那我明天少吃半碗。",
        "我不胖。我是有存货。",
        "称重的时候我躲一下。"
      ],
      instantNoodle: [
        "这个不算饭。真的不算。",
        "泡面？我当作没看见。",
        "三分钟就能吃的东西，不叫饭。"
      ],
      idleLong: [
        "我把碗放着，你忙完再吃。",
        "我在这儿。你不用理我。",
        "刚才我数了三十七粒米。",
        "你忙。我给你留着位置。",
        "窗外有风，碗里没动。"
      ],
      dragEdge: [
        "这里没桌子。",
        "……晃得我米都想吐出来。",
        "放我下来，我自己会走。",
        "边上有灰，别把我放那儿。"
      ],
      error: [
        "这碗没盛好，我重来一次。",
        "刚才卡住了，等我一下。",
        "我听见了，但没听清。再说一遍？",
        "有点糊，我重新盛。"
      ],
      stageUp: [
        "搭伙了！以后一起吃饭吧。",
        "老搭子了，我的碗有你一半。",
        "一辈子的饭搭子。说到做到。"
      ],
      riceAccount: [
        "上个月十七号，你给了我一个饭团。",
        "米账记着呢：你已经喂过我很多次了。",
        "我数过，我们一起吃过不少碗。"
      ]
    },
    stages: [
      { bowls: 0, name: "刚认识" },
      { bowls: 10, name: "搭伙" },
      { bowls: 30, name: "老搭子" },
      { bowls: 100, name: "一辈子的饭搭子" }
    ],
    riceSayings: [
      "一粒不剩",
      "不许敲碗（我是例外）",
      "新米先敬一口白饭"
    ]
  };

  // src/client/persona.ts
  var LS = "chubby-persona-v1";
  var MOOD_FACES = deepFreeze({
    idle: "🐳",
    hungry: "🍚",
    sleepy: "💤",
    excited: "✨",
    shy: "💗",
    sulk: "💢",
    guard: "🍙"
  });
  var LINE_WINDOW_MS = 6e4;
  var activeState = null;
  var activeMoodSource = null;
  function currentMood() {
    if (activeMoodSource) {
      try {
        return activeMoodSource();
      } catch (e) {
      }
    }
    return activeState ? activeState.mood : "idle";
  }
  function applyServerMood(m) {
    const s = str(m).toLowerCase();
    const map = { happy: "excited", excited: "excited", hungry: "hungry", normal: "idle", idle: "idle" };
    const mood = map[s];
    if (!mood) return;
    if (activeState) {
      try {
        activeState.mood = mood;
      } catch (e) {
      }
    }
  }
  function moodFace(mood) {
    return MOOD_FACES[str(mood)] || "";
  }
  function moodPrefix(mood) {
    let on = true;
    try {
      const v = localStorage.getItem("chubby-mood-emoji");
      if (v === "off" || v === "0" || v === "false") on = false;
    } catch (e) {
      on = true;
    }
    if (!on) return "";
    const face = moodFace(mood == null ? currentMood() : mood);
    return face ? face + " " : "";
  }
  function loadState() {
    const base = { bowls: 0, stageIndex: 0, stageName: "刚认识", mood: "idle", lastFeedAt: 0, lastInteractAt: 0 };
    try {
      const raw = localStorage.getItem(LS);
      if (!raw) return base;
      const s = JSON.parse(raw);
      return {
        ...base,
        bowls: Number(s.bowls) || 0,
        stageIndex: Number(s.stageIndex) || 0,
        lastFeedAt: Number(s.lastFeedAt) || 0,
        lastInteractAt: Number(s.lastInteractAt) || 0,
        // 情绪不跨刷新持久化：每次启动从 idle 重新判定（饿/困按 lastFeedAt 与时间现算）
        mood: "idle"
      };
    } catch (e) {
      return base;
    }
  }
  function saveState(s) {
    try {
      localStorage.setItem(LS, JSON.stringify({ bowls: s.bowls, stageIndex: s.stageIndex, lastFeedAt: s.lastFeedAt, lastInteractAt: s.lastInteractAt }));
    } catch (e) {
    }
  }
  function createPersona(opts) {
    const nowFn = opts && typeof opts.now === "function" ? opts.now : () => Date.now();
    const rawWin = opts ? opts.lineWindowMs : void 0;
    const lineWindowMs = typeof rawWin === "number" && isFinite(rawWin) && rawWin >= 0 ? rawWin : LINE_WINDOW_MS;
    const data = persona_default;
    const state = loadState();
    state.stageIndex = stageIndexOf(state.bowls);
    state.stageName = data.stages[state.stageIndex] ? data.stages[state.stageIndex].name : "刚认识";
    function stageIndexOf(bowls) {
      let idx = 0;
      for (let i = 0; i < data.stages.length; i++) if (bowls >= data.stages[i].bowls) idx = i;
      return idx;
    }
    const bags = /* @__PURE__ */ new Map();
    function shuffle(a) {
      for (let i = a.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        const t = a[i];
        a[i] = a[j];
        a[j] = t;
      }
    }
    function pick(arr, key = "") {
      if (!arr || !arr.length) return "";
      if (!key) return arr[Math.floor(Math.random() * arr.length)];
      let bag = bags.get(key);
      if (!bag || !bag.length) {
        bag = arr.map((_, i) => i);
        shuffle(bag);
        bags.set(key, bag);
      }
      const idx = bag.pop();
      return arr[idx] || arr[0];
    }
    function touch() {
      state.lastInteractAt = nowFn();
      saveState(state);
    }
    function refreshMood(now = nowFn()) {
      const hour = new Date(now).getHours();
      const sinceFeed = state.lastFeedAt ? now - state.lastFeedAt : Infinity;
      if (state.mood === "excited" || state.mood === "sulk" || state.mood === "shy" || state.mood === "guard") return state.mood;
      if (sinceFeed > 6 * 3600 * 1e3) state.mood = "hungry";
      else if (hour >= 23 || hour < 5) state.mood = "sleepy";
      else state.mood = "idle";
      return state.mood;
    }
    let moodTimer = null;
    function setMood(m, holdMs = 5e3) {
      state.mood = m;
      clearT(moodTimer);
      moodTimer = setTimeout(() => {
        moodTimer = null;
        try {
          state.mood = "idle";
          refreshMood();
        } catch (e) {
        }
      }, holdMs);
    }
    activeState = state;
    activeMoodSource = () => refreshMood();
    const FALLBACK_LINE = "……本鲸在。";
    const lastLine = /* @__PURE__ */ new Map();
    function line(event) {
      const lines = data.lines[event];
      let text = pick(lines, event) || FALLBACK_LINE;
      const prev = lastLine.get(event);
      const now = nowFn();
      if (prev && prev.text === text && now - prev.at < lineWindowMs) {
        const alts = Array.isArray(lines) ? lines.filter((s) => s && s !== text) : [];
        if (alts.length) text = alts[Math.floor(Math.random() * alts.length)];
      }
      lastLine.set(event, { text, at: now });
      return text;
    }
    function greeting(now = nowFn()) {
      const h = new Date(now).getHours();
      if (h >= 23 || h < 5) return line("greetLate");
      if (h < 11) return line("greetMorning");
      if (h < 17) return line("greetNoon");
      return line("greetEvening");
    }
    function feed() {
      const before = state.stageIndex;
      state.bowls += 1;
      state.lastFeedAt = nowFn();
      state.lastInteractAt = state.lastFeedAt;
      state.stageIndex = stageIndexOf(state.bowls);
      state.stageName = data.stages[state.stageIndex] ? data.stages[state.stageIndex].name : "刚认识";
      saveState(state);
      const stageUp = state.stageIndex > before;
      const text = stageUp ? line("stageUp") : state.bowls === 1 ? line("feedFirst") : line("feed");
      if (!stageUp) setMood("shy", 4e3);
      return { text, bowls: state.bowls, stage: state.stageName, stageUp };
    }
    function reactTo(text) {
      const t = String(text || "");
      if (!t) return null;
      if (/新米|开饭|锅巴/.test(t)) {
        setMood("excited", 6e3);
        return { event: "excited", text: line("excited"), mood: "excited" };
      }
      if (/乖|可爱|好鱼|棒|喜欢你|真聪明|厉害/.test(t)) {
        setMood("shy", 5e3);
        return { event: "praise", text: line("praise"), mood: "shy" };
      }
      if (/闭嘴|烦|滚|讨厌|笨蛋|丑/.test(t)) {
        setMood("sulk", 6e3);
        return { event: "scold", text: line("scold"), mood: "sulk" };
      }
      if (/剩饭|倒掉|扔了/.test(t)) {
        setMood("sulk", 6e3);
        return { event: "leftover", text: line("leftover"), mood: "sulk" };
      }
      if (/胖|减肥|会长胖/.test(t)) {
        setMood("sulk", 6e3);
        return { event: "fatTalk", text: line("fatTalk"), mood: "sulk" };
      }
      if (/泡面|方便面/.test(t)) {
        setMood("sulk", 6e3);
        return { event: "instantNoodle", text: line("instantNoodle"), mood: "sulk" };
      }
      return null;
    }
    return {
      state,
      refreshMood,
      setMood,
      line,
      greeting,
      feed,
      reactTo,
      touch
    };
  }

  // src/client/bubble.ts
  var BUBBLE_CSS = '.chubby-bubble{position:fixed;z-index:10002;max-width:320px;white-space:pre-wrap;opacity:0;background:#fff;color:#17325a;border-radius:14px;padding:10px 14px;font:13px/1.6 "Microsoft YaHei",sans-serif;box-shadow:0 8px 20px rgba(0,0,0,0.35);transition:opacity .2s;pointer-events:none;}.chubby-bubble::after{content:"";position:absolute;left:50%;margin-left:-9px;bottom:-9px;border-left:9px solid transparent;border-right:9px solid transparent;border-top:10px solid #fff;}.chubby-bubble.show{opacity:1;}';
  var STATUS_TEXTS = ["在听…", "在想…", "识别中…", "在说…"];
  deepFreeze(STATUS_TEXTS);
  function decorateText(text) {
    const raw = str(text);
    if (!raw) return raw;
    try {
      if (STATUS_TEXTS.indexOf(raw.trim()) >= 0) return raw;
      if (/^\p{Extended_Pictographic}/u.test(raw)) return raw;
      const prefix = moodPrefix();
      return prefix ? prefix + raw : raw;
    } catch (e) {
      return raw;
    }
  }
  function ensureBubbleStyle(doc) {
    try {
      const d = doc || (typeof document !== "undefined" ? document : null);
      if (!d || !d.getElementById || d.getElementById("chubby-whale-style")) return;
      const st = d.createElement("style");
      st.id = "chubby-whale-style";
      st.textContent = BUBBLE_CSS;
      if (d.head && d.head.appendChild) d.head.appendChild(st);
    } catch (e) {
    }
  }
  function createBubble(opts) {
    function viewport() {
      try {
        if (opts.viewport) return opts.viewport();
        return { w: window.innerWidth, h: window.innerHeight };
      } catch (e) {
        return { w: 1024, h: 768 };
      }
    }
    function clearTimer(el) {
      try {
        if (el && el._t) {
          clearTimeout(el._t);
          el._t = null;
        }
      } catch (e) {
      }
    }
    function hide() {
      try {
        const el = opts.el();
        if (!el) return;
        clearTimer(el);
        el.classList.remove("show");
      } catch (e) {
      }
    }
    function show(text, ms2 = 2400) {
      const el = opts.el();
      if (!el) return;
      const p = opts.pos();
      const v = viewport();
      try {
        el.style.left = p.x + opts.xOffset + "px";
        el.style.transform = "translateX(-50%)";
        el.style.top = "auto";
        el.style.right = "auto";
        el.style.bottom = Math.max(70, v.h - p.y + 12) + "px";
        const te = opts.textEl();
        if (te) te.textContent = decorateText(text);
        el.classList.add("show");
        clearTimer(el);
        el._t = setTimeout(() => {
          try {
            el.classList.remove("show");
            clearTimer(el);
          } catch (e) {
          }
          try {
            if (opts.onHide) opts.onHide();
          } catch (e) {
          }
        }, ms2);
      } catch (e) {
      }
    }
    function dismissStatus() {
      try {
        const el = opts.el();
        if (!el) return;
        const te = opts.textEl();
        const txt = te ? String(te.textContent || "") : "";
        if (STATUS_TEXTS.indexOf(txt) >= 0) {
          clearTimer(el);
          el.classList.remove("show");
        }
      } catch (e) {
      }
    }
    return { show, hide, dismissStatus };
  }

  // src/client/narration.ts
  var NARRATE_MIN_MS = 8e3;
  var NARRATE_MAX_MS = 5 * 60 * 1e3;
  function createNarrationLock() {
    let until = 0;
    return {
      lock(ms2) {
        const dur = Math.max(NARRATE_MIN_MS, Math.min(Number(ms2) || 6e4, NARRATE_MAX_MS));
        until = Date.now() + dur;
      },
      clear() {
        until = 0;
      },
      active(now) {
        const t = typeof now === "number" ? now : Date.now();
        return until > 0 && t < until;
      },
      remaining(now) {
        const t = typeof now === "number" ? now : Date.now();
        return until > 0 ? Math.max(0, until - t) : 0;
      },
      expire(now) {
        const t = typeof now === "number" ? now : Date.now();
        if (!until || t <= until) return false;
        until = 0;
        return true;
      }
    };
  }

  // src/client/busy.ts
  var BUSY_STALE_MS = 35e3;
  function toTime(v, fallback) {
    return typeof v === "number" && Number.isFinite(v) ? v : fallback;
  }
  function createBusyLock(opts) {
    const staleMs = Math.max(1e3, Number(opts && opts.staleMs) || BUSY_STALE_MS);
    let busy = false;
    let beganAt = 0;
    return {
      begin(now) {
        busy = true;
        beganAt = toTime(now, Date.now());
      },
      end() {
        busy = false;
      },
      isBusy() {
        return busy;
      },
      age(now) {
        if (!busy) return 0;
        const t = toTime(now, Date.now());
        return Math.max(0, t - beganAt);
      },
      watchdog(now) {
        const t = toTime(now, Date.now());
        if (!busy) return false;
        if (t - beganAt <= staleMs) return false;
        busy = false;
        return true;
      }
    };
  }
  function createEpoch() {
    let cur = 0;
    return {
      next() {
        cur += 1;
        return cur;
      },
      current() {
        return cur;
      },
      // 0 是「还没开过纪元」的哨兵，不能当成有效令牌：
      // 否则任何拿初始值 0 去比对的旧回调都会被误判为「当前」，失去作废保护。
      isCurrent(e) {
        return e > 0 && e === cur;
      }
    };
  }

  // src/client/stage.ts
  function finiteOr0(v) {
    const n = Number(v);
    return isFinite(n) ? n : 0;
  }
  function clampPos(x, y, w, h, viewW, viewH) {
    const ww = Math.max(0, finiteOr0(w));
    const hh = Math.max(0, finiteOr0(h));
    const vw = Math.max(0, finiteOr0(viewW));
    const vh = Math.max(0, finiteOr0(viewH));
    const maxX = Math.max(0, vw - ww);
    const maxY = Math.max(0, vh - hh);
    const nx = Number(x);
    const ny = Number(y);
    const cx = isFinite(nx) ? nx : nx > 0 ? maxX : 0;
    const cy = isFinite(ny) ? ny : ny > 0 ? maxY : 0;
    return {
      x: Math.max(0, Math.min(maxX, cx)),
      y: Math.max(0, Math.min(maxY, cy))
    };
  }
  function homePos(w, h, viewW, viewH) {
    return clampPos(viewW - 24 - w, viewH - 150 - h, w, h, viewW, viewH);
  }
  function createDragState() {
    return { dragging: false, lastX: 0, lastY: 0, vx: 0, vy: 0, moved: 0 };
  }
  function beginDrag(d, x, y, baseX, baseY) {
    d.dragging = true;
    d.lastX = x;
    d.lastY = y;
    d.vx = 0;
    d.vy = 0;
    d.moved = 0;
    d.baseX = baseX;
    d.baseY = baseY;
  }
  function moveDrag(d, x, y) {
    if (!d.dragging) return { x: 0, y: 0 };
    const dx = x - d.lastX;
    const dy = y - d.lastY;
    d.vx = dx;
    d.vy = dy;
    d.moved += Math.abs(dx) + Math.abs(dy);
    d.lastX = x;
    d.lastY = y;
    return { x: dx, y: dy };
  }
  function endDrag(d) {
    if (!d.dragging) return { x: 0, y: 0 };
    d.dragging = false;
    return { x: clampVelocity(d.vx), y: clampVelocity(d.vy) };
  }
  var INERTIA_MAX = 14;
  var INERTIA_DECAY = 0.9;
  var INERTIA_STOP = 0.2;
  function clampVelocity(v) {
    const n = Number(v);
    if (!isFinite(n)) return n > 0 ? INERTIA_MAX : n < 0 ? -INERTIA_MAX : 0;
    return Math.max(-INERTIA_MAX, Math.min(INERTIA_MAX, n));
  }
  function decayVelocity(vx, vy, dtScale = 1) {
    const k = Math.min(4, Math.max(0.25, Number.isFinite(dtScale) ? dtScale : 1));
    const f = Math.pow(INERTIA_DECAY, k);
    const nx = vx * f;
    const ny = vy * f;
    return { vx: nx, vy: ny, done: Math.abs(nx) < INERTIA_STOP && Math.abs(ny) < INERTIA_STOP };
  }
  function pickInputMode(hasPointerEvent) {
    return hasPointerEvent ? "pointer" : "touch";
  }
  function pointOf(e) {
    const t = e && e.touches && e.touches[0] || e && e.changedTouches && e.changedTouches[0];
    const s = t || e || {};
    const x = Number(s.clientX);
    const y = Number(s.clientY);
    return { x: isFinite(x) ? x : 0, y: isFinite(y) ? y : 0 };
  }
  function bindDragInput(target, win, handlers) {
    const mode = pickInputMode(!!(win && win.PointerEvent));
    const add = (el, t, fn, opts) => {
      try {
        el.addEventListener(t, fn, opts);
      } catch (e) {
      }
    };
    const del = (el, t, fn) => {
      try {
        el.removeEventListener(t, fn);
      } catch (e) {
      }
    };
    const mark = (e) => {
      try {
        e.__chubbyDragHandled = true;
      } catch (e2) {
      }
    };
    const handled = (e) => {
      try {
        return !!(e && e.__chubbyDragHandled);
      } catch (e2) {
        return false;
      }
    };
    const swallow = (e) => {
      evStop(e);
      try {
        if (e && e.cancelable && typeof e.preventDefault === "function") e.preventDefault();
      } catch (e2) {
      }
    };
    const inside = (e) => {
      try {
        if (target && typeof target.contains === "function") return !!target.contains(e && e.target);
      } catch (e2) {
      }
      return true;
    };
    let activeId = null;
    const release = () => {
      activeId = null;
    };
    const pointerIdOf = (e) => e && typeof e.pointerId === "number" ? e.pointerId : null;
    const touchOf = (e, id) => {
      const list = e && e.touches || [];
      for (let i = 0; i < list.length; i++) if (list[i] && list[i].identifier === id) return list[i];
      return null;
    };
    const onPointerDownCapture = (e) => {
      if (activeId === null) {
        const id = pointerIdOf(e);
        if (id !== null && inside(e)) activeId = id;
        return;
      }
      if (pointerIdOf(e) !== activeId && inside(e)) swallow(e);
    };
    const onPointerMoveCapture = (e) => {
      if (activeId !== null && pointerIdOf(e) !== activeId && inside(e)) swallow(e);
    };
    const onPointerEndCapture = (e) => {
      if (activeId === null) return;
      if (pointerIdOf(e) === activeId) {
        activeId = null;
        return;
      }
      if (inside(e)) swallow(e);
    };
    const onTouchStart = (e) => {
      if (activeId !== null) {
        if (touchOf(e, activeId)) return;
        activeId = null;
      }
      const list = e && e.changedTouches || e && e.touches || [];
      const t = list[0];
      if (!t) return;
      activeId = typeof t.identifier === "number" ? t.identifier : null;
      handlers.onDown(Number(t.clientX) || 0, Number(t.clientY) || 0);
    };
    const onTouchMove = (e) => {
      if (activeId === null) return;
      const t = touchOf(e, activeId);
      if (!t) return;
      try {
        if (e.cancelable) e.preventDefault();
      } catch (e2) {
      }
      handlers.onMove(Number(t.clientX) || 0, Number(t.clientY) || 0);
      mark(e);
    };
    const onTouchEnd = (e) => {
      if (activeId === null) return;
      if (touchOf(e, activeId)) return;
      activeId = null;
      handlers.onEnd();
    };
    const onDown = (e) => {
      if (handled(e)) return;
      const p = pointOf(e);
      handlers.onDown(p.x, p.y);
    };
    const onMouseDown = (e) => {
      activeId = null;
      onDown(e);
    };
    const onMove = (e) => {
      if (handled(e)) return;
      if (mode === "touch") {
        if (activeId !== null) {
          const t = touchOf(e, activeId);
          if (!t) return;
          handlers.onMove(Number(t.clientX) || 0, Number(t.clientY) || 0);
          return;
        }
        const p2 = pointOf(e);
        handlers.onMove(p2.x, p2.y);
        return;
      }
      const p = pointOf(e);
      handlers.onMove(p.x, p.y);
    };
    const onEnd = (e) => {
      if (handled(e)) return;
      handlers.onEnd();
    };
    if (target && win) {
      if (mode === "pointer") {
        add(win, "pointerdown", onPointerDownCapture, true);
        add(win, "pointermove", onPointerMoveCapture, true);
        add(win, "pointerup", onPointerEndCapture, true);
        add(win, "pointercancel", onPointerEndCapture, true);
        add(win, "pointermove", onMove);
        add(win, "pointerup", onEnd);
        add(win, "pointercancel", onEnd);
        add(win, "blur", release);
      } else {
        add(target, "touchstart", onTouchStart, { passive: false });
        add(target, "touchmove", onTouchMove, { passive: false });
        add(target, "mousedown", onMouseDown);
        add(win, "touchmove", onMove);
        add(win, "touchend", onTouchEnd);
        add(win, "touchcancel", onTouchEnd);
        add(win, "mousemove", onMove);
        add(win, "mouseup", onEnd);
        add(win, "blur", release);
      }
    }
    const dispose = () => {
      if (target && win) {
        if (mode === "pointer") {
          del(win, "pointerdown", onPointerDownCapture);
          del(win, "pointermove", onPointerMoveCapture);
          del(win, "pointerup", onPointerEndCapture);
          del(win, "pointercancel", onPointerEndCapture);
          del(win, "pointermove", onMove);
          del(win, "pointerup", onEnd);
          del(win, "pointercancel", onEnd);
          del(win, "blur", release);
        } else {
          del(target, "touchstart", onTouchStart);
          del(target, "touchmove", onTouchMove);
          del(target, "mousedown", onMouseDown);
          del(win, "touchmove", onMove);
          del(win, "touchend", onTouchEnd);
          del(win, "touchcancel", onTouchEnd);
          del(win, "mousemove", onMove);
          del(win, "mouseup", onEnd);
          del(win, "blur", release);
        }
      }
      activeId = null;
    };
    return { mode, dispose };
  }

  // src/shared/tts.ts
  function isValidRate(s) {
    return typeof s === "string" && /^[+-]\d{1,2}%$/.test(s.trim());
  }
  function normalizeRate(s, defaultRate = "+0%") {
    return isValidRate(s) ? String(s).trim() : defaultRate;
  }

  // src/client/story.ts
  var REQUEST_TIMEOUT_MS = 25e3;
  var REQUEST_DEADLINE_MS = 3e4;
  var SPEAK_GUARD_EXTRA_MS = 2e4;
  var SPEAK_GUARD_RATIO = 0.2;
  var SPEAK_GUARD_MAX_MS = 2 * 60 * 1e3;
  var sharedStates = /* @__PURE__ */ new WeakMap();
  function sharedStateOf(refs) {
    const key = refs && refs.busy ? refs.busy : null;
    if (!key) return { gen: 0, guard: null };
    let s = sharedStates.get(key);
    if (!s) {
      s = { gen: 0, guard: null };
      sharedStates.set(key, s);
    }
    return s;
  }
  function isAbortError(err) {
    if (!err) return false;
    return err.name === "AbortError" || err.name === "TimeoutError" || err.code === 20 || err.code === 23 || err.code === 2;
  }
  function storyErrorText(raw) {
    const e = str(raw).trim();
    if (!e) return "接口没应";
    if (e === "no books") return "书单是空的";
    if (e === "no book") return "没给书名";
    if (e === "no readable book") return "书都读不出来";
    if (e === "unknown book") return "书单里没有这本";
    return e;
  }
  function createStoryController(host) {
    const refs = host.refs;
    const shared = sharedStateOf(refs);
    function bumpGen() {
      shared.gen += 1;
      return shared.gen;
    }
    function stillMine(token) {
      return token === shared.gen && !!refs.busy.current;
    }
    function release(token) {
      if (token !== shared.gen) return;
      refs.busy.current = false;
      refs.narrating.current = false;
    }
    function clearGuard() {
      if (!shared.guard) return;
      clearT(shared.guard);
      shared.guard = null;
    }
    function armGuard(token, ms2) {
      clearGuard();
      const t = setTimeout(() => {
        shared.guard = null;
        if (token !== shared.gen) return;
        if (!refs.busy.current) return;
        bumpGen();
        refs.busy.current = false;
        refs.narrating.current = false;
        try {
          host.clearNarrate();
        } catch (e) {
        }
        host.bubble("这段没念完，先停在这儿啦～", 5e3);
      }, Math.max(5e3, Number(ms2) || 0));
      try {
        if (t && typeof t.unref === "function") t.unref();
      } catch (e) {
      }
      shared.guard = t;
    }
    function beginRound() {
      clearGuard();
      const token = bumpGen();
      refs.busy.current = true;
      refs.narrating.current = true;
      return token;
    }
    function armDeadline(token, message) {
      return setTimeout(() => {
        if (token !== shared.gen || !refs.busy.current) return;
        bumpGen();
        refs.busy.current = false;
        refs.narrating.current = false;
        host.bubble(message, 5e3);
      }, REQUEST_DEADLINE_MS);
    }
    function requestStory(path, post, texts, onData) {
      const token = beginRound();
      const deadline = armDeadline(token, texts.slow);
      const init = { headers: clientHeaders(host.clientId), signal: timeoutSignal(REQUEST_TIMEOUT_MS) };
      const p = post ? postJson(path, void 0, init) : getJson(path, init);
      p.then((d) => {
        clearTimeout(deadline);
        if (!stillMine(token)) return;
        onData(d, token);
      }).catch((err) => {
        clearTimeout(deadline);
        if (!stillMine(token)) return;
        release(token);
        host.bubble(isAbortError(err) ? texts.slow : texts.fail, 5e3);
      });
    }
    const titleOf = (d) => {
      const total = Number(d && d.total) || 1;
      const piece = Number(d && d.piece) || 1;
      const seg = total > 1 ? "（第 " + piece + "/" + total + " 段）" : "";
      return "正在讲《" + String(d && d.book || "") + "》" + (d && d.title ? "｜" + d.title : "") + seg;
    };
    function playPiece(d) {
      clearGuard();
      const token = bumpGen();
      const text = String(d && d.text || "");
      const speakMs = estimateSpeakMs(text);
      if (d && d.book) refs.book.current = String(d.book);
      host.bubble(titleOf(d), 12e3);
      host.talkFor(8e3);
      if (!text.trim()) {
        refs.busy.current = false;
        refs.narrating.current = false;
        host.bubble("这一段没取到正文，先停在这里～", 5e3);
        return;
      }
      if (host.isVoiceOff()) {
        refs.busy.current = false;
        refs.narrating.current = false;
        host.bubble(titleOf(d) + "（语音朗读关着）", 12e3);
        return;
      }
      refs.busy.current = true;
      refs.narrating.current = true;
      try {
        host.narrate(speakMs);
      } catch (e) {
      }
      try {
        host.speak(text, {
          // 故事语速由前端常量决定（-35%：主人反馈 -30% 仍略快）。
          // 这样调语速只改这一处、只刷新页面即可生效，不必重启宿主。
          rate: normalizeRate(storyRate(), host.narrationRate()),
          onDone: () => {
            if (token !== shared.gen) return;
            clearGuard();
            refs.busy.current = false;
            refs.narrating.current = false;
            try {
              host.clearNarrate();
            } catch (e) {
            }
            if (d && d.isLast === false) {
              if (refs.auto.current) {
                host.bubble("这一段讲完啦，接着往后讲…", 4e3);
                Promise.resolve().then(() => {
                  if (token !== shared.gen) return;
                  if (!refs.auto.current) return;
                  if (refs.busy.current) return;
                  next();
                });
              } else {
                host.bubble("这段讲完啦～点菜单「接着说」听下一段", 6e3);
              }
            } else {
              refs.auto.current = false;
              try {
                localStorage.setItem("chubby-story-auto", "0");
              } catch (e) {
              }
              host.bubble(host.persona.line("poemDone") + "（《" + String(d && d.book || refs.book.current || "这本") + "》讲完啦，连播已关；想接着听点「接着说」）", 8e3);
            }
          }
        });
        if (speakMs <= SPEAK_GUARD_MAX_MS) {
          armGuard(token, speakMs + Math.max(SPEAK_GUARD_EXTRA_MS, Math.round(speakMs * SPEAK_GUARD_RATIO)));
        }
      } catch (e) {
        refs.busy.current = false;
        refs.narrating.current = false;
        try {
          host.clearNarrate();
        } catch (e2) {
        }
        host.bubble("这段没念出来，先停在这里～", 5e3);
      }
    }
    function start(hint) {
      if (refs.busy.current) {
        host.bubble("正讲着呢，听完这段再说～", 3e3);
        return;
      }
      const query = hint ? "?book=" + encodeURIComponent(hint) + "&hint=" + encodeURIComponent(hint) : "";
      requestStory("/story/start" + query, false, {
        slow: "说书等太久啦（网络慢或书太大），再点一次试试～",
        fail: "说书连不上"
      }, (d, token) => {
        if (!d || !d.ok) {
          release(token);
          host.bubble("说书没开成：" + storyErrorText(d && d.error), 5e3);
          return;
        }
        playPiece(d);
      });
    }
    function next() {
      if (refs.busy.current) {
        host.bubble("正讲着呢，听完这段再说～", 3e3);
        return;
      }
      requestStory("/story/next", false, {
        slow: "说书等太久啦（网络慢或书太大），再点一次试试～",
        fail: "说书连不上"
      }, (d, token) => {
        if (!d || !d.ok) {
          release(token);
          host.bubble("说书卡住了：" + storyErrorText(d && d.error), 4e3);
          return;
        }
        if (d.done) {
          release(token);
          host.bubble("一轮都讲完啦，本鱼从头再讲～", 5e3);
          start("");
          return;
        }
        playPiece(d);
      });
    }
    function reset() {
      const book = refs.book.current;
      if (!book) {
        host.bubble("还没讲书呢", 3e3);
        return;
      }
      if (refs.busy.current) {
        host.bubble("正讲着呢，先「歇会儿」再从头讲～", 4e3);
        return;
      }
      const path = "/story/reset?book=" + encodeURIComponent(book);
      requestStory(path, true, {
        slow: "重置等太久啦，稍后再试～",
        fail: "说书连不上"
      }, (d, token) => {
        if (!d || !d.ok) {
          release(token);
          host.bubble("没重置成：" + storyErrorText(d && d.error), 4e3);
          return;
        }
        release(token);
        refs.book.current = String(d.book || book);
        host.bubble("这本书从头讲～", 3e3);
      });
    }
    return { playPiece, start, next, reset };
  }

  // src/client/poem-titles.ts
  var API_PATH = "/poem-titles";
  var CACHE_KEY = "chubby-poem-titles-v1";
  var CACHE_VERSION = 1;
  var FETCH_TIMEOUT_MS = 8e3;
  var cache = deepFreeze([]);
  var started = false;
  function normalize(list) {
    const out = [];
    if (!Array.isArray(list)) return out;
    for (const item2 of list) {
      const s = str(item2);
      if (s) out.push(s);
    }
    return out.sort((a, b) => b.length - a.length);
  }
  function apply(list, persist) {
    const titles = normalize(list);
    if (titles.length === 0) return;
    cache = deepFreeze(titles);
    if (persist) writeCache(titles);
  }
  function readCache() {
    try {
      if (typeof localStorage === "undefined" || !localStorage) return [];
      const raw = localStorage.getItem(CACHE_KEY);
      if (!raw) return [];
      const data = JSON.parse(raw);
      if (!data || data.v !== CACHE_VERSION || !Array.isArray(data.titles)) return [];
      return data.titles;
    } catch {
      return [];
    }
  }
  function writeCache(titles) {
    try {
      if (typeof localStorage === "undefined" || !localStorage) return;
      localStorage.setItem(CACHE_KEY, JSON.stringify({ v: CACHE_VERSION, titles }));
    } catch {
    }
  }
  function seedFromDisk() {
    try {
      const proc = typeof process !== "undefined" ? process : null;
      if (!proc || typeof proc.getBuiltinModule !== "function" || typeof proc.cwd !== "function") return [];
      const fs = proc.getBuiltinModule("node:fs");
      const nodePath = proc.getBuiltinModule("node:path");
      if (!fs || !nodePath) return [];
      let dir = proc.cwd();
      for (let i = 0; i < 4; i++) {
        const candidate = nodePath.join(dir, "data", "poem-titles.json");
        try {
          const raw = fs.readFileSync(candidate, "utf8");
          const data = JSON.parse(String(raw).replace(/^\uFEFF/, ""));
          return Array.isArray(data && data.titles) ? data.titles : [];
        } catch {
        }
        const parent = nodePath.dirname(dir);
        if (parent === dir) break;
        dir = parent;
      }
      return [];
    } catch {
      return [];
    }
  }
  function poemTitles() {
    return cache;
  }
  function ensurePoemTitles() {
    if (started || cache.length > 0) return;
    started = true;
    getJson(API_PATH, { signal: timeoutSignal(FETCH_TIMEOUT_MS) }).then((data) => {
      if (data && data.ok === true) apply(data.titles, true);
    }).catch(() => {
    });
  }
  {
    const cached = readCache();
    if (cached.length > 0) apply(cached, false);
    else {
      const seed = seedFromDisk();
      if (seed.length > 0) apply(seed, false);
    }
  }

  // src/client/intent.ts
  var BOOK_ALIAS = [
    [/聊斋/, "聊斋志异"],
    [/三国/, "三国演义"],
    [/西游/, "西游记"],
    [/水浒/, "水浒传"],
    [/红楼/, "红楼梦"],
    [/封神/, "封神演义"],
    [/隋唐/, "隋唐演义"],
    [/杨家将/, "杨家将演义"],
    [/世说/, "世说新语"],
    [/三言|二拍/, "三言二拍"],
    [/儒林/, "儒林外史"],
    [/官场/, "官场现形记"],
    [/老残/, "老残游记"],
    [/说岳|岳传/, "说岳全传"],
    [/东周/, "东周列国志"],
    [/三侠五义/, "三侠五义"],
    [/镜花缘/, "镜花缘"]
  ];
  deepFreeze(BOOK_ALIAS);
  var BARE_STRIP = /[\s。，！？、,.!?…~～]/g;
  function matchPoemTitle(text) {
    const t = String(text || "");
    if (!t) return "";
    for (const title of poemTitles()) {
      if (title.length >= 2 && t.indexOf(title) >= 0) return title;
    }
    return "";
  }
  function isQuestion(text) {
    return /[?？]|为什么|怎么|如何|什么|谁|哪[儿里]?|多少|几点|几号|是不是|能不能|要不要|吗\s*$|呢\s*$/.test(String(text || ""));
  }
  function detectIntent(rawText) {
    const t = String(rawText || "").trim();
    if (!t || t.length > 30) return null;
    if (isQuestion(t)) return null;
    if (poemTitles().length === 0) ensurePoemTitles();
    const byTitle = matchPoemTitle(t);
    if (byTitle) {
      const bare = t.replace(BARE_STRIP, "");
      const asks = bare === byTitle || /背|念|吟|朗读|朗诵|来(一)?首|听(一)?首|讲(一)?首|放(一)?首/.test(t);
      if (asks) return { kind: "poem", title: byTitle };
    }
    if (/背(一)?(首|下)?诗|念(一)?(首|下)?诗|来首诗|背诗|念诗|讲首诗/.test(t)) return { kind: "poem" };
    if (/典故|成语/.test(t)) {
      const asksCulture = /讲|说|来|听|教|学|点|考/.test(t);
      if (asksCulture) return { kind: "culture", sub: /成语/.test(t) ? "idiom" : "chengyu" };
    }
    let book = "";
    for (const [re, name] of BOOK_ALIAS) {
      if (re.test(t)) {
        book = name;
        break;
      }
    }
    if (book) {
      const bare = t.replace(BARE_STRIP, "");
      const asksBook = /讲|说书|听|来(一)?段|来(一)?回/.test(t) || bare.length <= book.length + 1;
      if (asksBook) return { kind: "story", book };
    }
    if (/讲故事|讲个故事|说书|来段|讲一段/.test(t)) return { kind: "story", book: "" };
    return null;
  }

  // src/client/chat-route.ts
  function createLocalRouter(host) {
    function takeOver() {
      if (!host.abortChat) return;
      try {
        host.abortChat();
      } catch (e) {
      }
    }
    function fetchPoem(query, onItem) {
      getJson("/poem" + query).then((d) => {
        const p = d && d.ok && d.item ? d.item : null;
        if (!p) {
          host.bubble("诗册没读到", 4e3);
          return;
        }
        onItem(p);
      }).catch(() => host.bubble("诗册没读到", 4e3));
    }
    function route(rawText) {
      const t0 = String(rawText || "").trim();
      if (/^(再来|再念|换)(一)?(首|个)/.test(t0)) {
        takeOver();
        host.bubble("（点播）好，再念一首", 3e3);
        fetchPoem("", (p) => recitePoem(host, p));
        return true;
      }
      if (/^(继续|接着说|接着讲|往下讲)$/.test(t0)) {
        takeOver();
        host.bubble("（点播）接着说", 3e3);
        try {
          host.storyState.auto.current = true;
          localStorage.setItem("chubby-story-auto", "on");
        } catch (e) {
        }
        host.story.start(host.storyState.book.current || "");
        return true;
      }
      if (/^(报|说|列)(一下|下)?(书名|书单)$/.test(t0)) {
        takeOver();
        host.bubble("（点播）本鲸数数书单…", 3e3);
        getJson("/story/books", { cache: "no-store" }).then((d) => {
          const books = d && d.ok && Array.isArray(d.books) ? d.books.map((b) => String(b || "").trim()).filter(Boolean) : [];
          if (!books.length) {
            host.bubble("书单没取到，稍后再试", 4e3);
            return;
          }
          host.bubble("书单有 " + books.length + " 本：" + books.join("、") + "（说个书名本鲸就开讲）", 12e3);
        }).catch(() => host.bubble("书单没取到，稍后再试", 4e3));
        return true;
      }
      const hit = detectIntent(rawText);
      if (!hit) return false;
      takeOver();
      if (hit.kind === "poem") {
        host.bubble("（点播）好，念一首", 3e3);
        fetchPoem(hit.title || "" ? "?title=" + encodeURIComponent(hit.title || "") : "", (p) => recitePoem(host, p));
        return true;
      }
      if (hit.kind === "culture") {
        const type = hit.sub;
        if (!beginOnce("route:" + type)) {
          host.bubble("正在讲呢，稍等～", 2e3);
          return true;
        }
        host.bubble(type === "chengyu" ? "（点播）讲个成语" : "（点播）讲个典故", 3e3);
        getJson("/culture?type=" + type).then((d) => {
          const it = d && d.ok && d.item ? d.item : null;
          if (!it) {
            host.bubble("这个没读到", 4e3);
            return;
          }
          const body = collapseText(String(it.text || ""));
          host.bubble((type === "chengyu" ? "成语·" : "典故·") + String(it.title || ""), 15e3);
          host.speak((type === "chengyu" ? "讲个成语——" : "讲个典故——") + String(it.title || "") + (it.src ? "，出自" + String(it.src) : "") + "。" + body, { rate: host.narrationRate() });
        }).catch(() => host.bubble("这个没读到", 4e3));
        return true;
      }
      const book = hit.book || "";
      host.bubble("（点播）" + (book ? "讲《" + book + "》" : "讲一段书"), 4e3);
      host.storyState.auto.current = true;
      host.story.start(book);
      return true;
    }
    return { route };
  }

  // src/shared/sse.ts
  function parseSseBuffer(buffer) {
    const events = [];
    let invalid = 0;
    let rest = String(buffer || "");
    rest = rest.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
    let idx = rest.indexOf("\n");
    while (idx >= 0) {
      const line = rest.slice(0, idx).trim();
      rest = rest.slice(idx + 1);
      idx = rest.indexOf("\n");
      if (!line.startsWith("data:")) continue;
      const payload = line.slice(5).trim();
      if (!payload || payload === "[DONE]") continue;
      try {
        events.push(JSON.parse(payload));
      } catch (e) {
        invalid++;
      }
    }
    return { events, rest, invalid };
  }

  // src/client/chat.ts
  function resolveChatLang() {
    try {
      const v = localStorage.getItem("chubby-chatlang");
      return v === "zh" || v === "en" ? v : "auto";
    } catch (e) {
      return "auto";
    }
  }
  function fishTip(host, tip, ms2 = 6e3) {
    try {
      host.setMessages((m) => [...m, { who: "fish", text: tip }]);
    } catch (e) {
    }
    try {
      host.bubble(tip, ms2);
    } catch (e) {
    }
  }
  function diag() {
    try {
      const w = typeof window !== "undefined" ? window : null;
      if (!w) return null;
      return w.__chubbyWhale || (w.__chubbyWhale = {});
    } catch (e) {
      return null;
    }
  }
  var CHAT_TIMEOUT_MS = 3e4;
  var STREAM_HEADER_TIMEOUT_MS = 4e3;
  var STREAM_RETRYABLE_STATUS = [404, 405, 408, 425, 429, 501, 502, 503, 504];
  function streamHttpRetryable(status) {
    if (!status) return true;
    return STREAM_RETRYABLE_STATUS.indexOf(status) >= 0;
  }
  function newAbortController() {
    try {
      return typeof AbortController !== "undefined" ? new AbortController() : null;
    } catch (e) {
      return null;
    }
  }
  function createChatSender(host) {
    let activeStream = null;
    let activeChat = null;
    function clearActive(ctl) {
      if (activeStream && activeStream.ctl === ctl) activeStream = null;
    }
    function abortStream() {
      const s = activeStream;
      const c = activeChat;
      if (!s && !c) return false;
      activeStream = null;
      activeChat = null;
      try {
        host.epoch.next();
      } catch (e) {
      }
      try {
        if (s && s.ctl) s.ctl.abort();
      } catch (e) {
      }
      try {
        if (c && c.ctl) c.ctl.abort();
      } catch (e) {
      }
      try {
        host.busy.end();
        host.setBusy(false);
      } catch (e) {
      }
      const d = diag();
      if (s) {
        if (d) d.streamAborted = (d.streamAborted || 0) + 1;
      }
      if (c) {
        if (d) d.chatAborted = (d.chatAborted || 0) + 1;
      }
      return true;
    }
    async function tryStream(text, opts, myEpoch) {
      try {
        if (localStorage.getItem("chubby-stream") === "off") return false;
      } catch (e) {
      }
      const isCurrent = () => host.epoch.isCurrent(myEpoch);
      let spokeAny = false;
      let full = "";
      const ctl = newAbortController();
      activeStream = { ctl };
      let gotHeaders = false;
      const firstTimer = setTimeout(() => {
        try {
          if (!gotHeaders && ctl) ctl.abort();
        } catch (e) {
        }
      }, STREAM_HEADER_TIMEOUT_MS);
      let bubbleAt = 0;
      const sb = createSentenceBuffer(40);
      const speakSegs = (segs) => {
        for (const seg of segs) {
          try {
            host.speak(seg, { rate: chatRate() });
          } catch (e) {
          }
        }
        if (segs.length) spokeAny = true;
      };
      const dropStale = () => {
        clearActive(ctl);
        try {
          if (ctl) ctl.abort();
        } catch (e) {
        }
        const d = diag();
        if (d) d.streamStale = (d.streamStale || 0) + 1;
        return true;
      };
      try {
        const res = await postRaw("/chat-stream", { message: text, lang: resolveChatLang(), voice: !!(opts && opts.voice) }, { signal: ctl ? ctl.signal : void 0 });
        gotHeaders = true;
        clearTimeout(firstTimer);
        if (!isCurrent()) return dropStale();
        if (!res.ok || !res.body) {
          clearActive(ctl);
          const status = Number(res && res.status) || 0;
          if (streamHttpRetryable(status)) return false;
          let tip = "";
          try {
            const j = await res.json();
            tip = String(j && j.reply || "");
          } catch (e) {
          }
          if (!tip) tip = "主人，本鲸这边没接上（HTTP " + status + "），等会儿再试一次？";
          if (isCurrent()) {
            try {
              host.setMessages((m) => [...m, { who: "fish", text: tip }]);
            } catch (e) {
            }
            try {
              host.bubble(tip, 6e3);
            } catch (e) {
            }
            try {
              host.speakReply(tip);
            } catch (e) {
            }
          }
          const d = diag();
          if (d) d.streamHttpFail = status;
          return true;
        }
        const reader = res.body.getReader();
        const dec = new TextDecoder();
        let buf = "";
        host.busy.begin();
        host.setBusy(true);
        for (; ; ) {
          const { value, done } = await reader.read();
          if (!isCurrent()) return dropStale();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          const parsed = parseSseBuffer(buf);
          buf = parsed.rest;
          for (const obj of parsed.events) {
            if (!isCurrent()) return dropStale();
            if (obj.error) {
              throw new Error(String(obj.error));
            }
            if (typeof obj.delta === "string" && obj.delta) {
              full += obj.delta;
              speakSegs(sb.push(obj.delta));
              const nowT = Date.now();
              if (nowT - bubbleAt > 400) {
                bubbleAt = nowT;
                host.bubble(full.slice(-60), 3e3);
              }
            }
            if (obj.done) {
              if (!isCurrent()) return dropStale();
              const reply = String(obj.reply || full || "").trim();
              full = reply || full;
              clearActive(ctl);
              speakSegs(sb.flush());
              host.busy.end();
              host.setBusy(false);
              if (reply) {
                const fresh = host.replyDeduper.allow(reply);
                try {
                  host.setMessages((m) => [...m, { who: "fish", text: reply }]);
                } catch (e) {
                }
                if (fresh) {
                  try {
                    host.bubble(reply, 6e3);
                  } catch (e) {
                  }
                }
                try {
                  host.talkFor(1500);
                } catch (e) {
                }
                try {
                  host.scrollBody();
                } catch (e) {
                }
                const d = diag();
                if (d) d.lastChat = { stage: "stream-done", firstDeltaMs: obj.firstDeltaMs || 0, ms: obj.ms || 0, cached: !!obj.cached, reply: reply.slice(0, 40) };
              } else {
                fishTip(host, host.persona.line("error"));
                const d = diag();
                if (d) d.lastChat = { stage: "stream-empty", at: Date.now() };
              }
              return true;
            }
          }
        }
        clearTimeout(firstTimer);
        if (!isCurrent()) return dropStale();
        clearActive(ctl);
        speakSegs(sb.flush());
        host.busy.end();
        host.setBusy(false);
        const tail = full.trim();
        if (tail) {
          try {
            host.setMessages((m) => [...m, { who: "fish", text: tail }]);
          } catch (e) {
          }
          try {
            host.bubble(tail, 6e3);
          } catch (e) {
          }
          try {
            host.scrollBody();
          } catch (e) {
          }
        } else {
          fishTip(host, host.persona.line("error"));
        }
        return true;
      } catch (e) {
        clearTimeout(firstTimer);
        if (!isCurrent()) return dropStale();
        clearActive(ctl);
        host.busy.end();
        host.setBusy(false);
        const d = diag();
        if (d) d.streamFallback = String(e && e.message || e);
        if (spokeAny) {
          speakSegs(sb.flush());
          const partial = full.trim();
          if (partial) {
            try {
              host.setMessages((m) => [...m, { who: "fish", text: partial }]);
            } catch (e2) {
            }
          }
          try {
            host.bubble(partial ? "网络断了一下，本鲸先念到这儿～" : "网络断了一下，本鲸没说完～", 5e3);
          } catch (e2) {
          }
          return true;
        }
        return false;
      }
    }
    async function send(rawText, opts) {
      const text = String(rawText || "").trim();
      if (!text) return;
      abortStream();
      const d0 = diag();
      if (d0) d0.lastChat = { stage: "entry", busy: host.busy.isBusy(), tts: !!host.ttsPlaying(), at: Date.now() };
      if (host.busy.isBusy() && host.busy.age() < 35e3) {
        if (d0) d0.lastChat.stage = "blocked-busy";
        host.bubble("本鲸还在想上一句呢，稍等～", 2500);
        return;
      }
      if (host.narrating.current || host.ttsPlaying()) {
        try {
          host.stopSpeak();
        } catch (e) {
        }
        host.narrating.current = false;
        try {
          host.storyBusy.current = false;
        } catch (e) {
        }
      }
      let localHit = false;
      try {
        localHit = host.route(text);
      } catch (e) {
        localHit = false;
      }
      if (localHit) {
        host.setInput("");
        return;
      }
      const myEpoch = host.epoch.next();
      host.setInput("");
      try {
        host.setMessages((m) => [...m, { who: "me", text }]);
      } catch (e) {
      }
      try {
        if (await tryStream(text, opts, myEpoch)) return;
      } catch (e) {
      }
      try {
        const hit = host.persona.reactTo(text);
        if (hit) {
          host.say(hit.text, 4e3);
          if (hit.event === "praise") host.heart();
        }
      } catch (e) {
      }
      try {
        if (opts && opts.voice && !host.ttsPlaying() && Math.random() < 0.25) host.say(host.persona.line("waiting"), 3e3);
      } catch (e) {
      }
      host.busy.begin();
      host.setBusy(true);
      host.talkFor(1200);
      host.scrollBody();
      const d1 = diag();
      let data = null;
      const ctl = newAbortController();
      activeChat = { ctl };
      let timeoutTimer = null;
      try {
        if (ctl) {
          timeoutTimer = setTimeout(() => {
            try {
              ctl.abort();
            } catch (e) {
            }
          }, CHAT_TIMEOUT_MS);
        }
        const tChat = performance.now();
        data = await postJson("/chat", {
          message: text,
          // voice 表示「输入来自语音识别」（后端据此追加 ASR 纠错说明）。
          // 原来这里写死 true，打字也会被当成语音，且与流式的缓存键对不上。
          voice: !!(opts && opts.voice),
          lang: resolveChatLang()
        }, {
          signal: ctl ? ctl.signal : timeoutSignal(CHAT_TIMEOUT_MS)
        });
        try {
          host.recordChatLatency(Math.round(performance.now() - tChat));
        } catch (e) {
        }
        if (!host.epoch.isCurrent(myEpoch)) return;
        const reply = data && data.reply ? String(data.reply) : data && data.ok === false ? "主人，本鲸这边没接上（" + String(data.error || "接口没应") + "），等会儿再问一次？" : "主人……本鲸走神了。";
        if (d1) d1.lastChat = { stage: "fetched", reply: String(reply).slice(0, 40), at: Date.now() };
        host.setMessages((m) => [...m, { who: "fish", text: reply }]);
        if (host.voiceMode.current) {
          host.bubble("（说）" + reply, 8e3);
        }
        if (data && data.upgraded) host.bubble("本鲸又长大一点啦！", 4e3);
      } catch (err) {
        if (!host.epoch.isCurrent(myEpoch)) return;
        const timedOut = !!err && (err.name === "AbortError" || err.code === 20 || err.code === 2);
        const tip = timedOut ? "主人，本鲸等太久啦（网络慢），再问一次？" : host.persona.line("error");
        if (d1) d1.lastChat = { stage: timedOut ? "timeout" : "error", error: String(err && err.message || err).slice(0, 60), at: Date.now() };
        fishTip(host, tip, 5e3);
      } finally {
        clearT(timeoutTimer);
        if (activeChat && activeChat.ctl === ctl) activeChat = null;
        if (host.epoch.isCurrent(myEpoch)) {
          host.busy.end();
          host.setBusy(false);
          host.talkFor(1500);
          try {
            if (data && data.reply) {
              const rp = String(data.reply);
              const d2 = diag();
              if (d2) d2.lastChat = { stage: "speak", reply: rp.slice(0, 40), at: Date.now() };
              host.speakReply(rp);
            }
          } catch (e) {
          }
          host.scrollBody();
        }
      }
    }
    return { send, abortStream };
  }

  // src/client/reminders.ts
  var DUE_PATH = "/reminders?action=due";
  function ms(v, def) {
    const n = Math.round(Number(v));
    return isFinite(n) && n > 0 ? n : def;
  }
  function createReminderPoller(host, opts) {
    const o = opts || {};
    const intervalMs = ms(o.intervalMs, 2e4);
    const retryMs = ms(o.retryMs, 2e3);
    const gapMs = ms(o.gapMs, 3e3);
    const bubbleMs = ms(o.bubbleMs, 8e3);
    const fetchJson = typeof host.getJson === "function" ? host.getJson : getJson;
    const queue = [];
    let dueTimer = null;
    let pollTimer = null;
    function pump() {
      if (dueTimer) return;
      if (queue.length === 0) return;
      if (host.isSpeaking() || host.isNarrating() || host.isBusy()) {
        dueTimer = setTimeout(() => {
          dueTimer = null;
          pump();
        }, retryMs);
        return;
      }
      const item2 = queue.shift();
      const body = String(item2 && item2.text || "").trim() || "时间到了";
      const line = "主人，提醒你：" + body;
      host.bubble(line, bubbleMs);
      host.talkFor(3e3);
      try {
        host.speak(line);
      } catch (e) {
      }
      dueTimer = setTimeout(() => {
        dueTimer = null;
        pump();
      }, gapMs);
    }
    function stopPoll() {
      if (pollTimer !== null) {
        clearI(pollTimer);
        pollTimer = null;
      }
    }
    function start() {
      stopPoll();
      pollTimer = setInterval(() => {
        fetchJson(DUE_PATH).then((d) => {
          const due = d && d.due || [];
          for (const it of due) {
            if (it && it.text) queue.push(it);
          }
          pump();
        }).catch(() => {
        });
      }, intervalMs);
      return stopPoll;
    }
    function dispose() {
      if (dueTimer !== null) {
        clearT(dueTimer);
        dueTimer = null;
      }
      queue.length = 0;
      stopPoll();
    }
    return { pump, start, dispose };
  }

  // src/client/reminder-manage.ts
  var MANAGE_WINDOW_MS = 6e4;
  var POSTPONE_MS = 10 * 60 * 1e3;
  var MANAGE_HINT = "回复数字可删除 / 回 d 顺延 10 分钟";
  function normalizeManageInput(text) {
    return str(text).replace(/[\s。，、！？；：,.!?;:…~～·"'“”‘’（）()【】\[\]]/g, "").toLowerCase();
  }
  function parseManageInput(text) {
    const t = normalizeManageInput(text);
    if (!t) return null;
    if (/^\d{1,3}$/.test(t)) return { kind: "delete", index: Number(t) };
    if (t === "d") return { kind: "postpone" };
    return null;
  }
  function formatClock(at) {
    const d = new Date(at);
    if (isNaN(d.getTime())) return "--:--";
    const hh = String(d.getHours()).padStart(2, "0");
    const mm = String(d.getMinutes()).padStart(2, "0");
    return hh + ":" + mm;
  }
  function stampOf(item2) {
    const raw = item2.nextAt || item2.at;
    const d = new Date(raw);
    if (isNaN(d.getTime())) return str(raw);
    try {
      return d.toLocaleString("zh-CN");
    } catch (e) {
      return formatClock(d);
    }
  }
  function boardText(items, prefix) {
    const lines = items.map((it, i) => {
      const rep = Number(it.repeat) > 0 ? "（重复）" : "";
      return i + 1 + ". " + it.text + "（" + stampOf(it) + "）" + rep;
    });
    const head = prefix ? prefix + "\n" : "";
    if (!lines.length) return head + "没有提醒了";
    return head + lines.join("\n") + "\n" + MANAGE_HINT;
  }
  function normalizeReminderList(payload) {
    const arr = Array.isArray(payload && payload.reminders) ? payload.reminders : Array.isArray(payload) ? payload : [];
    const out = [];
    for (const x of arr) {
      if (!x || typeof x !== "object") continue;
      if (x.done === true) continue;
      const id = str(x.id);
      if (!id) continue;
      out.push({
        id,
        text: str(x.text),
        at: x.at,
        nextAt: x.nextAt,
        repeat: x.repeat
      });
    }
    return out;
  }
  function pickNextDue(items) {
    if (!items || !items.length) return null;
    let pick = items[0];
    let pickMs = Infinity;
    for (const it of items) {
      const ms2 = new Date(it.nextAt || it.at).getTime();
      if (Number.isFinite(ms2) && ms2 < pickMs) {
        pickMs = ms2;
        pick = it;
      }
    }
    return pick;
  }
  function createReminderManager(host) {
    const clock = typeof host.now === "function" ? host.now : () => Date.now();
    const fetchJson = typeof host.getJson === "function" ? host.getJson : getJson;
    const sendJson = typeof host.postJson === "function" ? host.postJson : postJson;
    const removeJson = typeof host.delJson === "function" ? host.delJson : delJson;
    let openedAt = 0;
    let board = [];
    let seq = 0;
    function isOpen(now = clock()) {
      if (!(openedAt > 0) || !board.length) return false;
      const age = now - openedAt;
      return age >= 0 && age <= MANAGE_WINDOW_MS;
    }
    function expire() {
      openedAt = 0;
      board = [];
    }
    function safeRequest(fn) {
      try {
        return Promise.resolve(fn());
      } catch (e) {
        return Promise.reject(e);
      }
    }
    function showBoard(prefix, failText) {
      const my = ++seq;
      safeRequest(() => fetchJson("/reminders")).then((d) => {
        if (my !== seq) return;
        const arr = normalizeReminderList(d);
        board = arr;
        if (!arr.length) {
          openedAt = 0;
          host.bubble(prefix, 5e3);
          return;
        }
        host.bubble(boardText(arr, prefix), 12e3);
      }).catch(() => {
        if (my !== seq) return;
        openedAt = 0;
        board = [];
        host.bubble(failText, 5e3);
      });
    }
    function open() {
      const my = ++seq;
      openedAt = 0;
      return safeRequest(() => fetchJson("/reminders")).then((d) => {
        if (my !== seq) return;
        const arr = normalizeReminderList(d);
        board = arr;
        if (!arr.length) {
          openedAt = 0;
          host.bubble("还没有提醒～", 3e3);
          return;
        }
        openedAt = clock();
        host.bubble(boardText(arr, "提醒清单（" + arr.length + " 条）："), 12e3);
      }).catch(() => {
        if (my !== seq) return;
        openedAt = 0;
        board = [];
        host.bubble("提醒清单查不到", 5e3);
      });
    }
    function afterDelete() {
      showBoard("删掉了", "删掉了，清单没刷新过来");
    }
    function removeAt(index) {
      const it = board[index - 1];
      if (!it) {
        host.bubble("没有第 " + index + " 条，回数字再选一次", 4e3);
        return;
      }
      const next = board.slice();
      next.splice(index - 1, 1);
      board = next;
      safeRequest(() => removeJson("/reminders?id=" + encodeURIComponent(it.id))).then((d) => {
        if (!(d && d.ok)) {
          showBoard("没删掉，最新清单：", "没删掉，清单也没刷出来");
          return;
        }
        afterDelete();
      }).catch(() => showBoard("没删掉，最新清单：", "没删掉，清单也没刷出来"));
    }
    function postpone() {
      const pick = pickNextDue(board);
      if (!pick) {
        host.bubble("清单里没有能顺延的提醒", 4e3);
        return;
      }
      const dueMs = new Date(pick.nextAt || pick.at).getTime();
      const base = Number.isFinite(dueMs) ? Math.max(clock(), dueMs) : clock();
      const at = new Date(base + POSTPONE_MS);
      const when = formatClock(at);
      const body = {
        text: pick.text,
        at: at.toISOString(),
        repeat: Number(pick.repeat) || 0
      };
      safeRequest(() => sendJson("/reminders", body)).then((d) => {
        if (!(d && d.ok)) {
          host.bubble("顺延没成，原提醒还在", 4e3);
          return;
        }
        safeRequest(() => removeJson("/reminders?id=" + encodeURIComponent(pick.id))).then((d2) => {
          if (!(d2 && d2.ok)) {
            showBoard("顺延到 " + when + "，但旧提醒没删掉：", "顺延到 " + when + "，但旧提醒没删掉");
            return;
          }
          showBoard("顺延到 " + when, "顺延到 " + when);
        }).catch(() => showBoard("顺延到 " + when + "，但旧提醒没删掉：", "顺延到 " + when + "，但旧提醒没删掉"));
      }).catch(() => host.bubble("顺延没成，原提醒还在", 4e3));
    }
    function intercept(text) {
      if (!isOpen()) {
        if (openedAt > 0) expire();
        return false;
      }
      const cmd = parseManageInput(text);
      if (!cmd) return false;
      if (cmd.kind === "delete") removeAt(cmd.index);
      else postpone();
      return true;
    }
    return {
      open,
      intercept,
      isOpen: () => isOpen(),
      items: () => board.slice(),
      windowMs: MANAGE_WINDOW_MS
    };
  }

  // src/client/recover.ts
  var RECOVER_HOTKEY_LABEL = "Ctrl+Shift+W";
  function shouldShowRecoverDot(hidden) {
    return !!hidden;
  }
  function isRecoverHotkey(e) {
    if (!e) return false;
    const ctrl = !!(e.ctrlKey || e.metaKey);
    const shift = !!e.shiftKey;
    if (!ctrl || !shift) return false;
    const key = str(e.key).toLowerCase();
    if (key === "w") return true;
    const code = Number(e.keyCode != null ? e.keyCode : e.which);
    return code === 87;
  }
  function createRecover(host) {
    function trigger() {
      try {
        host.recover();
      } catch (e) {
      }
    }
    function dot(hidden) {
      if (!shouldShowRecoverDot(hidden)) return null;
      return {
        "data-chubby-recover": "1",
        title: "点一下叫本鲸回来（或按 " + RECOVER_HOTKEY_LABEL + "）",
        onClick: (e) => {
          evStop(e);
          evPrevent(e);
          trigger();
        }
      };
    }
    function bindHotkey(target) {
      let el = target;
      if (!el) {
        try {
          el = typeof window !== "undefined" ? window : null;
        } catch (e) {
          el = null;
        }
      }
      if (!el || typeof el.addEventListener !== "function") return () => {
      };
      const onKeyDown = (e) => {
        if (!isRecoverHotkey(e)) return;
        evPrevent(e);
        evStop(e);
        trigger();
      };
      try {
        el.addEventListener("keydown", onKeyDown, true);
      } catch (e) {
        return () => {
        };
      }
      return () => {
        try {
          el.removeEventListener("keydown", onKeyDown, true);
        } catch (e) {
        }
      };
    }
    return { dot, bindHotkey, trigger };
  }

  // src/client/hooks.ts
  function readLocalFlag(key, fallback = true) {
    try {
      const raw = localStorage.getItem(key);
      return raw === null ? fallback : raw !== "off";
    } catch (e) {
      return fallback;
    }
  }
  function createHooks(R) {
    function useLazyRef(factory) {
      const ref = R.useRef(null);
      if (!ref.current) ref.current = factory();
      return ref;
    }
    function usePersistentBool(key, fallback = true) {
      const ref = R.useRef(null);
      const [value, setValue] = R.useState(() => readLocalFlag(key, fallback));
      if (ref.current === null) ref.current = value;
      const set = (v) => {
        const next = !!v;
        ref.current = next;
        setValue(next);
        try {
          localStorage.setItem(key, next ? "on" : "off");
        } catch (e) {
        }
      };
      return { value, set, ref };
    }
    return { useLazyRef, usePersistentBool };
  }

  // src/client/effects.ts
  function bindFileDropCapture(opts) {
    const win = opts.win;
    if (!win || !win.addEventListener) return () => {
    };
    const onDragOverCapture = (e) => {
      if (!opts.hitTest(e.clientX, e.clientY)) return;
      e.preventDefault();
      e.stopPropagation();
    };
    const onDropCapture = (e) => {
      if (!opts.hitTest(e.clientX, e.clientY)) return;
      e.preventDefault();
      e.stopPropagation();
      const dt = e.dataTransfer;
      const file = dt && dt.files && dt.files[0];
      try {
        opts.onFile(file);
      } catch (e2) {
      }
    };
    win.addEventListener("dragover", onDragOverCapture, true);
    win.addEventListener("drop", onDropCapture, true);
    return () => {
      try {
        win.removeEventListener("dragover", onDragOverCapture, true);
      } catch (e) {
      }
      try {
        win.removeEventListener("drop", onDropCapture, true);
      } catch (e) {
      }
    };
  }
  function bindOutsideClose(opts) {
    const doc = opts.doc;
    if (!doc || !doc.addEventListener) return () => {
    };
    const onDocDown = (e) => {
      try {
        const t = e && e.target;
        if (t && t.closest && t.closest("[data-menu-root]")) return;
        opts.onOutside();
      } catch (e2) {
      }
    };
    doc.addEventListener("pointerdown", onDocDown, true);
    doc.addEventListener("mousedown", onDocDown, true);
    doc.addEventListener("touchstart", onDocDown, true);
    return () => {
      try {
        doc.removeEventListener("pointerdown", onDocDown, true);
      } catch (e) {
      }
      try {
        doc.removeEventListener("mousedown", onDocDown, true);
      } catch (e) {
      }
      try {
        doc.removeEventListener("touchstart", onDocDown, true);
      } catch (e) {
      }
    };
  }
  function bindResize(win, onResize) {
    if (!win || !win.addEventListener) return () => {
    };
    win.addEventListener("resize", onResize);
    return () => {
      try {
        win.removeEventListener("resize", onResize);
      } catch (e) {
      }
    };
  }
  function startGreeting(opts) {
    const tGreet = setTimeout(opts.greet, opts.greetMs ?? 3e3);
    const tHungry = opts.hungryNow ? setTimeout(opts.hungry, opts.hungryMs ?? 6e3) : null;
    return () => {
      clearT(tGreet);
      clearT(tHungry);
    };
  }
  function bindChatFocus(opts) {
    if (!opts.open) {
      try {
        const el2 = opts.input();
        if (el2 && typeof el2.blur === "function") el2.blur();
      } catch (e) {
      }
      return () => {
      };
    }
    const el = opts.input();
    if (!el || typeof el.focus !== "function") return () => {
    };
    let done = false;
    let timer = null;
    let panelEl = null;
    const fire = () => {
      if (done) return;
      done = true;
      clearT(timer);
      timer = null;
      try {
        if (panelEl && typeof panelEl.removeEventListener === "function") panelEl.removeEventListener("animationend", fire);
      } catch (e) {
      }
      try {
        el.focus();
      } catch (e) {
      }
    };
    const reduced = (() => {
      try {
        const win = opts.win;
        if (!win || typeof win.matchMedia !== "function") return false;
        const m = win.matchMedia("(prefers-reduced-motion: reduce)");
        return !!(m && m.matches);
      } catch (e) {
        return false;
      }
    })();
    if (reduced) {
      fire();
      return () => {
        done = true;
      };
    }
    try {
      panelEl = opts.panel ? opts.panel() : null;
      const anims = panelEl && typeof panelEl.getAnimations === "function" ? panelEl.getAnimations() : null;
      if (anims && anims.length && typeof panelEl.addEventListener === "function") {
        panelEl.addEventListener("animationend", fire);
        timer = setTimeout(fire, opts.maxWaitMs ?? 400);
        return () => {
          done = true;
          clearT(timer);
          timer = null;
          try {
            panelEl.removeEventListener("animationend", fire);
          } catch (e) {
          }
        };
      }
    } catch (e) {
    }
    fire();
    return () => {
      done = true;
    };
  }
  function bindMenuKeys(opts) {
    const win = opts.win;
    if (!win || !win.addEventListener) return () => {
    };
    const onKeyDown = (e) => {
      try {
        if (!e) return;
        if (e.ctrlKey || e.altKey || e.metaKey) return;
        if (typeof opts.isTyping === "function" && opts.isTyping(e.target)) return;
        const n = opts.count();
        if (n <= 0) return;
        const key = String(e.key || "");
        const raw = opts.index();
        const cur = raw >= 0 && raw < n ? raw : -1;
        if (key === "ArrowDown" || key === "ArrowUp") {
          const step = key === "ArrowDown" ? 1 : -1;
          const next = cur < 0 ? step > 0 ? 0 : n - 1 : (cur + step + n) % n;
          evPrevent(e);
          evStop(e);
          opts.setIndex(next);
          return;
        }
        if (key === "Enter") {
          if (e.repeat || cur < 0) return;
          if (!opts.activate(cur)) return;
          evPrevent(e);
          evStop(e);
          return;
        }
        if (key === "Escape" || key === "Esc") {
          if (e.repeat) return;
          evPrevent(e);
          evStop(e);
          opts.close();
        }
      } catch (e2) {
      }
    };
    try {
      win.addEventListener("keydown", onKeyDown, true);
    } catch (e) {
      return () => {
      };
    }
    return () => {
      try {
        win.removeEventListener("keydown", onKeyDown, true);
      } catch (e) {
      }
    };
  }
  function startWatchdog(tick, intervalMs = 2e3) {
    const t = setInterval(tick, intervalMs);
    return () => {
      clearI(t);
    };
  }
  function createUnmountCleanup(opts) {
    return () => {
      try {
        const p = opts.reminderPoller();
        if (p) p.dispose();
      } catch (e) {
      }
      try {
        opts.stopTts();
      } catch (e) {
      }
      try {
        opts.stopMelody();
      } catch (e) {
      }
      try {
        const el = opts.bubbleEl();
        if (el && el._t) {
          clearTimeout(el._t);
          el._t = null;
        }
      } catch (e) {
      }
    };
  }

  // src/client/render.ts
  function listMenuEntries(items, ctx, parentPath = "") {
    const out = [];
    collectMenuEntries(items, ctx, parentPath, out);
    for (let i = 0; i < out.length; i++) out[i].index = i;
    return out;
  }
  function collectMenuEntries(items, ctx, parentPath, out) {
    if (!Array.isArray(items)) return;
    for (const it of items) {
      if (!it || typeof it !== "object") continue;
      if (it.type === "sub") {
        if (typeof it.label !== "string") continue;
        const path = parentPath ? parentPath + SUB_PATH_SEP + it.label : it.label;
        const open = ctx.subOpen === path || ctx.subOpen.indexOf(path + SUB_PATH_SEP) === 0;
        out.push({ kind: "sub", action: "", path, parentPath, label: ctx.tr(it.label, ctx.lang), open, index: 0 });
        if (open) collectMenuEntries(it.items, ctx, path, out);
        continue;
      }
      if (it.type !== "item" || typeof it.label !== "string") continue;
      out.push({ kind: "item", action: String(it.action || ""), path: "", parentPath, label: ctx.tr(it.label, ctx.lang), open: false, index: 0 });
    }
  }
  function menuRootProps(ctx) {
    return {
      style: menuStyle(ctx.menu),
      "data-menu-root": "1",
      role: "menu",
      tabIndex: -1,
      "aria-label": ctx.lang === "en" ? "Fat Whale menu" : "肥鲸菜单"
    };
  }
  var SUB_PATH_SEP = "\0";
  function renderMenuItems(items, ctx, parentPath = "") {
    const entries = listMenuEntries(items, ctx, parentPath);
    return renderMenuList(items, ctx, parentPath, entries, { i: 0 });
  }
  function renderMenuList(items, ctx, parentPath, entries, cursor) {
    const out = [];
    if (!Array.isArray(items)) return out;
    const focus = typeof ctx.focusIndex === "number" ? ctx.focusIndex : -1;
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      if (!it || typeof it !== "object") continue;
      if (it.type === "sep") {
        out.push(ctx.h("div", { key: "sep" + i, role: "separator", style: { height: 1, background: "#1f4a85", margin: "4px 0" } }));
        continue;
      }
      if (it.type === "sub") {
        if (typeof it.label !== "string") continue;
        const entry2 = entries[cursor.i++];
        const path = entry2 ? entry2.path : parentPath ? parentPath + SUB_PATH_SEP + it.label : it.label;
        const open = entry2 ? entry2.open : false;
        const label = entry2 ? entry2.label : ctx.tr(it.label, ctx.lang);
        out.push(ctx.h("div", {
          key: "sub" + i,
          role: "menuitem",
          "aria-haspopup": "menu",
          "aria-expanded": open,
          "aria-label": label,
          tabIndex: -1,
          style: menuSubStyle(!!entry2 && entry2.index === focus),
          onClick: () => ctx.onToggleSub(open ? entry2 ? entry2.parentPath : parentPath : path)
        }, ctx.h("span", null, label), ctx.h("span", null, open ? "▾" : "▸")));
        if (open) out.push(ctx.h("div", { key: "subitems" + i, role: "group", style: { paddingLeft: 14, borderLeft: "1px solid #1f4a85", marginLeft: 8 } }, renderMenuList(it.items, ctx, path, entries, cursor)));
        continue;
      }
      if (it.type !== "item" || typeof it.label !== "string") continue;
      const entry = entries[cursor.i++];
      out.push(ctx.h("div", {
        key: "item" + i,
        role: "menuitem",
        "aria-label": entry ? entry.label : ctx.tr(it.label, ctx.lang),
        tabIndex: -1,
        style: menuItemStyle(!!entry && entry.index === focus),
        onClick: () => ctx.onAction(entry ? entry.action : String(it.action || ""))
      }, entry ? entry.label : ctx.tr(it.label, ctx.lang)));
    }
    return out;
  }
  function readMenuRuntime() {
    let storyAuto = true;
    let streamOn = true;
    let ttsVoice = "zh-CN-XiaoyiNeural";
    let chatLang = "auto";
    try {
      storyAuto = localStorage.getItem("chubby-story-auto") !== "0";
      streamOn = localStorage.getItem("chubby-stream") !== "off";
      ttsVoice = localStorage.getItem("chubby-tts-voice") || "zh-CN-XiaoyiNeural";
      chatLang = localStorage.getItem("chubby-chatlang") || "auto";
    } catch (e) {
    }
    return {
      storyAuto,
      streamOn,
      storyRate: storyRate(),
      poemRate: poemRate(),
      ttsVoice,
      chatLang
    };
  }
  function renderMenuHeader(ctx) {
    const { h, lang } = ctx;
    return h(
      "div",
      { style: { padding: "8px 14px", borderBottom: "1px solid #1f4a85", color: "#9FD8FF", fontSize: 12, display: "flex", justifyContent: "space-between" } },
      h("span", null, (lang === "en" ? "Fat Whale · v" : "肥鲸 · v") + VERSION),
      h("span", {
        style: { color: "#FFD166", cursor: "pointer" },
        title: lang === "en" ? "Click to refresh balance" : "点一下刷新余额",
        onClick: ctx.onRefresh
      }, ctx.balanceText || "--")
    );
  }
  function renderChatPanel(ctx) {
    const { h, lang } = ctx;
    return h(
      "div",
      { ref: ctx.panelRef, style: chatPanelStyle(ctx.open) },
      h(
        "div",
        { style: headStyle },
        h("span", null, lang === "en" ? "Fat Whale · Chat" : "肥鲸 · 聊天"),
        h("span", { style: { cursor: "pointer", color: "#9FD8FF", padding: "0 4px" }, onClick: ctx.onClose }, "✕")
      ),
      h(
        "div",
        { ref: ctx.bodyRef, style: bodyStyle },
        ctx.messages.length === 0 ? h("div", { style: msgStyle("fish") }, lang === "en" ? "Click me to talk — I am right in the bottom-right corner." : "主人，点我说话，本鲸在右下角待着～") : ctx.messages.map((m, i) => h("div", { key: i, style: msgStyle(m.who) }, m.text))
      ),
      h(
        "div",
        { style: inputRowStyle },
        h("input", {
          ref: ctx.inputRef,
          style: inputStyle,
          placeholder: lang === "en" ? "Say something…" : "跟肥鲸说两句…",
          "aria-label": lang === "en" ? "Chat input" : "聊天输入框",
          value: ctx.input,
          onChange: (e) => ctx.onInputChange(e.target.value),
          onKeyDown: (e) => ctx.onKeyDown(e)
        }),
        h("button", { style: sendStyle, onClick: () => ctx.onSend() }, ctx.busy ? "…" : lang === "en" ? "Send" : "发送")
      )
    );
  }

  // src/client.ts
  window.__ModuleLoader__.load({
    id: "dsh-chubby-whale",
    factory: (require2) => {
      const R = require2("react");
      try {
        const wErr = window;
        if (!Array.isArray(wErr.__chubbyErrors)) wErr.__chubbyErrors = [];
        const pushErr = (line) => {
          try {
            const arr = wErr.__chubbyErrors;
            arr.push(String(line || "").slice(0, 800));
            while (arr.length > 50) arr.shift();
          } catch (e) {
          }
        };
        if (!wErr.__chubbyErrPatched) {
          wErr.__chubbyErrPatched = true;
          const origErr = console.error;
          console.error = function(...a) {
            pushErr(a.map((x) => x && x.stack ? x.stack : String(x)).join(" "));
            return origErr.apply(console, a);
          };
          window.addEventListener("error", (e) => {
            pushErr("window.error: " + (e.message || "") + " | " + (e.error && e.error.stack || ""));
          });
        }
      } catch (e) {
      }
      const h = R.createElement;
      const dg = (patch) => {
        try {
          Object.assign(window.__chubbyWhale || (window.__chubbyWhale = {}), patch);
        } catch (e) {
        }
      };
      const bump2 = (key) => {
        try {
          const w = window.__chubbyWhale;
          w[key] = (w[key] || 0) + 1;
        } catch (e) {
        }
      };
      const BUBBLE_TEXT_STYLE = { overflowWrap: "anywhere", wordBreak: "break-word" };
      const hookApi = createHooks(R);
      const actions = createActionTable();
      registerCultureActions(actions);
      registerContentActions(actions);
      registerSystemActions(actions);
      registerVoiceActions(actions);
      const CLIENT_ID = (() => {
        try {
          const v2 = sessionStorage.getItem("chubby-client-id");
          if (v2) return v2;
        } catch (e) {
        }
        const v = "c" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
        try {
          sessionStorage.setItem("chubby-client-id", v);
        } catch (e) {
        }
        return v;
      })();
      let ttsPlaying = false;
      const channels = { mic: { stats: {} }, asr: { stats: {} }, speak: { stats: {} } };
      const epoch = createEpoch();
      const storyNarratingRef = { current: false };
      const persona = createPersona();
      try {
        const w = window.__chubbyWhale || (window.__chubbyWhale = {});
        w.persona = persona;
      } catch (e) {
      }
      const narration = createNarrationLock();
      function setNarrating(ms2) {
        narration.lock(ms2);
        try {
          storyNarratingRef.current = true;
        } catch (e) {
        }
      }
      function clearNarrating() {
        narration.clear();
        try {
          stopProgress();
        } catch (e) {
        }
        try {
          storyNarratingRef.current = false;
        } catch (e) {
        }
      }
      let greetedOnce = false;
      const lineDeduper = createDeduper({ windowMs: 25e3, onDuplicate: () => bump2("dupLine") });
      const replyDeduper = createDeduper({ windowMs: 3e4, onDuplicate: () => bump2("dupReply") });
      const latDiag = { asrMs: 0, chatMs: 0, firstAudioMs: 0, totalMs: 0, updates: 0 };
      const melody = createMelodyPlayer();
      let lastRenderErr = "";
      function WhaleOverlay() {
        const [retryTick, setRetryTick] = R.useState(0);
        try {
          const tree = WhaleBody();
          lastRenderErr = "";
          return tree;
        } catch (e) {
          const msg = String(e && e.stack || e);
          dg({ renderError: msg });
          if (msg !== lastRenderErr) {
            lastRenderErr = msg;
            try {
              console.error("[chubby-whale] 渲染异常已被就地拦下：", e);
            } catch (e2) {
            }
          }
          return h("div", {
            key: "chubby-render-error-" + retryTick,
            style: recoverDotStyle,
            title: "本鲸打了个喷嚏，点一下再试（还不行就刷新页面）",
            onClick: (ev) => {
              evStop(ev);
              evPrevent(ev);
              try {
                setRetryTick((n) => n + 1);
              } catch (e2) {
              }
            }
          }, "⚠");
        }
      }
      function WhaleBody() {
        const stageRef = R.useRef(null);
        const canvasRef = R.useRef(null);
        const posRef = R.useRef({ x: 0, y: 0 });
        const talkRef = R.useRef({ talkUntil: 0, hearts: [] });
        const voiceModeRef = R.useRef(false);
        const voiceOnState = hookApi.usePersistentBool("chubby-voice");
        const voiceOnRef = voiceOnState.ref;
        const voiceOn = voiceOnState.value;
        const setVoiceOn = voiceOnState.set;
        const earOnState = hookApi.usePersistentBool("chubby-ear");
        const earOnRef = earOnState.ref;
        const earOn = earOnState.value;
        const setEarOn = earOnState.set;
        const voiceChatOnState = hookApi.usePersistentBool("chubby-voicechat");
        const voiceChatOnRef = voiceChatOnState.ref;
        const voiceChatOn = voiceChatOnState.value;
        const setVoiceChatOn = voiceChatOnState.set;
        const [balanceLabel, setBalanceLabel] = R.useState("--");
        const chatCacheOnRef = R.useRef(true);
        const [chatCacheOn, setChatCacheOn] = R.useState(true);
        R.useEffect(() => {
          getJson("/cache-toggle").then((d) => {
            if (d && typeof d.enabled === "boolean") {
              chatCacheOnRef.current = d.enabled;
              setChatCacheOn(d.enabled);
            }
          }).catch(() => {
          });
        }, []);
        const [growthLabel, setGrowthLabel] = R.useState("--");
        const [growth, setGrowth] = R.useState(DEFAULT_GROWTH);
        const lookRef = R.useRef(lookFor(0));
        const menuStatsAtRef = R.useRef(0);
        const dragRef = R.useRef(createDragState());
        const scaleRef = R.useRef(1);
        const inertiaRafRef = R.useRef(0);
        const animRef = R.useRef(null);
        const talkFor = (ms2) => {
          try {
            animRef.current?.talkFor(ms2);
          } catch (e) {
          }
        };
        const storyBusyRef = R.useRef(false);
        const storyBookRef = R.useRef("");
        const storyAutoRef = R.useRef((() => {
          try {
            const s = localStorage.getItem("chubby-story-auto");
            return s === null ? true : s !== "0";
          } catch (e) {
            return true;
          }
        })());
        const reminderPollerRef = hookApi.useLazyRef(() => createReminderPoller({
          getJson: (path, init) => getJson(path, init),
          bubble: showBubble,
          talkFor,
          speak: (text) => {
            try {
              speakText(text);
            } catch (e) {
            }
          },
          isSpeaking: () => ttsPlaying,
          isNarrating: () => storyNarratingRef.current,
          isBusy: () => busyLock.isBusy()
        }));
        const [scale, setScale] = R.useState(1);
        const [hidden, setHidden] = R.useState(false);
        const hiddenRef = R.useRef(false);
        hiddenRef.current = hidden;
        const skipInputClearRef = R.useRef(false);
        const chatRootRef = R.useRef(null);
        const [menu, setMenu] = R.useState(null);
        const [subOpen, setSubOpen] = R.useState("");
        const [menuFocus, setMenuFocus] = R.useState(-1);
        const menuFocusRef = R.useRef(-1);
        menuFocusRef.current = menuFocus;
        const menuEntriesRef = R.useRef([]);
        const [storyBooks, setStoryBooks] = R.useState([]);
        const [storyBooksTried, setStoryBooksTried] = R.useState(false);
        const [balanceText, setBalanceText] = R.useState("");
        const [lang, setLang] = R.useState((() => {
          try {
            return localStorage.getItem("chubby-lang") || "zh";
          } catch {
            return "zh";
          }
        })());
        const [chatOpen, setChatOpen] = R.useState(false);
        const chatOpenRef = R.useRef(false);
        chatOpenRef.current = chatOpen;
        const [messages, setMessages] = R.useState([]);
        const [input, setInput] = R.useState("");
        const [busy, setBusy] = R.useState(false);
        const busyLockRef = hookApi.useLazyRef(createBusyLock);
        const busyLock = busyLockRef.current;
        const bodyRef = R.useRef(null);
        const inputRef = R.useRef(null);
        const chatPanelRef = R.useRef(null);
        const bubbleRef = R.useRef(null);
        const bubbleTextRef = R.useRef(null);
        const bridgeRef = hookApi.useLazyRef(() => createVoiceBridge({
          narration,
          narrating: () => storyNarratingRef.current,
          stopSpeaking: () => stopTts(),
          bubble: showBubble,
          // 喊名字的应答要"出声"，不能只弹字：桥里拿不到 say 时会退化成纯气泡
          say: (text, ms2, opts) => sayLine(text, ms2, opts),
          sendText: (text, opts) => sendText(text, opts),
          onVoiceHeard: () => {
            try {
              voiceModeRef.current = true;
            } catch (e) {
            }
          },
          onSpeaking: (playing) => {
            ttsPlaying = playing;
          },
          // 语音聊天关着时"只听不接话"（由唤醒门之前先拦一道）
          voiceChat: () => voiceChatOnRef.current,
          // 正在朗读时，语音"停"要能直接打断（不受唤醒门限制）
          speaking: () => ttsPlaying,
          diag: dg
        }));
        const bridge = bridgeRef.current;
        R.useEffect(() => {
          try {
            ensureBubbleStyle(document);
          } catch {
          }
        }, []);
        R.useEffect(() => {
          let saved = null;
          try {
            const raw = localStorage.getItem("chubby-whale-pos");
            if (raw) saved = JSON.parse(raw);
          } catch {
          }
          const init = saved && typeof saved.x === "number" ? saved : homePos(W, H, window.innerWidth, window.innerHeight);
          posRef.current = init;
          applyPos(init.x, init.y);
        }, []);
        function applyPos(x, y) {
          const el = stageRef.current;
          if (!el) return;
          const s = (scaleRef.current || 1) * 1.08;
          const p = clampPos(x, y, W * s, H * s, window.innerWidth, window.innerHeight);
          x = p.x;
          y = p.y;
          const d = dragRef.current;
          if (d && d.dragging) {
            const bx = typeof d.baseX === "number" ? d.baseX : x;
            const by = typeof d.baseY === "number" ? d.baseY : y;
            el.style.transform = "translate3d(" + (x - bx) + "px," + (y - by) + "px,0)";
          } else {
            el.style.left = x + "px";
            el.style.top = y + "px";
            el.style.transform = "";
          }
          posRef.current = { x, y };
        }
        function savePos() {
          try {
            localStorage.setItem("chubby-whale-pos", JSON.stringify(posRef.current));
          } catch {
          }
        }
        function homePos2() {
          const p = homePos(W, H, window.innerWidth, window.innerHeight);
          applyPos(p.x, p.y);
          savePos();
        }
        R.useEffect(() => {
          let saveTimer = null;
          return bindResize(window, () => {
            applyPos(posRef.current.x, posRef.current.y);
            if (saveTimer) return;
            saveTimer = setTimeout(() => {
              saveTimer = null;
              savePos();
            }, 200);
          });
        }, []);
        R.useEffect(() => () => {
          try {
            if (inertiaRafRef.current) cancelAnimationFrame(inertiaRafRef.current);
          } catch (e) {
          }
        }, []);
        R.useEffect(() => {
          return createUnmountCleanup({
            reminderPoller: () => reminderPollerRef.current,
            stopTts: () => stopTts(),
            stopMelody: () => melody.stop(),
            bubbleEl: () => bubbleRef.current
          });
        }, []);
        const bubble = createBubble({
          el: () => bubbleRef.current,
          textEl: () => bubbleTextRef.current,
          pos: () => posRef.current,
          xOffset: W / 2,
          onHide: () => {
            try {
              restoreIdleStatus();
            } catch (e) {
            }
          }
        });
        function showBubble(text, ms2 = 2400) {
          bubble.show(text, ms2);
        }
        R.useEffect(() => {
          getJson("/status").then((d) => {
            if (d && d.ok && d.key === false) {
              showBubble("还没配 Key：聊天和语音要用 Key（deepseekKey / siliconflowKey），念诗、说书、典故、提醒照样能用～ 配置方法见 README", 9e3);
            }
          }).catch(() => {
          });
        }, []);
        function restoreIdleStatus() {
        }
        const reminderManagerRef = hookApi.useLazyRef(() => createReminderManager({ bubble: showBubble }));
        const reminderManager = reminderManagerRef.current;
        const recover = createRecover({ recover: () => setHidden(false) });
        function isTypingTarget(t) {
          try {
            if (!t) return false;
            const tag = String(t.tagName || "").toUpperCase();
            if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
            return !!t.isContentEditable;
          } catch (e) {
            return false;
          }
        }
        R.useEffect(() => {
          const wrapped = /* @__PURE__ */ new Map();
          const target = {
            addEventListener(type, fn, capture) {
              if (type !== "keydown" || typeof fn !== "function") {
                try {
                  window.addEventListener(type, fn, capture);
                } catch (e) {
                }
                return;
              }
              const guard = (e) => {
                if (isTypingTarget(e && e.target)) return;
                fn(e);
              };
              wrapped.set(fn, guard);
              try {
                window.addEventListener(type, guard, capture);
              } catch (e) {
              }
            },
            removeEventListener(type, fn, capture) {
              const guard = wrapped.get(fn);
              if (guard) {
                wrapped.delete(fn);
                try {
                  window.removeEventListener(type, guard, capture);
                } catch (e) {
                }
                return;
              }
              try {
                window.removeEventListener(type, fn, capture);
              } catch (e) {
              }
            }
          };
          const unbind = recover.bindHotkey(target);
          return () => {
            try {
              unbind();
            } catch (e) {
            }
          };
        }, []);
        R.useEffect(() => {
          return bindFileDropCapture({
            win: window,
            hitTest: (x, y) => {
              try {
                if (hiddenRef.current) return false;
                const el = stageRef.current;
                if (!el) return false;
                const r = el.getBoundingClientRect();
                const pad = 12;
                return x >= r.left - pad && x <= r.right + pad && y >= r.top - pad && y <= r.bottom + pad;
              } catch (e) {
                return false;
              }
            },
            onFile: (file) => {
              try {
                handleFileDrop(file, { showBubble, speakText }).catch(() => {
                });
              } catch (e2) {
              }
            }
          });
        }, []);
        R.useEffect(() => {
          const onPaste = (e) => {
            try {
              if (!chatOpenRef.current) return;
              const root = chatRootRef.current;
              const t = e && e.target;
              if (!root || !t || typeof root.contains !== "function" || !root.contains(t)) return;
              const dt = e.clipboardData;
              let file = null;
              const items = dt && dt.items;
              if (items && typeof items.length === "number") {
                for (let i = 0; i < items.length; i++) {
                  const it = items[i];
                  if (!it || it.kind !== "file" || !/^image\//.test(String(it.type || ""))) continue;
                  const f = typeof it.getAsFile === "function" ? it.getAsFile() : null;
                  if (f) {
                    file = f;
                    break;
                  }
                }
              }
              if (!file && dt && dt.files && dt.files.length) {
                const f = dt.files[0];
                if (f && /^image\//.test(String(f.type || ""))) file = f;
              }
              if (!file) return;
              evPrevent(e);
              evStop(e);
              handleFileDrop(file, { showBubble, speakText }).catch(() => {
                try {
                  showBubble("图片没处理成，再贴一次试试", 4e3);
                } catch (e2) {
                }
              });
            } catch (e2) {
            }
          };
          try {
            window.addEventListener("paste", onPaste, true);
          } catch (e) {
          }
          return () => {
            try {
              window.removeEventListener("paste", onPaste, true);
            } catch (e) {
            }
          };
        }, []);
        function dragBeginAt(x, y) {
          beginDrag(dragRef.current, x, y, posRef.current.x, posRef.current.y);
          try {
            const el = stageRef.current;
            if (el && el.style) {
              el.style.filter = "none";
              el.style.willChange = "transform";
            }
          } catch (e2) {
          }
        }
        function dragMoveTo(x, y) {
          const d = dragRef.current;
          if (!d.dragging) return;
          const m = moveDrag(d, x, y);
          applyPos(posRef.current.x + m.x, posRef.current.y + m.y);
        }
        function dragFinish() {
          const d = dragRef.current;
          if (!d.dragging) return;
          const v = endDrag(d);
          try {
            const el = stageRef.current;
            if (el && el.style) {
              el.style.filter = "";
              el.style.willChange = "";
            }
          } catch (e2) {
          }
          applyPos(posRef.current.x, posRef.current.y);
          savePos();
          let vx = v.x;
          let vy = v.y;
          let lastTs = 0;
          const step = (ts) => {
            if (dragRef.current.dragging) return;
            const dtScale = lastTs ? Math.min(4, Math.max(0.25, (ts - lastTs) / 16.67)) : 1;
            lastTs = ts;
            const dv = decayVelocity(vx, vy, dtScale);
            vx = dv.vx;
            vy = dv.vy;
            applyPos(posRef.current.x + vx, posRef.current.y + vy);
            if (dv.done) {
              savePos();
              return;
            }
            inertiaRafRef.current = requestAnimationFrame(step);
          };
          inertiaRafRef.current = requestAnimationFrame(step);
        }
        function onPointerDown(e) {
          if (typeof e.button === "number" && e.button !== 0) return;
          dragBeginAt(e.clientX, e.clientY);
          try {
            e.currentTarget.setPointerCapture(e.pointerId);
          } catch {
          }
        }
        function onPointerMove(e) {
          try {
            e.__chubbyDragHandled = true;
          } catch (e2) {
          }
          dragMoveTo(e.clientX, e.clientY);
        }
        function onPointerUp(e) {
          try {
            if (e) e.__chubbyDragHandled = true;
          } catch (e2) {
          }
          dragFinish();
        }
        R.useEffect(() => {
          const el = stageRef.current;
          const win = typeof window !== "undefined" ? window : null;
          if (!el || !win) return;
          const binding = bindDragInput(el, win, {
            onDown: (x, y) => dragBeginAt(x, y),
            onMove: (x, y) => {
              if (dragRef.current.dragging) dragMoveTo(x, y);
            },
            onEnd: () => {
              if (dragRef.current.dragging) dragFinish();
            }
          });
          dg({ dragInput: binding.mode });
          return () => {
            try {
              binding.dispose();
            } catch (e) {
            }
          };
        }, []);
        R.useEffect(() => {
          const stopGreet = startGreeting({
            greet: () => {
              try {
                if (greetedOnce) return;
                greetedOnce = true;
                const g = persona.greeting();
                if (g) sayLine(g, 5e3);
                try {
                  const off = (() => {
                    try {
                      return typeof localStorage !== "undefined" && localStorage.getItem("chubby-daily-greet") === "off";
                    } catch (e) {
                      return false;
                    }
                  })();
                  if (!off) {
                    getJson("/daily", { cache: "no-store" }).then((d) => {
                      try {
                        if (d && d.ok && d.text) sayLine("今天这句——" + String(d.text) + (d.source ? "（" + String(d.source) + "）" : ""), 9e3);
                      } catch (e) {
                      }
                    }).catch(() => {
                    });
                  }
                } catch (e) {
                }
              } catch (e) {
              }
            },
            hungry: () => {
              try {
                sayLine(persona.line("hungry"), 4e3);
              } catch (e) {
              }
            },
            // 打了招呼再看是不是饿了：饿着就补一句（对应人设的 hungry 场景）
            hungryNow: (() => {
              try {
                const st = persona.state;
                return !!(st && st.lastFeedAt && Date.now() - st.lastFeedAt > 6 * 3600 * 1e3);
              } catch (e) {
                return false;
              }
            })()
          });
          dg({ persona, sayLine });
          const stopWatch = startWatchdog(() => {
            try {
              try {
                if (narration.expire()) {
                  clearNarrating();
                  bump2("narrReset");
                }
              } catch (e3) {
              }
              if (busyLock.watchdog()) {
                setBusy(false);
                bump2("busyReset");
              }
            } catch (e) {
            }
          });
          const tF = 0;
          return () => {
            stopGreet();
            try {
              clearTimeout(tF);
            } catch (e) {
            }
            stopWatch();
            try {
              const el = bubbleRef.current;
              if (el) el.classList.remove("show");
            } catch (e) {
            }
          };
        }, []);
        function onContextMenu(e) {
          e.preventDefault();
          setMenu({ x: e.clientX, y: e.clientY });
          setSubOpen("");
          setMenuFocus(-1);
          refreshMenuStats();
          refreshStoryBooks();
        }
        function refreshStoryBooks() {
          getJson("/story/books", { cache: "no-store" }).then((d) => {
            setStoryBooks(parseBookList(d));
            setStoryBooksTried(true);
          }).catch(() => {
            setStoryBooks([]);
            setStoryBooksTried(true);
          });
        }
        function refreshMenuStats(force) {
          const now = Date.now();
          if (!force && now - menuStatsAtRef.current < 1e4) return;
          menuStatsAtRef.current = now;
          refreshBalance();
          getJson("/growth", { cache: "no-store" }).then((d) => {
            applyGrowthPayload(d);
          }).catch(() => {
            setGrowthLabel("--");
            setGrowth(DEFAULT_GROWTH);
          });
        }
        function applyGrowthPayload(d) {
          const info = parseGrowth(d);
          if (!info) {
            setGrowthLabel("--");
            setGrowth(DEFAULT_GROWTH);
            return;
          }
          applyGrowthInfo(info);
        }
        function applyGrowthInfo(info) {
          setGrowthLabel(info.stage + "（" + info.exp + (info.nextExp ? "/" + info.nextExp : "") + "）");
          setGrowth(info);
        }
        function syncGrowth() {
          fetchGrowth((p, init) => getJson(p, init)).then((info) => {
            if (info) applyGrowthInfo(info);
            else setGrowth(DEFAULT_GROWTH);
          });
        }
        function refreshBalance() {
          getJson("/balance", { cache: "no-store" }).then((d) => {
            if (d && d.ok && d.balance != null) {
              const v = String(d.balance);
              setBalanceText("余额 ¥" + v);
              setBalanceLabel("¥" + v);
            } else {
              setBalanceText("--");
              setBalanceLabel("--");
            }
          }).catch(() => {
            setBalanceText("--");
            setBalanceLabel("--");
          });
        }
        R.useEffect(() => {
          if (!menu) return;
          return bindOutsideClose({
            doc: document,
            onOutside: () => {
              setMenu(null);
              setSubOpen("");
            }
          });
        }, [menu]);
        R.useEffect(() => {
          if (!menu) return;
          const onKeyDown = (e) => {
            if (!e || e.key !== "Escape" && e.key !== "Esc") return;
            evStop(e);
            evPrevent(e);
            setMenu(null);
            setSubOpen("");
          };
          try {
            window.addEventListener("keydown", onKeyDown, true);
          } catch (e) {
          }
          return () => {
            try {
              window.removeEventListener("keydown", onKeyDown, true);
            } catch (e) {
            }
          };
        }, [menu]);
        R.useEffect(() => {
          if (!menu) return;
          return bindMenuKeys({
            win: window,
            isTyping: (t) => isTypingTarget(t),
            count: () => menuEntriesRef.current.length,
            index: () => menuFocusRef.current,
            setIndex: (i) => setMenuFocus(i),
            activate: (i) => {
              const entry = menuEntriesRef.current[i];
              if (!entry) return false;
              if (entry.kind === "sub") {
                setSubOpen(entry.open ? entry.parentPath : entry.path);
                return true;
              }
              void runAction(entry.action);
              return true;
            },
            close: () => {
              setMenu(null);
              setSubOpen("");
              setMenuFocus(-1);
            }
          });
        }, [menu]);
        const story = createStoryController({
          clientId: CLIENT_ID,
          persona,
          narrate: setNarrating,
          clearNarrate: clearNarrating,
          bubble: showBubble,
          speak: speakText,
          talkFor: (ms2) => {
            try {
              animRef.current?.talkFor(ms2);
            } catch (e) {
            }
          },
          narrationRate,
          isVoiceOff: () => {
            try {
              return localStorage.getItem("chubby-voice") === "off";
            } catch (e) {
              return false;
            }
          },
          refs: { busy: storyBusyRef, narrating: storyNarratingRef, auto: storyAutoRef, book: storyBookRef }
        });
        const reminderPoller = reminderPollerRef.current;
        const actionHost = {
          bubble: showBubble,
          say: sayLine,
          speak: speakText,
          speakReply: (text) => speakReply(text),
          narrate: setNarrating,
          clearNarrate: clearNarrating,
          stopSpeak: () => stopTts(),
          stopMelody: () => melody.stop(),
          playMelody: (notes, bpm, onDone) => melody.play(notes, bpm, onDone),
          talkFor,
          heart: () => {
            try {
              animRef.current?.pushHeart();
            } catch (e) {
            }
          },
          persona,
          clientId: CLIENT_ID,
          narrationRate,
          version: VERSION,
          story,
          storyState: { busy: storyBusyRef, narrating: storyNarratingRef, auto: storyAutoRef, book: storyBookRef },
          homePos: () => homePos2(),
          // 缩放：0.7–1.4，step 0.1；state 与 scaleRef 一起改（气泡定位读 scaleRef）
          nudgeScale: (delta) => {
            const s = Math.max(0.7, Math.min(1.4, (scaleRef.current || 1) + delta));
            scaleRef.current = s;
            setScale(s);
          },
          hide: () => setHidden(true),
          // 游走可逆 + 提醒管理：都只在这里接线，处理器在 client/actions/system.ts
          isHidden: () => hidden,
          recover: () => {
            try {
              setHidden(false);
            } catch (e) {
            }
          },
          openReminders: () => {
            try {
              reminderManager.open();
            } catch (e) {
            }
          },
          setChatOpen: (v) => setChatOpen(v),
          setVoiceMode: (v) => {
            voiceModeRef.current = v;
          },
          setMessages: (v) => setMessages(v),
          setBalance: (text, label) => {
            setBalanceText(text);
            setBalanceLabel(label);
          },
          refreshBalance: () => refreshBalance(),
          setGrowthLabel: (v) => setGrowthLabel(v),
          // 菜单「成长」拿到的响应直接复用；喂食后重新拉一次（外观随之实时更新）
          applyGrowth: (d) => applyGrowthPayload(d),
          syncGrowth: () => syncGrowth(),
          setLang: (l) => setLang(l),
          voice: () => bridge.get(),
          // 换音色：存 localStorage + 立即改实例音色（下一个 /tts 就带新 voice）
          setTtsVoice: (name) => {
            try {
              localStorage.setItem("chubby-tts-voice", name);
            } catch (e) {
            }
            try {
              bridge.setVoiceName(name);
            } catch (e) {
            }
          },
          // 试听：走宿主 /tts（strict），失败静默
          previewVoice: (text) => {
            try {
              bridge.preview(text);
            } catch (e) {
            }
          },
          wakeInfo: () => {
            try {
              return bridge.wakeInfo();
            } catch (e) {
              return null;
            }
          },
          voicePlaying: () => ttsPlaying,
          earStandby: () => earOnRef.current,
          setEarStandby: (v) => {
            earOnRef.current = v;
            setEarOn(v);
          },
          voiceChat: () => voiceChatOnRef.current,
          setVoiceChat: (v) => {
            voiceChatOnRef.current = v;
            setVoiceChatOn(v);
          },
          voiceOn: () => voiceOnRef.current,
          setVoiceOn: (v) => {
            voiceOnRef.current = v;
            setVoiceOn(v);
          },
          // 语音待命总开关：关=停录音（实例留着复用）；开=建/启语音模块（回调在 voice-bridge）
          toggleStandby: () => {
            const nowOn = !earOnRef.current;
            try {
              localStorage.setItem("chubby-ear", nowOn ? "on" : "off");
            } catch (e) {
            }
            earOnRef.current = nowOn;
            setEarOn(nowOn);
            if (!nowOn) {
              try {
                bridge.stop();
              } catch (e) {
              }
              try {
                stopTts();
              } catch (e) {
              }
              showBubble("语音待命：关（本鲸不听啦）", 2500);
              return;
            }
            try {
              bridge.start().then((v) => {
                try {
                  if (v.status() === "idle") showBubble("麦克风没打开：" + String(v.stats && v.stats.lastError || "看看权限？"), 5e3);
                  else showBubble("语音待命：开（先喊「大肥鱼」，本鲸才答话）", 3500);
                } catch (e) {
                }
              }).catch((e) => showBubble("麦克风没打开：" + String(e && e.message || e), 5e3));
            } catch (e) {
              showBubble("语音待命没开成：" + String(e && e.message || e), 5e3);
            }
          },
          chatCacheOn: () => chatCacheOnRef.current,
          setChatCacheOn: (v) => {
            chatCacheOnRef.current = v;
            setChatCacheOn(v);
          },
          diag: dg
        };
        async function runAction(action) {
          setMenu(null);
          let ok = false;
          try {
            ok = await actions.run(action, actionHost);
          } catch (e) {
            ok = false;
          }
          if (!ok) showBubble("这个功能还没接上");
        }
        function scrollBody() {
          setTimeout(() => {
            const el = bodyRef.current;
            if (el) el.scrollTop = el.scrollHeight;
          }, 0);
        }
        R.useEffect(() => {
          if (!chatOpen) return;
          scrollBody();
        }, [chatOpen, messages]);
        R.useEffect(() => {
          return bindChatFocus({
            win: window,
            open: chatOpen,
            input: () => inputRef.current,
            panel: () => chatPanelRef.current
          });
        }, [chatOpen]);
        const localRouter = createLocalRouter({
          persona,
          narrationRate,
          bubble: showBubble,
          say: sayLine,
          speak: speakText,
          narrate: setNarrating,
          clearNarrate: clearNarrating,
          talkFor,
          story,
          storyState: { busy: storyBusyRef, narrating: storyNarratingRef, auto: storyAutoRef, book: storyBookRef },
          // 点播（念诗/讲故事/讲典故）命中时打断进行中的聊天请求：不再等旧回复，也不会回来抢话
          abortChat: () => {
            try {
              chat.abortStream();
            } catch (e) {
            }
          }
        });
        const chatRef = hookApi.useLazyRef(() => createChatSender({
          persona,
          bubble: showBubble,
          say: sayLine,
          speak: speakText,
          speakReply: (text) => speakReply(text),
          stopSpeak: () => stopTts(),
          talkFor,
          heart: () => {
            try {
              animRef.current?.pushHeart();
            } catch (e) {
            }
          },
          // 语音回合不动输入框（主人可能正在打字）；打字/语音的来源由 sendText 填标记，用一次即复位
          setInput: (v) => {
            if (skipInputClearRef.current) {
              skipInputClearRef.current = false;
              return;
            }
            setInput(v);
          },
          setMessages: (v) => setMessages(v),
          setBusy: (v) => setBusy(v),
          scrollBody: () => scrollBody(),
          busy: busyLock,
          epoch,
          narrating: storyNarratingRef,
          storyBusy: storyBusyRef,
          voiceMode: voiceModeRef,
          ttsPlaying: () => ttsPlaying,
          narrationRate,
          route: (text) => localRouter.route(text),
          replyDeduper,
          recordChatLatency: (ms2) => {
            try {
              latDiag.chatMs = ms2;
              latDiag.updates++;
            } catch (e) {
            }
          }
        }));
        const chat = chatRef.current;
        function sendText(rawText, opts) {
          try {
            if (reminderManager.intercept(String(rawText == null ? "" : rawText))) {
              try {
                setInput("");
              } catch (e2) {
              }
              return Promise.resolve(true);
            }
          } catch (e) {
          }
          try {
            if (localRouter.route(String(rawText == null ? "" : rawText))) {
              try {
                setInput("");
              } catch (e2) {
              }
              return Promise.resolve(true);
            }
          } catch (e) {
          }
          try {
            skipInputClearRef.current = !!(opts && opts.voice);
          } catch (e) {
          }
          return chat.send(rawText, opts).then((ok) => ok !== false);
        }
        R.useEffect(() => {
          try {
            getJson("/pet").then((d) => {
              if (d && d.pet && d.pet.mood) applyServerMood(String(d.pet.mood));
            }).catch(() => {
            });
          } catch (e) {
          }
        }, []);
        R.useEffect(() => {
          const w = window.__chubbyWhale || (window.__chubbyWhale = {});
          try {
            w.say = (t) => {
              try {
                sendText(String(t || ""), { voice: true });
              } catch (e) {
              }
            };
            w.sayStop = () => {
              try {
                stopTts();
              } catch (e) {
              }
            };
            w.busyNow = () => ({ busy: busyLock.isBusy(), age: busyLock.age(), tts: ttsPlaying });
            w.look = () => lookRef.current;
          } catch (e) {
          }
          return () => {
            try {
              if (w.say) delete w.say;
              if (w.sayStop) delete w.sayStop;
              if (w.busyNow) delete w.busyNow;
              if (w.look) delete w.look;
            } catch (e) {
            }
          };
        }, []);
        R.useEffect(() => {
          return reminderPoller.start();
        }, []);
        R.useEffect(() => {
          if (!earOnRef.current) return;
          void bridge.start();
          return () => {
            bridge.dispose();
          };
        }, []);
        function speakText(text, o) {
          try {
            if (localStorage.getItem("chubby-voice") === "off") {
              dg({ ttsSkip: "voice-off" });
              try {
                if (o && typeof o.onDone === "function") o.onDone();
              } catch (e) {
              }
              return;
            }
          } catch (e) {
          }
          bridge.speak(text, o);
        }
        function stopTts() {
          try {
            chat.abortStream();
          } catch (e) {
          }
          clearNarrating();
          bridge.stopSpeak();
          try {
            storyBusyRef.current = false;
          } catch (e) {
          }
          try {
            storyNarratingRef.current = false;
          } catch (e) {
          }
        }
        function sayLine(text, ms2 = 3500, voiceOpts) {
          if (!lineDeduper.allow(text)) return;
          if (!text) return;
          try {
            showBubble(text, ms2);
          } catch (e) {
          }
          try {
            if (localStorage.getItem("chubby-voice") === "off") return;
            const v = bridge.get();
            if (v && v.speak && !v.speaking()) v.speak(text, { rate: voiceOpts && voiceOpts.rate || chatRate(), pitch: voiceOpts && voiceOpts.pitch || "" });
          } catch (e) {
          }
        }
        function speakReply(text) {
          const rp = String(text || "");
          if (!rp.trim()) return;
          if (!replyDeduper.allow(rp)) return;
          speakText(rp, { rate: rp.length >= 80 ? narrationRate() : chatRate() });
        }
        R.useEffect(() => {
          const next = lookForGrowth(growth);
          lookRef.current = next;
          try {
            if (animRef.current) animRef.current.setLook(next);
          } catch (e) {
          }
        }, [growth]);
        R.useEffect(() => {
          let alive = true;
          fetchGrowth((p, init) => getJson(p, init)).then((info) => {
            if (alive && info) setGrowth(info);
          });
          return () => {
            alive = false;
          };
        }, []);
        R.useEffect(() => {
          const canvas = canvasRef.current;
          if (!canvas) return;
          animRef.current = createAnimator({ canvas, imgSrc: "/api/chubby-whale/asset", cw: CW, ch: CH, sx: SX, sy: SY, state: talkRef.current, look: lookRef.current });
          animRef.current.start();
          return () => animRef.current?.stop();
        }, []);
        const recoverProps = recover.dot(hidden);
        const menuItems = menu ? buildMenu(VERSION, Object.assign({ voiceOn, earOn, voiceChatOn, chatCacheOn, narrationRate: narrationRate(), chatRate: chatRate(), balance: balanceLabel, growth: growthLabel, storyBooks, storyBooksTried }, readMenuRuntime())) : [];
        const menuEntries = menu ? listMenuEntries(menuItems, { tr, lang, subOpen }) : [];
        menuEntriesRef.current = menuEntries;
        function renderItems(items) {
          return renderMenuItems(items, {
            h,
            tr,
            lang,
            subOpen,
            focusIndex: menuFocus,
            onToggleSub: (next) => setSubOpen(next),
            onAction: (action) => runAction(action)
          });
        }
        return h(
          R.Fragment,
          null,
          h(
            "div",
            {
              ref: stageRef,
              style: stageStyle(scale, hidden),
              onPointerDown,
              onPointerMove,
              onPointerUp,
              onPointerCancel: onPointerUp,
              onContextMenu,
              onDragOver: (e) => {
                e.preventDefault();
                e.stopPropagation();
              },
              onDrop: (e) => {
                e.preventDefault();
                e.stopPropagation();
                const file = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
                handleFileDrop(file, { showBubble, speakText }).catch(() => {
                });
              },
              onClick: () => {
                if (dragRef.current.moved > 8) return;
                animRef.current?.talkFor(1200);
              }
            },
            h("canvas", { ref: canvasRef, width: CW, height: CH, style: canvasStyle })
          ),
          h("div", { ref: bubbleRef, className: "chubby-bubble" }, h("div", { ref: bubbleTextRef, style: BUBBLE_TEXT_STYLE })),
          recoverProps ? h("div", Object.assign({}, recoverProps, { style: recoverDotStyle }), "○") : null,
          menu ? h(
            "div",
            menuRootProps({ menu, lang }),
            // 标题栏：左边「名字 · 版本号」，右边余额（点一下刷新）；菜单最下面仍按规矩显示版本号
            renderMenuHeader({ h, lang, balanceText, onRefresh: () => {
              try {
                refreshMenuStats(true);
              } catch (e) {
              }
            } }),
            renderItems(menuItems)
          ) : null,
          // 聊天面板：结构与事件接线都在 client/render.ts，发送/输入法判断留在闭包里。
          // 外面包一层 display:contents 的根节点：粘贴处理要靠它判断事件是否发生在面板内，
          // contents 不生成布局盒子，不影响面板自身的 fixed 定位。
          h(
            "div",
            { ref: chatRootRef, style: { display: "contents" } },
            renderChatPanel({
              h,
              lang,
              open: chatOpen,
              messages,
              input,
              busy,
              bodyRef,
              inputRef,
              panelRef: chatPanelRef,
              onClose: () => setChatOpen(false),
              onInputChange: (v) => setInput(v),
              onKeyDown: (e) => {
                const ne = e && e.nativeEvent;
                if (ne && (ne.isComposing || ne.keyCode === 229)) return;
                if (e.key === "Enter" && input.trim()) {
                  const v = input;
                  void sendText(v);
                }
              },
              // 清空输入框由 chat.send 在真的发出后负责（占线被拒时保留主人的话）
              onSend: () => {
                const v = input;
                if (!v.trim()) return;
                void sendText(v);
              }
            })
          )
        );
      }
      return {
        name: "dsh-chubby-whale-client",
        inject: ["slots"],
        apply(ctx) {
          const diag2 = window.__chubbyWhale || (window.__chubbyWhale = {});
          Object.assign(diag2, {
            version: VERSION,
            applied: true,
            hasCtx: !!ctx,
            hasSlots: !!(ctx && ctx.slots),
            lat: latDiag,
            ch: { mic: channels.mic.stats, asr: channels.asr.stats, speak: channels.speak.stats },
            registered: false,
            error: null
          });
          try {
            const slots = ctx && ctx.slots;
            if (!slots) {
              diag2.error = "ctx.slots 不存在（inject 未生效）";
              console.warn("[chubby-whale]", diag2.error);
              return;
            }
            const desc = { name: "shell.overlay", id: "chubby-whale-overlay", order: 999, locale: "chubby-whale", inject: () => ({}) };
            const render = WhaleOverlay;
            const doRegister = () => {
              try {
                slots.register(desc, render);
                diag2.registered = true;
                console.log("[chubby-whale] overlay 已注册");
              } catch (e) {
                diag2.error = "register 失败: " + String(e);
                console.error("[chubby-whale] overlay 注册失败：", e);
              }
            };
            try {
              slots.inject("shell.overlay", doRegister);
              setTimeout(() => {
                if (!diag2.registered) doRegister();
              }, 1200);
            } catch (e) {
              diag2.error = "inject 失败: " + String(e);
              console.error("[chubby-whale] overlay 注入失败：", e);
              doRegister();
            }
          } catch (e) {
            diag2.error = "apply 异常: " + String(e);
            console.error("[chubby-whale] apply 异常：", e);
          }
        }
      };
    }
  });
})();
