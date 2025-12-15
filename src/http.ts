/**
 * HTTP 请求模块
 * 负责构建浏览器请求头和发送 HTTP 请求
 */

import type { Env } from './types';
import { envString } from './utils';

/**
 * 默认浏览器请求头（Chrome on Windows）
 */
const DEFAULT_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const DEFAULT_CHROME_MAJOR_VERSION = '131';
const DEFAULT_SEC_CH_UA = `"Google Chrome";v="${DEFAULT_CHROME_MAJOR_VERSION}", "Chromium";v="${DEFAULT_CHROME_MAJOR_VERSION}", "Not_A Brand";v="24"`;
const DEFAULT_SEC_CH_UA_PLATFORM = '"Windows"';

export function extractChromeMajorVersion(userAgent: string): string | null {
    const match = userAgent.match(/\bChrome\/(\d+)\b/i);
    return match ? match[1] : null;
}

export function isMobileUserAgent(userAgent: string): boolean {
    return /\bMobile\b/i.test(userAgent) || /\bAndroid\b/i.test(userAgent) || /\biPhone\b/i.test(userAgent) || /\biPad\b/i.test(userAgent);
}

export function detectSecChUaPlatform(userAgent: string): string {
    if (/\bWindows\b/i.test(userAgent)) return '"Windows"';
    if (/\bAndroid\b/i.test(userAgent)) return '"Android"';
    if (/\biPhone\b/i.test(userAgent) || /\biPad\b/i.test(userAgent) || /\biPod\b/i.test(userAgent)) return '"iOS"';
    if (/\bMacintosh\b/i.test(userAgent) || /\bMac OS X\b/i.test(userAgent)) return '"macOS"';
    if (/\bLinux\b/i.test(userAgent)) return '"Linux"';
    return DEFAULT_SEC_CH_UA_PLATFORM;
}

export type BrowserHeaders = {
    userAgent: string;
    secChUa: string;
    secChUaMobile: string;
    secChUaPlatform: string;
};

export function buildBrowserHeaders(env: Env): BrowserHeaders {
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

/**
 * 获取页面内容
 */
export async function fetchUrl(
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
