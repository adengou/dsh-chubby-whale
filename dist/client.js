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
    "\u4E2D\u6587": "\u4E2D\u6587",
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
      { type: "item", label: "\u5582\u5B83\u4E00\u53E3", action: "feed" },
      { type: "item", label: "\u770B\u5F20\u56FE\u2026", action: "vision" },
      { type: "sep" },
      { type: "sub", label: "\u5F39\u9996\u66F2\u5B50 \u25B8", items: MELODIES.map((m) => ({ type: "item", label: "\u5F39\u300A" + m + "\u300B", action: "music:" + m })) },
      { type: "item", label: "\u505C\u6B62\u5F39\u594F", action: "music-stop" },
      { type: "sep" },
      { type: "item", label: "\u6253\u5B57\u8BF4\u4E24\u53E5", action: "type" },
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
      { type: "item", label: "\u8BED\u97F3\u5F85\u547D\uFF1A" + (earOn ? "\u5F00" : "\u5173"), action: "wake" },
      { type: "item", label: "\u8BED\u97F3\u804A\u5929\uFF1A" + (voiceChatOn ? "\u5F00" : "\u5173"), action: "chatmode" },
      { type: "item", label: "\u505C\u4E0B\u6B47\u4F1A\u513F", action: "pause" },
      { type: "item", label: "\u56DE\u5230\u53F3\u4E0B\u89D2", action: "home" },
      { type: "item", label: "\u957F\u5927\u4E00\u70B9", action: "bigger" },
      { type: "item", label: "\u53D8\u5C0F\u4E00\u70B9", action: "smaller" },
      { type: "sep" },
      { type: "item", label: "\u52A0\u4E2A\u63D0\u9192\u2026", action: "remind-add" },
      { type: "item", label: "\u63D0\u9192\u6E05\u5355\u2026", action: "remind-list" },
      { type: "sep" },
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
      { type: "item", label: "\u6E05\u9664\u8BB0\u5FC6\u2026", action: "clear-memory" },
      { type: "item", label: "\u6E05\u7A7A\u804A\u5929\u7F13\u5B58\u2026", action: "cache-clear" },
      { type: "item", label: chatCacheOn ? "\u804A\u5929\u7F13\u5B58\uFF1A\u5F00" : "\u804A\u5929\u7F13\u5B58\uFF1A\u5173", action: "cache-toggle" },
      { type: "item", label: "\u8BA9\u5B83\u6E38\u8D70\uFF08\u9000\u51FA\uFF09", action: "hide" },
      { type: "sep" },
      { type: "item", label: "\u9C7C\u7CAE\u8D26\u672C", action: "fishfood" },
      { type: "item", label: "\u6210\u957F\uFF1A" + growthText, action: "growth" },
      { type: "item", label: "\u7248\u672C\uFF1Av" + version, action: "version" }
    ];
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
      const b64 = await readFileAsBase64(file);
      if (!b64) {
        bubble("\u56FE\u7247\u8BFB\u4E0D\u51FA\u6765\uFF0C\u518D\u62D6\u4E00\u6B21\u8BD5\u8BD5", 4e3);
        return { ok: false, kind: "error", error: "empty image" };
      }
      try {
        const reply0 = await post({ message: VISION_PROMPT, image: b64, imageMime: file.type || "image/jpeg" });
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

  // src/shared/tts.ts
  function isValidRate(s) {
    return typeof s === "string" && /^[+-]\d{1,2}%$/.test(s.trim());
  }
  function normalizeRate(s, defaultRate = "+0%") {
    return isValidRate(s) ? String(s).trim() : defaultRate;
  }
  function splitTtsSegments(text, maxLen = 80) {
    const t = String(text || "").trim();
    if (!t) return [];
    const limit = Math.max(8, Math.floor(Number(maxLen) || 80));
    const firstMax = Math.min(limit, 14);
    const boundary = /[。！？!?；;…，,、\n\r]/;
    const out = [];
    let start = 0;
    while (start < t.length) {
      const cap = out.length === 0 ? firstMax : limit;
      let end = Math.min(t.length, start + cap);
      if (end < t.length) {
        const minCut = Math.max(2, Math.floor(cap / 3));
        let cut = -1;
        for (let i = end - 1; i >= start + minCut; i--) {
          if (boundary.test(t[i])) {
            cut = i + 1;
            break;
          }
        }
        if (cut > start) end = cut;
        const code = t.charCodeAt(end - 1);
        if (code >= 55296 && code <= 56319 && end - 2 > start) end -= 1;
      }
      out.push(t.slice(start, end));
      start = end;
    }
    return out;
  }
  function isEmojiCodePoint(code) {
    return code >= 126976 && code <= 129791 || code >= 9728 && code <= 10175 || code >= 11008 && code <= 11263 || code >= 65024 && code <= 65039 || code === 8205 || code === 8419;
  }
  function cleanTtsText(raw) {
    const s = String(raw == null ? "" : raw);
    let out = "";
    for (const ch of s) {
      const code = ch.codePointAt(0) || 0;
      if (code < 32 && code !== 10 && code !== 9 || code === 127) continue;
      if (ch === "*" || ch === "#" || ch === "`" || ch === "~" || ch === ">" || ch === "|") continue;
      if (isEmojiCodePoint(code)) continue;
      out += ch === "\n" || ch === "	" || ch === "\r" ? " " : ch;
    }
    return out.replace(/\s+/g, " ").trim();
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
      let ttsAudioRef = null;
      let ttsUrl = "";
      let ttsEpoch = 0;
      let ttsJobSeq = 0;
      let ttsGroupSeq = 0;
      const ttsQueue = [];
      const ttsPrefetch = /* @__PURE__ */ new Map();
      let ttsPlaying = false;
      let chatEpoch = 0;
      let asrBusy = false;
      const storyNarratingRef = { current: false };
      const earDiag = { db: 0, noiseDb: -60, onsetDb: -50, speechMs: 0, quietMs: 0, calibrating: true, drops: 0, echoDrops: 0, asrMs: 0 };
      const ECHO_MUTE_MS = 700;
      const echoMuteUntil = { t: 0 };
      const spokenRecent = [];
      function noteSpoken(text) {
        try {
          const s = String(text || "").trim();
          if (!s) return;
          spokenRecent.push({ text: s, at: Date.now() });
          while (spokenRecent.length > 6) spokenRecent.shift();
        } catch (e) {
        }
      }
      function looksLikeEcho(heard) {
        try {
          const norm = (s) => String(s || "").replace(/[\s，。、；：！？,.!?;:（）()「」“”"'’"…—-]/g, "");
          const h2 = norm(heard);
          if (h2.length < 4) return false;
          const now = Date.now();
          for (const rec of spokenRecent) {
            if (now - rec.at > 15e3) continue;
            const r = norm(rec.text);
            if (!r) continue;
            if (r.indexOf(h2) >= 0 || h2.indexOf(r) >= 0) return true;
            let hit = 0;
            for (const ch of h2) if (r.indexOf(ch) >= 0) hit++;
            if (hit / h2.length >= 0.6) return true;
          }
          return false;
        } catch (e) {
          return false;
        }
      }
      let ttsCurrentJob = null;
      let ttsPauseUntil = 0;
      let ttsPauseTimer = null;
      function currentVoice() {
        try {
          return localStorage.getItem("chubby-tts-voice") || "zh-CN-XiaoyiNeural";
        } catch (e) {
          return "zh-CN-XiaoyiNeural";
        }
      }
      function finishTtsJob(job) {
        if (!job || !job.onDone) return;
        const cb = job.onDone;
        job.onDone = void 0;
        try {
          cb();
        } catch (e) {
        }
      }
      function speakWithBrowserTts(job) {
        try {
          const ss = window.speechSynthesis;
          const Us = window.SpeechSynthesisUtterance;
          if (!ss || !Us) return Promise.resolve(null);
          const u = new Us(String(job.text || "").slice(0, 300));
          u.lang = /[\u4e00-\u9fa5]/.test(job.text) ? "zh-CN" : "en-US";
          return new Promise((resolve) => {
            let done = false;
            const finish = () => {
              if (!done) {
                done = true;
                resolve(null);
              }
            };
            u.onend = finish;
            u.onerror = finish;
            try {
              ss.cancel();
              ss.speak(u);
            } catch (e) {
              finish();
            }
            setTimeout(finish, 12e3);
          });
        } catch (e) {
          return Promise.resolve(null);
        }
      }
      function fetchTts(job) {
        try {
          return fetch("/api/chubby-whale/tts", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ text: job.text, voice: currentVoice(), rate: job.rate })
          }).then((r) => {
            const ct = String(r.headers && r.headers.get && r.headers.get("content-type") || "");
            if (r.status === 501 || ct.indexOf("application/json") >= 0) throw new Error("TTS_UNAVAILABLE");
            if (!r.ok) throw new Error("tts http " + r.status);
            return r.arrayBuffer();
          }).catch((err) => {
            if (String(err && err.message || err).indexOf("TTS_UNAVAILABLE") >= 0) return speakWithBrowserTts(job);
            return null;
          });
        } catch (e) {
          return Promise.resolve(null);
        }
      }
      let fillerBuf = null;
      let fillerLoading = false;
      function prefetchFiller() {
        if (fillerBuf || fillerLoading) return;
        try {
          if (localStorage.getItem("chubby-voice") === "off") return;
        } catch (e) {
        }
        fillerLoading = true;
        try {
          fetch("/api/chubby-whale/tts", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ text: "\u55EF\uFF0C\u672C\u9C7C\u5728\u542C\u3002", voice: (function() {
              try {
                return localStorage.getItem("chubby-tts-voice") || "zh-CN-XiaoyiNeural";
              } catch (e) {
                return "zh-CN-XiaoyiNeural";
              }
            })() })
          }).then((r) => r.ok ? r.arrayBuffer() : null).then((b) => {
            if (b && b.byteLength > 1e3) fillerBuf = b;
          }).catch(() => {
          }).finally(() => {
            fillerLoading = false;
          });
        } catch (e) {
          fillerLoading = false;
        }
      }
      function playFiller() {
        try {
          if (!fillerBuf) {
            prefetchFiller();
            return;
          }
          const url = URL.createObjectURL(new Blob([fillerBuf], { type: "audio/mpeg" }));
          const a = new Audio(url);
          a.volume = 0.9;
          a.onended = () => {
            try {
              URL.revokeObjectURL(url);
            } catch (e) {
            }
          };
          a.play().catch(() => {
            try {
              URL.revokeObjectURL(url);
            } catch (e) {
            }
          });
        } catch (e) {
        }
      }
      function prefetchNextTts() {
        const next = ttsQueue[0];
        if (!next) return;
        if (!ttsPrefetch.has(next.id)) ttsPrefetch.set(next.id, fetchTts(next));
      }
      function stopTts() {
        try {
          ttsEpoch++;
          ttsPauseUntil = 0;
          if (ttsPauseTimer) {
            try {
              clearTimeout(ttsPauseTimer);
            } catch (e) {
            }
            ;
            ttsPauseTimer = null;
          }
          while (ttsQueue.length > 0) finishTtsJob(ttsQueue.shift());
          if (ttsCurrentJob) {
            finishTtsJob(ttsCurrentJob);
            ttsCurrentJob = null;
          }
          ttsPrefetch.clear();
          const a = ttsAudioRef;
          ttsAudioRef = null;
          if (a) {
            try {
              a.onended = null;
              a.onerror = null;
            } catch (e) {
            }
            try {
              a.pause();
            } catch (e) {
            }
            try {
              a.currentTime = 0;
            } catch (e) {
            }
          }
          if (ttsUrl) {
            try {
              URL.revokeObjectURL(ttsUrl);
            } catch (e) {
            }
            ;
            ttsUrl = "";
          }
          ttsPlaying = false;
          echoMuteUntil.t = Date.now() + ECHO_MUTE_MS;
          try {
            const ss = window.speechSynthesis;
            if (ss && ss.speaking) ss.cancel();
          } catch (e) {
          }
        } catch (e) {
          ttsPlaying = false;
        }
      }
      function speakText(text, opts) {
        try {
          if (!text) return;
          try {
            if (localStorage.getItem("chubby-voice") === "off") return;
          } catch (e) {
          }
          const clean = cleanTtsText(text);
          if (!clean) return;
          const rate = normalizeRate(opts && opts.rate, "+0%");
          const narration = opts && typeof opts.narration === "boolean" ? opts.narration : rate === "-15%";
          const segs = splitTtsSegments(clean, 80);
          const group = ++ttsGroupSeq;
          for (let i = 0; i < segs.length; i++) {
            ttsQueue.push({
              id: ++ttsJobSeq,
              group,
              text: segs[i],
              rate,
              narration,
              onDone: i === segs.length - 1 ? opts && opts.onDone : void 0
            });
          }
          prefetchNextTts();
          playNextTts();
        } catch (e) {
        }
      }
      function playNextTts() {
        if (ttsPlaying) return;
        if (ttsQueue.length === 0) return;
        const wait = ttsPauseUntil - Date.now();
        if (wait > 0) {
          if (!ttsPauseTimer) {
            ttsPauseTimer = setTimeout(() => {
              ttsPauseTimer = null;
              playNextTts();
            }, wait);
          }
          return;
        }
        const epoch = ttsEpoch;
        const job = ttsQueue.shift();
        ttsPlaying = true;
        ttsCurrentJob = job;
        try {
          const pending = ttsPrefetch.get(job.id) || fetchTts(job);
          ttsPrefetch.delete(job.id);
          prefetchNextTts();
          pending.then((buf) => {
            if (epoch !== ttsEpoch) {
              finishTtsJob(job);
              return;
            }
            if (!buf) {
              if (ttsCurrentJob === job) ttsCurrentJob = null;
              finishTtsJob(job);
              ttsPlaying = false;
              echoMuteUntil.t = Date.now() + ECHO_MUTE_MS;
              playNextTts();
              return;
            }
            let settled = false;
            const settle = () => {
              if (settled) return;
              settled = true;
              if (ttsCurrentJob === job) ttsCurrentJob = null;
              try {
                URL.revokeObjectURL(url);
              } catch {
              }
              if (ttsUrl === url) ttsUrl = "";
              finishTtsJob(job);
              ttsPlaying = false;
              echoMuteUntil.t = Date.now() + ECHO_MUTE_MS;
              const next = ttsQueue[0];
              if (job.narration && next && next.group === job.group) ttsPauseUntil = Date.now() + 260;
              playNextTts();
            };
            const blob = new Blob([buf], { type: "audio/mpeg" });
            const url = URL.createObjectURL(blob);
            ttsUrl = url;
            const audio = new Audio(url);
            ttsAudioRef = audio;
            audio.onended = settle;
            audio.onerror = settle;
            audio.play().catch(() => {
              try {
                const u = new window.SpeechSynthesisUtterance(job.text.slice(0, 300));
                u.lang = /[\u4e00-\u9fa5]/.test(job.text) ? "zh-CN" : "en-US";
                u.onend = settle;
                u.onerror = settle;
                window.speechSynthesis.cancel();
                window.speechSynthesis.speak(u);
              } catch (e) {
                settle();
              }
            });
          }).catch(() => {
            if (ttsCurrentJob === job) ttsCurrentJob = null;
            finishTtsJob(job);
            ttsPlaying = false;
            echoMuteUntil.t = Date.now() + ECHO_MUTE_MS;
            playNextTts();
          });
        } catch (e) {
          if (ttsCurrentJob === job) ttsCurrentJob = null;
          ttsPlaying = false;
          echoMuteUntil.t = Date.now() + ECHO_MUTE_MS;
          finishTtsJob(job);
          playNextTts();
        }
      }
      function taleParts(rawTitle) {
        const t = String(rawTitle || "").trim();
        const i = t.indexOf("\xB7");
        if (i > 0 && i < t.length - 1) return { book: t.slice(0, i), title: t.slice(i + 1) };
        return { title: t, book: "" };
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
      function playMelody(notes, bpm) {
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
        const bodyRef = R.useRef(null);
        const bubbleRef = R.useRef(null);
        const bubbleTextRef = R.useRef(null);
        R.useEffect(() => {
          try {
            if (!document.getElementById("chubby-whale-style")) {
              const st = document.createElement("style");
              st.id = "chubby-whale-style";
              st.textContent = '.chubby-bubble{position:fixed;z-index:10002;max-width:250px;opacity:0;background:#fff;color:#17325a;border-radius:14px;padding:10px 14px;font:13px/1.6 "Microsoft YaHei",sans-serif;box-shadow:0 8px 20px rgba(0,0,0,0.35);transition:opacity .2s;pointer-events:none;}.chubby-bubble::after{content:"";position:absolute;left:50%;margin-left:-9px;bottom:-9px;border-left:9px solid transparent;border-right:9px solid transparent;border-top:10px solid #fff;}.chubby-bubble.show{opacity:1;}';
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
          }, ms);
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
          const tF = setTimeout(() => {
            try {
              prefetchFiller();
            } catch (e) {
            }
          }, 3e3);
          return () => clearTimeout(t0);
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
          storyNarratingRef.current = true;
          noteSpoken(text);
          speakText(text, {
            rate: normalizeRate(d.rate, "-15%"),
            onDone: () => {
              storyBusyRef.current = false;
              storyNarratingRef.current = false;
              showBubble("\u8FD9\u6BB5\u8BB2\u5B8C\u5566\uFF5E\u70B9\u83DC\u5355\u300C\u63A5\u7740\u8BF4\u300D\u542C\u4E0B\u4E00\u6BB5", 6e3);
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
          if (ttsPlaying || ttsQueue.length > 0 || storyNarratingRef.current || busy) {
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
            showBubble("\u597D\u5403\uFF01\u8C22\u8C22\u4E3B\u4EBA\uFF5E");
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
                const speech = "\u5FF5\u9996\u8BD7\u2014\u2014" + p.title + "\uFF0C" + (p.dynasty ? p.dynasty + "\uFF0C" : "") + author + "\u3002" + body.replace(/\n/g, "\uFF0C");
                noteSpoken(speech);
                speakText(speech, { rate: "-15%", onDone: () => {
                  showBubble("\u8BD7\u5FF5\u5B8C\u5566\uFF5E", 5e3);
                  try {
                    speakText("\u5FF5\u5B8C\u5566\uFF5E");
                  } catch (e) {
                  }
                } });
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
                speakText("\u8BB2\u4E2A\u6C11\u95F4\u6545\u4E8B\u2014\u2014" + tp.title + (tp.book ? "\uFF0C\u51FA\u81EA\u300A" + tp.book + "\u300B" : "") + "\u3002" + body.slice(0, 6e3), { rate: "-15%", onDone: () => {
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
                speakText("\u8BB2\u4E2A\u5178\u6545\u2014\u2014" + String(d.item.title || "") + "\uFF0C\u51FA\u81EA" + String(d.item.src || "") + "\u3002" + body, { rate: "-15%", onDone: () => {
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
                speakText(sp, { rate: "-15%", onDone: () => {
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
                playMelody(d.song.notes, d.song.bpm);
                showBubble("\u5F39\u300A" + d.song.name + "\u300B\u266A");
              } else showBubble("\u8FD9\u9996\u66F2\u5B50\u6CA1\u627E\u5230");
            }).catch(() => showBubble("\u5F39\u7434\u5931\u8D25"));
            return;
          }
          if (action === "wake") {
            const nowOn = !earOnRef.current;
            earOnRef.current = nowOn;
            setEarOn(nowOn);
            try {
              localStorage.setItem("chubby-ear", nowOn ? "on" : "off");
            } catch (e) {
            }
            if (nowOn) {
              try {
                earCtlRef.current.boot();
              } catch (e) {
              }
              ;
              showBubble("\u8BED\u97F3\u5F85\u547D\uFF1A\u5F00\uFF0C\u672C\u9CB8\u53C8\u542C\u7740\u5566");
            } else {
              try {
                earCtlRef.current.stop();
              } catch (e) {
              }
              ;
              showBubble("\u8BED\u97F3\u5F85\u547D\uFF1A\u5173\uFF0C\u9EA6\u514B\u98CE\u505C\u5566");
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
                  const b64 = await new Promise((resolve) => {
                    const fr = new FileReader();
                    fr.onloadend = () => {
                      const s = String(fr.result || "");
                      resolve(s.indexOf(",") >= 0 ? s.slice(s.indexOf(",") + 1) : s);
                    };
                    fr.readAsDataURL(file);
                  });
                  if (!b64) return;
                  showBubble("\u672C\u9CB8\u770B\u770B\u8FD9\u5F20\u56FE\u2026", 3e3);
                  setChatOpen(false);
                  const hdr = file.type || "image/jpeg";
                  const tChat = performance.now();
                  const res = await fetch("/api/chubby-whale/chat", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ message: VISION_PROMPT, image: b64, imageMime: hdr }) });
                  const d = await res.json();
                  const reply = d && d.reply || "\u8FD9\u6761\u9C7C\u770B\u4E0D\u61C2\u8FD9\u5F20\u56FE\u2026\u2026";
                  showBubble("\uFF08\u770B\u56FE\uFF09" + reply, 1e4);
                  noteSpoken(reply);
                  speakText(reply, { rate: reply.length >= 80 ? "-15%" : "+0%" });
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
        async function sendText(rawText, opts) {
          const text = String(rawText || "").trim();
          if (!text) return;
          if (busy) {
            if (opts && opts.voice) showBubble("\u672C\u9CB8\u8FD8\u5728\u60F3\u4E0A\u4E00\u53E5\u5462\uFF0C\u7A0D\u7B49\uFF5E", 2500);
            return;
          }
          if (storyNarratingRef.current || ttsPlaying || ttsQueue.length > 0) {
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
          const myEpoch = ++chatEpoch;
          if (/乖|可爱|好鱼|棒|喜欢你|真聪明/.test(text)) animRef.current?.pushHeart();
          if (/闭嘴|烦|滚|讨厌|笨蛋|丑/.test(text)) showBubble("\u54FC\u2026\u672C\u9CB8\u751F\u6C14\u4E86");
          if (/胖|肥猪|肥嘟嘟/.test(text)) {
            showBubble("\u4EBA\u5BB6\u4E0D\u80D6\uFF01\u662F\u9CB8\u9C7C\u5929\u751F\u5706\uFF01");
            const s0 = Math.min(1.4, scale + 0.12);
            setScale(s0);
            setTimeout(function() {
              setScale(Math.max(0.7, s0 - 0.12));
            }, 600);
          }
          setInput("");
          setMessages((m) => [...m, { who: "me", text }]);
          setBusy(true);
          animRef.current?.talkFor(1200);
          scrollBody();
          let data = null;
          try {
            const tChat = performance.now();
            const res = await fetch("/api/chubby-whale/chat", {
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
            if (myEpoch !== chatEpoch) return;
            const reply = data?.reply || "\u4E3B\u4EBA\u2026\u2026\u672C\u9CB8\u8D70\u795E\u4E86\u3002";
            setMessages((m) => [...m, { who: "fish", text: reply }]);
            if (voiceModeRef.current) {
              showBubble("\uFF08\u8BF4\uFF09" + reply, 8e3);
            }
            if (data && data.upgraded) showBubble("\u672C\u9CB8\u53C8\u957F\u5927\u4E00\u70B9\u5566\uFF01", 4e3);
          } catch {
            setMessages((m) => [...m, { who: "fish", text: "\u4E3B\u4EBA\uFF0C\u672C\u9CB8\u8FDE\u4E0D\u4E0A\u670D\u52A1\u5668\u2026\u2026" }]);
          } finally {
            setBusy(false);
            animRef.current?.talkFor(1500);
            try {
              if (data && data.reply && myEpoch === chatEpoch) {
                const rp = String(data.reply);
                noteSpoken(rp);
                speakText(rp, { rate: rp.length >= 80 ? "-15%" : "+0%" });
              }
            } catch {
            }
            scrollBody();
          }
        }
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
        R.useEffect(() => {
          let stopped = false;
          let lastHeardText = "";
          let lastHeardAt = 0;
          let stream = null;
          let mr = null;
          let actx = null;
          let analyser = null;
          let chunks = [];
          let raf = 0;
          let started = false;
          let peak = 0;
          let chunkStartedAt = 0;
          let lastTickAt = 0;
          let watchTimer = null;
          let startTimer = null;
          const SILENCE_LIMIT = 450;
          const VOICE_LIMIT = 5e3;
          function blobToBase64(blob) {
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
          function scheduleStart(delay) {
            if (stopped) return;
            if (startTimer) clearTimeout(startTimer);
            startTimer = setTimeout(() => {
              startTimer = null;
              startChunk();
            }, delay);
          }
          async function uploadChunk() {
            if (asrBusy) return;
            asrBusy = true;
            try {
              if (stopped) return;
              const blob = new Blob(chunks, { type: "audio/webm" });
              chunks = [];
              if (blob.size < 1200) return;
              if (Date.now() < echoMuteUntil.t) return;
              const b64 = await blobToBase64(blob);
              if (!b64) return;
              const t0 = performance.now();
              const r = await fetch("/api/chubby-whale/asr", {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ audio: b64, format: "webm" })
              });
              const d = await r.json();
              const asrMs = Math.round(performance.now() - t0);
              if (d && d.ok && d.text && looksLikeEcho(String(d.text))) {
                try {
                  console.log("[chubby-whale] \u4E22\u5F03\u56DE\u58F0\uFF08" + asrMs + "ms\uFF09\uFF1A" + String(d.text).slice(0, 40));
                } catch (e) {
                }
                return;
              }
              if (d && d.ok && d.text && d.text.trim().length >= 2) {
                if (ttsPlaying) return;
                if (ttsQueue.length > 0) return;
                let narrating = false;
                try {
                  narrating = storyNarratingRef.current;
                } catch (e) {
                }
                if (narrating) return;
                let t = String(d.text).trim();
                if (t === lastHeardText && Date.now() - lastHeardAt < 6e3) return;
                lastHeardText = t;
                lastHeardAt = Date.now();
                if (/[。，！？,.!?]{3,}/.test(t) || t.length > 60) return;
                const hasWake = WAKE_WORDS.some(function(w) {
                  return t.indexOf(w) >= 0;
                });
                if (hasWake) {
                  wokeRef.current.at = Date.now();
                  try {
                    t = t.replace(/大肥鱼|肥鲸|肥鱼|小鱼|蓝鱼|小蓝鱼|鱼鱼|肥肥/g, "").trim();
                  } catch (e) {
                  }
                  if (!t) {
                    showBubble("\u6211\u5728\uFF5E\u4E3B\u4EBA\u8BF4\uFF5E", 3e3);
                    return;
                  }
                } else {
                  const wokeRecent = Date.now() - wokeRef.current.at < 12e4;
                  if (!wokeRecent) return;
                }
                voiceModeRef.current = true;
                setChatOpen(false);
                if (!voiceChatOnRef.current) {
                  showBubble("\uFF08\u542C\u5230\uFF09" + t + "\uFF5C\u8BED\u97F3\u804A\u5929\u5173\u7740\uFF0C\u5148\u4E0D\u63A5\u8BDD", 4e3);
                  return;
                }
                playFiller();
                showBubble("\uFF08\u542C\u5230\uFF09" + t + "\uFF5C\u672C\u9C7C\u5728\u60F3\u2026", 3e3);
                sendText(t, { voice: true });
              }
            } catch (e) {
            } finally {
              asrBusy = false;
              if (!stopped) scheduleStart(350);
            }
          }
          const timeBuf = new Float32Array(1024);
          let noiseDb = null;
          let speechMs = 0;
          let quietMs = 0;
          const ONSET_DB = 9;
          const OFFSET_DB = 5;
          const MIN_SPEECH_MS = 150;
          const CALIB_MS = 400;
          const calibStart = performance.now();
          function readDb() {
            analyser.getFloatTimeDomainData(timeBuf);
            let sum = 0;
            for (let i = 0; i < timeBuf.length; i++) sum += timeBuf[i] * timeBuf[i];
            const rms = Math.sqrt(sum / timeBuf.length);
            return 20 * Math.log10(rms + 1e-8);
          }
          function watch() {
            try {
              if (stopped || !analyser) return;
              const db = readDb();
              const now = performance.now();
              const dt = Math.min(250, Math.max(0, now - lastTickAt));
              lastTickAt = now;
              const elapsed = now - chunkStartedAt;
              const calibrating = now - calibStart < CALIB_MS;
              const inSpeech = speechMs > 0 && quietMs < SILENCE_LIMIT;
              if (noiseDb === null) noiseDb = db;
              else if (!inSpeech) noiseDb = noiseDb * 0.95 + db * 0.05;
              if (noiseDb < -95) noiseDb = -95;
              if (noiseDb > -20) noiseDb = -20;
              const onsetTh = noiseDb + ONSET_DB;
              const offsetTh = noiseDb + OFFSET_DB;
              if (!calibrating) {
                if (db > onsetTh) {
                  speechMs += dt;
                  quietMs = 0;
                  if (db > peak) peak = db;
                } else if (db <= offsetTh) {
                  quietMs += dt;
                }
              }
              try {
                earDiag.db = Math.round(db * 10) / 10;
                earDiag.noiseDb = Math.round(noiseDb * 10) / 10;
                earDiag.onsetDb = Math.round(onsetTh * 10) / 10;
                earDiag.speechMs = Math.round(speechMs);
                earDiag.quietMs = Math.round(quietMs);
                earDiag.calibrating = calibrating;
              } catch (e) {
              }
              const ended = speechMs >= MIN_SPEECH_MS && quietMs >= SILENCE_LIMIT;
              const tooLong = elapsed >= VOICE_LIMIT + 1e3;
              if ((ended || tooLong) && mr.state === "recording") {
                try {
                  mr.stop();
                } catch {
                }
                setTimeout(uploadChunk, 100);
                return;
              }
              if (!stopped) scheduleWatch(60);
            } catch (e) {
              if (!stopped) scheduleWatch(100);
            }
          }
          function scheduleWatch(delay) {
            if (stopped) return;
            if (watchTimer) clearTimeout(watchTimer);
            watchTimer = setTimeout(() => {
              watchTimer = null;
              watch();
            }, delay);
          }
          function startChunk() {
            if (stopped || !mr) return;
            try {
              if (mr.state !== "inactive") {
                try {
                  mr.stop();
                } catch (e) {
                }
                scheduleStart(200);
                return;
              }
              chunks = [];
              peak = 0;
              speechMs = 0;
              quietMs = 0;
              chunkStartedAt = performance.now();
              lastTickAt = chunkStartedAt;
              mr.start();
              scheduleWatch(100);
            } catch (e) {
              scheduleStart(1e3);
            }
          }
          function detachGesture() {
            try {
              document.removeEventListener("pointerdown", onFirstGesture);
            } catch {
            }
            try {
              document.removeEventListener("keydown", onFirstGesture);
            } catch {
            }
          }
          function attachGesture() {
            try {
              document.addEventListener("pointerdown", onFirstGesture);
            } catch {
            }
            try {
              document.addEventListener("keydown", onFirstGesture);
            } catch {
            }
          }
          async function boot() {
            if (stopped) return;
            try {
              const s = await navigator.mediaDevices.getUserMedia({
                audio: {
                  echoCancellation: true,
                  noiseSuppression: true,
                  autoGainControl: true,
                  channelCount: 1
                }
              });
              if (stopped) {
                try {
                  s.getTracks().forEach((t) => t.stop());
                } catch (e) {
                }
                ;
                return;
              }
              stream = s;
              actx = new window.AudioContext();
              const src = actx.createMediaStreamSource(stream);
              analyser = actx.createAnalyser();
              analyser.fftSize = 1024;
              analyser.smoothingTimeConstant = 0;
              src.connect(analyser);
              mr = new window.MediaRecorder(stream);
              mr.ondataavailable = (e) => {
                if (e && e.data && e.data.size > 0) chunks.push(e.data);
              };
              mr.onstop = () => {
              };
              detachGesture();
              showBubble("\u672C\u9CB8\u5728\u542C\uFF08\u5343\u95EE\u8BC6\u522B\uFF09\uFF0C\u8BF4\u5B8C\u5C31\u4F1A\u63A5\u8BDD\uFF5E", 3e3);
              startChunk();
            } catch (e) {
              started = false;
              if (stopped) return;
              attachGesture();
              try {
                if (earOnRef.current) onFirstGesture();
              } catch (e2) {
              }
              showBubble("\u9EA6\u514B\u98CE\u6253\u4E0D\u5F00\uFF1A\u70B9\u5730\u5740\u680F\u5C0F\u9501\u5141\u8BB8\u9EA6\u514B\u98CE", 6e3);
            }
          }
          function onFirstGesture() {
            if (started || stopped) return;
            started = true;
            detachGesture();
            if (!earOnRef.current) return;
            boot();
          }
          function stopEar() {
            stopped = true;
            if (watchTimer) {
              try {
                clearTimeout(watchTimer);
              } catch {
              }
              watchTimer = null;
            }
            if (startTimer) {
              try {
                clearTimeout(startTimer);
              } catch {
              }
              startTimer = null;
            }
            try {
              if (mr && mr.state !== "inactive") mr.stop();
            } catch {
            }
            try {
              if (actx) actx.close();
            } catch {
            }
            try {
              if (stream) stream.getTracks().forEach((t) => t.stop());
            } catch {
            }
            mr = null;
            actx = null;
            stream = null;
            analyser = null;
          }
          function bootEar() {
            stopped = false;
            lastHeardText = "";
            lastHeardAt = 0;
            started = true;
            detachGesture();
            boot();
          }
          earCtlRef.current.stop = stopEar;
          earCtlRef.current.boot = bootEar;
          attachGesture();
          return () => {
            detachGesture();
            stopEar();
            earCtlRef.current.stop = () => {
            };
            earCtlRef.current.boot = () => {
            };
          };
        }, []);
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
            ear: earDiag,
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
