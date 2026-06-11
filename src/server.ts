import { existsSync } from 'node:fs';
import { serve } from '@hono/node-server';
import type Database from 'better-sqlite3';
import { type Context, Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { ulid } from 'ulid';
import { checkFallbackError } from './accounts/errorRules.js';
import { clearExpiredModelLocks, getModelLock, setModelLock } from './accounts/locks.js';
import { selectAccount } from './accounts/selection.js';
import { isModelLockActive } from './accounts/state.js';
import type { AccountState, SelectionMode } from './accounts/types.js';
import { adminApi } from './api/admin/index.js';
import { setPassword } from './auth/password.js';
import {
  handleLogin,
  handleLogout,
  requireAdmin,
  requireApiKey,
  verifySameOrigin,
} from './auth.js';
import { augmentRequest } from './cache-injection.js';
import { consoleBus } from './console/bus.js';
import {
  buildAccount,
  buildDone,
  buildError,
  buildStart,
  buildTransport,
  genReqId,
} from './console/flow.js';
import { attachStdoutSink } from './console/sink.js';
import { openDb } from './db/index.js';
import {
  createAccount,
  deleteAccount,
  disableAccount,
  enableAccount,
  listEnabledAccounts,
  listEnabledAccountsByProvider,
  updateAccount,
} from './db/repos/accounts.js';
import {
  createClientKey,
  deleteClientKey,
  disableClientKey,
  enableClientKey,
  genClientKey,
} from './db/repos/client_keys.js';
import { disableModel, enableModel } from './db/repos/models.js';
import { flushDeferredLogs, insertRequestLogDeferred } from './db/repos/requestLogs.js';
import { getAllSettings, getSetting, setSetting } from './db/repos/settings.js';
import { getCombo, type Combo } from './db/repos/combos.js';
import { resolveModel } from './providers/alias.js';
import { getUpstreamFormat } from './providers/format/negotiate.js';
import {
  bodyAddsOpenAIStreamUsage,
  bodyAnthropicToOpenAI,
  bodyOpenAIToAnthropic,
  responseAnthropicToOpenAI,
  responseOpenAIToAnthropic,
} from './providers/format/transform.js';
import { kiroResponseToAnthropicSSE } from './providers/kiro/anthropicSse.js';
import { kiroResponseToOpenAISSE } from './providers/kiro/assembler.js';
import { executeKiro } from './providers/kiro/index.js';
import { fetchModels } from './providers/listModels.js';
import { PROVIDER, upstreamHeaders, upstreamUrl } from './providers/minimax.js';
import { parseError } from './providers/parseError.js';
import { calculateCost } from './providers/pricing.js';
import { upstreamFetch } from './providers/upstreamFetch.js';
import { headersToJson, truncateBody } from './proxy/capture.js';
import { compressMessages, formatRtkLog } from './rtk/index.js';
import { markHotPath } from './runtime/hotPathMetrics.js';
import { startQuotaPuller, stopQuotaPuller } from './scheduler/quotaPull.js';
import { pipeWithUsage } from './streaming/pipeWithUsage.js';
import { resolveTransportForAccount } from './transport/resolve.js';
import { getHost, getPort } from './util/env.js';
import { log } from './util/log.js';

function safeJsonParse(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function statusCode(value: number): ContentfulStatusCode {
  return value as ContentfulStatusCode;
}

let _db: Database.Database | null = null;
function getDb(): Database.Database {
  if (!_db) _db = openDb();
  return _db;
}

let rrCursor = 0;
const stickyMap = new Map<number, string>();

const app = new Hono();
app.use('*', async (c, next) => {
  c.set('db', getDb());
  c.set('startTime', Date.now());
  await next();
});
app.route('/api', adminApi());

app.use('/admin/*', async (c, next) => {
  if (c.req.method !== 'GET' && c.req.method !== 'HEAD') {
    if (!verifySameOrigin(c)) {
      return c.json({ error: 'cross-origin request blocked' }, 403);
    }
  }
  await next();
});

app.get('/health', (c) => c.json({ ok: true }));

app.post('/login', handleLogin);
app.post('/logout', handleLogout);

/**
 * handleComboProxy — fallback chain handler.
 * Iterates through the combo's model list in order. For each model:
 *   1. Resolve model (via alias system)
 *   2. Select account from the pool
 *   3. Attempt upstream fetch
 *   4. On 429 or model-lock: try next model in the chain
 *   5. On success or non-retryable error: return response
 */
async function handleComboProxy(
  c: Context,
  format: 'openai' | 'anthropic',
  upstreamPath: string,
  body: Record<string, unknown>,
  originalText: string,
  db: ReturnType<typeof getDb>,
  combo: Combo
): Promise<Response> {
  const clientKey = c.get('clientKey');
  const startMs = c.get('startTime');
  const allSettings = getAllSettings(db);
  const minimax = allSettings.minimax as { upstreamFormat?: string } | undefined;
  const overrideRaw = minimax?.upstreamFormat ?? process.env.ROUTER_UPSTREAM_FORMAT ?? 'auto';
  const upstreamFormat = getUpstreamFormat(format, overrideRaw as 'auto' | 'openai' | 'anthropic');

  const reqId = genReqId();
  c.set('reqId', reqId);
  consoleBus.emit(
    buildStart(
      reqId,
      new Date().toISOString(),
      c.req.method,
      upstreamPath,
      `combo:${combo.name}`,
      combo.name
    )
  );

  // Augment body (caveman, caching, rtk) just like handleProxy does.
  let bodyDirty = false;
  const caveman = allSettings.caveman as { level: string } | undefined;
  const caching = allSettings.caching as
    | { autoBreakpoints: boolean; respectCallerMarkers: boolean }
    | undefined;
  const rtkSetting = allSettings.rtk as { enabled: boolean } | undefined;
  const cavemanOn = !!caveman?.level && caveman.level !== 'off';
  const cachingOn = !!caching?.autoBreakpoints;
  if (cavemanOn || cachingOn) {
    await augmentRequest(body, allSettings as Parameters<typeof augmentRequest>[1]);
    bodyDirty = true;
  }
  if (rtkSetting?.enabled) {
    compressMessages(body, true);
    bodyDirty = true;
  }

  // OpenAI streaming: ensure include_usage
  if (upstreamFormat === 'openai') {
    const withUsage = bodyAddsOpenAIStreamUsage(body);
    if (withUsage !== body) {
      Object.assign(body, withUsage);
      bodyDirty = true;
    }
  }

  // Cross-format body conversion
  if (format !== upstreamFormat) {
    if (format === 'openai' && upstreamFormat === 'anthropic') {
      Object.assign(body, bodyOpenAIToAnthropic(body));
    } else if (format === 'anthropic' && upstreamFormat === 'openai') {
      Object.assign(body, bodyAnthropicToOpenAI(body));
    }
    bodyDirty = true;
  }

  // Account pool
  const allAccounts = listEnabledAccounts(db);
  if (allAccounts.length === 0) {
    return c.json({ error: 'no upstream accounts configured' }, 503);
  }
  const accountStates: AccountState[] = allAccounts.map((a) => ({
    id: a.id,
    backoffLevel: a.backoff_level,
    rateLimitedUntil: a.rate_limited_until,
    lastError: a.last_error ? (safeJsonParse(a.last_error) as AccountState['lastError']) : null,
    status: a.status as AccountState['status'],
    enabled: !!a.enabled,
  }));
  const selMode = (getSetting<{ mode: SelectionMode }>(db, 'selection'))?.mode ?? 'lowest-backoff';
  const { account, reason, nextCursor } = selectAccount(accountStates, {
    mode: selMode,
    cursor: rrCursor,
    clientKeyId: clientKey?.id,
    stickyMap,
  });
  if (nextCursor != null) rrCursor = nextCursor;
  if (!account) return c.json({ error: 'all accounts unavailable' }, 503);
  const acc = allAccounts.find((a) => a.id === account.id)!;
  consoleBus.emit(buildAccount(reqId, new Date().toISOString(), acc.label, reason));

  let lastErrorResponse: Response | null = null;

  for (let i = 0; i < combo.models.length; i++) {
    const modelName = combo.models[i]!;
    let resolved;
    try {
      resolved = resolveModel(db, modelName, body);
    } catch {
      // Model not found/disabled — skip to next in chain
      log.warn({ combo: combo.name, model: modelName }, 'combo: model not resolvable, skipping');
      continue;
    }

    // Apply model body transform
    const attemptBody = { ...body };
    attemptBody.model = resolved.upstreamModel;
    resolved.bodyTransform(attemptBody);

    // Check model lock
    clearExpiredModelLocks(db);
    if (isModelLockActive(getModelLock(db, account.id, resolved.upstreamModel))) {
      log.info({ combo: combo.name, model: modelName }, 'combo: model locked, trying next');
      continue;
    }

    // Kiro provider: delegate to handleKiroProxy for this model
    if (resolved.provider === 'kiro') {
      try {
        const kiroBody = { ...body, model: modelName };
        const kiroResp = await handleKiroProxy(c, format, upstreamPath, kiroBody, db);
        // If we get here without throw, check status
        if (kiroResp.status === 429) {
          log.info({ combo: combo.name, model: modelName, status: 429 }, 'combo: kiro rate limited, trying next model');
          lastErrorResponse = kiroResp;
          continue;
        }
        // Success or non-retryable error
        log.info({ combo: combo.name, model: modelName, index: i }, 'combo: kiro success on model');
        return kiroResp;
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        log.warn({ combo: combo.name, model: modelName, error: msg }, 'combo: kiro model failed, trying next');
        lastErrorResponse = c.json({ error: msg }, 502);
        continue;
      }
    }

    const url = upstreamUrl(
      { provider: PROVIDER, apiKey: acc.api_key, baseUrl: acc.base_url },
      upstreamFormat,
      upstreamPath
    );
    const headers = upstreamHeaders(
      { provider: PROVIDER, apiKey: acc.api_key, baseUrl: acc.base_url },
      attemptBody.stream === true,
      upstreamFormat
    );
    const transport = resolveTransportForAccount(db, acc);

    try {
      const upstreamBody = JSON.stringify(attemptBody);
      const resp = await upstreamFetch(url, upstreamBody, headers, transport);

      if (!resp.ok) {
        const errBody = await resp.text();
        const parsed = parseError(resp, errBody);
        const decision = checkFallbackError(
          resp.status,
          parsed.message,
          parsed.baseRespCode,
          acc.backoff_level,
          parsed.windowResetMs,
          parsed.retryAfterSec ? parsed.retryAfterSec * 1000 : undefined
        );

        // Apply account error state
        const rateLimitedUntil =
          decision.cooldownMs > 0
            ? new Date(Date.now() + decision.cooldownMs).toISOString()
            : null;
        updateAccount(db, account.id, {
          rate_limited_until: rateLimitedUntil,
          backoff_level: decision.newBackoffLevel ?? 0,
          last_error: JSON.stringify({
            status: resp.status,
            message: errBody.slice(0, 500),
            timestamp: new Date().toISOString(),
            baseRespCode: parsed.baseRespCode,
          }),
          status: resp.status === 401 ? 'error' : 'active',
        });
        if (decision.cooldownMs > 0) {
          setModelLock(db, account.id, resolved.upstreamModel, decision.cooldownMs);
        }
        if (decision.source === 'balance') {
          disableAccount(db, account.id);
        }

        // Only retry on 429 (rate limit). Other errors are non-retryable.
        if (resp.status === 429) {
          log.info(
            { combo: combo.name, model: modelName, status: resp.status },
            'combo: rate limited, trying next model'
          );
          lastErrorResponse = c.body(errBody, statusCode(resp.status), {
            'content-type': resp.headers.get('content-type') ?? 'application/json',
          });
          continue;
        }

        // Non-retryable error — return immediately
        consoleBus.emit(
          buildError(reqId, new Date().toISOString(), resp.status, errBody.slice(0, 200))
        );
        return c.body(errBody, statusCode(resp.status), {
          'content-type': resp.headers.get('content-type') ?? 'application/json',
        });
      }

      // Success! Clear account errors.
      if (
        acc.backoff_level !== 0 ||
        acc.status !== 'active' ||
        acc.rate_limited_until !== null ||
        acc.last_error !== null
      ) {
        updateAccount(db, account.id, {
          rate_limited_until: null,
          backoff_level: 0,
          last_error: null,
          status: 'active',
        });
      }

      log.info(
        { combo: combo.name, model: modelName, index: i },
        'combo: success on model'
      );

      // Handle streaming response
      if (attemptBody.stream === true) {
        const piped = await pipeWithUsage(resp, format, (usage, raw) => {
          const prompt = usage?.prompt_tokens ?? 0;
          const completion = usage?.completion_tokens ?? 0;
          const cacheCreate = usage?.cache_creation_tokens ?? 0;
          const cacheRead = usage?.cache_read_tokens ?? 0;
          const total = usage?.total_tokens ?? prompt + completion;
          const cost = calculateCost(db, resolved.upstreamModel, {
            prompt_tokens: prompt,
            completion_tokens: completion,
            cache_creation_tokens: cacheCreate,
            cache_read_tokens: cacheRead,
          });
          insertRequestLogDeferred(db, {
            client_key_id: clientKey.id,
            account_id: account.id,
            model: resolved.upstreamModel,
            requested_model: combo.name,
            endpoint: upstreamPath,
            format: upstreamFormat,
            prompt_tokens: prompt,
            completion_tokens: completion,
            cache_creation_tokens: cacheCreate,
            cache_read_tokens: cacheRead,
            total_tokens: total,
            cost_usd: cost,
            latency_ms: Date.now() - startMs,
            status_code: resp.status,
            base_resp_code: undefined,
            stream: 1,
            rtk_bytes_saved: 0,
            request_body: truncateBody(originalText),
            response_body: truncateBody(raw),
            request_headers: headersToJson(c.req.raw.headers),
            response_headers: headersToJson(resp.headers),
            req_id: reqId,
          });
          consoleBus.emit(
            buildDone(
              reqId,
              new Date().toISOString(),
              resp.status,
              null,
              prompt,
              completion,
              cacheRead,
              cost,
              Date.now() - startMs
            )
          );
        });
        return piped;
      }

      // Handle buffered response
      let respBody = await resp.text();
      let usage: {
        prompt_tokens?: number;
        completion_tokens?: number;
        total_tokens?: number;
        cache_creation_tokens?: number;
        prompt_tokens_details?: { cached_tokens?: number };
      } = {};
      try {
        const parsedResp = JSON.parse(respBody) as { usage?: typeof usage } & Record<string, unknown>;
        if (format !== upstreamFormat) {
          const converted =
            upstreamFormat === 'anthropic'
              ? responseAnthropicToOpenAI(parsedResp as Parameters<typeof responseAnthropicToOpenAI>[0])
              : responseOpenAIToAnthropic(parsedResp as Parameters<typeof responseOpenAIToAnthropic>[0]);
          respBody = JSON.stringify(converted);
          const convUsage = (converted as { usage?: typeof usage }).usage;
          usage = convUsage ?? parsedResp.usage ?? {};
        } else {
          usage = parsedResp.usage ?? {};
        }
      } catch {
        /* non-JSON; pass through */
      }
      const cost = calculateCost(db, resolved.upstreamModel, {
        prompt_tokens: usage.prompt_tokens ?? 0,
        completion_tokens: usage.completion_tokens ?? 0,
        cache_creation_tokens: usage.cache_creation_tokens ?? 0,
        cache_read_tokens: usage.prompt_tokens_details?.cached_tokens ?? 0,
      });
      insertRequestLogDeferred(db, {
        client_key_id: clientKey.id,
        account_id: account.id,
        model: resolved.upstreamModel,
        requested_model: combo.name,
        endpoint: upstreamPath,
        format: upstreamFormat,
        prompt_tokens: usage.prompt_tokens ?? 0,
        completion_tokens: usage.completion_tokens ?? 0,
        cache_creation_tokens: usage.cache_creation_tokens ?? 0,
        cache_read_tokens: usage.prompt_tokens_details?.cached_tokens ?? 0,
        total_tokens: usage.total_tokens ?? 0,
        cost_usd: cost,
        latency_ms: Date.now() - startMs,
        status_code: resp.status,
        base_resp_code: undefined,
        stream: 0,
        rtk_bytes_saved: 0,
        request_body: truncateBody(originalText),
        response_body: truncateBody(respBody),
        request_headers: headersToJson(c.req.raw.headers),
        response_headers: headersToJson(resp.headers),
        req_id: reqId,
      });
      consoleBus.emit(
        buildDone(
          reqId,
          new Date().toISOString(),
          resp.status,
          null,
          usage.prompt_tokens ?? 0,
          usage.completion_tokens ?? 0,
          usage.prompt_tokens_details?.cached_tokens ?? 0,
          cost,
          Date.now() - startMs
        )
      );
      return c.body(respBody, statusCode(resp.status), {
        'content-type': resp.headers.get('content-type') ?? 'application/json',
      });
    } catch (e: unknown) {
      const message = errorMessage(e);
      log.warn({ combo: combo.name, model: modelName, err: message }, 'combo: upstream error');
      lastErrorResponse = c.json({ error: `upstream unreachable: ${message}` }, 502);
      // Network errors are retryable within the combo chain
      continue;
    }
  }

  // All models in the combo exhausted
  consoleBus.emit(buildError(reqId, new Date().toISOString(), 429, 'combo: all models exhausted'));
  if (lastErrorResponse) return lastErrorResponse;
  return c.json({ error: `combo ${combo.name}: all models exhausted` }, 429);
}

async function handleProxy(
  c: Context,
  format: 'openai' | 'anthropic',
  upstreamPath: string
): Promise<Response> {
  markHotPath('proxy:start');
  const clientKey = c.get('clientKey');
  const text = await c.req.text();
  if (text.length > 10 * 1024 * 1024) {
    return c.json({ error: 'request body exceeds 10MB limit' }, 413);
  }
  let body: Record<string, unknown> = {};
  if (text) {
    try {
      body = JSON.parse(text) as Record<string, unknown>;
    } catch (e: unknown) {
      return c.json({ error: `invalid JSON: ${errorMessage(e)}` }, 400);
    }
  }
  let bodyDirty = false;
  markHotPath('proxy:body-parsed');
  const db = c.get('db');
  const allSettings = getAllSettings(db);

  // Combo/fallback chain: if the requested model matches a combo name, handle
  // it via the combo fallback loop (try each model in sequence).
  const comboName = stringValue(body.model);
  const combo = getCombo(db, comboName);
  if (combo) {
    return await handleComboProxy(c, format, upstreamPath, body, text, db, combo);
  }

  // Provider routing: if the requested model belongs to a non-MiniMax provider,
  // branch to that provider's path. Unknown models fall through to the MiniMax
  // path, which surfaces the canonical 400 from resolveModel below.
  try {
    const peek = resolveModel(db, stringValue(body.model), body);
    if (peek.provider === 'kiro') {
      return await handleKiroProxy(c, format, upstreamPath, body, db);
    }
  } catch {
    /* unknown model — defer to the MiniMax path for the canonical error */
  }

  const caveman = allSettings.caveman as { level: string } | undefined;
  const caching = allSettings.caching as
    | { autoBreakpoints: boolean; respectCallerMarkers: boolean }
    | undefined;
  const rtkSetting = allSettings.rtk as { enabled: boolean } | undefined;
  const minimax = allSettings.minimax as { upstreamFormat?: string } | undefined;
  const cavemanOn = !!caveman?.level && caveman.level !== 'off';
  const cachingOn = !!caching?.autoBreakpoints;
  if (cavemanOn || cachingOn) {
    await augmentRequest(body, allSettings as Parameters<typeof augmentRequest>[1]);
    bodyDirty = true;
  }

  if (rtkSetting?.enabled) {
    const stats = compressMessages(body, true);
    const rtkLog = formatRtkLog(stats);
    if (rtkLog) console.log(rtkLog);
    // compressMessages mutates messages in-place (even when it ultimately returns
    // null), so any rtk-enabled request may have a changed body — mark dirty.
    bodyDirty = true;
  }

  // Determine upstream format. Default = same as client. Override via
  // settings.minimax.upstreamFormat or ROUTER_UPSTREAM_FORMAT env.
  const overrideRaw = minimax?.upstreamFormat ?? process.env.ROUTER_UPSTREAM_FORMAT ?? 'auto';
  const upstreamFormat = getUpstreamFormat(format, overrideRaw as 'auto' | 'openai' | 'anthropic');

  // OpenAI streaming: ensure include_usage so the final chunk carries usage.
  // bodyAddsOpenAIStreamUsage returns a NEW object (only when stream===true and
  // include_usage not already set); capture it and mark dirty so the fast path
  // re-serializes the injected body.
  if (upstreamFormat === 'openai') {
    const withUsage = bodyAddsOpenAIStreamUsage(body);
    if (withUsage !== body) {
      Object.assign(body, withUsage);
      bodyDirty = true;
    }
  }

  // Cross-format body conversion (only when client != upstream).
  if (format !== upstreamFormat) {
    if (format === 'openai' && upstreamFormat === 'anthropic') {
      Object.assign(body, bodyOpenAIToAnthropic(body));
    } else if (format === 'anthropic' && upstreamFormat === 'openai') {
      Object.assign(body, bodyAnthropicToOpenAI(body));
    }
    bodyDirty = true;
  }

  // Pool: ALL enabled MiniMax accounts (shared across all client keys).
  const allAccounts = listEnabledAccounts(db);
  if (allAccounts.length === 0) {
    return c.json({ error: 'no upstream accounts configured' }, 503);
  }
  const accountStates: AccountState[] = allAccounts.map((a) => ({
    id: a.id,
    backoffLevel: a.backoff_level,
    rateLimitedUntil: a.rate_limited_until,
    lastError: a.last_error ? (safeJsonParse(a.last_error) as AccountState['lastError']) : null,
    status: a.status as AccountState['status'],
    enabled: !!a.enabled,
  }));
  const selMode = (getSetting<{ mode: SelectionMode }>(db, 'selection'))?.mode ?? 'lowest-backoff';
  const { account, reason, nextCursor } = selectAccount(accountStates, {
    mode: selMode,
    cursor: rrCursor,
    clientKeyId: clientKey?.id,
    stickyMap,
  });
  if (nextCursor != null) rrCursor = nextCursor;
  if (!account) return c.json({ error: 'all accounts unavailable' }, 503);
  const acc = allAccounts.find((a) => a.id === account.id)!;
  markHotPath('proxy:account-selected');

  let resolved;
  try {
    resolved = resolveModel(db, stringValue(body.model), body);
    const origModel = body.model;
    // NOTE: this snapshot must list EVERY field resolved.bodyTransform may write.
    // bodyTransform currently writes: thinking, max_completion_tokens, reasoning_split.
    // If you add a field there, add it here too or the fast path will skip re-serialization.
    const beforeThinking = body.thinking;
    const beforeMaxCT = body.max_completion_tokens;
    const beforeReasoning = body.reasoning_split;
    body.model = resolved.upstreamModel;
    resolved.bodyTransform(body);
    if (
      body.model !== origModel ||
      body.thinking !== beforeThinking ||
      body.max_completion_tokens !== beforeMaxCT ||
      body.reasoning_split !== beforeReasoning
    ) {
      bodyDirty = true;
    }
  } catch (e: unknown) {
    return c.json({ error: errorMessage(e) }, 400);
  }
  const requestedModel = resolved.requestedModel;
  markHotPath('proxy:model-resolved');

  const reqId = genReqId();
  c.set('reqId', reqId);
  consoleBus.emit(
    buildStart(
      reqId,
      new Date().toISOString(),
      c.req.method,
      upstreamPath,
      resolved.upstreamModel,
      requestedModel && requestedModel !== resolved.upstreamModel ? requestedModel : null
    )
  );
  consoleBus.emit(buildAccount(reqId, new Date().toISOString(), acc.label, reason));

  clearExpiredModelLocks(db);
  if (isModelLockActive(getModelLock(db, account.id, resolved.upstreamModel))) {
    return c.json({ error: `model ${resolved.upstreamModel} temporarily locked` }, 429);
  }

  const url = upstreamUrl(
    { provider: PROVIDER, apiKey: acc.api_key, baseUrl: acc.base_url },
    upstreamFormat,
    upstreamPath
  );
  const headers = upstreamHeaders(
    { provider: PROVIDER, apiKey: acc.api_key, baseUrl: acc.base_url },
    body.stream === true,
    upstreamFormat
  );
  const transport = resolveTransportForAccount(db, acc);
  markHotPath('proxy:transport-resolved');
  if (transport) {
    if (transport.relay) {
      consoleBus.emit(
        buildTransport(reqId, new Date().toISOString(), 'relay', transport.relay.url)
      );
    } else if (transport.proxy) {
      consoleBus.emit(
        buildTransport(reqId, new Date().toISOString(), 'proxy', transport.proxy.url)
      );
    }
  }

  try {
    const upstreamBody = bodyDirty ? body : text || '{}';
    markHotPath('proxy:upstream-fetch-start');
    const resp = await upstreamFetch(url, upstreamBody, headers, transport);
    markHotPath('proxy:upstream-fetch-response');
    if (!resp.ok) {
      const errBody = await resp.text();
      const parsed = parseError(resp, errBody);
      const decision = checkFallbackError(
        resp.status,
        parsed.message,
        parsed.baseRespCode,
        acc.backoff_level,
        parsed.windowResetMs,
        parsed.retryAfterSec ? parsed.retryAfterSec * 1000 : undefined
      );
      const rateLimitedUntil =
        decision.cooldownMs > 0 ? new Date(Date.now() + decision.cooldownMs).toISOString() : null;
      updateAccount(db, account.id, {
        rate_limited_until: rateLimitedUntil,
        backoff_level: decision.newBackoffLevel ?? 0,
        last_error: JSON.stringify({
          status: resp.status,
          message: errBody.slice(0, 500),
          timestamp: new Date().toISOString(),
          baseRespCode: parsed.baseRespCode,
        }),
        status: resp.status === 401 ? 'error' : 'active',
      });
      if (decision.cooldownMs > 0) {
        setModelLock(db, account.id, resolved.upstreamModel, decision.cooldownMs);
      }
      if (decision.source === 'balance') {
        disableAccount(db, account.id);
      }
      consoleBus.emit(
        buildError(reqId, new Date().toISOString(), resp.status, errBody.slice(0, 200))
      );
      return c.body(errBody, statusCode(resp.status), {
        'content-type': resp.headers.get('content-type') ?? 'application/json',
      });
    }
    if (
      acc.backoff_level !== 0 ||
      acc.status !== 'active' ||
      acc.rate_limited_until !== null ||
      acc.last_error !== null
    ) {
      updateAccount(db, account.id, {
        rate_limited_until: null,
        backoff_level: 0,
        last_error: null,
        status: 'active',
      });
    }

    if (body.stream === true) {
      const startMs = c.get('startTime');
      const clientKeyId = clientKey.id;
      const accountId = account.id;
      const modelName = stringValue(body.model);
      const piped = await pipeWithUsage(resp, format, (usage, raw) => {
        const prompt = usage?.prompt_tokens ?? 0;
        const completion = usage?.completion_tokens ?? 0;
        const cacheCreate = usage?.cache_creation_tokens ?? 0;
        const cacheRead = usage?.cache_read_tokens ?? 0;
        const total = usage?.total_tokens ?? prompt + completion;
        const cost = calculateCost(db, modelName, {
          prompt_tokens: prompt,
          completion_tokens: completion,
          cache_creation_tokens: cacheCreate,
          cache_read_tokens: cacheRead,
        });
        insertRequestLogDeferred(db, {
          client_key_id: clientKeyId,
          account_id: accountId,
          model: modelName,
          requested_model: requestedModel,
          endpoint: upstreamPath,
          format: upstreamFormat,
          prompt_tokens: prompt,
          completion_tokens: completion,
          cache_creation_tokens: cacheCreate,
          cache_read_tokens: cacheRead,
          total_tokens: total,
          cost_usd: cost,
          latency_ms: Date.now() - startMs,
          status_code: resp.status,
          base_resp_code: undefined,
          stream: 1,
          rtk_bytes_saved: 0,
          request_body: truncateBody(text),
          response_body: truncateBody(raw),
          request_headers: headersToJson(c.req.raw.headers),
          response_headers: headersToJson(resp.headers),
          req_id: reqId,
        });
        consoleBus.emit(
          buildDone(
            reqId,
            new Date().toISOString(),
            resp.status,
            null,
            prompt,
            completion,
            cacheRead,
            cost,
            Date.now() - startMs
          )
        );
      });
      return piped;
    }

    let respBody = await resp.text();
    let usage: {
      prompt_tokens?: number;
      completion_tokens?: number;
      total_tokens?: number;
      cache_creation_tokens?: number;
      prompt_tokens_details?: { cached_tokens?: number };
    } = {};
    try {
      // Parse once, reuse for both cross-format conversion (if needed) and
      // usage extraction. Avoids a second JSON.parse on the same body.
      const parsed = JSON.parse(respBody) as { usage?: typeof usage } & Record<string, unknown>;
      if (format !== upstreamFormat) {
        const converted =
          upstreamFormat === 'anthropic'
            ? responseAnthropicToOpenAI(parsed as Parameters<typeof responseAnthropicToOpenAI>[0])
            : responseOpenAIToAnthropic(parsed as Parameters<typeof responseOpenAIToAnthropic>[0]);
        respBody = JSON.stringify(converted);
        const convUsage = (converted as { usage?: typeof usage }).usage;
        usage = convUsage ?? parsed.usage ?? {};
      } else {
        usage = parsed.usage ?? {};
      }
    } catch {
      /* non-JSON or malformed; pass through */
    }
    const cost = calculateCost(db, stringValue(body.model), {
      prompt_tokens: usage.prompt_tokens ?? 0,
      completion_tokens: usage.completion_tokens ?? 0,
      cache_creation_tokens: usage.cache_creation_tokens ?? 0,
      cache_read_tokens: usage.prompt_tokens_details?.cached_tokens ?? 0,
    });
    insertRequestLogDeferred(db, {
      client_key_id: clientKey.id,
      account_id: account.id,
      model: stringValue(body.model),
      requested_model: requestedModel,
      endpoint: upstreamPath,
      format: upstreamFormat,
      prompt_tokens: usage.prompt_tokens ?? 0,
      completion_tokens: usage.completion_tokens ?? 0,
      cache_creation_tokens: usage.cache_creation_tokens ?? 0,
      cache_read_tokens: usage.prompt_tokens_details?.cached_tokens ?? 0,
      total_tokens: usage.total_tokens ?? 0,
      cost_usd: cost,
      latency_ms: Date.now() - c.get('startTime'),
      status_code: resp.status,
      base_resp_code: undefined,
      stream: 0,
      rtk_bytes_saved: 0,
      request_body: truncateBody(text),
      response_body: truncateBody(respBody),
      request_headers: headersToJson(c.req.raw.headers),
      response_headers: headersToJson(resp.headers),
      req_id: reqId,
    });
    consoleBus.emit(
      buildDone(
        reqId,
        new Date().toISOString(),
        resp.status,
        null,
        usage.prompt_tokens ?? 0,
        usage.completion_tokens ?? 0,
        usage.prompt_tokens_details?.cached_tokens ?? 0,
        cost,
        Date.now() - c.get('startTime')
      )
    );
    return c.body(respBody, statusCode(resp.status), {
      'content-type': resp.headers.get('content-type') ?? 'application/json',
    });
  } catch (e: unknown) {
    const message = errorMessage(e);
    log.error({ err: message }, 'upstream unreachable');
    const rid = c.get('reqId') ?? '----';
    consoleBus.emit(buildError(rid, new Date().toISOString(), 502, message));
    return c.json({ error: `upstream unreachable: ${message}` }, 502);
  }
}

async function handleKiroProxy(
  c: Context,
  format: 'openai' | 'anthropic',
  upstreamPath: string,
  body: Record<string, unknown>,
  db: Database.Database
): Promise<Response> {
  const clientKey = c.get('clientKey');
  const startMs = c.get('startTime');

  // Kiro speaks OpenAI internally. Convert an Anthropic client body to OpenAI
  // first; the response is converted back below.
  const openaiBody = format === 'anthropic' ? { ...body, ...bodyAnthropicToOpenAI(body) } : body;
  const clientWantsStream = openaiBody.stream === true;
  // Kiro streams natively in both client formats now: OpenAI SSE chunks for
  // openai clients, Anthropic Messages SSE for anthropic clients (Claude Code /
  // hermes-agent). Only fall back to buffered when the client did not ask to
  // stream.
  const upstreamStream = clientWantsStream;

  let resolved: ReturnType<typeof resolveModel>;
  try {
    resolved = resolveModel(db, stringValue(body.model), body);
  } catch (e: unknown) {
    return c.json({ error: errorMessage(e) }, 400);
  }
  const requestedModel = resolved.requestedModel;
  const modelName = resolved.upstreamModel;

  const reqId = genReqId();
  c.set('reqId', reqId);
  consoleBus.emit(
    buildStart(
      reqId,
      new Date().toISOString(),
      c.req.method,
      upstreamPath,
      modelName,
      requestedModel ?? null
    )
  );

  const accounts = listEnabledAccountsByProvider(db, 'kiro');
  if (accounts.length === 0) return c.json({ error: 'no Kiro accounts configured' }, 503);
  const states: AccountState[] = accounts.map((a) => ({
    id: a.id,
    backoffLevel: a.backoff_level,
    rateLimitedUntil: a.rate_limited_until,
    lastError: a.last_error ? (safeJsonParse(a.last_error) as AccountState['lastError']) : null,
    status: a.status as AccountState['status'],
    enabled: !!a.enabled,
  }));
  const kiroSelMode =
    (getSetting(db, 'selection.mode') as SelectionMode | null) ?? 'lowest-backoff';
  const {
    account: picked,
    reason: kiroReason,
    nextCursor: kiroNext,
  } = selectAccount(states, {
    mode: kiroSelMode,
    cursor: rrCursor,
    clientKeyId: clientKey?.id,
    stickyMap,
  });
  if (kiroNext != null) rrCursor = kiroNext;
  if (!picked) return c.json({ error: 'all Kiro accounts unavailable' }, 503);
  const acc = accounts.find((a) => a.id === picked.id)!;
  consoleBus.emit(buildAccount(reqId, new Date().toISOString(), acc.label, kiroReason));

  const transport = resolveTransportForAccount(db, acc);
  if (transport) {
    if (transport.relay) {
      consoleBus.emit(
        buildTransport(reqId, new Date().toISOString(), 'relay', transport.relay.url)
      );
    } else if (transport.proxy) {
      consoleBus.emit(
        buildTransport(reqId, new Date().toISOString(), 'proxy', transport.proxy.url)
      );
    }
  }

  const logUsage = (
    usage: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number } | null,
    isStream: boolean,
    statusCode: number,
    responseBody: string
  ): void => {
    const prompt = usage?.prompt_tokens ?? 0;
    const completion = usage?.completion_tokens ?? 0;
    const cost = calculateCost(db, modelName, {
      prompt_tokens: prompt,
      completion_tokens: completion,
      cache_creation_tokens: 0,
      cache_read_tokens: 0,
    });
    insertRequestLogDeferred(db, {
      client_key_id: clientKey.id,
      account_id: acc.id,
      model: modelName,
      requested_model: requestedModel,
      endpoint: upstreamPath,
      format,
      prompt_tokens: prompt,
      completion_tokens: completion,
      cache_creation_tokens: 0,
      cache_read_tokens: 0,
      total_tokens: usage?.total_tokens ?? prompt + completion,
      cost_usd: cost,
      latency_ms: Date.now() - startMs,
      status_code: statusCode,
      base_resp_code: undefined,
      stream: isStream ? 1 : 0,
      rtk_bytes_saved: 0,
      request_body: truncateBody(JSON.stringify(body)),
      response_body: truncateBody(responseBody),
      request_headers: headersToJson(c.req.raw.headers),
      response_headers: undefined,
      req_id: reqId,
    });
    consoleBus.emit(
      buildDone(
        reqId,
        new Date().toISOString(),
        statusCode,
        null,
        prompt,
        completion,
        0,
        cost,
        Date.now() - startMs
      )
    );
  };

  try {
    const result = await executeKiro({
      db,
      account: acc,
      model: modelName,
      body: openaiBody,
      stream: upstreamStream,
      transport,
    });

    if (!result.ok) {
      const errBody = result.errorBody ?? '';
      const decision = checkFallbackError(
        result.status,
        errBody,
        undefined,
        acc.backoff_level,
        undefined,
        undefined
      );
      updateAccount(db, acc.id, {
        rate_limited_until:
          decision.cooldownMs > 0 ? new Date(Date.now() + decision.cooldownMs).toISOString() : null,
        backoff_level: decision.newBackoffLevel ?? 0,
        last_error: JSON.stringify({
          status: result.status,
          message: errBody.slice(0, 500),
          timestamp: new Date().toISOString(),
        }),
        status: result.status === 401 ? 'error' : 'active',
      });
      consoleBus.emit(
        buildError(reqId, new Date().toISOString(), result.status, errBody.slice(0, 200))
      );
      return c.body(
        errBody || JSON.stringify({ error: 'kiro upstream error' }),
        statusCode(result.status),
        {
          'content-type': 'application/json',
        }
      );
    }

    if (
      acc.backoff_level !== 0 ||
      acc.status !== 'active' ||
      acc.rate_limited_until !== null ||
      acc.last_error !== null
    ) {
      updateAccount(db, acc.id, {
        rate_limited_until: null,
        backoff_level: 0,
        last_error: null,
        status: 'active',
      });
    }

    if (upstreamStream && result.rawStreamResponse) {
      const sse =
        format === 'anthropic'
          ? kiroResponseToAnthropicSSE(result.rawStreamResponse, modelName)
          : kiroResponseToOpenAISSE(result.rawStreamResponse, modelName);
      return await pipeWithUsage(sse, format, (usage, raw) => {
        logUsage(usage, true, result.status, raw);
      });
    }

    const completion = result.json!;
    const respBody =
      format === 'anthropic'
        ? JSON.stringify(
            responseOpenAIToAnthropic(
              completion as unknown as Parameters<typeof responseOpenAIToAnthropic>[0]
            )
          )
        : JSON.stringify(completion);
    logUsage(completion.usage, false, result.status, respBody);
    return c.body(respBody, statusCode(result.status), { 'content-type': 'application/json' });
  } catch (e: unknown) {
    const message = errorMessage(e);
    log.error({ err: message }, 'kiro upstream error');
    const rid = c.get('reqId') ?? '----';
    consoleBus.emit(buildError(rid, new Date().toISOString(), 502, message));
    return c.json({ error: `kiro upstream error: ${message}` }, 502);
  }
}

app.post('/v1/chat/completions', requireApiKey, (c) =>
  handleProxy(c, 'openai', '/v1/chat/completions')
);
app.post('/v1/messages', requireApiKey, (c) => handleProxy(c, 'anthropic', '/v1/messages'));
app.post('/v1/messages/count_tokens', requireApiKey, (c) =>
  handleProxy(c, 'anthropic', '/v1/messages/count_tokens')
);
app.post('/v1/embeddings', requireApiKey, (c) =>
  c.json({ error: 'embeddings not supported by MiniMax' }, 501)
);

app.get('/api/admin/console/stream', requireAdmin, (c) =>
  streamSSE(c, async (stream) => {
    for (const ev of consoleBus.recent()) {
      await stream.writeSSE({ data: JSON.stringify(ev) });
    }
    let alive = true;
    const off = consoleBus.subscribe((ev) => {
      if (alive) void stream.writeSSE({ data: JSON.stringify(ev) });
    });
    stream.onAbort(() => {
      alive = false;
      off();
    });
    // Heartbeat until aborted.
    while (alive) {
      await stream.sleep(15000);
      if (alive) await stream.writeSSE({ data: '', event: 'ping' });
    }
  })
);
app.get('/v1/models', requireApiKey, async (c) => {
  const db = c.get('db');
  const allAccounts = listEnabledAccounts(db);
  if (allAccounts.length === 0) return c.json({ error: 'no upstream accounts configured' }, 503);
  const acc = allAccounts[0]!;
  const overrideRaw =
    (getSetting(db, 'minimax') as { upstreamFormat?: string } | null)?.upstreamFormat ?? 'auto';
  const upstreamFormat = getUpstreamFormat(
    'openai',
    overrideRaw as 'auto' | 'openai' | 'anthropic'
  );
  const url = upstreamUrl(
    { provider: PROVIDER, apiKey: acc.api_key, baseUrl: acc.base_url },
    upstreamFormat,
    '/v1/models'
  );
  const headers = upstreamHeaders(
    { provider: PROVIDER, apiKey: acc.api_key, baseUrl: acc.base_url },
    false,
    upstreamFormat
  );
  const transport = resolveTransportForAccount(db, acc);
  const resp = await upstreamFetch(url, {}, headers, transport);
  const text = await resp.text();
  return c.body(text, statusCode(resp.status), {
    'content-type': resp.headers.get('content-type') ?? 'application/json',
  });
});

app.post('/admin/models/fetch', requireAdmin, async (c) => {
  const db = c.get('db');
  const firstActive = listEnabledAccounts(db)[0];
  if (!firstActive)
    return c.json({ error: 'no active account — add a MiniMax upstream key first' }, 400);
  const result = await fetchModels(db, firstActive.api_key);
  if (!result.ok) {
    return c.json({ error: result.error ?? 'fetch failed', status: result.status }, 502);
  }
  return c.redirect(`/admin/models?fetched=${result.added ?? 0}`);
});
app.post('/admin/models/:name/enable', requireAdmin, (c) => {
  enableModel(c.get('db'), c.req.param('name')!);
  return c.redirect('/admin/models');
});
app.post('/admin/models/:name/disable', requireAdmin, (c) => {
  disableModel(c.get('db'), c.req.param('name')!);
  return c.redirect('/admin/models');
});

app.get('/admin', requireAdmin, (c) => c.redirect('/'));
app.get('/admin/usage', requireAdmin, (c) => c.redirect('/'));
app.get('/admin/accounts', requireAdmin, (c) => c.redirect('/'));
app.get('/admin/models', requireAdmin, (c) => c.redirect('/'));
app.get('/admin/quota', requireAdmin, (c) => c.redirect('/'));
app.get('/admin/settings', requireAdmin, (c) => c.redirect('/'));
app.get('/admin/client-keys', requireAdmin, (c) => c.redirect('/'));

app.post('/admin/accounts', requireAdmin, async (c) => {
  const body = await c.req.parseBody();
  const id = `acc_${ulid()}`;
  createAccount(c.get('db'), {
    id,
    label: String(body.label),
    credit_type: String(body.credit_type) as 'payg' | 'token-plan',
    api_key: String(body.api_key),
  });
  return c.redirect('/admin/accounts');
});
app.post('/admin/accounts/:id/enable', requireAdmin, (c) => {
  enableAccount(c.get('db'), c.req.param('id')!);
  return c.redirect('/admin/accounts');
});
app.post('/admin/accounts/:id/disable', requireAdmin, (c) => {
  disableAccount(c.get('db'), c.req.param('id')!);
  return c.redirect('/admin/accounts');
});
app.post('/admin/accounts/:id/delete', requireAdmin, (c) => {
  deleteAccount(c.get('db'), c.req.param('id')!);
  return c.redirect('/admin/accounts');
});

app.post('/admin/client-keys', requireAdmin, async (c) => {
  const body = await c.req.parseBody();
  const label = String(body.label ?? '').trim();
  if (!label) return c.redirect('/admin/client-keys');
  createClientKey(c.get('db'), { label, key: genClientKey() });
  return c.redirect('/admin/client-keys');
});
app.post('/admin/client-keys/:id/enable', requireAdmin, (c) => {
  enableClientKey(c.get('db'), Number(c.req.param('id')));
  return c.redirect('/admin/client-keys');
});
app.post('/admin/client-keys/:id/disable', requireAdmin, (c) => {
  disableClientKey(c.get('db'), Number(c.req.param('id')));
  return c.redirect('/admin/client-keys');
});
app.post('/admin/client-keys/:id/delete', requireAdmin, (c) => {
  deleteClientKey(c.get('db'), Number(c.req.param('id')));
  return c.redirect('/admin/client-keys');
});

app.post('/admin/settings/password', requireAdmin, async (c) => {
  const body = await c.req.parseBody();
  const action = String(body.action ?? '');
  if (action === 'clear') {
    setSetting(c.get('db'), 'admin_password', null);
  } else {
    const pw = String(body.password ?? '');
    if (pw.length >= 4) setPassword(c.get('db'), pw);
  }
  return c.redirect('/admin/settings');
});

app.post('/admin/settings/minimax', requireAdmin, async (c) => {
  const body = await c.req.parseBody();
  const current = (getSetting(c.get('db'), 'minimax') as Record<string, unknown> | null) ?? {};
  const next = {
    ...current,
    upstreamFormat: String((body as Record<string, string>).upstreamFormat ?? 'auto'),
    m3DefaultMaxCompletionTokens: Number(
      (body as Record<string, string>).m3DefaultMaxCompletionTokens ?? 131072
    ),
  };
  setSetting(c.get('db'), 'minimax', next);
  return c.redirect('/admin/settings');
});

app.post('/admin/settings/caveman', requireAdmin, async (c) => {
  const body = await c.req.parseBody();
  setSetting(c.get('db'), 'caveman', { level: String(body.level) });
  return c.redirect('/admin/settings');
});
app.post('/admin/settings/rtk', requireAdmin, async (c) => {
  const body = await c.req.parseBody();
  setSetting(c.get('db'), 'rtk', { enabled: body.enabled === 'on' || body.enabled === 'true' });
  return c.redirect('/admin/settings');
});
app.post('/admin/settings/caching', requireAdmin, async (c) => {
  const body = await c.req.parseBody();
  setSetting(c.get('db'), 'caching', { autoBreakpoints: body.autoBreakpoints === 'on' });
  return c.redirect('/admin/settings');
});

export { app };

export function resetDb(): void {
  if (_db) {
    try {
      _db.close();
    } catch {
      /* already closed */
    }
  }
  _db = null;
}

// Serve built SPA if client/dist exists. In dev with `npm run dev`, Vite serves on
// :5173 with HMR; users should browse there. Visiting :20137 in dev will also serve
// the built SPA (no HMR) so URLs stay consistent.
if (existsSync('./client/dist/index.html')) {
  try {
    const { serveStatic } = await import('@hono/node-server/serve-static');
    const distRoot = './client/dist';
    app.use('/assets/*', serveStatic({ root: distRoot }));
    app.get('*', serveStatic({ path: './index.html', root: distRoot }));
    log.info({ root: distRoot }, 'serving SPA from client/dist');
  } catch (e) {
    log.warn({ err: (e as Error).message }, 'serveStatic unavailable; SPA not served');
  }
}

if (true) { // patched for Windows: import.meta.url guard doesn't work with backslash paths
  const port = getPort();
  const hostname = getHost();
  serve({ fetch: app.fetch, port, hostname }, (info) => {
    log.info({ address: info.address, port: info.port }, 'router listening');
    startQuotaPuller(getDb(), 5 * 60_000);
    attachStdoutSink(consoleBus);
  });

  async function gracefulShutdown(signal: string): Promise<void> {
    log.info({ signal }, 'shutting down');
    stopQuotaPuller();
    await flushDeferredLogs();
    if (_db) {
      try {
        _db.close();
      } catch {
        /* ignore */
      }
      _db = null;
    }
    process.exit(0);
  }
  process.on('SIGTERM', () => void gracefulShutdown('SIGTERM'));
  process.on('SIGINT', () => void gracefulShutdown('SIGINT'));
}
