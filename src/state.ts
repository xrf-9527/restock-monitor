/**
 * 状态管理模块
 * 负责 KV 状态的加载和保存
 */

import type { Env, State } from './types';

/**
 * 加载状态
 */
export async function loadState(env: Env): Promise<State> {
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
export async function saveState(env: Env, state: State): Promise<void> {
    await env.STOCK_STATE.put('state', JSON.stringify(state));
}
