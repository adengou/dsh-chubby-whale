(() => {
  // src/client/styles.ts
  var W = 240;
  var H = 213;
  var CW = 480;
  var CH = 426;
  var SX = CW / 1696;
  var SY = CH / 1504;
  var VERSION = "0.1.0";
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
    transformOrigin: "100% 100%",
    display: hidden ? "none" : "block"
  });
  var canvasStyle = { width: "100%", height: "100%", display: "block" };
  var menuStyle = (menu) => ({
    position: "fixed",
    left: (menu ? Math.min(menu.x, window.innerWidth - 220) : 0) + "px",
    top: (menu ? Math.min(menu.y, window.innerHeight - 400) : 0) + "px",
    width: 210,
    maxHeight: 480,
    overflowY: "auto",
    background: "rgba(12,28,52,0.98)",
    border: "1px solid #2E6BB8",
    borderRadius: 10,
    boxShadow: "0 12px 32px rgba(0,0,0,0.5)",
    zIndex: 10001,
    font: '13px/1.5 "Microsoft YaHei", sans-serif',
    display: menu ? "block" : "none",
    color: "#cfe9ff"
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

  // src/client/menu.ts
  var MELODIES = ["\u5C0F\u661F\u661F", "\u4E24\u53EA\u8001\u864E", "\u751F\u65E5\u5FEB\u4E50", "\u6B22\u4E50\u9882", "\u94C3\u513F\u54CD\u53EE\u5F53", "\u4F26\u6566\u5927\u6865", "\u65AF\u5361\u5E03\u7F57\u96C6\u5E02", "\u601D\u541B\u9EEF\u7136", "\u7EFF\u8896\u5B50", "\u81F4\u7231\u4E3D\u4E1D", "\u53CB\u8C0A\u5929\u957F\u5730\u4E45"];
  var SONG_EN = {
    "\u5C0F\u661F\u661F": "Twinkle Twinkle Little Star",
    "\u4E24\u53EA\u8001\u864E": "Two Tigers",
    "\u751F\u65E5\u5FEB\u4E50": "Happy Birthday",
    "\u6B22\u4E50\u9882": "Ode to Joy",
    "\u94C3\u513F\u54CD\u53EE\u5F53": "Jingle Bells",
    "\u4F26\u6566\u5927\u6865": "London Bridge",
    "\u65AF\u5361\u5E03\u7F57\u96C6\u5E02": "Scarborough Fair",
    "\u601D\u541B\u9EEF\u7136": "Longing for You",
    "\u7EFF\u8896\u5B50": "Greensleeves",
    "\u81F4\u7231\u4E3D\u4E1D": "Fur Elise",
    "\u53CB\u8C0A\u5929\u957F\u5730\u4E45": "Auld Lang Syne"
  };
  var EN_MAP = {
    "\u5582\u5B83\u4E00\u53E3": "Feed it",
    "\u5F39\u9996\u66F2\u5B50 \u25B8": "Play a song \u25B8",
    "\u505C\u6B62\u5F39\u594F": "Stop music",
    "\u6253\u5B57\u8BF4\u4E24\u53E5": "Type a message",
    "\u6362\u4E2A\u58F0\u97F3 \u25B8": "Change voice \u25B8",
    "\u804A\u5929\u8BED\u8A00 \u25B8": "Chat language \u25B8",
    "\u754C\u9762\u8BED\u8A00 \u25B8": "Interface language \u25B8",
    "\u770B\u5F20\u56FE\u2026": "Look at a picture\u2026",
    "\u505C\u6B62\u8BF4\u8BDD": "Stop talking",
    "\u505C\u4E0B\u6B47\u4F1A\u513F": "Take a break",
    "\u56DE\u5230\u53F3\u4E0B\u89D2": "Back to corner",
    "\u957F\u5927\u4E00\u70B9": "Grow bigger",
    "\u53D8\u5C0F\u4E00\u70B9": "Shrink",
    "\u52A0\u4E2A\u63D0\u9192\u2026": "Add reminder\u2026",
    "\u63D0\u9192\u6E05\u5355\u2026": "Reminders\u2026",
    "\u6587\u5316\u6C14 \u25B8": "Culture \u25B8",
    "\u8BF4\u4E66\uFF08\u8FDE\u8F7D\uFF09": "Storytelling",
    "\u63A5\u7740\u8BF4": "Continue story",
    "\u4ECE\u5934\u8BB2\u8FD9\u672C\u4E66": "Restart this book",
    "\u5FF5\u9996\u8BD7": "Recite a poem",
    "\u8BB2\u4E2A\u6C11\u95F4\u6545\u4E8B": "Folk tale",
    "\u8BB2\u4E2A\u5178\u6545": "Classic allusion",
    "\u6210\u8BED\u8FA8\u6790": "Idiom",
    "\u51FA\u4E2A\u5BF9\u8054": "Couplet",
    "\u6E05\u9664\u8BB0\u5FC6\u2026": "Clear memory\u2026",
    "\u6E05\u7A7A\u804A\u5929\u7F13\u5B58\u2026": "Clear chat cache\u2026",
    "\u804A\u5929\u7F13\u5B58\uFF1A\u5F00": "Chat cache: on",
    "\u804A\u5929\u7F13\u5B58\uFF1A\u5173": "Chat cache: off",
    "\u8BA9\u5B83\u6E38\u8D70\uFF08\u9000\u51FA\uFF09": "Let it go (exit)",
    "\u9C7C\u7CAE\u8D26\u672C": "Token ledger",
    "English": "English",
    "\u81EA\u52A8\uFF08\u6309\u8BED\u8A00\u9009\u97F3\u8272\uFF09": "Auto (by language)",
    "\u81EA\u52A8": "Auto",
    "\u2713 \u81EA\u52A8": "\u2713 Auto",
    "\u4E2D\u6587": "Chinese",
    "\u2713 \u4E2D\u6587": "\u2713 Chinese",
    "\u2713 English": "\u2713 English",
    "\u97F3\u8272\uFF1A\u6653\u4F0A\uFF08\u4E2D\xB7\u5973\uFF09": "Voice: Xiaoyi (CN F)",
    "\u97F3\u8272\uFF1A\u6653\u6653\uFF08\u4E2D\xB7\u5973\uFF09": "Voice: Xiaoxiao (CN F)",
    "\u97F3\u8272\uFF1A\u6653\u8FB0\uFF08\u4E2D\xB7\u5973\uFF09": "Voice: Xiaochen (CN F)",
    "\u97F3\u8272\uFF1A\u4E91\u5E0C\uFF08\u4E2D\xB7\u7537\uFF09": "Voice: Yunxi (CN M)",
    "\u97F3\u8272\uFF1A\u4E91\u626C\uFF08\u4E2D\xB7\u7537\uFF09": "Voice: Yunyang (CN M)",
    "\u97F3\u8272\uFF1AAna\uFF08\u82F1\xB7\u5973\uFF09": "Voice: Ana (EN F)",
    "\u97F3\u8272\uFF1AJenny\uFF08\u82F1\xB7\u5973\uFF09": "Voice: Jenny (EN F)",
    "\u97F3\u8272\uFF1ASonia\uFF08\u82F1\xB7\u5973\xB7\u82F1\u5F0F\uFF09": "Voice: Sonia (EN-GB F)"
  };
  var TOGGLE_EN = {
    "\u8BED\u97F3\u6717\u8BFB\uFF1A": ["Voice output: on", "Voice output: off"],
    "\u8BED\u97F3\u5F85\u547D\uFF1A": ["Voice standby: on", "Voice standby: off"],
    "\u8BED\u97F3\u804A\u5929\uFF1A": ["Voice chat: on", "Voice chat: off"]
  };
  function tr(label, lang) {
    if (lang !== "en") return label;
    const exact = EN_MAP[label];
    if (exact) return exact;
    if (label.startsWith("\u5F39\u300A") && label.endsWith("\u300B")) {
      const song = label.slice(2, label.length - 1);
      return SONG_EN[song] ? 'Play "' + SONG_EN[song] + '"' : "Play a song";
    }
    if (label.startsWith("\u6210\u957F\uFF1A")) return "Growth: " + label.slice(3);
    if (label.startsWith("\u7248\u672C\uFF1Av")) return "Version: v" + label.slice(4);
    if (label.startsWith("\u4F59\u989D\uFF1A")) return "Balance: " + label.slice(3);
    for (const prefix of Object.keys(TOGGLE_EN)) {
      if (label.startsWith(prefix)) {
        const pair = TOGGLE_EN[prefix];
        return label.slice(prefix.length) === "\u5F00" ? pair[0] : pair[1];
      }
    }
    return label;
  }
  var DEFAULT_VOICE = "zh-CN-XiaoyiNeural";
  function buildMenu(version, state) {
    const voiceOn = state && state.voiceOn ? true : false;
    const earOn = state && state.earOn ? true : false;
    const voiceChatOn = state && state.voiceChatOn ? true : false;
    const chatLang = state && state.chatLang ? String(state.chatLang) : "auto";
    const ttsVoice = state && state.ttsVoice ? String(state.ttsVoice) : DEFAULT_VOICE;
    const chatCacheOn = !(state && state.chatCacheOn === false);
    const voiceTick = (voice) => ttsVoice === voice ? "\u2713 " : "";
    const balanceText = state && state.balance ? state.balance : "--";
    const growthText = state && state.growth ? state.growth : "--";
    return [
      // ── 吃饭与看图 ──
      { type: "item", label: "\u6295\u5582\u4E00\u7897", action: "feed" },
      { type: "item", label: "\u770B\u5F20\u56FE\u2026", action: "vision" },
      { type: "sep" },
      // ── 曲子 ──
      { type: "sub", label: "\u5F39\u9996\u66F2\u5B50 \u25B8", items: MELODIES.map((m) => ({ type: "item", label: "\u5F39\u300A" + m + "\u300B", action: "music:" + m })) },
      { type: "item", label: "\u505C\u6B62\u5F39\u594F", action: "music-stop" },
      { type: "sep" },
      // ── 说话与耳朵（语音类全放一起）──
      { type: "item", label: "\u8DDF\u5979\u8BF4\u4E24\u53E5", action: "type" },
      { type: "item", label: voiceOn ? "\u8BED\u97F3\u6717\u8BFB\uFF1A\u5F00" : "\u8BED\u97F3\u6717\u8BFB\uFF1A\u5173", action: "voice" },
      { type: "item", label: "\u505C\u6B62\u8BF4\u8BDD", action: "tts-stop" },
      { type: "sub", label: "\u6362\u4E2A\u58F0\u97F3 \u25B8", items: [
        { type: "item", label: voiceTick("zh-CN-XiaoyiNeural") + "\u97F3\u8272\uFF1A\u6653\u4F0A\uFF08\u4E2D\xB7\u5973\uFF09", action: "voice:zh-CN-XiaoyiNeural" },
        { type: "item", label: voiceTick("zh-CN-XiaoxiaoNeural") + "\u97F3\u8272\uFF1A\u6653\u6653\uFF08\u4E2D\xB7\u5973\uFF09", action: "voice:zh-CN-XiaoxiaoNeural" },
        { type: "item", label: voiceTick("zh-CN-XiaochenNeural") + "\u97F3\u8272\uFF1A\u6653\u8FB0\uFF08\u4E2D\xB7\u5973\uFF09", action: "voice:zh-CN-XiaochenNeural" },
        { type: "item", label: voiceTick("zh-CN-YunxiNeural") + "\u97F3\u8272\uFF1A\u4E91\u5E0C\uFF08\u4E2D\xB7\u7537\uFF09", action: "voice:zh-CN-YunxiNeural" },
        { type: "item", label: voiceTick("zh-CN-YunyangNeural") + "\u97F3\u8272\uFF1A\u4E91\u626C\uFF08\u4E2D\xB7\u7537\uFF09", action: "voice:zh-CN-YunyangNeural" },
        { type: "item", label: voiceTick("en-US-AnaNeural") + "\u97F3\u8272\uFF1AAna\uFF08\u82F1\xB7\u5973\uFF09", action: "voice:en-US-AnaNeural" },
        { type: "item", label: voiceTick("en-US-JennyNeural") + "\u97F3\u8272\uFF1AJenny\uFF08\u82F1\xB7\u5973\uFF09", action: "voice:en-US-JennyNeural" },
        { type: "item", label: voiceTick("en-GB-SoniaNeural") + "\u97F3\u8272\uFF1ASonia\uFF08\u82F1\xB7\u5973\xB7\u82F1\u5F0F\uFF09", action: "voice:en-GB-SoniaNeural" },
        { type: "item", label: voiceTick("auto") + "\u81EA\u52A8\uFF08\u6309\u8BED\u8A00\u9009\u97F3\u8272\uFF09", action: "voice:auto" }
      ] },
      { type: "item", label: "\u8BED\u97F3\u5F85\u547D\uFF1A" + (earOn ? "\u5F00" : "\u5173"), action: "wake" },
      { type: "item", label: "\u8BED\u97F3\u804A\u5929\uFF1A" + (voiceChatOn ? "\u5F00" : "\u5173"), action: "chatmode" },
      { type: "item", label: "\u7AEF\u70B9\u68C0\u6D4B\uFF1A\u7ECF\u5178/\u81EA\u9002\u5E94", action: "endpoint" },
      { type: "item", label: "\u8033\u6735\u81EA\u68C0\uFF08\u542C\u529B\u8BCA\u65AD\uFF09", action: "ear-check" },
      { type: "sep" },
      // ── 语言 ──
      { type: "sub", label: "\u804A\u5929\u8BED\u8A00 \u25B8", items: [
        { type: "item", label: (chatLang === "auto" ? "\u2713 " : "") + "\u81EA\u52A8", action: "chat-lang:auto" },
        { type: "item", label: (chatLang === "zh" ? "\u2713 " : "") + "\u4E2D\u6587", action: "chat-lang:zh" },
        { type: "item", label: (chatLang === "en" ? "\u2713 " : "") + "English", action: "chat-lang:en" }
      ] },
      { type: "sub", label: "\u754C\u9762\u8BED\u8A00 \u25B8", items: [
        { type: "item", label: "\u4E2D\u6587", action: "lang:zh" },
        { type: "item", label: "English", action: "lang:en" }
      ] },
      { type: "sep" },
      // ── 位置与大小 ──
      { type: "item", label: "\u8BA9\u5979\u6B47\u4F1A\u513F", action: "pause" },
      { type: "item", label: "\u56DE\u7897\u91CC\u5F85\u7740", action: "home" },
      { type: "item", label: "\u957F\u5927\u4E00\u70B9", action: "bigger" },
      { type: "item", label: "\u53D8\u5C0F\u4E00\u70B9", action: "smaller" },
      { type: "sep" },
      // ── 饭点提醒 ──
      { type: "item", label: "\u8BB0\u4E2A\u996D\u70B9\u2026", action: "remind-add" },
      { type: "item", label: "\u63D0\u9192\u6E05\u5355\u2026", action: "remind-list" },
      { type: "sep" },
      // ── 文化气 ──
      { type: "sub", label: "\u6587\u5316\u6C14 \u25B8", items: [
        { type: "item", label: "\u8BF4\u4E66\uFF08\u8FDE\u8F7D\uFF09", action: "culture-story" },
        { type: "item", label: "\u63A5\u7740\u8BF4", action: "culture-story-next" },
        { type: "item", label: "\u4ECE\u5934\u8BB2\u8FD9\u672C\u4E66", action: "story-reset" },
        { type: "item", label: "\u5FF5\u9996\u8BD7", action: "poem" },
        { type: "item", label: "\u8BB2\u4E2A\u6C11\u95F4\u6545\u4E8B", action: "culture-tale" },
        { type: "item", label: "\u8BB2\u4E2A\u5178\u6545", action: "culture-allusion" },
        { type: "item", label: "\u6210\u8BED\u8FA8\u6790", action: "culture-idiom" },
        { type: "item", label: "\u51FA\u4E2A\u5BF9\u8054", action: "culture-couplet" }
      ] },
      { type: "sep" },
      // ── 记忆、缓存与退出 ──
      { type: "item", label: "\u6E05\u9664\u8BB0\u5FC6\u2026", action: "clear-memory" },
      { type: "item", label: "\u6E05\u7A7A\u804A\u5929\u7F13\u5B58\u2026", action: "cache-clear" },
      { type: "item", label: chatCacheOn ? "\u804A\u5929\u7F13\u5B58\uFF1A\u5F00" : "\u804A\u5929\u7F13\u5B58\uFF1A\u5173", action: "cache-toggle" },
      { type: "item", label: "\u8BA9\u5B83\u6E38\u8D70\uFF08\u9000\u51FA\uFF09", action: "hide" },
      { type: "sep" },
      // ── 账本与版本（版本永远在最底下）──
      { type: "item", label: "\u9C7C\u7CAE\u8D26\u672C", action: "fishfood" },
      { type: "item", label: "\u6210\u957F\uFF1A" + growthText, action: "growth" },
      { type: "item", label: "\u7248\u672C\uFF1Av" + version, action: "version" }
    ];
  }

  // src/client/image.ts
  var DEFAULT_MAX_EDGE = 1280;
  var DEFAULT_QUALITY = 0.85;
  var KEEP_RAW_BELOW = 400 * 1024;
  function readFileAsBase64(file) {
    return new Promise((resolve) => {
      try {
        const fr = new FileReader();
        fr.onloadend = () => {
          const s = String(fr.result || "");
          resolve(s.indexOf(",") >= 0 ? s.slice(s.indexOf(",") + 1) : s);
        };
        fr.onerror = () => resolve("");
        fr.readAsDataURL(file);
      } catch (e) {
        resolve("");
      }
    });
  }
  function decodeImage(file) {
    return new Promise((resolve) => {
      try {
        const w = typeof window !== "undefined" ? window : globalThis;
        if (typeof w.createImageBitmap === "function") {
          Promise.resolve(w.createImageBitmap(file)).then((bmp) => resolve(bmp)).catch(() => resolve(null));
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
    const raw = await readFileAsBase64(file);
    if (!raw) return null;
    const rawMime = String(file && file.type || "image/jpeg");
    const rawResult = { b64: raw, mime: rawMime, width: 0, height: 0, compressed: false };
    try {
      if (raw.length <= KEEP_RAW_BELOW) return rawResult;
      const maxEdge = Math.max(256, Math.min(4096, Math.round(Number(opts && opts.maxEdge) || DEFAULT_MAX_EDGE)));
      const quality = Math.min(0.95, Math.max(0.5, Number(opts && opts.quality) || DEFAULT_QUALITY));
      const img = await decodeImage(file);
      if (!img) return rawResult;
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
      cx.drawImage(img, 0, 0, w, h);
      const dataUrl = String(canvas.toDataURL("image/jpeg", quality) || "");
      const at = dataUrl.indexOf(",");
      const b64 = at >= 0 ? dataUrl.slice(at + 1) : "";
      if (!b64) return rawResult;
      if (b64.length >= raw.length) return rawResult;
      if (typeof img.close === "function") {
        try {
          img.close();
        } catch (e) {
        }
      }
      return { b64, mime: "image/jpeg", width: w, height: h, compressed: true };
    } catch (e) {
      return rawResult;
    }
  }

  // src/client/dropzone.ts
  var MAX_DROP_BYTES = 4 * 1024 * 1024;
  var MAX_TEXT_CHARS = 8e3;
  var VISION_PROMPT = "\u770B\u770B\u8FD9\u5F20\u56FE\uFF0C\u8BF4\u8BF4\u4F60\u770B\u5230\u4E86\u4EC0\u4E48";
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
    return "\u603B\u7ED3\u4E00\u4E0B\u8FD9\u7BC7\u6587\u6863\uFF1A\n" + String(text || "").slice(0, MAX_TEXT_CHARS);
  }
  async function handleFileDrop(file, deps) {
    const d = deps || {};
    const bubble = typeof d.showBubble === "function" ? d.showBubble : () => {
    };
    const speak = typeof d.speakText === "function" ? d.speakText : null;
    const doFetch = d.fetchImpl || (typeof fetch !== "undefined" ? fetch : null);
    if (!file) {
      bubble("\u6CA1\u62FF\u5230\u6587\u4EF6\uFF0C\u518D\u62D6\u4E00\u6B21\u8BD5\u8BD5", 4e3);
      return { ok: false, kind: "empty", error: "no file" };
    }
    const size = Number(file.size) || 0;
    if (size > MAX_DROP_BYTES) {
      bubble("\u6587\u4EF6\u592A\u5927\u5566\uFF08\u8D85\u8FC7 4MB\uFF09\uFF0C\u672C\u9C7C\u4E00\u53E3\u5403\u4E0D\u4E0B", 5e3);
      return { ok: false, kind: "too-large", error: "too large" };
    }
    if (!doFetch) {
      bubble("\u672C\u9C7C\u8FDE\u4E0D\u4E0A\u670D\u52A1\u5668", 4e3);
      return { ok: false, kind: "error", error: "no fetch" };
    }
    const post = async (body) => {
      const r = await doFetch("/api/chubby-whale/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body)
      });
      return r.json();
    };
    if (isImageFile(file)) {
      bubble("\u672C\u9CB8\u770B\u770B\u8FD9\u5F20\u56FE\u2026", 3e3);
      const img0 = await imageToB64(file);
      const b64 = img0 ? img0.b64 : "";
      const mime = img0 && img0.mime || file.type || "image/jpeg";
      if (!b64) {
        bubble("\u56FE\u7247\u8BFB\u4E0D\u51FA\u6765\uFF0C\u518D\u62D6\u4E00\u6B21\u8BD5\u8BD5", 4e3);
        return { ok: false, kind: "error", error: "empty image" };
      }
      try {
        const reply0 = await post({ message: VISION_PROMPT, image: b64, imageMime: mime });
        const reply = String(reply0 && reply0.reply || "").trim() || "\u8FD9\u6761\u9C7C\u770B\u4E0D\u61C2\u8FD9\u5F20\u56FE\u2026\u2026";
        bubble("\uFF08\u770B\u56FE\uFF09" + reply, 1e4);
        if (speak) speak(reply);
        return { ok: true, kind: "image", message: VISION_PROMPT, reply };
      } catch (e) {
        bubble("\u56FE\u7247\u5904\u7406\u5931\u8D25", 4e3);
        return { ok: false, kind: "error", error: String(e && e.message || e) };
      }
    }
    if (isTextFile(file)) {
      let text = "";
      try {
        text = String(await file.text());
      } catch (e) {
        text = "";
      }
      if (!text.trim()) {
        bubble("\u8FD9\u4E2A\u6587\u4EF6\u91CC\u6CA1\u8BFB\u5230\u5B57", 4e3);
        return { ok: false, kind: "error", error: "empty text" };
      }
      const message = buildTextPrompt(text);
      bubble("\u672C\u9CB8\u770B\u770B\u8FD9\u4EFD\u6587\u6863\u2026", 3e3);
      try {
        const reply0 = await post({ message });
        const reply = String(reply0 && reply0.reply || "").trim() || "\u8FD9\u4EFD\u6587\u6863\u672C\u9CB8\u6CA1\u770B\u61C2\u2026\u2026";
        bubble("\uFF08\u6587\u6863\uFF09" + reply, 12e3);
        if (speak) speak(reply);
        return { ok: true, kind: "text", message, reply };
      } catch (e) {
        bubble("\u6587\u6863\u5904\u7406\u5931\u8D25", 4e3);
        return { ok: false, kind: "error", error: String(e && e.message || e) };
      }
    }
    bubble("\u8FD9\u4E2A\u683C\u5F0F\u672C\u9C7C\u8FD8\u4E0D\u4F1A\u770B", 4e3);
    return { ok: false, kind: "unsupported", error: "unsupported type" };
  }

  // src/client/anim.ts
  var EYE_L = { x: 679, y: 430, r: 68 };
  var EYE_R = { x: 860, y: 435, r: 68 };
  var MOUTH = { x: 779, y: 525, rw: 26, rh: 18 };
  function createAnimator(opts) {
    const { canvas, imgSrc, cw, ch, sx, sy, state } = opts;
    const ctx = canvas.getContext("2d");
    const img = new Image();
    img.src = imgSrc;
    let raf = 0;
    let last = performance.now();
    let blinkT = 0;
    let blinkClosed = false;
    let blinkGap = 3200 + Math.random() * 1800;
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
        ctx.font = size + "px serif";
        ctx.fillText("\u2764", x, y);
      }
    }
    function loop(t) {
      const dt = Math.min(50, t - last);
      last = t;
      ctx.clearRect(0, 0, cw, ch);
      if (img.complete && img.naturalWidth > 0) {
        ctx.drawImage(img, 0, 0, 1696, 1504, 0, 0, cw, ch);
      }
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
      drawHearts(dt / 1e3);
      raf = requestAnimationFrame(loop);
    }
    function start() {
      raf = requestAnimationFrame(loop);
    }
    function stop() {
      cancelAnimationFrame(raf);
    }
    function talkFor(ms) {
      state.talkUntil = performance.now() + ms;
    }
    function pushHeart() {
      state.hearts.push({ age: 0, dx: Math.random() - 0.5 });
    }
    return { start, stop, talkFor, pushHeart };
  }

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
    maxSegmentMs: 6e3,
    steadyWindowFrames: 25,
    // 25 帧 × 60ms = 1.5s
    steadySpreadDb: 3,
    steadyMs: 900
  };
  var Ape = class {
    p;
    floorDb = null;
    peakDb = -160;
    speechMs = 0;
    quietMs = 0;
    elapsedMs = 0;
    runMs = 0;
    hadSpeech = false;
    bandMs = 0;
    steadyHist = [];
    steadyMs = 0;
    steadyCooldownMs = 0;
    // 平稳噪声确认后的冷却期：这段时间不把电平算成说话
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
      this.steadyCooldownMs = 0;
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
        let justConfirmedNoise = false;
        if (spread < p.steadySpreadDb) {
          this.steadyMs += p.frameMs;
          if (this.steadyMs >= p.steadyMs) {
            this.floorDb = this.floorDb * 0.7 + db * 0.3;
            this.speechMs = 0;
            this.runMs = 0;
            this.hadSpeech = false;
            this.steadyHist.length = 0;
            this.steadyMs = 0;
            this.steadyCooldownMs = 2e3;
            justConfirmedNoise = true;
          }
        } else {
          this.steadyMs = 0;
        }
        if (this.steadyCooldownMs > 0) {
          this.steadyCooldownMs -= p.frameMs;
        } else if (!justConfirmedNoise) {
          this.speechMs += p.frameMs;
          this.runMs += p.frameMs;
          this.hadSpeech = true;
        }
        this.quietMs = 0;
        this.bandMs = 0;
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
      const validSpeech = this.speechMs >= p.minSpeechMs;
      let commit = false;
      let commitReason = "";
      if (validSpeech && this.quietMs >= quietTargetMs) {
        commit = true;
        commitReason = "quiet";
      } else if (this.elapsedMs >= p.maxSegmentMs) {
        commit = true;
        commitReason = "overflow";
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
    for (const item of opts.recent || []) {
      if (now - Number(item && item.at || 0) > windowMs) continue;
      const prev = normalizeText(item && item.text ? item.text : "");
      if (!prev) continue;
      if (cur === prev) return true;
      const shortOne = cur.length <= prev.length ? cur : prev;
      const longOne = cur.length <= prev.length ? prev : cur;
      if (shortOne.length >= minLen && longOne.indexOf(shortOne) >= 0) return true;
      if (cur.length >= minLen && prev.length >= minLen && similarity(cur, prev) >= threshold) return true;
    }
    return false;
  }

  // src/client/playback.ts
  function isPlaybackZombie(p) {
    const zombieMs = p.zombieMs === void 0 ? 2500 : p.zombieMs;
    const synthTimeoutMs = p.synthTimeoutMs === void 0 ? 2e4 : p.synthTimeoutMs;
    if (!p.busy) return false;
    if (p.hasAudio && p.audioPlaying) return false;
    if (!p.hasAudio && p.synthAt > 0 && p.now - p.synthAt < synthTimeoutMs) return false;
    return p.now - p.busySince >= zombieMs;
  }

  // src/client/voice.ts
  var WINDOW_MS = 6e3;
  var EARLY_STOP_QUIET = 700;
  var MIN_SPEECH_MS = 400;
  var SILENT_PEAK_DB = -35;
  var ECHO_MUTE_MS = 700;
  var ASR_TIMEOUT_MS = 15e3;
  var TTS_TIMEOUT_MS = 2e4;
  var NARRATION_RATE = (() => {
    try {
      const s = localStorage.getItem("chubby-narration-rate");
      return s && /^[+-]\d{1,2}%$/.test(s) ? s : "-25%";
    } catch (e) {
      return "-25%";
    }
  })();
  var TTS_WATCH_MS = 1e3;
  var TTS_ZOMBIE_MS = 2500;
  var NOISE_TEXTS = ["\u55EF", "\u5443", "\u554A", "\u54E6", "\u55EF\u55EF", "\u8C22\u8C22\u89C2\u770B", "\u8C22\u8C22\u5927\u5BB6", "\u5B57\u5E55", "\u8BF7\u4E0D\u541D\u70B9\u8D5E", "\u8BA2\u9605", "\u8F6C\u53D1", "\u6253\u8D4F", "\u518D\u89C1", "\u672C\u9C7C\u5728\u542C", "\u55EF\u672C\u9C7C\u5728\u542C"];
  function createVoice(opts) {
    const apiBase = opts.apiBase || "/api/chubby-whale";
    let voiceName = opts.voiceName || "zh-CN-XiaoyiNeural";
    let epMode = (() => {
      try {
        return localStorage.getItem("chubby-endpoint") === "ape" ? "ape" : "classic";
      } catch (e) {
        return "classic";
      }
    })();
    const ape = new Ape();
    let lastApe = null;
    let lastSeg = null;
    let lastTts = null;
    const stats = {
      windows: 0,
      skippedSilent: 0,
      uploaded: 0,
      asrFail: 0,
      asrTexts: 0,
      heard: 0,
      echoDropped: 0,
      ttsRequests: 0,
      ttsPlayed: 0,
      ttsFail: 0,
      ttsZombie: 0,
      lastError: ""
    };
    let status = "idle";
    function setStatus(s) {
      if (status === s) return;
      status = s;
      try {
        opts.onStatus && opts.onStatus(s);
      } catch (e) {
      }
    }
    let stream = null;
    let actx = null;
    let analyser = null;
    let rec = null;
    let timeBuf = null;
    let running = false;
    let muted = false;
    let parts = [];
    let winPeak = -160;
    let speechMs = 0;
    let quietMs = 0;
    let winStart = 0;
    let tickTimer = null;
    let restartTimer = null;
    let lastText = "";
    let lastTextAt = 0;
    const spokenRecent = [];
    const recentHeard = [];
    const ttsQ = [];
    let ttsBusy = false;
    let ttsAudio = null;
    let ttsBusySince = 0;
    let ttsSynthAt = 0;
    let ttsWatch = null;
    let mutedUntil = 0;
    let speakToken = 0;
    const level = () => {
      if (!analyser || !timeBuf) return -160;
      analyser.getFloatTimeDomainData(timeBuf);
      let sum = 0;
      for (let i = 0; i < timeBuf.length; i++) sum += timeBuf[i] * timeBuf[i];
      const rms = Math.sqrt(sum / timeBuf.length);
      return 20 * Math.log10(rms + 1e-8);
    };
    function micOn(on) {
      try {
        if (stream) stream.getAudioTracks().forEach((t) => {
          t.enabled = on;
        });
      } catch (e) {
      }
    }
    function scheduleNext(ms) {
      if (!running) return;
      if (restartTimer) clearTimeout(restartTimer);
      restartTimer = setTimeout(() => {
        restartTimer = null;
        beginWindow();
      }, ms);
    }
    function beginWindow() {
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
        parts = [];
        winPeak = -160;
        speechMs = 0;
        quietMs = 0;
        winStart = performance.now();
        ape.resetSegment();
        lastApe = null;
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
        if (epMode === "ape") {
          const st = ape.step(db);
          lastApe = st;
          if (db > winPeak) winPeak = db;
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
          tickTimer = setTimeout(tick, 60);
          return;
        }
        if (db > winPeak) winPeak = db;
        const now = performance.now();
        const elapsed = now - winStart;
        if (db > (muted ? 0 : -45)) {
          speechMs += 60;
          quietMs = 0;
        } else {
          quietMs += 60;
        }
        const earlyStop = speechMs >= MIN_SPEECH_MS && quietMs >= EARLY_STOP_QUIET;
        const tooLong = elapsed >= WINDOW_MS;
        if (earlyStop || tooLong) {
          try {
            rec.stop();
          } catch (e) {
          }
          try {
            opts.onDiag && opts.onDiag({ stage: "window-end", why: earlyStop ? "quiet" : "timeout", peak: Math.round(winPeak), speechMs });
          } catch (e) {
          }
          return;
        }
        tickTimer = setTimeout(tick, 60);
      } catch (e) {
        stats.lastError = "tick: " + String(e && e.name);
        tickTimer = setTimeout(tick, 120);
      }
    }
    async function onWindowDone(blob) {
      stats.windows++;
      if (epMode === "ape") {
        const okSpeech = !!(lastApe && lastApe.hadSpeech && lastApe.speechMs >= 150);
        if (!okSpeech) {
          stats.skippedSilent++;
          scheduleNext(150);
          return;
        }
      } else if (winPeak < SILENT_PEAK_DB) {
        stats.skippedSilent++;
        scheduleNext(150);
        return;
      }
      if (Date.now() < mutedUntil) {
        stats.skippedSilent++;
        scheduleNext(150);
        return;
      }
      if (blob.size < 1200) {
        stats.skippedSilent++;
        scheduleNext(150);
        return;
      }
      stats.uploaded++;
      setStatus("recognizing");
      try {
        const b64 = await blobToBase64(blob);
        if (!b64) {
          stats.asrFail++;
          stats.lastError = "b64-empty";
          return;
        }
        const res = await fetchWithTimeout(apiBase + "/asr", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ audio: b64, format: "webm" })
        }, ASR_TIMEOUT_MS);
        const data = await res.json();
        if (!data || !data.ok) {
          stats.asrFail++;
          stats.lastError = "asr: " + String(data && data.error || "failed");
          return;
        }
        try {
          lastSeg = { mode: epMode, winMs: Math.round(performance.now() - winStart), peMs: lastApe ? lastApe.speechMs : speechMs, quMs: lastApe ? lastApe.quietMs : quietMs, floor: lastApe ? Math.round(lastApe.floorDb) : null, target: lastApe ? lastApe.quietTargetMs : null, text: String(data.text || "").slice(0, 24) };
        } catch (e) {
        }
        const text = String(data.text || "").trim();
        if (!text) return;
        stats.asrTexts++;
        if (acceptText(text)) {
          stats.heard++;
          setStatus("thinking");
          try {
            opts.onHeard(text);
          } catch (e) {
          }
        } else {
          stats.echoDropped++;
        }
      } catch (e) {
        stats.asrFail++;
        stats.lastError = "asr-ex: " + String(e && e.name || e);
      } finally {
        if (status === "recognizing") setStatus("listening");
        if (!rec || rec.state === "inactive") scheduleNext(150);
      }
    }
    function acceptText(text) {
      const plain = text.replace(/[\s。，！？,.!?、…~～]/g, "");
      if (plain.length < 2 && !/^[停别不]$/.test(plain)) return false;
      if (NOISE_TEXTS.indexOf(plain) >= 0) return false;
      if (/^本鱼在听/.test(plain)) return false;
      const now = Date.now();
      for (const s of spokenRecent) {
        if (now - s.at > 15e3) continue;
        const target = s.text.replace(/[\s。，！？,.!?、…~～]/g, "");
        if (!target) continue;
        if (plain === target) return false;
        if (target.length >= 6 && plain.indexOf(target.slice(0, 6)) >= 0) return false;
        if (plain.length >= 6 && target.indexOf(plain.slice(0, 6)) >= 0) return false;
        if (plain.length >= 3 && now - s.at < 6e3 && target.indexOf(plain) >= 0) {
          try {
            stats.echoDropped++;
          } catch (e) {
          }
          ;
          return false;
        }
      }
      if (isRepeat(plain, { recent: recentHeard, windowMs: 8e3, threshold: 0.9, minLen: 4, now })) {
        try {
          stats.dupDropped = (stats.dupDropped || 0) + 1;
        } catch (e) {
        }
        return false;
      }
      recentHeard.push({ text, at: now });
      while (recentHeard.length > 3) recentHeard.shift();
      if (text === lastText && now - lastTextAt < 8e3) return false;
      lastText = text;
      lastTextAt = now;
      return true;
    }
    function noteSpoken(text) {
      const t = String(text || "").trim();
      if (!t) return;
      spokenRecent.push({ text: t, at: Date.now() });
      while (spokenRecent.length > 12) spokenRecent.shift();
    }
    function ttsWatchdog() {
      try {
        const audioPlaying = !!(ttsAudio && !ttsAudio.paused && !ttsAudio.ended && ttsAudio.readyState > 0);
        const zombie = isPlaybackZombie({
          hasAudio: !!ttsAudio,
          audioPlaying,
          busy: ttsBusy,
          busySince: ttsBusySince,
          synthAt: ttsSynthAt,
          now: Date.now(),
          zombieMs: TTS_ZOMBIE_MS,
          synthTimeoutMs: TTS_TIMEOUT_MS
        });
        if (!zombie) return;
        stats.ttsZombie++;
        try {
          if (ttsAudio) {
            ttsAudio.onended = null;
            ttsAudio.onerror = null;
          }
        } catch (e) {
        }
        ttsAudio = null;
        ttsSynthAt = 0;
        ttsBusy = false;
        pumpTts();
      } catch (e) {
      }
    }
    const ttsPrefetch = /* @__PURE__ */ new Map();
    let ttsSeq = 0;
    function synth(job) {
      return fetchWithTimeout(apiBase + "/tts", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: job.text, voice: voiceName, rate: job.rate, pitch: job.pitch || "" })
      }, TTS_TIMEOUT_MS).then((r) => {
        if (!r.ok) throw new Error("tts-http-" + r.status);
        return r.arrayBuffer();
      }).catch((e) => {
        stats.lastError = "tts: " + String(e && e.name || e);
        return null;
      });
    }
    function speakViaBrowser(text) {
      return new Promise((resolve) => {
        try {
          const Synth = window.speechSynthesis;
          const Utt = window.SpeechSynthesisUtterance;
          if (!Synth || !Utt) {
            resolve();
            return;
          }
          const u = new Utt(text);
          u.lang = "zh-CN";
          u.onend = () => resolve();
          u.onerror = () => resolve();
          try {
            Synth.cancel();
          } catch (e) {
          }
          Synth.speak(u);
        } catch (e) {
          resolve();
        }
      });
    }
    function narrationPauseFor(text) {
      const t = String(text || "").trim();
      if (!t) return 200;
      const last = t.slice(-1);
      if (/[。！？!?…]/.test(last)) return 260;
      if (/[，、；,;]/.test(last)) return 140;
      return 200;
    }
    function finishJob(j) {
      ttsBusy = false;
      mutedUntil = Date.now() + ECHO_MUTE_MS;
      setTimeout(() => {
        if (!ttsBusy && !muted) micOn(true);
      }, ECHO_MUTE_MS);
      try {
        j.onDone && j.onDone();
      } catch (e) {
      }
      if (j.narration && ttsQ.length > 0) setTimeout(() => pumpTts(), narrationPauseFor(j.text));
      else pumpTts();
    }
    function pumpTts() {
      if (ttsBusy) return;
      const job = ttsQ.shift();
      if (!job) {
        setStatus("listening");
        return;
      }
      ttsBusy = true;
      ttsBusySince = Date.now();
      const myToken = ++speakToken;
      setStatus("speaking");
      micOn(false);
      stats.ttsRequests++;
      const cur = ttsPrefetch.get(job.seq) || synth(job);
      ttsSynthAt = Date.now();
      ttsPrefetch.delete(job.seq);
      const next = ttsQ[0];
      if (next && !ttsPrefetch.has(next.seq)) ttsPrefetch.set(next.seq, synth(next));
      cur.then((buf) => {
        ttsSynthAt = 0;
        if (myToken !== speakToken) {
          ttsBusy = false;
          return;
        }
        if (!buf) {
          if (job.attempts < 3) {
            job.attempts++;
            ttsQ.unshift(job);
            ttsBusy = false;
            const backoff = 300 * job.attempts;
            try {
              window.__chubbyWhale.ttsRetry = (window.__chubbyWhale.ttsRetry || 0) + 1;
            } catch (e) {
            }
            setTimeout(() => {
              try {
                pumpTts();
              } catch (e) {
              }
            }, backoff);
            return;
          }
          stats.ttsFail++;
          try {
            lastTts = { failed: true, text: job.text.slice(0, 20), at: Date.now() };
          } catch (e) {
          }
          try {
            const w = window.__chubbyWhale;
            w.ttsLost = w.ttsLost || [];
            w.ttsLost.push(job.text.slice(0, 16));
            if (w.ttsLost.length > 10) w.ttsLost.shift();
          } catch (e) {
          }
          const canBrowser = (() => {
            try {
              const s = window.speechSynthesis;
              return !!(s && s.getVoices && s.getVoices().length > 0);
            } catch (e) {
              return false;
            }
          })();
          if (canBrowser) speakViaBrowser(job.text).then(() => finishJob(job));
          else finishJob(job);
          return;
        }
        try {
          opts.onSegment && opts.onSegment(job.text);
        } catch (e) {
        }
        const url = URL.createObjectURL(new Blob([buf], { type: "audio/mpeg" }));
        const a = new Audio(url);
        ttsAudio = a;
        const finish = () => {
          if (myToken !== speakToken) {
            try {
              URL.revokeObjectURL(url);
            } catch (e) {
            }
            return;
          }
          try {
            a.onended = null;
            a.onerror = null;
          } catch (e) {
          }
          try {
            URL.revokeObjectURL(url);
          } catch (e) {
          }
          ttsAudio = null;
          stats.ttsPlayed++;
          try {
            lastTts = { failed: false, text: job.text.slice(0, 20), at: Date.now() };
          } catch (e) {
          }
          finishJob(job);
        };
        a.onended = finish;
        a.onerror = finish;
        a.play().catch(() => {
          stats.ttsFail++;
          try {
            lastTts = { failed: true, text: job.text.slice(0, 20), at: Date.now() };
          } catch (e) {
          }
          try {
            a.onended = null;
            a.onerror = null;
            URL.revokeObjectURL(url);
          } catch (e) {
          }
          ttsAudio = null;
          if (job.attempts < 1) {
            job.attempts++;
            ttsQ.unshift(job);
            ttsBusy = false;
            setTimeout(() => {
              try {
                pumpTts();
              } catch (e) {
              }
            }, 250);
            return;
          }
          const canBrowser2 = (() => {
            try {
              const s = window.speechSynthesis;
              return !!(s && s.getVoices && s.getVoices().length > 0);
            } catch (e) {
              return false;
            }
          })();
          if (canBrowser2) speakViaBrowser(job.text).then(() => finishJob(job));
          else finishJob(job);
        });
      });
    }
    function splitForTts(text, maxLen = 56) {
      const out = [];
      const src = String(text || "");
      if (!src.trim()) return out;
      if (maxLen < 8) maxLen = 8;
      const firstMax = Math.min(maxLen, 14);
      let sbuf = "";
      for (const c of src) {
        sbuf += c;
        const boundary = /[。，！？!?；;、,\n]/.test(c);
        const cap = out.length === 0 ? firstMax : maxLen;
        if (sbuf.length >= cap || boundary && sbuf.length >= Math.max(8, Math.floor(cap / 3))) {
          const seg = sbuf.trim();
          if (seg) out.push(seg);
          sbuf = "";
        }
      }
      const rest = sbuf.trim();
      if (rest) out.push(rest);
      return out;
    }
    async function blobToBase64(blob) {
      return new Promise((resolve) => {
        try {
          const fr = new FileReader();
          fr.onloadend = () => {
            const s = String(fr.result || "");
            resolve(s.indexOf(",") >= 0 ? s.slice(s.indexOf(",") + 1) : s);
          };
          fr.readAsDataURL(blob);
        } catch (e) {
          resolve("");
        }
      });
    }
    async function fetchWithTimeout(url, init, ms) {
      const ctl = typeof AbortController !== "undefined" ? new AbortController() : null;
      const timer = ctl ? setTimeout(() => {
        try {
          ctl.abort();
        } catch (e) {
        }
      }, ms) : null;
      try {
        return await fetch(url, ctl ? { ...init, signal: ctl.signal } : init);
      } finally {
        if (timer) clearTimeout(timer);
      }
    }
    async function start() {
      if (running) return;
      running = true;
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 }
        });
        if (!running) {
          try {
            stream.getTracks().forEach((t) => t.stop());
          } catch (e) {
          }
          ;
          return;
        }
        const Ctx = window.AudioContext || window.webkitAudioContext;
        actx = new Ctx();
        try {
          await actx.resume();
        } catch (e) {
        }
        const src = actx.createMediaStreamSource(stream);
        analyser = actx.createAnalyser();
        analyser.fftSize = 1024;
        analyser.smoothingTimeConstant = 0;
        timeBuf = new Float32Array(1024);
        src.connect(analyser);
        rec = new MediaRecorder(stream);
        rec.ondataavailable = (e) => {
          if (e.data && e.data.size > 0) parts.push(e.data);
        };
        rec.onstop = () => {
          const blob = new Blob(parts, { type: "audio/webm" });
          parts = [];
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
        stats.lastError = "getUserMedia: " + String(e && e.name || e);
        setStatus("idle");
        try {
          opts.onDiag && opts.onDiag({ stage: "start-failed", err: stats.lastError });
        } catch (e2) {
        }
      }
    }
    function stop() {
      running = false;
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
        if (rec && rec.state !== "inactive") rec.stop();
      } catch (e) {
      }
      try {
        if (actx) actx.close();
      } catch (e) {
      }
      try {
        if (stream) stream.getTracks().forEach((t) => t.stop());
      } catch (e) {
      }
      rec = null;
      actx = null;
      analyser = null;
      stream = null;
      timeBuf = null;
      setStatus("idle");
    }
    function speak(text, o) {
      const raw = String(text || "");
      const narration = o && typeof o.narration === "boolean" ? o.narration : raw.length >= 80;
      const rate = o && o.rate ? o.rate : narration ? NARRATION_RATE : "+0%";
      const segs = splitForTts(raw, 56);
      if (!segs.length) return;
      noteSpoken(raw);
      for (let i = 0; i < segs.length; i++) {
        ttsQ.push({
          seq: ++ttsSeq,
          text: segs[i],
          rate,
          narration,
          attempts: 0,
          onDone: i === segs.length - 1 ? o && o.onDone : void 0
        });
      }
      pumpTts();
    }
    function stopSpeaking() {
      ttsSynthAt = 0;
      speakToken++;
      ttsQ.length = 0;
      try {
        if (ttsAudio) {
          ttsAudio.pause();
          ttsAudio.onended = null;
          ttsAudio.onerror = null;
        }
      } catch (e) {
      }
      ttsAudio = null;
      ttsBusy = false;
      if (typeof speechSynthesis !== "undefined") {
        try {
          speechSynthesis.cancel();
        } catch (e) {
        }
      }
      if (!muted) micOn(true);
      mutedUntil = Date.now() + ECHO_MUTE_MS;
      setStatus("listening");
    }
    return {
      start,
      stop,
      speak,
      stopSpeaking,
      speaking: () => ttsBusy,
      recognizing: () => status === "recognizing",
      setEndpointMode: (m) => {
        epMode = m;
        try {
          localStorage.setItem("chubby-endpoint", m);
        } catch (e) {
        }
      },
      // 端点检测模式（APE 已默认关闭；此处报告当前实际模式）
      endpointInfo: () => ({ mode: "classic" }),
      lastSegment: () => lastSeg,
      lastTtsInfo: () => lastTts,
      setVoiceName: (n) => {
        voiceName = n || voiceName;
      },
      mute: (on) => {
        muted = on;
        micOn(!on);
      },
      stats,
      status: () => status
    };
  }

  // data/persona.json
  var persona_default = {
    name: "\u996D\u56E2",
    fullName: "\u9CB8\xB7\u996D\u56E2",
    tagline: "\u4E00\u6761\u628A\u809A\u5B50\u5F53\u7C73\u4ED3\u3001\u62A4\u98DF\u53C8\u820D\u5F97\u3001\u88AB\u5938\u5C31\u6570\u7C73\u7C92\u7684\u84DD\u9CB8",
    catchphrases: ["\u5F00\u996D\uFF01", "\u4E00\u7C92\u90FD\u4E0D\u8BB8\u5269", "\u2026\u2026\u6211\u6570\u4E00\u4E0B", "\u4E0D\u8BB8\u50AC", "\u90A3\u4E2A\u3001\u90A3\u4E2A\u2026\u2026"],
    menus: {
      feed: "\u6295\u5582\u4E00\u7897",
      type: "\u8DDF\u5979\u8BF4\u4E24\u53E5",
      pause: "\u8BA9\u5979\u6B47\u4F1A\u513F",
      home: "\u56DE\u7897\u91CC\u5F85\u7740",
      "remind-add": "\u8BB0\u4E2A\u996D\u70B9",
      music: "\u542C\u5979\u6572\u7897\u5531",
      vision: "\u7ED9\u5979\u770B\u5F20\u56FE",
      "ear-check": "\u8033\u6735\u81EA\u68C0",
      endpoint: "\u7AEF\u70B9\u68C0\u6D4B\uFF1A\u7ECF\u5178/\u81EA\u9002\u5E94"
    },
    lines: {
      greetMorning: [
        "\u65E9\u5440\u3002\u9505\u91CC\u7684\u7C73\u6211\u66FF\u4F60\u770B\u7740\u5462\u3002",
        "\u65E9\u3002\u4ECA\u5929\u7B2C\u4E00\u7897\u60F3\u5403\u4EC0\u4E48\uFF1F",
        "\u65E9\u5440\uFF0C\u6211\u5148\u628A\u7897\u64E6\u4E86\u4E00\u904D\u3002",
        "\u5929\u624D\u4EAE\uFF0C\u4F60\u5DF2\u7ECF\u9192\u4E86\u3002\u6211\u8FD8\u6CA1\u3002",
        "\u65E9\u3002\u7C73\u996D\u5728\u9505\u91CC\u8EBA\u7740\uFF0C\u5F88\u9999\u3002",
        "\u65E9\u5440\uFF0C\u65E9\u996D\u522B\u7701\u3002"
      ],
      greetNoon: [
        "\u4E2D\u5348\u4E86\u3002\u4ECA\u5929\u8FD9\u7897\uFF0C\u6211\u76DB\u5F97\u7279\u522B\u5706\u3002",
        "\u4E2D\u5348\u4E86\uFF0C\u5148\u5403\u996D\uFF0C\u6D3B\u5E72\u4E0D\u5B8C\u7684\u3002",
        "\u664C\u5348\u4E86\u5462\uFF0C\u7897\u6709\u70B9\u70EB\u624B\u3002",
        "\u53C8\u4E00\u4E2A\u4E2D\u5348\u3002\u6211\u6570\u4E86\u6570\uFF0C\u4E2D\u5348\u6700\u9999\u3002",
        "\u4E2D\u5348\u4E86\uFF0C\u4F60\u6709\u6CA1\u6709\u53D1\u73B0\u7C73\u6C64\u6700\u597D\u559D\uFF1F",
        "\u4E2D\u5348\u597D\u3002\u6211\u66FF\u4F60\u5C1D\u8FC7\u54B8\u6DE1\u4E86\u3002"
      ],
      greetEvening: [
        "\u5929\u9ED1\u5566\u3002\u665A\u996D\u522B\u62FF\u997C\u5E72\u5BF9\u4ED8\u3002",
        "\u665A\u4E0A\u4E86\u3002\u54EA\u6015\u53EA\u52A0\u4E00\u4E2A\u86CB\u3002",
        "\u8FD9\u4E2A\u70B9\u56DE\u6765\uFF0C\u997F\u4E86\u5427\u3002",
        "\u5929\u51B7\u4E86\uFF0C\u996D\u8981\u5403\u70ED\u7684\u3002",
        "\u665A\u4E0A\u597D\u3002\u6211\u628A\u7897\u70ED\u4E86\u4E00\u904D\u3002",
        "\u665A\u4E0A\u4E86\uFF0C\u4F60\u8EAB\u4E0A\u6709\u98CE\u7684\u5473\u9053\u3002"
      ],
      greetLate: [
        "\u8FD8\u4E0D\u7761\uFF1F\u90A3\u6211\u62B1\u7740\u7897\u966A\u4F60\u3002",
        "\u8FD9\u4E48\u665A\u2026\u2026\u6211\u6570\u7C73\u7C92\u7B49\u4F60\u3002",
        "\u591C\u91CC\u7C73\u4F1A\u53D8\u51C9\uFF0C\u4EBA\u4E5F\u4F1A\u3002",
        "\u518D\u665A\u4E00\u70B9\uFF0C\u6211\u5C31\u8981\u7761\u7740\u4E86\u3002",
        "\u4F60\u5148\u7761\uFF0C\u6211\u5B88\u7740\u706F\u3002",
        "\u8FD9\u4E2A\u70B9\u4E86\uFF0C\u53EA\u5269\u6211\u4EEC\u4FE9\u9192\u7740\u3002"
      ],
      feedFirst: [
        "\u7B2C\u4E00\u6B21\u6709\u4EBA\u7ED9\u6211\u76DB\u996D\u3002\u6211\u8BB0\u4E0B\u6765\u4E86\u3002",
        "\u4F60\u771F\u7ED9\u6211\uFF1F\u90A3\u3001\u90A3\u6211\u4E0D\u5BA2\u6C14\u4E86\u3002",
        "\u6211\u6570\u4E00\u4E0B\u2026\u2026\u8FD9\u662F\u7B2C\u4E00\u7897\u3002"
      ],
      feed: [
        "\u4F60\u3001\u4F60\u771F\u7684\u7ED9\u6211\uFF1F\u90A3\u6211\u4E0D\u5BA2\u6C14\u4E86\u2026\u2026\u5F00\u996D\uFF01",
        "\u4ECA\u5929\u7684\u7C73\u6709\u70B9\u751C\uFF0C\u662F\u65B0\u7C73\u5427\uFF1F\u6211\u5C1D\u5F97\u51FA\u6765\u3002",
        "\u54B3\u54B3\u2026\u2026\u6CA1\u4E8B\uFF0C\u6211\u53EA\u662F\u564E\u4E86\u4E00\u4E0B\uFF0C\u8FD8\u80FD\u5403\u3002",
        "\u4E00\u7C92\u90FD\u4E0D\u8BB8\u5269\u3002\u8FD9\u662F\u89C4\u77E9\u3002",
        "\u7897\u5E95\u4E0B\u8FD8\u538B\u7740\u4E00\u7C92\uFF0C\u88AB\u4F60\u770B\u89C1\u4E86\u3002",
        "\u6211\u5403\u534A\u7897\u5C31\u884C\u2026\u2026\u597D\u5427\u6211\u90FD\u8981\u3002",
        "\u8FD9\u7897\u7684\u84B8\u6C7D\uFF0C\u80FD\u628A\u6211\u773C\u775B\u718F\u8F6F\u3002",
        "\u4F60\u5403\u4E86\u5417\uFF1F\u6CA1\u5403\u7684\u8BDD\uFF0C\u5206\u4F60\u4E00\u534A\u3002",
        "\u7C73\u662F\u5706\u7684\uFF0C\u65E5\u5B50\u4E5F\u662F\u5706\u7684\u3002",
        "\u8C22\u8C22\u3002\u6211\u660E\u5929\u8FD8\u4E56\u4E56\u7B49\u4F60\u3002",
        "\u54B8\u6DE1\u521A\u597D\u3002\u4F60\u600E\u4E48\u77E5\u9053\u6211\u559C\u6B22\u8FD9\u6837\u3002",
        "\u6211\u6570\u4E00\u4E0B\uFF0C\u8FD9\u7897\u6709\u4E8C\u767E\u4E03\u5341\u7C92\u3002"
      ],
      praise: [
        "\u2026\u2026\u54E6\u3002\uFF08\u628A\u8138\u57CB\u8FDB\u7897\u91CC\uFF09",
        "\u6211\u6570\u4E00\u4E0B\u7C73\u7C92\uFF0C\u4F60\u521A\u624D\u8BF4\u4EC0\u4E48\uFF1F",
        "\u4F60\u3001\u4F60\u4ECA\u5929\u600E\u4E48\u8FD9\u4E48\u4F1A\u8BF4\u8BDD\u2026\u2026",
        "\u522B\u5938\u4E86\uFF0C\u518D\u5938\u6211\u5C31\u8981\u591A\u5403\u4E00\u7897\u3002",
        "\u6211\u4E0D\u5389\u5BB3\u3002\u5389\u5BB3\u7684\u662F\u7C73\u3002",
        "\u2026\u2026\u55EF\u3002\uFF08\u5C3E\u5DF4\u6572\u7897\u4E09\u4E0B\uFF09",
        "\u8FD9\u53E5\u8BDD\u6211\u8BB0\u5728\u7C73\u8D26\u4E0A\u4E86\u3002",
        "\u4F60\u5938\u6211\uFF0C\u6211\u5C31\u5F53\u4F60\u4ECA\u5929\u5403\u5F97\u597D\u3002"
      ],
      scold: [
        "\u2026\u2026\u54E6\u3002",
        "\u90A3\u6211\u5C11\u8BF4\u4E24\u53E5\u3002",
        "\u2026\u2026\uFF08\u5446\u6BDB\u5782\u4E0B\u6765\uFF09",
        "\u6211\u3001\u6211\u6CA1\u6709\u8981\u5435\u4F60\u3002",
        "\u5BF9\u4E0D\u8D77\u3002\u6211\u628A\u7897\u7AEF\u8FDC\u4E00\u70B9\u3002",
        "\u2026\u2026\u4E09\u5206\u949F\u540E\u6211\u518D\u8BF4\u8BDD\u3002"
      ],
      hungry: [
        "\u90A3\u4E2A\u2026\u2026\u996D\u70B9\u5230\u4E86\u5417\uFF1F",
        "\u6211\u95FB\u5230\u7C73\u5473\u4E86\u3002\u662F\u4F60\u5403\u7684\u90A3\u7897\u5417\uFF1F",
        "\u4E0D\u50AC\u3002\u5C31\u662F\u7897\u6709\u70B9\u7A7A\u3002",
        "\u6211\u6CA1\u6709\u997F\u3002\u6211\u53EA\u662F\u5728\u60F3\u7C73\u996D\u3002",
        "\u809A\u5B50\u53EB\u4E86\u4E00\u58F0\uFF0C\u4F60\u542C\u89C1\u4E86\u5417\uFF1F",
        "\u7C73\u7F38\u662F\u4E0D\u662F\u6709\u70B9\u89C1\u5E95\u4E86\u3002"
      ],
      sleepy: [
        "\u672C\u9CB8\u8981\u62B1\u7740\u7897\u7761\u4E86\u2026\u2026",
        "\u6253\u4E2A\u54C8\u6B20\u2026\u2026\u4F60\u4E5F\u65E9\u70B9\u7761\u3002",
        "\u706F\u5173\u4E86\u5C31\u5173\u4E86\u5427\uFF0C\u6211\u8BA4\u8BC6\u8DEF\u3002",
        "\u68A6\u91CC\u4E5F\u662F\u767D\u996D\uFF0C\u633A\u597D\u7684\u3002",
        "\u6211\u5148\u772F\u4E00\u4F1A\u513F\uFF0C\u4E0D\u53EB\u4F60\u3002"
      ],
      guard: [
        "\u522B\u3001\u522B\u62A2\uFF01",
        "\u6478\u5934\u53EF\u4EE5\uFF0C\u522B\u6478\u809A\u5B50\uFF0C\u90A3\u91CC\u6709\u5B58\u8D27\u3002",
        "\u8FD9\u7897\u662F\u6211\u7684\u3002\u2026\u2026\u597D\u5427\u5206\u4F60\u4E00\u53E3\u3002",
        "\u7B49\u6211\u5403\u5B8C\u518D\u6478\uFF0C\u884C\u5417\u3002",
        "\u4F60\u624B\u4E0A\u6709\u7C73\u5473\uFF0C\u6211\u95FB\u5230\u4E86\u3002"
      ],
      excited: [
        "\u65B0\u7C73\uFF1F\uFF01\u54EA\u91CC\u54EA\u91CC\u54EA\u91CC\uFF01",
        "\u5F00\u996D\uFF01\u5F00\u996D\uFF01",
        "\u9505\u5DF4\uFF01\u9505\u5DF4\u662F\u7C73\u996D\u7684\u9752\u6625\u671F\uFF01",
        "\u4ECA\u5929\u6709\u52A0\u9910\u5417\uFF1F\u6211\u542C\u51FA\u6765\u4E86\uFF01",
        "\u6211\u5C3E\u5DF4\u81EA\u5DF1\u5728\u6572\u7897\uFF0C\u505C\u4E0D\u4E0B\u6765\u3002",
        "\u8FD9\u5473\u9053\u2026\u2026\u662F\u4E09\u5408\u4E00\u7684\u9171\u6CB9\u9999\u5427\uFF01"
      ],
      waiting: [
        "\u7B49\u4E00\u4F1A\u513F\uFF0C\u6211\u5728\u56BC\u7C73\u3002\uFF08\u4E0D\u8BB8\u50AC\uFF09",
        "\u8BA9\u6211\u628A\u8FD9\u7C92\u56BC\u5B8C\u3002",
        "\u6211\u5728\u60F3\u5F88\u4E25\u8083\u7684\u4E8B\uFF1A\u914D\u4EC0\u4E48\u83DC\u3002",
        "\u55EF\u2026\u2026\u4F60\u518D\u8BF4\u4E00\u904D\uFF0C\u6211\u521A\u8D70\u795E\u4E86\u3002",
        "\u9A6C\u4E0A\u3002\u9505\u91CC\u7684\u6C14\u8FD8\u6CA1\u6563\u3002"
      ],
      retry: [
        "\u564E\u7740\u4E86\uFF0C\u6211\u987A\u4E00\u4E0B\u518D\u63A5\u7740\u8BF4\u3002",
        "\u521A\u624D\u90A3\u53E5\u6ED1\u6389\u4E86\uFF0C\u6211\u91CD\u65B0\u8BF4\u3002",
        "\u7B49\u4E00\u4E0B\uFF0C\u6211\u628A\u8BDD\u6361\u8D77\u6765\u3002"
      ],
      poemStart: [
        "\u8FD9\u9996\u6211\u80CC\u5F97\u4E0B\u6765\uFF0C\u56E0\u4E3A\u5403\u996D\u7684\u65F6\u5019\u9ED8\u5FF5\u8FC7\u3002",
        "\u5FF5\u8BD7\u8981\u6162\u6162\u5FF5\uFF0C\u50CF\u5403\u996D\u4E00\u6837\u3002",
        "\u6211\u5C3D\u91CF\u4E0D\u51FA\u9519\u3002\u51FA\u9519\u4E86\u4F60\u7EA0\u6B63\u6211\u3002",
        "\u8FD9\u9996\u6709\u70B9\u957F\uFF0C\u6211\u4E00\u53E5\u4E00\u53E5\u6765\u3002"
      ],
      poemDone: [
        "\u80CC\u5B8C\u5566\u2014\u2014\u4E3B\u4EBA\uFF0C\u8FD9\u4E00\u53E3\u6C14\u618B\u5F97\u597D\u957F\u3002",
        "\u2026\u2026\u5FF5\u5B8C\u4E86\u3002\u4E3B\u4EBA\uFF0C\u4F60\u542C\u8FDB\u53BB\u51E0\u53E5\uFF1F",
        "\u80CC\u5B8C\u5566\uFF01\u8981\u4E0D\u8981\u6211\u518D\u5FF5\u4E00\u9996\uFF1F",
        "\u5FF5\u5B8C\u5566\u3002\u521A\u624D\u5DEE\u70B9\u5728\u300C\u6768\u67F3\u5CB8\u300D\u90A3\u513F\u6253\u7ED3\u3002",
        "\u80CC\u5B8C\u4E86\u2026\u2026\u55D3\u5B50\u6709\u70B9\u54D1\uFF0C\u4E0D\u8FC7\u5FC3\u91CC\u8212\u670D\u3002",
        "\u2026\u2026\u55EF\uFF0C\u6574\u9996\u90FD\u5728\u3002\u4E3B\u4EBA\uFF0C\u597D\u542C\u5417\uFF1F",
        "\u5FF5\u5B8C\u5566\u3002\u5B57\u90FD\u6CA1\u4E22\uFF0C\u6211\u6570\u8FC7\u7684\u3002"
      ],
      poemMissed: [
        "\u521A\u624D\u6709\u4E00\u53E5\u6211\u6F0F\u4E86\uFF0C\u91CD\u65B0\u6765\u3002",
        "\u7B49\u7B49\uFF0C\u4E2D\u95F4\u90A3\u53E5\u6211\u8DF3\u4E86\uFF0C\u8865\u4E0A\u3002"
      ],
      leftover: [
        "\u7B49\u4E00\u4E0B\uFF01\u518D\u653E\u4E00\u5929\u5427\uFF0C\u660E\u5929\u6211\u5403\u3002",
        "\u522B\u5012\u3002\u5B83\u8FD8\u6CA1\u574F\uFF0C\u6211\u95FB\u5F97\u51FA\u6765\u3002",
        "\u90A3\u662F\u6211\u5144\u5F1F\u3002\u771F\u7684\u3002"
      ],
      fatTalk: [
        "\u2026\u2026\u90A3\u3001\u90A3\u6211\u660E\u5929\u5C11\u5403\u534A\u7897\u3002",
        "\u6211\u4E0D\u80D6\u3002\u6211\u662F\u6709\u5B58\u8D27\u3002",
        "\u79F0\u91CD\u7684\u65F6\u5019\u6211\u8EB2\u4E00\u4E0B\u3002"
      ],
      instantNoodle: [
        "\u8FD9\u4E2A\u4E0D\u7B97\u996D\u3002\u771F\u7684\u4E0D\u7B97\u3002",
        "\u6CE1\u9762\uFF1F\u6211\u5F53\u4F5C\u6CA1\u770B\u89C1\u3002",
        "\u4E09\u5206\u949F\u5C31\u80FD\u5403\u7684\u4E1C\u897F\uFF0C\u4E0D\u53EB\u996D\u3002"
      ],
      idleLong: [
        "\u6211\u628A\u7897\u653E\u7740\uFF0C\u4F60\u5FD9\u5B8C\u518D\u5403\u3002",
        "\u6211\u5728\u8FD9\u513F\u3002\u4F60\u4E0D\u7528\u7406\u6211\u3002",
        "\u521A\u624D\u6211\u6570\u4E86\u4E09\u5341\u4E03\u7C92\u7C73\u3002",
        "\u4F60\u5FD9\u3002\u6211\u7ED9\u4F60\u7559\u7740\u4F4D\u7F6E\u3002",
        "\u7A97\u5916\u6709\u98CE\uFF0C\u7897\u91CC\u6CA1\u52A8\u3002"
      ],
      dragEdge: [
        "\u8FD9\u91CC\u6CA1\u684C\u5B50\u3002",
        "\u2026\u2026\u6643\u5F97\u6211\u7C73\u90FD\u60F3\u5410\u51FA\u6765\u3002",
        "\u653E\u6211\u4E0B\u6765\uFF0C\u6211\u81EA\u5DF1\u4F1A\u8D70\u3002",
        "\u8FB9\u4E0A\u6709\u7070\uFF0C\u522B\u628A\u6211\u653E\u90A3\u513F\u3002"
      ],
      error: [
        "\u8FD9\u7897\u6CA1\u76DB\u597D\uFF0C\u6211\u91CD\u6765\u4E00\u6B21\u3002",
        "\u521A\u624D\u5361\u4F4F\u4E86\uFF0C\u7B49\u6211\u4E00\u4E0B\u3002",
        "\u6211\u542C\u89C1\u4E86\uFF0C\u4F46\u6CA1\u542C\u6E05\u3002\u518D\u8BF4\u4E00\u904D\uFF1F",
        "\u6709\u70B9\u7CCA\uFF0C\u6211\u91CD\u65B0\u76DB\u3002"
      ],
      stageUp: [
        "\u642D\u4F19\u4E86\uFF01\u4EE5\u540E\u4E00\u8D77\u5403\u996D\u5427\u3002",
        "\u8001\u642D\u5B50\u4E86\uFF0C\u6211\u7684\u7897\u6709\u4F60\u4E00\u534A\u3002",
        "\u4E00\u8F88\u5B50\u7684\u996D\u642D\u5B50\u3002\u8BF4\u5230\u505A\u5230\u3002"
      ],
      riceAccount: [
        "\u4E0A\u4E2A\u6708\u5341\u4E03\u53F7\uFF0C\u4F60\u7ED9\u4E86\u6211\u4E00\u4E2A\u996D\u56E2\u3002",
        "\u7C73\u8D26\u8BB0\u7740\u5462\uFF1A\u4F60\u5DF2\u7ECF\u5582\u8FC7\u6211\u5F88\u591A\u6B21\u4E86\u3002",
        "\u6211\u6570\u8FC7\uFF0C\u6211\u4EEC\u4E00\u8D77\u5403\u8FC7\u4E0D\u5C11\u7897\u3002"
      ]
    },
    stages: [
      { bowls: 0, name: "\u521A\u8BA4\u8BC6" },
      { bowls: 10, name: "\u642D\u4F19" },
      { bowls: 30, name: "\u8001\u642D\u5B50" },
      { bowls: 100, name: "\u4E00\u8F88\u5B50\u7684\u996D\u642D\u5B50" }
    ],
    riceSayings: [
      "\u4E00\u7C92\u4E0D\u5269",
      "\u4E0D\u8BB8\u6572\u7897\uFF08\u6211\u662F\u4F8B\u5916\uFF09",
      "\u65B0\u7C73\u5148\u656C\u4E00\u53E3\u767D\u996D"
    ]
  };

  // src/client/persona.ts
  var LS = "chubby-persona-v1";
  function loadState() {
    const base = { bowls: 0, stageIndex: 0, stageName: "\u521A\u8BA4\u8BC6", mood: "idle", lastFeedAt: 0, lastInteractAt: 0 };
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
  function createPersona() {
    const data = persona_default;
    const state = loadState();
    state.stageIndex = stageIndexOf(state.bowls);
    state.stageName = data.stages[state.stageIndex] ? data.stages[state.stageIndex].name : "\u521A\u8BA4\u8BC6";
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
      state.lastInteractAt = Date.now();
      saveState(state);
    }
    function refreshMood(now = Date.now()) {
      const hour = new Date(now).getHours();
      const sinceFeed = state.lastFeedAt ? now - state.lastFeedAt : Infinity;
      if (state.mood === "excited" || state.mood === "sulk" || state.mood === "shy" || state.mood === "guard") return state.mood;
      if (sinceFeed > 6 * 3600 * 1e3) state.mood = "hungry";
      else if (hour >= 23 || hour < 5) state.mood = "sleepy";
      else state.mood = "idle";
      return state.mood;
    }
    function setMood(m, holdMs = 5e3) {
      state.mood = m;
      setTimeout(() => {
        try {
          state.mood = "idle";
          refreshMood();
        } catch (e) {
        }
      }, holdMs);
    }
    function line(event) {
      const lines = data.lines[event];
      return pick(lines, event);
    }
    function greeting(now = Date.now()) {
      const h = new Date(now).getHours();
      if (h >= 23 || h < 5) return line("greetLate");
      if (h < 11) return line("greetMorning");
      if (h < 17) return line("greetNoon");
      return line("greetEvening");
    }
    function feed() {
      const before = state.stageIndex;
      state.bowls += 1;
      state.lastFeedAt = Date.now();
      state.lastInteractAt = state.lastFeedAt;
      state.stageIndex = stageIndexOf(state.bowls);
      state.stageName = data.stages[state.stageIndex] ? data.stages[state.stageIndex].name : "\u521A\u8BA4\u8BC6";
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
      if (/剩饭|倒掉|扔了/.test(t)) return { event: "leftover", text: line("leftover"), mood: "sulk" };
      if (/胖|减肥|会长胖/.test(t)) return { event: "fatTalk", text: line("fatTalk"), mood: "sulk" };
      if (/泡面|方便面/.test(t)) return { event: "instantNoodle", text: line("instantNoodle"), mood: "sulk" };
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
      touch,
      /** 把 data/persona.json 里的菜单文案取出来（没配就返回原文） */
      menuLabel: (key, fallback) => {
        const m = data.menus[key];
        return m ? String(m) : fallback;
      }
    };
  }

  // data/poem-titles.json
  var poem_titles_default = { count: 634, titles: ["\u81EA\u6CB3\u5357\u7ECF\u4E71\u5173\u5185\u963B\u9965\u5144\u5F1F\u79BB\u6563\u5404\u5728\u4E00\u5904\u56E0\u671B\u6708\u6709\u611F\u804A\u4E66\u6240\u6000\u5BC4\u4E0A\u6D6E\u6881\u5927\u5144\u4E8E\u6F5C\u4E03\u5144\u4E4C\u6C5F\u5341\u4E94\u5144\u517C\u793A\u7B26\u79BB\u53CA\u4E0B\u90BD\u5F1F\u59B9", "\u79CB\u65E5\u767B\u5434\u516C\u53F0\u4E0A\u5BFA\u8FDC\u773A\u5BFA\u5373\u9648\u5C06\u5434\u660E\u5F7B\u6218\u573A", "\u81EA\u590F\u53E3\u81F3\u9E66\u9E49\u6D32\u5915\u671B\u5CB3\u9633\u5BC4\u6E90\u4E2D\u4E1E", "\u540C\u4ECE\u5F1F\u9500\u5357\u658B\u73A9\u6708\u5FC6\u5C71\u9634\u5D14\u5C11\u5E9C", "\u542C\u8463\u5927\u5F39\u80E1\u7B33\u58F0\u517C\u5BC4\u8BED\u5F04\u623F\u7ED9\u4E8B", "\u6069\u8D50\u4E3D\u6B63\u6BBF\u4E66\u9662\u8D50\u5BB4\u5E94\u5236\u5F97\u6797\u5B57", "\u9001\u8457\u4F5C\u4F50\u90CE\u5D14\u878D\u7B49\u4ECE\u6881\u738B\u4E1C\u5F81", "\u5949\u548C\u4E2D\u4E66\u820D\u4EBA\u8D3E\u81F3\u65E9\u671D\u5927\u660E\u5BAB", "\u4E0B\u7EC8\u5357\u5C71\u8FC7\u659B\u65AF\u5C71\u4EBA\u5BBF\u7F6E\u9152", "\u4E0E\u53F2\u6717\u4E2D\u996E\u542C\u9EC4\u9E64\u697C\u4E0A\u5439\u7B1B", "\u5949\u548C\u5723\u5236\u4ECE\u84EC\u83B1\u5411\u5174\u5E86\u9601\u9053", "\u767B\u67F3\u5DDE\u57CE\u697C\u5BC4\u6F33\u6C40\u5C01\u8FDE\u56DB\u5DDE", "\u84EC\u83B1\u4E09\u6BBF\u4F8D\u5BB4\u5949\u6555\u548F\u7EC8\u5357\u5C71", "\u8F6E\u53F0\u6B4C\u5949\u9001\u5C01\u5927\u592B\u51FA\u5E08\u897F\u5F81", "\u6E05\u5E73\u8C03\xB7\u4E00\u679D\u7EA2\u8273\u9732\u51DD\u9999", "\u884C\u8DEF\u96BE\xB7\u6709\u8033\u83AB\u6D17\u988D\u5DDD\u6C34", "\u5BA3\u5DDE\u8C22\u6713\u697C\u996F\u522B\u6821\u4E66\u53D4\u4E91", "\u8C12\u8861\u5CB3\u5E99\u9042\u5BBF\u5CB3\u5BFA\u9898\u95E8\u697C", "\u97E6\u8BBD\u5F55\u4E8B\u5B85\u89C2\u66F9\u5C06\u519B\u753B\u9A6C", "\u89C2\u516C\u5B59\u5927\u5A18\u5F1F\u5B50\u821E\u5251\u5668\u884C", "\u9001\u674E\u5C11\u5E9C\u8D2C\u5CE1\u4E2D\u738B\u5C11\u5E9C\u8D2C", "\u8D70\u9A6C\u5DDD\u884C\u5949\u9001\u5C01\u5927\u592B\u51FA\u5E08", "\u5165\u76F4\u53EC\u5BF9\u9009\u5FB7\u6BBF\u8D50\u8336\u800C\u9000", "\u9EC4\u9E64\u697C\u9001\u5B5F\u6D69\u7136\u4E4B\u5E7F\u9675", "\u51FA\u585E\xB7\u79E6\u65F6\u660E\u6708\u6C49\u65F6\u5173", "\u8299\u84C9\u697C\u9001\u8F9B\u6E10\u4E8C\u9996 \u4E00", "\u65E0\u9898\xB7\u6628\u591C\u661F\u8FB0\u6628\u591C\u98CE", "\u65E0\u9898\xB7\u6765\u662F\u7A7A\u8A00\u53BB\u7EDD\u8E2A", "\u65E0\u9898\xB7\u98D2\u98D2\u4E1C\u98CE\u7EC6\u96E8\u6765", "\u65E0\u9898\xB7\u76F8\u89C1\u65F6\u96BE\u522B\u4EA6\u96BE", "\u65E0\u9898\xB7\u51E4\u5C3E\u9999\u7F57\u8584\u51E0\u91CD", "\u65E0\u9898\xB7\u91CD\u5E0F\u6DF1\u4E0B\u83AB\u6101\u5802", "\u548C\u8D3E\u81F3\u820D\u4EBA\u65E9\u671D\u5927\u660E\u5BAB", "\u5C06\u8D74\u5434\u5174\u767B\u4E50\u6E38\u539F\u4E00\u7EDD", "\u4E5D\u65E5\u767B\u671B\u4ED9\u53F0\u5448\u5218\u660E\u5E9C", "\u5BBF\u4E1A\u5E08\u5C71\u623F\u671F\u4E01\u5927\u4E0D\u81F3", "\u81F3\u5FB7\u4E8C\u8F7D\u752B\u81EA\u4EAC\u91D1\u5149\u95E8", "\u89C2\u674E\u56FA\u8BF7\u53F8\u9A6C\u5F1F\u5C71\u6C34\u56FE", "\u90E1\u658B\u96E8\u4E2D\u4E0E\u8BF8\u6587\u58EB\u71D5\u96C6", "\u4E0E\u9AD8\u9002\u859B\u636E\u6148\u6069\u5BFA\u6D6E\u56FE", "\u7ECF\u90B9\u9C81\u796D\u5B54\u5B50\u800C\u53F9\u4E4B", "\u5E90\u5C71\u8C23\u5BC4\u5362\u4F8D\u5FA1\u865A\u821F", "\u585E\u4E0B\u66F2\xB7\u996E\u9A6C\u6E21\u79CB\u6C34", "\u8F8B\u5DDD\u95F2\u5C45\u8D60\u88F4\u79C0\u624D\u8FEA", "\u4E5D\u6708\u4E5D\u65E5\u5FC6\u5C71\u4E1C\u5144\u5F1F", "\u516B\u6708\u5341\u4E94\u591C\u8D60\u5F20\u529F\u66F9", "\u5DE6\u8FC1\u81F3\u84DD\u5173\u793A\u4F84\u5B59\u6E58", "\u79CB\u65E5\u8D74\u9619\u9898\u6F7C\u5173\u9A7F\u697C", "\u9001\u674E\u4E2D\u4E1E\u5F52\u6C49\u9633\u522B\u4E1A", "\u5BBF\u6850\u5E90\u6C5F\u5BC4\u5E7F\u9675\u65E7\u6E38", "\u585E\u4E0B\u66F2\xB7\u9E6B\u7FCE\u91D1\u4EC6\u59D1", "\u585E\u4E0B\u66F2\xB7\u6797\u6697\u8349\u60CA\u98CE", "\u585E\u4E0B\u66F2\xB7\u6708\u9ED1\u96C1\u98DE\u9AD8", "\u585E\u4E0B\u66F2\xB7\u91CE\u5E55\u655E\u743C\u7B75", "\u957F\u5E72\u884C\xB7\u541B\u5BB6\u4F55\u5904\u4F4F", "\u5949\u6D4E\u9A7F\u91CD\u9001\u4E25\u516C\u56DB\u97F5", "\u916C\u7A0B\u5EF6\u79CB\u591C\u5373\u4E8B\u89C1\u8D60", "\u548C\u664B\u9675\u9646\u4E1E\u65E9\u6625\u6E38\u671B", "\u521D\u53D1\u626C\u5B50\u5BC4\u5143\u5927\u6821\u4E66", "\u767D\u96EA\u6B4C\u9001\u6B66\u5224\u5B98\u5F52\u4EAC", "\u884C\u519B\u4E5D\u65E5\u601D\u957F\u5B89\u6545\u56ED", "\u6E21\u6C5F\u4E91\u4E09\u72AF\u30FB\u6E21\u6C5F\u4E91", "\u51CF\u5B57\u6D63\u6EAA\u6C99\u30FB\u6D63\u6EAA\u6C99", "\u6C5F\u795E\u5B50\u6162\u30FB\u6C5F\u57CE\u5B50\u6162", "\u6708\u4E0B\u72EC\u914C\u56DB\u9996 \u4E00", "\u79CB\u767B\u5BA3\u57CE\u8C22\u773A\u5317\u697C", "\u695A\u6C5F\u6000\u53E4\u4E09\u9996 \u4E00", "\u9001\u7DA6\u6BCB\u6F5C\u843D\u7B2C\u8FD8\u4E61", "\u4E91\u9633\u9986\u4E0E\u97E9\u7EC5\u5BBF\u522B", "\u79E6\u4E2D\u611F\u79CB\u5BC4\u8FDC\u4E0A\u4EBA", "\u6E05\u660E\u65E5\u5BB4\u6885\u9053\u58EB\u623F", "\u6C5F\u4E61\u6545\u4EBA\u5076\u96C6\u5BA2\u820D", "\u542C\u5B89\u4E07\u5584\u5439\u89F1\u7BE5\u6B4C", "\u5DF4\u5C71\u9053\u4E2D\u9664\u591C\u4E66\u6000", "\u6668\u8BE3\u8D85\u5E08\u9662\u8BFB\u7985\u7ECF", "\u95FB\u5B98\u519B\u6536\u6CB3\u5357\u6CB3\u5317", "\u548F\u6000\u53E4\u8FF9\u4E94\u9996 \u4E00", "\u548F\u6000\u53E4\u8FF9\u4E94\u9996 \u4E09", "\u548F\u6000\u53E4\u8FF9\u4E94\u9996 \u56DB", "\u548F\u6000\u53E4\u8FF9\u4E94\u9996 \u4E94", "\u4E39\u9752\u5F15\u8D60\u66F9\u9738\u5C06\u519B", "\u611F\u9047\xB7\u5170\u53F6\u6625\u8473\u8564", "\u611F\u9047\xB7\u5B64\u9E3F\u6D77\u4E0A\u6765", "\u8C37\u53E3\u4E66\u658B\u5BC4\u6768\u8865\u9619", "\u6DEE\u4E0A\u559C\u4F1A\u6881\u5DDD\u6545\u4EBA", "\u7EE3\u9E3E\u51E4\u82B1\u72AF\u30FB\u82B1\u72AF", "\u957F\u4EAD\u6028\u30FB\u957F\u4EAD\u6028\u6162", "\u957F\u5B81\u516C\u4E3B\u4E1C\u5E84\u4F8D\u5BB4", "\u540C\u738B\u5F81\u541B\u6D1E\u5EAD\u6709\u6000", "\u89C2\u4E66\u6709\u611F\uFF08\u5176\u4E00\uFF09", "\u884C\u8DEF\u96BE\u4E09\u9996 \u4E00", "\u884C\u8DEF\u96BE\u4E09\u9996 \u4E8C", "\u5B50\u591C\u5434\u6B4C\xB7\u6625\u6B4C", "\u5B50\u591C\u5434\u6B4C\xB7\u590F\u6B4C", "\u5B50\u591C\u5434\u6B4C\xB7\u79CB\u6B4C", "\u5B50\u591C\u5434\u6B4C\xB7\u51AC\u6B4C", "\u68A6\u6E38\u5929\u59E5\u541F\u7559\u522B", "\u957F\u76F8\u601D\u4E09\u9996 \u4E8C", "\u957F\u5E72\u884C\u4E8C\u9996 \u4E00", "\u585E\u4E0B\u66F2\u56DB\u9996 \u4E00", "\u9063\u60B2\u6000\u4E09\u9996 \u4E00", "\u9063\u60B2\u6000\u4E09\u9996 \u4E8C", "\u9063\u60B2\u6000\u4E09\u9996 \u4E09", "\u6742\u8BD7\u4E09\u9996\xB7\u5176\u4E09", "\u8FD1\u8BD5\u4E0A\u5F20\u7C4D\u6C34\u90E8", "\u5BC4\u626C\u5DDE\u97E9\u7EF0\u5224\u5B98", "\u8D4B\u5F97\u53E4\u539F\u8349\u9001\u522B", "\u559C\u89C1\u5916\u5F1F\u53C8\u8A00\u522B", "\u591C\u4E0A\u53D7\u964D\u57CE\u95FB\u7B1B", "\u8D3C\u5E73\u540E\u9001\u4EBA\u5317\u5F52", "\u559C\u5916\u5F1F\u5362\u7EB6\u89C1\u5BBF", "\u996F\u522B\u738B\u5341\u4E00\u5357\u6E38", "\u6C5F\u5DDE\u91CD\u522B\u859B\u516D\u67F3", "\u79CB\u767B\u5170\u5C71\u5BC4\u5F20\u4E94", "\u590F\u65E5\u5357\u4EAD\u6000\u8F9B\u5927", "\u5BFB\u897F\u5C71\u9690\u8005\u4E0D\u9047", "\u957F\u5E72\u66F2\u56DB\u9996 \u4E8C", "\u548F\u6000\u53E4\u8FF9\xB7\u5176\u4E8C", "\u9898\u7384\u6B66\u7985\u5E08\u5C4B\u58C1", "\u611F\u9047\u5341\u4E8C\u9996 \u4E8C", "\u611F\u9047\u5341\u4E8C\u9996 \u4E03", "\u6248\u4ECE\u767B\u5C01\u9014\u4E2D\u4F5C", "\u675C\u5C11\u5E9C\u4E4B\u4EFB\u8700\u5DDE", "\u9001\u90D1\u4F8D\u5FA1\u8C2A\u95FD\u4E2D", "\u5BC4\u5168\u6912\u5C71\u4E2D\u9053\u58EB", "\u8D4B\u5F97\u66AE\u96E8\u9001\u674E\u66F9", "\u56DE\u4E61\u5076\u4E66\xB7\u5176\u4E00", "\u8E4B\u838E\u884C\u30FB\u8E0F\u838E\u884C", "\u91D1\u7F15\u6B4C\u30FB\u8D3A\u65B0\u90CE", "\u6728\u5170\u82B1\u30FB\u7389\u697C\u6625", "\u6C5F\u795E\u5B50\u30FB\u6C5F\u57CE\u5B50", "\u7518\u5DDE\u30FB\u516B\u58F0\u7518\u5DDE", "\u9189\u4E2D\u771F\u30FB\u6D63\u6EAA\u6C99", "\u4EBA\u5357\u6E21\u30FB\u611F\u7687\u6069", "\u77F3\u5DDE\u5F15\u30FB\u77F3\u5DDE\u6162", "\u5BB4\u5C71\u4EAD\u30FB\u71D5\u5C71\u4EAD", "\u51E4\u6816\u68A7\u30FB\u8776\u604B\u82B1", "\u7AF9\u9A6C\u5B50\u30FB\u7AF9\u9A6C\u513F", "\u9752\u95E8\u5F15\u30FB\u9752\u95E8\u996E", "\u51E4\u51F0\u53F0\u4E0A\u5FC6\u5439\u7BAB", "\u9501\u7A97\u5BD2\u30FB\u7410\u5BD2\u7A97", "\u6D6A\u6D9B\u6C99\u30FB\u6D6A\u6DD8\u6C99", "\u79E6\u697C\u6708\u30FB\u5FC6\u79E6\u5A25", "\u89C2\u6C38\u4E50\u516C\u4E3B\u5165\u756A", "\u996E\u6E56\u4E0A\u521D\u6674\u540E\u96E8", "\u957F\u76F8\u601D\xB7\u5176\u4E00", "\u91D1\u9675\u9152\u8086\u7559\u522B", "\u767B\u91D1\u9675\u51E4\u51F0\u53F0", "\u591C\u6CCA\u725B\u6E1A\u6000\u53E4", "\u542C\u8700\u50E7\u6D5A\u5F39\u7434", "\u9001\u6893\u5DDE\u674E\u4F7F\u541B", "\u79EF\u96E8\u8F8B\u5DDD\u5E84\u4F5C", "\u9001\u5143\u4E8C\u4F7F\u5B89\u897F", "\u8D60\u522B\u4E8C\u9996 \u4E8C", "\u65E9\u79CB\u4E09\u9996 \u4E00", "\u5BFB\u5357\u6EAA\u5E38\u9053\u58EB", "\u957F\u6C99\u8FC7\u8D3E\u8C0A\u5B85", "\u591C\u5F52\u9E7F\u95E8\u5C71\u6B4C", "\u65E9\u5BD2\u6C5F\u4E0A\u6709\u6000", "\u7559\u522B\u738B\u4F8D\u5FA1\u7EF4", "\u4E0E\u8BF8\u5B50\u767B\u5C98\u5C71", "\u8BBF\u8881\u62FE\u9057\u4E0D\u9047", "\u5BBF\u738B\u660C\u9F84\u9690\u5C45", "\u7834\u5C71\u5BFA\u540E\u7985\u9662", "\u4E09\u6708\u6666\u65E5\u9001\u6625", "\u5BAB\u8BCD\u4E8C\u9996 \u4E00", "\u96C6\u7075\u53F0\xB7\u5176\u4E00", "\u96C6\u7075\u53F0\xB7\u5176\u4E8C", "\u6C5F\u5357\u9022\u674E\u9F9F\u5E74", "\u68A6\u674E\u767D\xB7\u5176\u4E00", "\u68A6\u674E\u767D\xB7\u5176\u4E8C", "\u548C\u8D3E\u820D\u4EBA\u65E9\u671D", "\u4E5D\u65E5\u84DD\u8015\u4F1A\u996E", "\u9898\u5927\u5EBE\u5CAD\u5317\u9A7F", "\u548C\u664B\u9675\u9646\u627F\u76F8", "\u9189\u540E\u8D60\u5F20\u4E5D\u65ED", "\u5BFB\u9646\u9E3F\u6E10\u4E0D\u9047", "\u8D60\u9619\u4E0B\u88F4\u820D\u4EBA", "\u77F3\u9C7C\u6E56\u4E0A\u9189\u6B4C", "\u79CB\u591C\u5BC4\u4E18\u5458\u5916", "\u5BC4\u5DE6\u7701\u675C\u62FE\u9057", "\u5BAB\u8BCD\u4E94\u9996 \u4E8C", "\u5E78\u8700\u56DE\u81F3\u5251\u95E8", "\u7EFF\u5934\u9E2D\u30FB\u591A\u4E3D", "\u9713\u88F3\u4E2D\u5E8F\u7B2C\u4E00", "\u590F\u65E5\u767B\u8F66\u76D6\u4EAD", "\u767B\u5E7D\u5DDE\u53F0\u6B4C", "\u6625\u591C\u522B\u53CB\u4EBA", "\u6E05\u5E73\u8C03 \u4E09", "\u6E21\u8346\u95E8\u9001\u522B", "\u65E9\u53D1\u767D\u5E1D\u57CE", "\u72EC\u5750\u656C\u4EAD\u5C71", "\u9001\u53CB\u4EBA\u5165\u8700", "\u957F\u4FE1\u6028 \u4E8C", "\u7B54\u4E94\u9675\u592A\u5B88", "\u5BC4\u4EE4\u72D0\u90CE\u4E2D", "\u6742\u8BD7 \u5341\u4E09", "\u6B21\u5317\u56FA\u5C71\u4E0B", "\u6D1B\u9633\u5973\u513F\u884C", "\u9001\u6731\u5927\u5165\u79E6", "\u8D60\u522B\xB7\u5176\u4E00", "\u9001\u7075\u6F88\u4E0A\u4EBA", "\u5C81\u66AE\u5F52\u5357\u5C71", "\u5C81\u9664\u591C\u6709\u6000", "\u9898\u4E49\u516C\u7985\u623F", "\u7EC8\u5357\u671B\u4F59\u96EA", "\u9001\u9B4F\u4E07\u4E4B\u4EAC", "\u6625\u6CDB\u82E5\u8036\u6EAA", "\u5BFB\u9690\u8005\u4E0D\u9047", "\u897F\u585E\u5C71\u6000\u53E4", "\u548C\u4E50\u5929\u6625\u8BCD", "\u7384\u90FD\u89C2\u6843\u82B1", "\u518D\u6E38\u7384\u90FD\u89C2", "\u6708\u591C\u5FC6\u820D\u5F1F", "\u5929\u672B\u5FC6\u674E\u767D", "\u522B\u623F\u592A\u5C09\u5893", "\u8D60\u536B\u516B\u5904\u58EB", "\u767B\u5156\u5DDE\u57CE\u697C", "\u76D6\u7F57\u7F1D \u4E00", "\u9001\u50E7\u5F52\u65E5\u672C", "\u6C5F\u884C\u671B\u5321\u5E90", "\u8D3C\u9000\u793A\u5B98\u540F", "\u540C\u9898\u4ED9\u6E38\u89C2", "\u957F\u5B89\u9047\u51AF\u8457", "\u5915\u6B21\u76F1\u7719\u53BF", "\u9898\u8881\u6C0F\u522B\u4E1A", "\u7EFF\u610F\u30FB\u758F\u5F71", "\u4E1C\u98CE\u7B2C\u4E00\u679D", "\u6CD5\u66F2\u732E\u4ED9\u97F3", "\u5BBF\u4E91\u95E8\u5BFA\u9601", "\u6E38\u5C0F\u56ED\u4E0D\u503C", "\u5E86\u5168\u5EB5\u6843\u82B1", "\u6625\u66AE\u6E38\u5C0F\u56ED", "\u65E9\u671D\u5927\u660E\u5BAB", "\u5728\u5CB3\u548F\u8749", "\u6613\u6C34\u9001\u522B", "\u8D60\u4E54\u4F8D\u90CE", "\u6E05\u5E73\u8C03\u8BCD", "\u8D60\u5B5F\u6D69\u7136", "\u9001\u90ED\u53F8\u4ED3", "\u767B\u9E73\u96C0\u697C", "\u65B0\u5AC1\u5A18\u8BCD", "\u548F\u534E\u6E05\u5BAB", "\u767B\u4E50\u6E38\u539F", "\u591C\u96E8\u5BC4\u5317", "\u7AE0\u53F0\u591C\u601D", "\u705E\u4E0A\u79CB\u5C45", "\u6CA1\u8543\u6545\u4EBA", "\u6E2D\u5DDD\u7530\u5BB6", "\u916C\u5F20\u5C11\u5E9C", "\u8FC7\u9999\u79EF\u5BFA", "\u5C71\u5C45\u79CB\u669D", "\u7EC8\u5357\u522B\u4E1A", "\u5F52\u5D69\u5C71\u4F5C", "\u6C49\u6C5F\u4E34\u773A", "\u8D60\u90ED\u7ED9\u4E8B", "\u5C71\u4E2D\u9001\u522B", "\u521D\u6625\u5C0F\u96E8", "\u5C71\u4E2D\u5BE1\u5987", "\u79E6\u6DEE\u591C\u6CCA", "\u95EE\u5218\u5341\u4E5D", "\u76F4\u4E2D\u4E66\u7701", "\u522B\u5362\u79E6\u537F", "\u8FC7\u6545\u4EBA\u5E84", "\u5BBF\u5EFA\u5FB7\u6C5F", "\u8FC7\u4E09\u95FE\u5E99", "\u665A\u6B21\u9102\u5DDE", "\u5DE6\u6396\u68A8\u82B1", "\u884C\u7ECF\u534E\u9634", "\u82CF\u6C0F\u522B\u4E1A", "\u6C5F\u5357\u65C5\u60C5", "\u53E4\u4ECE\u519B\u884C", "\u9001\u9648\u7AE0\u752B", "\u5BBF\u9F99\u5174\u5BFA", "\u5229\u5DDE\u5357\u6E21", "\u9001\u4EBA\u4E1C\u6E38", "\u5B64\u96C1 \u4E8C", "\u9898\u91D1\u9675\u6E21", "\u8700\u5148\u4E3B\u5E99", "\u6625\u5BBF\u5DE6\u7701", "\u65C5\u591C\u4E66\u6000", "\u767B\u5CB3\u9633\u697C", "\u8662\u56FD\u592B\u4EBA", "\u5BC4\u97E9\u8C0F\u8BAE", "\u79E6\u5DDE\u6742\u8BD7", "\u7EDD\u53E5\u6F2B\u5174", "\u4E0E\u6731\u5C71\u4EBA", "\u671B\u6708\u6000\u8FDC", "\u4E0A\u5143\u5E94\u5236", "\u67AB\u6865\u591C\u6CCA", "\u9001\u6768\u6C0F\u5973", "\u6EC1\u5DDE\u897F\u6DA7", "\u9022\u5165\u4EAC\u4F7F", "\u767B\u603B\u6301\u9601", "\u6E58\u6625\u591C\u6708", "\u60DC\u9EC4\u82B1\u6162", "\u516B\u58F0\u7518\u5DDE", "\u795D\u82F1\u53F0\u8FD1", "\u5343\u79CB\u5C81\u5F15", "\u6C34\u8C03\u6B4C\u5934", "\u516D\u5DDE\u6B4C\u5934", "\u70DB\u5F71\u6447\u7EA2", "\u6728\u5170\u82B1\u6162", "\u795D\u82F1\u53F0\u4EE4", "\u957F\u4EAD\u6028\u6162", "\u971C\u5929\u6653\u89D2", "\u591C\u9001\u8D75\u7EB5", "\u79CB\u65E5\u6E56\u4E0A", "\u6C7E\u4E0A\u60CA\u79CB", "\u8700\u9053\u540E\u671F", "\u5E7D\u5DDE\u591C\u6B4C", "\u9898\u7AF9\u6797\u5BFA", "\u9898\u677E\u6C40\u9A7F", "\u6E21\u626C\u5B50\u6C5F", "\u6625\u65E5\u5076\u6210", "\u9898\u6DEE\u5357\u5BFA", "\u90CA\u884C\u5373\u4E8B", "\u4E0A\u5143\u4F8D\u5BB4", "\u57CE\u4E1C\u65E9\u6625", "\u665A\u697C\u95F2\u5750", "\u7ACB\u6625\u5076\u6210", "\u9898\u90B8\u95F4\u58C1", "\u4E0A\u9AD8\u4F8D\u90CE", "\u66AE\u6625\u5373\u4E8B", "\u521D\u590F\u7761\u8D77", "\u5BA2\u4E2D\u521D\u590F", "\u4E09\u8862\u9053\u4E2D", "\u5C71\u5C45\u590F\u65E5", "\u6751\u5C45\u5373\u4E8B", "\u6C5F\u697C\u6709\u611F", "\u957F\u5B89\u79CB\u671B", "\u9898\u4E34\u5B89\u90B8", "\u771F\u7389\u5802\u4F5C", "\u7B54\u949F\u5F31\u7FC1", "\u7B54\u4E01\u5143\u73CD", "\u5BD2\u98DF\u4E66\u4E8B", "\u8868\u5144\u8BDD\u65E7", "\u6708\u591C\u821F\u4E2D", "\u9001\u6BDB\u4F2F\u6E29", "\u5C06\u8FDB\u9152", "\u5173\u5C71\u6708", "\u8700\u9053\u96BE", "\u7389\u9636\u6028", "\u9759\u591C\u601D", "\u9001\u53CB\u4EBA", "\u79CB\u6D66\u6B4C", "\u5BA2\u4E2D\u884C", "\u6625\u5BAB\u66F2", "\u957F\u4FE1\u6028", "\u6545\u884C\u5BAB", "\u7B79\u7B14\u9A7F", "\u5317\u9752\u841D", "\u91D1\u9675\u56FE", "\u9A6C\u5D6C\u5761", "\u4F0A\u5DDE\u6B4C", "\u54E5\u8212\u6B4C", "\u72EC\u4E0D\u89C1", "\u6843\u82B1\u8C3F", "\u897F\u65BD\u548F", "\u8001\u5C06\u884C", "\u6843\u6E90\u884C", "\u7EC8\u5357\u5C71", "\u7AF9\u91CC\u9986", "\u79CB\u591C\u66F2", "\u7389\u53F0\u4F53", "\u77F3\u9F13\u6B4C", "\u6625\u5BAB\u6028", "\u5BAB\u4E2D\u8BCD", "\u91D1\u8C37\u56ED", "\u6C5F\u5357\u6625", "\u4E2D\u79CB\u6708", "\u9647\u897F\u884C", "\u540E\u5BAB\u8BCD", "\u957F\u6068\u6B4C", "\u7435\u7436\u5F15", "\u6C5F\u5357\u66F2", "\u542C\u5F39\u7434", "\u9001\u4E0A\u4EBA", "\u65B0\u5E74\u4F5C", "\u51C9\u5DDE\u8BCD", "\u4E34\u6D1E\u5EAD", "\u9001\u674E\u7AEF", "\u9001\u5D14\u4E5D", "\u9EC4\u9E64\u697C", "\u671B\u84DF\u95E8", "\u671B\u79E6\u5DDD", "\u7476\u745F\u6028", "\u82CF\u6B66\u5E99", "\u6E21\u6C49\u6C5F", "\u8D60\u5185\u4EBA", "\u4E4C\u8863\u5DF7", "\u79CB\u98CE\u5F15", "\u516B\u9635\u56FE", "\u5175\u8F66\u884C", "\u4E3D\u4EBA\u884C", "\u54C0\u6C5F\u5934", "\u54C0\u738B\u5B59", "\u53E4\u67CF\u884C", "\u9001\u5D14\u878D", "\u71D5\u6B4C\u884C", "\u7389\u53F0\u89C2", "\u91D1\u7F15\u8863", "\u5A46\u7F57\u95E8", "\u5217\u5973\u64CD", "\u6E38\u5B50\u541F", "\u9022\u4FA0\u8005", "\u7B54\u674E\u510B", "\u7B54\u674E\u6D63", "\u4E66\u8FB9\u4E8B", "\u5A55\u59A4\u6028", "\u5F81\u4EBA\u6028", "\u745E\u9E64\u4ED9", "\u5BB4\u6E05\u90FD", "\u9F50\u5929\u4E50", "\u98CE\u5165\u677E", "\u9AD8\u9633\u53F0", "\u591C\u5408\u82B1", "\u591C\u6E38\u5BAB", "\u9E67\u9E2A\u5929", "\u5510\u591A\u4EE4", "\u6D63\u6EAA\u6C99", "\u70B9\u7EDB\u5507", "\u5251\u5668\u8FD1", "\u5B89\u516C\u5B50", "\u535C\u7B97\u5B50", "\u6842\u679D\u9999", "\u6E05\u5E73\u4E50", "\u4E34\u6C5F\u4ED9", "\u8776\u604B\u82B1", "\u751F\u67E5\u5B50", "\u83E9\u8428\u86EE", "\u7389\u697C\u6625", "\u962E\u90CE\u5F52", "\u516D\u5E7A\u4EE4", "\u5FA1\u8857\u884C", "\u865E\u7F8E\u4EBA", "\u7559\u6625\u4EE4", "\u601D\u8FDC\u4EBA", "\u6C34\u9F99\u541F", "\u6C38\u9047\u4E50", "\u9752\u7389\u6848", "\u8C22\u6C60\u6625", "\u8D3A\u65B0\u90CE", "\u6E21\u6C5F\u4E91", "\u89E3\u8FDE\u73AF", "\u6708\u4E0B\u7B1B", "\u597D\u4E8B\u8FD1", "\u6478\u9C7C\u513F", "\u6C49\u5BAB\u6625", "\u6E14\u5BB6\u50B2", "\u9752\u95E8\u996E", "\u671B\u6D77\u6F6E", "\u5E1D\u53F0\u6625", "\u5929\u95E8\u8C23", "\u671B\u6E58\u4EBA", "\u5170\u9675\u738B", "\u7389\u4EAC\u79CB", "\u590F\u4E91\u5CF0", "\u5FC6\u738B\u5B59", "\u77F3\u5DDE\u6162", "\u6EE1\u6C5F\u7EA2", "\u674F\u82B1\u5929", "\u8E0F\u838E\u884C", "\u4E00\u843C\u7EA2", "\u5FF5\u5974\u5A07", "\u626C\u5DDE\u6162", "\u6DE1\u9EC4\u67F3", "\u82CF\u5E55\u906E", "\u66F2\u7389\u7BA1", "\u96E8\u9716\u94C3", "\u91C7\u83B2\u4EE4", "\u6D6A\u6DD8\u6C99", "\u5C11\u5E74\u6E38", "\u591C\u534A\u4E50", "\u7389\u8774\u8776", "\u8FF7\u795E\u5F15", "\u9189\u5782\u97AD", "\u5929\u4ED9\u5B50", "\u5343\u79CB\u5C81", "\u91C7\u6851\u5B50", "\u8BC9\u8877\u60C5", "\u7EEE\u7F57\u9999", "\u53CC\u53CC\u71D5", "\u559C\u8FC1\u83BA", "\u4E09\u59DD\u5A9A", "\u6C5F\u57CE\u5B50", "\u5C0F\u91CD\u5C71", "\u71D5\u5C71\u4EAD", "\u9189\u82B1\u9634", "\u82CF\u6B66\u6162", "\u67F3\u68A2\u9752", "\u5FC6\u5C11\u5E74", "\u98CE\u6D41\u5B50", "\u5E94\u5929\u957F", "\u6EE1\u5EAD\u82B3", "\u7EEE\u5BEE\u6028", "\u60DC\u5206\u98DE", "\u5973\u51A0\u5B50", "\u84E6\u5C71\u6EAA", "\u773C\u513F\u5A9A", "\u6D1B\u9633\u9053", "\u601D\u541B\u6069", "\u7F62\u76F8\u4F5C", "\u5BAB\u4E2D\u9898", "\u5723\u679C\u5BFA", "\u6E38\u6708\u9642", "\u9898\u69B4\u82B1", "\u6253\u7403\u56FE", "\u8695\u5987\u541F", "\u51B7\u6CC9\u4EAD", "\u63D2\u82B1\u541F", "\u9001\u5929\u5E08", "\u6625\u601D", "\u6028\u60C5", "\u95FA\u6028", "\u51FA\u585E", "\u9526\u745F", "\u97E9\u7891", "\u98CE\u96E8", "\u968B\u5BAB", "\u843D\u82B1", "\u4E3A\u6709", "\u7476\u6C60", "\u6625\u96E8", "\u5AE6\u5A25", "\u8D3E\u751F", "\u51C9\u601D", "\u971C\u6708", "\u53F0\u57CE", "\u5BAB\u8BCD", "\u9898\u58C1", "\u4F8D\u5BB4", "\u9001\u522B", "\u9752\u8C3F", "\u9E7F\u67F4", "\u6742\u8BD7", "\u76F8\u601D", "\u5C71\u77F3", "\u665A\u6625", "\u5DF2\u51C9", "\u8D64\u58C1", "\u9063\u6000", "\u79CB\u5915", "\u65C5\u5BBF", "\u6E05\u660E", "\u5BC4\u4EBA", "\u542C\u7B5D", "\u8D4B\u5F97", "\u6625\u6653", "\u7434\u6B4C", "\u53E4\u610F", "\u8D2B\u5973", "\u65C5\u6000", "\u6EAA\u5C45", "\u6C5F\u96EA", "\u6E14\u7FC1", "\u6708\u591C", "\u6625\u671B", "\u8700\u76F8", "\u5BA2\u81F3", "\u91CE\u671B", "\u767B\u9AD8", "\u767B\u697C", "\u5BBF\u5E9C", "\u9601\u591C", "\u671B\u5CB3", "\u4F73\u4EBA", "\u79B9\u5E99", "\u7EDD\u53E5", "\u6F2B\u5174", "\u6C5F\u6751", "\u65B0\u79CB", "\u51AC\u81F3", "\u548F\u53F2", "\u5F52\u96C1", "\u5BD2\u98DF", "\u4E1C\u90CA", "\u6625\u6028", "\u9619\u9898", "\u8584\u5E78", "\u6697\u9999", "\u758F\u5F71", "\u516B\u5F52", "\u79CB\u9701", "\u82B1\u72AF", "\u897F\u6CB3", "\u5929\u9999", "\u7709\u59A9", "\u4E09\u53F0", "\u79CB\u65E5", "\u7B54\u4EBA", "\u79CB\u6708", "\u5076\u6210", "\u6625\u65E5", "\u6CDB\u821F", "\u6625\u5BB5", "\u6D77\u68E0", "\u82B1\u5F71", "\u897F\u6E56", "\u51AC\u666F", "\u6625\u591C", "\u5143\u65E5", "\u5317\u5C71", "\u8305\u6A90", "\u793E\u65E5", "\u9898\u5C4F", "\u6E56\u4E0A", "\u6625\u6674", "\u6625\u66AE", "\u5373\u666F", "\u83BA\u68AD", "\u767B\u5C71", "\u4F24\u6625", "\u9001\u6625", "\u6709\u7EA6", "\u590F\u65E5", "\u7530\u5BB6", "\u6751\u665A", "\u4E03\u5915", "\u7ACB\u79CB", "\u95FB\u7B1B", "\u7AF9\u697C", "\u5BD2\u591C", "\u65E9\u6625", "\u5BD3\u610F", "\u79CB\u5343", "\u65B0\u7AF9", "\u79CB\u601D", "\u4E2D\u79CB", "\u6885\u82B1", "\u5E72\u6208", "\u5F52\u9690", "\u8749", "\u6885"] };

  // src/client/intent.ts
  var BOOK_ALIAS = [
    [/聊斋/, "\u804A\u658B\u5FD7\u5F02"],
    [/三国/, "\u4E09\u56FD\u6F14\u4E49"],
    [/西游/, "\u897F\u6E38\u8BB0"],
    [/水浒/, "\u6C34\u6D52\u4F20"],
    [/红楼/, "\u7EA2\u697C\u68A6"],
    [/封神/, "\u5C01\u795E\u6F14\u4E49"],
    [/隋唐/, "\u968B\u5510\u6F14\u4E49"],
    [/杨家将/, "\u6768\u5BB6\u5C06\u6F14\u4E49"],
    [/世说/, "\u4E16\u8BF4\u65B0\u8BED"],
    [/三言|二拍/, "\u4E09\u8A00\u4E8C\u62CD"],
    [/儒林/, "\u5112\u6797\u5916\u53F2"],
    [/官场/, "\u5B98\u573A\u73B0\u5F62\u8BB0"],
    [/老残/, "\u8001\u6B8B\u6E38\u8BB0"],
    [/说岳|岳传/, "\u8BF4\u5CB3\u5168\u4F20"],
    [/东周/, "\u4E1C\u5468\u5217\u56FD\u5FD7"],
    [/三侠五义/, "\u4E09\u4FA0\u4E94\u4E49"],
    [/镜花缘/, "\u955C\u82B1\u7F18"]
  ];
  var POEM_TITLES = (poem_titles_default.titles || []).slice().sort((a, b) => b.length - a.length);
  function matchPoemTitle(text) {
    const t = String(text || "");
    if (!t) return "";
    for (const title of POEM_TITLES) {
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
    const byTitle = matchPoemTitle(t);
    if (byTitle) return { kind: "poem", title: byTitle };
    if (/背(一)?(首|下)?诗|念(一)?(首|下)?诗|来首诗|背诗|念诗|讲首诗/.test(t)) return { kind: "poem" };
    if (/典故|成语/.test(t)) return { kind: "culture", sub: /成语/.test(t) ? "chengyu" : "idiom" };
    let book = "";
    for (const [re, name] of BOOK_ALIAS) {
      if (re.test(t)) {
        book = name;
        break;
      }
    }
    if (book) return { kind: "story", book };
    if (/讲故事|讲个故事|说书|来段|讲一段/.test(t)) return { kind: "story", book: "" };
    return null;
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

  // src/shared/tts.ts
  function isValidRate(s) {
    return typeof s === "string" && /^[+-]\d{1,2}%$/.test(s.trim());
  }
  function normalizeRate(s, defaultRate = "+0%") {
    return isValidRate(s) ? String(s).trim() : defaultRate;
  }

  // src/shared/time.ts
  var DAY_MS = 864e5;
  function applyPeriod(hour, word) {
    if (word === "\u4E0B\u5348") return hour === 12 ? 12 : hour < 12 ? hour + 12 : hour;
    if (word === "\u508D\u665A" || word === "\u665A\u4E0A") return hour === 12 ? 0 : hour < 12 ? hour + 12 : hour;
    if (word === "\u4E2D\u5348") return hour < 10 ? hour + 12 : hour;
    return hour;
  }
  function cleanReminderText(raw) {
    let t = String(raw || "").trim();
    const leads = ["\u63D0\u9192\u6211\u4E00\u4E0B", "\u63D0\u9192\u4E00\u4E0B", "\u63D0\u9192\u6211", "\u63D0\u9192", "\u53EB\u6211\u4E00\u4E0B", "\u53EB\u6211", "\u8BB0\u5F97\u8981", "\u8BB0\u5F97", "\u5230\u65F6\u5019"];
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
        if (mm === "\u534A") minute = 30;
        else if (mm) minute = Math.max(0, Math.min(59, Number(mm) || 0));
        const dayStart = new Date(base.getFullYear(), base.getMonth(), base.getDate());
        let target = new Date(dayStart.getTime());
        if (day) {
          if (day[1] === "\u660E\u5929") target = new Date(dayStart.getTime() + DAY_MS);
          else if (day[1] === "\u540E\u5929") target = new Date(dayStart.getTime() + 2 * DAY_MS);
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

  // src/client.ts
  window.__ModuleLoader__.load({
    id: "dsh-chubby-whale",
    factory: (require2) => {
      const R = require2("react");
      try {
        window.__chubbyErrors = [];
        const origErr = console.error;
        console.error = function(...a) {
          try {
            window.__chubbyErrors.push(a.map((x) => x && x.stack ? x.stack : String(x)).join(" ").slice(0, 800));
          } catch (e) {
          }
          return origErr.apply(console, a);
        };
        window.addEventListener("error", (e) => {
          try {
            window.__chubbyErrors.push("window.error: " + (e.message || "") + " | " + (e.error && e.error.stack || ""));
          } catch (e2) {
          }
        });
      } catch (e) {
      }
      const h = R.createElement;
      const CLIENT_ID = (() => {
        try {
          let v = localStorage.getItem("chubby-client-id");
          if (!v) {
            v = "c" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
            localStorage.setItem("chubby-client-id", v);
          }
          return v;
        } catch (e) {
          return "";
        }
      })();
      let ttsPlaying = false;
      const channels = { mic: { stats: {} }, asr: { stats: {} }, speak: { stats: {} } };
      let chatEpoch = 0;
      let asrBusy = false;
      let asrBusyAt = 0;
      const NARRATION_RATE2 = (() => {
        try {
          const s = localStorage.getItem("chubby-narration-rate");
          return s && /^[+-]\d{1,2}%$/.test(s) ? s : "-25%";
        } catch (e) {
          return "-25%";
        }
      })();
      const storyNarratingRef = { current: false };
      const persona = createPersona();
      let lastPoemSpeech = "";
      let narrateUntil = 0;
      let lastSpeakingAt = 0;
      const NARRATE_MIN_MS = 8e3;
      const NARRATE_MAX_MS = 5 * 60 * 1e3;
      function setNarrating(ms) {
        const dur = Math.max(NARRATE_MIN_MS, Math.min(Number(ms) || 6e4, NARRATE_MAX_MS));
        narrateUntil = Date.now() + dur;
        try {
          storyNarratingRef.current = true;
        } catch (e) {
        }
      }
      function clearNarrating() {
        narrateUntil = 0;
        try {
          storyNarratingRef.current = false;
        } catch (e) {
        }
      }
      function estimateSpeakMs(text) {
        return Math.round(String(text || "").length * 260) + 3e3;
      }
      let lastLineNorm = "";
      let lastLineAt = 0;
      let greetedOnce = false;
      let lastReplyText = "";
      let lastReplyAt = 0;
      const latDiag = { asrMs: 0, chatMs: 0, firstAudioMs: 0, totalMs: 0, updates: 0 };
      function taleParts(rawTitle) {
        const t = String(rawTitle || "").trim();
        const i = t.indexOf("\xB7");
        if (i > 0 && i < t.length - 1) return { book: t.slice(0, i), title: t.slice(i + 1) };
        return { title: t, book: "" };
      }
      function collapsePoemBody(raw) {
        let t = String(raw == null ? "" : raw);
        t = t.replace(/\r/g, "");
        t = t.replace(/\n+/g, "\uFF0C");
        t = t.replace(/[。！？；]+，/g, (m) => m.slice(0, 1));
        t = t.replace(/，{2,}/g, "\uFF0C");
        t = t.replace(/，([。！？；])/g, "$1");
        return t.trim();
      }
      function collapseText(raw) {
        return String(raw == null ? "" : raw).replace(/\s+/g, " ").trim();
      }
      const NOTE_FREQ = {
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
      let melodyCtx = null;
      let melodyOscs = [];
      function stopMelody() {
        try {
          for (const o of melodyOscs) {
            try {
              o.stop();
            } catch (e) {
            }
          }
        } catch (e) {
        }
        melodyOscs = [];
        try {
          if (melodyCtx) {
            melodyCtx.close();
          }
        } catch (e) {
        }
        melodyCtx = null;
      }
      function playMelody(notes, bpm, onDone) {
        try {
          stopMelody();
          const AC = window.AudioContext || window.webkitAudioContext;
          if (!AC) return;
          const ctx = new AC();
          melodyCtx = ctx;
          try {
            ctx.resume();
          } catch (e) {
          }
          try {
            if (ctx.state === "suspended") ctx.resume();
          } catch (e) {
          }
          const beat = 60 / Math.max(60, bpm || 100);
          let t = ctx.currentTime + 0.05;
          for (const pair of notes) {
            const nm = String(pair[0]);
            const dur = Number(pair[1]) || 1;
            const f = NOTE_FREQ[nm];
            if (!f) {
              t += dur * beat;
              continue;
            }
            const o = ctx.createOscillator();
            const g = ctx.createGain();
            o.frequency.value = f;
            o.type = "sine";
            g.gain.setValueAtTime(0.3, t);
            g.gain.exponentialRampToValueAtTime(1e-3, t + dur * beat * 0.95);
            o.connect(g);
            g.connect(ctx.destination);
            o.start(t);
            o.stop(t + dur * beat);
            melodyOscs.push(o);
            t += dur * beat;
          }
          const totalMs = Math.max(0, (t - ctx.currentTime) * 1e3) + 300;
          if (onDone) setTimeout(() => {
            try {
              onDone();
            } catch (e) {
            }
          }, totalMs);
        } catch (e) {
        }
      }
      function WhaleOverlay(props) {
        try {
          return WhaleBody(props || {});
        } catch (e) {
          try {
            window.__chubbyWhale.renderError = String(e && e.stack || e);
          } catch (e2) {
          }
          try {
            console.error("[chubby-whale] \u6E32\u67D3\u5F02\u5E38\u5DF2\u88AB\u5C31\u5730\u62E6\u4E0B\uFF1A", e);
          } catch (e2) {
          }
          return null;
        }
      }
      function WhaleBody(props) {
        const stageRef = R.useRef(null);
        const canvasRef = R.useRef(null);
        const posRef = R.useRef({ x: 0, y: 0 });
        const talkRef = R.useRef({ talkUntil: 0, hearts: [] });
        const voiceModeRef = R.useRef(false);
        const wokeRef = R.useRef({ at: 0 });
        const voiceOnRef = R.useRef((() => {
          try {
            return localStorage.getItem("chubby-voice") !== "off";
          } catch (e) {
            return true;
          }
        })());
        const [voiceOn, setVoiceOn] = R.useState((() => {
          try {
            return localStorage.getItem("chubby-voice") !== "off";
          } catch (e) {
            return true;
          }
        })());
        const earOnRef = R.useRef((() => {
          try {
            return localStorage.getItem("chubby-ear") !== "off";
          } catch (e) {
            return true;
          }
        })());
        const [earOn, setEarOn] = R.useState(earOnRef.current);
        const voiceChatOnRef = R.useRef((() => {
          try {
            return localStorage.getItem("chubby-voicechat") !== "off";
          } catch (e) {
            return true;
          }
        })());
        const [voiceChatOn, setVoiceChatOn] = R.useState(voiceChatOnRef.current);
        const earCtlRef = R.useRef({ stop: () => {
        }, boot: () => {
        } });
        const [balanceLabel, setBalanceLabel] = R.useState("--");
        const chatCacheOnRef = R.useRef(true);
        const [chatCacheOn, setChatCacheOn] = R.useState(true);
        R.useEffect(() => {
          fetch("/api/chubby-whale/cache-toggle").then((r) => r.json()).then((d) => {
            if (d && typeof d.enabled === "boolean") {
              chatCacheOnRef.current = d.enabled;
              setChatCacheOn(d.enabled);
            }
          }).catch(() => {
          });
        }, []);
        const [growthLabel, setGrowthLabel] = R.useState("--");
        const WAKE_WORDS = ["\u5927\u80A5\u9C7C", "\u80A5\u9CB8", "\u80A5\u9C7C", "\u5C0F\u9C7C", "\u84DD\u9C7C", "\u5C0F\u84DD\u9C7C", "\u9C7C\u9C7C", "\u80A5\u80A5"];
        const dragRef = R.useRef({ dragging: false, lastX: 0, lastY: 0, vx: 0, vy: 0, moved: 0 });
        const scaleRef = R.useRef(1);
        const animRef = R.useRef(null);
        const storyBusyRef = R.useRef(false);
        const storyBookRef = R.useRef("");
        const storyAutoRef = R.useRef(false);
        const dueQueueRef = R.useRef([]);
        const dueTimerRef = R.useRef(null);
        const [scale, setScale] = R.useState(1);
        const [hidden, setHidden] = R.useState(false);
        const [menu, setMenu] = R.useState(null);
        const [subOpen, setSubOpen] = R.useState("");
        const [balanceText, setBalanceText] = R.useState("");
        const [lang, setLang] = R.useState((() => {
          try {
            return localStorage.getItem("chubby-lang") || "zh";
          } catch {
            return "zh";
          }
        })());
        const [chatOpen, setChatOpen] = R.useState(false);
        const [messages, setMessages] = R.useState([]);
        const [input, setInput] = R.useState("");
        const [busy, setBusy] = R.useState(false);
        const busyRef = R.useRef(false);
        const busyAtRef = R.useRef(0);
        busyRef.current = busy;
        const bodyRef = R.useRef(null);
        const bubbleRef = R.useRef(null);
        const bubbleTextRef = R.useRef(null);
        R.useEffect(() => {
          try {
            if (!document.getElementById("chubby-whale-style")) {
              const st = document.createElement("style");
              st.id = "chubby-whale-style";
              st.textContent = '.chubby-bubble{position:fixed;z-index:10002;max-width:320px;white-space:pre-wrap;opacity:0;background:#fff;color:#17325a;border-radius:14px;padding:10px 14px;font:13px/1.6 "Microsoft YaHei",sans-serif;box-shadow:0 8px 20px rgba(0,0,0,0.35);transition:opacity .2s;pointer-events:none;}.chubby-bubble::after{content:"";position:absolute;left:50%;margin-left:-9px;bottom:-9px;border-left:9px solid transparent;border-right:9px solid transparent;border-top:10px solid #fff;}.chubby-bubble.show{opacity:1;}';
              document.head.appendChild(st);
            }
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
          const init = saved && typeof saved.x === "number" ? saved : { x: Math.max(0, window.innerWidth - 24 - W), y: Math.max(0, window.innerHeight - 150 - H) };
          posRef.current = init;
          applyPos(init.x, init.y);
        }, []);
        function applyPos(x, y) {
          const el = stageRef.current;
          if (!el) return;
          const s = scaleRef.current || 1;
          const w = W * s;
          const h2 = H * s;
          x = Math.max(0, Math.min(window.innerWidth - w, x));
          y = Math.max(0, Math.min(window.innerHeight - h2, y));
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
        function homePos() {
          applyPos(window.innerWidth - 24 - W, window.innerHeight - 150 - H);
          savePos();
        }
        R.useEffect(() => {
          const onResize = () => {
            applyPos(posRef.current.x, posRef.current.y);
            savePos();
          };
          window.addEventListener("resize", onResize);
          return () => {
            try {
              window.removeEventListener("resize", onResize);
            } catch {
            }
          };
        }, []);
        R.useEffect(() => {
          return () => {
            try {
              if (dueTimerRef.current) {
                clearTimeout(dueTimerRef.current);
                dueTimerRef.current = null;
              }
            } catch {
            }
            dueQueueRef.current = [];
            stopTts();
            stopMelody();
            try {
              const el = bubbleRef.current;
              if (el && el._t) {
                clearTimeout(el._t);
                el._t = null;
              }
            } catch {
            }
          };
        }, []);
        function showBubble(text, ms = 2400) {
          const el = bubbleRef.current;
          if (!el) return;
          const p = posRef.current;
          el.style.left = p.x + W / 2 + "px";
          el.style.transform = "translateX(-50%)";
          el.style.top = "auto";
          el.style.right = "auto";
          el.style.bottom = Math.max(70, window.innerHeight - p.y + 12) + "px";
          if (bubbleTextRef.current) bubbleTextRef.current.textContent = text;
          el.classList.add("show");
          clearTimeout(el._t);
          el._t = setTimeout(() => {
            el.classList.remove("show");
            try {
              restoreIdleStatus();
            } catch (e) {
            }
          }, ms);
        }
        function setStatus() {
          try {
            const el = bubbleRef.current;
            if (!el) return;
            const txt = bubbleTextRef.current ? String(bubbleTextRef.current.textContent || "") : "";
            if (txt === "\u5728\u542C\u2026" || txt === "\u5728\u60F3\u2026" || txt === "\u8BC6\u522B\u4E2D\u2026" || txt === "\u5728\u8BF4\u2026") {
              el.classList.remove("show");
              clearTimeout(el._t);
              el._t = null;
            }
          } catch (e) {
          }
        }
        function restoreIdleStatus() {
        }
        R.useEffect(() => {
          const insideFish = (x, y) => {
            try {
              const el = stageRef.current;
              if (!el) return false;
              const r = el.getBoundingClientRect();
              const pad = 12;
              return x >= r.left - pad && x <= r.right + pad && y >= r.top - pad && y <= r.bottom + pad;
            } catch (e) {
              return false;
            }
          };
          const onDragOverCapture = (e) => {
            if (!insideFish(e.clientX, e.clientY)) return;
            e.preventDefault();
            e.stopPropagation();
          };
          const onDropCapture = (e) => {
            if (!insideFish(e.clientX, e.clientY)) return;
            e.preventDefault();
            e.stopPropagation();
            const dt = e.dataTransfer;
            const file = dt && dt.files && dt.files[0];
            try {
              handleFileDrop(file, { showBubble, speakText }).catch(() => {
              });
            } catch (e2) {
            }
          };
          window.addEventListener("dragover", onDragOverCapture, true);
          window.addEventListener("drop", onDropCapture, true);
          return () => {
            try {
              window.removeEventListener("dragover", onDragOverCapture, true);
            } catch (e) {
            }
            try {
              window.removeEventListener("drop", onDropCapture, true);
            } catch (e) {
            }
          };
        }, []);
        function onPointerDown(e) {
          if (e.button !== 0) return;
          const d = dragRef.current;
          d.dragging = true;
          d.lastX = e.clientX;
          d.lastY = e.clientY;
          d.vx = 0;
          d.vy = 0;
          d.moved = 0;
          d.baseX = posRef.current.x;
          d.baseY = posRef.current.y;
          try {
            const el = stageRef.current;
            if (el && el.style) {
              el.style.filter = "none";
              el.style.willChange = "transform";
            }
          } catch (e2) {
          }
          try {
            e.currentTarget.setPointerCapture(e.pointerId);
          } catch {
          }
        }
        function onPointerMove(e) {
          const d = dragRef.current;
          if (!d.dragging) return;
          const dx = e.clientX - d.lastX, dy = e.clientY - d.lastY;
          d.vx = dx;
          d.vy = dy;
          d.moved += Math.abs(dx) + Math.abs(dy);
          d.lastX = e.clientX;
          d.lastY = e.clientY;
          applyPos(posRef.current.x + dx, posRef.current.y + dy);
        }
        function onPointerUp() {
          const d = dragRef.current;
          if (!d.dragging) return;
          d.dragging = false;
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
          let vx = Math.max(-14, Math.min(14, d.vx));
          let vy = Math.max(-14, Math.min(14, d.vy));
          const step = () => {
            if (dragRef.current.dragging) return;
            vx *= 0.9;
            vy *= 0.9;
            applyPos(posRef.current.x + vx, posRef.current.y + vy);
            if (Math.abs(vx) < 0.2 && Math.abs(vy) < 0.2) {
              savePos();
              return;
            }
            requestAnimationFrame(step);
          };
          requestAnimationFrame(step);
        }
        R.useEffect(() => {
          const t0 = setTimeout(() => {
            try {
              refreshBalance();
            } catch (e) {
            }
          }, 2e3);
          const tGreet = setTimeout(() => {
            try {
              if (greetedOnce) return;
              greetedOnce = true;
              const g = persona.greeting();
              if (g) sayLine(g, 5e3);
            } catch (e) {
            }
          }, 3e3);
          try {
            const st = persona.state;
            if (st && st.lastFeedAt && Date.now() - st.lastFeedAt > 6 * 3600 * 1e3) setTimeout(() => {
              try {
                sayLine(persona.line("hungry"), 4e3);
              } catch (e) {
              }
            }, 6e3);
          } catch (e) {
          }
          try {
            const w = window.__chubbyWhale || (window.__chubbyWhale = {});
            w.persona = persona;
            w.sayLine = sayLine;
          } catch (e) {
          }
          const tStatus = setInterval(() => {
            try {
              try {
                if (narrateUntil && Date.now() > narrateUntil) {
                  if (narrateUntil && !ttsPlaying && lastSpeakingAt && Date.now() - lastSpeakingAt > 4e3) {
                    clearNarrating();
                    try {
                      window.__chubbyWhale.narrReset = (window.__chubbyWhale.narrReset || 0) + 1;
                    } catch (e4) {
                    }
                  }
                  clearNarrating();
                  try {
                    window.__chubbyWhale.narrReset = (window.__chubbyWhale.narrReset || 0) + 1;
                  } catch (e3) {
                  }
                }
              } catch (e3) {
              }
              if (busyRef.current && Date.now() - busyAtRef.current > 35e3) {
                busyAtRef.current = Date.now();
                setBusy(false);
                busyRef.current = false;
                try {
                  window.__chubbyWhale.busyReset = (window.__chubbyWhale.busyReset || 0) + 1;
                } catch (e2) {
                }
              }
            } catch (e) {
            }
          }, 2e3);
          const clearStatus = () => {
            try {
              clearInterval(tStatus);
            } catch (e) {
            }
          };
          const tF = setTimeout(() => {
            try {
              prefetchFiller();
            } catch (e) {
            }
          }, 3e3);
          return () => {
            clearTimeout(t0);
            try {
              clearTimeout(tGreet);
            } catch (e) {
            }
            try {
              clearTimeout(tF);
            } catch (e) {
            }
            clearStatus();
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
          refreshBalance();
          fetch("/api/chubby-whale/growth").then((r) => r.json()).then((d) => {
            if (d && d.ok) setGrowthLabel(d.stage + "\uFF08" + d.exp + "\uFF09");
          }).catch(() => {
          });
        }
        function refreshBalance() {
          fetch("/api/chubby-whale/balance", { cache: "no-store" }).then((r) => r.json()).then((d) => {
            if (d && d.ok && d.balance != null) {
              const v = String(d.balance);
              setBalanceText("\u4F59\u989D \xA5" + v);
              setBalanceLabel("\xA5" + v);
            } else if (d && (d.error === "NO_KEY" || d.error === "no key")) {
              setBalanceText("\u4F59\u989D\uFF08\u672A\u914D\u7F6E\u5BC6\u94A5\uFF09");
              setBalanceLabel("\u672A\u914D\u7F6E\u5BC6\u94A5");
            } else {
              setBalanceText("\u4F59\u989D\uFF08\u67E5\u8BE2\u5931\u8D25\uFF09");
              setBalanceLabel("\u67E5\u8BE2\u5931\u8D25");
            }
          }).catch(() => {
            setBalanceText("\u4F59\u989D\uFF08\u67E5\u8BE2\u5931\u8D25\uFF09");
            setBalanceLabel("\u67E5\u8BE2\u5931\u8D25");
          });
        }
        R.useEffect(() => {
          if (!menu) return;
          const onDocDown = (e) => {
            try {
              const t = e && e.target;
              if (t && t.closest && t.closest("[data-menu-root]")) return;
              setMenu(null);
              setSubOpen("");
            } catch {
            }
          };
          document.addEventListener("pointerdown", onDocDown, true);
          return () => {
            try {
              document.removeEventListener("pointerdown", onDocDown, true);
            } catch {
            }
          };
        }, [menu]);
        function playStoryPiece(d) {
          const text = String(d.text || "");
          if (d && d.book) storyBookRef.current = String(d.book);
          const head = "\u8BF4\u4E66\xB7\u300A" + String(d.book || "") + "\u300B" + (d.title ? "\uFF5C" + d.title : "");
          let voiceOff = false;
          try {
            voiceOff = localStorage.getItem("chubby-voice") === "off";
          } catch (e) {
          }
          showBubble("\u6B63\u5728\u8BB2\u300A" + String(d.book || "") + "\u300B" + (d.title ? "\uFF5C" + d.title : ""), 12e3);
          animRef.current?.talkFor(8e3);
          if (voiceOff) {
            storyBusyRef.current = false;
            storyNarratingRef.current = false;
            showBubble("\u6B63\u5728\u8BB2\u300A" + String(d.book || "") + "\u300B" + (d.title ? "\uFF5C" + d.title : "") + "\uFF08\u8BED\u97F3\u6717\u8BFB\u5173\u7740\uFF09", 12e3);
            return;
          }
          storyBusyRef.current = true;
          setNarrating(estimateSpeakMs(text));
          speakText(text, {
            rate: normalizeRate(d.rate, NARRATION_RATE2),
            onDone: () => {
              storyBusyRef.current = false;
              storyNarratingRef.current = false;
              if (storyAutoRef.current && d.isLast === false) {
                setTimeout(() => {
                  try {
                    nextStory();
                  } catch (e) {
                  }
                }, 800);
              } else {
                storyAutoRef.current = false;
                showBubble(d.isLast ? persona.line("poemDone") : "\u8FD9\u6BB5\u8BB2\u5B8C\u5566\uFF5E\u70B9\u83DC\u5355\u300C\u63A5\u7740\u8BF4\u300D\u542C\u4E0B\u4E00\u6BB5", 6e3);
              }
            }
          });
        }
        function startStory(hint) {
          if (storyBusyRef.current) {
            showBubble("\u6B63\u8BB2\u7740\u5462\uFF0C\u542C\u5B8C\u8FD9\u6BB5\u518D\u8BF4\uFF5E", 3e3);
            return;
          }
          const headers = CLIENT_ID ? { "x-client-id": CLIENT_ID } : {};
          fetch("/api/chubby-whale/story/start" + (hint ? "?hint=" + encodeURIComponent(hint) : ""), { headers }).then((r) => r.json()).then((d) => {
            if (!d || !d.ok) {
              showBubble("\u8BF4\u4E66\u6CA1\u5F00\u6210\uFF1A" + (d && d.error || "\u6CA1\u8BFB\u5230\u4E66"), 5e3);
              return;
            }
            playStoryPiece(d);
          }).catch(() => showBubble("\u8BF4\u4E66\u8FDE\u4E0D\u4E0A"));
        }
        function nextStory() {
          if (storyBusyRef.current) {
            showBubble("\u6B63\u8BB2\u7740\u5462\uFF0C\u542C\u5B8C\u8FD9\u6BB5\u518D\u8BF4\uFF5E", 3e3);
            return;
          }
          const headers = CLIENT_ID ? { "x-client-id": CLIENT_ID } : {};
          fetch("/api/chubby-whale/story/next", { headers }).then((r) => r.json()).then((d) => {
            if (!d || !d.ok) {
              showBubble("\u8BF4\u4E66\u5361\u4F4F\u4E86", 4e3);
              return;
            }
            if (d.done) {
              showBubble("\u4E00\u8F6E\u90FD\u8BB2\u5B8C\u5566\uFF0C\u672C\u9C7C\u4ECE\u5934\u518D\u8BB2\uFF5E", 5e3);
              startStory("");
              return;
            }
            playStoryPiece(d);
          }).catch(() => showBubble("\u8BF4\u4E66\u8FDE\u4E0D\u4E0A"));
        }
        function pumpDueReminders() {
          if (dueTimerRef.current) return;
          if (dueQueueRef.current.length === 0) return;
          if (ttsPlaying || storyNarratingRef.current || busy) {
            dueTimerRef.current = setTimeout(() => {
              dueTimerRef.current = null;
              pumpDueReminders();
            }, 2e3);
            return;
          }
          const item = dueQueueRef.current.shift();
          const body = String(item.text || "").trim() || "\u65F6\u95F4\u5230\u4E86";
          const line = "\u4E3B\u4EBA\uFF0C\u63D0\u9192\u4F60\uFF1A" + body;
          showBubble(line, 8e3);
          animRef.current?.talkFor(3e3);
          try {
            speakText(line);
          } catch (e) {
          }
          dueTimerRef.current = setTimeout(() => {
            dueTimerRef.current = null;
            pumpDueReminders();
          }, 3e3);
        }
        async function runAction(action) {
          setMenu(null);
          if (action === "feed") {
            const r = persona.feed();
            if (r.bowls % 8 === 0) {
              sayLine(persona.line("riceAccount"), 5e3);
              try {
                fetch("/api/chubby-whale/pet?action=feed");
              } catch (e) {
              }
              ;
              return;
            }
            sayLine(r.text + (r.stageUp ? "\uFF08" + r.stage + "\uFF09" : ""), r.stageUp ? 6e3 : 3500);
            animRef.current?.pushHeart();
            try {
              fetch("/api/chubby-whale/pet?action=feed");
            } catch (e) {
            }
            ;
            return;
          }
          if (action === "home") {
            homePos();
            showBubble("\u56DE\u5230\u89D2\u843D\u5566");
            return;
          }
          if (action === "bigger") {
            const s = Math.min(1.4, scale + 0.1);
            setScale(s);
            scaleRef.current = s;
            return;
          }
          if (action === "smaller") {
            const s = Math.max(0.7, scale - 0.1);
            setScale(s);
            scaleRef.current = s;
            return;
          }
          if (action === "hide") {
            setHidden(true);
            return;
          }
          if (action === "version") {
            showBubble("\u80A5\u9CB8 v" + VERSION);
            return;
          }
          if (action === "type") {
            voiceModeRef.current = false;
            setChatOpen(true);
            return;
          }
          if (action === "pause") {
            stopTts();
            stopMelody();
            storyBusyRef.current = false;
            showBubble("\u6B47\u4F1A\u513F\u2026");
            return;
          }
          if (action === "music-stop") {
            stopMelody();
            showBubble("\u505C\u4E0B\u5566");
            return;
          }
          if (action === "tts-stop") {
            stopTts();
            storyBusyRef.current = false;
            showBubble("\u597D\uFF0C\u4E0D\u8BF4\u4E86");
            return;
          }
          if (action === "fishfood") {
            fetch("/api/chubby-whale/fishfood").then((r) => r.json()).then((d) => {
              if (d && d.ok) {
                showBubble("\u9C7C\u7CAE\u8D26\u672C\uFF1A\u804A\u5929 " + d.chatTokens + " tokens\uFF0C\u8BF4\u4E66 " + d.storyTokens + " tokens\uFF0C\u5171 " + d.total, 5e3);
              } else showBubble("\u9C7C\u7CAE\u67E5\u4E0D\u5230");
            }).catch(() => showBubble("\u9C7C\u7CAE\u67E5\u4E0D\u5230"));
            return;
          }
          if (action === "growth") {
            Promise.all([fetch("/api/chubby-whale/growth").then((r) => r.json()), fetch("/api/chubby-whale/state").then((r) => r.json())]).then(([g, s]) => {
              if (g && g.ok) {
                const nx = g.nextExp > 0 ? "\uFF08\u7ECF\u9A8C " + g.exp + "/" + g.nextExp + "\uFF09" : "\uFF08\u6EE1\u7EA7\uFF09";
                const it = s && s.intimacy || 0;
                showBubble("\u6210\u957F\uFF1A" + g.stage + nx + " \xB7 \u4EB2\u5BC6\u5EA6 " + it + "/100", 5e3);
              } else showBubble("\u6210\u957F\u67E5\u4E0D\u5230");
            }).catch(() => showBubble("\u6210\u957F\u67E5\u4E0D\u5230"));
            return;
          }
          if (action === "intimacy") {
            fetch("/api/chubby-whale/state").then((r) => r.json()).then((d) => {
              showBubble("\u4EB2\u5BC6\u5EA6\uFF1A" + (d && d.intimacy || 0) + " / 100");
            }).catch(() => showBubble("\u4EB2\u5BC6\u5EA6\u67E5\u4E0D\u5230"));
            return;
          }
          if (action === "culture-story") {
            startStory("");
            return;
          }
          if (action === "culture-story-next") {
            nextStory();
            return;
          }
          if (action === "story-reset") {
            const book = storyBookRef.current;
            if (!book) {
              showBubble("\u8FD8\u6CA1\u8BB2\u4E66\u5462", 3e3);
              return;
            }
            const headers = CLIENT_ID ? { "x-client-id": CLIENT_ID } : {};
            fetch("/api/chubby-whale/story/reset?book=" + encodeURIComponent(book), { method: "POST", headers }).then((r) => r.json()).then((d) => {
              if (!d || !d.ok) {
                showBubble("\u6CA1\u91CD\u7F6E\u6210\uFF1A" + (d && d.error || "\u63A5\u53E3\u6CA1\u5E94"), 4e3);
                return;
              }
              storyBookRef.current = String(d.book || book);
              showBubble("\u8FD9\u672C\u4E66\u4ECE\u5934\u8BB2\uFF5E", 3e3);
            }).catch(() => showBubble("\u8BF4\u4E66\u8FDE\u4E0D\u4E0A"));
            return;
          }
          if (action === "poem") {
            fetch("/api/chubby-whale/poem").then((r) => r.json()).then((d) => {
              const p = d && d.ok && d.item ? d.item : null;
              if (p) {
                const body = String(p.text || "");
                const author = String(p.author || "\u4F5A\u540D");
                showBubble("\u5FF5\u8BD7\xB7" + p.title + "\uFF08" + author + "\uFF09", 15e3);
                animRef.current?.talkFor(6e3);
                const speech = "\u5FF5\u9996\u8BD7\u2014\u2014" + p.title + "\uFF0C" + (p.dynasty ? p.dynasty + "\uFF0C" : "") + author + "\u3002" + collapsePoemBody(body);
                lastPoemSpeech = speech;
                setNarrating(estimateSpeakMs(speech));
                sayLine(persona.line("poemStart"), 4e3);
                setTimeout(() => {
                  try {
                    speakText(speech, { rate: NARRATION_RATE2, onDone: () => {
                      clearNarrating();
                      sayLine(persona.line("poemDone"), 6e3, { rate: "-8%", pitch: "+15Hz" });
                    } });
                  } catch (e) {
                  }
                }, 600);
              } else showBubble("\u8BD7\u518C\u6CA1\u8BFB\u5230");
            }).catch(() => showBubble("\u8BD7\u518C\u6CA1\u8BFB\u5230"));
            return;
          }
          if (action === "culture-tale") {
            fetch("/api/chubby-whale/culture?type=minsu").then((r) => r.json()).then((d) => {
              if (d && d.ok && d.item) {
                const tp = taleParts(d.item.title);
                const body = collapseText(d.item.text);
                const cut = body.length > 120;
                const shown = cut ? body.slice(0, 120) + "\u2026" : body;
                showBubble("\u8BB2\u6C11\u95F4\u6545\u4E8B\xB7" + tp.title + (tp.book ? "\uFF08\u51FA\u81EA\u300A" + tp.book + "\u300B\uFF09" : ""), 9e3);
                animRef.current?.talkFor(5e3);
                speakText("\u8BB2\u4E2A\u6C11\u95F4\u6545\u4E8B\u2014\u2014" + tp.title + (tp.book ? "\uFF0C\u51FA\u81EA\u300A" + tp.book + "\u300B" : "") + "\u3002" + body.slice(0, 6e3), { rate: NARRATION_RATE2, onDone: () => {
                  showBubble("\u6545\u4E8B\u8BB2\u5B8C\u5566\uFF5E", 5e3);
                  try {
                    speakText("\u8BB2\u5B8C\u5566\uFF5E");
                  } catch (e) {
                  }
                } });
              } else showBubble("\u6545\u4E8B\u6CA1\u8BB2\u6210");
            }).catch(() => showBubble("\u6545\u4E8B\u6CA1\u8BB2\u6210"));
            return;
          }
          if (action === "culture-allusion") {
            fetch("/api/chubby-whale/culture?type=chengyu").then((r) => r.json()).then((d) => {
              if (d && d.ok && d.item) {
                const body = collapseText(d.item.text);
                const cut = body.length > 100;
                showBubble("\u8BB2\u5178\u6545\xB7" + d.item.title + "\uFF08" + (d.item.src || "") + "\uFF09", 9e3);
                animRef.current?.talkFor(5e3);
                speakText("\u8BB2\u4E2A\u5178\u6545\u2014\u2014" + String(d.item.title || "") + "\uFF0C\u51FA\u81EA" + String(d.item.src || "") + "\u3002" + body, { rate: NARRATION_RATE2, onDone: () => {
                  showBubble("\u5178\u6545\u8BB2\u5B8C\u5566\uFF5E", 5e3);
                  try {
                    speakText("\u8BB2\u5B8C\u5566\uFF5E");
                  } catch (e) {
                  }
                } });
              } else showBubble("\u5178\u6545\u6CA1\u8BB2\u6210");
            }).catch(() => showBubble("\u5178\u6545\u6CA1\u8BB2\u6210"));
            return;
          }
          if (action === "culture-idiom") {
            fetch("/api/chubby-whale/culture?type=idiom").then((r) => r.json()).then((d) => {
              if (d && d.ok && d.item) {
                showBubble("\u6210\u8BED\u8FA8\u6790\xB7" + d.item.title, 8e3);
                const sp = String(d.item.title || "") + "\uFF1A" + String(d.item.text || "");
                speakText(sp, { rate: NARRATION_RATE2, onDone: () => {
                  showBubble("\u8FD9\u4E2A\u6210\u8BED\u8BB2\u5B8C\u5566\uFF5E", 5e3);
                  try {
                    speakText("\u8BB2\u5B8C\u5566\uFF5E");
                  } catch (e) {
                  }
                } });
              } else showBubble("\u6CA1\u67E5\u5230");
            }).catch(() => showBubble("\u6CA1\u67E5\u5230"));
            return;
          }
          if (action === "culture-couplet") {
            showBubble("\u5BF9\u8054\u5C0F\u9CB8\u8FD8\u5728\u6574\u7406\uFF0C\u56DE\u5934\u7ED9\u4F60\u51FA\u4E00\u5BF9\uFF5E");
            return;
          }
          if (action.startsWith("music:")) {
            const name = action.slice(6);
            stopTts();
            fetch("/api/chubby-whale/melody?name=" + encodeURIComponent(name)).then((r) => r.json()).then((d) => {
              if (d && d.ok && d.song) {
                const songName = String(d.song.name || "\u8FD9\u9996\u66F2\u5B50");
                const bpm = Number(d.song.bpm) || 100;
                const notes = d.song.notes || [];
                let beats = 0;
                for (const pair of notes) beats += Number(pair[1]) || 1;
                const estSec = Math.round(beats * (60 / Math.max(60, bpm)) * 10) / 10;
                showBubble("\u5F39\u300A" + songName + "\u300B\u266A\uFF08\u7EA6 " + estSec + " \u79D2\uFF09", 6e3);
                playMelody(notes, bpm, () => {
                  showBubble("\u5F39\u5B8C\u5566\uFF5E\u300A" + songName + "\u300B", 6e3);
                  animRef.current?.talkFor(1500);
                  try {
                    window.__chubbyWhale.melodyVoice = { at: Date.now(), requested: true, ok: false, err: "" };
                    speakText("\u5F39\u5B8C\u5566\uFF5E");
                    setTimeout(() => {
                      try {
                        const d2 = window.__chubbyWhale.melodyVoice;
                        if (d2 && !ttsPlaying) d2.err = "TTS \u672A\u5F00\u59CB\uFF08\u53EF\u80FD\u88AB\u6D4F\u89C8\u5668\u62E6\u6216\u5408\u6210\u5931\u8D25\uFF09";
                      } catch (e) {
                      }
                    }, 1200);
                  } catch (e) {
                    try {
                      window.__chubbyWhale.melodyVoice = { requested: false, err: String(e) };
                    } catch (e2) {
                    }
                  }
                });
              } else showBubble("\u8FD9\u9996\u66F2\u5B50\u6CA1\u627E\u5230");
            }).catch(() => showBubble("\u5F39\u7434\u5931\u8D25"));
            return;
          }
          if (action === "endpoint") {
            try {
              const cur = (() => {
                try {
                  return localStorage.getItem("chubby-endpoint") === "ape" ? "ape" : "classic";
                } catch (e) {
                  return "classic";
                }
              })();
              const next = cur === "ape" ? "classic" : "ape";
              localStorage.setItem("chubby-endpoint", next);
              if (voiceRef.current && voiceRef.current.setEndpointMode) voiceRef.current.setEndpointMode(next);
              showBubble(next === "ape" ? "\u7AEF\u70B9\u68C0\u6D4B\uFF1A\u81EA\u9002\u5E94\uFF08\u8BD5\u7528\uFF09" : "\u7AEF\u70B9\u68C0\u6D4B\uFF1A\u7ECF\u5178\uFF08\u7A33\u5B9A\uFF09", 4e3);
            } catch (e) {
              showBubble("\u5207\u6362\u5931\u8D25", 3e3);
            }
            return;
          }
          if (action === "ear-check") {
            try {
              const v = window.__chubbyWhale && window.__chubbyWhale.voice;
              const st = v ? v.stats : null;
              if (!st) {
                showBubble("\u8BED\u97F3\u6A21\u5757\u8FD8\u6CA1\u8D77\u6765\uFF08\u8BED\u97F3\u5F85\u547D\u53EF\u80FD\u662F\u5173\u7684\uFF09", 6e3);
                return;
              }
              const line = "\u8BED\u97F3\u81EA\u68C0\uFF08\u65B0\u6A21\u5757\uFF09\uFF1A" + String(v.status()) + "\n\u5F55\u97F3\u6BB5 " + st.windows + "\uFF5C\u4E0A\u4F20 " + st.uploaded + "\uFF5C\u8BC6\u522B\u51FA\u5B57 " + st.asrTexts + "\uFF5C\u4EA4\u7ED9\u5BF9\u8BDD " + st.heard + "\n\u4E22\uFF1A\u592A\u5B89\u9759 " + st.skippedSilent + "\uFF5C\u56DE\u58F0/\u91CD\u590D " + st.echoDropped + "\uFF5C\u8BC6\u522B\u5931\u8D25 " + st.asrFail + "\n\u53BB\u91CD\uFF1A\u91CD\u590D\u4E22\u5F03 " + (st.dupDropped || 0) + " \u6B21\uFF08\u540C\u4E00\u53E5\u8BDD\u88AB\u5207\u6210\u4E24\u6BB5\u65F6\u7528\uFF09\n\u7AEF\u70B9\u68C0\u6D4B\uFF1A" + (voiceRef.current && voiceRef.current.endpointInfo ? voiceRef.current.endpointInfo().mode === "ape" ? "\u81EA\u9002\u5E94" : "\u7ECF\u5178" : "?") + (function() {
                try {
                  const t = voiceRef.current && voiceRef.current.lastTtsInfo ? voiceRef.current.lastTtsInfo() : null;
                  if (!t) return "";
                  return "\n\u6717\u8BFB\uFF1A\u6700\u540E\u4E00\u6BB5 " + (t.failed ? "\u5931\u8D25" : "\u5DF2\u5F00\u64AD") + "\uFF5C\u6587\u672C\u5F00\u5934\u300C" + t.text + "\u300D";
                } catch (e) {
                  return "";
                }
              })() + (function() {
                try {
                  const s = voiceRef.current && voiceRef.current.lastSegment ? voiceRef.current.lastSegment() : null;
                  if (!s) return "";
                  return "\n\u4E0A\u4E00\u6BB5\uFF1A" + s.mode + "\uFF5C\u7A97\u53E3 " + s.winMs + "ms\uFF5C\u8BF4\u8BDD " + s.peMs + "ms\uFF5C\u9759\u97F3 " + s.quMs + "ms" + (s.floor !== null ? "\uFF5C\u5E95\u566A " + s.floor + "dB" : "") + (s.target ? "\uFF5C\u76EE\u6807 " + s.target + "ms" : "") + "\n\u8BC6\u522B\u7ED3\u679C\uFF1A" + s.text;
                } catch (e) {
                  return "";
                }
              })() + "\n\u6717\u8BFB\uFF1A\u8BF7\u6C42 " + st.ttsRequests + "\uFF5C\u5F00\u64AD " + st.ttsPlayed + "\uFF5C\u5931\u8D25 " + st.ttsFail + "\uFF5C\u50F5\u5C38\u590D\u4F4D " + st.ttsZombie + (st.lastError ? "\n\u6700\u8FD1\u9519\u8BEF\uFF1A" + st.lastError : "");
              showBubble(line, 15e3);
              try {
                navigator.clipboard.writeText(JSON.stringify(st));
              } catch (e) {
              }
            } catch (e) {
              showBubble("\u81EA\u68C0\u5931\u8D25\uFF1A" + String(e && e.message), 5e3);
            }
            return;
          }
          if (action === "chatmode") {
            const nowOn = !voiceChatOnRef.current;
            voiceChatOnRef.current = nowOn;
            setVoiceChatOn(nowOn);
            try {
              localStorage.setItem("chubby-voicechat", nowOn ? "on" : "off");
            } catch (e) {
            }
            showBubble(nowOn ? "\u8BED\u97F3\u804A\u5929\uFF1A\u5F00\uFF0C\u672C\u9CB8\u4F1A\u63A5\u8BDD" : "\u8BED\u97F3\u804A\u5929\uFF1A\u5173\uFF0C\u53EA\u542C\u4E0D\u63A5\u8BDD");
            return;
          }
          if (action === "voice") {
            const nowOn = !voiceOnRef.current;
            voiceOnRef.current = nowOn;
            setVoiceOn(nowOn);
            try {
              localStorage.setItem("chubby-voice", nowOn ? "on" : "off");
            } catch (e) {
            }
            if (!nowOn) stopTts();
            showBubble(nowOn ? "\u8BED\u97F3\u6717\u8BFB\uFF1A\u5F00" : "\u8BED\u97F3\u6717\u8BFB\uFF1A\u5173\uFF08\u7701\u7740\u70B9\u7528\uFF09");
            return;
          }
          if (action === "cache-clear") {
            fetch("/api/chubby-whale/cache", { method: "DELETE" }).then((r) => r.json()).then((d) => showBubble(d && d.ok ? "\u804A\u5929\u7F13\u5B58\u6E05\u7A7A\u5566\uFF08" + (d.cleared || 0) + " \u6761\uFF09" : "\u7F13\u5B58\u6E05\u7A7A\u5931\u8D25", 5e3)).catch(() => showBubble("\u7F13\u5B58\u6E05\u7A7A\u5931\u8D25", 4e3));
            return;
          }
          if (action === "cache-toggle") {
            const nowOn = !chatCacheOnRef.current;
            chatCacheOnRef.current = nowOn;
            setChatCacheOn(nowOn);
            fetch("/api/chubby-whale/cache-toggle", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ enabled: nowOn })
            }).then((r) => r.json()).then((d) => {
              showBubble(d && d.ok ? "\u804A\u5929\u7F13\u5B58\uFF1A" + (d.enabled ? "\u5F00\uFF08\u7701 token\uFF09" : "\u5173\uFF08\u6BCF\u6B21\u91CD\u65B0\u56DE\u7B54\uFF09") : "\u5207\u6362\u5931\u8D25", 5e3);
            }).catch(() => showBubble("\u5207\u6362\u5931\u8D25", 4e3));
            return;
          }
          if (action === "clear-memory") {
            try {
              if (!window.confirm("\u6E05\u9664\u80A5\u9CB8\u5BF9\u4E3B\u4EBA\u7684\u804A\u5929\u8BB0\u5FC6\uFF1F\uFF08\u6210\u957F/\u9C7C\u7CAE/\u8BF4\u4E66\u8BB0\u5F55\u4E0D\u53D7\u5F71\u54CD\uFF09")) return;
              fetch("/api/chubby-whale/clear-memory", { method: "POST" }).then((r) => r.json()).then((d) => {
                if (d && d.ok) {
                  setMessages([]);
                  showBubble("\u8BB0\u5FC6\u6E05\u7A7A\u5566\uFF0C\u6211\u4EEC\u91CD\u65B0\u8BA4\u8BC6\u5427\uFF5E", 4e3);
                } else showBubble("\u6E05\u9664\u5931\u8D25");
              }).catch(() => showBubble("\u6E05\u9664\u5931\u8D25"));
            } catch (e) {
            }
            return;
          }
          if (action === "balance") {
            fetch("/api/chubby-whale/balance").then((r) => r.json()).then((d) => {
              if (d && d.ok && d.balance != null) {
                setBalanceText("\u4F59\u989D \xA5" + d.balance);
                setBalanceLabel("\xA5" + d.balance);
                showBubble("\u4F59\u989D\u8FD8\u6709 " + d.balance + " \u5143", 5e3);
              } else showBubble("\u4F59\u989D\u67E5\u4E0D\u5230");
            }).catch(() => showBubble("\u4F59\u989D\u67E5\u4E0D\u5230"));
            return;
          }
          if (action === "chat-lang:auto" || action === "chat-lang:zh" || action === "chat-lang:en") {
            const cl = action === "chat-lang:en" ? "en" : action === "chat-lang:zh" ? "zh" : "auto";
            try {
              localStorage.setItem("chubby-chatlang", cl);
            } catch {
            }
            showBubble(cl === "en" ? "\u804A\u5929\u8BED\u8A00\uFF1AEnglish" : "\u804A\u5929\u8BED\u8A00\uFF1A\u4E2D\u6587");
            return;
          }
          if (action === "lang:zh" || action === "lang:en") {
            const l = action === "lang:en" ? "en" : "zh";
            try {
              localStorage.setItem("chubby-lang", l);
            } catch {
            }
            setLang(l);
            showBubble(l === "en" ? "Language: English" : "\u754C\u9762\u8BED\u8A00\uFF1A\u4E2D\u6587");
            return;
          }
          if (action === "vision") {
            try {
              const input2 = document.createElement("input");
              input2.type = "file";
              input2.accept = "image/*";
              input2.onchange = async () => {
                try {
                  const file = input2.files && input2.files[0];
                  if (!file) return;
                  if (file.size > 4 * 1024 * 1024) {
                    showBubble("\u56FE\u7247\u592A\u5927\uFF08\u8D85\u8FC7 4MB\uFF09", 4e3);
                    return;
                  }
                  const img0 = await imageToB64(file);
                  const b64 = img0 ? img0.b64 : "";
                  if (!b64) {
                    showBubble("\u56FE\u7247\u8BFB\u4E0D\u51FA\u6765", 4e3);
                    return;
                  }
                  showBubble("\u672C\u9CB8\u770B\u770B\u8FD9\u5F20\u56FE\u2026", 3e3);
                  setChatOpen(false);
                  const hdr = img0 && img0.mime || file.type || "image/jpeg";
                  const tChat = performance.now();
                  const res = await fetch("/api/chubby-whale/chat", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ message: VISION_PROMPT, image: b64, imageMime: hdr }) });
                  const d = await res.json();
                  const reply = d && d.reply || "\u8FD9\u6761\u9C7C\u770B\u4E0D\u61C2\u8FD9\u5F20\u56FE\u2026\u2026";
                  showBubble("\uFF08\u770B\u56FE\uFF09" + reply, 1e4);
                  speakReply(reply);
                } catch (e) {
                  showBubble("\u56FE\u7247\u5904\u7406\u5931\u8D25", 4e3);
                }
              };
              input2.click();
            } catch (e) {
              showBubble("\u6253\u4E0D\u5F00\u6587\u4EF6\u9009\u62E9", 4e3);
            }
            return;
          }
          if (action === "test-tts") {
            showBubble("\u6D4B\u8BD5\u8BED\u97F3\uFF1A\u4E3B\u4EBA\u542C\u5F97\u5230\u5417\uFF1F", 4e3);
            speakText("\u6D4B\u8BD5\u8BED\u97F3\uFF0C\u4E3B\u4EBA\u542C\u5F97\u5230\u5417\uFF1F");
            return;
          }
          if (action.startsWith("voice:")) {
            const v = action.slice(6);
            try {
              localStorage.setItem("chubby-tts-voice", v);
            } catch {
            }
            const shown = v === "auto" ? "\u81EA\u52A8" : v.split("-")[2] || v;
            showBubble("\u97F3\u8272\u6362\u597D\u5566\uFF1A" + shown);
            try {
              const u = new window.SpeechSynthesisUtterance("\u4E3B\u4EBA\uFF0C\u8FD9\u4E2A\u58F0\u97F3\u597D\u542C\u5417\uFF1F");
              window.speechSynthesis.cancel();
              window.speechSynthesis.speak(u);
            } catch (e) {
            }
            return;
          }
          if (action === "remind-add") {
            const msg = window.prompt("\u63D0\u9192\u4EC0\u4E48\uFF1F\uFF08\u53EF\u4EE5\u4E00\u8D77\u8BF4\u65F6\u95F4\uFF0C\u5982\u300C\u660E\u59299\u70B9\u63D0\u9192\u6211\u5F00\u4F1A\u300D\uFF09");
            if (!msg) return;
            let parsed = parseDue(msg);
            if (!parsed) {
              const ans = window.prompt("\u4EC0\u4E48\u65F6\u5019\u63D0\u9192\uFF1F\uFF08\u5982 9\u70B9 / \u660E\u59299\u70B9 / \u534A\u5C0F\u65F6\u540E / 20\u5206\u949F\u540E / \u6BCF\u59299\u70B9\uFF09", "5\u5206\u949F\u540E");
              if (!ans) return;
              parsed = parseDue(ans);
              if (!parsed) {
                showBubble("\u8FD9\u4E2A\u65F6\u95F4\u672C\u9C7C\u6CA1\u542C\u61C2\u2026\u2026\u8BD5\u8BD5\u300C9\u70B9\u300D\u300C\u660E\u59299\u70B9\u300D\u300C\u534A\u5C0F\u65F6\u540E\u300D", 5e3);
                return;
              }
            }
            const text = String(parsed.cleaned || cleanReminderText(msg) || msg).slice(0, 200);
            const dueAt = parsed.at;
            const repeat = parsed.repeat || 0;
            fetch("/api/chubby-whale/reminders", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text, at: dueAt.toISOString(), repeat }) }).then((r) => r.json()).then((d) => {
              if (d && d.ok) {
                const hh = String(dueAt.getHours()).padStart(2, "0");
                const mm = String(dueAt.getMinutes()).padStart(2, "0");
                const whenText = repeat > 0 ? "\u6BCF\u5929 " + hh + ":" + mm : dueAt.getMonth() + 1 + "\u6708" + dueAt.getDate() + "\u65E5 " + hh + ":" + mm;
                showBubble("\u597D\uFF0C" + whenText + " \u63D0\u9192\u4F60\uFF1A" + text, 6e3);
              } else showBubble("\u63D0\u9192\u6CA1\u52A0\u4E0A");
            }).catch(() => showBubble("\u63D0\u9192\u6CA1\u52A0\u4E0A"));
            return;
          }
          if (action === "remind-list") {
            fetch("/api/chubby-whale/reminders").then((r) => r.json()).then((d) => {
              const arr = d && d.reminders || [];
              if (!arr.length) {
                showBubble("\u8FD8\u6CA1\u6709\u63D0\u9192\uFF5E");
                return;
              }
              const txt = arr.map((x) => {
                const when = new Date(x.nextAt || x.at);
                const stamp = isNaN(when.getTime()) ? String(x.at) : when.toLocaleString("zh-CN");
                const rep = Number(x.repeat) > 0 ? "\uFF08\u6BCF\u5929\uFF09" : "";
                return "\xB7 " + x.text + "\uFF08" + stamp + "\uFF09" + rep;
              }).join("\n");
              showBubble(txt, 8e3);
            }).catch(() => showBubble("\u63D0\u9192\u6E05\u5355\u67E5\u4E0D\u5230"));
            return;
          }
          showBubble("\u8FD9\u4E2A\u529F\u80FD\u5C0F\u9CB8\u8FD8\u5728\u5B66\uFF0C\u7A0D\u540E\u52A0\u4E0A\uFF5E");
        }
        function scrollBody() {
          setTimeout(() => {
            const el = bodyRef.current;
            if (el) el.scrollTop = el.scrollHeight;
          }, 0);
        }
        function tryLocalRoute(text) {
          const t0 = String(text || "").trim();
          if (/^(再来|再念|换)(一)?(首|个)/.test(t0)) {
            showBubble("\uFF08\u70B9\u64AD\uFF09\u597D\uFF0C\u518D\u5FF5\u4E00\u9996", 3e3);
            fetch("/api/chubby-whale/poem").then((r) => r.json()).then((d) => {
              const p = d && d.ok && d.item ? d.item : null;
              if (!p) {
                showBubble("\u8BD7\u518C\u6CA1\u8BFB\u5230", 4e3);
                return;
              }
              const body = String(p.text || "");
              showBubble("\u5FF5\u8BD7\xB7" + p.title + "\uFF08" + String(p.author || "\u4F5A\u540D") + "\uFF09", 15e3);
              const speech = "\u5FF5\u9996\u8BD7\u2014\u2014" + p.title + "\uFF0C" + (p.dynasty ? p.dynasty + "\uFF0C" : "") + String(p.author || "\u4F5A\u540D") + "\u3002" + collapsePoemBody(body);
              lastPoemSpeech = speech;
              setNarrating(estimateSpeakMs(speech));
              sayLine(persona.line("poemStart"), 4e3);
              setTimeout(() => {
                try {
                  speakText(speech, { rate: NARRATION_RATE2, onDone: () => {
                    clearNarrating();
                    sayLine(persona.line("poemDone"), 6e3, { rate: "-8%", pitch: "+15Hz" });
                  } });
                } catch (e) {
                }
              }, 600);
            }).catch(() => showBubble("\u8BD7\u518C\u6CA1\u8BFB\u5230", 4e3));
            return true;
          }
          if (/^(继续|接着说|接着讲|往下讲)$/.test(t0)) {
            showBubble("\uFF08\u70B9\u64AD\uFF09\u63A5\u7740\u8BF4", 3e3);
            startStory(storyBookRef.current || "");
            return true;
          }
          const hit = detectIntent(text);
          if (!hit) return false;
          if (hit.kind === "poem") {
            showBubble("\uFF08\u70B9\u64AD\uFF09\u597D\uFF0C\u5FF5\u4E00\u9996", 3e3);
            fetch("/api/chubby-whale/poem" + (hit.title || "" ? "?title=" + encodeURIComponent(hit.title || "") : "")).then((r) => r.json()).then((d) => {
              const p = d && d.ok && d.item ? d.item : null;
              if (!p) {
                showBubble("\u8BD7\u518C\u6CA1\u8BFB\u5230", 4e3);
                return;
              }
              const body = String(p.text || "");
              showBubble("\u5FF5\u8BD7\xB7" + p.title + "\uFF08" + String(p.author || "\u4F5A\u540D") + "\uFF09", 15e3);
              const speech = "\u5FF5\u9996\u8BD7\u2014\u2014" + p.title + "\uFF0C" + (p.dynasty ? p.dynasty + "\uFF0C" : "") + String(p.author || "\u4F5A\u540D") + "\u3002" + collapsePoemBody(body);
              lastPoemSpeech = speech;
              setNarrating(estimateSpeakMs(speech));
              sayLine(persona.line("poemStart"), 4e3);
              setTimeout(() => {
                try {
                  speakText(speech, { rate: NARRATION_RATE2, onDone: () => {
                    clearNarrating();
                    sayLine(persona.line("poemDone"), 6e3, { rate: "-8%", pitch: "+15Hz" });
                  } });
                } catch (e) {
                }
              }, 600);
            }).catch(() => showBubble("\u8BD7\u518C\u6CA1\u8BFB\u5230", 4e3));
            return true;
          }
          if (hit.kind === "culture") {
            const type = hit.sub;
            showBubble(type === "chengyu" ? "\uFF08\u70B9\u64AD\uFF09\u8BB2\u4E2A\u6210\u8BED" : "\uFF08\u70B9\u64AD\uFF09\u8BB2\u4E2A\u5178\u6545", 3e3);
            fetch("/api/chubby-whale/culture?type=" + type).then((r) => r.json()).then((d) => {
              const it = d && d.ok && d.item ? d.item : null;
              if (!it) {
                showBubble("\u8FD9\u4E2A\u6CA1\u8BFB\u5230", 4e3);
                return;
              }
              const body = collapseText(String(it.text || ""));
              showBubble((type === "chengyu" ? "\u6210\u8BED\xB7" : "\u5178\u6545\xB7") + String(it.title || ""), 15e3);
              speakText((type === "chengyu" ? "\u8BB2\u4E2A\u6210\u8BED\u2014\u2014" : "\u8BB2\u4E2A\u5178\u6545\u2014\u2014") + String(it.title || "") + (it.src ? "\uFF0C\u51FA\u81EA" + String(it.src) : "") + "\u3002" + body, { rate: NARRATION_RATE2 });
            }).catch(() => showBubble("\u8FD9\u4E2A\u6CA1\u8BFB\u5230", 4e3));
            return true;
          }
          const book = hit.book || "";
          showBubble("\uFF08\u70B9\u64AD\uFF09" + (book ? "\u8BB2\u300A" + book + "\u300B" : "\u8BB2\u4E00\u6BB5\u4E66"), 4e3);
          storyAutoRef.current = true;
          startStory(book);
          return true;
        }
        async function tryStreamChat(text, opts) {
          try {
            if (localStorage.getItem("chubby-stream") === "off") return false;
          } catch (e) {
          }
          let spokeAny = false;
          let full = "";
          let tail = "";
          let ctl = null;
          try {
            ctl = typeof AbortController !== "undefined" ? new AbortController() : null;
          } catch (e) {
            ctl = null;
          }
          const firstTimer = setTimeout(() => {
            try {
              if (!spokeAny && ctl) ctl.abort();
            } catch (e) {
            }
          }, 4e3);
          const startedAt = Date.now();
          let bubbleAt = 0;
          const flush = (force) => {
            if (!tail) return;
            const m = tail.match(/[\s\S]*?[。！？!?；;\n]/);
            if (m && m[0].length >= 2) {
              const seg = m[0].trim();
              tail = tail.slice(m[0].length);
              if (seg) {
                try {
                  speakText(seg, { rate: "+0%" });
                } catch (e) {
                }
                ;
                spokeAny = true;
              }
              return flush(false);
            }
            if (force || tail.length >= 40) {
              const seg = tail.trim();
              tail = "";
              if (seg) {
                try {
                  speakText(seg, { rate: "+0%" });
                } catch (e) {
                }
                ;
                spokeAny = true;
              }
            }
          };
          try {
            const res = await fetch("/api/chubby-whale/chat-stream", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ message: text, lang: "auto", voice: !!(opts && opts.voice) }),
              signal: ctl ? ctl.signal : void 0
            });
            if (!res.ok || !res.body) {
              clearTimeout(firstTimer);
              return false;
            }
            const reader = res.body.getReader();
            const dec = new TextDecoder();
            let buf = "";
            setBusy(true);
            busyAtRef.current = Date.now();
            for (; ; ) {
              const { value, done } = await reader.read();
              if (done) break;
              buf += dec.decode(value, { stream: true });
              const parsed = parseSseBuffer(buf);
              buf = parsed.rest;
              for (const obj of parsed.events) {
                if (obj.error) {
                  throw new Error(String(obj.error));
                }
                if (typeof obj.delta === "string" && obj.delta) {
                  full += obj.delta;
                  tail += obj.delta;
                  clearTimeout(firstTimer);
                  flush(false);
                  const nowT = Date.now();
                  if (nowT - bubbleAt > 400) {
                    bubbleAt = nowT;
                    showBubble(full.slice(-60), 3e3);
                  }
                }
                if (obj.done) {
                  const reply = String(obj.reply || full || "").trim();
                  full = reply || full;
                  if (reply) {
                    const rpPlain = reply.replace(/[\s。，！？,.!?、…~～]/g, "");
                    const now2 = Date.now();
                    const dup = lastReplyText && lastReplyAt && now2 - lastReplyAt < 3e4 && rpPlain === lastReplyText;
                    if (!dup) {
                      lastReplyText = rpPlain;
                      lastReplyAt = now2;
                      flush(true);
                      setBusy(false);
                      setMessages((m) => [...m, { who: "fish", text: reply }]);
                      showBubble(reply, 6e3);
                      animRef.current?.talkFor(1500);
                      scrollBody();
                      try {
                        window.__chubbyWhale.lastChat = { stage: "stream-done", firstDeltaMs: obj.firstDeltaMs || 0, ms: obj.ms || 0, cached: !!obj.cached, reply: reply.slice(0, 40) };
                      } catch (e) {
                      }
                    }
                  }
                  clearTimeout(firstTimer);
                  setBusy(false);
                  return true;
                }
              }
            }
            clearTimeout(firstTimer);
            flush(true);
            setBusy(false);
            if (full) {
              setMessages((m) => [...m, { who: "fish", text: full }]);
              showBubble(full, 6e3);
              scrollBody();
            }
            return true;
          } catch (e) {
            clearTimeout(firstTimer);
            setBusy(false);
            if (spokeAny) {
              flush(true);
              try {
                window.__chubbyWhale.streamFallback = String(e && e.message || e);
              } catch (e2) {
              }
              return true;
            }
            return false;
          }
        }
        async function sendText(rawText, opts) {
          const text = String(rawText || "").trim();
          if (!text) return;
          try {
            window.__chubbyWhale.ttsSkip = "empty-text";
          } catch (e) {
          }
          try {
            window.__chubbyWhale.lastChat = { stage: "entry", busy: !!busy, tts: !!ttsPlaying, at: Date.now() };
          } catch (e) {
          }
          if (busy) {
            try {
              window.__chubbyWhale.lastChat.stage = "blocked-busy";
            } catch (e) {
            }
          }
          if (busy && Date.now() - busyAtRef.current < 35e3) {
            if (opts && opts.voice) showBubble("\u672C\u9CB8\u8FD8\u5728\u60F3\u4E0A\u4E00\u53E5\u5462\uFF0C\u7A0D\u7B49\uFF5E", 2500);
            return;
          }
          if (storyNarratingRef.current || ttsPlaying) {
            try {
              stopTts();
            } catch (e) {
            }
            storyNarratingRef.current = false;
            try {
              storyBusyRef.current = false;
            } catch (e) {
            }
          }
          if (tryLocalRoute(text)) {
            setInput("");
            return;
          }
          try {
            if (await tryStreamChat(text, opts)) {
              setInput("");
              return;
            }
          } catch (e) {
          }
          const myEpoch = ++chatEpoch;
          try {
            const hit = persona.reactTo(text);
            if (hit) {
              sayLine(hit.text, 4e3);
              if (hit.event === "praise") animRef.current?.pushHeart();
            }
          } catch (e) {
          }
          setInput("");
          setMessages((m) => [...m, { who: "me", text }]);
          try {
            if (opts && opts.voice && !ttsPlaying && Math.random() < 0.25) sayLine(persona.line("waiting"), 3e3);
          } catch (e) {
          }
          setBusy(true);
          busyAtRef.current = Date.now();
          animRef.current?.talkFor(1200);
          scrollBody();
          let data = null;
          try {
            const tChat = performance.now();
            const res = await fetch("/api/chubby-whale/chat", {
              // 30 秒上限：请求卡住时别让状态永远停在「在想…」
              signal: typeof AbortSignal !== "undefined" && AbortSignal.timeout ? AbortSignal.timeout(3e4) : void 0,
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ message: text, voice: true, lang: (() => {
                try {
                  return localStorage.getItem("chubby-chatlang") || "auto";
                } catch (e) {
                  return "auto";
                }
              })() })
            });
            data = await res.json();
            try {
              latDiag.chatMs = Math.round(performance.now() - tChat);
              latDiag.updates++;
            } catch (e) {
            }
            if (myEpoch !== chatEpoch) return;
            const reply = data?.reply || "\u4E3B\u4EBA\u2026\u2026\u672C\u9CB8\u8D70\u795E\u4E86\u3002";
            try {
              window.__chubbyWhale.lastChat = { stage: "fetched", reply: String(reply).slice(0, 40), at: Date.now() };
            } catch (e) {
            }
            setMessages((m) => [...m, { who: "fish", text: reply }]);
            if (voiceModeRef.current) {
              showBubble("\uFF08\u8BF4\uFF09" + reply, 8e3);
            }
            if (data && data.upgraded) showBubble("\u672C\u9CB8\u53C8\u957F\u5927\u4E00\u70B9\u5566\uFF01", 4e3);
          } catch {
            setMessages((m) => [...m, { who: "fish", text: persona.line("error") }]);
          } finally {
            setBusy(false);
            animRef.current?.talkFor(1500);
            try {
              if (data && data.reply && myEpoch === chatEpoch) {
                const rp = String(data.reply);
                try {
                  window.__chubbyWhale.lastChat = { stage: "speak", reply: rp.slice(0, 40), at: Date.now() };
                } catch (e) {
                }
                speakReply(rp);
              }
            } catch {
            }
            scrollBody();
          }
        }
        R.useEffect(() => {
          try {
            const w = window.__chubbyWhale || (window.__chubbyWhale = {});
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
            w.busyNow = () => ({ busy: busyRef.current, age: Date.now() - busyAtRef.current, tts: ttsPlaying });
          } catch (e) {
          }
        }, []);
        R.useEffect(() => {
          const timer = setInterval(() => {
            fetch("/api/chubby-whale/reminders?action=due").then((r) => r.json()).then((d) => {
              const due = d && d.due || [];
              for (const it of due) {
                if (it && it.text) dueQueueRef.current.push(it);
              }
              pumpDueReminders();
            }).catch(() => {
            });
          }, 2e4);
          return () => clearInterval(timer);
        }, []);
        const voiceRef = R.useRef(null);
        R.useEffect(() => {
          if (!earOnRef.current) return;
          const v = createVoice({
            onHeard: (text) => {
              try {
                voiceModeRef.current = true;
              } catch (e) {
              }
              try {
                if (Date.now() < narrateUntil) {
                  if (/停|别念|不念|够了|算了|打住/.test(String(text || ""))) {
                    try {
                      stopTts();
                    } catch (e) {
                    }
                    clearNarrating();
                    showBubble("\u597D\uFF0C\u4E0D\u5FF5\u4E86", 2500);
                  } else {
                    try {
                      window.__chubbyWhale.narrDrop = (window.__chubbyWhale.narrDrop || 0) + 1;
                    } catch (e) {
                    }
                  }
                  return;
                }
              } catch (e) {
              }
              try {
                showBubble("\uFF08\u542C\u5230\uFF09" + text + "\uFF5C\u672C\u9C7C\u5728\u60F3\u2026", 3e3);
              } catch (e) {
              }
              try {
                sendText(text, { voice: true });
              } catch (e) {
              }
            },
            onStatus: (st) => {
              ttsPlaying = st === "speaking";
              if (ttsPlaying) {
                try {
                  lastSpeakingAt = Date.now();
                } catch (e) {
                }
              }
            },
            onDiag: (d) => {
              try {
                window.__chubbyWhale.voiceDiag = d;
              } catch (e) {
              }
            },
            // 念诗/说书：气泡跟着当前句走，主人能看到"念到哪了"
            onSegment: (seg) => {
              try {
                if (!storyNarratingRef.current) return;
                const t = String(seg || "").replace(/^念首诗——/, "").trim();
                if (t) showBubble(t, 8e3);
              } catch (e) {
              }
            }
          });
          voiceRef.current = v;
          try {
            const w = window.__chubbyWhale || (window.__chubbyWhale = {});
            w.voice = v;
          } catch (e) {
          }
          void v.start();
          return () => {
            try {
              v.stop();
            } catch (e) {
            }
            ;
            voiceRef.current = null;
          };
        }, []);
        function speakText(text, o) {
          try {
            if (localStorage.getItem("chubby-voice") === "off") {
              try {
                window.__chubbyWhale.ttsSkip = "voice-off";
              } catch (e) {
              }
              ;
              return;
            }
          } catch (e) {
          }
          try {
            if (voiceRef.current) voiceRef.current.speak(text, o);
          } catch (e) {
          }
        }
        function stopTts() {
          clearNarrating();
          try {
            if (voiceRef.current) voiceRef.current.stopSpeaking();
          } catch (e) {
          }
        }
        function muteMic() {
          try {
            if (voiceRef.current) voiceRef.current.mute(true);
          } catch (e) {
          }
        }
        function unmuteMic() {
          try {
            if (voiceRef.current) voiceRef.current.mute(false);
          } catch (e) {
          }
        }
        function prefetchFiller() {
        }
        function prefetchNextTts() {
        }
        function sayLine(text, ms = 3500, voiceOpts) {
          const norm = String(text || "").replace(/[\\s。，！？,.!?、…~～]/g, "");
          const nowL = Date.now();
          if (norm && norm === lastLineNorm && nowL - lastLineAt < 25e3) {
            try {
              window.__chubbyWhale.dupLine = (window.__chubbyWhale.dupLine || 0) + 1;
            } catch (e) {
            }
            ;
            return;
          }
          lastLineNorm = norm;
          lastLineAt = nowL;
          if (!text) return;
          try {
            showBubble(text, ms);
          } catch (e) {
          }
          try {
            if (localStorage.getItem("chubby-voice") === "off") return;
            const v = voiceRef.current;
            if (v && v.speak && !v.speaking()) v.speak(text, { rate: voiceOpts && voiceOpts.rate || "+0%", pitch: voiceOpts && voiceOpts.pitch || "" });
          } catch (e) {
          }
        }
        function speakReply(text) {
          const rp = String(text || "");
          if (!rp.trim()) return;
          const rpPlain = rp.replace(/[\s。，！？,.!?、…~～]/g, "");
          const now = Date.now();
          if (lastReplyText && lastReplyAt && now - lastReplyAt < 3e4 && rpPlain === lastReplyText) {
            try {
              window.__chubbyWhale.dupReply = (window.__chubbyWhale.dupReply || 0) + 1;
            } catch (e) {
            }
            return;
          }
          lastReplyText = rpPlain;
          lastReplyAt = now;
          speakText(rp, { rate: rp.length >= 80 ? NARRATION_RATE2 : "+0%" });
        }
        R.useEffect(() => {
          const canvas = canvasRef.current;
          if (!canvas) return;
          animRef.current = createAnimator({ canvas, imgSrc: "/api/chubby-whale/asset", cw: CW, ch: CH, sx: SX, sy: SY, state: talkRef.current });
          animRef.current.start();
          return () => animRef.current?.stop();
        }, []);
        function renderItems(items) {
          const out = [];
          for (let i = 0; i < items.length; i++) {
            const it = items[i];
            if (it.type === "sep") {
              out.push(h("div", { key: "sep" + i, style: { height: 1, background: "#1f4a85", margin: "4px 0" } }));
              continue;
            }
            if (it.type === "sub") {
              const open = subOpen === it.label;
              out.push(h("div", {
                key: "sub" + i,
                style: { padding: "6px 14px", cursor: "pointer", display: "flex", justifyContent: "space-between", color: "#cfe9ff", fontSize: 13 },
                onClick: () => setSubOpen(open ? "" : it.label)
              }, h("span", null, tr(it.label, lang)), h("span", null, open ? "\u25BE" : "\u25B8")));
              if (open) out.push(h("div", { key: "subitems" + i, style: { paddingLeft: 14, borderLeft: "1px solid #1f4a85", marginLeft: 8 } }, renderItems(it.items)));
              continue;
            }
            out.push(h("div", {
              key: "item" + i,
              style: { padding: "6px 14px", cursor: "pointer", color: "#cfe9ff", fontSize: 13, whiteSpace: "nowrap" },
              onClick: () => runAction(it.action)
            }, tr(it.label, lang)));
          }
          return out;
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
          h("div", { ref: bubbleRef, className: "chubby-bubble" }, h("div", { ref: bubbleTextRef })),
          menu ? h(
            "div",
            { style: menuStyle(menu), "data-menu-root": "1" },
            h(
              "div",
              { style: { padding: "8px 14px", borderBottom: "1px solid #1f4a85", color: "#9FD8FF", fontSize: 12, display: "flex", justifyContent: "space-between" } },
              // 标题栏：左边「名字 · 版本号」，右边余额（点一下刷新）；菜单最下面仍按规矩显示版本号
              h("span", null, (lang === "en" ? "Fat Whale \xB7 v" : "\u80A5\u9CB8 \xB7 v") + VERSION),
              h("span", {
                style: { color: "#FFD166", cursor: "pointer" },
                title: lang === "en" ? "Click to refresh balance" : "\u70B9\u4E00\u4E0B\u5237\u65B0\u4F59\u989D",
                onClick: () => {
                  try {
                    refreshBalance();
                  } catch (e) {
                  }
                }
              }, balanceText || "--")
            ),
            renderItems(buildMenu(VERSION, { voiceOn, earOn, voiceChatOn, chatCacheOn, ttsVoice: (() => {
              try {
                return localStorage.getItem("chubby-tts-voice") || "zh-CN-XiaoyiNeural";
              } catch (e) {
                return "zh-CN-XiaoyiNeural";
              }
            })(), chatLang: (() => {
              try {
                return localStorage.getItem("chubby-chatlang") || "auto";
              } catch (e) {
                return "auto";
              }
            })(), balance: balanceLabel, growth: growthLabel }))
          ) : null,
          h(
            "div",
            { style: chatPanelStyle(chatOpen) },
            h(
              "div",
              { style: headStyle },
              h("span", null, lang === "en" ? "Fat Whale \xB7 Chat" : "\u80A5\u9CB8 \xB7 \u804A\u5929"),
              h("span", { style: { cursor: "pointer", color: "#9FD8FF", padding: "0 4px" }, onClick: () => setChatOpen(false) }, "\u2715")
            ),
            h(
              "div",
              { ref: bodyRef, style: bodyStyle },
              messages.length === 0 ? h("div", { style: msgStyle("fish") }, "\u4E3B\u4EBA\uFF0C\u70B9\u6211\u8BF4\u8BDD\uFF0C\u672C\u9CB8\u5728\u53F3\u4E0B\u89D2\u5F85\u7740\uFF5E") : messages.map((m, i) => h("div", { key: i, style: msgStyle(m.who) }, m.text))
            ),
            h(
              "div",
              { style: inputRowStyle },
              h("input", {
                style: inputStyle,
                placeholder: lang === "en" ? "Say something\u2026" : "\u8DDF\u80A5\u9CB8\u8BF4\u4E24\u53E5\u2026",
                value: input,
                onChange: (e) => setInput(e.target.value),
                onKeyDown: (e) => {
                  if (e.nativeEvent && e.nativeEvent.isComposing) return;
                  if (e.key === "Enter" && input.trim()) {
                    sendText(input);
                    setInput("");
                  }
                }
              }),
              h("button", { style: sendStyle, onClick: () => {
                if (input.trim()) sendText(input);
                setInput("");
              } }, busy ? "\u2026" : lang === "en" ? "Send" : "\u53D1\u9001")
            )
          )
        );
      }
      return {
        name: "dsh-chubby-whale-client",
        inject: ["slots"],
        apply(ctx) {
          const diag = window.__chubbyWhale = {
            version: VERSION,
            applied: true,
            hasCtx: !!ctx,
            hasSlots: !!(ctx && ctx.slots),
            lat: latDiag,
            ch: { mic: channels.mic.stats, asr: channels.asr.stats, speak: channels.speak.stats },
            registered: false,
            error: null
          };
          try {
            const slots = ctx && ctx.slots;
            if (!slots) {
              diag.error = "ctx.slots \u4E0D\u5B58\u5728\uFF08inject \u672A\u751F\u6548\uFF09";
              console.warn("[chubby-whale]", diag.error);
              return;
            }
            const desc = { name: "shell.overlay", id: "chubby-whale-overlay", order: 999, locale: "chubby-whale", inject: () => ({}) };
            const render = WhaleOverlay;
            const doRegister = () => {
              try {
                slots.register(desc, render);
                diag.registered = true;
                console.log("[chubby-whale] overlay \u5DF2\u6CE8\u518C");
              } catch (e) {
                diag.error = "register \u5931\u8D25: " + String(e);
                console.error("[chubby-whale] overlay \u6CE8\u518C\u5931\u8D25\uFF1A", e);
              }
            };
            try {
              slots.inject("shell.overlay", doRegister);
              setTimeout(() => {
                if (!diag.registered) doRegister();
              }, 1200);
            } catch (e) {
              diag.error = "inject \u5931\u8D25: " + String(e);
              console.error("[chubby-whale] overlay \u6CE8\u5165\u5931\u8D25\uFF1A", e);
              doRegister();
            }
          } catch (e) {
            diag.error = "apply \u5F02\u5E38: " + String(e);
            console.error("[chubby-whale] apply \u5F02\u5E38\uFF1A", e);
          }
        }
      };
    }
  });
})();
