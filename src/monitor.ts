/**
 * 监控逻辑模块
 * 负责抓取页面、判断库存状态、管理状态
 */

import type { Env, Target, ProbeResult, State, TargetState } from './types';
import { buildNotifiers, notifyAll } from './notifiers';

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

const UA = 'Mozilla/5.0 (restock-watch/1.0; +https://example.invalid)';

function envInt(value: string | undefined, fallback: number): number {
    const parsed = Number.parseInt(value ?? '', 10);
    return Number.isFinite(parsed) ? parsed : fallback;
}

function clampInt(value: number, min: number, max: number): number {
    return Math.min(Math.max(value, min), max);
}

/**
 * 获取页面内容
 */
async function fetchUrl(
    url: string,
    timeoutMs: number
): Promise<{ html: string | null; status: number }> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const response = await fetch(url, {
            headers: {
                'User-Agent': UA,
                'Accept-Language': 'en-US,en;q=0.9,zh-CN;q=0.8',
                'Cache-Control': 'no-cache',
                'Pragma': 'no-cache',
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
async function probeTarget(target: Target, env: Env): Promise<ProbeResult> {
    const timeoutSec = clampInt(envInt(env.TIMEOUT_SEC, 15), 1, 120);
    const timeoutMs = timeoutSec * 1000;
    const confirmDelayMs = clampInt(envInt(env.CONFIRM_DELAY_MS, 2000), 0, 60_000);

    let lastReason = 'fetch_failed';
    let lastUsedUrl: string | null = null;

    for (const url of target.urls) {
        lastUsedUrl = url;
        const { html, status } = await fetchUrl(url, timeoutMs);

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

        const { html: html2, status: status2 } = await fetchUrl(url, timeoutMs);

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

    const inConfirmationsRequired = clampInt(envInt(env.IN_CONFIRMATIONS_REQUIRED, 2), 1, 10);
    const errorStreakNotifyThreshold = clampInt(envInt(env.ERROR_STREAK_NOTIFY_THRESHOLD, 5), 1, 100);
    const errorNotifyCooldownSec = clampInt(envInt(env.ERROR_NOTIFY_COOLDOWN_SEC, 1800), 0, 86400);

    const changes: string[] = [];

    for (const target of TARGETS) {
        const name = target.name;
        const s: TargetState = state[name] || {
            status: 'OUT',
            inStreak: 0,
            errStreak: 0,
            lastErrNotifyTs: 0,
            lastUsedUrl: null,
            lastReason: '',
            ts: 0,
        };

        let { status: prevStatus, inStreak, errStreak, lastErrNotifyTs } = s;

        const result = await probeTarget(target, env);

        if (result.status === 'ERROR') {
            errStreak += 1;

            // 错误达到阈值且超过冷却时间才通知
            if (
                errStreak >= errorStreakNotifyThreshold &&
                now - lastErrNotifyTs >= errorNotifyCooldownSec
            ) {
                const title = '⚠️ 补货监控异常';
                const text = `${name}\n原因: ${result.reason}\n建议: 检查网络/WAF/关键词/域名可达性`;
                await notifyAll(notifiers, title, text);
                lastErrNotifyTs = now;
            }

            // ERROR 不改变 prevStatus
            state[name] = {
                status: prevStatus,
                inStreak,
                errStreak,
                lastErrNotifyTs,
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
        } else if (result.status === 'IN') {
            if (prevStatus === 'OUT') {
                inStreak += 1;
                if (inStreak >= inConfirmationsRequired) {
                    // 达到连续确认次数：认定补货
                    prevStatus = 'IN';
                    const title = '🎉 可能补货了（OUT → IN）';
                    const text = `${name}\n入口: ${result.usedUrl}\n连续确认: ${inStreak}/${inConfirmationsRequired}\n提示: 立即打开下单页尝试加入购物车/结算`;
                    await notifyAll(notifiers, title, text);
                    changes.push(`${name}: OUT -> IN (${result.usedUrl})`);
                }
            } else {
                // 已经是 IN，维持
                prevStatus = 'IN';
                inStreak = Math.max(inStreak, inConfirmationsRequired);
            }
        }

        state[name] = {
            status: prevStatus,
            inStreak,
            errStreak,
            lastErrNotifyTs,
            lastUsedUrl: result.usedUrl,
            lastReason: result.reason,
            ts: now,
        };
    }

    await saveState(env, state);

    const timestamp = new Date().toISOString();
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
