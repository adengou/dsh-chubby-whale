/**
 * shared/deepseek.ts —— DeepSeek 对话接口地址（host 与 mobile 共用）
 *
 * 为什么单独放共享层：host/chat-core.ts 与 mobile/core/deepseek.ts 都要用它，
 * 而 mobile 不允许深路径导入 host（scripts/check-boundaries.mjs 的 B2 规则）。
 */
export const DEEPSEEK_CHAT_URL = 'https://api.deepseek.com/chat/completions';
