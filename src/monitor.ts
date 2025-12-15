/**
 * 监控逻辑模块
 * 负责抓取页面、判断库存状态、管理状态
 */

import type { Env, Target, ProbeResult, State, TargetState } from './types';
import { buildNotifiers, notifyAll } from './notifiers';
import { envInt, clampInt, envString, formatBeijingTime, DEFAULTS } from './utils';

// 重新导出 formatBeijingTime 以保持向后兼容
export { formatBeijingTime } from './utils';

/**
 * 监控目标配置（两款套餐）
 */
export const TARGETS: Target[] = [
    {
        name: 'BandwagonHost MegaBox Pro (pid=157)',
        urls: [
            'https://bwh81.net/cart.php?a=add&pid=157',
            'https://bandwagonhost.com/cart.php?a=add&pid=157',
        ],
        mustContainAny: ['Shopping Cart', 'Bandwagon Host'],
        outOfStockRegex: [
            /\bOut of Stock\b/i,
            /We are currently out of stock on this plan\./i,
        ],
    },
    {
        name: 'DMIT LAX.Pro.MALIBU (pid=186)',
        urls: ['https://www.dmit.io/cart.php?a=add&pid=186'],
        mustContainAny: ['DMIT, Inc.', 'Client Area', 'Shopping Cart'],
        outOfStockRegex: [
            /\bOut of Stock\b/i,
            /We are currently out of stock on this item/i,
        ],
    },
];

/**
 * 默认浏览器请求头（Chrome on Windows）
 */
const DEFAULT_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const DEFAULT_CHROME_MAJOR_VERSION = '131';
const DEFAULT_SEC_CH_UA = `"Google Chrome";v="${DEFAULT_CHROME_MAJOR_VERSION}", "Chromium";v="${DEFAULT_CHROME_MAJOR_VERSION}", "Not_A Brand";v="24"`;
const DEFAULT_SEC_CH_UA_PLATFORM = '"Windows"';

function extractChromeMajorVersion(userAgent: string): string | null {
    const match = userAgent.match(/\bChrome\/(\d+)\b/i);
    return match ? match[1] : null;
}

function isMobileUserAgent(userAgent: string): boolean {
    return /\bMobile\b/i.test(userAgent) || /\bAndroid\b/i.test(userAgent) || /\biPhone\b/i.test(userAgent) || /\biPad\b/i.test(userAgent);
}

function detectSecChUaPlatform(userAgent: string): string {
    if (/\bWindows\b/i.test(userAgent)) return '"Windows"';
    if (/\bAndroid\b/i.test(userAgent)) return '"Android"';
    if (/\biPhone\b/i.test(userAgent) || /\biPad\b/i.test(userAgent) || /\biPod\b/i.test(userAgent)) return '"iOS"';
    if (/\bMacintosh\b/i.test(userAgent) || /\bMac OS X\b/i.test(userAgent)) return '"macOS"';
    if (/\bLinux\b/i.test(userAgent)) return '"Linux"';
    return DEFAULT_SEC_CH_UA_PLATFORM;
}

type BrowserHeaders = {
    userAgent: string;
    secChUa: string;
    secChUaMobile: string;
    secChUaPlatform: string;
};

function buildBrowserHeaders(env: Env): BrowserHeaders {
    const userAgent = envString(env.USER_AGENT) ?? DEFAULT_UA;
    const chromeMajorVersion = extractChromeMajorVersion(userAgent);

    const secChUa = chromeMajorVersion
        ? `"Google Chrome";v="${chromeMajorVersion}", "Chromium";v="${chromeMajorVersion}", "Not_A Brand";v="24"`
        : DEFAULT_SEC_CH_UA;

    const secChUaMobile = isMobileUserAgent(userAgent) ? '?1' : '?0';
    const secChUaPlatform = detectSecChUaPlatform(userAgent);

    return {
        userAgent,
        secChUa,
        secChUaMobile,
        secChUaPlatform,
    };
}

type RegexJson = string | { source: string; flags?: string };
type TargetJson = {
    name: string;
    urls: string[];
    mustContainAny: string[];
    outOfStockRegex: RegexJson[];
};

function normalizeStringArray(value: unknown): string[] {
    if (!Array.isArray(value)) return [];
    const result: string[] = [];
    for (const item of value) {
        if (typeof item !== 'string') continue;
        const trimmed = item.trim();
        if (trimmed) result.push(trimmed);
    }
    return result;
}

function parseRegexJson(value: unknown): RegExp | null {
    if (typeof value === 'string') {
        const trimmed = value.trim();
        if (!trimmed) return null;

        const slashed = trimmed.match(/^\/(.+)\/([a-z]*)$/i);
        if (slashed) {
            try {
                return new RegExp(slashed[1], slashed[2]);
            } catch {
                return null;
            }
        }

        try {
            return new RegExp(trimmed, 'i');
        } catch {
            return null;
        }
    }

    if (value && typeof value === 'object' && !Array.isArray(value)) {
        const record = value as Record<string, unknown>;
        const source = typeof record.source === 'string' ? record.source : null;
        if (!source) return null;

        const flags = typeof record.flags === 'string' ? record.flags : 'i';
        try {
            return new RegExp(source, flags);
        } catch {
            return null;
        }
    }

    return null;
}

function parseTargetJson(value: unknown): Target | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const record = value as Record<string, unknown>;

    const name = typeof record.name === 'string' ? record.name.trim() : '';
    if (!name) return null;

    const urls = normalizeStringArray(record.urls);
    const mustContainAny = normalizeStringArray(record.mustContainAny);
    if (urls.length === 0 || mustContainAny.length === 0) return null;

    const outOfStockRegexRaw = Array.isArray(record.outOfStockRegex) ? record.outOfStockRegex : [];
    const outOfStockRegex: RegExp[] = [];
    for (const item of outOfStockRegexRaw) {
        const re = parseRegexJson(item);
        if (re) outOfStockRegex.push(re);
    }
    if (outOfStockRegex.length === 0) return null;

    return { name, urls, mustContainAny, outOfStockRegex };
}

function parseTargetsJson(value: unknown): Target[] | null {
    if (!Array.isArray(value)) return null;

    const targets: Target[] = [];
    for (const item of value) {
        const target = parseTargetJson(item);
        if (!target) {
            console.warn('Skipping invalid TARGETS_JSON item:', item);
            continue;
        }
        targets.push(target);
    }

    return targets.length > 0 ? targets : null;
}

export function getTargets(env: Env): Target[] {
    const raw = envString(env.TARGETS_JSON);
    if (!raw) return TARGETS;

    try {
        const parsed = JSON.parse(raw) as unknown;
        const targets = parseTargetsJson(parsed);
        if (targets) return targets;
        console.warn('TARGETS_JSON is invalid or empty, using default TARGETS.');
        return TARGETS;
    } catch (error) {
        console.warn('Failed to parse TARGETS_JSON, using default TARGETS:', error);
        return TARGETS;
    }
}

/**
 * 获取页面内容
 */
async function fetchUrl(
    url: string,
    timeoutMs: number,
    browserHeaders: BrowserHeaders
): Promise<{ html: string | null; status: number }> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const response = await fetch(url, {
            headers: {
                'User-Agent': browserHeaders.userAgent,
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7',
                'Accept-Language': 'en-US,en;q=0.9,zh-CN;q=0.8,zh;q=0.7',
                'Accept-Encoding': 'gzip, deflate, br',
                'Cache-Control': 'no-cache',
                'Pragma': 'no-cache',
                'Sec-Ch-Ua': browserHeaders.secChUa,
                'Sec-Ch-Ua-Mobile': browserHeaders.secChUaMobile,
                'Sec-Ch-Ua-Platform': browserHeaders.secChUaPlatform,
                'Sec-Fetch-Dest': 'document',
                'Sec-Fetch-Mode': 'navigate',
                'Sec-Fetch-Site': 'none',
                'Sec-Fetch-User': '?1',
                'Upgrade-Insecure-Requests': '1',
            },
            signal: controller.signal,
        });

        if (response.ok) {
            const html = await response.text();
            return { html, status: response.status };
        }
        return { html: null, status: response.status };
    } catch {
        return { html: null, status: 0 };
    } finally {
        clearTimeout(timeoutId);
    }
}

/**
 * 页面健康校验（Sanity Check）
 * 确保返回的是正确的购物车页面
 */
function sanityOk(html: string, mustContainAny: string[]): boolean {
    const lowerHtml = html.toLowerCase();
    return mustContainAny.some((keyword) => lowerHtml.includes(keyword.toLowerCase()));
}

/**
 * 匹配缺货关键词
 */
function matchAnyRegex(html: string, patterns: RegExp[]): boolean {
    return patterns.some((pattern) => pattern.test(html));
}

/**
 * 延迟函数
 */
function delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 探测单个目标
 */
async function probeTarget(target: Target, env: Env, browserHeaders: BrowserHeaders): Promise<ProbeResult> {
    const timeoutSec = clampInt(envInt(env.TIMEOUT_SEC, DEFAULTS.TIMEOUT_SEC), 1, 120);
    const timeoutMs = timeoutSec * 1000;
    const confirmDelayMs = clampInt(envInt(env.CONFIRM_DELAY_MS, DEFAULTS.CONFIRM_DELAY_MS), 0, 60_000);

    let lastReason = 'fetch_failed';
    let lastUsedUrl: string | null = null;

    for (const url of target.urls) {
        lastUsedUrl = url;
        const { html, status } = await fetchUrl(url, timeoutMs, browserHeaders);

        if (!html) {
            lastReason = `http_${status || 'error'}`;
            continue;
        }

        if (!sanityOk(html, target.mustContainAny)) {
            lastReason = `sanity_failed@${url}`;
            continue;
        }

        // OUT 直接判定
        if (matchAnyRegex(html, target.outOfStockRegex)) {
            return {
                ok: true,
                status: 'OUT',
                usedUrl: url,
                reason: 'out_of_stock_keyword',
            };
        }

        // 看起来 IN：做一次短延迟二次确认（同 URL）
        await delay(confirmDelayMs);

        const { html: html2, status: status2 } = await fetchUrl(url, timeoutMs, browserHeaders);

        if (!html2) {
            lastReason = `confirm_http_${status2 || 'error'}`;
            continue;
        }

        if (!sanityOk(html2, target.mustContainAny)) {
            lastReason = `confirm_sanity_failed@${url}`;
            continue;
        }

        if (matchAnyRegex(html2, target.outOfStockRegex)) {
            return {
                ok: true,
                status: 'OUT',
                usedUrl: url,
                reason: 'flap_back_to_out',
            };
        }

        return {
            ok: true,
            status: 'IN',
            usedUrl: url,
            reason: 'confirmed_in_stock',
        };
    }

    return {
        ok: false,
        status: 'ERROR',
        usedUrl: lastUsedUrl,
        reason: lastReason,
    };
}

/**
 * 加载状态
 */
async function loadState(env: Env): Promise<State> {
    const stateJson = await env.STOCK_STATE.get('state');
    if (!stateJson) return {};
    try {
        const parsed = JSON.parse(stateJson) as unknown;
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            return parsed as State;
        }
    } catch (error) {
        console.warn('Invalid state in KV, resetting:', error);
    }
    return {};
}

/**
 * 保存状态
 */
async function saveState(env: Env, state: State): Promise<void> {
    await env.STOCK_STATE.put('state', JSON.stringify(state));
}

/**
 * 执行完整检查流程
 */
export async function runCheck(env: Env): Promise<string> {
    const notifiers = buildNotifiers(env);
    const state = await loadState(env);
    const now = Math.floor(Date.now() / 1000);
    const targets = getTargets(env);
    const browserHeaders = buildBrowserHeaders(env);

    const inConfirmationsRequired = clampInt(envInt(env.IN_CONFIRMATIONS_REQUIRED, DEFAULTS.IN_CONFIRMATIONS_REQUIRED), 1, 10);
    const errorStreakNotifyThreshold = clampInt(envInt(env.ERROR_STREAK_NOTIFY_THRESHOLD, DEFAULTS.ERROR_STREAK_NOTIFY_THRESHOLD), 1, 100);
    const errorNotifyCooldownSec = clampInt(envInt(env.ERROR_NOTIFY_COOLDOWN_SEC, DEFAULTS.ERROR_NOTIFY_COOLDOWN_SEC), 0, 86400);

    const changes: string[] = [];

    for (const target of targets) {
        const name = target.name;
        const s: TargetState = {
            status: 'OUT',
            inSinceTs: 0,
            inStreak: 0,
            errStreak: 0,
            lastErrNotifyTs: 0,
            lastInNotifyAttemptTs: 0,
            lastInNotifyOkTs: 0,
            lastUsedUrl: null,
            lastReason: '',
            ts: 0,
            ...(state[name] as Partial<TargetState> | undefined),
        };

        let {
            status: prevStatus,
            inSinceTs,
            inStreak,
            errStreak,
            lastErrNotifyTs,
            lastInNotifyAttemptTs,
            lastInNotifyOkTs,
        } = s;

        const result = await probeTarget(target, env, browserHeaders);

        if (result.status === 'ERROR') {
            errStreak += 1;

            // 错误达到阈值且超过冷却时间才通知
            if (
                errStreak >= errorStreakNotifyThreshold &&
                now - lastErrNotifyTs >= errorNotifyCooldownSec
            ) {
                const title = '⚠️ 补货监控异常';
                const text = `${name}\n原因: ${result.reason}\n建议: 检查网络/WAF/关键词/域名可达性`;
                const notifyResult = await notifyAll(notifiers, title, text);
                if (notifyResult.sent > 0) lastErrNotifyTs = now;
            }

            // ERROR 不改变 prevStatus
            state[name] = {
                status: prevStatus,
                inSinceTs,
                inStreak,
                errStreak,
                lastErrNotifyTs,
                lastInNotifyAttemptTs,
                lastInNotifyOkTs,
                lastUsedUrl: result.usedUrl,
                lastReason: result.reason,
                ts: now,
            };
            continue;
        }

        // probe OK：清空错误计数
        errStreak = 0;

        if (result.status === 'OUT') {
            inStreak = 0;
            if (prevStatus !== 'OUT') {
                changes.push(`${name}: IN -> OUT (${result.usedUrl})`);
            }
            prevStatus = 'OUT';
            inSinceTs = 0;
        } else if (result.status === 'IN') {
            if (prevStatus === 'OUT') {
                inStreak += 1;
                if (inStreak >= inConfirmationsRequired) {
                    // 达到连续确认次数：认定补货
                    prevStatus = 'IN';
                    inSinceTs = now;
                    const title = '🎉 可能补货了（OUT → IN）';
                    const text = `${name}\n入口: ${result.usedUrl}\n连续确认: ${inStreak}/${inConfirmationsRequired}\n提示: 立即打开下单页尝试加入购物车/结算`;
                    const notifyResult = await notifyAll(notifiers, title, text);
                    lastInNotifyAttemptTs = now;
                    if (notifyResult.sent > 0) lastInNotifyOkTs = now;
                    changes.push(`${name}: OUT -> IN (${result.usedUrl})`);
                }
            } else {
                // 已经是 IN，维持
                prevStatus = 'IN';
                inStreak = Math.max(inStreak, inConfirmationsRequired);

                // 如果补货通知在状态切换时全部失败：后续在 IN 状态下继续重试，直到至少一个渠道发送成功
                if (notifiers.length > 0 && lastInNotifyOkTs < inSinceTs) {
                    const title = '🎉 可能补货了（OUT → IN）';
                    const text = `${name}\n入口: ${result.usedUrl}\n提示: 立即打开下单页尝试加入购物车/结算\n(补货通知重试)`;
                    const notifyResult = await notifyAll(notifiers, title, text);
                    lastInNotifyAttemptTs = now;
                    if (notifyResult.sent > 0) lastInNotifyOkTs = now;
                }
            }
        }

        state[name] = {
            status: prevStatus,
            inSinceTs,
            inStreak,
            errStreak,
            lastErrNotifyTs,
            lastInNotifyAttemptTs,
            lastInNotifyOkTs,
            lastUsedUrl: result.usedUrl,
            lastReason: result.reason,
            ts: now,
        };
    }

    await saveState(env, state);

    const timestamp = formatBeijingTime();
    if (changes.length > 0) {
        const msg = `[${timestamp}] State changes:\n${changes.join('\n')}`;
        console.log(msg);
        return msg;
    } else {
        const msg = `[${timestamp}] OK - no changes`;
        console.log(msg);
        return msg;
    }
}

/**
 * 获取当前状态（用于 HTTP 查询）
 */
export async function getStatus(env: Env): Promise<State> {
    return await loadState(env);
}
