/**
 * host/feedback/send.ts —— 意见反馈投递（后台发送，客户端看不到收件邮箱）
 *
 * 隐私要求：收件邮箱只存在 host 侧配置里，接口与前端都不暴露它。
 *
 * 两层投递：
 *   1) **先落盘**：无论能不能发信，反馈都先写进 `runtimeDir/feedback/`，绝不丢；
 *   2) **有凭据才发信**：配置里给了 SMTP（host/port/user/pass/to）就用 node:tls 手写 SMTP 发送，
 *      零第三方依赖；没给就只落盘，接口如实回 `sent:false`（不谎报「已发送」）。
 *
 * 为什么手写 SMTP 而不装 nodemailer：插件红线是「不依赖第三方」，node 内置 tls 足够完成
 * EHLO/AUTH LOGIN/MAIL FROM/RCPT TO/DATA/QUIT 这一套最小对话。
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { connect } from 'node:tls';
/** 把一条反馈落盘（失败时不抛错，返回空串） */
function saveLocal(runtimeDir, text, at) {
    try {
        const dir = join(runtimeDir, 'feedback');
        mkdirSync(dir, { recursive: true });
        const stamp = new Date(at).toISOString().replace(/[:.]/g, '-');
        const file = join(dir, 'feedback-' + stamp + '.json');
        writeFileSync(file, JSON.stringify({ at, text }, null, 2), 'utf8');
        return file;
    }
    catch (e) {
        return '';
    }
}
/** 邮件正文（头 + base64 正文，行首点转义交给 "." 单独一行处理） */
function mailPayload(cfg, text) {
    const subject = '=?UTF-8?B?' + Buffer.from('肥鲸反馈 ' + new Date().toISOString(), 'utf8').toString('base64') + '?=';
    const body = Buffer.from(text, 'utf8').toString('base64').replace(/(.{76})/g, '$1\r\n');
    return [
        'From: ' + cfg.user,
        'To: ' + cfg.to,
        'Subject: ' + subject,
        'MIME-Version: 1.0',
        'Content-Type: text/plain; charset=utf-8',
        'Content-Transfer-Encoding: base64',
        '',
        body,
    ].join('\r\n');
}
/**
 * 最小 SMTP 客户端（TLS 直连，如 foxmail 的 465）：
 * 220 → EHLO → 250 → AUTH LOGIN → 334 → user → 334 → pass → 235
 * → MAIL FROM → 250 → RCPT TO → 250 → DATA → 354 → 正文 → 250 → QUIT
 * 任何 4xx/5xx 或超时都 reject，由调用方折算成「只落盘」。
 */
function smtpSend(cfg, text) {
    return new Promise((resolve, reject) => {
        const sock = connect({ host: cfg.host, port: cfg.port, servername: cfg.host });
        let buf = '';
        let step = 0;
        let finished = false;
        const fin = (err) => {
            if (finished)
                return;
            finished = true;
            try {
                sock.destroy();
            }
            catch (e) { }
            if (err)
                reject(err);
            else
                resolve();
        };
        const write = (s) => { try {
            sock.write(s + '\r\n');
        }
        catch (e) {
            fin(e);
        } };
        const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');
        const onLine = (line) => {
            const code = parseInt(line.slice(0, 3), 10);
            if (!Number.isFinite(code))
                return;
            if (code >= 400) {
                fin(new Error('SMTP ' + code));
                return;
            }
            switch (step) {
                case 0: // 服务器欢迎
                    if (code === 220) {
                        write('EHLO chubby-whale');
                        step = 1;
                    }
                    break;
                case 1:
                    if (code === 250) {
                        write('AUTH LOGIN');
                        step = 2;
                    }
                    break;
                case 2:
                    if (code === 334) {
                        write(b64(cfg.user));
                        step = 3;
                    }
                    break;
                case 3:
                    if (code === 334) {
                        write(b64(cfg.pass));
                        step = 4;
                    }
                    break;
                case 4:
                    if (code === 235) {
                        write('MAIL FROM:<' + cfg.user + '>');
                        step = 5;
                    }
                    break;
                case 5:
                    if (code === 250) {
                        write('RCPT TO:<' + cfg.to + '>');
                        step = 6;
                    }
                    break;
                case 6:
                    if (code === 250) {
                        write('DATA');
                        step = 7;
                    }
                    break;
                case 7:
                    if (code === 354) {
                        write(mailPayload(cfg, text));
                        write('.');
                        step = 8;
                    }
                    break;
                case 8:
                    if (code === 250) {
                        write('QUIT');
                        step = 9;
                    }
                    break;
                case 9:
                    fin();
                    break;
            }
        };
        sock.setTimeout(20000, () => fin(new Error('SMTP 超时')));
        sock.on('error', (err) => fin(err));
        sock.on('data', (chunk) => {
            buf += chunk.toString('utf8');
            // 多行响应：以 "250-" 续行，最后一行是 "250 "（空格）
            for (;;) {
                const idx = buf.indexOf('\r\n');
                if (idx < 0)
                    break;
                const line = buf.slice(0, idx);
                buf = buf.slice(idx + 2);
                if (line.length > 3 && line.charAt(3) === '-')
                    continue;
                onLine(line);
            }
        });
    });
}
/**
 * 投递一条反馈：先落盘，配置了 SMTP 才发信。
 * 绝不抛错：任何异常都折算成 `{ ok:false, sent:false, error }`。
 */
export async function deliverFeedback(opts) {
    const text = String(opts.text || '');
    const at = Number(opts.at) || Date.now();
    saveLocal(opts.runtimeDir, text, at);
    const cfg = opts.smtp;
    if (!cfg || !cfg.host || !cfg.user || !cfg.pass || !cfg.to) {
        return { ok: true, sent: false };
    }
    try {
        await smtpSend(cfg, text);
        return { ok: true, sent: 'smtp' };
    }
    catch (e) {
        return { ok: false, sent: false, error: String((e && e.message) || e).slice(0, 120) };
    }
}
