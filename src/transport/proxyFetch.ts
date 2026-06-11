import type { Dispatcher } from 'undici';
import { fetch as undiciFetch } from 'undici';
import { getDispatcher } from './dispatcherCache.js';
import { getSocksDispatcher } from './socksLoader.js';
import type { TransportConfig } from './types.js';

function normalizeProxyUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    new URL(url);
    return url;
  } catch {
    return `http://${url}`;
  }
}

const envProxyMemo = new Map<string, string | null>();

function getEnvProxyUrl(targetUrl: string): string | null {
  let host: string;
  try {
    host = new URL(targetUrl).host;
  } catch {
    return null;
  }
  const cached = envProxyMemo.get(host);
  if (cached !== undefined) return cached;
  const noProxy = process.env.NO_PROXY || process.env.no_proxy;
  if (noProxy && shouldBypassByNoProxy(targetUrl, noProxy)) {
    envProxyMemo.set(host, null);
    return null;
  }
  const protocol = new URL(targetUrl).protocol;
  const out =
    protocol === 'https:'
      ? process.env.HTTPS_PROXY ||
        process.env.https_proxy ||
        process.env.ALL_PROXY ||
        process.env.all_proxy ||
        null
      : process.env.HTTP_PROXY ||
        process.env.http_proxy ||
        process.env.ALL_PROXY ||
        process.env.all_proxy ||
        null;
  envProxyMemo.set(host, out);
  return out;
}

/** Test helper — clear the env-proxy memo between cases. */
export function _resetEnvProxyMemo(): void {
  envProxyMemo.clear();
}

function shouldBypassByNoProxy(targetUrl: string, noProxyValue: string): boolean {
  if (!noProxyValue) return false;
  const host = new URL(targetUrl).hostname.toLowerCase();
  return noProxyValue
    .split(',')
    .map((p) => p.trim().toLowerCase())
    .filter(Boolean)
    .some((pattern) => {
      if (pattern === '*') return true;
      if (pattern.startsWith('.')) return host.endsWith(pattern) || host === pattern.slice(1);
      return host === pattern || host.endsWith(`.${pattern}`);
    });
}

// undici's fetch accepts dispatcher via its own RequestInit extension
type UndiciFetchOptions = RequestInit & { dispatcher?: Dispatcher };

export async function proxyAwareFetch(
  targetUrl: string,
  options: RequestInit,
  transportConfig: TransportConfig | null
): Promise<Response> {
  if (transportConfig?.relay?.url) {
    const parsed = new URL(targetUrl);
    const relayHeaders: Record<string, string> = {
      ...(options.headers as Record<string, string> | undefined),
      'x-relay-target': `${parsed.protocol}//${parsed.host}`,
      'x-relay-path': `${parsed.pathname}${parsed.search}`,
    };
    return globalThis.fetch(transportConfig.relay.url, { ...options, headers: relayHeaders });
  }

  const settingsProxyUrl = transportConfig?.proxy?.url;
  const envProxyUrl = getEnvProxyUrl(targetUrl);
  const proxyUrl = normalizeProxyUrl(settingsProxyUrl || envProxyUrl);

  if (proxyUrl) {
    try {
      const dispatcher: Dispatcher | null =
        transportConfig?.proxy?.kind === 'socks5'
          ? await getSocksDispatcher(proxyUrl)
          : await getDispatcher(proxyUrl);
      if (dispatcher) {
        return await undiciFetch(targetUrl, { ...options, dispatcher } as Parameters<typeof undiciFetch>[1]) as unknown as Response;
      }
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : String(e);
      console.warn(`[transport] proxy failed, falling back to direct: ${message}`);
      return globalThis.fetch(targetUrl, options);
    }
  }

  return globalThis.fetch(targetUrl, options);
}
