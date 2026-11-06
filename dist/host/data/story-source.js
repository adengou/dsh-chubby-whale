/** 书名上限：与路由层一致（最长书名 4 字，64 已留余量） */
const MAX_BOOK_LEN = 64;
/** 书单条数上限：正常 17 本；云端清单被写坏时也不至于让播放器空转上万次 */
const MAX_BOOKS = 200;
/** 书名里不允许出现：路径分隔符、控制字符、上跳片段（`..`） */
const BAD_BOOK_RE = /[\\/\u0000-\u001F\u007F]|\.\./;
/** 清洗单个书名；不可用返回空串 */
function cleanBookName(raw) {
    const name = String(raw == null ? '' : raw).trim();
    if (!name || name.length > MAX_BOOK_LEN)
        return '';
    if (BAD_BOOK_RE.test(name))
        return '';
    return name;
}
/** 日志里的外部输入：截断 + 去掉换行，别让一次坏请求写出几千字的日志行或伪造日志 */
function logSafe(raw) {
    return String(raw == null ? '' : raw).slice(0, 80).replace(/[\r\n]/g, ' ');
}
export function createStorySource(port) {
    return {
        listBooks: async () => {
            let books;
            try {
                books = await port.readStoryIndex();
            }
            catch (err) {
                console.error('STORY-INDEX-FAIL err=' + String(err?.message || err));
                return [];
            }
            const out = [];
            const seen = new Set();
            for (const b of Array.isArray(books) ? books : []) {
                const name = cleanBookName(b && b.book);
                if (!name || seen.has(name))
                    continue;
                seen.add(name);
                out.push(name);
                if (out.length >= MAX_BOOKS)
                    break;
            }
            return out;
        },
        loadBook: async (book) => {
            const name = cleanBookName(book);
            if (!name) {
                // 走到这里说明上游传了非法书名（正常路径由 listBooks 拦截）；留痕但不修，交给上层跳过
                console.error('STORY-LOAD-FAIL book=' + logSafe(book) + ' err=bad book name');
                return [];
            }
            try {
                const chunks = await port.readStoryBook(name);
                // DataPort 承诺返回数组，但假实现/未来实现可能违约：非数组按空书处理，别让 player 的 .length 崩
                if (!Array.isArray(chunks))
                    return [];
                // 段内 book 统一投影成「书单书名」（= 本次请求的 name）。
                // 三言二拍这类合辑的数据里，段内 book 是子书名（喻世明言/醒世恒言/初刻拍案惊奇…）；
                // player 把这个字段放进响应的 book，客户端据此记「当前书」并发 /story/reset?book=<book>，
                // 子书名不在书单里 → reset 只能回 unknown book，「从头讲这本书」失效。
                // 书单名（文件名 / 云端 index 的 book）才是可点播、可重置、能拼进 join() 的键；
                // 段内 book 只是内容分组，不该作为播放器对外的书名。只在不同时复制，正常书零开销。
                return chunks.map((c) => (c && typeof c === 'object' && String(c.book || '') !== name ? { ...c, book: name } : c));
            }
            catch (err) {
                console.error('STORY-LOAD-FAIL book=' + name + ' err=' + String(err?.message || err));
                return [];
            }
        },
    };
}
