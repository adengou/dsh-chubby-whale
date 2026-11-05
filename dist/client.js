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
  var VERSION = "1.0.1";

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
    transformOrigin: "100% 100%",
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
    left: (menu ? Math.min(menu.x, window.innerWidth - 220) : 0) + "px",
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

  // src/client/menu.ts
  var MELODIES = ["\u5C0F\u661F\u661F", "\u4E24\u53EA\u8001\u864E", "\u751F\u65E5\u5FEB\u4E50", "\u6B22\u4E50\u9882", "\u94C3\u513F\u54CD\u53EE\u5F53", "\u4F26\u6566\u5927\u6865", "\u65AF\u5361\u5E03\u7F57\u96C6\u5E02", "\u601D\u541B\u9EEF\u7136", "\u7EFF\u8896\u5B50", "\u81F4\u7231\u4E3D\u4E1D", "\u53CB\u8C0A\u5929\u957F\u5730\u4E45"];
  deepFreeze(MELODIES);
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
  deepFreeze(SONG_EN);
  var EN_MAP = {
    "\u6295\u5582\u4E00\u7897": "Feed a bowl",
    "\u9009\u672C\u4E66 \u25B8": "Choose a book \u25B8",
    "\u4E66\u5355\u6CA1\u53D6\u5230\uFF0C\u7A0D\u540E\u518D\u8BD5": "Book list unavailable, try again later",
    "\u6B63\u5728\u7FFB\u4E66\u5355\u2026": "Loading book list\u2026",
    "\u4ECA\u65E5\u4E00\u53E5": "Daily quote",
    "\u4ECA\u65E5\u7B80\u62A5": "Today's briefing",
    "\u6570\u636E\u5BFC\u51FA\u2026": "Export data\u2026",
    "\u6570\u636E\u5BFC\u5165\u2026": "Import data\u2026",
    "\u4F7F\u7528\u7EDF\u8BA1": "Usage stats",
    "\u63D0\u9192\u7BA1\u7406\u2026": "Manage reminders\u2026",
    "\u5524\u9192\u6062\u590D": "Wake recovery",
    "\u5F39\u9996\u66F2\u5B50 \u25B8": "Play a song \u25B8",
    "\u505C\u6B62\u5F39\u594F": "Stop music",
    "\u8DDF\u5979\u8BF4\u4E24\u53E5": "Talk to her",
    "\u6362\u4E2A\u58F0\u97F3 \u25B8": "Change voice \u25B8",
    "\u804A\u5929\u8BED\u8A00 \u25B8": "Chat language \u25B8",
    "\u754C\u9762\u8BED\u8A00 \u25B8": "Interface language \u25B8",
    "\u770B\u5F20\u56FE\u2026": "Look at a picture\u2026",
    "\u505C\u6B62\u8BF4\u8BDD": "Stop talking",
    "\u8BA9\u5979\u6B47\u4F1A\u513F": "Let her rest",
    "\u56DE\u7897\u91CC\u5F85\u7740": "Back in the bowl",
    "\u957F\u5927\u4E00\u70B9": "Grow bigger",
    "\u53D8\u5C0F\u4E00\u70B9": "Shrink",
    "\u8BB0\u4E2A\u996D\u70B9\u2026": "Add a meal reminder\u2026",
    "\u63D0\u9192\u6E05\u5355\u2026": "Reminders\u2026",
    "\u7AEF\u70B9\u68C0\u6D4B\uFF1A\u7ECF\u5178/\u81EA\u9002\u5E94": "Endpoint detection: classic / adaptive",
    "\u8033\u6735\u81EA\u68C0\uFF08\u542C\u529B\u8BCA\u65AD\uFF09": "Hearing self-test",
    "\u6587\u5316\u6C14 \u25B8": "Culture \u25B8",
    "\u8BF4\u4E66\uFF08\u8FDE\u8F7D\uFF09": "Storytelling",
    "\u7A0D\u5FEB -25%": "A bit faster -25%",
    "\u9002\u4E2D -30%": "Medium -30%",
    "\u504F\u6162 -35%\uFF08\u9ED8\u8BA4\uFF09": "Slower -35% (default)",
    "\u7A0D\u5FEB -15%": "A bit faster -15%",
    "\u9002\u4E2D -20%": "Medium -20%",
    "\u504F\u6162 -25%\uFF08\u9ED8\u8BA4\uFF09": "Slower -25% (default)",
    "\u5F88\u6162 -30%": "Very slow -30%",
    "\u5F88\u6162 -40%": "Very slow -40%",
    "\u63A5\u7740\u8BF4": "Continue story",
    "\u4ECE\u5934\u8BB2\u8FD9\u672C\u4E66": "Restart this book",
    "\u5FF5\u9996\u8BD7": "Recite a poem",
    "\u8BB2\u4E2A\u6C11\u95F4\u6545\u4E8B": "Folk tale",
    "\u8BB2\u4E2A\u5178\u6545": "Classic allusion",
    "\u6210\u8BED\u8FA8\u6790": "Idiom",
    "\u51FA\u4E2A\u5BF9\u8054 \u25B8": "Couplets \u25B8",
    "\u968F\u673A\u4E00\u526F": "Random pair",
    "\u6625\u8054": "Spring couplet",
    "\u683C\u8A00": "Motto",
    "\u8C10\u8DA3": "Witty",
    "\u540D\u80DC": "Landmarks",
    "\u666F\u89C2": "Scenery",
    "\u4E66\u623F": "Study",
    "\u5BFF\u8054": "Birthday couplet",
    "\u4E2D\u836F": "Herbs",
    "\u53E0\u5B57": "Repeated characters",
    "\u6570\u5B57": "Numerals",
    "\u6E05\u9664\u8BB0\u5FC6\u2026": "Clear memory\u2026",
    "\u6E05\u7A7A\u804A\u5929\u7F13\u5B58\u2026": "Clear chat cache\u2026",
    "\u8BA9\u5B83\u6E38\u8D70\uFF08\u9000\u51FA\uFF09": "Let it go (exit)",
    "\u9C7C\u7CAE\u8D26\u672C": "Token ledger",
    "English": "English",
    "\u4E2D\u6587": "Chinese",
    // 动态 label（音色勾选/聊天缓存开关/自动）需要的英文键
    "\u804A\u5929\u7F13\u5B58\uFF1A\u5F00": "Chat cache: on",
    "\u804A\u5929\u7F13\u5B58\uFF1A\u5173": "Chat cache: off",
    "\u81EA\u52A8\uFF08\u6309\u8BED\u8A00\u9009\u97F3\u8272\uFF09": "Auto (by language)",
    "\u81EA\u52A8": "Auto",
    "\u97F3\u8272\uFF1A\u6653\u4F0A\uFF08\u4E2D\xB7\u5973\uFF09": "Voice: Xiaoyi (CN F)",
    "\u97F3\u8272\uFF1A\u6653\u6653\uFF08\u4E2D\xB7\u5973\uFF09": "Voice: Xiaoxiao (CN F)",
    "\u97F3\u8272\uFF1A\u6653\u8FB0\uFF08\u4E2D\xB7\u5973\uFF09": "Voice: Xiaochen (CN F)",
    "\u97F3\u8272\uFF1A\u4E91\u5E0C\uFF08\u4E2D\xB7\u7537\uFF09": "Voice: Yunxi (CN M)",
    "\u97F3\u8272\uFF1A\u4E91\u626C\uFF08\u4E2D\xB7\u7537\uFF09": "Voice: Yunyang (CN M)",
    "\u97F3\u8272\uFF1AAna\uFF08\u82F1\xB7\u5973\uFF09": "Voice: Ana (EN F)",
    "\u97F3\u8272\uFF1AJenny\uFF08\u82F1\xB7\u5973\uFF09": "Voice: Jenny (EN F)",
    "\u97F3\u8272\uFF1ASonia\uFF08\u82F1\xB7\u5973\xB7\u82F1\u5F0F\uFF09": "Voice: Sonia (EN-GB F)"
  };
  deepFreeze(EN_MAP);
  var TOGGLE_EN = {
    "\u8BED\u97F3\u6717\u8BFB\uFF1A": ["Voice output: on", "Voice output: off"],
    "\u8BED\u97F3\u5F85\u547D\uFF1A": ["Voice standby: on", "Voice standby: off"],
    "\u8BED\u97F3\u804A\u5929\uFF1A": ["Voice chat: on", "Voice chat: off"],
    "\u6D41\u5F0F\u56DE\u590D\uFF1A": ["Streaming replies: on", "Streaming replies: off"]
  };
  function tr(label, lang) {
    if (lang !== "en") return label;
    const exact = EN_MAP[label];
    if (exact) return exact;
    if (label.startsWith("\u2713 ")) {
      const base = label.slice(2);
      const en = tr(base, lang);
      return en === base ? label : "\u2713 " + en;
    }
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
    if (label.startsWith("\u8BF4\u4E66\u8BED\u901F\uFF1A")) return label.replace("\u8BF4\u4E66\u8BED\u901F\uFF1A", "Story speed: ");
    if (label.startsWith("\u8FDE\u64AD\uFF1A")) return label.indexOf("\u5F00") >= 0 ? "Auto-continue: on" : "Auto-continue: off";
    if (label.startsWith("\u5FF5\u8BD7\u8BED\u901F\uFF1A")) return label.replace("\u5FF5\u8BD7\u8BED\u901F\uFF1A", "Poem speed: ");
    if (label.startsWith("\u53D9\u8FF0\u8BED\u901F\uFF1A")) return label.replace("\u53D9\u8FF0\u8BED\u901F\uFF1A", "Narration speed: ");
    return label;
  }
  var DEFAULT_VOICE = "zh-CN-XiaoyiNeural";
  function buildMenu(version, state = {}) {
    const voiceOn = state.voiceOn ? true : false;
    const earOn = state.earOn ? true : false;
    const voiceChatOn = state.voiceChatOn ? true : false;
    const chatLang = state.chatLang ? String(state.chatLang) : "auto";
    const ttsVoice = state.ttsVoice ? String(state.ttsVoice) : DEFAULT_VOICE;
    const chatCacheOn = !(state.chatCacheOn === false);
    const voiceTick = (voice) => ttsVoice === voice ? "\u2713 " : "";
    const balanceText = state && state.balance ? state.balance : "--";
    const growthText = state && state.growth ? state.growth : "--";
    const books = Array.isArray(state.storyBooks) ? state.storyBooks.map((b) => String(b || "").trim()).filter(Boolean) : [];
    const bookItems = books.length ? books.map((b) => ({ type: "item", label: b, action: "story-book:" + b })) : [{ type: "item", label: state.storyBooksTried ? "\u4E66\u5355\u6CA1\u53D6\u5230\uFF0C\u7A0D\u540E\u518D\u8BD5" : "\u6B63\u5728\u7FFB\u4E66\u5355\u2026", action: "story-books" }];
    return [
      // ── 界面语言（主人定的位置：标题栏下方第一行）──
      { type: "sub", label: "\u754C\u9762\u8BED\u8A00 \u25B8", items: [
        { type: "item", label: "\u4E2D\u6587", action: "lang:zh" },
        { type: "item", label: "English", action: "lang:en" }
      ] },
      // ── 吃饭与看图 ──
      { type: "item", label: "\u6210\u957F\uFF1A" + growthText, action: "growth" },
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
      { type: "item", label: "\u6D41\u5F0F\u56DE\u590D\uFF1A" + (state.streamOn === false ? "\u5173" : "\u5F00"), action: "stream-toggle" },
      { type: "item", label: "\u7AEF\u70B9\u68C0\u6D4B\uFF1A\u7ECF\u5178/\u81EA\u9002\u5E94", action: "endpoint" },
      { type: "item", label: "\u8033\u6735\u81EA\u68C0\uFF08\u542C\u529B\u8BCA\u65AD\uFF09", action: "ear-check" },
      { type: "sep" },
      // ── 语言 ──
      { type: "sub", label: "\u804A\u5929\u8BED\u8A00 \u25B8", items: [
        { type: "item", label: (chatLang === "auto" ? "\u2713 " : "") + "\u81EA\u52A8", action: "chat-lang:auto" },
        { type: "item", label: (chatLang === "zh" ? "\u2713 " : "") + "\u4E2D\u6587", action: "chat-lang:zh" },
        { type: "item", label: (chatLang === "en" ? "\u2713 " : "") + "English", action: "chat-lang:en" }
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
        { type: "item", label: "\u8FDE\u64AD\uFF1A" + (state.storyAuto === false ? "\u5173" : "\u5F00") + "\uFF08\u8BB2\u5B8C\u4E00\u6BB5\u81EA\u52A8\u63A5\u4E0B\u4E00\u6BB5\uFF09", action: "story-auto" },
        { type: "sub", label: "\u8BF4\u4E66\u8BED\u901F\uFF1A" + (state.storyRate || "-35%") + " \u25B8", items: [
          { type: "item", label: ((state.storyRate || "-35%") === "-25%" ? "\u2713 " : "") + "\u7A0D\u5FEB -25%", action: "story-rate:-25%" },
          { type: "item", label: ((state.storyRate || "-35%") === "-30%" ? "\u2713 " : "") + "\u9002\u4E2D -30%", action: "story-rate:-30%" },
          { type: "item", label: ((state.storyRate || "-35%") === "-35%" ? "\u2713 " : "") + "\u504F\u6162 -35%\uFF08\u9ED8\u8BA4\uFF09", action: "story-rate:-35%" },
          { type: "item", label: ((state.storyRate || "-35%") === "-40%" ? "\u2713 " : "") + "\u5F88\u6162 -40%", action: "story-rate:-40%" }
        ] },
        { type: "item", label: "\u63A5\u7740\u8BF4", action: "culture-story-next" },
        { type: "item", label: "\u4ECE\u5934\u8BB2\u8FD9\u672C\u4E66", action: "story-reset" },
        { type: "item", label: "\u5FF5\u9996\u8BD7", action: "poem" },
        { type: "sub", label: "\u53D9\u8FF0\u8BED\u901F\uFF1A" + (state.narrationRate || "-25%") + " \u25B8", items: [
          { type: "item", label: ((state.narrationRate || "-25%") === "-15%" ? "\u2713 " : "") + "\u7A0D\u5FEB -15%", action: "narration-rate:-15%" },
          { type: "item", label: ((state.narrationRate || "-25%") === "-20%" ? "\u2713 " : "") + "\u9002\u4E2D -20%", action: "narration-rate:-20%" },
          { type: "item", label: ((state.narrationRate || "-25%") === "-25%" ? "\u2713 " : "") + "\u504F\u6162 -25%\uFF08\u9ED8\u8BA4\uFF09", action: "narration-rate:-25%" },
          { type: "item", label: ((state.narrationRate || "-25%") === "-30%" ? "\u2713 " : "") + "\u5F88\u6162 -30%", action: "narration-rate:-30%" }
        ] },
        { type: "sub", label: "\u5FF5\u8BD7\u8BED\u901F\uFF1A" + (state.poemRate || "-25%") + " \u25B8", items: [
          { type: "item", label: ((state.poemRate || "-25%") === "-15%" ? "\u2713 " : "") + "\u7A0D\u5FEB -15%", action: "poem-rate:-15%" },
          { type: "item", label: ((state.poemRate || "-25%") === "-20%" ? "\u2713 " : "") + "\u9002\u4E2D -20%", action: "poem-rate:-20%" },
          { type: "item", label: ((state.poemRate || "-25%") === "-25%" ? "\u2713 " : "") + "\u504F\u6162 -25%\uFF08\u9ED8\u8BA4\uFF09", action: "poem-rate:-25%" },
          { type: "item", label: ((state.poemRate || "-25%") === "-30%" ? "\u2713 " : "") + "\u5F88\u6162 -30%", action: "poem-rate:-30%" }
        ] },
        { type: "item", label: "\u8BB2\u4E2A\u6C11\u95F4\u6545\u4E8B", action: "culture-tale" },
        { type: "item", label: "\u8BB2\u4E2A\u5178\u6545", action: "culture-allusion" },
        { type: "item", label: "\u6210\u8BED\u8FA8\u6790", action: "culture-idiom" },
        { type: "sub", label: "\u51FA\u4E2A\u5BF9\u8054 \u25B8", items: [
          { type: "item", label: "\u968F\u673A\u4E00\u526F", action: "culture-couplet" },
          { type: "item", label: "\u6625\u8054", action: "culture-couplet:\u6625\u8054" },
          { type: "item", label: "\u683C\u8A00", action: "culture-couplet:\u683C\u8A00" },
          { type: "item", label: "\u8C10\u8DA3", action: "culture-couplet:\u8C10\u8DA3" },
          { type: "item", label: "\u540D\u80DC", action: "culture-couplet:\u540D\u80DC" },
          { type: "item", label: "\u666F\u89C2", action: "culture-couplet:\u666F\u89C2" },
          { type: "item", label: "\u4E66\u623F", action: "culture-couplet:\u4E66\u623F" },
          { type: "item", label: "\u5BFF\u8054", action: "culture-couplet:\u5BFF\u8054" },
          { type: "item", label: "\u4E2D\u836F", action: "culture-couplet:\u4E2D\u836F" },
          { type: "item", label: "\u53E0\u5B57", action: "culture-couplet:\u53E0\u5B57" },
          { type: "item", label: "\u6570\u5B57", action: "culture-couplet:\u6570\u5B57" }
        ] }
      ] },
      { type: "sep" },
      // ── 每日内容（说书选本 / 每日一句 / 今日简报）──
      { type: "sub", label: "\u9009\u672C\u4E66 \u25B8", items: bookItems },
      { type: "item", label: "\u4ECA\u65E5\u4E00\u53E5", action: "daily-line" },
      { type: "item", label: "\u4ECA\u65E5\u7B80\u62A5", action: "briefing-card" },
      { type: "sep" },
      // ── 数据与统计（处理器由其他分身实现，未接上时走兜底提示）──
      { type: "item", label: "\u6570\u636E\u5BFC\u51FA\u2026", action: "data-export" },
      { type: "item", label: "\u6570\u636E\u5BFC\u5165\u2026", action: "data-import" },
      { type: "item", label: "\u4F7F\u7528\u7EDF\u8BA1", action: "stats" },
      { type: "item", label: "\u63D0\u9192\u7BA1\u7406\u2026", action: "remind-manage" },
      { type: "item", label: "\u5524\u9192\u6062\u590D", action: "wake-recover" },
      { type: "sep" },
      // ── 记忆、缓存与退出 ──
      { type: "item", label: "\u6E05\u9664\u8BB0\u5FC6\u2026", action: "clear-memory" },
      { type: "item", label: "\u6E05\u7A7A\u804A\u5929\u7F13\u5B58\u2026", action: "cache-clear" },
      { type: "item", label: chatCacheOn ? "\u804A\u5929\u7F13\u5B58\uFF1A\u5F00" : "\u804A\u5929\u7F13\u5B58\uFF1A\u5173", action: "cache-toggle" },
      { type: "item", label: "\u8BA9\u5B83\u6E38\u8D70\uFF08\u9000\u51FA\uFF09", action: "hide" },
      { type: "sep" },
      // ── 账本与版本（版本永远在最底下）──
      { type: "item", label: "\u9C7C\u7CAE\u8D26\u672C", action: "fishfood" }
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
        const head = total > 0 && idx > 0 ? current.label + "\uFF08\u7B2C " + idx + "/" + total + " \u53E5\uFF09" : current.label;
        return head + (seg.trim() ? "\uFF1A" + seg.trim() : "");
      }
    };
  }
  var defaultProgress = createProgress();
  var startProgress = defaultProgress.start;
  var stopProgress = defaultProgress.stop;
  var progressActive = defaultProgress.active;
  var progressIndex = defaultProgress.index;
  var bumpProgress = defaultProgress.bump;

  // src/client/rates.ts
  var NARRATION_RATES = ["-15%", "-20%", "-25%", "-30%"];
  deepFreeze(NARRATION_RATES);
  var DEFAULT_NARRATION_RATE = "-25%";
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
  var MAX_TEXT_CHARS = 4e3;
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

  // src/client/look.ts
  var TIER_EXP = [0, 200, 800];
  deepFreeze(TIER_EXP);
  var TIER_NAMES = ["\u521D\u8BC6", "\u719F\u7EDC", "\u9ECF\u4EBA"];
  deepFreeze(TIER_NAMES);
  var LOOKS = [
    { tier: 0, label: "\u521D\u8BC6", scale: 1, dots: 2, halo: 0, tailEveryMs: 14e3 },
    { tier: 1, label: "\u719F\u7EDC", scale: 1.04, dots: 4, halo: 0.12, tailEveryMs: 9e3 },
    { tier: 2, label: "\u9ECF\u4EBA", scale: 1.08, dots: 6, halo: 0.22, tailEveryMs: 5500 }
  ];
  deepFreeze(LOOKS);
  function tierOf(exp) {
    const e = Number(exp);
    if (!isFinite(e) || e <= 0) return 0;
    let idx = 0;
    for (let i = 0; i < TIER_EXP.length; i++) {
      if (e >= TIER_EXP[i]) idx = i;
    }
    return idx;
  }
  function lookFor(exp) {
    return LOOKS[tierOf(exp)];
  }
  function lookForGrowth(info) {
    if (!info || typeof info.exp !== "number") return LOOKS[0];
    return LOOKS[tierOf(info.exp)];
  }
  var DEFAULT_GROWTH = { exp: 0, stage: "\u521D\u8BC6", nextExp: 200, tier: 0 };
  deepFreeze(DEFAULT_GROWTH);
  function parseGrowth(d) {
    if (!d || typeof d !== "object" || !d.ok) return null;
    const raw = Number(d.exp);
    if (!isFinite(raw)) return null;
    const exp = Math.max(0, Math.floor(raw));
    const tier = tierOf(exp);
    const n = Number(d.nextExp);
    let nextExp = 0;
    if (isFinite(n) && n >= 0) nextExp = Math.floor(n);
    else if (tier + 1 < TIER_EXP.length) nextExp = TIER_EXP[tier + 1];
    const stage = typeof d.stage === "string" && d.stage ? d.stage : TIER_NAMES[tier];
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
    const ctx = canvas.getContext("2d");
    const img = new Image();
    img.src = imgSrc;
    let raf = 0;
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
    function wagGap() {
      return Math.max(2500, look.tailEveryMs * (1 - WAG_JITTER + Math.random() * WAG_JITTER * 2));
    }
    function applyLook(next) {
      look = next || lookFor(0);
      dotIdx = pickDotIndexes(look.dots);
      nextWagAt = performance.now() + wagGap();
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
        ctx.font = size + "px serif";
        ctx.fillText("\u2764", x, y);
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
      const dt = Math.min(50, t - last);
      last = t;
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
      raf = requestAnimationFrame(loop);
    }
    function stop() {
      cancelAnimationFrame(raf);
    }
    function talkFor(ms2) {
      state.talkUntil = performance.now() + ms2;
    }
    function pushHeart() {
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

  // src/client/text.ts
  function collapseText(raw) {
    return String(raw == null ? "" : raw).replace(/\s+/g, " ").trim();
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
  function taleParts(rawTitle) {
    const t = String(rawTitle || "").trim();
    const i = t.indexOf("\xB7");
    if (i > 0 && i < t.length - 1) return { book: t.slice(0, i), title: t.slice(i + 1) };
    return { title: t, book: "" };
  }
  function normalizePlain(text) {
    return String(text == null ? "" : text).replace(/[\s。，！？,.!?、…~～]/g, "");
  }
  function estimateSpeakMs(text) {
    return Math.round(String(text || "").length * 260) + 3e3;
  }
  function echoKey(s) {
    return String(s == null ? "" : s).replace(/星号|米字号/g, "*").replace(/\*[^*]{1,60}\*/g, "").replace(/[\s。，！？,.!?、…~～]/g, "");
  }
  var SHORT_ECHO_ALLOW = [
    "\u505C",
    "\u522B",
    "\u4E0D",
    "\u597D",
    "\u5582",
    "\u505C\u4E0B",
    "\u505C\u4E00\u4E0B",
    "\u522B\u8BF4",
    "\u522B\u5FF5",
    "\u522B\u8BB2",
    "\u95ED\u5634",
    "\u5B89\u9759",
    "\u6253\u4F4F",
    "\u591F\u4E86",
    "\u597D\u7684",
    "\u597D\u5440",
    "\u597D\u5427",
    "\u662F\u7684",
    "\u5BF9\u7684",
    "\u53EF\u4EE5",
    "\u4E0D\u884C",
    "\u4E0D\u8981",
    "\u6CA1\u6709",
    "\u6CA1\u4E8B",
    "\u8C22\u8C22",
    "\u665A\u5B89",
    "\u65E9\u5B89",
    "\u518D\u89C1",
    "\u7B49\u6211",
    "\u7A0D\u7B49",
    "\u8BB2\u5427",
    "\u8BF4\u5427",
    "\u5531\u5427",
    "\u5FF5\u5427",
    "\u6765\u5427",
    "\u5F00\u59CB",
    "\u7EE7\u7EED",
    "\u6CA1\u9519",
    "\u8BD5\u8BD5",
    "\u55EF\u55EF"
  ];
  deepFreeze(SHORT_ECHO_ALLOW);
  function isShortEchoFragment(plain, hadRecentSpeech) {
    const p = String(plain || "");
    if (!hadRecentSpeech) return false;
    if (p.length > 2) return false;
    return SHORT_ECHO_ALLOW.indexOf(p) < 0;
  }
  function stripStageDirections(raw) {
    let t = String(raw == null ? "" : raw);
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
        tail += String(delta == null ? "" : delta);
        return take(false);
      },
      flush() {
        return take(true);
      }
    };
  }

  // src/shared/noise.ts
  var NOISE_TEXTS = [
    "\u55EF",
    "\u5443",
    "\u554A",
    "\u54E6",
    "\u6069",
    "\u55EF\u55EF",
    "\u554A\u554A",
    "\u8C22\u8C22\u89C2\u770B",
    "\u8C22\u8C22\u5927\u5BB6",
    "\u5B57\u5E55",
    "\u8BF7\u4E0D\u541D\u70B9\u8D5E",
    "\u70B9\u8D5E",
    "\u8BA2\u9605",
    "\u8F6C\u53D1",
    "\u6253\u8D4F",
    "\u518D\u89C1",
    "\u672C\u9C7C\u5728\u542C",
    "\u55EF\u672C\u9C7C\u5728\u542C",
    "\u5B57\u5E55\u7531",
    "\u660E\u955C\u4E0E\u70B9\u70B9"
  ];
  deepFreeze(NOISE_TEXTS);
  function normalizeNoiseKey(text) {
    return String(text == null ? "" : text).replace(/\s+/g, "").replace(/[。，、！？；：,.!?;:…~～·""''（）()【】\[\]]/g, "").toLowerCase();
  }
  function isNoiseText(text) {
    const k = normalizeNoiseKey(text);
    if (!k) return true;
    if (k.length <= 1) return true;
    if (NOISE_TEXTS.indexOf(k) >= 0) return true;
    if (k.length <= 6 && /^([\u4e00-\u9fa5])\1{2,}$/.test(k)) return true;
    return false;
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

  // src/client/voice.ts
  var WINDOW_MS = 6e3;
  var EARLY_STOP_QUIET = 700;
  var MIN_SPEECH_MS = 400;
  var SILENT_PEAK_DB = -35;
  var ECHO_MUTE_MS = 700;
  var ASR_TIMEOUT_MS = 15e3;
  var TTS_TIMEOUT_MS = 2e4;
  var TTS_WATCH_MS = 1e3;
  var TTS_ZOMBIE_MS = 2500;
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
  var DEFAULT_VOICE2 = "zh-CN-XiaoyiNeural";
  function normalizeVoiceName(name, fallback = DEFAULT_VOICE2) {
    const n = String(name == null ? "" : name).trim();
    return TTS_VOICES.indexOf(n) >= 0 ? n : fallback;
  }
  function readStoredVoiceName() {
    try {
      return normalizeVoiceName(localStorage.getItem("chubby-tts-voice"));
    } catch (e) {
      return DEFAULT_VOICE2;
    }
  }
  function createVoice(opts) {
    const apiBase = opts.apiBase || "/api/chubby-whale";
    let voiceName = normalizeVoiceName(opts.voiceName || readStoredVoiceName());
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
      shortDropped: 0,
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
    let ttsProgressAt = 0;
    let ttsCurJob = null;
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
    function scheduleNext(ms2) {
      if (!running) return;
      if (restartTimer) clearTimeout(restartTimer);
      restartTimer = setTimeout(() => {
        restartTimer = null;
        beginWindow();
      }, ms2);
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
      if (!running) return;
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
        const asrCtl = typeof AbortController !== "undefined" ? new AbortController() : null;
        if (asrCtl) asrAborts.add(asrCtl);
        let res;
        try {
          res = await fetchWithTimeout(apiBase + "/asr", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ audio: b64, format: "webm" })
          }, ASR_TIMEOUT_MS, asrCtl ? asrCtl.signal : void 0);
        } finally {
          if (asrCtl) asrAborts.delete(asrCtl);
        }
        const data = await res.json();
        if (!running) return;
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
      const plainKey = echoKey(text);
      if (plain.length < 2 && !/^[停别不]$/.test(plain)) return false;
      if (isNoiseText(plain)) return false;
      if (/^本鱼在听/.test(plain)) return false;
      const now = Date.now();
      let hadRecentSpeech = false;
      for (const s of spokenRecent) {
        if (now - s.at > 15e3) continue;
        if (now - s.at <= 8e3) hadRecentSpeech = true;
        const target = s.text.replace(/[\s。，！？,.!?、…~～]/g, "");
        if (!target) continue;
        const targetKey = echoKey(s.text);
        if (plainKey && targetKey && (plainKey === targetKey || targetKey.length >= 6 && plainKey.indexOf(targetKey.slice(0, 6)) >= 0)) {
          try {
            stats.echoDropped++;
          } catch (e) {
          }
          return false;
        }
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
      if (isShortEchoFragment(plain, hadRecentSpeech)) {
        try {
          stats.shortDropped = (stats.shortDropped || 0) + 1;
        } catch (e) {
        }
        return false;
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
        try {
          if (ttsAudio) {
            ttsAudio.pause();
            ttsAudio.onended = null;
            ttsAudio.onerror = null;
          }
        } catch (e) {
        }
        ttsAudio = null;
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
    let ttsSeq = 0;
    function synth(job) {
      const ctl = typeof AbortController !== "undefined" ? new AbortController() : null;
      if (ctl) ttsAborts.add(ctl);
      return fetchWithTimeout(apiBase + "/tts", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: job.text, voice: voiceName, rate: job.rate, pitch: job.pitch || "" })
      }, TTS_TIMEOUT_MS, ctl ? ctl.signal : void 0).then((r) => {
        if (!r.ok) throw new Error("tts-http-" + r.status);
        return r.arrayBuffer();
      }).catch((e) => {
        stats.lastError = "tts: " + String(e && e.name || e);
        return null;
      }).finally(() => {
        if (ctl) ttsAborts.delete(ctl);
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
      ttsProgressAt = Date.now();
      ttsCurJob = job;
      const myToken = ++speakToken;
      setStatus("speaking");
      stats.ttsRequests++;
      const cur = ttsPrefetch.get(job.seq) || synth(job);
      ttsSynthAt = Date.now();
      ttsPrefetch.delete(job.seq);
      const next = ttsQ[0];
      if (next && !ttsPrefetch.has(next.seq)) ttsPrefetch.set(next.seq, synth(next));
      const next2 = ttsQ[1];
      if (job.narration && next2 && !ttsPrefetch.has(next2.seq)) ttsPrefetch.set(next2.seq, synth(next2));
      cur.then((buf) => {
        if (myToken !== speakToken) return;
        ttsSynthAt = 0;
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
          const canBrowser = !job.strict && (() => {
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
        micOn(false);
        a.play().catch(() => {
          if (myToken !== speakToken) {
            try {
              URL.revokeObjectURL(url);
            } catch (e) {
            }
            ;
            return;
          }
          if (!muted) micOn(true);
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
          const canBrowser2 = !job.strict && (() => {
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
    async function fetchWithTimeout(url, init, ms2, outer) {
      const ctl = typeof AbortController !== "undefined" ? new AbortController() : null;
      const timer = ctl ? setTimeout(() => {
        try {
          ctl.abort();
        } catch (e) {
        }
      }, ms2) : null;
      let sig = ctl ? ctl.signal : void 0;
      if (outer) {
        try {
          sig = ctl && typeof AbortSignal.any === "function" ? AbortSignal.any([ctl.signal, outer]) : outer || ctl.signal;
        } catch (e) {
          sig = outer || sig;
        }
      }
      try {
        return await fetch(url, sig ? { ...init, signal: sig } : init);
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
          if (!running) {
            parts = [];
            return;
          }
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
      const raw = stripStageDirections(String(text || ""));
      if (!raw) return;
      const narration = o && typeof o.narration === "boolean" ? o.narration : raw.length >= 80;
      const rate = o && o.rate ? o.rate : narration ? narrationRate() : "+0%";
      const strict = !!(o && o.strict);
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
          strict,
          onDone: i === segs.length - 1 ? o && o.onDone : void 0
        });
      }
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
        epMode = m === "ape" ? "ape" : "classic";
        try {
          localStorage.setItem("chubby-endpoint", epMode);
        } catch (e) {
        }
      },
      // 端点检测：报告当前实际生效的模式（ape / classic），不再写死 classic
      endpointInfo: () => ({ mode: epMode }),
      lastSegment: () => lastSeg,
      lastTtsInfo: () => lastTts,
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
      status: () => status
    };
  }

  // src/client/wake.ts
  var WAKE_WORDS = ["\u5927\u80A5\u9C7C", "\u5C0F\u84DD\u9C7C", "\u80A5\u9CB8", "\u80A5\u9C7C", "\u5C0F\u9C7C", "\u84DD\u9C7C", "\u9C7C\u9C7C", "\u80A5\u80A5"];
  deepFreeze(WAKE_WORDS);
  var WAKE_WINDOW_MS = 3e4;
  var TRAD_TO_SIMPLE = { "\u9B5A": "\u9C7C", "\u98DB": "\u98DE", "\u85CD": "\u84DD", "\u7C43": "\u7BEE", "\u862D": "\u5170", "\u9BE8": "\u9CB8" };
  function normalizeWakeText(text) {
    return String(text == null ? "" : text).split("").map((c) => TRAD_TO_SIMPLE[c] || c).join("").replace(/[\s。，、！？；：,.!?;:…~～·"'“”‘’（）()【】\[\]]/g, "").toLowerCase();
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
    const raw = String(input == null ? "" : input);
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
        return { hit: false, pass, text: String(text == null ? "" : text).trim(), word: "", remainingMs: remainingMs(now) };
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
    const gate = createWakeGate();
    const wakeStats = { passed: 0, dropped: 0, hits: 0, lastHitAt: 0, dropNotifiedAt: 0 };
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
                host.bubble("\u597D\uFF0C\u4E0D\u5FF5\u4E86", 2500);
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
                  host.bubble("\u597D\uFF0C\u4E0D\u8BF4\u4E86", 2e3);
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
          if (!r.pass) {
            wakeStats.dropped++;
            const now = Date.now();
            if (now - wakeStats.dropNotifiedAt > 2e4) {
              wakeStats.dropNotifiedAt = now;
              try {
                host.bubble("\u5148\u558A\u4E00\u58F0\u300C" + (gate.words[0] || "\u5927\u80A5\u9C7C") + "\u300D\uFF0C\u672C\u9CB8\u624D\u7B54\u8BDD\uFF5E", 3500);
              } catch (e) {
              }
            }
            bump("wakeDrop");
            pushWake();
            return;
          }
          if (!r.text) {
            try {
              if (host.say) host.say("\u672C\u9CB8\u5728\u5462\uFF5E", 2200);
              else host.bubble("\u672C\u9CB8\u5728\u5462\uFF5E", 2200);
            } catch (e) {
              try {
                host.bubble("\u672C\u9CB8\u5728\u5462\uFF5E", 2200);
              } catch (e2) {
              }
            }
            pushWake();
            return;
          }
          wakeStats.passed++;
          try {
            host.bubble("\uFF08\u542C\u5230\uFF09" + r.text + "\uFF5C\u672C\u9C7C\u5728\u60F3\u2026", 3e3);
          } catch (e) {
          }
          try {
            host.sendText(r.text, { voice: true });
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
    return fetch(apiUrl(path), Object.assign({ method: "DELETE" }, init || {})).then((r) => r.json());
  }
  function timeoutSignal(ms2) {
    try {
      const AS = typeof AbortSignal !== "undefined" ? AbortSignal : null;
      if (AS && typeof AS.timeout === "function") return AS.timeout(Number(ms2) || 0);
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
    for (const pair of notes || []) beats += Number(pair && pair[1]) || 1;
    return Math.round(beats * beatSeconds(bpm) * 10) / 10;
  }
  function createMelodyPlayer() {
    let ctx = null;
    let oscs = [];
    let doneTimer = null;
    function stop() {
      try {
        for (const o of oscs) {
          try {
            o.stop();
          } catch (e) {
          }
        }
      } catch (e) {
      }
      oscs = [];
      try {
        if (doneTimer) {
          clearTimeout(doneTimer);
          doneTimer = null;
        }
      } catch (e) {
      }
      try {
        if (ctx) ctx.close();
      } catch (e) {
      }
      ctx = null;
    }
    function play(notes, bpm, onDone) {
      try {
        stop();
        const AC = window.AudioContext || window.webkitAudioContext;
        if (!AC) return;
        const c = new AC();
        ctx = c;
        try {
          c.resume();
        } catch (e) {
        }
        try {
          if (c.state === "suspended") c.resume();
        } catch (e) {
        }
        const beat = beatSeconds(bpm);
        let t = c.currentTime + 0.05;
        for (const pair of notes || []) {
          const nm = String(pair && pair[0]);
          const dur = Number(pair && pair[1]) || 1;
          const f = NOTE_FREQ[nm];
          if (!f) {
            t += dur * beat;
            continue;
          }
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
          oscs.push(o);
          t += dur * beat;
        }
        const totalMs = Math.max(0, (t - c.currentTime) * 1e3) + 300;
        if (onDone) doneTimer = setTimeout(() => {
          try {
            onDone();
          } catch (e) {
          }
        }, totalMs);
      } catch (e) {
      }
    }
    return { play, stop };
  }

  // src/client/duilian.ts
  var COUPLETS = [
    {
      "upper": "\u98CE\u58F0\u96E8\u58F0\u8BFB\u4E66\u58F0\uFF0C\u58F0\u58F0\u5165\u8033",
      "lower": "\u5BB6\u4E8B\u56FD\u4E8B\u5929\u4E0B\u4E8B\uFF0C\u4E8B\u4E8B\u5173\u5FC3",
      "source": "\u660E\xB7\u987E\u5BAA\u6210\u9898\u65E0\u9521\u4E1C\u6797\u4E66\u9662",
      "cat": "\u4E66\u9662"
    },
    {
      "upper": "\u6D77\u7EB3\u767E\u5DDD\uFF0C\u6709\u5BB9\u4E43\u5927",
      "lower": "\u58C1\u7ACB\u5343\u4EDE\uFF0C\u65E0\u6B32\u5219\u521A",
      "source": "\u6E05\xB7\u6797\u5219\u5F90\u81EA\u9898\u8054",
      "cat": "\u683C\u8A00"
    },
    {
      "upper": "\u5BA4\u96C5\u4F55\u987B\u5927",
      "lower": "\u82B1\u9999\u4E0D\u5728\u591A",
      "source": "\u6E05\xB7\u90D1\u677F\u6865",
      "cat": "\u683C\u8A00"
    },
    {
      "upper": "\u5220\u7E41\u5C31\u7B80\u4E09\u79CB\u6811",
      "lower": "\u9886\u5F02\u6807\u65B0\u4E8C\u6708\u82B1",
      "source": "\u6E05\xB7\u90D1\u677F\u6865",
      "cat": "\u683C\u8A00"
    },
    {
      "upper": "\u5899\u4E0A\u82A6\u82C7\uFF0C\u5934\u91CD\u811A\u8F7B\u6839\u5E95\u6D45",
      "lower": "\u5C71\u95F4\u7AF9\u7B0B\uFF0C\u5634\u5C16\u76AE\u539A\u8179\u4E2D\u7A7A",
      "source": "\u76F8\u4F20\u4E3A\u660E\xB7\u89E3\u7F19\u4F5C",
      "cat": "\u8C10\u8DA3"
    },
    {
      "upper": "\u94C1\u80A9\u62C5\u9053\u4E49",
      "lower": "\u5999\u624B\u8457\u6587\u7AE0",
      "source": "\u674E\u5927\u948A\u300A\u6668\u949F\u62A5\u300B\u521B\u520A\u53F7\uFF081916\uFF09",
      "cat": "\u683C\u8A00"
    },
    {
      "upper": "\u56DB\u9762\u8377\u82B1\u4E09\u9762\u67F3",
      "lower": "\u4E00\u57CE\u5C71\u8272\u534A\u57CE\u6E56",
      "source": "\u6E05\xB7\u5218\u51E4\u8BF0\u9898\u6D4E\u5357\u5927\u660E\u6E56\u94C1\u516C\u7960",
      "cat": "\u540D\u80DC"
    },
    {
      "upper": "\u9752\u5C71\u6709\u5E78\u57CB\u5FE0\u9AA8",
      "lower": "\u767D\u94C1\u65E0\u8F9C\u94F8\u4F5E\u81E3",
      "source": "\u676D\u5DDE\u5CB3\u738B\u5E99\u5893\u9619\u8054\uFF08\u4F20\u7EDF\uFF09",
      "cat": "\u540D\u80DC"
    },
    {
      "upper": "\u4E00\u7CA5\u4E00\u996D\uFF0C\u5F53\u601D\u6765\u5904\u4E0D\u6613",
      "lower": "\u534A\u4E1D\u534A\u7F15\uFF0C\u6052\u5FF5\u7269\u529B\u7EF4\u8270",
      "source": "\u660E\u672B\u6E05\u521D\xB7\u6731\u67CF\u5E90\u300A\u6CBB\u5BB6\u683C\u8A00\u300B",
      "cat": "\u683C\u8A00"
    },
    {
      "upper": "\u8BFB\u4E66\u597D\uFF0C\u8015\u7530\u597D\uFF0C\u5B66\u597D\u4FBF\u597D",
      "lower": "\u521B\u4E1A\u96BE\uFF0C\u5B88\u6210\u96BE\uFF0C\u77E5\u96BE\u4E0D\u96BE",
      "source": "\u6E05\xB7\u5434\u656C\u6893\u300A\u5112\u6797\u5916\u53F2\u300B\u7B2C\u4E8C\u5341\u4E8C\u56DE",
      "cat": "\u683C\u8A00"
    },
    {
      "upper": "\u6625\u98CE\u5927\u96C5\u80FD\u5BB9\u7269",
      "lower": "\u79CB\u6C34\u6587\u7AE0\u4E0D\u67D3\u5C18",
      "source": "\u6E05\xB7\u9093\u77F3\u5982",
      "cat": "\u683C\u8A00"
    },
    {
      "upper": "\u96E8\u8FC7\u7434\u4E66\u6DA6",
      "lower": "\u98CE\u6765\u7FF0\u58A8\u9999",
      "source": "\u4F20\u7EDF\u4E66\u623F\u8054",
      "cat": "\u4E66\u623F"
    },
    {
      "upper": "\u5927\u809A\u80FD\u5BB9\uFF0C\u5BB9\u5929\u4E0B\u96BE\u5BB9\u4E4B\u4E8B",
      "lower": "\u5F00\u53E3\u4FBF\u7B11\uFF0C\u7B11\u4E16\u95F4\u53EF\u7B11\u4E4B\u4EBA",
      "source": "\u4F20\u7EDF\u5F25\u52D2\u4F5B\u8054",
      "cat": "\u8C10\u8DA3"
    },
    {
      "upper": "\u5929\u589E\u5C81\u6708\u4EBA\u589E\u5BFF",
      "lower": "\u6625\u6EE1\u4E7E\u5764\u798F\u6EE1\u95E8",
      "source": "\u4F20\u7EDF\u6625\u8054",
      "cat": "\u6625\u8054"
    },
    {
      "upper": "\u4E00\u5143\u590D\u59CB",
      "lower": "\u4E07\u8C61\u66F4\u65B0",
      "source": "\u4F20\u7EDF\u6625\u8054",
      "cat": "\u6625\u8054"
    },
    {
      "upper": "\u6625\u56DE\u5927\u5730",
      "lower": "\u798F\u6EE1\u4EBA\u95F4",
      "source": "\u4F20\u7EDF\u6625\u8054",
      "cat": "\u6625\u8054"
    },
    {
      "upper": "\u95E8\u8FCE\u767E\u798F",
      "lower": "\u6237\u7EB3\u5343\u7965",
      "source": "\u4F20\u7EDF\u6625\u8054",
      "cat": "\u6625\u8054"
    },
    {
      "upper": "\u4E94\u6E56\u56DB\u6D77\u7686\u6625\u8272",
      "lower": "\u4E07\u6C34\u5343\u5C71\u5C3D\u5F97\u8F89",
      "source": "\u4F20\u7EDF\u6625\u8054",
      "cat": "\u6625\u8054"
    },
    {
      "upper": "\u677E\u7AF9\u6885\u5C81\u5BD2\u4E09\u53CB",
      "lower": "\u6843\u674E\u674F\u6625\u98CE\u4E00\u5BB6",
      "source": "\u4F20\u7EDF",
      "cat": "\u683C\u8A00"
    },
    {
      "upper": "\u798F\u5982\u4E1C\u6D77\u957F\u6D41\u6C34",
      "lower": "\u5BFF\u6BD4\u5357\u5C71\u4E0D\u8001\u677E",
      "source": "\u4F20\u7EDF\u5BFF\u8054",
      "cat": "\u5BFF\u8054"
    },
    {
      "upper": "\u5BA2\u4E0A\u5929\u7136\u5C45",
      "lower": "\u5C45\u7136\u5929\u4E0A\u5BA2",
      "source": "\u4F20\u7EDF\u56DE\u6587\u8054\uFF08\u987A\u8BFB\u5012\u8BFB\u540C\u53E5\uFF09",
      "cat": "\u8C10\u8DA3"
    },
    {
      "upper": "\u753B\u4E0A\u8377\u82B1\u548C\u5C1A\u753B",
      "lower": "\u4E66\u4E34\u6C49\u5E16\u7FF0\u6797\u4E66",
      "source": "\u4F20\u7EDF\u56DE\u6587\u8054",
      "cat": "\u8C10\u8DA3"
    },
    {
      "upper": "\u56E0\u8377\u800C\u5F97\u85D5",
      "lower": "\u6709\u674F\u4E0D\u987B\u6885",
      "source": "\u4F20\u7EDF\u8C10\u97F3\u8054\uFF08\u8377=\u4F55\u3001\u85D5=\u5076\uFF1B\u674F=\u5E78\u3001\u6885=\u5A92\uFF09",
      "cat": "\u8C10\u8DA3"
    },
    {
      "upper": "\u4E24\u821F\u5E76\u884C\uFF0C\u6A79\u901F\u4E0D\u5982\u5E06\u5FEB",
      "lower": "\u516B\u97F3\u9F50\u594F\uFF0C\u7B1B\u6E05\u96BE\u6BD4\u7BAB\u548C",
      "source": "\u4F20\u7EDF\u8C10\u97F3\u8054\uFF08\u6A79\u901F=\u9C81\u8083\u3001\u5E06\u5FEB=\u6A0A\u54D9\uFF1B\u7B1B\u6E05=\u72C4\u9752\u3001\u7BAB\u548C=\u8427\u4F55\uFF09",
      "cat": "\u8C10\u8DA3"
    },
    {
      "upper": "\u5357\u901A\u5DDE\uFF0C\u5317\u901A\u5DDE\uFF0C\u5357\u5317\u901A\u5DDE\u901A\u5357\u5317",
      "lower": "\u4E1C\u5F53\u94FA\uFF0C\u897F\u5F53\u94FA\uFF0C\u4E1C\u897F\u5F53\u94FA\u5F53\u4E1C\u897F",
      "source": "\u4F20\u7EDF\u5730\u540D\u8054",
      "cat": "\u8C10\u8DA3"
    },
    {
      "upper": "\u5929\u4F5C\u68CB\u76D8\u661F\u4F5C\u5B50\uFF0C\u8C01\u4EBA\u6562\u4E0B",
      "lower": "\u5730\u4E3A\u7435\u7436\u8DEF\u4E3A\u5F26\uFF0C\u54EA\u4E2A\u80FD\u5F39",
      "source": "\u4F20\u7EDF\uFF08\u6C11\u95F4\u6D41\u4F20\uFF09",
      "cat": "\u8C10\u8DA3"
    },
    {
      "upper": "\u5899\u4E0A\u753B\u9A6C\u4E0D\u80FD\u9A91",
      "lower": "\u955C\u91CC\u70E7\u997C\u96BE\u5145\u9965",
      "source": "\u4F20\u7EDF\uFF08\u6C11\u95F4\u4FD7\u8054\uFF09",
      "cat": "\u8C10\u8DA3"
    },
    {
      "upper": "\u6C34\u6E05\u77F3\u51FA\u9C7C\u53EF\u6570",
      "lower": "\u6797\u6DF1\u65E0\u4EBA\u9E1F\u76F8\u547C",
      "source": "\u5B8B\xB7\u82CF\u8F7C\u8BD7\u53E5\uFF08\u6210\u8054\u6B23\u8D4F\uFF09",
      "cat": "\u666F\u89C2"
    },
    {
      "upper": "\u9752\u5C71\u4E0D\u58A8\u5343\u79CB\u753B",
      "lower": "\u6D41\u6C34\u65E0\u5F26\u4E07\u53E4\u7434",
      "source": "\u4F20\u7EDF\uFF08\u6D41\u4F20\u751A\u5E7F\uFF0C\u4F5C\u8005\u5F85\u8003\uFF09",
      "cat": "\u666F\u89C2"
    },
    {
      "upper": "\u4E91\u5E26\u949F\u58F0\u7A7F\u6811\u53BB",
      "lower": "\u6708\u79FB\u5854\u5F71\u8FC7\u6C5F\u6765",
      "source": "\u4F20\u7EDF\u540D\u80DC\u8054",
      "cat": "\u540D\u80DC"
    },
    {
      "upper": "\u6B64\u6728\u4E3A\u67F4\u5C71\u5C71\u51FA",
      "lower": "\u56E0\u706B\u6210\u70DF\u5915\u5915\u591A",
      "source": "\u4F20\u7EDF\u62C6\u5B57\u8054\uFF08\u67F4=\u6B64+\u6728\u3001\u51FA=\u5C71+\u5C71\uFF1B\u70DF=\u56E0+\u706B\u3001\u591A=\u5915+\u5915\uFF09",
      "cat": "\u8C10\u8DA3"
    },
    {
      "upper": "\u9F20\u65E0\u5927\u5C0F\u7686\u79F0\u8001",
      "lower": "\u9E66\u6709\u96CC\u96C4\u90FD\u53EB\u54E5",
      "source": "\u4F20\u7EDF\u8C10\u8DA3\u8054",
      "cat": "\u8C10\u8DA3"
    },
    {
      "upper": "\u4EBA\u66FE\u662F\u50E7\uFF0C\u4EBA\u5F17\u80FD\u6210\u4F5B",
      "lower": "\u5973\u5351\u4E3A\u5A62\uFF0C\u5973\u53C8\u53EF\u79F0\u5974",
      "source": "\u76F8\u4F20\u4E3A\u82CF\u8F7C\u4E0E\u4F5B\u5370\u548C\u5C1A\u620F\u5BF9",
      "cat": "\u8C10\u8DA3"
    },
    {
      "upper": "\u4E8C\u4E09\u56DB\u4E94",
      "lower": "\u516D\u4E03\u516B\u4E5D",
      "source": "\u4F20\u7EDF\u8C10\u610F\u8054\uFF08\u4E0A\u8054\u7F3A\u300C\u4E00\u300D\uFF0C\u4E0B\u8054\u5C11\u300C\u5341\u300D\uFF1A\u7F3A\u8863\u5C11\u98DF\uFF09",
      "cat": "\u8C10\u8DA3"
    },
    {
      "upper": "\u5B9D\u5251\u950B\u4ECE\u78E8\u783A\u51FA",
      "lower": "\u6885\u82B1\u9999\u81EA\u82E6\u5BD2\u6765",
      "source": "\u4F20\u7EDF\u683C\u8A00\u8054",
      "cat": "\u683C\u8A00"
    },
    {
      "upper": "\u4E66\u5C71\u6709\u8DEF\u52E4\u4E3A\u5F84",
      "lower": "\u5B66\u6D77\u65E0\u6DAF\u82E6\u4F5C\u821F",
      "source": "\u4F20\u7EDF\u683C\u8A00\u8054\uFF08\u5E38\u89C1\u7F72\u540D\u97E9\u6108\uFF0C\u51FA\u5904\u5F85\u8003\uFF0C\u6545\u4E0D\u7F72\uFF09",
      "cat": "\u683C\u8A00"
    },
    {
      "upper": "\u4E66\u5230\u7528\u65F6\u65B9\u6068\u5C11",
      "lower": "\u4E8B\u975E\u7ECF\u8FC7\u4E0D\u77E5\u96BE",
      "source": "\u4F20\u7EDF\u683C\u8A00\u8054",
      "cat": "\u683C\u8A00"
    },
    {
      "upper": "\u6D77\u9614\u51ED\u9C7C\u8DC3",
      "lower": "\u5929\u9AD8\u4EFB\u9E1F\u98DE",
      "source": "\u4F20\u7EDF\u683C\u8A00\u8054",
      "cat": "\u683C\u8A00"
    },
    {
      "upper": "\u8DEF\u9065\u77E5\u9A6C\u529B",
      "lower": "\u65E5\u4E45\u89C1\u4EBA\u5FC3",
      "source": "\u4F20\u7EDF\uFF08\u4FD7\u8C1A\u6210\u8054\uFF09",
      "cat": "\u683C\u8A00"
    },
    {
      "upper": "\u548C\u987A\u4E00\u95E8\u6709\u767E\u798F",
      "lower": "\u5E73\u5B89\u4E8C\u5B57\u503C\u5343\u91D1",
      "source": "\u4F20\u7EDF\u6625\u8054",
      "cat": "\u6625\u8054"
    },
    {
      "upper": "\u7206\u7AF9\u4E00\u58F0\u9664\u65E7",
      "lower": "\u6843\u7B26\u4E07\u6237\u66F4\u65B0",
      "source": "\u4F20\u7EDF\u6625\u8054\uFF08\u5316\u7528\u738B\u5B89\u77F3\u300A\u5143\u65E5\u300B\uFF09",
      "cat": "\u6625\u8054"
    },
    {
      "upper": "\u5929\u6CF0\u5730\u6CF0\u4E09\u9633\u6CF0",
      "lower": "\u5BB6\u548C\u4EBA\u548C\u4E07\u4E8B\u548C",
      "source": "\u4F20\u7EDF\u6625\u8054",
      "cat": "\u6625\u8054"
    },
    {
      "upper": "\u4E00\u5E74\u56DB\u5B63\u6625\u5E38\u5728",
      "lower": "\u4E07\u7D2B\u5343\u7EA2\u82B1\u6C38\u5F00",
      "source": "\u4F20\u7EDF\u6625\u8054",
      "cat": "\u6625\u8054"
    },
    {
      "upper": "\u8FD1\u6C34\u697C\u53F0\u5148\u5F97\u6708",
      "lower": "\u5411\u9633\u82B1\u6728\u6613\u4E3A\u6625",
      "source": "\u5B8B\xB7\u82CF\u9E9F\u8BD7\uFF08\u76F8\u4F20\uFF09",
      "cat": "\u683C\u8A00"
    },
    {
      "upper": "\u5C71\u91CD\u6C34\u590D\u7591\u65E0\u8DEF",
      "lower": "\u67F3\u6697\u82B1\u660E\u53C8\u4E00\u6751",
      "source": "\u5B8B\xB7\u9646\u6E38\u300A\u6E38\u5C71\u897F\u6751\u300B\u8BD7\u53E5\uFF08\u6210\u8054\u6B23\u8D4F\uFF09",
      "cat": "\u666F\u89C2"
    },
    {
      "upper": "\u4E00\u697C\u4F55\u5947\uFF1F\u675C\u5C11\u9675\u4E94\u8A00\u7EDD\u5531\uFF0C\u8303\u5E0C\u6587\u4E24\u5B57\u5173\u60C5\uFF0C\u6ED5\u5B50\u4EAC\u767E\u5E9F\u4FF1\u5174\uFF0C\u5415\u7EAF\u9633\u4E09\u8FC7\u5FC5\u9189\u3002\u8BD7\u8036\uFF1F\u5112\u8036\uFF1F\u540F\u8036\uFF1F\u4ED9\u8036\uFF1F\u524D\u4E0D\u89C1\u53E4\u4EBA\uFF0C\u4F7F\u6211\u6006\u7136\u6D95\u4E0B",
      "lower": "\u8BF8\u541B\u8BD5\u770B\uFF1A\u6D1E\u5EAD\u6E56\u5357\u6781\u6F47\u6E58\uFF0C\u626C\u5B50\u6C5F\u5317\u901A\u5DEB\u5CE1\uFF0C\u5DF4\u9675\u5C71\u897F\u6765\u723D\u6C14\uFF0C\u5CB3\u5DDE\u57CE\u4E1C\u9053\u5CA9\u7586\u3002\u6F74\u8005\uFF01\u6D41\u8005\uFF01\u5CD9\u8005\uFF01\u9547\u8005\uFF01\u6B64\u4E2D\u6709\u771F\u610F\uFF0C\u95EE\u8C01\u9886\u4F1A\u5F97\u6765",
      "source": "\u5CB3\u9633\u697C\u957F\u8054\uFF08\u6E05\xB7\u7AA6\u57BF\uFF0C\u4E00\u8BF4\u9648\u5927\u7EB2\uFF09",
      "cat": "\u540D\u80DC"
    },
    {
      "upper": "\u5174\u5E9F\u603B\u5173\u60C5\uFF0C\u770B\u843D\u971E\u5B64\u9E5C\u3001\u79CB\u6C34\u957F\u5929\uFF0C\u5E78\u6B64\u5730\u6E56\u5C71\u65E0\u6059",
      "lower": "\u53E4\u4ECA\u624D\u4E00\u77AC\uFF0C\u95EE\u6C5F\u4E0A\u624D\u4EBA\u3001\u9601\u4E2D\u5E1D\u5B50\uFF0C\u6BD4\u5F53\u5E74\u98CE\u666F\u5982\u4F55",
      "source": "\u6E05\xB7\u5218\u5764\u4E00\u9898\u5357\u660C\u6ED5\u738B\u9601",
      "cat": "\u540D\u80DC"
    },
    {
      "upper": "\u4E00\u697C\u8403\u4E09\u695A\u7CBE\u795E\uFF0C\u4E91\u9E64\u4FF1\u7A7A\u6A2A\u7B1B\u5728",
      "lower": "\u4E8C\u6C34\u6C47\u767E\u5DDD\u652F\u6D3E\uFF0C\u53E4\u4ECA\u65E0\u5C3D\u5927\u6C5F\u6D41",
      "source": "\u9EC4\u9E64\u697C\u8054\uFF08\u4F20\u7EDF\uFF09",
      "cat": "\u540D\u80DC"
    },
    {
      "upper": "\u767D\u5934\u7FC1\u7275\u725B\u8015\u719F\u5730",
      "lower": "\u7EA2\u5A18\u5B50\u4F5B\u624B\u63D2\u91D1\u82B1",
      "source": "\u4F20\u7EDF\u4E2D\u836F\u540D\u8054\uFF08\u767D\u5934\u7FC1/\u7275\u725B/\u719F\u5730/\u7EA2\u5A18\u5B50/\u4F5B\u624B/\u91D1\u82B1\u7686\u836F\u540D\uFF09",
      "cat": "\u4E2D\u836F"
    },
    {
      "upper": "\u6C34\u6C34\u5C71\u5C71\uFF0C\u5904\u5904\u660E\u660E\u79C0\u79C0",
      "lower": "\u6674\u6674\u96E8\u96E8\uFF0C\u65F6\u65F6\u597D\u597D\u5947\u5947",
      "source": "\u897F\u6E56\u53E0\u5B57\u8054\uFF08\u4F20\u7EDF\uFF09",
      "cat": "\u53E0\u5B57"
    },
    {
      "upper": "\u4E00\u53BB\u4E8C\u4E09\u91CC\uFF0C\u70DF\u6751\u56DB\u4E94\u5BB6",
      "lower": "\u4EAD\u53F0\u516D\u4E03\u5EA7\uFF0C\u516B\u4E5D\u5341\u679D\u82B1",
      "source": "\u5B8B\xB7\u90B5\u96CD\u300A\u5C71\u6751\u548F\u6000\u300B\u8BD7\u53E5\uFF08\u6570\u5B57\u8054\uFF09",
      "cat": "\u6570\u5B57"
    }
  ];
  deepFreeze(COUPLETS);
  var COUPLET_CATS = ["\u4E66\u9662", "\u683C\u8A00", "\u8C10\u8DA3", "\u540D\u80DC", "\u4E66\u623F", "\u6625\u8054", "\u5BFF\u8054", "\u666F\u89C2", "\u4E2D\u836F", "\u53E0\u5B57", "\u6570\u5B57"];
  deepFreeze(COUPLET_CATS);
  function pickCouplet(excludeUpper, cat) {
    const byCat = cat ? COUPLETS.filter((c) => c.cat === cat) : COUPLETS;
    const base = byCat.length > 0 ? byCat : COUPLETS;
    const pool = base.length > 1 && excludeUpper ? base.filter((c) => c.upper !== excludeUpper) : base;
    const src = pool.length > 0 ? pool : base;
    return src[Math.floor(Math.random() * src.length)];
  }

  // src/client/actions/culture.ts
  function poemRate(fallback) {
    try {
      const v = localStorage.getItem("chubby-poem-rate");
      if (v && /^-\d{1,2}%$/.test(v)) return v;
    } catch (e) {
    }
    return fallback;
  }
  function recitePoem(host, poem) {
    const body = String(poem.text || "");
    const author = String(poem.author || "\u4F5A\u540D");
    const lines = body.split(/\r?\n/).map((x) => x.trim()).filter(Boolean);
    const totalLines = lines.length;
    const intro = "\u5FF5\u9996\u8BD7\u2014\u2014" + poem.title + "\uFF0C" + (poem.dynasty ? poem.dynasty + "\uFF0C" : "") + author + "\u3002";
    try {
      startProgress("\u5FF5\u8BD7\xB7" + String(poem.title || ""), lines, intro);
    } catch (e) {
    }
    host.bubble("\u5FF5\u8BD7\xB7" + poem.title + "\uFF08" + author + "\uFF09" + (totalLines > 1 ? "\xB7 \u5171 " + totalLines + " \u53E5" : ""), 15e3);
    host.talkFor(6e3);
    const speech = intro + collapsePoemBody(body);
    host.narrate(estimateSpeakMs(speech));
    host.say(host.persona.line("poemStart"), 4e3);
    setTimeout(() => {
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
    }, 600);
  }
  function registerCultureActions(table) {
    let lastCouplet = "";
    table.define("poem", (host) => {
      getJson("/poem").then((d) => {
        const p = d && d.ok && d.item ? d.item : null;
        if (!p) {
          host.bubble("\u8BD7\u518C\u6CA1\u8BFB\u5230");
          return;
        }
        recitePoem(host, p);
      }).catch(() => host.bubble("\u8BD7\u518C\u6CA1\u8BFB\u5230"));
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
    table.define("story-auto", (host) => {
      const cur = host && host.storyState && host.storyState.auto ? !!host.storyState.auto.current : true;
      const next = !cur;
      try {
        if (host.storyState && host.storyState.auto) host.storyState.auto.current = next;
      } catch (e) {
      }
      try {
        localStorage.setItem("chubby-story-auto", next ? "1" : "0");
      } catch (e) {
      }
      host.bubble(next ? "\u8FDE\u64AD\uFF1A\u5F00\u2014\u2014\u8BB2\u5B8C\u8FD9\u6BB5\u81EA\u52A8\u63A5\u4E0B\u4E00\u6BB5" : "\u8FDE\u64AD\uFF1A\u5173\u2014\u2014\u8BB2\u5B8C\u8FD9\u6BB5\u5C31\u505C", 4e3);
    });
    table.definePrefix("narration-rate:", (host, suffix) => {
      const v = String(suffix || "");
      if (setNarrationRate(v)) host.bubble("\u53D9\u8FF0\u8BED\u901F\uFF1A" + v, 4e3);
      else host.bubble("\u8FD9\u4E2A\u8BED\u901F\u503C\u4E0D\u8BA4", 3e3);
    });
    table.definePrefix("poem-rate:", (host, suffix) => {
      const rate = String(suffix || "");
      if (!/^-\d{1,2}%$/.test(rate)) {
        host.bubble("\u8FD9\u4E2A\u8BED\u901F\u503C\u4E0D\u8BA4", 3e3);
        return;
      }
      try {
        localStorage.setItem("chubby-poem-rate", rate);
      } catch (e) {
      }
      host.bubble("\u5FF5\u8BD7\u8BED\u901F\uFF1A" + rate, 4e3);
    });
    table.definePrefix("story-rate:", (host, suffix) => {
      const rate = String(suffix || "");
      if (!/^-\d{1,2}%$/.test(rate)) {
        host.bubble("\u8FD9\u4E2A\u8BED\u901F\u503C\u4E0D\u8BA4", 3e3);
        return;
      }
      try {
        localStorage.setItem("chubby-story-rate", rate);
      } catch (e) {
      }
      host.bubble("\u8BF4\u4E66\u8BED\u901F\uFF1A" + rate, 4e3);
    });
    table.define("culture-tale", (host) => {
      getJson("/culture?type=minsu").then((d) => {
        if (!(d && d.ok && d.item)) {
          host.bubble("\u6545\u4E8B\u6CA1\u8BB2\u6210");
          return;
        }
        const tp = taleParts(d.item.title);
        const body = collapseText(d.item.text);
        host.bubble("\u8BB2\u6C11\u95F4\u6545\u4E8B\xB7" + tp.title + (tp.book ? "\uFF08\u51FA\u81EA\u300A" + tp.book + "\u300B\uFF09" : ""), 9e3);
        host.talkFor(5e3);
        host.speak("\u8BB2\u4E2A\u6C11\u95F4\u6545\u4E8B\u2014\u2014" + tp.title + (tp.book ? "\uFF0C\u51FA\u81EA\u300A" + tp.book + "\u300B" : "") + "\u3002" + body.slice(0, 6e3), {
          rate: host.narrationRate(),
          onDone: () => {
            host.bubble("\u6545\u4E8B\u8BB2\u5B8C\u5566\uFF5E", 5e3);
            try {
              host.speak("\u8BB2\u5B8C\u5566\uFF5E");
            } catch (e) {
            }
          }
        });
      }).catch(() => host.bubble("\u6545\u4E8B\u6CA1\u8BB2\u6210"));
    });
    table.define("culture-allusion", (host) => {
      getJson("/culture?type=chengyu").then((d) => {
        if (!(d && d.ok && d.item)) {
          host.bubble("\u5178\u6545\u6CA1\u8BB2\u6210");
          return;
        }
        const body = collapseText(d.item.text);
        host.bubble("\u8BB2\u5178\u6545\xB7" + d.item.title + "\uFF08" + (d.item.src || "") + "\uFF09", 9e3);
        host.talkFor(5e3);
        host.speak("\u8BB2\u4E2A\u5178\u6545\u2014\u2014" + String(d.item.title || "") + "\uFF0C\u51FA\u81EA" + String(d.item.src || "") + "\u3002" + body, {
          rate: host.narrationRate(),
          onDone: () => {
            host.bubble("\u5178\u6545\u8BB2\u5B8C\u5566\uFF5E", 5e3);
            try {
              host.speak("\u8BB2\u5B8C\u5566\uFF5E");
            } catch (e) {
            }
          }
        });
      }).catch(() => host.bubble("\u5178\u6545\u6CA1\u8BB2\u6210"));
    });
    table.define("culture-idiom", (host) => {
      getJson("/culture?type=idiom").then((d) => {
        if (!(d && d.ok && d.item)) {
          host.bubble("\u6CA1\u67E5\u5230");
          return;
        }
        host.bubble("\u6210\u8BED\u8FA8\u6790\xB7" + d.item.title, 8e3);
        const sp = String(d.item.title || "") + "\uFF1A" + String(d.item.text || "");
        host.speak(sp, {
          rate: host.narrationRate(),
          onDone: () => {
            host.bubble("\u8FD9\u4E2A\u6210\u8BED\u8BB2\u5B8C\u5566\uFF5E", 5e3);
            try {
              host.speak("\u8BB2\u5B8C\u5566\uFF5E");
            } catch (e) {
            }
          }
        });
      }).catch(() => host.bubble("\u6CA1\u67E5\u5230"));
    });
    table.define("culture-couplet", (host) => {
      const c = pickCouplet(lastCouplet);
      lastCouplet = c.upper;
      host.bubble("\u4E0A\u8054\uFF1A" + c.upper + "\uFF08\u5148\u5BF9\u4E00\u5BF9\uFF0C\u672C\u9CB8 6 \u79D2\u540E\u63ED\u6653\u4E0B\u8054\uFF09", 5600);
      setTimeout(() => {
        try {
          host.bubble("\u4E0B\u8054\uFF1A" + c.lower + "\n\u2014\u2014" + c.source, 7e3);
        } catch (e) {
        }
      }, 6e3);
    });
    table.definePrefix("culture-couplet:", (host, cat) => {
      const c = pickCouplet(lastCouplet, cat);
      lastCouplet = c.upper;
      host.bubble("\u3010" + c.cat + "\u3011\u4E0A\u8054\uFF1A" + c.upper + "\uFF08\u5148\u5BF9\u4E00\u5BF9\uFF0C\u672C\u9CB8 6 \u79D2\u540E\u63ED\u6653\u4E0B\u8054\uFF09", 5600);
      setTimeout(() => {
        try {
          host.bubble("\u4E0B\u8054\uFF1A" + c.lower + "\n\u2014\u2014" + c.source, 7e3);
        } catch (e) {
        }
      }, 6e3);
    });
    table.definePrefix("music:", (host, name) => {
      host.stopSpeak();
      getJson("/melody?name=" + encodeURIComponent(name)).then((d) => {
        if (!(d && d.ok && d.song)) {
          host.bubble("\u8FD9\u9996\u66F2\u5B50\u6CA1\u627E\u5230");
          return;
        }
        const songName = String(d.song.name || "\u8FD9\u9996\u66F2\u5B50");
        const bpm = Number(d.song.bpm) || 100;
        const notes = d.song.notes || [];
        const estSec = estimateMelodySeconds(notes, bpm);
        host.bubble("\u5F39\u300A" + songName + "\u300B\u266A\uFF08\u7EA6 " + estSec + " \u79D2\uFF09", 6e3);
        host.playMelody(notes, bpm, () => {
          host.bubble("\u5F39\u5B8C\u5566\uFF5E\u300A" + songName + "\u300B", 6e3);
          host.talkFor(1500);
          try {
            host.diag({ melodyVoice: { at: Date.now(), requested: true, ok: false, err: "" } });
            host.speak("\u5F39\u5B8C\u5566\uFF5E");
            setTimeout(() => {
              try {
                const w = typeof window !== "undefined" ? window.__chubbyWhale : null;
                const info = w && w.melodyVoice;
                if (info && !host.voicePlaying()) info.err = "TTS \u672A\u5F00\u59CB\uFF08\u53EF\u80FD\u88AB\u6D4F\u89C8\u5668\u62E6\u6216\u5408\u6210\u5931\u8D25\uFF09";
              } catch (e) {
              }
            }, 1200);
          } catch (e) {
            host.diag({ melodyVoice: { requested: false, err: String(e) } });
          }
        });
      }).catch(() => host.bubble("\u5F39\u7434\u5931\u8D25"));
    });
  }

  // src/client/actions/content.ts
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
        weather ? "\u5317\u6D77\u5929\u6C14\uFF1A" + weather : "",
        growth ? "\u80A5\u9CB8\u6210\u957F\uFF1A" + growth : ""
      ].filter(Boolean).join("\n");
      if (head) first.push(head);
      if (Array.isArray(d.todos)) second.push("\u5F85\u529E\u63D0\u9192\uFF1A" + d.todos.length + " \u6761");
      else if (typeof d.todos === "string" && d.todos.trim()) second.push("\u5F85\u529E\u63D0\u9192\uFF1A" + d.todos.trim());
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
        const books = d && d.ok && Array.isArray(d.books) ? d.books.map((b) => String(b || "").trim()).filter(Boolean) : [];
        if (!books.length) {
          host.bubble("\u4E66\u5355\u6CA1\u53D6\u5230\uFF0C\u7A0D\u540E\u518D\u8BD5", 4e3);
          return;
        }
        host.bubble("\u4E66\u5355\u6709 " + books.length + " \u672C\uFF0C\u53F3\u952E\u70B9\u300C\u9009\u672C\u4E66\u300D\u6311\u4E00\u672C\uFF5E", 5e3);
      }).catch(() => host.bubble("\u4E66\u5355\u6CA1\u53D6\u5230\uFF0C\u7A0D\u540E\u518D\u8BD5", 4e3));
    });
    table.definePrefix("story-book:", (host, name) => {
      const book = String(name || "").trim();
      if (!book) {
        host.bubble("\u4E66\u540D\u6CA1\u8BFB\u5230", 3e3);
        return;
      }
      if (host.storyState && host.storyState.busy.current) {
        host.bubble("\u6B63\u8BB2\u7740\u5462\uFF0C\u542C\u5B8C\u8FD9\u6BB5\u518D\u8BF4\uFF5E", 3e3);
        return;
      }
      host.bubble("\u5F00\u59CB\u8BB2\u300A" + book + "\u300B", 3e3);
      host.story.start(book);
    });
    table.define("daily-line", (host) => {
      getJson("/daily", { cache: "no-store" }).then((d) => {
        const line = pickDaily(d);
        if (!line) {
          host.bubble("\u4ECA\u5929\u90A3\u53E5\u8FD8\u6CA1\u51C6\u5907\u597D", 3500);
          return;
        }
        const shown = line.source ? line.text + "\n\u2014\u2014" + line.source : line.text;
        showAndSpeak(host, shown, shown, 9e3);
      }).catch(() => host.bubble("\u4ECA\u5929\u90A3\u53E5\u8FD8\u6CA1\u51C6\u5907\u597D", 3500));
    });
    table.define("briefing-card", (host) => {
      getJson("/briefing", { cache: "no-store" }).then((d) => {
        const card = parseBriefing(d);
        if (!card) {
          host.bubble("\u7B80\u62A5\u4ECA\u5929\u6CA1\u53D6\u5230", 3500);
          return;
        }
        const shown = card.first && card.second ? card.first + "\n\n" + card.second : card.first || card.second;
        const speech = [card.first, card.second].filter(Boolean).join("\u3002");
        showAndSpeak(host, shown, speech, 12e3);
      }).catch(() => host.bubble("\u7B80\u62A5\u4ECA\u5929\u6CA1\u53D6\u5230", 3500));
    });
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

  // src/client/actions/data.ts
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
    return "\u5BFC\u5165\u4E86 " + imported + " \u4E2A\u5B57\u6BB5\uFF0C\u8DF3\u8FC7 " + skipped + " \u4E2A\u5B57\u6BB5";
  }
  function numOf(...vals) {
    for (const v of vals) {
      if (v == null || v === "") continue;
      const n = Number(v);
      if (Number.isFinite(n)) return n;
    }
    return 0;
  }
  function shortText(v, max = 16) {
    const t = String(v == null ? "" : v).replace(/\s+/g, " ").trim();
    if (!t) return "";
    return t.length > max ? t.slice(0, max) + "\u2026" : t;
  }
  function asList(v) {
    if (v == null) return [];
    if (Array.isArray(v)) return v;
    if (typeof v === "object") {
      try {
        return Object.keys(v).map((k) => v[k]);
      } catch (e) {
        return [];
      }
    }
    return [v];
  }
  function formatStats(payload) {
    const d = payload && typeof payload === "object" ? payload : {};
    const s = d.stats && typeof d.stats === "object" ? d.stats : d;
    const cacheObj = s.cache && typeof s.cache === "object" ? s.cache : s.byType && typeof s.byType === "object" ? s.byType : {};
    const tts = numOf(cacheObj.tts, s.tts, s.cacheTts);
    const chat = numOf(cacheObj.chat, s.chat, s.cacheChat);
    const asr = numOf(cacheObj.asr, s.asr, s.cacheAsr);
    const ff = s.fishfood && typeof s.fishfood === "object" ? s.fishfood : s.fishFood && typeof s.fishFood === "object" ? s.fishFood : {};
    const tokens = numOf(ff.total, ff.totalTokens, s.totalTokens, s.tokens && typeof s.tokens === "object" ? s.tokens.total : s.tokens, s.fishfoodTotal);
    const g = s.growth && typeof s.growth === "object" ? s.growth : {};
    const stage = shortText(g.stage || s.stage || "--", 12) || "--";
    const intimacy = numOf(s.intimacy, s.state && s.state.intimacy);
    const p = s.personality && typeof s.personality === "object" ? s.personality : {};
    const pts = [];
    const addPoint = (v) => {
      const t = shortText(v, 16);
      if (t && pts.indexOf(t) < 0 && pts.length < 3) pts.push(t);
    };
    for (const v of asList(p.points)) addPoint(v);
    for (const v of asList(p.catchphrases)) addPoint(v);
    for (const v of asList(p.preferences)) addPoint(v);
    for (const v of asList(p.notes)) addPoint(v);
    addPoint(p.selfNarrative);
    addPoint(s.selfNarrative);
    const points = pts.length ? pts.join("\uFF1B") : "\u6682\u65E0";
    return "\u7EDF\u8BA1\u5361\n\u7F13\u5B58\uFF1Atts " + tts + " \u6761\uFF5Cchat " + chat + " \u6761\uFF5Casr " + asr + " \u6761\n\u9C7C\u7CAE\uFF1A" + tokens + " tokens\n\u6210\u957F\uFF1A" + stage + "\uFF5C\u4EB2\u5BC6\u5EA6 " + intimacy + "/100\n\u4EBA\u683C\u8981\u70B9\uFF1A" + points;
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
  function exportBackup(host) {
    const fetchJson = host.getJson || getJson;
    let p;
    try {
      p = Promise.resolve(fetchJson("/data/export"));
    } catch (e) {
      host.bubble("\u5BFC\u51FA\u6CA1\u6210\u529F", 5e3);
      return;
    }
    p.then((d) => {
      if (d == null || d.ok === false) {
        host.bubble("\u5BFC\u51FA\u6CA1\u6210\u529F", 5e3);
        return;
      }
      const name = backupFileName(host.now ? host.now() : /* @__PURE__ */ new Date());
      const ok = downloadJson(d, name, host.env);
      host.bubble(ok ? "\u5907\u4EFD\u5DF2\u4E0B\u8F7D\uFF1A" + name : "\u8FD9\u4E2A\u6D4F\u89C8\u5668\u4E0D\u8BA9\u4E0B\u8F7D\u5907\u4EFD", 6e3);
    }).catch(() => host.bubble("\u5BFC\u51FA\u6CA1\u6210\u529F", 5e3));
  }
  function readFileText(file) {
    return new Promise((resolve, reject) => {
      try {
        if (!file) {
          reject(new Error("no file"));
          return;
        }
        if (typeof file.text === "function") {
          file.text().then((t) => resolve(String(t == null ? "" : t)), reject);
          return;
        }
        const FR = typeof FileReader !== "undefined" ? FileReader : null;
        if (!FR) {
          reject(new Error("FileReader missing"));
          return;
        }
        const fr = new FR();
        fr.onload = () => resolve(String(fr.result == null ? "" : fr.result));
        fr.onerror = () => reject(new Error("read failed"));
        fr.readAsText(file);
      } catch (e) {
        reject(e);
      }
    });
  }
  function parseImportText(text) {
    const raw = String(text == null ? "" : text).trim();
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
  function importBackup(host) {
    const pick = typeof host.pickFile === "function" ? host.pickFile : pickJsonFile;
    const sendJson = host.postJson || postJson;
    try {
      pick((file) => {
        if (!file) {
          host.bubble("\u6CA1\u9009\u5907\u4EFD\u6587\u4EF6", 3e3);
          return;
        }
        readFileText(file).then((text) => {
          const body = parseImportText(text);
          if (!body) {
            host.bubble("\u5907\u4EFD\u6587\u4EF6\u8BFB\u4E0D\u4E86", 6e3);
            return;
          }
          let p;
          try {
            p = Promise.resolve(sendJson("/data/import", body));
          } catch (e) {
            host.bubble("\u5907\u4EFD\u6587\u4EF6\u8BFB\u4E0D\u4E86", 6e3);
            return;
          }
          p.then((d) => {
            if (d && d.ok === false) {
              host.bubble("\u5907\u4EFD\u6587\u4EF6\u8BFB\u4E0D\u4E86", 6e3);
              return;
            }
            host.bubble(formatImportResult(d || {}), 7e3);
          }).catch(() => host.bubble("\u5907\u4EFD\u6587\u4EF6\u8BFB\u4E0D\u4E86", 6e3));
        }).catch(() => host.bubble("\u5907\u4EFD\u6587\u4EF6\u8BFB\u4E0D\u4E86", 6e3));
      });
    } catch (e) {
      host.bubble("\u5907\u4EFD\u6587\u4EF6\u8BFB\u4E0D\u4E86", 6e3);
    }
  }

  // src/client/actions/system.ts
  function registerSystemActions(table) {
    table.define("feed", (host) => {
      const r = host.persona.feed();
      if (r.bowls % 8 === 0) {
        host.say(host.persona.line("riceAccount"), 5e3);
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
        return;
      }
      host.say(r.text + (r.stageUp ? "\uFF08" + r.stage + "\uFF09" : ""), r.stageUp ? 6e3 : 3500);
      host.heart();
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
    });
    table.define("home", (host) => {
      host.homePos();
      host.bubble("\u56DE\u5230\u89D2\u843D\u5566");
    });
    table.define("stream-toggle", (host) => {
      try {
        const off = localStorage.getItem("chubby-stream") === "off";
        localStorage.setItem("chubby-stream", off ? "on" : "off");
        host.bubble(off ? "\u6D41\u5F0F\u56DE\u590D\uFF1A\u5F00\uFF08\u8FB9\u751F\u6210\u8FB9\u8BF4\uFF09" : "\u6D41\u5F0F\u56DE\u590D\uFF1A\u5173\uFF08\u7B49\u6574\u6BB5\u518D\u5F00\u53E3\uFF09", 4e3);
      } catch (e) {
        host.bubble("\u6539\u4E0D\u4E86\uFF08\u6D4F\u89C8\u5668\u7981\u6B62\u5B58\u50A8\uFF09", 3e3);
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
      host.bubble("\u672C\u9CB8\u5148\u6E38\u8D70\u4E86\uFF0C\u53F3\u4E0B\u89D2\u7684\u300C\u25CB\u300D\u6216 Ctrl+Shift+W \u80FD\u53EB\u56DE\u6765", 6e3);
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
      host.bubble(wasHidden ? "\u672C\u9CB8\u56DE\u6765\u5566" : "\u672C\u9CB8\u4E00\u76F4\u5728\u5440", 3e3);
    });
    table.define("version", (host) => {
      host.bubble("\u80A5\u9CB8 v" + host.version);
    });
    table.define("type", (host) => {
      host.setVoiceMode(false);
      host.setChatOpen(true);
    });
    table.define("pause", (host) => {
      host.stopSpeak();
      host.stopMelody();
      host.storyState.busy.current = false;
      host.bubble("\u6B47\u4F1A\u513F\u2026");
    });
    table.define("music-stop", (host) => {
      host.stopMelody();
      host.bubble("\u505C\u4E0B\u5566");
    });
    table.define("tts-stop", (host) => {
      host.stopSpeak();
      host.storyState.busy.current = false;
      host.bubble("\u597D\uFF0C\u4E0D\u8BF4\u4E86");
    });
    table.define("fishfood", (host) => {
      getJson("/fishfood").then((d) => {
        if (d && d.ok) {
          host.bubble("\u9C7C\u7CAE\u8D26\u672C\uFF1A\u804A\u5929 " + d.chatTokens + " tokens\uFF0C\u8BF4\u4E66 " + d.storyTokens + " tokens\uFF0C\u5171 " + d.total, 5e3);
        } else host.bubble("\u9C7C\u7CAE\u67E5\u4E0D\u5230");
      }).catch(() => host.bubble("\u9C7C\u7CAE\u67E5\u4E0D\u5230"));
    });
    table.define("growth", (host) => {
      Promise.all([getJson("/growth"), getJson("/state")]).then(([g, s]) => {
        if (g && g.ok) {
          const nx = g.nextExp > 0 ? "\uFF08\u7ECF\u9A8C " + g.exp + "/" + g.nextExp + "\uFF09" : "\uFF08\u6EE1\u7EA7\uFF09";
          const it = s && s.intimacy || 0;
          try {
            host.applyGrowth(g);
          } catch (e) {
          }
          host.bubble("\u6210\u957F\uFF1A" + g.stage + nx + " \xB7 \u4EB2\u5BC6\u5EA6 " + it + "/100", 5e3);
        } else host.bubble("\u6210\u957F\u67E5\u4E0D\u5230");
      }).catch(() => host.bubble("\u6210\u957F\u67E5\u4E0D\u5230"));
    });
    table.define("intimacy", (host) => {
      getJson("/state").then((d) => {
        host.bubble("\u4EB2\u5BC6\u5EA6\uFF1A" + (d && d.intimacy || 0) + " / 100");
      }).catch(() => host.bubble("\u4EB2\u5BC6\u5EA6\u67E5\u4E0D\u5230"));
    });
    table.define("balance", (host) => {
      getJson("/balance").then((d) => {
        if (d && d.ok && d.balance != null) {
          host.setBalance("\u4F59\u989D \xA5" + d.balance, "\xA5" + d.balance);
          host.bubble("\u4F59\u989D\u8FD8\u6709 " + d.balance + " \u5143", 5e3);
        } else host.bubble("\u4F59\u989D\u67E5\u4E0D\u5230");
      }).catch(() => host.bubble("\u4F59\u989D\u67E5\u4E0D\u5230"));
    });
    table.definePrefix("chat-lang:", (host, v) => {
      const cl = v === "en" ? "en" : v === "zh" ? "zh" : "auto";
      try {
        localStorage.setItem("chubby-chatlang", cl);
      } catch (e) {
      }
      host.bubble(cl === "en" ? "\u804A\u5929\u8BED\u8A00\uFF1AEnglish" : "\u804A\u5929\u8BED\u8A00\uFF1A\u4E2D\u6587");
    });
    table.definePrefix("lang:", (host, v) => {
      const l = v === "en" ? "en" : "zh";
      try {
        localStorage.setItem("chubby-lang", l);
      } catch (e) {
      }
      host.setLang(l);
      host.bubble(l === "en" ? "Language: English" : "\u754C\u9762\u8BED\u8A00\uFF1A\u4E2D\u6587");
    });
    table.define("cache-clear", (host) => {
      delJson("/cache").then((d) => host.bubble(d && d.ok ? "\u804A\u5929\u7F13\u5B58\u6E05\u7A7A\u5566\uFF08" + (d.cleared || 0) + " \u6761\uFF09" : "\u7F13\u5B58\u6E05\u7A7A\u5931\u8D25", 5e3)).catch(() => host.bubble("\u7F13\u5B58\u6E05\u7A7A\u5931\u8D25", 4e3));
    });
    table.define("cache-toggle", (host) => {
      const nowOn = !host.chatCacheOn();
      host.setChatCacheOn(nowOn);
      postJson("/cache-toggle", { enabled: nowOn }).then((d) => {
        host.bubble(d && d.ok ? "\u804A\u5929\u7F13\u5B58\uFF1A" + (d.enabled ? "\u5F00\uFF08\u7701 token\uFF09" : "\u5173\uFF08\u6BCF\u6B21\u91CD\u65B0\u56DE\u7B54\uFF09") : "\u5207\u6362\u5931\u8D25", 5e3);
      }).catch(() => host.bubble("\u5207\u6362\u5931\u8D25", 4e3));
    });
    table.define("clear-memory", (host) => {
      try {
        if (!window.confirm("\u6E05\u9664\u80A5\u9CB8\u5BF9\u4E3B\u4EBA\u7684\u804A\u5929\u8BB0\u5FC6\uFF1F\uFF08\u6210\u957F/\u9C7C\u7CAE/\u8BF4\u4E66\u8BB0\u5F55\u4E0D\u53D7\u5F71\u54CD\uFF09")) return;
        postJson("/clear-memory").then((d) => {
          if (d && d.ok) {
            host.setMessages([]);
            host.bubble("\u8BB0\u5FC6\u6E05\u7A7A\u5566\uFF0C\u6211\u4EEC\u91CD\u65B0\u8BA4\u8BC6\u5427\uFF5E", 4e3);
          } else host.bubble("\u6E05\u9664\u5931\u8D25");
        }).catch(() => host.bubble("\u6E05\u9664\u5931\u8D25"));
      } catch (e) {
      }
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
              host.bubble("\u56FE\u7247\u592A\u5927\uFF08\u8D85\u8FC7 4MB\uFF09", 4e3);
              return;
            }
            const img0 = await imageToB64(file);
            const b64 = img0 ? img0.b64 : "";
            if (!b64) {
              host.bubble("\u56FE\u7247\u8BFB\u4E0D\u51FA\u6765", 4e3);
              return;
            }
            host.bubble("\u672C\u9CB8\u770B\u770B\u8FD9\u5F20\u56FE\u2026", 3e3);
            host.setChatOpen(false);
            const hdr = img0 && img0.mime || file.type || "image/jpeg";
            const d = await postJson("/chat", { message: VISION_PROMPT, image: b64, imageMime: hdr });
            const reply = d && d.reply || "\u8FD9\u6761\u9C7C\u770B\u4E0D\u61C2\u8FD9\u5F20\u56FE\u2026\u2026";
            host.bubble("\uFF08\u770B\u56FE\uFF09" + reply, 1e4);
            host.speakReply(reply);
          } catch (e) {
            host.bubble("\u56FE\u7247\u5904\u7406\u5931\u8D25", 4e3);
          }
        };
        input.click();
      } catch (e) {
        host.bubble("\u6253\u4E0D\u5F00\u6587\u4EF6\u9009\u62E9", 4e3);
      }
    });
    table.define("test-tts", (host) => {
      host.bubble("\u6D4B\u8BD5\u8BED\u97F3\uFF1A\u4E3B\u4EBA\u542C\u5F97\u5230\u5417\uFF1F", 4e3);
      host.speak("\u6D4B\u8BD5\u8BED\u97F3\uFF0C\u4E3B\u4EBA\u542C\u5F97\u5230\u5417\uFF1F");
    });
    table.define("remind-add", (host) => {
      const msg = window.prompt("\u63D0\u9192\u4EC0\u4E48\uFF1F\uFF08\u53EF\u4EE5\u4E00\u8D77\u8BF4\u65F6\u95F4\uFF0C\u5982\u300C\u660E\u59299\u70B9\u63D0\u9192\u6211\u5F00\u4F1A\u300D\uFF09");
      if (!msg) return;
      let parsed = parseDue(msg);
      if (!parsed) {
        const ans = window.prompt("\u4EC0\u4E48\u65F6\u5019\u63D0\u9192\uFF1F\uFF08\u5982 9\u70B9 / \u660E\u59299\u70B9 / \u534A\u5C0F\u65F6\u540E / 20\u5206\u949F\u540E / \u6BCF\u59299\u70B9\uFF09", "5\u5206\u949F\u540E");
        if (!ans) return;
        parsed = parseDue(ans);
        if (!parsed) {
          host.bubble("\u8FD9\u4E2A\u65F6\u95F4\u672C\u9C7C\u6CA1\u542C\u61C2\u2026\u2026\u8BD5\u8BD5\u300C9\u70B9\u300D\u300C\u660E\u59299\u70B9\u300D\u300C\u534A\u5C0F\u65F6\u540E\u300D", 5e3);
          return;
        }
      }
      const text = String(parsed.cleaned || cleanReminderText(msg) || msg).slice(0, 200);
      const dueAt = parsed.at;
      const repeat = parsed.repeat || 0;
      postJson("/reminders", { text, at: dueAt.toISOString(), repeat }).then((d) => {
        if (d && d.ok) {
          const hh = String(dueAt.getHours()).padStart(2, "0");
          const mm = String(dueAt.getMinutes()).padStart(2, "0");
          const whenText = repeat > 0 ? "\u6BCF\u5929 " + hh + ":" + mm : dueAt.getMonth() + 1 + "\u6708" + dueAt.getDate() + "\u65E5 " + hh + ":" + mm;
          host.bubble("\u597D\uFF0C" + whenText + " \u63D0\u9192\u4F60\uFF1A" + text, 6e3);
        } else host.bubble("\u63D0\u9192\u6CA1\u52A0\u4E0A");
      }).catch(() => host.bubble("\u63D0\u9192\u6CA1\u52A0\u4E0A"));
    });
    table.define("remind-manage", (host) => {
      try {
        host.openReminders();
      } catch (e) {
        host.bubble("\u63D0\u9192\u6E05\u5355\u67E5\u4E0D\u5230", 4e3);
      }
    });
    table.define("remind-list", (host) => {
      try {
        host.openReminders();
      } catch (e) {
        host.bubble("\u63D0\u9192\u6E05\u5355\u67E5\u4E0D\u5230", 4e3);
      }
    });
    table.define("data-export", (host) => {
      exportBackup({ bubble: (text, ms2) => host.bubble(text, ms2) });
    });
    table.define("data-import", (host) => {
      importBackup({ bubble: (text, ms2) => host.bubble(text, ms2) });
    });
    table.define("stats", (host) => {
      getJson("/stats", { cache: "no-store" }).then((d) => {
        if (!d || d.ok === false) {
          host.bubble("\u7EDF\u8BA1\u8FD8\u6CA1\u51C6\u5907\u597D", 5e3);
          return;
        }
        host.bubble(formatStats(d), 12e3);
      }).catch(() => host.bubble("\u7EDF\u8BA1\u8FD8\u6CA1\u51C6\u5907\u597D", 5e3));
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
      host.bubble(nowOn ? "\u8BED\u97F3\u804A\u5929\uFF1A\u5F00\uFF0C\u672C\u9CB8\u4F1A\u63A5\u8BDD" : "\u8BED\u97F3\u804A\u5929\uFF1A\u5173\uFF0C\u53EA\u542C\u4E0D\u63A5\u8BDD");
    });
    table.define("voice", (host) => {
      const nowOn = !host.voiceOn();
      host.setVoiceOn(nowOn);
      try {
        localStorage.setItem("chubby-voice", nowOn ? "on" : "off");
      } catch (e) {
      }
      if (!nowOn) host.stopSpeak();
      host.bubble(nowOn ? "\u8BED\u97F3\u6717\u8BFB\uFF1A\u5F00" : "\u8BED\u97F3\u6717\u8BFB\uFF1A\u5173\uFF08\u7701\u7740\u70B9\u7528\uFF09");
    });
    table.define("endpoint", (host) => {
      try {
        const v = host.voice();
        const cur = v && v.endpointInfo ? v.endpointInfo().mode : (() => {
          try {
            return localStorage.getItem("chubby-endpoint") === "ape" ? "ape" : "classic";
          } catch (e) {
            return "classic";
          }
        })();
        const next = cur === "ape" ? "classic" : "ape";
        localStorage.setItem("chubby-endpoint", next);
        if (v && v.setEndpointMode) v.setEndpointMode(next);
        const real = v && v.endpointInfo ? v.endpointInfo().mode : next;
        host.bubble(real === "ape" ? "\u7AEF\u70B9\u68C0\u6D4B\uFF1A\u81EA\u9002\u5E94\uFF08\u8BD5\u7528\uFF09" : "\u7AEF\u70B9\u68C0\u6D4B\uFF1A\u7ECF\u5178\uFF08\u7A33\u5B9A\uFF09", 4e3);
      } catch (e) {
        host.bubble("\u5207\u6362\u5931\u8D25", 3e3);
      }
    });
    table.define("ear-check", (host) => {
      try {
        const v = host.voice();
        const st = v ? v.stats : null;
        if (!st) {
          host.bubble("\u8BED\u97F3\u6A21\u5757\u8FD8\u6CA1\u8D77\u6765\uFF08\u8BED\u97F3\u5F85\u547D\u53EF\u80FD\u662F\u5173\u7684\uFF09", 6e3);
          return;
        }
        const line = "\u8BED\u97F3\u81EA\u68C0\uFF08\u65B0\u6A21\u5757\uFF09\uFF1A" + String(v.status()) + "\n\u5F55\u97F3\u6BB5 " + st.windows + "\uFF5C\u4E0A\u4F20 " + st.uploaded + "\uFF5C\u8BC6\u522B\u51FA\u5B57 " + st.asrTexts + "\uFF5C\u4EA4\u7ED9\u5BF9\u8BDD " + st.heard + "\n\u4E22\uFF1A\u592A\u5B89\u9759 " + st.skippedSilent + "\uFF5C\u56DE\u58F0/\u91CD\u590D " + st.echoDropped + "\uFF5C\u8BC6\u522B\u5931\u8D25 " + st.asrFail + "\n\u53BB\u91CD\uFF1A\u91CD\u590D\u4E22\u5F03 " + (st.dupDropped || 0) + " \u6B21\uFF08\u540C\u4E00\u53E5\u8BDD\u88AB\u5207\u6210\u4E24\u6BB5\u65F6\u7528\uFF09\n\u7AEF\u70B9\u68C0\u6D4B\uFF1A" + (v.endpointInfo ? v.endpointInfo().mode === "ape" ? "\u81EA\u9002\u5E94" : "\u7ECF\u5178" : "?") + (function() {
          try {
            const t = v.lastTtsInfo ? v.lastTtsInfo() : null;
            if (!t) return "";
            return "\n\u6717\u8BFB\uFF1A\u6700\u540E\u4E00\u6BB5 " + (t.failed ? "\u5931\u8D25" : "\u5DF2\u5F00\u64AD") + "\uFF5C\u6587\u672C\u5F00\u5934\u300C" + t.text + "\u300D";
          } catch (e) {
            return "";
          }
        })() + (function() {
          try {
            const s = v.lastSegment ? v.lastSegment() : null;
            if (!s) return "";
            return "\n\u4E0A\u4E00\u6BB5\uFF1A" + s.mode + "\uFF5C\u7A97\u53E3 " + s.winMs + "ms\uFF5C\u8BF4\u8BDD " + s.peMs + "ms\uFF5C\u9759\u97F3 " + s.quMs + "ms" + (s.floor !== null ? "\uFF5C\u5E95\u566A " + s.floor + "dB" : "") + (s.target ? "\uFF5C\u76EE\u6807 " + s.target + "ms" : "") + "\n\u8BC6\u522B\u7ED3\u679C\uFF1A" + s.text;
          } catch (e) {
            return "";
          }
        })() + "\n\u6717\u8BFB\uFF1A\u8BF7\u6C42 " + st.ttsRequests + "\uFF5C\u5F00\u64AD " + st.ttsPlayed + "\uFF5C\u5931\u8D25 " + st.ttsFail + "\uFF5C\u50F5\u5C38\u590D\u4F4D " + st.ttsZombie + "\n\u97F3\u8272\uFF1A" + (v.voiceName ? v.voiceName() : "?") + (function() {
          try {
            const w = host.wakeInfo ? host.wakeInfo() : null;
            if (!w) return "";
            const head = w.awake ? "\u9192\u7740\uFF08\u8FD8\u5269 " + Math.round((Number(w.remainingMs) || 0) / 1e3) + " \u79D2\uFF09" : "\u5F85\u5524\u9192\uFF08\u5148\u558A\u300C" + (w.words && w.words[0] || "\u5927\u80A5\u9C7C") + "\u300D\uFF09";
            return "\n\u5524\u9192\u8BCD\uFF1A" + head + "\uFF5C\u5524\u9192 " + w.hits + " \u6B21\uFF5C\u653E\u884C " + w.passed + "\uFF5C\u6321\u4E0B " + w.dropped;
          } catch (e) {
            return "";
          }
        })() + (st.lastError ? "\n\u6700\u8FD1\u9519\u8BEF\uFF1A" + st.lastError : "");
        host.bubble(line, 15e3);
        try {
          navigator.clipboard.writeText(JSON.stringify(st));
        } catch (e) {
        }
      } catch (e) {
        host.bubble("\u81EA\u68C0\u5931\u8D25\uFF1A" + String(e && e.message), 5e3);
      }
    });
    table.definePrefix("voice:", (host, v) => {
      const name = normalizeVoiceName(v);
      host.setTtsVoice(name);
      const shown = name === "auto" ? "\u81EA\u52A8" : name.split("-")[2] || name;
      host.bubble("\u97F3\u8272\u6362\u597D\u5566\uFF1A" + shown);
      try {
        host.previewVoice("\u4E3B\u4EBA\uFF0C\u8FD9\u4E2A\u58F0\u97F3\u597D\u542C\u5417\uFF1F");
      } catch (e) {
      }
    });
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

  // src/client/bubble.ts
  var BUBBLE_CSS = '.chubby-bubble{position:fixed;z-index:10002;max-width:320px;white-space:pre-wrap;opacity:0;background:#fff;color:#17325a;border-radius:14px;padding:10px 14px;font:13px/1.6 "Microsoft YaHei",sans-serif;box-shadow:0 8px 20px rgba(0,0,0,0.35);transition:opacity .2s;pointer-events:none;}.chubby-bubble::after{content:"";position:absolute;left:50%;margin-left:-9px;bottom:-9px;border-left:9px solid transparent;border-right:9px solid transparent;border-top:10px solid #fff;}.chubby-bubble.show{opacity:1;}';
  var STATUS_TEXTS = ["\u5728\u542C\u2026", "\u5728\u60F3\u2026", "\u8BC6\u522B\u4E2D\u2026", "\u5728\u8BF4\u2026"];
  deepFreeze(STATUS_TEXTS);
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
        if (te) te.textContent = text;
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
  function createBusyLock(opts) {
    const staleMs = Math.max(1e3, Number(opts && opts.staleMs) || BUSY_STALE_MS);
    let busy = false;
    let beganAt = 0;
    return {
      begin(now) {
        busy = true;
        beganAt = typeof now === "number" ? now : Date.now();
      },
      end() {
        busy = false;
      },
      isBusy() {
        return busy;
      },
      age(now) {
        if (!busy) return 0;
        const t = typeof now === "number" ? now : Date.now();
        return Math.max(0, t - beganAt);
      },
      watchdog(now) {
        const t = typeof now === "number" ? now : Date.now();
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
      isCurrent(e) {
        return e === cur;
      }
    };
  }

  // src/client/stage.ts
  function clampPos(x, y, w, h, viewW, viewH) {
    return {
      x: Math.max(0, Math.min(viewW - w, x)),
      y: Math.max(0, Math.min(viewH - h, y))
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
    return Math.max(-INERTIA_MAX, Math.min(INERTIA_MAX, v));
  }
  function decayVelocity(vx, vy) {
    const nx = vx * INERTIA_DECAY;
    const ny = vy * INERTIA_DECAY;
    return { vx: nx, vy: ny, done: Math.abs(nx) < INERTIA_STOP && Math.abs(ny) < INERTIA_STOP };
  }

  // src/shared/tts.ts
  function isValidRate(s) {
    return typeof s === "string" && /^[+-]\d{1,2}%$/.test(s.trim());
  }
  function normalizeRate(s, defaultRate = "+0%") {
    return isValidRate(s) ? String(s).trim() : defaultRate;
  }

  // src/client/story.ts
  var STORY_RATE = "-35%";
  function storyRate() {
    try {
      const s = localStorage.getItem("chubby-story-rate");
      if (s && /^-\d{1,2}%$/.test(s)) return s;
    } catch (e) {
    }
    return STORY_RATE;
  }
  function createStoryController(host) {
    const refs = host.refs;
    const titleOf = (d) => {
      const total = Number(d && d.total) || 1;
      const piece = Number(d && d.piece) || 1;
      const seg = total > 1 ? "\uFF08\u7B2C " + piece + "/" + total + " \u6BB5\uFF09" : "";
      return "\u6B63\u5728\u8BB2\u300A" + String(d && d.book || "") + "\u300B" + (d && d.title ? "\uFF5C" + d.title : "") + seg;
    };
    function playPiece(d) {
      const text = String(d && d.text || "");
      if (d && d.book) refs.book.current = String(d.book);
      host.bubble(titleOf(d), 12e3);
      host.talkFor(8e3);
      if (host.isVoiceOff()) {
        refs.busy.current = false;
        refs.narrating.current = false;
        host.bubble(titleOf(d) + "\uFF08\u8BED\u97F3\u6717\u8BFB\u5173\u7740\uFF09", 12e3);
        return;
      }
      refs.busy.current = true;
      host.narrate(estimateSpeakMs(text));
      host.speak(text, {
        // 故事语速由前端常量决定（-35%：主人反馈 -30% 仍略快）。
        // 这样调语速只改这一处、只刷新页面即可生效，不必重启宿主。
        rate: normalizeRate(storyRate(), host.narrationRate()),
        onDone: () => {
          refs.busy.current = false;
          refs.narrating.current = false;
          if (d && d.isLast === false) {
            if (refs.auto.current) {
              host.bubble("\u8FD9\u4E00\u6BB5\u8BB2\u5B8C\u5566\uFF0C\u63A5\u7740\u5F80\u540E\u8BB2\u2026", 4e3);
              setTimeout(() => {
                try {
                  next();
                } catch (e) {
                }
              }, 800);
            } else {
              host.bubble("\u8FD9\u6BB5\u8BB2\u5B8C\u5566\uFF5E\u70B9\u83DC\u5355\u300C\u63A5\u7740\u8BF4\u300D\u542C\u4E0B\u4E00\u6BB5", 6e3);
            }
          } else {
            refs.auto.current = false;
            host.bubble(host.persona.line("poemDone"), 6e3);
          }
        }
      });
    }
    function start(hint) {
      if (refs.busy.current) {
        host.bubble("\u6B63\u8BB2\u7740\u5462\uFF0C\u542C\u5B8C\u8FD9\u6BB5\u518D\u8BF4\uFF5E", 3e3);
        return;
      }
      const headers = clientHeaders(host.clientId);
      const query = hint ? "?book=" + encodeURIComponent(hint) + "&hint=" + encodeURIComponent(hint) : "";
      getJson("/story/start" + query, { headers }).then((d) => {
        if (!d || !d.ok) {
          host.bubble("\u8BF4\u4E66\u6CA1\u5F00\u6210\uFF1A" + (d && d.error || "\u6CA1\u8BFB\u5230\u4E66"), 5e3);
          return;
        }
        playPiece(d);
      }).catch(() => host.bubble("\u8BF4\u4E66\u8FDE\u4E0D\u4E0A"));
    }
    function next() {
      if (refs.busy.current) {
        host.bubble("\u6B63\u8BB2\u7740\u5462\uFF0C\u542C\u5B8C\u8FD9\u6BB5\u518D\u8BF4\uFF5E", 3e3);
        return;
      }
      const headers = clientHeaders(host.clientId);
      getJson("/story/next", { headers }).then((d) => {
        if (!d || !d.ok) {
          host.bubble("\u8BF4\u4E66\u5361\u4F4F\u4E86", 4e3);
          return;
        }
        if (d.done) {
          host.bubble("\u4E00\u8F6E\u90FD\u8BB2\u5B8C\u5566\uFF0C\u672C\u9C7C\u4ECE\u5934\u518D\u8BB2\uFF5E", 5e3);
          start("");
          return;
        }
        playPiece(d);
      }).catch(() => host.bubble("\u8BF4\u4E66\u8FDE\u4E0D\u4E0A"));
    }
    function reset() {
      const book = refs.book.current;
      if (!book) {
        host.bubble("\u8FD8\u6CA1\u8BB2\u4E66\u5462", 3e3);
        return;
      }
      const headers = clientHeaders(host.clientId);
      postJson("/story/reset?book=" + encodeURIComponent(book), void 0, { headers }).then((d) => {
        if (!d || !d.ok) {
          host.bubble("\u6CA1\u91CD\u7F6E\u6210\uFF1A" + (d && d.error || "\u63A5\u53E3\u6CA1\u5E94"), 4e3);
          return;
        }
        refs.book.current = String(d.book || book);
        host.bubble("\u8FD9\u672C\u4E66\u4ECE\u5934\u8BB2\uFF5E", 3e3);
      }).catch(() => host.bubble("\u8BF4\u4E66\u8FDE\u4E0D\u4E0A"));
    }
    return { playPiece, start, next, reset };
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
  deepFreeze(BOOK_ALIAS);
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

  // src/client/chat-route.ts
  function createLocalRouter(host) {
    function fetchPoem(query, onItem) {
      getJson("/poem" + query).then((d) => {
        const p = d && d.ok && d.item ? d.item : null;
        if (!p) {
          host.bubble("\u8BD7\u518C\u6CA1\u8BFB\u5230", 4e3);
          return;
        }
        onItem(p);
      }).catch(() => host.bubble("\u8BD7\u518C\u6CA1\u8BFB\u5230", 4e3));
    }
    function route(rawText) {
      const t0 = String(rawText || "").trim();
      if (/^(再来|再念|换)(一)?(首|个)/.test(t0)) {
        host.bubble("\uFF08\u70B9\u64AD\uFF09\u597D\uFF0C\u518D\u5FF5\u4E00\u9996", 3e3);
        fetchPoem("", (p) => recitePoem(host, p));
        return true;
      }
      if (/^(继续|接着说|接着讲|往下讲)$/.test(t0)) {
        host.bubble("\uFF08\u70B9\u64AD\uFF09\u63A5\u7740\u8BF4", 3e3);
        host.story.start(host.storyState.book.current || "");
        return true;
      }
      const hit = detectIntent(rawText);
      if (!hit) return false;
      if (hit.kind === "poem") {
        host.bubble("\uFF08\u70B9\u64AD\uFF09\u597D\uFF0C\u5FF5\u4E00\u9996", 3e3);
        fetchPoem(hit.title || "" ? "?title=" + encodeURIComponent(hit.title || "") : "", (p) => recitePoem(host, p));
        return true;
      }
      if (hit.kind === "culture") {
        const type = hit.sub;
        host.bubble(type === "chengyu" ? "\uFF08\u70B9\u64AD\uFF09\u8BB2\u4E2A\u6210\u8BED" : "\uFF08\u70B9\u64AD\uFF09\u8BB2\u4E2A\u5178\u6545", 3e3);
        getJson("/culture?type=" + type).then((d) => {
          const it = d && d.ok && d.item ? d.item : null;
          if (!it) {
            host.bubble("\u8FD9\u4E2A\u6CA1\u8BFB\u5230", 4e3);
            return;
          }
          const body = collapseText(String(it.text || ""));
          host.bubble((type === "chengyu" ? "\u6210\u8BED\xB7" : "\u5178\u6545\xB7") + String(it.title || ""), 15e3);
          host.speak((type === "chengyu" ? "\u8BB2\u4E2A\u6210\u8BED\u2014\u2014" : "\u8BB2\u4E2A\u5178\u6545\u2014\u2014") + String(it.title || "") + (it.src ? "\uFF0C\u51FA\u81EA" + String(it.src) : "") + "\u3002" + body, { rate: host.narrationRate() });
        }).catch(() => host.bubble("\u8FD9\u4E2A\u6CA1\u8BFB\u5230", 4e3));
        return true;
      }
      const book = hit.book || "";
      host.bubble("\uFF08\u70B9\u64AD\uFF09" + (book ? "\u8BB2\u300A" + book + "\u300B" : "\u8BB2\u4E00\u6BB5\u4E66"), 4e3);
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
  function diag() {
    try {
      const w = typeof window !== "undefined" ? window : null;
      if (!w) return null;
      return w.__chubbyWhale || (w.__chubbyWhale = {});
    } catch (e) {
      return null;
    }
  }
  function createChatSender(host) {
    let activeStream = null;
    function clearActive(ctl) {
      if (activeStream && activeStream.ctl === ctl) activeStream = null;
    }
    function abortStream() {
      const s = activeStream;
      if (!s) return false;
      activeStream = null;
      try {
        host.epoch.next();
      } catch (e) {
      }
      try {
        s.ctl && s.ctl.abort();
      } catch (e) {
      }
      try {
        host.busy.end();
        host.setBusy(false);
      } catch (e) {
      }
      const d = diag();
      if (d) d.streamAborted = (d.streamAborted || 0) + 1;
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
      let ctl = null;
      try {
        ctl = typeof AbortController !== "undefined" ? new AbortController() : null;
      } catch (e) {
        ctl = null;
      }
      activeStream = { ctl };
      let gotHeaders = false;
      const firstTimer = setTimeout(() => {
        try {
          if (!spokeAny && !gotHeaders && ctl) ctl.abort();
        } catch (e) {
        }
      }, 4e3);
      let bubbleAt = 0;
      const sb = createSentenceBuffer(40);
      const speakSegs = (segs) => {
        for (const seg of segs) {
          try {
            host.speak(seg, { rate: "+0%" });
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
        if (!isCurrent()) return dropStale();
        if (!res.ok || !res.body) {
          clearTimeout(firstTimer);
          clearActive(ctl);
          return false;
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
              clearTimeout(firstTimer);
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
              if (reply) {
                if (host.replyDeduper.allow(reply)) {
                  speakSegs(sb.flush());
                  host.busy.end();
                  host.setBusy(false);
                  host.setMessages((m) => [...m, { who: "fish", text: reply }]);
                  host.bubble(reply, 6e3);
                  host.talkFor(1500);
                  host.scrollBody();
                  const d = diag();
                  if (d) d.lastChat = { stage: "stream-done", firstDeltaMs: obj.firstDeltaMs || 0, ms: obj.ms || 0, cached: !!obj.cached, reply: reply.slice(0, 40) };
                }
              }
              clearTimeout(firstTimer);
              clearActive(ctl);
              host.busy.end();
              host.setBusy(false);
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
        if (full) {
          host.setMessages((m) => [...m, { who: "fish", text: full }]);
          host.bubble(full, 6e3);
          host.scrollBody();
        }
        return true;
      } catch (e) {
        clearTimeout(firstTimer);
        if (!isCurrent()) return dropStale();
        clearActive(ctl);
        host.busy.end();
        host.setBusy(false);
        if (spokeAny) {
          speakSegs(sb.flush());
          const d = diag();
          if (d) d.streamFallback = String(e && e.message || e);
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
      if (d0) d0.ttsSkip = "empty-text";
      if (d0) d0.lastChat = { stage: "entry", busy: host.busy.isBusy(), tts: !!host.ttsPlaying(), at: Date.now() };
      if (host.busy.isBusy() && d0) d0.lastChat.stage = "blocked-busy";
      if (host.busy.isBusy() && host.busy.age() < 35e3) {
        if (opts && opts.voice) host.bubble("\u672C\u9CB8\u8FD8\u5728\u60F3\u4E0A\u4E00\u53E5\u5462\uFF0C\u7A0D\u7B49\uFF5E", 2500);
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
      if (host.route(text)) {
        host.setInput("");
        return;
      }
      const myEpoch = host.epoch.next();
      try {
        if (await tryStream(text, opts, myEpoch)) {
          host.setInput("");
          return;
        }
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
      host.setInput("");
      host.setMessages((m) => [...m, { who: "me", text }]);
      try {
        if (opts && opts.voice && !host.ttsPlaying() && Math.random() < 0.25) host.say(host.persona.line("waiting"), 3e3);
      } catch (e) {
      }
      host.busy.begin();
      host.setBusy(true);
      host.talkFor(1200);
      host.scrollBody();
      let data = null;
      try {
        const tChat = performance.now();
        data = await postJson("/chat", { message: text, voice: true, lang: resolveChatLang() }, {
          // 30 秒上限：请求卡住时别让状态永远停在「在想…」
          signal: timeoutSignal(3e4)
        });
        try {
          host.recordChatLatency(Math.round(performance.now() - tChat));
        } catch (e) {
        }
        if (!host.epoch.isCurrent(myEpoch)) return;
        const reply = data?.reply || "\u4E3B\u4EBA\u2026\u2026\u672C\u9CB8\u8D70\u795E\u4E86\u3002";
        const d1 = diag();
        if (d1) d1.lastChat = { stage: "fetched", reply: String(reply).slice(0, 40), at: Date.now() };
        host.setMessages((m) => [...m, { who: "fish", text: reply }]);
        if (host.voiceMode.current) {
          host.bubble("\uFF08\u8BF4\uFF09" + reply, 8e3);
        }
        if (data && data.upgraded) host.bubble("\u672C\u9CB8\u53C8\u957F\u5927\u4E00\u70B9\u5566\uFF01", 4e3);
      } catch {
        host.setMessages((m) => [...m, { who: "fish", text: host.persona.line("error") }]);
      } finally {
        host.busy.end();
        host.setBusy(false);
        host.talkFor(1500);
        try {
          if (data && data.reply && host.epoch.isCurrent(myEpoch)) {
            const rp = String(data.reply);
            const d2 = diag();
            if (d2) d2.lastChat = { stage: "speak", reply: rp.slice(0, 40), at: Date.now() };
            host.speakReply(rp);
          }
        } catch {
        }
        host.scrollBody();
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
      const item = queue.shift();
      const body = String(item && item.text || "").trim() || "\u65F6\u95F4\u5230\u4E86";
      const line = "\u4E3B\u4EBA\uFF0C\u63D0\u9192\u4F60\uFF1A" + body;
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
        try {
          clearInterval(pollTimer);
        } catch (e) {
        }
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
        try {
          clearTimeout(dueTimer);
        } catch (e) {
        }
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
  var MANAGE_HINT = "\u56DE\u590D\u6570\u5B57\u53EF\u5220\u9664 / \u56DE d \u987A\u5EF6 10 \u5206\u949F";
  function normalizeManageInput(text) {
    return String(text == null ? "" : text).replace(/[\s。，、！？；：,.!?;:…~～·"'“”‘’（）()【】\[\]]/g, "").toLowerCase();
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
  function stampOf(item) {
    const raw = item.nextAt || item.at;
    const d = new Date(raw);
    if (isNaN(d.getTime())) return String(raw == null ? "" : raw);
    try {
      return d.toLocaleString("zh-CN");
    } catch (e) {
      return formatClock(d);
    }
  }
  function boardText(items, prefix) {
    const lines = items.map((it, i) => {
      const rep = Number(it.repeat) > 0 ? "\uFF08\u91CD\u590D\uFF09" : "";
      return i + 1 + ". " + it.text + "\uFF08" + stampOf(it) + "\uFF09" + rep;
    });
    const head = prefix ? prefix + "\n" : "";
    if (!lines.length) return head + "\u6CA1\u6709\u63D0\u9192\u4E86";
    return head + lines.join("\n") + "\n" + MANAGE_HINT;
  }
  function normalizeReminderList(payload) {
    const arr = Array.isArray(payload && payload.reminders) ? payload.reminders : Array.isArray(payload) ? payload : [];
    const out = [];
    for (const x of arr) {
      if (!x || typeof x !== "object") continue;
      if (x.done === true) continue;
      const id = String(x.id == null ? "" : x.id);
      if (!id) continue;
      out.push({
        id,
        text: String(x.text == null ? "" : x.text),
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
      return openedAt > 0 && board.length > 0 && now - openedAt <= MANAGE_WINDOW_MS;
    }
    function expire() {
      openedAt = 0;
      board = [];
    }
    function refresh() {
      const my = ++seq;
      return Promise.resolve(fetchJson("/reminders")).then((d) => {
        if (my !== seq) return board;
        board = normalizeReminderList(d);
        return board;
      }).catch(() => board);
    }
    function open() {
      const my = ++seq;
      const at = clock();
      openedAt = 0;
      return Promise.resolve(fetchJson("/reminders")).then((d) => {
        if (my !== seq) return;
        const arr = normalizeReminderList(d);
        board = arr;
        if (!arr.length) {
          openedAt = 0;
          host.bubble("\u8FD8\u6CA1\u6709\u63D0\u9192\uFF5E", 3e3);
          return;
        }
        openedAt = at;
        host.bubble(boardText(arr, "\u63D0\u9192\u6E05\u5355\uFF08" + arr.length + " \u6761\uFF09\uFF1A"), 12e3);
      }).catch(() => {
        if (my !== seq) return;
        openedAt = 0;
        board = [];
        host.bubble("\u63D0\u9192\u6E05\u5355\u67E5\u4E0D\u5230", 5e3);
      });
    }
    function afterDelete() {
      const my = ++seq;
      Promise.resolve(fetchJson("/reminders")).then((d) => {
        if (my !== seq) return;
        const arr = normalizeReminderList(d);
        board = arr;
        if (!arr.length) {
          openedAt = 0;
          host.bubble("\u5220\u6389\u4E86", 4e3);
          return;
        }
        host.bubble(boardText(arr, "\u5220\u6389\u4E86"), 12e3);
      }).catch(() => {
        openedAt = 0;
        board = [];
        host.bubble("\u5220\u6389\u4E86", 4e3);
      });
    }
    function removeAt(index) {
      const it = board[index - 1];
      if (!it) {
        host.bubble("\u6CA1\u6709\u7B2C " + index + " \u6761\uFF0C\u56DE\u6570\u5B57\u518D\u9009\u4E00\u6B21", 4e3);
        return;
      }
      Promise.resolve(removeJson("/reminders?id=" + encodeURIComponent(it.id))).then((d) => {
        if (!(d && d.ok)) {
          host.bubble("\u6CA1\u5220\u6389\uFF0C\u7B49\u4F1A\u513F\u518D\u8BD5", 4e3);
          return;
        }
        afterDelete();
      }).catch(() => host.bubble("\u6CA1\u5220\u6389\uFF0C\u7B49\u4F1A\u513F\u518D\u8BD5", 4e3));
    }
    function postpone() {
      const pick = pickNextDue(board);
      if (!pick) {
        host.bubble("\u6E05\u5355\u91CC\u6CA1\u6709\u80FD\u987A\u5EF6\u7684\u63D0\u9192", 4e3);
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
      Promise.resolve(sendJson("/reminders", body)).then((d) => {
        if (!(d && d.ok)) {
          host.bubble("\u987A\u5EF6\u6CA1\u6210\uFF0C\u539F\u63D0\u9192\u8FD8\u5728", 4e3);
          return;
        }
        Promise.resolve(removeJson("/reminders?id=" + encodeURIComponent(pick.id))).then((d2) => {
          if (!(d2 && d2.ok)) {
            host.bubble("\u987A\u5EF6\u5230 " + when + "\uFF0C\u4F46\u65E7\u63D0\u9192\u6CA1\u5220\u6389", 6e3);
            return;
          }
          const my = ++seq;
          Promise.resolve(fetchJson("/reminders")).then((d3) => {
            if (my !== seq) return;
            const arr = normalizeReminderList(d3);
            board = arr;
            if (!arr.length) {
              openedAt = 0;
              host.bubble("\u987A\u5EF6\u5230 " + when, 5e3);
              return;
            }
            host.bubble(boardText(arr, "\u987A\u5EF6\u5230 " + when), 12e3);
          }).catch(() => {
            openedAt = 0;
            board = [];
            host.bubble("\u987A\u5EF6\u5230 " + when, 5e3);
          });
        }).catch(() => host.bubble("\u987A\u5EF6\u5230 " + when + "\uFF0C\u4F46\u65E7\u63D0\u9192\u6CA1\u5220\u6389", 6e3));
      }).catch(() => host.bubble("\u987A\u5EF6\u6CA1\u6210\uFF0C\u539F\u63D0\u9192\u8FD8\u5728", 4e3));
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
    const key = String(e.key == null ? "" : e.key).toLowerCase();
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
        title: "\u70B9\u4E00\u4E0B\u53EB\u672C\u9CB8\u56DE\u6765\uFF08\u6216\u6309 " + RECOVER_HOTKEY_LABEL + "\uFF09",
        onClick: (e) => {
          try {
            if (e && typeof e.stopPropagation === "function") e.stopPropagation();
          } catch (err) {
          }
          try {
            if (e && typeof e.preventDefault === "function") e.preventDefault();
          } catch (err) {
          }
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
        try {
          if (e && typeof e.preventDefault === "function") e.preventDefault();
        } catch (err) {
        }
        try {
          if (e && typeof e.stopPropagation === "function") e.stopPropagation();
        } catch (err) {
        }
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
      const actions = createActionTable();
      registerCultureActions(actions);
      registerContentActions(actions);
      registerSystemActions(actions);
      registerVoiceActions(actions);
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
      const epoch = createEpoch();
      let asrBusy = false;
      let asrBusyAt = 0;
      const storyNarratingRef = { current: false };
      const persona = createPersona();
      let lastPoemSpeech = "";
      const narration = createNarrationLock();
      let lastSpeakingAt = 0;
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
      const lineDeduper = createDeduper({ windowMs: 25e3, onDuplicate: () => {
        try {
          window.__chubbyWhale.dupLine = (window.__chubbyWhale.dupLine || 0) + 1;
        } catch (e) {
        }
      } });
      const replyDeduper = createDeduper({ windowMs: 3e4, onDuplicate: () => {
        try {
          window.__chubbyWhale.dupReply = (window.__chubbyWhale.dupReply || 0) + 1;
        } catch (e) {
        }
      } });
      const latDiag = { asrMs: 0, chatMs: 0, firstAudioMs: 0, totalMs: 0, updates: 0 };
      const melody = createMelodyPlayer();
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
        const animRef = R.useRef(null);
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
        const reminderPollerRef = R.useRef(null);
        const [scale, setScale] = R.useState(1);
        const [hidden, setHidden] = R.useState(false);
        const [menu, setMenu] = R.useState(null);
        const [subOpen, setSubOpen] = R.useState("");
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
        const [messages, setMessages] = R.useState([]);
        const [input, setInput] = R.useState("");
        const [busy, setBusy] = R.useState(false);
        const busyLockRef = R.useRef(null);
        if (!busyLockRef.current) busyLockRef.current = createBusyLock();
        const busyLock = busyLockRef.current;
        const bodyRef = R.useRef(null);
        const bubbleRef = R.useRef(null);
        const bubbleTextRef = R.useRef(null);
        const bridgeRef = R.useRef(null);
        if (!bridgeRef.current) {
          bridgeRef.current = createVoiceBridge({
            narration,
            narrating: () => storyNarratingRef.current,
            stopSpeaking: () => stopTts(),
            bubble: showBubble,
            sendText: (text, opts) => sendText(text, opts),
            onVoiceHeard: () => {
              try {
                voiceModeRef.current = true;
              } catch (e) {
              }
            },
            onSpeaking: (playing) => {
              ttsPlaying = playing;
              if (playing) {
                try {
                  lastSpeakingAt = Date.now();
                } catch (e) {
                }
              }
            },
            // 语音聊天关着时"只听不接话"（由唤醒门之前先拦一道）
            voiceChat: () => voiceChatOnRef.current,
            // 正在朗读时，语音"停"要能直接打断（不受唤醒门限制）
            speaking: () => ttsPlaying,
            diag: (patch) => {
              try {
                Object.assign(window.__chubbyWhale || (window.__chubbyWhale = {}), patch);
              } catch (e) {
              }
            }
          });
        }
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
          const s = scaleRef.current || 1;
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
              if (reminderPollerRef.current) reminderPollerRef.current.dispose();
            } catch {
            }
            stopTts();
            melody.stop();
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
        function setStatus() {
          bubble.dismissStatus();
        }
        function restoreIdleStatus() {
        }
        const reminderManager = createReminderManager({ bubble: (text, ms2) => showBubble(text, ms2) });
        const recover = createRecover({ recover: () => setHidden(false) });
        R.useEffect(() => {
          const unbind = recover.bindHotkey(window);
          return () => {
            try {
              unbind();
            } catch (e) {
            }
          };
        }, []);
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
          beginDrag(dragRef.current, e.clientX, e.clientY, posRef.current.x, posRef.current.y);
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
          const m = moveDrag(d, e.clientX, e.clientY);
          applyPos(posRef.current.x + m.x, posRef.current.y + m.y);
        }
        function onPointerUp() {
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
          const step = () => {
            if (dragRef.current.dragging) return;
            const dv = decayVelocity(vx, vy);
            vx = dv.vx;
            vy = dv.vy;
            applyPos(posRef.current.x + vx, posRef.current.y + vy);
            if (dv.done) {
              savePos();
              return;
            }
            requestAnimationFrame(step);
          };
          requestAnimationFrame(step);
        }
        R.useEffect(() => {
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
                if (narration.expire()) {
                  clearNarrating();
                  try {
                    window.__chubbyWhale.narrReset = (window.__chubbyWhale.narrReset || 0) + 1;
                  } catch (e3) {
                  }
                }
              } catch (e3) {
              }
              if (busyLock.watchdog()) {
                setBusy(false);
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
          refreshMenuStats();
          refreshStoryBooks();
        }
        function refreshStoryBooks() {
          getJson("/story/books", { cache: "no-store" }).then((d) => {
            const list = d && d.ok && Array.isArray(d.books) ? d.books.map((b) => String(b || "").trim()).filter(Boolean) : [];
            setStoryBooks(list);
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
          setGrowthLabel(info.stage + "\uFF08" + info.exp + (info.nextExp ? "/" + info.nextExp : "") + "\uFF09");
          setGrowth(info);
        }
        function syncGrowth() {
          fetchGrowth((p, init) => getJson(p, init)).then((info) => {
            if (info) {
              setGrowthLabel(info.stage + "\uFF08" + info.exp + (info.nextExp ? "/" + info.nextExp : "") + "\uFF09");
              setGrowth(info);
            } else {
              setGrowth(DEFAULT_GROWTH);
            }
          });
        }
        function refreshBalance() {
          getJson("/balance", { cache: "no-store" }).then((d) => {
            if (d && d.ok && d.balance != null) {
              const v = String(d.balance);
              setBalanceText("\u4F59\u989D \xA5" + v);
              setBalanceLabel("\xA5" + v);
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
        if (!reminderPollerRef.current) {
          reminderPollerRef.current = createReminderPoller({
            getJson: (path, init) => getJson(path, init),
            bubble: (text, ms2) => showBubble(text, ms2),
            talkFor: (ms2) => {
              try {
                animRef.current?.talkFor(ms2);
              } catch (e) {
              }
            },
            speak: (text) => {
              try {
                speakText(text);
              } catch (e) {
              }
            },
            isSpeaking: () => ttsPlaying,
            isNarrating: () => storyNarratingRef.current,
            isBusy: () => busyLock.isBusy()
          });
        }
        const reminderPoller = reminderPollerRef.current;
        const actionHost = {
          bubble: (text, ms2) => showBubble(text, ms2),
          say: (text, ms2, opts) => sayLine(text, ms2, opts),
          speak: (text, opts) => speakText(text, opts),
          speakReply: (text) => speakReply(text),
          narrate: setNarrating,
          clearNarrate: clearNarrating,
          stopSpeak: () => stopTts(),
          stopMelody: () => melody.stop(),
          playMelody: (notes, bpm, onDone) => melody.play(notes, bpm, onDone),
          talkFor: (ms2) => {
            try {
              animRef.current?.talkFor(ms2);
            } catch (e) {
            }
          },
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
              showBubble("\u8BED\u97F3\u5F85\u547D\uFF1A\u5173\uFF08\u672C\u9CB8\u4E0D\u542C\u5566\uFF09", 2500);
              return;
            }
            try {
              bridge.start().then((v) => {
                try {
                  if (v.status() === "idle") showBubble("\u9EA6\u514B\u98CE\u6CA1\u6253\u5F00\uFF1A" + String(v.stats && v.stats.lastError || "\u770B\u770B\u6743\u9650\uFF1F"), 5e3);
                  else showBubble("\u8BED\u97F3\u5F85\u547D\uFF1A\u5F00\uFF08\u5148\u558A\u300C\u5927\u80A5\u9C7C\u300D\uFF0C\u672C\u9CB8\u624D\u7B54\u8BDD\uFF09", 3500);
                } catch (e) {
                }
              }).catch((e) => showBubble("\u9EA6\u514B\u98CE\u6CA1\u6253\u5F00\uFF1A" + String(e && e.message || e), 5e3));
            } catch (e) {
              showBubble("\u8BED\u97F3\u5F85\u547D\u6CA1\u5F00\u6210\uFF1A" + String(e && e.message || e), 5e3);
            }
          },
          chatCacheOn: () => chatCacheOnRef.current,
          setChatCacheOn: (v) => {
            chatCacheOnRef.current = v;
            setChatCacheOn(v);
          },
          diag: (patch) => {
            try {
              Object.assign(window.__chubbyWhale || (window.__chubbyWhale = {}), patch);
            } catch (e) {
            }
          }
        };
        async function runAction(action) {
          setMenu(null);
          let ok = false;
          try {
            ok = await actions.run(action, actionHost);
          } catch (e) {
            ok = false;
          }
          if (!ok) showBubble("\u8FD9\u4E2A\u529F\u80FD\u8FD8\u6CA1\u63A5\u4E0A");
        }
        function scrollBody() {
          setTimeout(() => {
            const el = bodyRef.current;
            if (el) el.scrollTop = el.scrollHeight;
          }, 0);
        }
        const localRouter = createLocalRouter({
          persona,
          narrationRate,
          bubble: (text, ms2) => showBubble(text, ms2),
          say: (text, ms2, opts) => sayLine(text, ms2, opts),
          speak: (text, opts) => speakText(text, opts),
          narrate: setNarrating,
          clearNarrate: clearNarrating,
          talkFor: (ms2) => {
            try {
              animRef.current?.talkFor(ms2);
            } catch (e) {
            }
          },
          story,
          storyState: { busy: storyBusyRef, narrating: storyNarratingRef, auto: storyAutoRef, book: storyBookRef }
        });
        const chat = createChatSender({
          persona,
          bubble: (text, ms2) => showBubble(text, ms2),
          say: (text, ms2, voiceOpts) => sayLine(text, ms2, voiceOpts),
          speak: (text, opts) => speakText(text, opts),
          speakReply: (text) => speakReply(text),
          stopSpeak: () => stopTts(),
          talkFor: (ms2) => {
            try {
              animRef.current?.talkFor(ms2);
            } catch (e) {
            }
          },
          heart: () => {
            try {
              animRef.current?.pushHeart();
            } catch (e) {
            }
          },
          setInput: (v) => setInput(v),
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
        });
        function sendText(rawText, opts) {
          try {
            if (reminderManager.intercept(String(rawText == null ? "" : rawText))) return Promise.resolve();
          } catch (e) {
          }
          return chat.send(rawText, opts);
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
            w.busyNow = () => ({ busy: busyLock.isBusy(), age: busyLock.age(), tts: ttsPlaying });
            w.look = () => lookRef.current;
          } catch (e) {
          }
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
              try {
                window.__chubbyWhale.ttsSkip = "voice-off";
              } catch (e) {
              }
              ;
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
        function muteMic() {
          bridge.mute(true);
        }
        function unmuteMic() {
          bridge.mute(false);
        }
        function prefetchFiller() {
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
            if (v && v.speak && !v.speaking()) v.speak(text, { rate: voiceOpts && voiceOpts.rate || "+0%", pitch: voiceOpts && voiceOpts.pitch || "" });
          } catch (e) {
          }
        }
        function speakReply(text) {
          const rp = String(text || "");
          if (!rp.trim()) return;
          if (!replyDeduper.allow(rp)) return;
          speakText(rp, { rate: rp.length >= 80 ? narrationRate() : "+0%" });
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
          recoverProps ? h("div", Object.assign({}, recoverProps, { style: recoverDotStyle }), "\u25CB") : null,
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
                    refreshMenuStats(true);
                  } catch (e) {
                  }
                }
              }, balanceText || "--")
            ),
            renderItems(buildMenu(VERSION, { voiceOn, earOn, voiceChatOn, chatCacheOn, storyAuto: (() => {
              try {
                return localStorage.getItem("chubby-story-auto") !== "0";
              } catch (e) {
                return true;
              }
            })(), narrationRate: narrationRate(), streamOn: (() => {
              try {
                return localStorage.getItem("chubby-stream") !== "off";
              } catch (e) {
                return true;
              }
            })(), storyRate: (() => {
              try {
                const s = localStorage.getItem("chubby-story-rate") || "-35%";
                return /^-\d{1,2}%$/.test(s) ? s : "-35%";
              } catch (e) {
                return "-35%";
              }
            })(), poemRate: (() => {
              try {
                const s = localStorage.getItem("chubby-poem-rate") || "-25%";
                return /^-\d{1,2}%$/.test(s) ? s : "-25%";
              } catch (e) {
                return "-25%";
              }
            })(), ttsVoice: (() => {
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
            })(), balance: balanceLabel, growth: growthLabel, storyBooks, storyBooksTried }))
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
              diag2.error = "ctx.slots \u4E0D\u5B58\u5728\uFF08inject \u672A\u751F\u6548\uFF09";
              console.warn("[chubby-whale]", diag2.error);
              return;
            }
            const desc = { name: "shell.overlay", id: "chubby-whale-overlay", order: 999, locale: "chubby-whale", inject: () => ({}) };
            const render = WhaleOverlay;
            const doRegister = () => {
              try {
                slots.register(desc, render);
                diag2.registered = true;
                console.log("[chubby-whale] overlay \u5DF2\u6CE8\u518C");
              } catch (e) {
                diag2.error = "register \u5931\u8D25: " + String(e);
                console.error("[chubby-whale] overlay \u6CE8\u518C\u5931\u8D25\uFF1A", e);
              }
            };
            try {
              slots.inject("shell.overlay", doRegister);
              setTimeout(() => {
                if (!diag2.registered) doRegister();
              }, 1200);
            } catch (e) {
              diag2.error = "inject \u5931\u8D25: " + String(e);
              console.error("[chubby-whale] overlay \u6CE8\u5165\u5931\u8D25\uFF1A", e);
              doRegister();
            }
          } catch (e) {
            diag2.error = "apply \u5F02\u5E38: " + String(e);
            console.error("[chubby-whale] apply \u5F02\u5E38\uFF1A", e);
          }
        }
      };
    }
  });
})();
