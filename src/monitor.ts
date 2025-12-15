/**
 * 监控逻辑模块
 * 负责抓取页面、判断库存状态、管理状态
 */

import type { Env, Target, ProbeResult, State, TargetState } from './types';
import { buildNotifiers, notifyAll } from './notifiers';
import { envInt, clampInt, formatBeijingTime, DEFAULTS } from './utils';
import { getTargets } from './config';
import { buildBrowserHeaders, fetchUrl, type BrowserHeaders } from './http';

// 重新导出以保持向后兼容
export { formatBeijingTime } from './utils';
export { getTargets, TARGETS } from './config';

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
