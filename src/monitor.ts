/**
 * 监控逻辑模块
 * 负责抓取页面、判断库存状态、管理状态
 */

import type { Env, Target, ProbeResult, State, TargetState } from './types';
import { buildNotifiers, notifyAll } from './notifiers';
import { envInt, clampInt, formatBeijingTime, DEFAULTS } from './utils';
import { getTargets } from './config';
import { buildBrowserHeaders, fetchUrl, fetchWithBrowser, type BrowserHeaders } from './http';
import { loadState, saveState } from './state';
import puppeteer from '@cloudflare/puppeteer';

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
 * 判断是否应该使用 Browser Rendering 降级
 * 403/429 等状态码表示被 WAF/限流阻止
 */
function shouldFallbackToBrowser(status: number): boolean {
    return status === 403 || status === 429 || status === 503;
}

/**
 * 探测单个目标
 */
async function probeTarget(
    target: Target,
    env: Env,
    browserHeaders: BrowserHeaders,
    getBrowser: () => Promise<import('@cloudflare/puppeteer').Browser | null>
): Promise<ProbeResult> {
    const timeoutSec = clampInt(envInt(env.TIMEOUT_SEC, DEFAULTS.TIMEOUT_SEC), 1, 120);
    const timeoutMs = timeoutSec * 1000;
    const confirmDelayMs = clampInt(envInt(env.CONFIRM_DELAY_MS, DEFAULTS.CONFIRM_DELAY_MS), 0, 60_000);

    let lastReason = 'fetch_failed';
    let lastUsedUrl: string | null = null;

    for (const url of target.urls) {
        lastUsedUrl = url;
        let { html, status } = await fetchUrl(url, timeoutMs, browserHeaders);

        // 降级策略：普通 fetch 被阻止时，尝试 Browser Rendering
        if (!html && shouldFallbackToBrowser(status)) {
            const browserInstance = await getBrowser();
            if (browserInstance) {
                console.log(`[Browser Fallback] ${url} got ${status}, trying Browser Rendering...`);
                const browserResult = await fetchWithBrowser(url, timeoutMs, browserInstance, browserHeaders.userAgent);
                html = browserResult.html;
                status = browserResult.status;
                if (html) {
                    console.log(`[Browser Fallback] Success for ${url}`);
                }
            }
        }

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

        let { html: html2, status: status2 } = await fetchUrl(url, timeoutMs, browserHeaders);

        // 二次确认也使用降级策略
        if (!html2 && shouldFallbackToBrowser(status2)) {
            const browserInstance = await getBrowser();
            if (browserInstance) {
                console.log(`[Browser Fallback] Confirm ${url} got ${status2}, trying Browser Rendering...`);
                const browserResult = await fetchWithBrowser(url, timeoutMs, browserInstance, browserHeaders.userAgent);
                html2 = browserResult.html;
                status2 = browserResult.status;
            }
        }

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

/** 检查配置参数 */
interface CheckConfig {
    inConfirmationsRequired: number;
    errorStreakNotifyThreshold: number;
    errorNotifyCooldownSec: number;
}

/** 状态处理上下文 */
interface StateContext {
    prevStatus: 'OUT' | 'IN';
    inSinceTs: number;
    inStreak: number;
    errStreak: number;
    lastErrNotifyTs: number;
    lastInNotifyAttemptTs: number;
    lastInNotifyOkTs: number;
}

/** 默认目标状态 */
function getDefaultTargetState(): TargetState {
    return {
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
    };
}

/** 处理探测错误 */
async function handleProbeError(
    ctx: StateContext,
    result: ProbeResult,
    name: string,
    now: number,
    config: CheckConfig,
    notifiers: import('./notifiers').Notifier[]
): Promise<StateContext> {
    ctx.errStreak += 1;

    // 错误达到阈值且超过冷却时间才通知
    if (
        ctx.errStreak >= config.errorStreakNotifyThreshold &&
        now - ctx.lastErrNotifyTs >= config.errorNotifyCooldownSec
    ) {
        const title = '⚠️ 补货监控异常';
        const text = `${name}\n原因: ${result.reason}\n建议: 检查网络/WAF/关键词/域名可达性`;
        const notifyResult = await notifyAll(notifiers, title, text);
        if (notifyResult.sent > 0) {
            ctx.lastErrNotifyTs = now;
            // 重置错误计数，避免每次冷却期结束后重复通知
            // 需要再次累积足够的连续错误才会再次通知
            ctx.errStreak = 0;
        }
    }

    return ctx;
}

/** 处理缺货状态 */
function handleOutOfStock(
    ctx: StateContext,
    result: ProbeResult,
    name: string,
    changes: string[]
): StateContext {
    ctx.inStreak = 0;
    if (ctx.prevStatus !== 'OUT') {
        changes.push(`${name}: IN -> OUT (${result.usedUrl})`);
    }
    ctx.prevStatus = 'OUT';
    ctx.inSinceTs = 0;
    return ctx;
}

/** 处理有货状态 */
async function handleInStock(
    ctx: StateContext,
    result: ProbeResult,
    name: string,
    now: number,
    config: CheckConfig,
    notifiers: import('./notifiers').Notifier[],
    changes: string[]
): Promise<StateContext> {
    if (ctx.prevStatus === 'OUT') {
        // 从 OUT 转向 IN：累计确认次数
        ctx.inStreak += 1;
        if (ctx.inStreak >= config.inConfirmationsRequired) {
            // 达到连续确认次数：认定补货
            ctx.prevStatus = 'IN';
            ctx.inSinceTs = now;
            const title = '🎉 可能补货了（OUT → IN）';
            const text = `${name}\n入口: ${result.usedUrl}\n连续确认: ${ctx.inStreak}/${config.inConfirmationsRequired}\n提示: 立即打开下单页尝试加入购物车/结算`;
            const notifyResult = await notifyAll(notifiers, title, text);
            ctx.lastInNotifyAttemptTs = now;
            if (notifyResult.sent > 0) ctx.lastInNotifyOkTs = now;
            changes.push(`${name}: OUT -> IN (${result.usedUrl})`);
        }
    } else {
        // 已经是 IN：维持状态
        ctx.prevStatus = 'IN';
        ctx.inStreak = Math.max(ctx.inStreak, config.inConfirmationsRequired);

        // 如果补货通知在状态切换时全部失败：后续在 IN 状态下继续重试
        if (notifiers.length > 0 && ctx.lastInNotifyOkTs < ctx.inSinceTs) {
            const title = '🎉 可能补货了（OUT → IN）';
            const text = `${name}\n入口: ${result.usedUrl}\n提示: 立即打开下单页尝试加入购物车/结算\n(补货通知重试)`;
            const notifyResult = await notifyAll(notifiers, title, text);
            ctx.lastInNotifyAttemptTs = now;
            if (notifyResult.sent > 0) ctx.lastInNotifyOkTs = now;
        }
    }
    return ctx;
}

/** 构建最终状态 */
function buildTargetState(ctx: StateContext, result: ProbeResult, now: number): TargetState {
    return {
        status: ctx.prevStatus,
        inSinceTs: ctx.inSinceTs,
        inStreak: ctx.inStreak,
        errStreak: ctx.errStreak,
        lastErrNotifyTs: ctx.lastErrNotifyTs,
        lastInNotifyAttemptTs: ctx.lastInNotifyAttemptTs,
        lastInNotifyOkTs: ctx.lastInNotifyOkTs,
        lastUsedUrl: result.usedUrl,
        lastReason: result.reason,
        ts: now,
    };
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

    const config: CheckConfig = {
        inConfirmationsRequired: clampInt(envInt(env.IN_CONFIRMATIONS_REQUIRED, DEFAULTS.IN_CONFIRMATIONS_REQUIRED), 1, 10),
        errorStreakNotifyThreshold: clampInt(envInt(env.ERROR_STREAK_NOTIFY_THRESHOLD, DEFAULTS.ERROR_STREAK_NOTIFY_THRESHOLD), 1, 100),
        errorNotifyCooldownSec: clampInt(envInt(env.ERROR_NOTIFY_COOLDOWN_SEC, DEFAULTS.ERROR_NOTIFY_COOLDOWN_SEC), 0, 86400),
    };

    let browser: import('@cloudflare/puppeteer').Browser | null = null;

    // 惰性获取 Browser 实例
    const getBrowser = async () => {
        if (browser) return browser;
        if (env.BROWSER) {
            try {
                console.log('Launching browser instance...');
                browser = await puppeteer.launch(env.BROWSER);
            } catch (e) {
                console.error('Failed to launch browser:', e);
            }
        }
        return browser;
    };

    const changes: string[] = [];

    try {
        for (const target of targets) {
            const name = target.name;
            const savedState = state[name] as Partial<TargetState> | undefined;
            const defaultState = getDefaultTargetState();
            const s: TargetState = { ...defaultState, ...savedState };

            let ctx: StateContext = {
                prevStatus: s.status,
                inSinceTs: s.inSinceTs,
                inStreak: s.inStreak,
                errStreak: s.errStreak,
                lastErrNotifyTs: s.lastErrNotifyTs,
                lastInNotifyAttemptTs: s.lastInNotifyAttemptTs,
                lastInNotifyOkTs: s.lastInNotifyOkTs,
            };

            const result = await probeTarget(target, env, browserHeaders, getBrowser);

            if (result.status === 'ERROR') {
                ctx = await handleProbeError(ctx, result, name, now, config, notifiers);
                state[name] = buildTargetState(ctx, result, now);
                continue;
            }

            // probe OK：清空错误计数
            ctx.errStreak = 0;

            if (result.status === 'OUT') {
                ctx = handleOutOfStock(ctx, result, name, changes);
            } else if (result.status === 'IN') {
                ctx = await handleInStock(ctx, result, name, now, config, notifiers, changes);
            }

            state[name] = buildTargetState(ctx, result, now);
        }

        // 清理 KV 中已删除的目标（不在当前配置中的）
        const currentTargetNames = new Set(targets.map(t => t.name));
        for (const stateName of Object.keys(state)) {
            if (!currentTargetNames.has(stateName)) {
                console.log(`Cleaning up removed target: ${stateName}`);
                delete state[stateName];
            }
        }

        await saveState(env, state);

        const timestamp = formatBeijingTime();
        const msg = changes.length > 0
            ? `[${timestamp}] State changes:\n${changes.join('\n')}`
            : `[${timestamp}] OK - no changes`;
        console.log(msg);
        return msg;
    } finally {
        if (browser) {
            console.log('Closing browser instance...');
            try {
                // @ts-ignore
                await browser.close();
            } catch (e) {
                console.error('Error closing browser:', e);
            }
        }
    }
}

/**
 * 获取当前状态（用于 HTTP 查询）
 * 只返回当前配置的监控目标的状态
 */
export async function getStatus(env: Env): Promise<State> {
    const fullState = await loadState(env);
    const targets = getTargets(env);
    const filteredState: State = {};

    // 返回所有当前配置的目标，即使还没有历史状态
    for (const target of targets) {
        if (fullState[target.name]) {
            filteredState[target.name] = fullState[target.name];
        } else {
            // 新添加的目标或还没有运行过检查，返回默认状态
            filteredState[target.name] = getDefaultTargetState();
        }
    }

    return filteredState;
}
