const statusEl = document.getElementById('status');
const translateBtn = document.getElementById('translateBtn');
const restoreBtn = document.getElementById('restoreBtn');
const copyBtn = document.getElementById('copyBtn');
const statePillEl = document.getElementById('statePill');
const progressBarEl = document.getElementById('progressBar');
const progressValueEl = document.getElementById('progressValue');
const elapsedValueEl = document.getElementById('elapsedValue');
const proxyValueEl = document.getElementById('proxyValue');
const versionBadgeEl = document.getElementById('versionBadge');

const PROXY_URL = 'https://wiki.soothingspotspa.care/translate';
const SOURCE_LANG = 'eng';
const TARGET_LANG = 'nyn';
const CHUNK_CHAR_LIMIT = 2000;
const REQUEST_TIMEOUT_MS = 120000;
const MAX_SPLIT_DEPTH = 5;
const PAGE_CHUNK_CONCURRENCY = 3;
const COPY_CHUNK_CONCURRENCY = 3;
const BUILD_ITERATION = 16;
const EXTENSION_VERSION = chrome.runtime?.getManifest?.().version || '0.0.0';

let isRunning = false;
let runStartedAt = 0;
let runTimer = null;
let progressPercent = 0;

function formatElapsed(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const m = String(Math.floor(total / 60)).padStart(2, '0');
  const s = String(total % 60).padStart(2, '0');
  return `${m}:${s}`;
}

function setProgress(percent) {
  progressPercent = Math.max(0, Math.min(100, Number(percent || 0)));
  if (progressBarEl) progressBarEl.style.width = `${progressPercent}%`;
  if (progressValueEl) progressValueEl.textContent = `${Math.round(progressPercent)}%`;
}

function setStatePill(state) {
  if (!statePillEl) return;
  statePillEl.classList.remove('running', 'success', 'error');
  if (state === 'running') {
    statePillEl.classList.add('running');
    statePillEl.textContent = 'Running';
    return;
  }
  if (state === 'success') {
    statePillEl.classList.add('success');
    statePillEl.textContent = 'Completed';
    return;
  }
  if (state === 'error') {
    statePillEl.classList.add('error');
    statePillEl.textContent = 'Failed';
    return;
  }
  statePillEl.textContent = 'Idle';
}

function statusTone(msg) {
  const text = String(msg || '').toLowerCase();
  if (text.includes('fail') || text.includes('error') || text.includes('timed out') || text.includes('unavailable')) return 'error';
  if (text.includes('done') || text.includes('copied') || text.includes('restored')) return 'success';
  if (text.includes('translating') || text.includes('starting') || text.includes('fetching') || text.includes('restoring')) return 'running';
  return 'idle';
}

function syncProgressFromMessage(msg) {
  const m = String(msg || '').match(/(\d+)\/(\d+)/);
  if (!m) {
    if (statusTone(msg) === 'success') setProgress(100);
    return;
  }
  const done = Number(m[1]);
  const total = Number(m[2]);
  if (Number.isFinite(done) && Number.isFinite(total) && total > 0) {
    setProgress((done / total) * 100);
  }
}

function setStatus(msg) {
  statusEl.textContent = msg;
  syncProgressFromMessage(msg);

  const tone = statusTone(msg);
  if (!isRunning && tone === 'running') {
    setStatePill('idle');
  } else {
    setStatePill(tone);
  }
}

function setRunningState(running) {
  isRunning = running;
  translateBtn.disabled = running;
  restoreBtn.disabled = false;
  copyBtn.disabled = running;

  if (running) {
    runStartedAt = Date.now();
    setStatePill('running');
    if (runTimer) clearInterval(runTimer);
    runTimer = setInterval(() => {
      if (elapsedValueEl) elapsedValueEl.textContent = formatElapsed(Date.now() - runStartedAt);
    }, 500);
  } else {
    if (runTimer) {
      clearInterval(runTimer);
      runTimer = null;
    }
    if (elapsedValueEl) elapsedValueEl.textContent = formatElapsed(Date.now() - runStartedAt);
  }
}

if (versionBadgeEl) versionBadgeEl.textContent = `v${EXTENSION_VERSION}`;
if (proxyValueEl) proxyValueEl.textContent = PROXY_URL.includes('localhost') ? 'Local' : 'Cloud';
setProgress(0);
if (elapsedValueEl) elapsedValueEl.textContent = '00:00';

function isWikipediaUrl(url) {
  return /^https:\/\/[a-z-]+\.wikipedia\.org\//i.test(url || '');
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function extractNamePhrases(text) {
  const names = new Set();
  const multiWord = /\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+){1,4})\b/g;
  let m;
  while ((m = multiWord.exec(text)) !== null) {
    const phrase = m[1].trim();
    if (phrase.length >= 5) names.add(phrase);
  }
  const acronyms = /\b([A-Z]{2,})\b/g;
  while ((m = acronyms.exec(text)) !== null) names.add(m[1]);
  return Array.from(names).sort((a, b) => b.length - a.length);
}

function maskNamesInText(text) {
  const candidates = extractNamePhrases(text);
  if (!candidates.length) return { masked: text, tokens: [] };

  let masked = text;
  const tokens = [];

  candidates.forEach((name, i) => {
    const token = `__SBNAME_${i}__`;
    const re = new RegExp(escapeRegExp(name), 'g');
    if (re.test(masked)) {
      masked = masked.replace(re, token);
      tokens.push({ token, name, index: i });
    }
  });

  return { masked, tokens };
}

function unmaskNamesInText(text, tokens) {
  let out = text;
  for (const t of tokens) {
    const legacy = `NM_${t.index}`;
    const variants = [
      t.token,
      `[${t.token}]`,
      `[[${t.token}]]`,
      legacy,
      `[${legacy}]`,
      `[[${legacy}]]`,
      `_${legacy}__`,
      `__${legacy}__`,
      `_${t.token}_`,
      `_${t.token}__`,
      `__${t.token}_`,
    ];
    for (const v of variants) out = out.split(v).join(t.name);
  }
  const byIndex = new Map(tokens.map((x) => [String(x.index), x.name]));
  out = out.replace(/[\[_]*SBNAME_(\d+)_*[\]_]*/g, (m, idx) => byIndex.get(String(idx)) || m);
  out = out.replace(/[\[_]*NM_(\d+)_*[\]_]*/g, (m, idx) => byIndex.get(String(idx)) || m);
  return out;
}


function maskWikitextSyntax(text) {
  if (!text) return { masked: text, tokens: [] };

  let masked = text;
  const tokens = [];
  const addToken = (raw) => {
    const index = tokens.length;
    const token = `__SBSYN_${index}__`;
    tokens.push({ token, raw, index });
    return token;
  };

  masked = masked.replace(/'{2,5}/g, (m) => addToken(m));
  masked = masked.replace(/(^|\n)([ \t]*[*#;:]+)(?=\s)/g, (m, p1, p2) => `${p1}${addToken(p2)}`);
  masked = masked.replace(/(^|\n)(----+)(?=\n|$)/g, (m, p1, p2) => `${p1}${addToken(p2)}`);
  masked = masked.replace(
    /(^|\n)([ \t]*={2,6})([^\n]*?)(={2,6}[ \t]*)(?=\n|$)/g,
    (m, p1, p2, p3, p4) => `${p1}${addToken(p2)}${p3}${addToken(p4)}`
  );

  return { masked, tokens };
}

function unmaskWikitextSyntax(text, tokens) {
  let out = text;
  for (const t of tokens) {
    const legacy = `SBSYN_${t.index}`;
    const variants = [
      t.token,
      `[${t.token}]`,
      `[[${t.token}]]`,
      legacy,
      `[${legacy}]`,
      `[[${legacy}]]`,
      `_${legacy}__`,
      `__${legacy}__`,
      `_${t.token}_`,
      `_${t.token}__`,
      `__${t.token}_`,
    ];
    for (const v of variants) out = out.split(v).join(t.raw);
  }
  const byIndex = new Map(tokens.map((x) => [String(x.index), x.raw]));
  out = out.replace(/[\[_]*SBSYN_(\d+)_*[\]_]*/g, (m, idx) => byIndex.get(String(idx)) || m);
  return out;
}
function preserveEdgeWhitespace(original, translated) {
  const leading = (original.match(/^\s*/) || [''])[0];
  const trailing = (original.match(/\s*$/) || [''])[0];
  const coreOriginal = original.trim();
  const coreTranslated = (typeof translated === 'string' ? translated : '').trim();
  const core = coreTranslated || coreOriginal;
  return leading + core + trailing;
}

function chunkByCharLimit(texts, limit) {
  const chunks = [];
  let current = [];
  let currentLen = 0;

  for (let i = 0; i < texts.length; i++) {
    const text = texts[i] || '';
    const len = text.length;

    if (len > limit) {
      if (current.length) {
        chunks.push(current);
        current = [];
        currentLen = 0;
      }
      chunks.push([{ index: i, text }]);
      continue;
    }

    if (currentLen + len > limit && current.length) {
      chunks.push(current);
      current = [{ index: i, text }];
      currentLen = len;
    } else {
      current.push({ index: i, text });
      currentLen += len;
    }
  }

  if (current.length) chunks.push(current);
  return chunks;
}

function chunkItemsByCharLimit(items, limit) {
  const chunks = [];
  let current = [];
  let currentLen = 0;

  for (const item of items) {
    const len = (item.text || '').length;
    if (len > limit) {
      if (current.length) {
        chunks.push(current);
        current = [];
        currentLen = 0;
      }
      chunks.push([item]);
      continue;
    }

    if (currentLen + len > limit && current.length) {
      chunks.push(current);
      current = [item];
      currentLen = len;
    } else {
      current.push(item);
      currentLen += len;
    }
  }

  if (current.length) chunks.push(current);
  return chunks;
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


async function withActiveTab(fn) {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) throw new Error('No active tab found.');
  return fn(tab);
}

async function checkProxyHealth() {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 6000);
  try {
    const res = await fetch('https://wiki.soothingspotspa.care/health', { signal: controller.signal });
    if (!res.ok) throw new Error(`Proxy health ${res.status}`);
  } catch (_err) {
    throw new Error('Proxy unavailable. Ensure proxy is running on https://wiki.soothingspotspa.care.');
  } finally {
    clearTimeout(timeout);
  }
}

async function ensurePageActionsInjected(tabId) {
  await chrome.scripting.executeScript({
    target: { tabId },
    files: ['page-actions.js'],
  });
}

async function collectPageTexts(tabId) {
  const [result] = await chrome.scripting.executeScript({
    target: { tabId },
    func: () => window.__sunbirdCollectTexts?.(),
  });
  return result?.result;
}

async function applyTranslations(tabId, translations) {
  const [result] = await chrome.scripting.executeScript({
    target: { tabId },
    func: (arr) => window.__sunbirdApplyTranslations?.(arr),
    args: [translations],
  });
  return result?.result;
}

async function restorePage(tabId) {
  const [result] = await chrome.scripting.executeScript({
    target: { tabId },
    func: () => window.__sunbirdRestorePage?.(),
  });
  return result?.result;
}

async function writeClipboard(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch (_err) {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.left = '-9999px';
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    if (!ok) throw new Error('Clipboard copy failed.');
    return true;
  }
}

async function translateChunk(lines) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(PROXY_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: controller.signal,
      body: JSON.stringify({
        source_language: SOURCE_LANG,
        target_language: TARGET_LANG,
        texts: lines,
      }),
    });

    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      const details = body?.details ? ` (${JSON.stringify(body.details)})` : '';
      throw new Error((body.error || `Proxy ${response.status}`) + details);
    }

    if (!Array.isArray(body.translations)) {
      throw new Error('Invalid proxy response: translations array missing.');
    }

    return body.translations;
  } catch (err) {
    if (err?.name === 'AbortError') {
      throw new Error('Translation timed out.');
    }
    throw err;
  } finally {
    clearTimeout(timeout);
  }
}

async function translateChunkAdaptive(items, depth = 0, options = {}) {
  const opts = {
    preserveNames: options.preserveNames !== false,
    preserveSyntax: options.preserveSyntax !== false,
  };

  const prepared = items.map((item) => {
    let working = item.text;
    let nameTokens = [];
    let syntaxTokens = [];

    if (opts.preserveNames) {
      const nameMasked = maskNamesInText(working);
      working = nameMasked.masked;
      nameTokens = nameMasked.tokens;
    }

    if (opts.preserveSyntax) {
      const syntaxMasked = maskWikitextSyntax(working);
      working = syntaxMasked.masked;
      syntaxTokens = syntaxMasked.tokens;
    }

    return {
      ...item,
      maskedText: working,
      nameTokens,
      syntaxTokens,
    };
  });

  const lines = prepared.map((x) => x.maskedText);

  try {
    const out = await translateChunk(lines);
    if (out.length !== items.length) {
      throw new Error('Translation mismatch between input and output lengths.');
    }

    return out.map((translated, i) => {
      const safe = typeof translated === 'string' ? translated : prepared[i].maskedText;
      let unmasked = safe;
      if (opts.preserveSyntax) {
        unmasked = unmaskWikitextSyntax(unmasked, prepared[i].syntaxTokens);
      }
      if (opts.preserveNames) {
        unmasked = unmaskNamesInText(unmasked, prepared[i].nameTokens);
      }
      return preserveEdgeWhitespace(prepared[i].text, unmasked);
    });
  } catch (err) {
    const isTimeout = /timed out/i.test(err?.message || '');
    if (isTimeout && items.length > 1 && depth < MAX_SPLIT_DEPTH) {
      const mid = Math.ceil(items.length / 2);
      const left = await translateChunkAdaptive(items.slice(0, mid), depth + 1, opts);
      const right = await translateChunkAdaptive(items.slice(mid), depth + 1, opts);
      return left.concat(right);
    }
    throw err;
  }
}

function parseBalanced(text, start, openSeq, closeSeq) {
  let i = start;
  let depth = 0;
  while (i < text.length) {
    if (text.startsWith(openSeq, i)) {
      depth += 1;
      i += openSeq.length;
      continue;
    }
    if (text.startsWith(closeSeq, i)) {
      depth -= 1;
      i += closeSeq.length;
      if (depth === 0) return i;
      continue;
    }
    i += 1;
  }
  return text.length;
}

function tokenizeWikitext(text) {
  const segments = [];
  let i = 0;

  while (i < text.length) {
    if (text.startsWith('{{', i)) {
      const end = parseBalanced(text, i, '{{', '}}');
      segments.push({ type: 'protected', value: text.slice(i, end) });
      i = end;
      continue;
    }

    if (text.startsWith('[[', i)) {
      const end = parseBalanced(text, i, '[[', ']]');
      segments.push({ type: 'protected', value: text.slice(i, end) });
      i = end;
      continue;
    }

    if (text.startsWith('<!--', i)) {
      const j = text.indexOf('-->', i + 4);
      const end = j === -1 ? text.length : j + 3;
      segments.push({ type: 'protected', value: text.slice(i, end) });
      i = end;
      continue;
    }

    if (/^<ref\b/i.test(text.slice(i))) {
      const openEnd = text.indexOf('>', i + 1);
      if (openEnd === -1) {
        segments.push({ type: 'protected', value: text.slice(i) });
        break;
      }
      const openTag = text.slice(i, openEnd + 1);
      if (openTag.endsWith('/>')) {
        segments.push({ type: 'protected', value: openTag });
        i = openEnd + 1;
      } else {
        const closeIdx = text.toLowerCase().indexOf('</ref>', openEnd + 1);
        const end = closeIdx === -1 ? text.length : closeIdx + 6;
        segments.push({ type: 'protected', value: text.slice(i, end) });
        i = end;
      }
      continue;
    }

    if (text[i] === '<') {
      const end = text.indexOf('>', i + 1);
      const j = end === -1 ? text.length : end + 1;
      segments.push({ type: 'protected', value: text.slice(i, j) });
      i = j;
      continue;
    }

    if (text.startsWith('{|', i)) {
      const close = text.indexOf('|}', i + 2);
      const end = close === -1 ? text.length : close + 2;
      segments.push({ type: 'protected', value: text.slice(i, end) });
      i = end;
      continue;
    }

    if (text[i] === '[' && /^(\[https?:|\[ftp:|\[mailto:)/i.test(text.slice(i))) {
      const end = text.indexOf(']', i + 1);
      const j = end === -1 ? text.length : end + 1;
      segments.push({ type: 'protected', value: text.slice(i, j) });
      i = j;
      continue;
    }

    const start = i;
    while (i < text.length) {
      if (
        text.startsWith('{{', i) ||
        text.startsWith('[[', i) ||
        text.startsWith('<!--', i) ||
        /^<ref\b/i.test(text.slice(i)) ||
        text[i] === '<' ||
        text.startsWith('{|', i) ||
        (text[i] === '[' && /^(\[https?:|\[ftp:|\[mailto:)/i.test(text.slice(i)))
      ) {
        break;
      }
      i += 1;
    }
    segments.push({ type: 'text', value: text.slice(start, i) });
  }

  return segments;
}

async function translateWikitextPreservingMarkup(sourceWikitext) {
  const segments = tokenizeWikitext(sourceWikitext);
  const items = [];

  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    if (seg.type !== 'text' || !/[A-Za-z]/.test(seg.value || '')) continue;

    const lines = seg.value.split('\n');
    const plans = lines.map((line) => {
      if (!/[A-Za-z]/.test(line || '')) {
        return { original: line, translate: false };
      }

      if (/^\s*----+\s*$/.test(line)) {
        return { original: line, translate: false };
      }

      const heading = line.match(/^(\s*={2,6}\s*)(.*?)(\s*={2,6}\s*)$/);
      if (heading) {
        return {
          original: line,
          translate: /[A-Za-z]/.test(heading[2] || ''),
          prefix: heading[1],
          core: heading[2],
          suffix: heading[3],
          translated: '',
        };
      }

      const list = line.match(/^(\s*[*#;:]+\s*)(.*)$/);
      if (list) {
        return {
          original: line,
          translate: /[A-Za-z]/.test(list[2] || ''),
          prefix: list[1],
          core: list[2],
          suffix: '',
          translated: '',
        };
      }

      return {
        original: line,
        translate: true,
        prefix: '',
        core: line,
        suffix: '',
        translated: '',
      };
    });

    seg._linePlans = plans;

    for (const plan of plans) {
      if (plan.translate) {
        items.push({ plan, text: plan.core });
      }
    }
  }

  if (!items.length) return sourceWikitext;

  const chunks = chunkItemsByCharLimit(items, CHUNK_CHAR_LIMIT);
  let done = 0;

  await mapWithConcurrency(chunks, COPY_CHUNK_CONCURRENCY, async (chunk) => {
    const translated = await translateChunkAdaptive(chunk, 0, {
      preserveNames: false,
      preserveSyntax: false,
    });

    for (let i = 0; i < chunk.length; i++) {
      chunk[i].plan.translated = translated[i] || chunk[i].text;
      done += 1;
    }

    const percent = Math.round((done / items.length) * 100);
    setStatus(`Translating wikitext ${done}/${items.length} (${percent}%)`);
  });

  for (const seg of segments) {
    if (!seg._linePlans) continue;
    seg.value = seg._linePlans
      .map((plan) => {
        if (!plan.translate) return plan.original;
        return `${plan.prefix}${plan.translated || plan.core}${plan.suffix}`;
      })
      .join('\n');
    delete seg._linePlans;
  }

  return segments.map((x) => x.value).join('');
}

function getWikipediaTitleFromUrl(url) {
  const u = new URL(url);
  if (u.pathname.startsWith('/wiki/')) {
    return decodeURIComponent(u.pathname.slice('/wiki/'.length)).replace(/_/g, ' ');
  }
  const title = u.searchParams.get('title');
  if (title) return decodeURIComponent(title).replace(/_/g, ' ');
  throw new Error('Could not determine article title from URL.');
}

async function fetchWikipediaWikitext(url) {
  const u = new URL(url);
  const title = getWikipediaTitleFromUrl(url);
  const apiUrl = `${u.origin}/w/api.php`;

  const params = new URLSearchParams({
    action: 'query',
    prop: 'revisions',
    rvprop: 'content',
    rvslots: 'main',
    titles: title,
    format: 'json',
    formatversion: '2',
    origin: '*',
  });

  const res = await fetch(`${apiUrl}?${params.toString()}`);
  const data = await res.json().catch(() => null);
  if (!res.ok || !data) throw new Error('Failed to fetch article source from Wikipedia API.');

  const page = data?.query?.pages?.[0];
  if (!page || page.missing) throw new Error('Article source not available for this page.');

  const rev = page?.revisions?.[0];
  const content = rev?.slots?.main?.content ?? rev?.content;
  if (typeof content !== 'string') throw new Error('Wikipedia API returned no source content.');

  return { title: page.title || title, wikitext: content };
}

translateBtn.addEventListener('click', async () => {
  if (isRunning) return;

  setRunningState(true);
  setStatus('Starting translation...');

  try {
    await checkProxyHealth();

    await withActiveTab(async (tab) => {
      if (!isWikipediaUrl(tab.url)) {
        throw new Error('Open a Wikipedia article tab first.');
      }

      await ensurePageActionsInjected(tab.id);

      const collected = await collectPageTexts(tab.id);
      if (!collected?.ok) {
        throw new Error(collected?.error || 'Unable to collect page text.');
      }

      const texts = collected.texts || [];
      const translations = new Array(texts.length);

      const chunks = chunkByCharLimit(texts, CHUNK_CHAR_LIMIT);
      let done = 0;

      await mapWithConcurrency(chunks, PAGE_CHUNK_CONCURRENCY, async (chunk) => {
        const out = await translateChunkAdaptive(chunk);

        for (let i = 0; i < chunk.length; i++) {
          translations[chunk[i].index] = out[i] || chunk[i].text;
          done += 1;
        }

        const percent = Math.round((done / texts.length) * 100);
        setStatus(`Translating ${done}/${texts.length} (${percent}%)`);
      });

      const applyResult = await applyTranslations(tab.id, translations);
      if (!applyResult?.ok) {
        throw new Error(applyResult?.error || 'Failed to apply translated text to page.');
      }

      setStatus(`Done. Translated ${applyResult.appliedCount || 0}/${applyResult.totalNodes || texts.length} segments (names preserved).`);
    });
  } catch (err) {
    setStatus(err?.message || 'Translation failed.');
  } finally {
    setRunningState(false);
  }
});

restoreBtn.addEventListener('click', async () => {
  setStatus('Restoring...');
  try {
    await withActiveTab(async (tab) => {
      if (!isWikipediaUrl(tab.url)) {
        throw new Error('Open a Wikipedia article tab first.');
      }

      await ensurePageActionsInjected(tab.id);
      const result = await restorePage(tab.id);
      if (!result?.ok) {
        throw new Error(result?.error || 'Restore failed.');
      }

      setStatus(`Restored ${result.restoredCount || 0} segments.`);
    });
  } catch (err) {
    setStatus(err?.message || 'Restore failed.');
  } finally {
    setRunningState(false);
  }
});

copyBtn.addEventListener('click', async () => {
  if (isRunning) return;

  setRunningState(true);
  setStatus('Fetching article source...');
  try {
    await checkProxyHealth();

    await withActiveTab(async (tab) => {
      if (!isWikipediaUrl(tab.url)) {
        throw new Error('Open a Wikipedia article tab first.');
      }

      const source = await fetchWikipediaWikitext(tab.url);
      setStatus('Translating source while preserving links/refs...');

      const translatedWikitext = await translateWikitextPreservingMarkup(source.wikitext);
      await writeClipboard(translatedWikitext);

      setStatus(`Copied translated wikitext for "${source.title}".`);
    });
  } catch (err) {
    setStatus(err?.message || 'Copy Wikitext failed.');
  } finally {
    setRunningState(false);
  }
});

setStatus(`Ready (v${EXTENSION_VERSION} | iteration ${BUILD_ITERATION})`);





