import { describe, it, expect } from 'vitest';
import { extractChromeMajorVersion, isMobileUserAgent, detectSecChUaPlatform } from '../http';

describe('extractChromeMajorVersion', () => {
    it('should extract Chrome major version', () => {
        expect(extractChromeMajorVersion('Mozilla/5.0 Chrome/131.0.0.0 Safari/537.36')).toBe('131');
        expect(extractChromeMajorVersion('Chrome/120.1.2.3')).toBe('120');
    });

    it('should return null for non-Chrome UA', () => {
        expect(extractChromeMajorVersion('Mozilla/5.0 Firefox/120.0')).toBeNull();
        expect(extractChromeMajorVersion('Safari/537.36')).toBeNull();
    });
});

describe('isMobileUserAgent', () => {
    it('should detect mobile user agents', () => {
        expect(isMobileUserAgent('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0)')).toBe(true);
        expect(isMobileUserAgent('Mozilla/5.0 (Linux; Android 14)')).toBe(true);
        expect(isMobileUserAgent('Mozilla/5.0 (iPad; CPU OS 17_0)')).toBe(true);
        expect(isMobileUserAgent('Mozilla/5.0 Mobile Safari')).toBe(true);
    });

    it('should detect desktop user agents', () => {
        expect(isMobileUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64)')).toBe(false);
        expect(isMobileUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X)')).toBe(false);
    });
});

describe('detectSecChUaPlatform', () => {
    it('should detect Windows', () => {
        expect(detectSecChUaPlatform('Mozilla/5.0 (Windows NT 10.0; Win64; x64)')).toBe('"Windows"');
    });

    it('should detect macOS', () => {
        expect(detectSecChUaPlatform('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)')).toBe('"macOS"');
    });

    it('should detect Android', () => {
        expect(detectSecChUaPlatform('Mozilla/5.0 (Linux; Android 14)')).toBe('"Android"');
    });

    it('should detect iOS', () => {
        expect(detectSecChUaPlatform('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0)')).toBe('"iOS"');
        expect(detectSecChUaPlatform('Mozilla/5.0 (iPad; CPU OS 17_0)')).toBe('"iOS"');
    });

    it('should detect Linux', () => {
        expect(detectSecChUaPlatform('Mozilla/5.0 (X11; Linux x86_64)')).toBe('"Linux"');
    });

    it('should return default for unknown', () => {
        expect(detectSecChUaPlatform('Unknown UA')).toBe('"Windows"');
    });
});
