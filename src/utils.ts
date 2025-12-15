/**
 * 工具函数模块
 * 提供通用的辅助函数和默认配置
 */

/**
 * 默认配置值
 */
export const DEFAULTS = {
    TIMEOUT_SEC: 15,
    CONFIRM_DELAY_MS: 2000,
    IN_CONFIRMATIONS_REQUIRED: 1,
    ERROR_STREAK_NOTIFY_THRESHOLD: 5,
    ERROR_NOTIFY_COOLDOWN_SEC: 1800,
} as const;

/**
 * 解析环境变量为整数
 */
export function envInt(value: string | undefined, fallback: number): number {
    const parsed = Number.parseInt(value ?? '', 10);
    return Number.isFinite(parsed) ? parsed : fallback;
}

/**
 * 限制数值在指定范围内
 */
export function clampInt(value: number, min: number, max: number): number {
    return Math.min(Math.max(value, min), max);
}

/**
 * 解析环境变量为字符串（去除空白）
 */
export function envString(value: string | undefined): string | undefined {
    const trimmed = (value ?? '').trim();
    return trimmed ? trimmed : undefined;
}

/**
 * 格式化为北京时间字符串（带时区标识）
 * @returns 格式：YYYY-MM-DD HH:mm:ss Beijing (UTC+8)
 */
export function formatBeijingTime(date: Date = new Date()): string {
    const timeStr = date.toLocaleString('zh-CN', {
        timeZone: 'Asia/Shanghai',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false
    }).replace(/\//g, '-');
    return `${timeStr} Beijing (UTC+8)`;
}
