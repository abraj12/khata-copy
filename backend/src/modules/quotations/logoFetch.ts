import dns from 'node:dns/promises';
import net from 'node:net';
import { env } from '../../config/env.js';
import { storageService } from '../../services/storage.service.js';

export const MAX_QUOTATION_LOGO_BYTES = 512 * 1024; // 512 KB
export const LOGO_FETCH_TIMEOUT_MS = 2500;

export interface LogoFetchDependencies {
  allowedHosts?: string[];
  fetchFn?: typeof fetch;
  lookupFn?: (hostname: string) => Promise<Array<{ address: string; family: number }>>;
  timeoutMs?: number;
}

const SAFE_R2_KEY_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9/_-]*\.(?:png|jpg|jpeg)$/i;
const ALLOWED_LOGO_MIME_TYPES = new Set(['image/png', 'image/jpeg', 'image/jpg', 'application/octet-stream']);

export function isSupportedLogoBuffer(buffer: Uint8Array): boolean {
  if (!buffer || buffer.length < 4) return false;

  // JPEG: FF D8 FF
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return true;
  }

  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (
    buffer.length >= 8 &&
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47 &&
    buffer[4] === 0x0d &&
    buffer[5] === 0x0a &&
    buffer[6] === 0x1a &&
    buffer[7] === 0x0a
  ) {
    return true;
  }

  return false;
}

function isPrivateOrReservedIpv4(ip: string): boolean {
  const parts = ip.split('.').map((part) => Number(part));
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
    return true;
  }

  const [a, b] = parts;
  if (a === 0) return true; // 0.0.0.0/8
  if (a === 10) return true; // 10.0.0.0/8
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 (CGNAT)
  if (a === 127) return true; // 127.0.0.0/8 (loopback)
  if (a === 169 && b === 254) return true; // 169.254.0.0/16 (link-local / metadata)
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
  if (a === 192 && b === 0) return true; // 192.0.0.0/24, 192.0.2.0/24
  if (a === 192 && b === 168) return true; // 192.168.0.0/16
  if (a === 198 && (b === 18 || b === 19)) return true; // 198.18.0.0/15
  if (a >= 224) return true; // multicast / reserved
  return false;
}

export function isPrivateOrReservedIp(rawIp: string): boolean {
  const ip = rawIp.trim().toLowerCase().replace(/^\[|\]$/g, '').split('%')[0];
  const version = net.isIP(ip);
  if (version === 4) {
    return isPrivateOrReservedIpv4(ip);
  }
  if (version !== 6) {
    return true;
  }

  if (ip === '::' || ip === '::1') return true;
  if (ip.startsWith('fc') || ip.startsWith('fd')) return true; // ULA fc00::/7
  if (ip.startsWith('fe8') || ip.startsWith('fe9') || ip.startsWith('fea') || ip.startsWith('feb')) {
    return true; // link-local fe80::/10
  }
  if (ip.startsWith('ff')) return true; // multicast

  if (ip.startsWith('::ffff:')) {
    const mapped = ip.slice('::ffff:'.length);
    if (net.isIP(mapped) === 4) {
      return isPrivateOrReservedIpv4(mapped);
    }
    const hexParts = mapped.split(':');
    if (hexParts.length === 2) {
      const hi = Number.parseInt(hexParts[0], 16);
      const lo = Number.parseInt(hexParts[1], 16);
      if (Number.isInteger(hi) && Number.isInteger(lo)) {
        const ipv4 = `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`;
        return isPrivateOrReservedIpv4(ipv4);
      }
    }
    return true;
  }

  return false;
}

function extractHostname(candidate?: string | null): string | null {
  if (!candidate || typeof candidate !== 'string') return null;
  const trimmed = candidate.trim();
  if (!trimmed) return null;

  try {
    const withScheme = trimmed.includes('://') ? trimmed : `https://${trimmed}`;
    const parsed = new URL(withScheme);
    return parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '') || null;
  } catch {
    return null;
  }
}

export function getAllowedLogoHosts(extraHosts: string[] = []): Set<string> {
  const hosts = new Set<string>();
  const add = (value?: string | null) => {
    const host = extractHostname(value);
    if (host) hosts.add(host);
  };

  add(env.R2_PUBLIC_DOMAIN);
  add(env.R2_ENDPOINT);

  for (const origin of (env.FRONTEND_URL || '').split(',')) {
    add(origin);
  }
  for (const host of extraHosts) {
    add(host);
  }

  return hosts;
}

function isSafeRelativeObjectKey(logoUrl: string): boolean {
  if (!logoUrl || logoUrl.includes('://') || logoUrl.startsWith('/') || logoUrl.includes('..') || logoUrl.includes('\\')) {
    return false;
  }
  return SAFE_R2_KEY_PATTERN.test(logoUrl);
}

async function readStreamWithinLimit(stream: NodeJS.ReadableStream, maxBytes: number): Promise<Buffer | null> {
  const chunks: Buffer[] = [];
  let total = 0;

  for await (const chunk of stream) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buf.length;
    if (total > maxBytes) {
      return null;
    }
    chunks.push(buf);
  }

  const combined = Buffer.concat(chunks);
  return combined.length > 0 && isSupportedLogoBuffer(combined) ? combined : null;
}

async function readWebBodyWithinLimit(response: Response, maxBytes: number): Promise<Buffer | null> {
  const declaredLen = response.headers.get('content-length');
  if (declaredLen !== null) {
    const parsedLen = Number(declaredLen);
    if (!Number.isFinite(parsedLen) || parsedLen < 0 || parsedLen > maxBytes) {
      try {
        await response.body?.cancel();
      } catch {
        // ignore cancel failure
      }
      return null;
    }
  }

  if (!response.body) {
    return null;
  }

  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        return null;
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }

  const combined = Buffer.concat(chunks);
  return combined.length > 0 && isSupportedLogoBuffer(combined) ? combined : null;
}

/**
 * Safely fetches a company logo image buffer (PNG or JPEG only) for PDF rendering.
 * Never throws; returns null when disabled, disallowed, unreachable, oversized, or invalid.
 */
export async function fetchSafeLogoBuffer(
  logoUrl?: string | null,
  deps: LogoFetchDependencies = {}
): Promise<Buffer | null> {
  if (!logoUrl || typeof logoUrl !== 'string') {
    return null;
  }

  const trimmed = logoUrl.trim();
  if (!trimmed) {
    return null;
  }

  // 1. Trusted relative R2 object key path
  if (isSafeRelativeObjectKey(trimmed)) {
    if (!storageService.isConfigured()) {
      return null;
    }
    try {
      const { stream, contentType, contentLength } = await storageService.getObjectStream(trimmed);
      if (contentLength !== undefined && contentLength > MAX_QUOTATION_LOGO_BYTES) {
        return null;
      }
      const normalizedType = contentType.split(';')[0].trim().toLowerCase();
      if (normalizedType && !ALLOWED_LOGO_MIME_TYPES.has(normalizedType)) {
        return null;
      }
      return await readStreamWithinLimit(stream, MAX_QUOTATION_LOGO_BYTES);
    } catch {
      return null;
    }
  }

  // 2. Strict HTTPS allowlisted URL fetch with DNS + IP SSRF checks
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(trimmed);
  } catch {
    return null;
  }

  if (parsedUrl.protocol !== 'https:' || parsedUrl.username || parsedUrl.password) {
    return null;
  }

  const hostname = parsedUrl.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (!hostname || hostname === 'localhost' || net.isIP(hostname) !== 0) {
    return null;
  }

  const allowedHosts = getAllowedLogoHosts(deps.allowedHosts);
  if (!allowedHosts.has(hostname)) {
    return null;
  }

  const lookupFn =
    deps.lookupFn ||
    ((host: string) => dns.lookup(host, { all: true }));

  let resolvedAddresses: Array<{ address: string; family: number }>;
  try {
    resolvedAddresses = await lookupFn(hostname);
  } catch {
    return null;
  }

  if (!Array.isArray(resolvedAddresses) || resolvedAddresses.length === 0) {
    return null;
  }

  for (const record of resolvedAddresses) {
    if (!record?.address || isPrivateOrReservedIp(record.address)) {
      return null;
    }
  }

  const fetchImpl = deps.fetchFn || globalThis.fetch;
  if (typeof fetchImpl !== 'function') {
    return null;
  }

  const timeoutMs = deps.timeoutMs ?? LOGO_FETCH_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetchImpl(parsedUrl.toString(), {
      method: 'GET',
      redirect: 'manual',
      signal: controller.signal,
      headers: {
        Accept: 'image/png, image/jpeg',
      },
    });

    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel().catch(() => undefined);
      return null;
    }

    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      return null;
    }

    const rawContentType = response.headers.get('content-type');
    if (rawContentType) {
      const mimeType = rawContentType.split(';')[0].trim().toLowerCase();
      if (!ALLOWED_LOGO_MIME_TYPES.has(mimeType)) {
        await response.body?.cancel().catch(() => undefined);
        return null;
      }
    }

    return await readWebBodyWithinLimit(response, MAX_QUOTATION_LOGO_BYTES);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
