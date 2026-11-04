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
  var EN_MAP = {
    "\u5582\u5B83\u4E00\u53E3": "Feed it",
    "\u5F39\u9996\u66F2\u5B50 \u25B8": "Play a song \u25B8",
    "\u505C\u6B62\u5F39\u594F": "Stop music",
    "\u6253\u5B57\u8BF4\u4E24\u53E5": "Type a message",
    "\u8BED\u97F3\u6717\u8BFB\uFF1A\u5F00": "Voice output: on",
    "\u6362\u4E2A\u58F0\u97F3 \u25B8": "Change voice \u25B8",
    "\u804A\u5929\u8BED\u8A00 \u25B8": "Chat language \u25B8",
    "\u754C\u9762\u8BED\u8A00 \u25B8": "Interface language \u25B8",
    "\u8BED\u97F3\u5F85\u547D\uFF1A\u5F00": "Voice standby: on",
    "\u8BED\u97F3\u804A\u5929\uFF1A\u5F00": "Voice chat: on",
    "\u4F59\u989D\uFF1A--": "Balance: --",
    "\u505C\u4E0B\u6B47\u4F1A\u513F": "Take a break",
    "\u56DE\u5230\u53F3\u4E0B\u89D2": "Back to corner",
    "\u957F\u5927\u4E00\u70B9": "Grow bigger",
    "\u53D8\u5C0F\u4E00\u70B9": "Shrink",
    "\u4ECA\u65E5\u7B80\u62A5\uFF1A\u5F00": "Daily briefing: on",
    "\u73B0\u5728\u7B80\u62A5\u4E00\u6B21": "Brief me now",
    "\u6700\u8FD1\u7B80\u62A5 \u25B8": "Recent briefings \u25B8",
    "\u53E3\u8FF0\u516C\u6587\uFF1A\u5F00\u59CB": "Dictate: start",
    "\u4EA4\u7ED9 DSH \u52A9\u624B\u2026": "Send to DSH\u2026",
    "\u52A0\u4E2A\u63D0\u9192\u2026": "Add reminder\u2026",
    "\u63D0\u9192\u6E05\u5355\u2026": "Reminders\u2026",
    "\u6587\u5316\u6C14 \u25B8": "Culture \u25B8",
    "\u8BF4\u4E66\uFF08\u8FDE\u8F7D\uFF09": "Storytelling",
    "\u63A5\u7740\u8BF4": "Continue story",
    "\u5FF5\u9996\u8BD7": "Recite a poem",
    "\u8BB2\u4E2A\u6C11\u95F4\u6545\u4E8B": "Folk tale",
    "\u8BB2\u4E2A\u5178\u6545": "Classic allusion",
    "\u6210\u8BED\u8FA8\u6790": "Idiom",
    "\u51FA\u4E2A\u5BF9\u8054": "Couplet",
    "\u6E05\u9664\u8BB0\u5FC6\u2026": "Clear memory\u2026",
    "\u8BA9\u5B83\u6E38\u8D70\uFF08\u9000\u51FA\uFF09": "Let it go (exit)",
    "\u9C7C\u7CAE\u8D26\u672C": "Token ledger",
    "\u6210\u957F\uFF1A--": "Growth: --",
    "\u4E2D\u6587": "\u4E2D\u6587",
    "English": "English",
    "\u81EA\u52A8\uFF08\u6309\u8BED\u8A00\u9009\u97F3\u8272\uFF09": "Auto (by language)",
    "\u97F3\u8272\uFF1A\u6653\u4F0A\uFF08\u4E2D\xB7\u5973\uFF09": "Voice: Xiaoyi (CN F)",
    "\u97F3\u8272\uFF1A\u6653\u6653\uFF08\u4E2D\xB7\u5973\uFF09": "Voice: Xiaoxiao (CN F)",
    "\u97F3\u8272\uFF1A\u6653\u8FB0\uFF08\u4E2D\xB7\u5973\uFF09": "Voice: Xiaochen (CN F)",
    "\u97F3\u8272\uFF1A\u4E91\u5E0C\uFF08\u4E2D\xB7\u7537\uFF09": "Voice: Yunxi (CN M)",
    "\u97F3\u8272\uFF1A\u4E91\u626C\uFF08\u4E2D\xB7\u7537\uFF09": "Voice: Yunyang (CN M)",
    "\u97F3\u8272\uFF1AAna\uFF08\u82F1\xB7\u5973\uFF09": "Voice: Ana (EN F)",
    "\u97F3\u8272\uFF1AJenny\uFF08\u82F1\xB7\u5973\uFF09": "Voice: Jenny (EN F)",
    "\u97F3\u8272\uFF1ASonia\uFF08\u82F1\xB7\u5973\xB7\u82F1\u5F0F\uFF09": "Voice: Sonia (EN-GB F)",
    "\u6682\u65E0\u7B80\u62A5": "No briefings yet"
  };
  function tr(label, lang) {
    if (lang !== "en") return label;
    return EN_MAP[label] || label;
  }
  function buildMenu(version, state) {
    const voiceOn = state && state.voiceOn ? true : false;
    const balanceText = state && state.balance ? state.balance : "--";
    const growthText = state && state.growth ? state.growth : "--";
    return [
      { type: "item", label: "\u5582\u5B83\u4E00\u53E3", action: "feed" },
      { type: "sep" },
      { type: "sub", label: "\u5F39\u9996\u66F2\u5B50 \u25B8", items: MELODIES.map((m) => ({ type: "item", label: "\u5F39\u300A" + m + "\u300B", action: "music:" + m })) },
      { type: "item", label: "\u505C\u6B62\u5F39\u594F", action: "music-stop" },
      { type: "sep" },
      { type: "item", label: "\u6253\u5B57\u8BF4\u4E24\u53E5", action: "type" },
      { type: "item", label: voiceOn ? "\u8BED\u97F3\u6717\u8BFB\uFF1A\u5F00" : "\u8BED\u97F3\u6717\u8BFB\uFF1A\u5173", action: "voice" },
      { type: "sub", label: "\u6362\u4E2A\u58F0\u97F3 \u25B8", items: [
        { type: "item", label: "\u81EA\u52A8\uFF08\u6309\u8BED\u8A00\u9009\u97F3\u8272\uFF09", action: "voice:auto" },
        { type: "item", label: "\u97F3\u8272\uFF1A\u6653\u4F0A\uFF08\u4E2D\xB7\u5973\uFF09", action: "voice:zh-CN-XiaoyiNeural" },
        { type: "item", label: "\u97F3\u8272\uFF1A\u6653\u6653\uFF08\u4E2D\xB7\u5973\uFF09", action: "voice:zh-CN-XiaoxiaoNeural" },
        { type: "item", label: "\u97F3\u8272\uFF1A\u6653\u8FB0\uFF08\u4E2D\xB7\u5973\uFF09", action: "voice:zh-CN-XiaochenNeural" },
        { type: "item", label: "\u97F3\u8272\uFF1A\u4E91\u5E0C\uFF08\u4E2D\xB7\u7537\uFF09", action: "voice:zh-CN-YunxiNeural" },
        { type: "item", label: "\u97F3\u8272\uFF1A\u4E91\u626C\uFF08\u4E2D\xB7\u7537\uFF09", action: "voice:zh-CN-YunyangNeural" },
        { type: "item", label: "\u97F3\u8272\uFF1AAna\uFF08\u82F1\xB7\u5973\uFF09", action: "voice:en-US-AnaNeural" },
        { type: "item", label: "\u97F3\u8272\uFF1AJenny\uFF08\u82F1\xB7\u5973\uFF09", action: "voice:en-US-JennyNeural" },
        { type: "item", label: "\u97F3\u8272\uFF1ASonia\uFF08\u82F1\xB7\u5973\xB7\u82F1\u5F0F\uFF09", action: "voice:en-GB-SoniaNeural" }
      ] },
      { type: "sub", label: "\u804A\u5929\u8BED\u8A00 \u25B8", items: [
        { type: "item", label: "\u4E2D\u6587", action: "chat-lang:zh" },
        { type: "item", label: "English", action: "chat-lang:en" }
      ] },
      { type: "sub", label: "\u754C\u9762\u8BED\u8A00 \u25B8", items: [
        { type: "item", label: "\u4E2D\u6587", action: "lang:zh" },
        { type: "item", label: "English", action: "lang:en" }
      ] },
      { type: "sep" },
      { type: "item", label: "\u8BED\u97F3\u5F85\u547D\uFF1A\u5F00", action: "wake" },
      { type: "item", label: "\u8BED\u97F3\u804A\u5929\uFF1A\u5F00", action: "chatmode" },
      { type: "item", label: "\u505C\u4E0B\u6B47\u4F1A\u513F", action: "pause" },
      { type: "item", label: "\u56DE\u5230\u53F3\u4E0B\u89D2", action: "home" },
      { type: "item", label: "\u957F\u5927\u4E00\u70B9", action: "bigger" },
      { type: "item", label: "\u53D8\u5C0F\u4E00\u70B9", action: "smaller" },
      { type: "sep" },
      { type: "item", label: "\u4ECA\u65E5\u7B80\u62A5\uFF1A\u5F00", action: "briefing" },
      { type: "item", label: "\u73B0\u5728\u7B80\u62A5\u4E00\u6B21", action: "briefing-now" },
      { type: "sub", label: "\u6700\u8FD1\u7B80\u62A5 \u25B8", items: [
        { type: "item", label: "\u6682\u65E0\u7B80\u62A5", action: "briefing-recent" }
      ] },
      { type: "sep" },
      { type: "item", label: "\u53E3\u8FF0\u516C\u6587\uFF1A\u5F00\u59CB", action: "dictate" },
      { type: "item", label: "\u4EA4\u7ED9 DSH \u52A9\u624B\u2026", action: "dsh" },
      { type: "item", label: "\u52A0\u4E2A\u63D0\u9192\u2026", action: "remind-add" },
      { type: "item", label: "\u63D0\u9192\u6E05\u5355\u2026", action: "remind-list" },
      { type: "sep" },
      { type: "sub", label: "\u6587\u5316\u6C14 \u25B8", items: [
        { type: "item", label: "\u8BF4\u4E66\uFF08\u8FDE\u8F7D\uFF09", action: "culture-story" },
        { type: "item", label: "\u63A5\u7740\u8BF4", action: "culture-story-next" },
        { type: "item", label: "\u5FF5\u9996\u8BD7", action: "poem" },
        { type: "item", label: "\u8BB2\u4E2A\u6C11\u95F4\u6545\u4E8B", action: "culture-tale" },
        { type: "item", label: "\u8BB2\u4E2A\u5178\u6545", action: "culture-allusion" },
        { type: "item", label: "\u6210\u8BED\u8FA8\u6790", action: "culture-idiom" },
        { type: "item", label: "\u51FA\u4E2A\u5BF9\u8054", action: "culture-couplet" }
      ] },
      { type: "item", label: "\u6E05\u9664\u8BB0\u5FC6\u2026", action: "clear-memory" },
      { type: "item", label: "\u8BA9\u5B83\u6E38\u8D70\uFF08\u9000\u51FA\uFF09", action: "hide" },
      { type: "sep" },
      { type: "item", label: "\u9C7C\u7CAE\u8D26\u672C", action: "fishfood" },
      { type: "item", label: "\u6210\u957F\uFF1A" + growthText, action: "growth" },
      { type: "item", label: "\u7248\u672C\uFF1Av" + version, action: "version" }
    ];
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
    function drawHearts() {
      const arr = state.hearts;
      for (let i = arr.length - 1; i >= 0; i--) {
        const hh = arr[i];
        hh.age += 1 / 60;
        if (hh.age > 1.4) {
          arr.splice(i, 1);
          continue;
        }
        const x = 120 + Math.sin(hh.age * 6) * 30;
        const y = 30 - hh.age * 40;
        ctx.fillStyle = "rgba(255,120,150," + (1 - hh.age / 1.4) + ")";
        ctx.font = "22px serif";
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
      drawHearts();
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
      state.hearts.push({ age: 0 });
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
    if (t.length <= maxLen) return [t];
    const boundary = /[。！？!?；;…，,、\n\r]/;
    const minCut = Math.max(20, Math.floor(maxLen / 2));
    const out = [];
    let start = 0;
    while (start < t.length) {
      let end = Math.min(t.length, start + maxLen);
      if (end < t.length) {
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

  // src/shared/time.ts
  var DAY_MS = 864e5;
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
      const h = Number(clock[1]);
      if (Number.isFinite(h) && h >= 0 && h <= 23) {
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
      let ttsAudio = null;
      const ttsQueue = [];
      let ttsPlaying = false;
      function currentVoice() {
        try {
          return localStorage.getItem("chubby-tts-voice") || "auto";
        } catch (e) {
          return "auto";
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
      function speakText(text, opts) {
        try {
          if (!text) return;
          try {
            if (localStorage.getItem("chubby-voice") === "off") return;
          } catch (e) {
          }
          const rate = normalizeRate(opts && opts.rate, "+0%");
          const segs = splitTtsSegments(text, 80);
          for (let i = 0; i < segs.length; i++) {
            ttsQueue.push({ text: segs[i], rate, onDone: i === segs.length - 1 ? opts && opts.onDone : void 0 });
          }
          playNextTts();
        } catch (e) {
        }
      }
      function playNextTts() {
        if (ttsPlaying) return;
        if (ttsQueue.length === 0) return;
        let job = null;
        try {
          ttsPlaying = true;
          job = ttsQueue.shift();
          const text = job.text;
          fetch("/api/chubby-whale/tts", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ text, voice: currentVoice(), rate: job.rate })
          }).then((r) => {
            if (!r.ok) throw new Error("tts http " + r.status);
            return r.arrayBuffer();
          }).then((buf) => {
            const jobRef = job;
            let settled = false;
            const settle = () => {
              if (settled) return;
              settled = true;
              finishTtsJob(jobRef);
              ttsPlaying = false;
              playNextTts();
            };
            const blob = new Blob([buf], { type: "audio/mpeg" });
            const url = URL.createObjectURL(blob);
            const audio = new Audio(url);
            ttsAudio = audio;
            audio.onended = () => {
              try {
                URL.revokeObjectURL(url);
              } catch {
              }
              ;
              settle();
            };
            audio.onerror = () => {
              settle();
            };
            audio.play().catch(() => {
              try {
                const u = new window.SpeechSynthesisUtterance(text.slice(0, 300));
                u.lang = /[\u4e00-\u9fa5]/.test(text) ? "zh-CN" : "en-US";
                u.onend = settle;
                u.onerror = settle;
                window.speechSynthesis.cancel();
                window.speechSynthesis.speak(u);
              } catch (e) {
                settle();
              }
            });
          }).catch(() => {
            finishTtsJob(job);
            ttsPlaying = false;
            playNextTts();
          });
        } catch (e) {
          ttsPlaying = false;
          if (job) finishTtsJob(job);
        }
      }
      let recognition = null;
      function startVoiceChat(onText) {
        try {
          const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
          if (!SR) {
            showBubble("\u8FD9\u4E2A\u6D4F\u89C8\u5668\u4E0D\u652F\u6301\u8BED\u97F3\u542C\u5199\uFF0C\u6362 Edge \u6216 Chrome \u8BD5\u8BD5", 5e3);
            return;
          }
          if (recognition) {
            try {
              recognition.stop();
            } catch {
            }
          }
          recognition = new SR();
          recognition.lang = "zh-CN";
          recognition.interimResults = false;
          recognition.maxAlternatives = 1;
          recognition.onresult = (e) => {
            try {
              const t = e.results[0][0].transcript;
              if (t) onText(t);
            } catch {
            }
          };
          recognition.onend = () => {
            recognition = null;
          };
          recognition.start();
        } catch (e) {
        }
      }
      const NOTE_FREQ = { "C4": 261.63, "D4": 293.66, "E4": 329.63, "F4": 349.23, "G4": 392, "A4": 440, "B4": 493.88, "C5": 523.25, "D5": 587.33, "E5": 659.25, "F5": 698.46, "G5": 783.99, "A5": 880, "B5": 987.77 };
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
      function WhaleOverlay() {
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
        const [balanceLabel, setBalanceLabel] = R.useState("--");
        const [growthLabel, setGrowthLabel] = R.useState("--");
        const WAKE_WORDS = ["\u5927\u80A5\u9C7C", "\u80A5\u9CB8", "\u80A5\u9C7C", "\u5C0F\u9C7C", "\u84DD\u9C7C", "\u5C0F\u84DD\u9C7C", "\u9C7C\u9C7C", "\u80A5\u80A5"];
        const dragRef = R.useRef({ dragging: false, lastX: 0, lastY: 0, vx: 0, vy: 0, moved: 0 });
        const scaleRef = R.useRef(1);
        const animRef = R.useRef(null);
        const storyBusyRef = R.useRef(false);
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
        const dictateRef = R.useRef({ on: false, text: "" });
        const [dictateOn, setDictateOn] = R.useState(false);
        const [dictText, setDictText] = R.useState("");
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
          x = Math.max(0, Math.min(window.innerWidth - W, x));
          y = Math.max(0, Math.min(window.innerHeight - H, y));
          el.style.left = x + "px";
          el.style.top = y + "px";
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
        function showBubble2(text, ms = 2400) {
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
        function onPointerDown(e) {
          if (e.button !== 0) return;
          const d = dragRef.current;
          d.dragging = true;
          d.lastX = e.clientX;
          d.lastY = e.clientY;
          d.vx = 0;
          d.vy = 0;
          d.moved = 0;
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
        function onContextMenu(e) {
          e.preventDefault();
          setMenu({ x: e.clientX, y: e.clientY });
          setSubOpen("");
          fetch("/api/chubby-whale/balance").then((r) => r.json()).then((d) => {
            if (d && d.ok && d.balance != null) {
              setBalanceText("\u4F59\u989D \xA5" + d.balance);
              setBalanceLabel("\xA5" + d.balance);
            } else setBalanceText("\u4F59\u989D --");
          }).catch(() => setBalanceText("\u4F59\u989D --"));
          fetch("/api/chubby-whale/growth").then((r) => r.json()).then((d) => {
            if (d && d.ok) setGrowthLabel(d.stage + "\uFF08" + d.exp + "\uFF09");
          }).catch(() => {
          });
        }
        function playStoryPiece(d) {
          const text = String(d.text || "");
          const head = "\u8BF4\u4E66\xB7\u300A" + String(d.book || "") + "\u300B" + (d.title ? "\uFF5C" + d.title : "");
          let voiceOff = false;
          try {
            voiceOff = localStorage.getItem("chubby-voice") === "off";
          } catch (e) {
          }
          showBubble2(head + "\uFF1A" + text.slice(0, 100) + (text.length > 100 ? "\u2026" : ""), 12e3);
          animRef.current?.talkFor(8e3);
          if (voiceOff) {
            storyBusyRef.current = false;
            showBubble2(head + "\uFF1A" + text.slice(0, 300) + "\u2026", 2e4);
            return;
          }
          storyBusyRef.current = true;
          speakText(text, {
            rate: normalizeRate(d.rate, "-15%"),
            onDone: () => {
              storyBusyRef.current = false;
              showBubble2("\u8FD9\u6BB5\u8BB2\u5B8C\u5566\uFF5E\u70B9\u83DC\u5355\u300C\u63A5\u7740\u8BF4\u300D\u542C\u4E0B\u4E00\u6BB5", 6e3);
            }
          });
        }
        function startStory(hint) {
          if (storyBusyRef.current) {
            showBubble2("\u6B63\u8BB2\u7740\u5462\uFF0C\u542C\u5B8C\u8FD9\u6BB5\u518D\u8BF4\uFF5E", 3e3);
            return;
          }
          const headers = CLIENT_ID ? { "x-client-id": CLIENT_ID } : {};
          fetch("/api/chubby-whale/story/start" + (hint ? "?hint=" + encodeURIComponent(hint) : ""), { headers }).then((r) => r.json()).then((d) => {
            if (!d || !d.ok) {
              showBubble2("\u8BF4\u4E66\u6CA1\u5F00\u6210\uFF1A" + (d && d.error || "\u6CA1\u8BFB\u5230\u4E66"), 5e3);
              return;
            }
            playStoryPiece(d);
          }).catch(() => showBubble2("\u8BF4\u4E66\u8FDE\u4E0D\u4E0A"));
        }
        function nextStory() {
          if (storyBusyRef.current) {
            showBubble2("\u6B63\u8BB2\u7740\u5462\uFF0C\u542C\u5B8C\u8FD9\u6BB5\u518D\u8BF4\uFF5E", 3e3);
            return;
          }
          const headers = CLIENT_ID ? { "x-client-id": CLIENT_ID } : {};
          fetch("/api/chubby-whale/story/next", { headers }).then((r) => r.json()).then((d) => {
            if (!d || !d.ok) {
              showBubble2("\u8BF4\u4E66\u5361\u4F4F\u4E86", 4e3);
              return;
            }
            if (d.done) {
              showBubble2("\u4E00\u8F6E\u90FD\u8BB2\u5B8C\u5566\uFF0C\u672C\u9C7C\u4ECE\u5934\u518D\u8BB2\uFF5E", 5e3);
              startStory("");
              return;
            }
            playStoryPiece(d);
          }).catch(() => showBubble2("\u8BF4\u4E66\u8FDE\u4E0D\u4E0A"));
        }
        function pumpDueReminders() {
          if (dueTimerRef.current) return;
          if (dueQueueRef.current.length === 0) return;
          const item = dueQueueRef.current.shift();
          showBubble2("\u63D0\u9192\uFF1A" + String(item.text || ""), 8e3);
          animRef.current?.talkFor(3e3);
          try {
            speakText("\u63D0\u9192\uFF1A" + String(item.text || ""));
          } catch (e) {
          }
          dueTimerRef.current = setTimeout(() => {
            dueTimerRef.current = null;
            pumpDueReminders();
          }, 3e3);
        }
        function runAction(action) {
          setMenu(null);
          if (action === "feed") {
            showBubble2("\u597D\u5403\uFF01\u8C22\u8C22\u4E3B\u4EBA\uFF5E");
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
            showBubble2("\u56DE\u5230\u89D2\u843D\u5566");
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
            showBubble2("\u80A5\u9CB8 v" + VERSION);
            return;
          }
          if (action === "type") {
            voiceModeRef.current = false;
            setChatOpen(true);
            return;
          }
          if (action === "pause") {
            showBubble2("\u6B47\u4F1A\u513F\u2026");
            return;
          }
          if (action === "music-stop") {
            stopMelody();
            showBubble2("\u505C\u4E0B\u5566");
            return;
          }
          if (action === "fishfood") {
            fetch("/api/chubby-whale/fishfood").then((r) => r.json()).then((d) => {
              if (d && d.ok) {
                showBubble2("\u9C7C\u7CAE\u8D26\u672C\uFF1A\u804A\u5929 " + d.chatTokens + " tokens\uFF0C\u8BF4\u4E66 " + d.storyTokens + " tokens\uFF0C\u5171 " + d.total, 5e3);
              } else showBubble2("\u9C7C\u7CAE\u67E5\u4E0D\u5230");
            }).catch(() => showBubble2("\u9C7C\u7CAE\u67E5\u4E0D\u5230"));
            return;
          }
          if (action === "growth") {
            Promise.all([fetch("/api/chubby-whale/growth").then((r) => r.json()), fetch("/api/chubby-whale/state").then((r) => r.json())]).then(([g, s]) => {
              if (g && g.ok) {
                const nx = g.nextExp > 0 ? "\uFF08\u7ECF\u9A8C " + g.exp + "/" + g.nextExp + "\uFF09" : "\uFF08\u6EE1\u7EA7\uFF09";
                const it = s && s.intimacy || 0;
                showBubble2("\u6210\u957F\uFF1A" + g.stage + nx + " \xB7 \u4EB2\u5BC6\u5EA6 " + it + "/100", 5e3);
              } else showBubble2("\u6210\u957F\u67E5\u4E0D\u5230");
            }).catch(() => showBubble2("\u6210\u957F\u67E5\u4E0D\u5230"));
            return;
          }
          if (action === "intimacy") {
            fetch("/api/chubby-whale/state").then((r) => r.json()).then((d) => {
              showBubble2("\u4EB2\u5BC6\u5EA6\uFF1A" + (d && d.intimacy || 0) + " / 100");
            }).catch(() => showBubble2("\u4EB2\u5BC6\u5EA6\u67E5\u4E0D\u5230"));
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
          if (action === "poem") {
            fetch("/api/chubby-whale/poem").then((r) => r.json()).then((d) => {
              if (d && d.ok) {
                const body = String(d.text || "");
                const author = String(d.author || "\u4F5A\u540D");
                showBubble2("\u5FF5\u8BD7\xB7" + d.title + "\uFF08" + author + "\uFF09\n" + body, 15e3);
                animRef.current?.talkFor(6e3);
                const speech = "\u5FF5\u9996\u8BD7\u2014\u2014" + d.title + "\uFF0C" + (d.dynasty ? d.dynasty + "\uFF0C" : "") + author + "\u3002" + body.replace(/\n/g, "\uFF0C");
                speakText(speech, { rate: "-15%" });
              } else showBubble2("\u8BD7\u518C\u6CA1\u8BFB\u5230");
            }).catch(() => showBubble2("\u8BD7\u518C\u6CA1\u8BFB\u5230"));
            return;
          }
          if (action === "culture-tale") {
            fetch("/api/chubby-whale/culture?type=minsu").then((r) => r.json()).then((d) => {
              if (d && d.ok && d.item) {
                showBubble2(String(d.item.text || "").slice(0, 120) + "\u2026", 9e3);
                animRef.current?.talkFor(5e3);
                speakText("\u8BB2\u4E2A\u6C11\u95F4\u6545\u4E8B\u2014\u2014" + String(d.item.title || "") + "\u3002" + String(d.item.text || "").slice(0, 6e3), { rate: "-15%" });
              } else showBubble2("\u6545\u4E8B\u6CA1\u8BB2\u6210");
            }).catch(() => showBubble2("\u6545\u4E8B\u6CA1\u8BB2\u6210"));
            return;
          }
          if (action === "culture-allusion") {
            fetch("/api/chubby-whale/culture?type=chengyu").then((r) => r.json()).then((d) => {
              if (d && d.ok && d.item) {
                showBubble2("\u300A" + d.item.title + "\u300B\uFF08" + (d.item.src || "") + "\uFF09" + String(d.item.text || "").slice(0, 100) + "\u2026", 9e3);
                animRef.current?.talkFor(5e3);
                speakText("\u8BB2\u4E2A\u5178\u6545\u2014\u2014" + String(d.item.title || "") + "\uFF0C\u51FA\u81EA" + String(d.item.src || "") + "\u3002" + String(d.item.text || ""), { rate: "-15%" });
              } else showBubble2("\u5178\u6545\u6CA1\u8BB2\u6210");
            }).catch(() => showBubble2("\u5178\u6545\u6CA1\u8BB2\u6210"));
            return;
          }
          if (action === "culture-idiom") {
            fetch("/api/chubby-whale/culture?type=idiom").then((r) => r.json()).then((d) => {
              if (d && d.ok && d.item) {
                showBubble2(d.item.title + "\uFF1A" + String(d.item.text || "").slice(0, 100), 8e3);
                const sp = String(d.item.title || "") + "\uFF1A" + String(d.item.text || "");
                speakText(sp, { rate: sp.length >= 80 ? "-15%" : "+0%" });
              } else showBubble2("\u6CA1\u67E5\u5230");
            }).catch(() => showBubble2("\u6CA1\u67E5\u5230"));
            return;
          }
          if (action === "culture-couplet") {
            showBubble2("\u5BF9\u8054\u5C0F\u9CB8\u8FD8\u5728\u6574\u7406\uFF0C\u56DE\u5934\u7ED9\u4F60\u51FA\u4E00\u5BF9\uFF5E");
            return;
          }
          if (action.startsWith("music:")) {
            const name = action.slice(6);
            fetch("/api/chubby-whale/melody?name=" + encodeURIComponent(name)).then((r) => r.json()).then((d) => {
              if (d && d.ok && d.song) {
                playMelody(d.song.notes, d.song.bpm);
                showBubble2("\u5F39\u300A" + d.song.name + "\u300B\u266A");
              } else showBubble2("\u8FD9\u9996\u66F2\u5B50\u6CA1\u627E\u5230");
            }).catch(() => showBubble2("\u5F39\u7434\u5931\u8D25"));
            return;
          }
          if (action === "briefing-now") {
            fetch("/api/chubby-whale/briefing").then((r) => r.json()).then((d) => {
              if (d && d.ok) {
                showBubble2(d.text, 12e3);
                animRef.current?.talkFor(6e3);
              } else showBubble2("\u7B80\u62A5\u6CA1\u505A\u51FA\u6765");
            }).catch(() => showBubble2("\u7B80\u62A5\u8FDE\u4E0D\u4E0A"));
            return;
          }
          if (action === "briefing") {
            showBubble2("\u7B80\u62A5\u662F\u5F00\u7740\u7684\uFF0C\u70B9\u300C\u73B0\u5728\u7B80\u62A5\u4E00\u6B21\u300D\u5C31\u80FD\u770B\uFF5E");
            return;
          }
          if (action === "chatmode" || action === "wake") {
            setChatOpen(true);
            startVoiceChat((t) => {
              setInput(t);
            });
            showBubble2("\u6211\u5728\u542C\uFF0C\u8BF4\u5B8C\u6309\u53D1\u9001\u5C31\u597D\uFF5E");
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
            showBubble2(nowOn ? "\u8BED\u97F3\u6717\u8BFB\uFF1A\u5F00" : "\u8BED\u97F3\u6717\u8BFB\uFF1A\u5173\uFF08\u7701\u7740\u70B9\u7528\uFF09");
            return;
          }
          if (action === "clear-memory") {
            try {
              if (!window.confirm("\u6E05\u9664\u80A5\u9CB8\u5BF9\u4E3B\u4EBA\u7684\u804A\u5929\u8BB0\u5FC6\uFF1F\uFF08\u6210\u957F/\u9C7C\u7CAE/\u8BF4\u4E66\u8BB0\u5F55\u4E0D\u53D7\u5F71\u54CD\uFF09")) return;
              fetch("/api/chubby-whale/clear-memory", { method: "POST" }).then((r) => r.json()).then((d) => {
                if (d && d.ok) {
                  setMessages([]);
                  showBubble2("\u8BB0\u5FC6\u6E05\u7A7A\u5566\uFF0C\u6211\u4EEC\u91CD\u65B0\u8BA4\u8BC6\u5427\uFF5E", 4e3);
                } else showBubble2("\u6E05\u9664\u5931\u8D25");
              }).catch(() => showBubble2("\u6E05\u9664\u5931\u8D25"));
            } catch (e) {
            }
            return;
          }
          if (action === "balance") {
            fetch("/api/chubby-whale/balance").then((r) => r.json()).then((d) => {
              if (d && d.ok && d.balance != null) showBubble2("\u4F59\u989D\uFF1A\xA5" + d.balance, 5e3);
              else showBubble2("\u4F59\u989D\u67E5\u4E0D\u5230");
            }).catch(() => showBubble2("\u4F59\u989D\u67E5\u4E0D\u5230"));
            return;
          }
          if (action === "chat-lang:zh" || action === "chat-lang:en") {
            const cl = action === "chat-lang:en" ? "en" : "zh";
            try {
              localStorage.setItem("chubby-chatlang", cl);
            } catch {
            }
            showBubble2(cl === "en" ? "\u804A\u5929\u8BED\u8A00\uFF1AEnglish" : "\u804A\u5929\u8BED\u8A00\uFF1A\u4E2D\u6587");
            return;
          }
          if (action === "briefing-recent") {
            showBubble2("\u6700\u8FD1\u7B80\u62A5\uFF1A\u8FD8\u6CA1\u5B58\u6863\uFF08\u7B80\u62A5\u4E0D\u4FDD\u5B58\u5386\u53F2\uFF09", 4e3);
            return;
          }
          if (action === "lang:zh" || action === "lang:en") {
            const l = action === "lang:en" ? "en" : "zh";
            try {
              localStorage.setItem("chubby-lang", l);
            } catch {
            }
            setLang(l);
            showBubble2(l === "en" ? "Language: English" : "\u754C\u9762\u8BED\u8A00\uFF1A\u4E2D\u6587");
            return;
          }
          if (action === "dsh") {
            try {
              const q = window.prompt("\u8981\u628A\u4EC0\u4E48\u95EE\u9898\u4EA4\u7ED9 DSH \u52A9\u624B\uFF1F\uFF08\u4F1A\u590D\u5236\u5230\u526A\u8D34\u677F\uFF09");
              if (!q) return;
              try {
                await(navigator).clipboard.writeText(q);
              } catch (e) {
              }
              showBubble2("\u5DF2\u590D\u5236\uFF1A\u300C" + String(q).slice(0, 40) + "\u300D\u2014 \u53BB DSH \u4F1A\u8BDD\u91CC\u7C98\u8D34\u5C31\u884C\uFF5E", 5e3);
            } catch (e) {
            }
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
                    showBubble2("\u56FE\u7247\u592A\u5927\uFF08\u8D85\u8FC7 4MB\uFF09", 4e3);
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
                  showBubble2("\u672C\u9CB8\u770B\u770B\u8FD9\u5F20\u56FE\u2026", 3e3);
                  setChatOpen(false);
                  const hdr = file.type || "image/jpeg";
                  const res = await fetch("/api/chubby-whale/chat", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ message: "", image: b64, imageMime: hdr }) });
                  const d = await res.json();
                  const reply = d && d.reply || "\u8FD9\u6761\u9C7C\u770B\u4E0D\u61C2\u8FD9\u5F20\u56FE\u2026\u2026";
                  showBubble2("\uFF08\u770B\u56FE\uFF09" + reply, 1e4);
                  speakText(reply);
                } catch (e) {
                  showBubble2("\u56FE\u7247\u5904\u7406\u5931\u8D25", 4e3);
                }
              };
              input2.click();
            } catch (e) {
              showBubble2("\u6253\u4E0D\u5F00\u6587\u4EF6\u9009\u62E9", 4e3);
            }
            return;
          }
          if (action === "dictate") {
            if (!dictateRef.current.on) {
              dictateRef.current.on = true;
              dictateRef.current.text = "";
              setDictateOn(true);
              setDictText("");
              startDictation((t) => {
                dictateRef.current.text += t;
                setDictText(dictateRef.current.text);
                showBubble2("\uFF08\u53E3\u8FF0\uFF09" + t, 2500);
              });
              showBubble2("\u53E3\u8FF0\u5F00\u59CB\uFF0C\u8BF4\u8BDD\u5C31\u4F1A\u8F6C\u6210\u6587\u5B57\uFF5E", 3e3);
            } else {
              dictateRef.current.on = false;
              setDictateOn(false);
              const body = dictateRef.current.text || "\uFF08\u8FD8\u6CA1\u5F55\u5230\u5185\u5BB9\uFF09";
              try {
                const blob = new Blob([body], { type: "text/plain;charset=utf-8" });
                const url = URL.createObjectURL(blob);
                const a = document.createElement("a");
                a.href = url;
                a.download = "\u53E3\u8FF0\u516C\u6587-" + (/* @__PURE__ */ new Date()).toISOString().slice(0, 19).replace(/[:T]/g, "-") + ".txt";
                document.body.appendChild(a);
                a.click();
                document.body.removeChild(a);
                URL.revokeObjectURL(url);
              } catch (e) {
              }
              showBubble2("\u53E3\u8FF0\u7ED3\u675F\uFF0C\u5DF2\u5BFC\u51FA txt\uFF08" + body.length + " \u5B57\uFF09", 4e3);
            }
            return;
          }
          if (action === "test-tts") {
            showBubble2("\u6D4B\u8BD5\u8BED\u97F3\uFF1A\u4E3B\u4EBA\u542C\u5F97\u5230\u5417\uFF1F", 4e3);
            speakText("\u6D4B\u8BD5\u8BED\u97F3\uFF0C\u4E3B\u4EBA\u542C\u5F97\u5230\u5417\uFF1F");
            return;
          }
          if (action.startsWith("voice:")) {
            const v = action.slice(6);
            try {
              localStorage.setItem("chubby-tts-voice", v);
            } catch {
            }
            showBubble2("\u97F3\u8272\u6362\u597D\u5566\uFF1A" + v.split("-")[2]);
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
                showBubble2("\u8FD9\u4E2A\u65F6\u95F4\u672C\u9C7C\u6CA1\u542C\u61C2\u2026\u2026\u8BD5\u8BD5\u300C9\u70B9\u300D\u300C\u660E\u59299\u70B9\u300D\u300C\u534A\u5C0F\u65F6\u540E\u300D", 5e3);
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
                showBubble2("\u597D\uFF0C" + whenText + " \u63D0\u9192\u4F60\uFF1A" + text, 6e3);
              } else showBubble2("\u63D0\u9192\u6CA1\u52A0\u4E0A");
            }).catch(() => showBubble2("\u63D0\u9192\u6CA1\u52A0\u4E0A"));
            return;
          }
          if (action === "remind-list") {
            fetch("/api/chubby-whale/reminders").then((r) => r.json()).then((d) => {
              const arr = d && d.reminders || [];
              if (!arr.length) {
                showBubble2("\u8FD8\u6CA1\u6709\u63D0\u9192\uFF5E");
                return;
              }
              const txt = arr.map((x) => {
                const when = new Date(x.nextAt || x.at);
                const stamp = isNaN(when.getTime()) ? String(x.at) : when.toLocaleString("zh-CN");
                const rep = Number(x.repeat) > 0 ? "\uFF08\u6BCF\u5929\uFF09" : "";
                return "\xB7 " + x.text + "\uFF08" + stamp + "\uFF09" + rep;
              }).join("\n");
              showBubble2(txt, 8e3);
            }).catch(() => showBubble2("\u63D0\u9192\u6E05\u5355\u67E5\u4E0D\u5230"));
            return;
          }
          showBubble2("\u8FD9\u4E2A\u529F\u80FD\u5C0F\u9CB8\u8FD8\u5728\u5B66\uFF0C\u7A0D\u540E\u52A0\u4E0A\uFF5E");
        }
        function scrollBody() {
          setTimeout(() => {
            const el = bodyRef.current;
            if (el) el.scrollTop = el.scrollHeight;
          }, 0);
        }
        async function sendText(rawText) {
          const text = String(rawText || "").trim();
          if (!text || busy) return;
          if (/乖|可爱|好鱼|棒|喜欢你|真聪明/.test(text)) animRef.current?.pushHeart();
          if (/闭嘴|烦|滚|讨厌|笨蛋|丑/.test(text)) showBubble2("\u54FC\u2026\u672C\u9CB8\u751F\u6C14\u4E86");
          if (/胖|肥猪|肥嘟嘟/.test(text)) {
            showBubble2("\u4EBA\u5BB6\u4E0D\u80D6\uFF01\u662F\u9CB8\u9C7C\u5929\u751F\u5706\uFF01");
            const s0 = Math.min(1.4, scale + 0.12);
            setScale(s0);
            setTimeout(function() {
              setScale(Math.max(0.7, s0 - 0.12));
            }, 600);
          }
          if (/胖|肥猪|肥嘟嘟/.test(text)) {
            showBubble2("\u4EBA\u5BB6\u4E0D\u80D6\uFF01\u662F\u9CB8\u9C7C\u5929\u751F\u5706\uFF01");
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
            const res = await fetch("/api/chubby-whale/chat", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ message: text, lang: (() => {
                try {
                  return localStorage.getItem("chubby-chatlang") || "auto";
                } catch (e) {
                  return "auto";
                }
              })() })
            });
            data = await res.json();
            const reply = data?.reply || "\u4E3B\u4EBA\u2026\u2026\u672C\u9CB8\u8D70\u795E\u4E86\u3002";
            setMessages((m) => [...m, { who: "fish", text: reply }]);
            if (voiceModeRef.current) {
              showBubble2("\uFF08\u8BF4\uFF09" + reply, 8e3);
            }
            if (data && data.upgraded) showBubble2("\u672C\u9CB8\u53C8\u957F\u5927\u4E00\u70B9\u5566\uFF01", 4e3);
          } catch {
            setMessages((m) => [...m, { who: "fish", text: "\u4E3B\u4EBA\uFF0C\u672C\u9CB8\u8FDE\u4E0D\u4E0A\u670D\u52A1\u5668\u2026\u2026" }]);
          } finally {
            setBusy(false);
            animRef.current?.talkFor(1500);
            try {
              if (data && data.reply) speakText(data.reply);
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
          let voicedMs = 0;
          let silenceMs = 0;
          let peak = 0;
          let chunkStartedAt = 0;
          let lastTickAt = 0;
          let watchTimer = null;
          let startTimer = null;
          const SILENCE_GATE = 8;
          const SILENCE_LIMIT = 700;
          const VOICE_LIMIT = 6e3;
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
            try {
              if (stopped) return;
              const blob = new Blob(chunks, { type: "audio/webm" });
              chunks = [];
              if (blob.size < 2500) return;
              const b64 = await blobToBase64(blob);
              if (!b64) return;
              const r = await fetch("/api/chubby-whale/asr", {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ audio: b64, format: "webm" })
              });
              const d = await r.json();
              if (d && d.ok && d.text && d.text.trim().length >= 2) {
                if (ttsPlaying) return;
                let t = String(d.text).trim();
                if (t === lastHeardText && Date.now() - lastHeardAt < 2e4) return;
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
                    showBubble2("\u6211\u5728\uFF5E\u4E3B\u4EBA\u8BF4\uFF5E", 3e3);
                    return;
                  }
                } else {
                  const wokeRecent = Date.now() - wokeRef.current.at < 3e4;
                  if (!wokeRecent) return;
                }
                voiceModeRef.current = true;
                setChatOpen(false);
                showBubble2("\uFF08\u542C\u5230\uFF09" + t, 3e3);
                sendText(t);
              }
            } catch (e) {
            } finally {
              if (!stopped) scheduleStart(350);
            }
          }
          function watch() {
            try {
              if (stopped || !analyser) return;
              const buf = new Uint8Array(analyser.fftSize);
              analyser.getByteFrequencyData(buf);
              let sum = 0;
              for (let i = 0; i < buf.length; i++) sum += buf[i];
              const avg = sum / buf.length;
              if (avg > peak) peak = avg;
              const now = performance.now();
              const dt = Math.min(250, Math.max(0, now - lastTickAt));
              lastTickAt = now;
              if (avg > SILENCE_GATE) {
                voicedMs += dt;
                silenceMs = 0;
              } else {
                silenceMs += dt;
              }
              const elapsed = now - chunkStartedAt;
              const done = voicedMs > 200 && silenceMs >= SILENCE_LIMIT || elapsed >= VOICE_LIMIT + 2e3 || peak > 90 && silenceMs >= 400;
              if (done && mr.state === "recording") {
                try {
                  mr.stop();
                } catch {
                }
                setTimeout(uploadChunk, 100);
                return;
              }
              if (!stopped) scheduleWatch(100);
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
              voicedMs = 0;
              silenceMs = 0;
              peak = 0;
              chunkStartedAt = performance.now();
              lastTickAt = chunkStartedAt;
              mr.start();
              scheduleWatch(100);
            } catch (e) {
              scheduleStart(1e3);
            }
          }
          async function boot() {
            try {
              stream = await navigator.mediaDevices.getUserMedia({ audio: true });
              actx = new window.AudioContext();
              const src = actx.createMediaStreamSource(stream);
              analyser = actx.createAnalyser();
              analyser.fftSize = 512;
              src.connect(analyser);
              mr = new window.MediaRecorder(stream);
              mr.ondataavailable = (e) => {
                if (e && e.data && e.data.size > 0) chunks.push(e.data);
              };
              mr.onstop = () => {
              };
              showBubble2("\u672C\u9CB8\u5728\u542C\uFF08\u5343\u95EE\u8BC6\u522B\uFF09\uFF0C\u8BF4\u5B8C\u5C31\u4F1A\u63A5\u8BDD\uFF5E", 3e3);
              startChunk();
            } catch (e) {
              showBubble2("\u9EA6\u514B\u98CE\u6253\u4E0D\u5F00\uFF1A\u70B9\u5730\u5740\u680F\u5C0F\u9501\u5141\u8BB8\u9EA6\u514B\u98CE", 6e3);
            }
          }
          function onFirstGesture() {
            if (started) return;
            started = true;
            try {
              document.removeEventListener("pointerdown", onFirstGesture);
              document.removeEventListener("keydown", onFirstGesture);
            } catch {
            }
            boot();
          }
          try {
            document.addEventListener("pointerdown", onFirstGesture)(document).addEventListener("keydown", onFirstGesture);
          } catch {
          }
          return () => {
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
              if (mr && mr.state === "recording") mr.stop();
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
                onFileDrop(e);
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
            { style: menuStyle(menu) },
            h(
              "div",
              { style: { padding: "8px 14px", borderBottom: "1px solid #1f4a85", color: "#9FD8FF", fontSize: 12, display: "flex", justifyContent: "space-between" } },
              h("span", null, (lang === "en" ? "Fat Whale \xB7 v" : "\u80A5\u9CB8 \xB7 v") + VERSION),
              h("span", { style: { color: "#FFD166" } }, balanceText)
            ),
            renderItems(buildMenu(VERSION, { voiceOn, balance: balanceLabel, growth: growthLabel }))
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
        inject: ["slots"],
        apply(ctx) {
          ctx.slots.inject("shell.overlay", () => ctx.slots.register({
            name: "shell.overlay",
            id: "chubby-whale",
            order: 100
          }, WhaleOverlay));
        }
      };
    }
  });
})();
