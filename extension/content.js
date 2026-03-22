const PROXY_URL = 'http://localhost:8787/translate';
const TARGET_LANG = 'nyn';
const SOURCE_LANG = 'eng';
const CHUNK_CHAR_LIMIT = 900;
const NODE_CACHE_PREFIX = 'sb_cache_';
const REQUEST_TIMEOUT_MS = 25000;
const MAX_NODES = 1200;
const MAX_TOTAL_CHARS = 120000;

let activeSnapshot = [];
let isTranslating = false;
let activeControllers = [];

function emitProgress(payload) {
  try {
    chrome.runtime.sendMessage({ type: 'TRANSLATION_PROGRESS', ...payload });
  } catch (_err) {
    // Popup may be closed; ignore.
  }
}

function isWikipediaPage() {
  return /https:\/\/[a-z]+\.wikipedia\.org\//i.test(window.location.href);
}

function isVisible(el) {
  if (!el) return false;
  const style = window.getComputedStyle(el);
  return style.display !== 'none' && style.visibility !== 'hidden';
}

function shouldSkipNode(textNode) {
  if (!textNode || !textNode.parentElement) return true;
  const el = textNode.parentElement;
  const tag = el.tagName;

  if (!isVisible(el)) return true;
  if (/^(SCRIPT|STYLE|NOSCRIPT|CODE|PRE|KBD|SAMP|MATH|SUP|SUB|TABLE|FIGCAPTION|TH|TD)$/.test(tag)) return true;

  if (
    el.closest(
      '#mw-navigation, #catlinks, .navbox, .metadata, .mw-editsection, .reflist, .reference, .sidebar, .infobox, .toc, .thumbcaption, .hatnote, .shortdescription, .portalbox, .navbox, .vertical-navbox'
    )
  ) {
    return true;
  }

  const text = textNode.textContent;
  if (!text) return true;
  const trimmed = text.trim();
  if (!trimmed) return true;
  if (trimmed.length < 2) return true;
  if (!/[A-Za-z]/.test(trimmed)) return true;
  return false;
}

function getArticleRoot() {
  return document.querySelector('#mw-content-text, #bodyContent, #content, article') || document.body;
}

function collectTextNodes() {
  const root = getArticleRoot();
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const out = [];
  let node;

  while ((node = walker.nextNode())) {
    if (shouldSkipNode(node)) continue;
    out.push(node);
  }

  return out;
}

function fnv1aHash(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h += (h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24);
  }
  return (h >>> 0).toString(16);
}

function keyFor(text) {
  return `${NODE_CACHE_PREFIX}${SOURCE_LANG}_${TARGET_LANG}_${fnv1aHash(text)}`;
}

async function getCachedTranslation(text) {
  const key = keyFor(text);
  const v = await chrome.storage.local.get(key);
  return v[key] || null;
}

async function setCachedTranslation(text, translated) {
  const key = keyFor(text);
  await chrome.storage.local.set({ [key]: translated });
}

function chunkByCharLimit(items, limit) {
  const chunks = [];
  let current = [];
  let currentLen = 0;

  for (const it of items) {
    const len = it.text.length;

    if (len > limit) {
      if (current.length) {
        chunks.push(current);
        current = [];
        currentLen = 0;
      }
      chunks.push([it]);
      continue;
    }

    if (currentLen + len > limit && current.length) {
      chunks.push(current);
      current = [it];
      currentLen = len;
    } else {
      current.push(it);
      currentLen += len;
    }
  }

  if (current.length) chunks.push(current);
  return chunks;
}

async function translateBatch(lines) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort('timeout'), REQUEST_TIMEOUT_MS);
  activeControllers.push(controller);

  try {
    const response = await fetch(PROXY_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        source_language: SOURCE_LANG,
        target_language: TARGET_LANG,
        texts: lines,
        context: 'Wikipedia article content',
      }),
      signal: controller.signal,
    });

    const body = await response.json().catch(() => ({}));

    if (!response.ok) {
      const details = body?.details ? ` (${JSON.stringify(body.details)})` : '';
      throw new Error((body.error || `Proxy error ${response.status}`) + details);
    }

    if (!Array.isArray(body.translations)) {
      throw new Error('Invalid proxy response: translations array missing.');
    }

    return body.translations;
  } catch (err) {
    if (err?.name === 'AbortError') {
      throw new Error('Translation timed out. Try a shorter page section.');
    }
    throw err;
  } finally {
    clearTimeout(timeoutId);
    activeControllers = activeControllers.filter((c) => c !== controller);
  }
}

async function translatePage() {
  if (!isWikipediaPage()) {
    return { ok: false, error: 'Open a Wikipedia page first.' };
  }

  if (isTranslating) {
    return { ok: false, error: 'A translation job is already running.' };
  }

  const nodes = collectTextNodes();
  if (!nodes.length) {
    return { ok: false, error: 'No eligible text found on this page.' };
  }

  if (nodes.length > MAX_NODES) {
    return {
      ok: false,
      error: `Page too large (${nodes.length} nodes). Limit is ${MAX_NODES}.`,
    };
  }

  const totalChars = nodes.reduce((sum, n) => sum + (n.textContent?.length || 0), 0);
  if (totalChars > MAX_TOTAL_CHARS) {
    return {
      ok: false,
      error: `Page text too large (${totalChars} chars). Limit is ${MAX_TOTAL_CHARS}.`,
    };
  }

  isTranslating = true;
  activeSnapshot = [];

  let processed = 0;
  let translatedCount = 0;
  const total = nodes.length;

  emitProgress({ status: 'start', done: 0, total, percent: 0, chunkSize: 0 });

  const workItems = [];
  for (const node of nodes) {
    const original = node.textContent;
    const cached = await getCachedTranslation(original);

    if (cached) {
      activeSnapshot.push({ node, original });
      node.textContent = cached;
      processed += 1;
      translatedCount += 1;
      emitProgress({
        status: 'progress',
        done: processed,
        total,
        percent: Math.round((processed / total) * 100),
        chunkSize: 1,
        cached: true,
      });
    } else {
      workItems.push({ node, text: original });
    }
  }

  if (!workItems.length) {
    isTranslating = false;
    emitProgress({ status: 'done', done: total, total, percent: 100, chunkSize: 0 });
    return { ok: true, translatedCount, totalCount: total, partial: false };
  }

  const chunks = chunkByCharLimit(workItems, CHUNK_CHAR_LIMIT);

  try {
    for (const chunk of chunks) {
      const inputLines = chunk.map((x) => x.text);
      const translated = await translateBatch(inputLines);

      if (translated.length !== chunk.length) {
        throw new Error('Translation mismatch between input and output length.');
      }

      for (let i = 0; i < chunk.length; i++) {
        const item = chunk[i];
        const out = translated[i] || item.text;

        activeSnapshot.push({ node: item.node, original: item.text });
        item.node.textContent = out;
        translatedCount += 1;
        processed += 1;

        await setCachedTranslation(item.text, out);
      }

      emitProgress({
        status: 'progress',
        done: processed,
        total,
        percent: Math.round((processed / total) * 100),
        chunkSize: chunk.length,
        cached: false,
      });
    }

    emitProgress({ status: 'done', done: total, total, percent: 100, chunkSize: 0 });
    return { ok: true, translatedCount, totalCount: total, partial: false };
  } catch (err) {
    emitProgress({
      status: 'error',
      done: processed,
      total,
      percent: Math.round((processed / total) * 100),
      chunkSize: 0,
      error: err.message || 'Translation failed',
    });

    return {
      ok: false,
      partial: processed > 0,
      translatedCount,
      totalCount: total,
      error:
        processed > 0
          ? `Partially translated ${processed}/${total} nodes. ${err.message || 'Translation failed.'}`
          : err.message || 'Translation failed.',
    };
  } finally {
    isTranslating = false;
  }
}

function restorePage() {
  // Stop in-flight requests if any
  for (const controller of activeControllers) {
    try {
      controller.abort('restore');
    } catch (_err) {
      // ignore
    }
  }
  activeControllers = [];
  isTranslating = false;

  if (!activeSnapshot.length) {
    return { ok: true, restoredCount: 0 };
  }

  let restored = 0;
  for (const item of activeSnapshot) {
    if (item.node && item.node.isConnected) {
      item.node.textContent = item.original;
      restored += 1;
    }
  }

  activeSnapshot = [];
  return { ok: true, restoredCount: restored };
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.action === 'PING') {
    sendResponse({ ok: true, isTranslating });
    return true;
  }

  if (msg?.action === 'TRANSLATE_PAGE') {
    translatePage()
      .then(sendResponse)
      .catch((err) => sendResponse({ ok: false, error: err.message || 'Translate failed' }));
    return true;
  }

  if (msg?.action === 'RESTORE_PAGE') {
    try {
      sendResponse(restorePage());
    } catch (err) {
      sendResponse({ ok: false, error: err.message || 'Restore failed' });
    }
    return true;
  }

  return false;
});
