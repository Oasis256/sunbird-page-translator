const statusEl = document.getElementById('status');
const translateBtn = document.getElementById('translateBtn');
const restoreBtn = document.getElementById('restoreBtn');
const copyBtn = document.getElementById('copyBtn');
const retryBtn = document.getElementById('retryBtn');
const objectBtn = document.getElementById('objectBtn');
const statePillEl = document.getElementById('statePill');
const progressBarEl = document.getElementById('progressBar');
const progressValueEl = document.getElementById('progressValue');
const elapsedValueEl = document.getElementById('elapsedValue');
const versionBadgeEl = document.getElementById('versionBadge');
const segmentsValueEl = document.getElementById('segmentsValue');
const cacheValueEl = document.getElementById('cacheValue');
const modeValueEl = document.getElementById('modeValue');
const scopeValueEl = document.getElementById('scopeValue');
const activityListEl = document.getElementById('activityList');
const objectPanelEl = document.getElementById('objectPanel');
const objectListEl = document.getElementById('objectList');
const incubatorUrlInputEl = document.getElementById('incubatorUrlInput');
const localSeedPanelEl = document.getElementById('localSeedPanel');
const localSeedMetaEl = document.getElementById('localSeedMeta');
const localSeedPreviewEl = document.getElementById('localSeedPreview');
const localSeedLoadBtn = document.getElementById('localSeedLoadBtn');
const localSeedCopyBtn = document.getElementById('localSeedCopyBtn');
const localSeedCopyOpenBtn = document.getElementById('localSeedCopyOpenBtn');
const localSeedNextBtn = document.getElementById('localSeedNextBtn');

const PROXY_URL = 'https://wiki.soothingspotspa.care/translate';
const SOURCE_LANG = 'eng';
const TARGET_LANG = 'nyn';
const REQUEST_TIMEOUT_MS = 120000;
const MAX_SPLIT_DEPTH = 5;
const BUILD_ITERATION = 19;
const OFFSCREEN_DOCUMENT_URL = 'offscreen.html';
const RATE_LIMIT_RETRY_COUNT = 3;
const RATE_LIMIT_BASE_DELAY_MS = 5000;
const RATE_LIMIT_STATUS_THROTTLE_MS = 1500;
const EXTENSION_VERSION = chrome.runtime?.getManifest?.().version || '0.0.0';
const PREF_KEY = 'sunbirdPopupPrefs';
const DEFAULT_PREFS = { mode: 'fast', scope: 'article', incubatorTemplate: 'https://incubator.wikimedia.org/wiki/Wp/nyn/{title}?action=edit' };

let isRunning = false;
let runStartedAt = 0;
let runTimer = null;
let progressPercent = 0;
let prefs = { ...DEFAULT_PREFS };
let lastRetryAction = null;
let activity = ['Ready'];
let objectBlocks = [];
let objectSourceTitle = '';
let objectSourcePageUrl = '';
let localSeedItems = [];
let localSeedIndex = 0;
let translationCooldownUntil = 0;
let translationCooldownReason = '';
let translationCooldownAnnouncedAt = 0;
const LOCAL_SEED_INDEX_KEY = 'sunbirdLocalSeedIndex';

function getRuntimeParams() {
  if (prefs.mode === 'quality') {
    return {
      chunkCharLimit: 1000,
      pageChunkConcurrency: 1,
      copyChunkConcurrency: 1,
    };
  }

  return {
    chunkCharLimit: 1800,
    pageChunkConcurrency: 2,
    copyChunkConcurrency: 1,
  };
}

async function loadPrefs() {
  const data = await chrome.storage.local.get(PREF_KEY).catch(() => ({}));
  const raw = data?.[PREF_KEY] || {};
  prefs = {
    mode: raw.mode === 'quality' ? 'quality' : 'fast',
    scope: raw.scope === 'article_infobox' ? 'article_infobox' : 'article',
    incubatorTemplate: typeof raw.incubatorTemplate === 'string' && raw.incubatorTemplate.trim() ? raw.incubatorTemplate.trim() : DEFAULT_PREFS.incubatorTemplate,
  };
}

async function savePrefs() {
  await chrome.storage.local.set({ [PREF_KEY]: prefs }).catch(() => {});
}

function applyPrefsToUI() {
  const modeEls = Array.from(document.querySelectorAll('input[name="mode"]'));
  const scopeEls = Array.from(document.querySelectorAll('input[name="scope"]'));

  modeEls.forEach((el) => {
    el.checked = el.value === prefs.mode;
    el.onchange = async () => {
      prefs.mode = el.value === 'quality' ? 'quality' : 'fast';
      applyPrefsToUI();
      await savePrefs();
      addActivity(`Mode set to ${prefs.mode}.`);
    };
  });

  scopeEls.forEach((el) => {
    el.checked = el.value === prefs.scope;
    el.onchange = async () => {
      prefs.scope = el.value === 'article_infobox' ? 'article_infobox' : 'article';
      applyPrefsToUI();
      await savePrefs();
      addActivity(`Scope set to ${prefs.scope}.`);
    };
  });

  if (modeValueEl) modeValueEl.textContent = prefs.mode === 'quality' ? 'Quality' : 'Fast';
  if (scopeValueEl) scopeValueEl.textContent = prefs.scope === 'article_infobox' ? 'Article+Info' : 'Article';

  if (incubatorUrlInputEl) {
    incubatorUrlInputEl.value = prefs.incubatorTemplate || DEFAULT_PREFS.incubatorTemplate;
    incubatorUrlInputEl.onchange = async () => {
      const v = incubatorUrlInputEl.value.trim();
      prefs.incubatorTemplate = v || DEFAULT_PREFS.incubatorTemplate;
      await savePrefs();
      addActivity('Updated incubator URL template.');
    };
  }
}

function formatElapsed(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const m = String(Math.floor(total / 60)).padStart(2, '0');
  const s = String(total % 60).padStart(2, '0');
  return `${m}:${s}`;
}

function formatDuration(ms) {
  const total = Math.max(0, Math.ceil(Number(ms || 0) / 1000));
  if (total < 60) return `${total}s`;
  const m = Math.floor(total / 60);
  const s = total % 60;
  return s ? `${m}m ${s}s` : `${m}m`;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(ms || 0))));
}

function getTranslationCooldownRemainingMs() {
  return Math.max(0, translationCooldownUntil - Date.now());
}

function announceTranslationCooldown(ms, reason = 'the translation service') {
  const cooldownMs = Math.max(0, Math.floor(Number(ms || 0)));
  if (!cooldownMs) return;

  const until = Date.now() + cooldownMs;
  translationCooldownUntil = Math.max(translationCooldownUntil, until);
  translationCooldownReason = reason;

  const message = `Rate limited by ${reason}. Cooling down for ${formatDuration(cooldownMs)}.`;
  addActivity(message);
  setStatus(message);
}

async function waitForTranslationCooldown(context = 'translation request') {
  while (true) {
    const remaining = getTranslationCooldownRemainingMs();
    if (remaining <= 0) return;

    const message = `Waiting ${formatDuration(remaining)} before ${context}...`;
    if (Date.now() - translationCooldownAnnouncedAt >= RATE_LIMIT_STATUS_THROTTLE_MS) {
      translationCooldownAnnouncedAt = Date.now();
      setStatus(translationCooldownReason ? `Rate limited by ${translationCooldownReason}. ${message}` : message);
    }

    await sleep(Math.min(remaining, RATE_LIMIT_STATUS_THROTTLE_MS));
  }
}

function setProgress(percent) {
  progressPercent = Math.max(0, Math.min(100, Number(percent || 0)));
  if (progressBarEl) progressBarEl.style.width = `${progressPercent}%`;
  if (progressValueEl) progressValueEl.textContent = `${Math.round(progressPercent)}%`;
}

function setSegmentsValue(v) {
  if (segmentsValueEl) segmentsValueEl.textContent = String(v ?? '-');
}

function setCacheValue(v) {
  if (cacheValueEl) cacheValueEl.textContent = String(v ?? '-');
}

function setRetryVisible(show) {
  if (!retryBtn) return;
  retryBtn.style.display = show ? 'inline-flex' : 'none';
}

function renderActivity() {
  if (!activityListEl) return;
  activityListEl.innerHTML = '';
  for (const item of activity) {
    const li = document.createElement('li');
    li.textContent = item;
    activityListEl.appendChild(li);
  }
}

function addActivity(text) {
  activity = [text, ...activity].slice(0, 3);
  renderActivity();
}


function escapeHtml(text) {
  return String(text || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function previewText(text, max = 200) {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max)}...` : t;
}

function getIncubatorProjectPrefix() {
  const raw = (prefs.incubatorTemplate || DEFAULT_PREFS.incubatorTemplate).trim();
  const match = raw.match(/\/wiki\/([^/?#]+)\/{title}/i);
  if (match?.[1]) {
    return decodeURIComponent(match[1]).replace(/^\/+|\/+$/g, '');
  }
  return 'Wp/nyn';
}

function getIncubatorUrlForTitle(title) {
  const raw = (prefs.incubatorTemplate || DEFAULT_PREFS.incubatorTemplate).trim();
  const safeTitle = encodeURIComponent(String(title || '').replace(/\s+/g, '_'));

  // Template:/Category:/Module: pages on Incubator should open directly,
  // not under Wp/nyn/{title} (which would double-prefix).
  if (/^(Template|Category|Module|MediaWiki):/i.test(String(title || '').trim())) {
    try {
      const u = new URL(raw);
      return `${u.origin}/wiki/${safeTitle}?action=edit`;
    } catch (_) {
      return `https://incubator.wikimedia.org/wiki/${safeTitle}?action=edit`;
    }
  }

  if (raw.includes('{title}')) {
    return raw.replace(/\{title\}/g, safeTitle);
  }
  const base = raw.endsWith('/') ? raw : `${raw}/`;
  return `${base}${safeTitle}?action=edit`;
}

async function openIncubatorTabForCurrent() {
  const url = getIncubatorUrlForTitle(objectSourceTitle || 'New_article');
  await chrome.tabs.create({ url });
}


function escapeRegex(s) {
  return String(s || '').replace(/[.*+?^${}()|[\\]\\]/g, '\\$&');
}

function normalizeObjectOpenTitle(rawObjectTitle, namespace) {
  const base = String(rawObjectTitle || '').trim().replace(/_/g, ' ');
  if (!base) return null;

  const match = base.match(/^([^:]+):(.*)$/);
  let body = base;

  if (match) {
    const ns = (match[1] || '').trim().toLowerCase();
    const rest = (match[2] || '').trim();
    if (!rest) return null;
    body = ns === namespace.toLowerCase() ? rest : base;
  }

  const projectPrefix = getIncubatorProjectPrefix();
  const prefixRegex = new RegExp(`^${escapeRegex(projectPrefix)}/`, 'i');
  const bodyNoPrefix = body.replace(prefixRegex, '').trim();
  if (!bodyNoPrefix) return null;

  return `${namespace}:${projectPrefix}/${bodyNoPrefix}`;
}

function getObjectOpenTitle(raw, templateName) {
  const text = String(raw || '').trim();

  if (text.startsWith('{{')) {
    return normalizeObjectOpenTitle(templateName, 'Template');
  }

  const categoryMatch = text.match(/^\[\[\s*category\s*:\s*([^\]|]+)(?:\|[^\]]*)?\]\]/i);
  if (categoryMatch) {
    return normalizeObjectOpenTitle(categoryMatch[1], 'Category');
  }

  return null;
}

function classifyTemplateName(name) {
  const n = String(name || '').toLowerCase();
  if (!n) return 'Template';
  if (n.includes('infobox')) return 'Infobox';
  if (n.startsWith('cite ')) return 'Citation template';
  if (n.includes('authority control')) return 'Authority control';
  if (n.startsWith('use ') || n.startsWith('cleanup') || n.startsWith('short description')) return 'Maintenance template';
  if (n.includes('reflist')) return 'References template';
  return 'Template';
}


function extractTemplateNamesFromText(text) {
  const src = String(text || '');
  const out = [];
  const rx = /\{\{\s*([^|}\n]+)\s*(?:[|}])/g;
  let m;

  while ((m = rx.exec(src)) !== null) {
    let name = String(m?.[1] || '').trim();
    if (!name) continue;

    if (/^\{|^#/i.test(name)) continue;
    name = name.replace(/^(?:subst:|safesubst:)\s*/i, '').trim();
    if (!name) continue;

    out.push(name);
  }

  return Array.from(new Set(out));
}

function extractWikitextObjects(sourceWikitext) {
  const segments = tokenizeWikitext(sourceWikitext || '');
  const objects = [];

  for (const seg of segments) {
    const raw = String(seg?.value || '').trim();
    if (!raw) continue;

    const templateNames = extractTemplateNamesFromText(raw);
    for (const templateName of templateNames) {
      const templateRaw = raw.startsWith('{{') && templateNames.length === 1
        ? raw
        : `{{${templateName}}}`;

      objects.push({
        type: classifyTemplateName(templateName),
        title: templateName || 'template',
        raw: templateRaw,
        openTitle: getObjectOpenTitle(templateRaw, templateName),
      });
    }

    if (/^<ref\b/i.test(raw)) {
      objects.push({ type: 'Reference', title: 'ref', raw });
    }

    if (/^\[\[category:/i.test(raw)) {
      objects.push({
        type: 'Category',
        title: 'category',
        raw,
        openTitle: getObjectOpenTitle(raw, ''),
      });
    }

    if (raw.startsWith('{|')) {
      objects.push({ type: 'Table', title: 'table', raw });
    }
  }

  const seen = new Set();
  const deduped = [];
  for (const o of objects) {
    const key = o.openTitle
      ? `open::${String(o.openTitle).toLowerCase()}`
      : `${o.type}::${o.raw}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(o);
  }

  return deduped;
}

function renderObjectBlocks() {
  if (!objectPanelEl || !objectListEl) return;

  if (!objectBlocks.length) {
    objectPanelEl.style.display = 'none';
    objectListEl.innerHTML = '';
    return;
  }

  objectPanelEl.style.display = 'block';
  objectListEl.innerHTML = objectBlocks
    .map((obj, idx) => `
      <div class="object-item">
        <div class="object-head">
          <span class="object-type">${escapeHtml(obj.type)}</span>
          <div class="object-actions">
            <button class="secondary" data-obj-action="copy" data-idx="${idx}">Copy</button>
            <button data-obj-action="copy-open" data-idx="${idx}">Copy+Open</button>
          </div>
        </div>
        <div class="object-preview"><strong>Open target:</strong> ${escapeHtml(obj.openTitle || 'N/A (copy-only object)')}</div>
        <div class="object-preview">${escapeHtml(previewText(obj.raw, 220))}</div>
      </div>
    `)
    .join('');
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
  if (
    text.includes('translating') ||
    text.includes('starting') ||
    text.includes('fetching') ||
    text.includes('restoring') ||
    text.includes('waiting') ||
    text.includes('cooling down') ||
    text.includes('retrying') ||
    text.includes('rate limited')
  ) return 'running';
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

  if (tone === 'error') {
    addActivity(`Error: ${msg}`);
    setRetryVisible(Boolean(lastRetryAction));
  } else if (tone === 'success') {
    addActivity(msg);
    setRetryVisible(false);
  }
}

function setRunningState(running) {
  isRunning = running;
  translateBtn.disabled = running;
  restoreBtn.disabled = false;
  copyBtn.disabled = running;
  if (retryBtn) retryBtn.disabled = running;
  if (objectBtn) objectBtn.disabled = running;

  if (running) {
    runStartedAt = Date.now();
    setStatePill('running');
    setRetryVisible(false);
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
setProgress(0);
setSegmentsValue('-');
setCacheValue('-');
if (elapsedValueEl) elapsedValueEl.textContent = '00:00';
renderActivity();

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

async function collectPageTexts(tabId, options = {}) {
  const [result] = await chrome.scripting.executeScript({
    target: { tabId },
    func: (opts) => window.__sunbirdCollectTexts?.(opts),
    args: [options],
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

async function hasOffscreenDocument() {
  if (typeof chrome.offscreen?.hasDocument === 'function') {
    return chrome.offscreen.hasDocument();
  }

  if (typeof chrome.runtime?.getContexts === 'function') {
    const contexts = await chrome.runtime.getContexts({
      contextTypes: ['OFFSCREEN_DOCUMENT'],
      documentUrls: [chrome.runtime.getURL(OFFSCREEN_DOCUMENT_URL)],
    });
    return Array.isArray(contexts) && contexts.length > 0;
  }

  return false;
}

async function ensureOffscreenDocument() {
  if (!chrome.offscreen?.createDocument) return false;
  if (await hasOffscreenDocument()) return true;

  await chrome.offscreen.createDocument({
    url: OFFSCREEN_DOCUMENT_URL,
    reasons: ['CLIPBOARD'],
    justification: 'Copy translated Wikipedia wikitext to the system clipboard after async translation completes.',
  });

  return true;
}

async function writeClipboard(text) {
  const payload = String(text ?? '');

  try {
    if (await ensureOffscreenDocument()) {
      const response = await chrome.runtime.sendMessage({
        target: 'offscreen-clipboard',
        action: 'COPY_TO_CLIPBOARD',
        text: payload,
      });

      if (response?.ok) {
        return true;
      }

      throw new Error(response?.error || 'Clipboard copy failed.');
    }
  } catch (_err) {
    // Fall through to the legacy popup-based copy path if the offscreen
    // document is unavailable for any reason.
  }

  try {
    await navigator.clipboard.writeText(payload);
    return true;
  } catch (_err) {
    const ta = document.createElement('textarea');
    ta.value = payload;
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
  await waitForTranslationCooldown('translation request');

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
      const err = new Error((body.error || `Proxy ${response.status}`) + details);
      err.status = response.status;
      err.details = body?.details || null;
      err.retryAfterMs = Number(body?.details?.retryAfterMs || 0) || 0;
      throw err;
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

function isRateLimitError(err) {
  const status = Number(err?.status || err?.details?.status || 0);
  const retryAfterMs = Number(err?.retryAfterMs || err?.details?.retryAfterMs || 0);
  const msg = String(err?.message || '').toLowerCase();
  return status === 429 || retryAfterMs > 0 || msg.includes('429') || msg.includes('too many requests') || msg.includes('rate limited');
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
  let rateLimitAttempts = 0;

  while (true) {
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
      if (isRateLimitError(err) && rateLimitAttempts < RATE_LIMIT_RETRY_COUNT) {
        rateLimitAttempts += 1;
        const retryAfterMs = Number(err?.retryAfterMs || err?.details?.retryAfterMs || 0);
        const fallbackMs = RATE_LIMIT_BASE_DELAY_MS * rateLimitAttempts;
        const cooldownMs = Math.max(retryAfterMs || 0, fallbackMs);

        announceTranslationCooldown(cooldownMs, 'the translation service');
        setStatus(`Rate limited. Waiting ${formatDuration(cooldownMs)} before retry ${rateLimitAttempts}/${RATE_LIMIT_RETRY_COUNT}...`);
        await sleep(cooldownMs);
        continue;
      }

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

async function translateWikitextPreservingMarkup(sourceWikitext, copyConcurrency = 2, chunkCharLimit = 1200) {
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

  const chunks = chunkItemsByCharLimit(items, chunkCharLimit);
  let done = 0;

  await mapWithConcurrency(chunks, copyConcurrency, async (chunk) => {
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


function stripWikiMarkup(text) {
  return String(text || '')
    .replace(/\[\[([^\]|]+\|)?([^\]]+)\]\]/g, '$2')
    .replace(/'''?/g, '')
    .replace(/<[^>]+>/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function parseTemplateParams(paramText) {
  const params = {};
  const rx = /\|\s*([^=|{}<>\n]+?)\s*=\s*([\s\S]*?)(?=(\|\s*[^=|{}<>\n]+?\s*=)|$)/g;
  let m;
  while ((m = rx.exec(paramText)) !== null) {
    const key = String(m[1] || '').trim().toLowerCase();
    const val = stripWikiMarkup(m[2] || '');
    if (key && val) params[key] = val;
  }
  return params;
}

function buildPlainCitation(params) {
  const title = params.title || params.chapter || params.article || params.subject;
  const source = params.website || params.work || params.journal || params.newspaper || params.publisher;
  const date = params.date || params.year;
  const accessDate = params['access-date'] || params.accessdate;

  const parts = [];
  if (title) parts.push(`"${title}"`);
  if (source) parts.push(source);
  if (date) parts.push(date);
  if (accessDate) parts.push(`Retrieved ${accessDate}`);

  return parts.join('. ') + (parts.length ? '.' : '');
}

function normalizeReferenceTemplatePrefixes(wikitext) {
  const src = String(wikitext || '');

  // In references, remove Incubator project prefixes from template calls
  // so unresolved local alias pages do not appear as red links in ref output.
  // Example: {{Wp/nyn/Cite news}} -> {{Cite news}}
  return src.replace(/<ref([^>]*)>([\s\S]*?)<\/ref>/gi, (_m, attrs, body) => {
    const normalizedBody = String(body || '')
      .replace(/\{\{\s*Wp\/[a-z-]+\/([^|}\n]+)/gi, '{{$1')
      .replace(/\{\{\s*Template\s*:\s*Wp\/[a-z-]+\/([^|}\n]+)/gi, '{{$1');

    return `<ref${attrs}>${normalizedBody}</ref>`;
  });
}

function convertCiteTemplatesInRefsToPlainText(wikitext) {
  const src = String(wikitext || '');
  return src.replace(/<ref([^>]*)>\s*\{\{\s*cite\s+(web|news|journal|book)\b([\s\S]*?)\}\}\s*<\/ref>/gi, (_m, attrs, _kind, paramText) => {
    const params = parseTemplateParams(paramText || '');
    const plain = buildPlainCitation(params);
    if (!plain) return _m;
    return `<ref${attrs}>${plain}</ref>`;
  });
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


async function fetchWikipediaWikitextByTitle(baseUrl, title) {
  const u = new URL(baseUrl);
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
  if (!res.ok || !data) throw new Error(`Failed to fetch source for ${title}.`);

  const page = data?.query?.pages?.[0];
  if (!page || page.missing) throw new Error(`Source page not found: ${title}.`);

  const rev = page?.revisions?.[0];
  const content = rev?.slots?.main?.content ?? rev?.content;
  if (typeof content !== 'string') throw new Error(`Wikipedia API returned no source content for ${title}.`);

  return { title: page.title || title, wikitext: content };
}

function normalizeTemplateSourceName(name) {
  let v = String(name || '').trim();
  if (!v) return null;

  v = v.replace(/^template\s*:/i, '').trim();
  v = v.replace(/^Wp\/[a-z-]+\//i, '').trim();
  if (!v) return null;

  // Parser functions/invokes are not template pages.
  if (v.startsWith('#')) return null;

  return `Template:${v}`;
}

function extractTemplateCandidatesFromRaw(raw) {
  const text = String(raw || '');
  const out = [];
  if (!text) return out;

  // Any template invocation opening (with or without params)
  // Example: {{Infobox person|...}} or {{Infobox Omuntu}}
  const rx = /\{\{\s*([^|}\n]+)(?:\|[^}]*)?\}\}?/g;
  let m;
  while ((m = rx.exec(text)) !== null) {
    const n = normalizeTemplateSourceName(m?.[1] || '');
    if (n) out.push(n);
  }

  // Strong hint: infobox-style parameter block likely belongs to an infobox template.
  if (!out.length && /^\s*\|\s*\w+/m.test(text)) {
    const infoboxGuess = text.match(/\{\{\s*(Infobox[^|}\n]*)/i)?.[1];
    const n = normalizeTemplateSourceName(infoboxGuess || '');
    if (n) out.push(n);
  }

  // Deduplicate while preserving order.
  return Array.from(new Set(out));
}

function getSourceTemplateCandidatesForObject(obj) {
  const candidates = [];
  const openTitle = String(obj?.openTitle || '').trim();
  const type = String(obj?.type || '').toLowerCase();

  if (/^template:/i.test(openTitle)) {
    const fromOpen = normalizeTemplateSourceName(openTitle);
    if (fromOpen) candidates.push(fromOpen);
  }

  const fromRaw = extractTemplateCandidatesFromRaw(obj?.raw || '');
  if (fromRaw.length) {
    // Prefer infobox-like templates when present in malformed infobox fragments.
    fromRaw.sort((a, b) => {
      const ai = /template:infobox/i.test(a) ? 0 : 1;
      const bi = /template:infobox/i.test(b) ? 0 : 1;
      return ai - bi;
    });
    candidates.push(...fromRaw);
  }

  const looksTemplateType =
    type.includes('template') ||
    type === 'infobox' ||
    type === 'authority control' ||
    type === 'references template' ||
    type === 'maintenance template' ||
    type === 'citation template';

  if (looksTemplateType) {
    const fromTitle = normalizeTemplateSourceName(obj?.title || '');
    if (fromTitle) candidates.push(fromTitle);
  }

  return Array.from(new Set(candidates));
}

async function resolveCopiedObjectText(obj) {
  const templateCandidates = getSourceTemplateCandidatesForObject(obj);
  if (!templateCandidates.length) {
    return { text: obj.raw, sourceTitle: null };
  }

  if (!objectSourcePageUrl) {
    throw new Error('Build objects from a Wikipedia tab first to resolve template source pages.');
  }

  const errors = [];
  for (const templateTitle of templateCandidates) {
    try {
      const source = await fetchWikipediaWikitextByTitle(objectSourcePageUrl, templateTitle);
      return { text: source.wikitext, sourceTitle: source.title || templateTitle };
    } catch (err) {
      errors.push(`${templateTitle}: ${err?.message || 'fetch failed'}`);
    }
  }

  throw new Error(`Template source fetch failed. Tried: ${errors.join(' | ')}`);
}

async function translateTitlePreservingProperNouns(title) {
  const original = String(title || '').trim();
  if (!original) return 'New_article';

  try {
    const translated = await translateChunkAdaptive(
      [{ text: original }],
      0,
      { preserveNames: true, preserveSyntax: false }
    );
    const candidate = String(translated?.[0] || '').trim();
    return candidate || original;
  } catch (_) {
    return original;
  }
}

async function runTranslate() {
  if (isRunning) return;

  lastRetryAction = runTranslate;
  translationCooldownUntil = 0;
  translationCooldownReason = '';
  translationCooldownAnnouncedAt = 0;
  setRunningState(true);
  setStatus('Starting translation...');

  try {
    await checkProxyHealth();

    await withActiveTab(async (tab) => {
      if (!isWikipediaUrl(tab.url)) {
        throw new Error('Open a Wikipedia article tab first.');
      }

      await ensurePageActionsInjected(tab.id);

      const runtime = getRuntimeParams();
      const collected = await collectPageTexts(tab.id, {
        includeInfobox: prefs.scope === 'article_infobox',
      });
      if (!collected?.ok) {
        throw new Error(collected?.error || 'Unable to collect page text.');
      }

      const texts = collected.texts || [];
      const normalized = texts.map((t) => (t || '').trim()).filter(Boolean);
      const estimatedCacheHits = Math.max(0, normalized.length - new Set(normalized).size);
      setSegmentsValue(texts.length);
      setCacheValue(estimatedCacheHits);

      const translations = new Array(texts.length);
      const chunks = chunkByCharLimit(texts, runtime.chunkCharLimit);
      let done = 0;

      await mapWithConcurrency(chunks, runtime.pageChunkConcurrency, async (chunk, chunkIndex) => {
        const out = await translateChunkAdaptive(chunk);

        for (let i = 0; i < chunk.length; i++) {
          translations[chunk[i].index] = out[i] || chunk[i].text;
          done += 1;
        }

        const percent = Math.round((done / texts.length) * 100);
        setStatus(`Applying chunk ${chunkIndex + 1}/${chunks.length} · ${done}/${texts.length} (${percent}%)`);
      });

      const applyResult = await applyTranslations(tab.id, translations);
      if (!applyResult?.ok) {
        throw new Error(applyResult?.error || 'Failed to apply translated text to page.');
      }

      setStatus(`Done. Translated ${applyResult.appliedCount || 0}/${applyResult.totalNodes || texts.length} segments.`);
    });
  } catch (err) {
    setStatus(err?.message || 'Translation failed.');
  } finally {
    setRunningState(false);
  }
}

async function runRestore() {
  lastRetryAction = runRestore;
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
}

async function runCopy() {
  if (isRunning) return;

  lastRetryAction = runCopy;
  translationCooldownUntil = 0;
  translationCooldownReason = '';
  translationCooldownAnnouncedAt = 0;
  setRunningState(true);
  setStatus('Fetching article source...');
  try {
    await checkProxyHealth();

    await withActiveTab(async (tab) => {
      if (!isWikipediaUrl(tab.url)) {
        throw new Error('Open a Wikipedia article tab first.');
      }

      const runtime = getRuntimeParams();
      const source = await fetchWikipediaWikitext(tab.url);
      setStatus('Translating source while preserving links/refs...');

      const translatedWikitext = await translateWikitextPreservingMarkup(source.wikitext, runtime.copyChunkConcurrency, runtime.chunkCharLimit);
      const normalizedWikitext = normalizeReferenceTemplatePrefixes(translatedWikitext);
      await writeClipboard(normalizedWikitext);

      setStatus('Translating title (preserving names)...');
      const translatedTitle = await translateTitlePreservingProperNouns(source.title);

      const editorUrl = getIncubatorUrlForTitle(translatedTitle || source.title || 'New_article');
      await chrome.tabs.create({ url: editorUrl });

      setStatus(`Copied translated wikitext and opened editor for "${translatedTitle}".`);
    });
  } catch (err) {
    setStatus(err?.message || 'Copy Wikitext failed.');
  } finally {
    setRunningState(false);
  }
}


async function runBuildObjects() {
  if (isRunning) return;

  lastRetryAction = runBuildObjects;
  setRunningState(true);
  setStatus('Fetching source for object builder...');
  try {
    await withActiveTab(async (tab) => {
      if (!isWikipediaUrl(tab.url)) {
        throw new Error('Open a Wikipedia article tab first.');
      }

      const source = await fetchWikipediaWikitext(tab.url);
      objectSourceTitle = source.title || '';
      objectSourcePageUrl = tab.url || '';
      objectBlocks = extractWikitextObjects(source.wikitext);
      renderObjectBlocks();
      setSegmentsValue(objectBlocks.length);
      setCacheValue('-');
      setStatus(`Built ${objectBlocks.length} objects from source.`);
    });
  } catch (err) {
    setStatus(err?.message || 'Object build failed.');
  } finally {
    setRunningState(false);
  }
}


async function loadLocalSeedData() {
  if (!localSeedPanelEl) return;

  try {
    const dataUrl = chrome.runtime.getURL('local-seed-data.json');
    const res = await fetch(dataUrl);
    if (!res.ok) throw new Error('local-seed-data.json not found. Run enable-seeding-mode script.');
    const data = await res.json();
    localSeedItems = Array.isArray(data?.items) ? data.items : [];

    const saved = await chrome.storage.local.get(LOCAL_SEED_INDEX_KEY).catch(() => ({}));
    localSeedIndex = Number(saved?.[LOCAL_SEED_INDEX_KEY] || 0);
    if (!Number.isFinite(localSeedIndex) || localSeedIndex < 0) localSeedIndex = 0;
    if (localSeedIndex >= localSeedItems.length) localSeedIndex = 0;

    localSeedPanelEl.style.display = localSeedItems.length ? 'block' : 'none';
    renderLocalSeedCurrent();
  } catch (err) {
    localSeedPanelEl.style.display = 'block';
    localSeedMetaEl.textContent = err?.message || 'Failed to load local seed data.';
    localSeedPreviewEl.textContent = '';
  }
}

async function saveLocalSeedIndex() {
  await chrome.storage.local.set({ [LOCAL_SEED_INDEX_KEY]: localSeedIndex }).catch(() => {});
}

function renderLocalSeedCurrent() {
  if (!localSeedPanelEl) return;

  if (!localSeedItems.length) {
    localSeedMetaEl.textContent = 'No local seed items available.';
    localSeedPreviewEl.textContent = '';
    return;
  }

  const item = localSeedItems[localSeedIndex];
  localSeedMetaEl.textContent = `${localSeedIndex + 1}/${localSeedItems.length} · ${item.title}`;
  localSeedPreviewEl.textContent = String(item.content || '').slice(0, 240);
}

async function localSeedCopy(openAfterCopy) {
  if (!localSeedItems.length) {
    setStatus('No local seed items loaded.');
    return;
  }

  const item = localSeedItems[localSeedIndex];
  const text = String(item?.content || '');
  if (!text) {
    setStatus(`No content for ${item?.title || 'item'}.`);
    return;
  }

  await writeClipboard(text);

  if (openAfterCopy && item?.edit_url) {
    await chrome.tabs.create({ url: item.edit_url });
    setStatus(`Copied local seed and opened ${item.title}.`);
  } else {
    setStatus(`Copied local seed for ${item.title}.`);
  }
}

async function localSeedNext() {
  if (!localSeedItems.length) return;
  localSeedIndex = (localSeedIndex + 1) % localSeedItems.length;
  await saveLocalSeedIndex();
  renderLocalSeedCurrent();
  setStatus(`Advanced to local seed ${localSeedIndex + 1}/${localSeedItems.length}.`);
}
translateBtn.addEventListener('click', runTranslate);
restoreBtn.addEventListener('click', runRestore);
copyBtn.addEventListener('click', runCopy);
if (objectBtn) objectBtn.addEventListener('click', runBuildObjects);


if (objectListEl) {
  objectListEl.addEventListener('click', async (ev) => {
    const btn = ev.target?.closest?.('button[data-obj-action]');
    if (!btn) return;

    const idx = Number(btn.dataset.idx);
    const action = btn.dataset.objAction;
    const obj = objectBlocks[idx];
    if (!obj) return;

    try {
      const resolved = await resolveCopiedObjectText(obj);
      await writeClipboard(resolved.text);

      const copiedLabel = resolved.sourceTitle
        ? `${obj.type} source (${resolved.sourceTitle})`
        : `${obj.type} object`;

      if (action === 'copy-open') {
        if (obj.openTitle) {
          const url = getIncubatorUrlForTitle(obj.openTitle);
          await chrome.tabs.create({ url });
          setStatus(`Copied ${copiedLabel} and opened ${obj.openTitle}.`);
        } else {
          setStatus(`Copied ${copiedLabel}. No dedicated wiki page target for this object type.`);
        }
      } else {
        setStatus(`Copied ${copiedLabel}.`);
      }
    } catch (err) {
      setStatus(err?.message || 'Failed to copy object.');
    }
  });
}

if (localSeedLoadBtn) {
  localSeedLoadBtn.addEventListener('click', async () => {
    await loadLocalSeedData();
    setStatus(`Loaded local seed queue (${localSeedItems.length} items).`);
  });
}

if (localSeedCopyBtn) {
  localSeedCopyBtn.addEventListener('click', async () => {
    try { await localSeedCopy(false); } catch (err) { setStatus(err?.message || 'Local seed copy failed.'); }
  });
}

if (localSeedCopyOpenBtn) {
  localSeedCopyOpenBtn.addEventListener('click', async () => {
    try { await localSeedCopy(true); } catch (err) { setStatus(err?.message || 'Local seed copy+open failed.'); }
  });
}

if (localSeedNextBtn) {
  localSeedNextBtn.addEventListener('click', async () => {
    try { await localSeedNext(); } catch (err) { setStatus(err?.message || 'Local seed next failed.'); }
  });
}
if (retryBtn) {
  retryBtn.addEventListener('click', async () => {
    if (isRunning || !lastRetryAction) return;
    await lastRetryAction();
  });
}

(async () => {
  await loadPrefs();
  applyPrefsToUI();
  await loadLocalSeedData();
  setStatus(`Ready (v${EXTENSION_VERSION} | iteration ${BUILD_ITERATION})`);
})();

