import { describe, it, expect } from 'vitest';
import { TARGETS, parseRegexJson, parseTargetsJson } from '../config';

describe('TARGETS', () => {
    it('should have default monitoring targets', () => {
        expect(TARGETS.length).toBeGreaterThan(0);
        expect(TARGETS[0].name).toContain('BandwagonHost');
        expect(TARGETS[0].urls.length).toBeGreaterThan(0);
        expect(TARGETS[0].mustContainAny.length).toBeGreaterThan(0);
        expect(TARGETS[0].outOfStockRegex.length).toBeGreaterThan(0);
    });
});

describe('parseRegexJson', () => {
    it('should parse string as case-insensitive regex', () => {
        const regex = parseRegexJson('out of stock');
        expect(regex).toBeInstanceOf(RegExp);
        expect(regex?.test('Out Of Stock')).toBe(true);
    });

    it('should parse slashed string with flags', () => {
        const regex = parseRegexJson('/out of stock/i');
        expect(regex).toBeInstanceOf(RegExp);
        expect(regex?.test('OUT OF STOCK')).toBe(true);

        const regexCase = parseRegexJson('/Out/');
        expect(regexCase?.test('Out')).toBe(true);
        expect(regexCase?.test('out')).toBe(false);
    });

    it('should parse object format', () => {
        const regex = parseRegexJson({ source: 'test\\d+', flags: 'g' });
        expect(regex).toBeInstanceOf(RegExp);
        expect(regex?.flags).toBe('g');
        expect(regex?.test('test123')).toBe(true);
    });

    it('should return null for invalid input', () => {
        expect(parseRegexJson('')).toBeNull();
        expect(parseRegexJson(null)).toBeNull();
        expect(parseRegexJson(123)).toBeNull();
        expect(parseRegexJson({})).toBeNull();
        expect(parseRegexJson({ source: '' })).toBeNull();
    });
});

describe('parseTargetsJson', () => {
    it('should parse valid targets array', () => {
        const input = [
            {
                name: 'Test Product',
                urls: ['https://example.com/cart'],
                mustContainAny: ['Shopping Cart'],
                outOfStockRegex: ['out of stock'],
            },
        ];
        const result = parseTargetsJson(input);
        expect(result).not.toBeNull();
        expect(result?.length).toBe(1);
        expect(result?.[0].name).toBe('Test Product');
    });

    it('should skip invalid items', () => {
        const input = [
            { name: 'Valid', urls: ['https://a.com'], mustContainAny: ['x'], outOfStockRegex: ['y'] },
            { name: '', urls: ['https://b.com'], mustContainAny: ['x'], outOfStockRegex: ['y'] }, // invalid: empty name
            { name: 'NoUrls', urls: [], mustContainAny: ['x'], outOfStockRegex: ['y'] }, // invalid: no urls
        ];
        const result = parseTargetsJson(input);
        expect(result?.length).toBe(1);
        expect(result?.[0].name).toBe('Valid');
    });

    it('should return null for non-array input', () => {
        expect(parseTargetsJson(null)).toBeNull();
        expect(parseTargetsJson({})).toBeNull();
        expect(parseTargetsJson('string')).toBeNull();
    });

    it('should return null for empty array', () => {
        expect(parseTargetsJson([])).toBeNull();
    });
});
