/**
 * 通知器模块
 * 支持 Telegram、飞书、钉钉
 */

import type { Env } from './types';

function envInt(value: string | undefined, fallback: number): number {
    const parsed = Number.parseInt(value ?? '', 10);
    return Number.isFinite(parsed) ? parsed : fallback;
}

function clampInt(value: number, min: number, max: number): number {
    return Math.min(Math.max(value, min), max);
}

function defaultTimeoutMs(env: Env): number {
    const timeoutSec = clampInt(envInt(env.TIMEOUT_SEC, 15), 1, 120);
    return timeoutSec * 1000;
}

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
    try {
        return await fetch(url, { ...init, signal: controller.signal });
    } finally {
        clearTimeout(timeoutId);
    }
}

async function throwIfNotOk(response: Response, serviceName: string): Promise<void> {
    if (response.ok) return;
    let detail = '';
    try {
        const text = await response.text();
        detail = text ? ` - ${text.slice(0, 500)}` : '';
    } catch {
        // ignore
    }
    throw new Error(`${serviceName} API error: ${response.status}${detail}`);
}

/**
 * 通知器接口
 */
export interface Notifier {
    send(title: string, text: string): Promise<void>;
}

export interface NotifyResult {
    attempted: number;
    sent: number;
    failed: number;
    errors: string[];
}

/**
 * Telegram 通知器
 */
export class TelegramNotifier implements Notifier {
    constructor(
        private token: string,
        private chatId: string,
        private timeoutMs: number
    ) { }

    async send(title: string, text: string): Promise<void> {
        const url = `https://api.telegram.org/bot${this.token}/sendMessage`;
        const response = await fetchWithTimeout(
            url,
            {
                method: 'POST',
                headers: { 'Content-Type': 'application/json; charset=utf-8' },
                body: JSON.stringify({
                    chat_id: this.chatId,
                    text: `${title}\n${text}`,
                }),
            },
            this.timeoutMs
        );

        await throwIfNotOk(response, 'Telegram');
    }
}

/**
 * 生成飞书签名
 * 按官方说明：
 * - string_to_sign = `${timestamp}\n${secret}`
 * - sign = Base64( HMAC_SHA256(key=secret, msg=string_to_sign) )
 */
async function genFeishuSign(timestampSec: number, secret: string): Promise<string> {
    const stringToSign = `${timestampSec}\n${secret}`;
    const encoder = new TextEncoder();

    const key = await crypto.subtle.importKey(
        'raw',
        encoder.encode(secret),
        { name: 'HMAC', hash: 'SHA-256' },
        false,
        ['sign']
    );

    const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(stringToSign));
    return btoa(String.fromCharCode(...new Uint8Array(signature)));
}

/**
 * 飞书通知器
 */
export class FeishuNotifier implements Notifier {
    constructor(
        private webhookUrl: string,
        private secret?: string,
        private alertPrefix?: string,
        private timeoutMs: number = 15_000
    ) { }

    async send(title: string, text: string): Promise<void> {
        let content = `${title}\n${text}`;
        if (this.alertPrefix) {
            content = `${this.alertPrefix} ${content}`;
        }

        const body: Record<string, unknown> = {
            msg_type: 'text',
            content: { text: content },
        };

        if (this.secret) {
            const ts = Math.floor(Date.now() / 1000);
            body.timestamp = String(ts);
            body.sign = await genFeishuSign(ts, this.secret);
        }

        const response = await fetchWithTimeout(
            this.webhookUrl,
            {
                method: 'POST',
                headers: { 'Content-Type': 'application/json; charset=utf-8' },
                body: JSON.stringify(body),
            },
            this.timeoutMs
        );

        await throwIfNotOk(response, 'Feishu');
    }
}

/**
 * 生成钉钉签名 URL
 * 按官方说明：
 * - timestamp：毫秒
 * - string_to_sign = `${timestamp}\n${secret}`
 * - sign = urlEncode( Base64( HMAC_SHA256(key=secret, msg=string_to_sign) ) )
 */
async function genDingTalkSignedUrl(webhookUrl: string, secret: string): Promise<string> {
    const timestampMs = Date.now();
    const stringToSign = `${timestampMs}\n${secret}`;
    const encoder = new TextEncoder();

    const key = await crypto.subtle.importKey(
        'raw',
        encoder.encode(secret),
        { name: 'HMAC', hash: 'SHA-256' },
        false,
        ['sign']
    );

    const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(stringToSign));
    const sign = encodeURIComponent(btoa(String.fromCharCode(...new Uint8Array(signature))));

    const url = new URL(webhookUrl);
    url.searchParams.set('timestamp', String(timestampMs));
    url.searchParams.set('sign', sign);

    return url.toString();
}

/**
 * 钉钉通知器
 */
export class DingTalkNotifier implements Notifier {
    constructor(
        private webhookUrl: string,
        private secret?: string,
        private alertPrefix?: string,
        private timeoutMs: number = 15_000
    ) { }

    async send(title: string, text: string): Promise<void> {
        let content = `${title}\n${text}`;
        if (this.alertPrefix) {
            content = `${this.alertPrefix} ${content}`;
        }

        let url = this.webhookUrl;
        if (this.secret) {
            url = await genDingTalkSignedUrl(this.webhookUrl, this.secret);
        }

        const body = {
            msgtype: 'text',
            text: { content },
        };

        const response = await fetchWithTimeout(
            url,
            {
                method: 'POST',
                headers: { 'Content-Type': 'application/json; charset=utf-8' },
                body: JSON.stringify(body),
            },
            this.timeoutMs
        );

        await throwIfNotOk(response, 'DingTalk');
    }
}

/**
 * 根据环境变量构建通知器列表
 */
export function buildNotifiers(env: Env): Notifier[] {
    const notifiers: Notifier[] = [];
    const timeoutMs = defaultTimeoutMs(env);

    // Telegram
    if (env.TG_BOT_TOKEN && env.TG_CHAT_ID) {
        notifiers.push(new TelegramNotifier(env.TG_BOT_TOKEN, env.TG_CHAT_ID, timeoutMs));
    }

    // 飞书
    if (env.FEISHU_WEBHOOK_URL) {
        notifiers.push(
            new FeishuNotifier(env.FEISHU_WEBHOOK_URL, env.FEISHU_SECRET, env.ALERT_PREFIX, timeoutMs)
        );
    }

    // 钉钉
    if (env.DINGTALK_WEBHOOK_URL) {
        notifiers.push(
            new DingTalkNotifier(env.DINGTALK_WEBHOOK_URL, env.DINGTALK_SECRET, env.ALERT_PREFIX, timeoutMs)
        );
    }

    return notifiers;
}

/**
 * 向所有通知器发送消息
 */
export async function notifyAll(
    notifiers: Notifier[],
    title: string,
    text: string
): Promise<NotifyResult> {
    if (notifiers.length === 0) {
        return { attempted: 0, sent: 0, failed: 0, errors: [] };
    }

    const settled = await Promise.allSettled(notifiers.map((n) => n.send(title, text)));

    let sent = 0;
    const errors: string[] = [];

    settled.forEach((r, i) => {
        if (r.status === 'fulfilled') {
            sent += 1;
            return;
        }
        const notifierName = notifiers[i]?.constructor?.name ?? `Notifier#${i}`;
        const detail = r.reason instanceof Error ? r.reason.message : String(r.reason);
        errors.push(`${notifierName}: ${detail}`);
    });

    if (errors.length > 0) console.error('Notify errors:', errors.join(', '));

    return { attempted: notifiers.length, sent, failed: errors.length, errors };
}
