/**
 * shared/sentence-boundary.ts —— 动态断句阈值 + 分段标点纠偏（纯函数，client 共用）
 *
 * 背景（2026-11-14 主人反馈）：
 *   ① 一句一落切片太快：固定 450ms 静音就收尾，短句（"等一下"、"你好"这类）经常被
 *      掐掉尾音或还没说完就被切走；
 *   ② 每个切片几乎都以句号结束：录音窗口/自适应端点强行切出来的半句，ASR 照样在末尾
 *      补「。」，代笔正文于是全是断句，读起来不像一段话。
 *
 * 本模块只回答两个问题（零依赖、纯函数、不碰 DOM/网络/存储/定时器）：
 *   · requiredQuietMs(speechMs)：这段语音收尾前至少要等多久静音？
 *       短语音（≤800ms）等满 900ms 再收 —— 短句容易被尾音/拖腔误判成说完；
 *       长语音（≥4000ms）600ms 就够 —— 长句再等只会让整段"落地"变慢；
 *       中间线性插值（800→4000ms 对应 900→600ms）。
 *   · normalizeSegment(text, meta)：这句到底算不算"说完"？
 *       meta 是录音收尾快照（voice.ts 的 snap.quietMs/speechMs/winMs）。判据：
 *         pauseMs（收尾时累计的尾部静音）< requiredQuietMs(speechMs) → 没等够，是半句，
 *         把结尾的「。/.」改成「，」（没有句末标点就补「，」）；
 *         等够了 / 强句末（！？!?）/ 已经是续句标点（，、；：,;:）→ 完整句，原样保留。
 *
 * 为什么"不改写其它内容"：代笔是用户可编辑的正文，任何多余美化都可能破坏主人手改的
 * 标点与措辞；这里只允许动**最后一个字符**或在其后追加一个「，」。
 *
 * meta 缺失（旧调用方 / 非语音来源）时保持旧行为：不改标点。
 */
/** 短语音边界：说话时长 ≤ 此值 → 要求最长静音（900ms） */
const SHORT_SPEECH_MS = 800;
/** 长语音边界：说话时长 ≥ 此值 → 要求最短静音（450ms） */
const LONG_SPEECH_MS = 4000;
/** 静音阈值上限（短语音；越保守越不容易把半句切出去） */
const QUIET_MAX_MS = 900;
/** 静音阈值下限（长语音；越灵敏整段落地越快） */
const QUIET_MIN_MS = 600;
/** 续句标点：文本已经以这些结尾 → 本来就是一个"还没说完"的片段，不再动 */
const CONTINUE_ENDS = '，、；：,;:';
/** 强句末标点：感叹/问句自带完整语气，视为完整句 */
const STRONG_ENDS = '！？!?';
/** 可被降级成逗号的句号（中英各一） */
const PERIOD_ENDS = '。.';
/**
 * 这段语音收尾前需要等多少毫秒静音（动态 450~750ms，见文件头取舍）。
 * 非数字/负数按 0 处理（=短语音，取最保守的 750ms）：宁可多等，也别把半句切出去。
 */
export function requiredQuietMs(speechMs) {
    const ms = Number(speechMs);
    const s = Number.isFinite(ms) && ms > 0 ? ms : 0;
    if (s <= SHORT_SPEECH_MS)
        return QUIET_MAX_MS;
    if (s >= LONG_SPEECH_MS)
        return QUIET_MIN_MS;
    const ratio = (s - SHORT_SPEECH_MS) / (LONG_SPEECH_MS - SHORT_SPEECH_MS);
    return Math.round(QUIET_MAX_MS - (QUIET_MAX_MS - QUIET_MIN_MS) * ratio);
}
/**
 * 把一段 ASR 文本按「是否真的说完」纠偏标点（规则见文件头）。
 *
 * 只做三种动作：原样返回 / 把最后一个句号换成逗号 / 末尾补一个逗号。
 * 正文中间的任何字符、标点、空白都不动。
 */
export function normalizeSegment(text, _meta) {
    const raw = String(text == null ? '' : text);
    if (!raw)
        return raw;
    // 允许标点后面跟右引号/右括号：他说：“好。” → 他把“好，”留住，而不是在引号外乱补逗号。
    const tail = /([”’"'）)]*)$/.exec(raw);
    const closers = tail ? tail[1] : '';
    const core = closers ? raw.slice(0, raw.length - closers.length) : raw;
    if (!core)
        return raw;
    const last = core.charAt(core.length - 1);
    // 已经是续句标点：保留，不重复补。
    if (CONTINUE_ENDS.indexOf(last) >= 0)
        return raw;
    // 句号/问号/感叹号/英文句点 → 统一改成中文逗号（标点在右引号/右括号内侧）。
    if (PERIOD_ENDS.indexOf(last) >= 0 || STRONG_ENDS.indexOf(last) >= 0) {
        return core.slice(0, -1) + '，' + closers;
    }
    // 没有任何句末标点 → 在右引号/右括号外补一个逗号。
    return raw + '，';
}
