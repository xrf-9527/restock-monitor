/**
 * 类型定义
 */

/**
 * 监控目标配置
 */
export interface Target {
    name: string;
    urls: string[];
    mustContainAny: string[];
    outOfStockRegex: RegExp[];
}

/**
 * 探测结果
 */
export interface ProbeResult {
    ok: boolean;
    status: 'OUT' | 'IN' | 'ERROR';
    usedUrl: string | null;
    reason: string;
}

/**
 * 单个目标的状态
 */
export interface TargetState {
    status: 'OUT' | 'IN';
    inSinceTs: number;
    inStreak: number;
    errStreak: number;
    lastErrNotifyTs: number;
    lastInNotifyAttemptTs: number;
    lastInNotifyOkTs: number;
    lastUsedUrl: string | null;
    lastReason: string;
    ts: number;
}

/**
 * 全局状态（存储在 KV 中）
 */
export type State = Partial<Record<string, TargetState>>;

/**
 * 环境变量接口
 */
export interface Env {
    // KV 绑定
    STOCK_STATE: KVNamespace;

    // 可选：保护 HTTP 端点（Authorization: Bearer <token>）
    ADMIN_TOKEN?: string;

    // 配置参数
    TIMEOUT_SEC: string;
    CONFIRM_DELAY_MS: string;
    IN_CONFIRMATIONS_REQUIRED: string;
    ERROR_STREAK_NOTIFY_THRESHOLD: string;
    ERROR_NOTIFY_COOLDOWN_SEC: string;
    ALERT_PREFIX: string;

    // Telegram
    TG_BOT_TOKEN?: string;
    TG_CHAT_ID?: string;

    // 飞书
    FEISHU_WEBHOOK_URL?: string;
    FEISHU_SECRET?: string;

    // 钉钉
    DINGTALK_WEBHOOK_URL?: string;
    DINGTALK_SECRET?: string;
}
