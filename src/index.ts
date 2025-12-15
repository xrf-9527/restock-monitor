/**
 * Cloudflare Worker 入口文件
 * 补货监控 - BandwagonHost MegaBox Pro & DMIT LAX.Pro.MALIBU
 */

import type { Env } from './types';
import { runCheck, getStatus, formatBeijingTime } from './monitor';

function responseHeaders(contentType: string): Record<string, string> {
    return {
        'Content-Type': contentType,
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
    };
}

function methodAllowed(method: string): boolean {
    return method === 'GET';
}

function readBearerToken(request: Request): string | null {
    const auth = request.headers.get('Authorization');
    if (!auth) return null;
    const match = auth.match(/^Bearer\s+(.+)$/i);
    return match ? match[1].trim() : null;
}

function isAuthorized(request: Request, env: Env): boolean {
    if (!env.ADMIN_TOKEN) return true;
    const token = readBearerToken(request) ?? request.headers.get('X-Admin-Token');
    return token === env.ADMIN_TOKEN;
}

function unauthorized(): Response {
    return new Response('Unauthorized', {
        status: 401,
        headers: {
            ...responseHeaders('text/plain; charset=utf-8'),
            'WWW-Authenticate': 'Bearer',
        },
    });
}

function methodNotAllowed(): Response {
    return new Response('Method Not Allowed', {
        status: 405,
        headers: {
            ...responseHeaders('text/plain; charset=utf-8'),
            'Allow': 'GET',
        },
    });
}

export default {
    /**
     * HTTP 请求处理
     * - GET / : 手动触发检查
     * - GET /status : 查看当前状态
     */
    async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
        const url = new URL(request.url);

        // 状态查询
        if (url.pathname === '/status') {
            if (!methodAllowed(request.method)) return methodNotAllowed();
            if (!isAuthorized(request, env)) return unauthorized();
            try {
                const state = await getStatus(env);
                return new Response(JSON.stringify(state, null, 2), {
                    headers: responseHeaders('application/json; charset=utf-8'),
                });
            } catch (error) {
                const errorMessage = error instanceof Error ? error.message : String(error);
                return new Response(`Error: ${errorMessage}`, {
                    status: 500,
                    headers: responseHeaders('text/plain; charset=utf-8'),
                });
            }
        }

        // 手动触发检查
        if (url.pathname === '/' || url.pathname === '/check') {
            if (!methodAllowed(request.method)) return methodNotAllowed();
            if (!isAuthorized(request, env)) return unauthorized();
            try {
                const result = await runCheck(env);
                return new Response(result, {
                    headers: responseHeaders('text/plain; charset=utf-8'),
                });
            } catch (error) {
                const errorMessage = error instanceof Error ? error.message : String(error);
                return new Response(`Error: ${errorMessage}`, {
                    status: 500,
                    headers: responseHeaders('text/plain; charset=utf-8'),
                });
            }
        }

        // 其他路径返回使用说明
        return new Response(
            `Restock Monitor

Endpoints:
  GET /        - 手动触发检查
  GET /check   - 手动触发检查
  GET /status  - 查看当前状态

Cron: */2 * * * * (每 2 分钟自动执行)

监控目标:
  - BandwagonHost MegaBox Pro (pid=157)
  - DMIT LAX.Pro.MALIBU (pid=186)
`,
            {
                headers: responseHeaders('text/plain; charset=utf-8'),
            }
        );
    },

    /**
     * Cron Trigger 处理
     * 每 2 分钟自动执行检查
     */
    async scheduled(
        controller: ScheduledController,
        env: Env,
        ctx: ExecutionContext
    ): Promise<void> {
        console.log(`Cron triggered at ${formatBeijingTime()}`);
        ctx.waitUntil(
            runCheck(env).catch((error) => {
                console.error('runCheck failed:', error);
            })
        );
    },
};
