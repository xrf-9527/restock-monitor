/**
 * 配置模块
 * 负责监控目标配置和解析
 */

import type { Env, Target } from './types';
import { envString } from './utils';

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
        name: 'BandwagonHost BiggerBox Pro (pid=156)',
        urls: [
            'https://bwh81.net/cart.php?a=add&pid=156',
            'https://bandwagonhost.com/cart.php?a=add&pid=156',
        ],
        mustContainAny: ['Shopping Cart', 'Bandwagon Host'],
        outOfStockRegex: [
            /\bOut of Stock\b/i,
            /We are currently out of stock on this plan\./i,
        ],
    },
    {
        name: 'BandwagonHost THE PLAN (pid=147)',
        urls: [
            'https://bwh81.net/cart.php?a=add&pid=147',
            'https://bandwagonhost.com/cart.php?a=add&pid=147',
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
    {
        name: 'DMIT LAX.Pro.Wee (pid=188)',
        urls: ['https://www.dmit.io/cart.php?a=add&pid=188'],
        mustContainAny: ['DMIT, Inc.', 'Client Area', 'Shopping Cart'],
        outOfStockRegex: [
            /\bOut of Stock\b/i,
            /We are currently out of stock on this item/i,
        ],
    },

];

/** JSON 中正则表达式的格式 */
export type RegexJson = string | { source: string; flags?: string };

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

export function parseRegexJson(value: unknown): RegExp | null {
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

export function parseTargetsJson(value: unknown): Target[] | null {
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

/**
 * 获取监控目标列表
 * 优先使用环境变量 TARGETS_JSON，否则使用默认配置
 */
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
