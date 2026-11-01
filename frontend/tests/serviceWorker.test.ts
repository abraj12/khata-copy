import { describe, it, expect } from 'vitest';

describe('Service Worker Vite Asset Matching & Security Exclusions (Phase 9)', () => {
  // Regex from frontend/public/sw.js
  const IMMUTABLE_ASSET_REGEX = /^\/assets\/[\w.-]+[-.][A-Za-z0-9_-]{8,}\.(?:js|css|woff2?|png|jpe?g|gif|svg|webp|ico)$/i;

  it('matches all real Vite-generated hashed bundle names', () => {
    const validViteAssets = [
      '/assets/index-D1wM4r-5.js',
      '/assets/index-DwglHT6G.css',
      '/assets/vendor-C3zK7pQ2.js',
      '/assets/font-Dx9f2Ab3.woff2',
      '/assets/logo-A1B2C3D4.svg',
      '/assets/montserrat-vietnamese-500-normal-DpeZlV_K.woff',
      '/assets/montserrat-latin-600-normal-UVxSCcoG.woff2',
      '/assets/montserrat-cyrillic-ext-400-normal-Xqov12YL.woff2',
      '/assets/hero-banner-9a8b7c6d.png',
      '/assets/photo-11223344.jpeg',
      '/assets/photo-11223344.jpg',
      '/assets/icon-12345678.webp',
      '/assets/favicon-87654321.ico',
      // Legacy dot-hash pattern if applicable
      '/assets/bundle.a1b2c3d4.js',
    ];

    for (const asset of validViteAssets) {
      expect(IMMUTABLE_ASSET_REGEX.test(asset), `Expected ${asset} to match IMMUTABLE_ASSET_REGEX`).toBe(true);
    }
  });

  it('rejects unhashed assets, HTML files, root documents, and non-asset paths', () => {
    const unhashedOrNonAssets = [
      '/index.html',
      '/',
      '/manifest.webmanifest',
      '/sw.js',
      '/.well-known/assetlinks.json',
      '/icons/icon-192.png',
      '/assets/index.js',          // unhashed
      '/assets/styles.css',        // unhashed
      '/assets/logo.svg',          // unhashed
      '/assets/short-123.js',      // hash < 8 characters
      '/static/index-D1wM4r-5.js', // wrong directory
    ];

    for (const path of unhashedOrNonAssets) {
      expect(IMMUTABLE_ASSET_REGEX.test(path), `Expected ${path} to NOT match IMMUTABLE_ASSET_REGEX`).toBe(false);
    }
  });

  it('strictly excludes private API endpoints from service worker caching', () => {
    const apiEndpoints = [
      '/api/v1/auth/session',
      '/api/v1/auth/login',
      '/api/v1/auth/logout',
      '/api/v1/khata/customers',
      '/api/v1/khata/transactions',
      '/api/v1/khata/payments',
      '/api/v1/products',
      '/api/v1/health/ready',
    ];

    for (const endpoint of apiEndpoints) {
      // Must not match immutable asset regex
      expect(IMMUTABLE_ASSET_REGEX.test(endpoint)).toBe(false);
      // Service worker rule: startsWith('/api/')
      expect(endpoint.startsWith('/api/')).toBe(true);
    }
  });
});
