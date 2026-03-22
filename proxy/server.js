import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';

dotenv.config();

const app = express();
app.use(cors({ origin: '*' }));
app.use(express.json({ limit: '1mb' }));

const baseUrl = process.env.SUNBIRD_BASE_URL || 'https://api.sunbird.ai';
const token = process.env.SUNBIRD_TOKEN || '';
const endpoints = (process.env.SUNBIRD_TRANSLATE_ENDPOINTS || '/tasks/translate')
  .split(',')
  .map((x) => x.trim())
  .filter(Boolean);
const port = Number(process.env.PORT || 8787);

const translateConcurrency = Math.max(1, Number(process.env.TRANSLATE_CONCURRENCY || 8));
const requestTimeoutMs = Math.max(1000, Number(process.env.SUNBIRD_REQUEST_TIMEOUT_MS || 20000));
const retryCount = Math.max(0, Number(process.env.SUNBIRD_RETRY_COUNT || 1));
const translationCacheMaxEntries = Math.max(100, Number(process.env.TRANSLATION_CACHE_MAX_ENTRIES || 5000));
const maxRequestsPerMinute = Math.max(1, Number(process.env.SUNBIRD_MAX_REQUESTS_PER_MINUTE || 45));
const logLevel = (process.env.LOG_LEVEL || 'info').toLowerCase();
const debugTranslation = ['1', 'true', 'yes', 'on'].includes(String(process.env.DEBUG_TRANSLATION || '').toLowerCase());
const translationCache = new Map();
const upstreamRequestTimestamps = [];
let requestSeq = 0;

function logAtLevel(level, message, data = null) {
  const rank = { error: 0, warn: 1, info: 2, debug: 3 };
  const current = rank[logLevel] ?? 2;
  const target = rank[level] ?? 2;
  if (target > current) return;

  const payload = data ? ` ${JSON.stringify(data)}` : '';
  const line = `[proxy:${level}] ${message}${payload}`;

  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);
}

function logInfo(message, data = null) {
  logAtLevel('info', message, data);
}

function logDebug(message, data = null) {
  if (!debugTranslation) return;
  logAtLevel('debug', message, data);
}

function makeCacheKey(source_language, target_language, text) {
  return `${source_language}\u0001${target_language}\u0001${text}`;
}

function cacheGet(key) {
  if (!translationCache.has(key)) return null;
  const value = translationCache.get(key);
  translationCache.delete(key);
  translationCache.set(key, value);
  return value;
}

function cacheSet(key, value) {
  if (translationCache.has(key)) translationCache.delete(key);
  translationCache.set(key, value);
  if (translationCache.size > translationCacheMaxEntries) {
    const oldestKey = translationCache.keys().next().value;
    if (oldestKey !== undefined) translationCache.delete(oldestKey);
  }
}

function requireToken() {
  if (!token || token.startsWith('replace-with-your-token')) {
    const err = new Error('SUNBIRD_TOKEN is not configured.');
    err.status = 500;
    throw err;
  }
}

function makePayload(source_language, target_language, text) {
  return {
    source_language,
    target_language,
    text,
  };
}

function extractTextFromResult(result) {
  if (!result || typeof result !== 'object') return null;

  const candidates = [
    result?.output?.translated_text,
    result?.output?.text,
    result?.translated_text,
    result?.translation,
    result?.text,
    result?.result,
    Array.isArray(result?.output) ? result.output[0] : null,
  ];

  for (const c of candidates) {
    if (typeof c === 'string' && c.trim()) return c;
  }

  return null;
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseRetryAfterMs(headerValue) {
  if (!headerValue) return 0;
  const raw = String(headerValue).trim();
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds > 0) return Math.ceil(seconds * 1000);
  const at = Date.parse(raw);
  if (!Number.isNaN(at)) return Math.max(0, at - Date.now());
  return 0;
}

function nextRateSlotDelayMs() {
  const now = Date.now();
  const windowMs = 60_000;
  while (upstreamRequestTimestamps.length && now - upstreamRequestTimestamps[0] >= windowMs) {
    upstreamRequestTimestamps.shift();
  }
  if (upstreamRequestTimestamps.length < maxRequestsPerMinute) return 0;
  return Math.max(0, windowMs - (now - upstreamRequestTimestamps[0])) + 25;
}

async function acquireRateSlot() {
  while (true) {
    const delayMs = nextRateSlotDelayMs();
    if (delayMs <= 0) {
      upstreamRequestTimestamps.push(Date.now());
      return;
    }
    if (delayMs >= 1000) {
      logDebug('rate-limit-wait', { delayMs });
    }
    await wait(delayMs);
  }
}

function isRetriableStatus(status) {
  return status === 429 || status >= 500;
}

function decorateError(err, details = {}) {
  const e = err instanceof Error ? err : new Error(String(err || 'Unknown error'));
  e.details = { ...(e.details || {}), ...details };
  return e;
}

async function fetchWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (err) {
    if (err?.name === 'AbortError') {
      throw decorateError(new Error('Sunbird request timed out.'), { type: 'timeout', timeoutMs });
    }
    throw decorateError(err, { type: 'network' });
  } finally {
    clearTimeout(timeoutId);
  }
}

async function callSingleEndpoint({ source_language, target_language, text, endpoint }) {
  const payload = makePayload(source_language, target_language, text);
  const url = `${baseUrl}${endpoint}`;

  for (let attempt = 0; attempt <= retryCount; attempt++) {
    try {
      await acquireRateSlot();
      logDebug('sunbird-request', { endpoint, attempt: attempt + 1 });

      const res = await fetchWithTimeout(
        url,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify(payload),
        },
        requestTimeoutMs
      );

      const body = await res.json().catch(() => ({}));

      if (!res.ok) {
        const err = decorateError(new Error(body?.error || `Sunbird ${res.status} @ ${endpoint}`), {
          type: 'http',
          status: res.status,
          endpoint,
          attempt,
          responseBody: body,
        });

        logAtLevel(res.status === 429 ? 'warn' : 'error', 'sunbird-non-200', { endpoint, status: res.status, attempt: attempt + 1 });

        if (isRetriableStatus(res.status) && attempt < retryCount) {
          const retryAfterMs = parseRetryAfterMs(res.headers.get('retry-after'));
          const quotaDelayMs = res.status === 429 ? nextRateSlotDelayMs() : 0;
          const backoffMs = 250 * (attempt + 1);
          await wait(Math.max(backoffMs, retryAfterMs, quotaDelayMs, 1000));
          continue;
        }

        throw err;
      }

      const translated = extractTextFromResult(body);
      if (!translated) {
        throw decorateError(new Error(`No translated text field returned by ${endpoint}`), {
          type: 'schema',
          endpoint,
          attempt,
          responseBody: body,
        });
      }

      return translated;
    } catch (err) {
      const details = err?.details || {};
      const retriable = details.type === 'network' || details.type === 'timeout' || isRetriableStatus(details.status || 0);

      if (retriable && attempt < retryCount) {
        const quotaDelayMs = details.status === 429 ? nextRateSlotDelayMs() : 0;
        await wait(Math.max(250 * (attempt + 1), quotaDelayMs, 1000));
        continue;
      }

      throw decorateError(err, { endpoint, attempt });
    }
  }

  throw decorateError(new Error(`Retries exhausted for ${endpoint}`), { endpoint });
}

async function callSunbirdTranslate({ source_language, target_language, text }) {
  let lastErr = null;

  for (const endpoint of endpoints) {
    try {
      return await callSingleEndpoint({ source_language, target_language, text, endpoint });
    } catch (err) {
      lastErr = decorateError(err, { endpointTried: endpoint });
      continue;
    }
  }

  throw decorateError(lastErr || new Error('All Sunbird translation endpoints failed.'), {
    type: 'all_endpoints_failed',
    endpoints,
  });
}

async function mapWithConcurrency(items, limit, worker) {
  const results = new Array(items.length);
  let cursor = 0;

  async function runWorker() {
    while (true) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      results[index] = await worker(items[index], index);
    }
  }

  const workers = Array.from({ length: Math.min(limit, items.length) }, () => runWorker());
  await Promise.all(workers);
  return results;
}

app.get('/health', (_req, res) => {
  res.json({
    ok: true,
    endpoints,
    baseUrl,
    translateConcurrency,
    requestTimeoutMs,
    retryCount,
    translationCacheEntries: translationCache.size,
    translationCacheMaxEntries,
    maxRequestsPerMinute,
    queuedForRateLimit: Math.max(0, upstreamRequestTimestamps.length - maxRequestsPerMinute),
  });
});

app.post('/translate', async (req, res) => {
  try {
    requireToken();

    const reqId = ++requestSeq;
    const startedAt = Date.now();

    const { source_language = 'eng', target_language = 'nyn', texts } = req.body || {};

    if (!Array.isArray(texts) || !texts.length) {
      return res.status(400).json({ error: '`texts` must be a non-empty string array.' });
    }

    if (texts.some((t) => typeof t !== 'string')) {
      return res.status(400).json({ error: 'Every item in `texts` must be a string.' });
    }

    logInfo('translate-start', { reqId, count: texts.length, source_language, target_language });

    const uniqueTexts = [];
    const uniqueIndexByText = new Map();

    for (const text of texts) {
      if (!uniqueIndexByText.has(text)) {
        uniqueIndexByText.set(text, uniqueTexts.length);
        uniqueTexts.push(text);
      }
    }

    const uniqueTranslations = new Array(uniqueTexts.length);
    const missing = [];

    logInfo('translate-dedupe', { reqId, unique: uniqueTexts.length, duplicate: texts.length - uniqueTexts.length });

    for (let i = 0; i < uniqueTexts.length; i++) {
      const text = uniqueTexts[i];
      const key = makeCacheKey(source_language, target_language, text);
      const cached = cacheGet(key);
      if (typeof cached === 'string' && cached.length) {
        uniqueTranslations[i] = cached;
      } else {
        missing.push({ index: i, text, key });
      }
    }

    logInfo('translate-cache', { reqId, hit: uniqueTexts.length - missing.length, miss: missing.length });

    if (missing.length) {
      const translatedMissing = await mapWithConcurrency(missing, translateConcurrency, async (item) => {
        const translated = await callSunbirdTranslate({ source_language, target_language, text: item.text });
        cacheSet(item.key, translated);
        return { index: item.index, translated };
      });

      for (const item of translatedMissing) {
        uniqueTranslations[item.index] = item.translated;
      }
    }

    const translations = texts.map((text) => uniqueTranslations[uniqueIndexByText.get(text)] || text);

    logInfo('translate-done', { reqId, count: texts.length, durationMs: Date.now() - startedAt });

    res.json({ source_language, target_language, translations });
  } catch (err) {
    logAtLevel('error', 'translate-failed', { message: err?.message || 'Unexpected error', details: err?.details || null });
    res.status(err.status || 500).json({
      error: err.message || 'Unexpected error',
      details: err.details || null,
    });
  }
});

app.listen(port, () => {
  logInfo(`Sunbird proxy listening on http://localhost:${port}`, { endpoints, translateConcurrency, maxRequestsPerMinute, logLevel, debugTranslation });
});



