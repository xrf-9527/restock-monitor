import { describe, it, expect } from 'vitest';
import { envInt, clampInt, envString, formatBeijingTime, DEFAULTS } from '../utils';

describe('envInt', () => {
    it('should parse valid integer string', () => {
        expect(envInt('42', 0)).toBe(42);
        expect(envInt('0', 10)).toBe(0);
        expect(envInt('-5', 0)).toBe(-5);
    });

    it('should return fallback for invalid input', () => {
        expect(envInt(undefined, 15)).toBe(15);
        expect(envInt('', 15)).toBe(15);
        expect(envInt('abc', 15)).toBe(15);
        expect(envInt('12.5', 15)).toBe(12); // parseInt truncates
    });
});

describe('clampInt', () => {
    it('should clamp value within range', () => {
        expect(clampInt(5, 0, 10)).toBe(5);
        expect(clampInt(-5, 0, 10)).toBe(0);
        expect(clampInt(15, 0, 10)).toBe(10);
        expect(clampInt(0, 0, 10)).toBe(0);
        expect(clampInt(10, 0, 10)).toBe(10);
    });
});

describe('envString', () => {
    it('should return trimmed string', () => {
        expect(envString('hello')).toBe('hello');
        expect(envString('  hello  ')).toBe('hello');
    });

    it('should return undefined for empty or undefined', () => {
        expect(envString(undefined)).toBeUndefined();
        expect(envString('')).toBeUndefined();
        expect(envString('   ')).toBeUndefined();
    });
});

describe('formatBeijingTime', () => {
    it('should format date in Beijing timezone', () => {
        const result = formatBeijingTime(new Date('2024-01-15T08:30:00Z'));
        expect(result).toContain('Beijing (UTC+8)');
        // UTC 08:30 = Beijing 16:30
        expect(result).toContain('16:30:00');
    });

    it('should use current time by default', () => {
        const result = formatBeijingTime();
        expect(result).toContain('Beijing (UTC+8)');
        expect(result).toMatch(/\d{4}-\d{2}-\d{2}/);
    });
});

describe('DEFAULTS', () => {
    it('should have expected default values', () => {
        expect(DEFAULTS.TIMEOUT_SEC).toBe(15);
        expect(DEFAULTS.CONFIRM_DELAY_MS).toBe(2000);
        expect(DEFAULTS.IN_CONFIRMATIONS_REQUIRED).toBe(1);
        expect(DEFAULTS.ERROR_STREAK_NOTIFY_THRESHOLD).toBe(5);
        expect(DEFAULTS.ERROR_NOTIFY_COOLDOWN_SEC).toBe(1800);
    });
});
