(() => {
  const MAX_SEGMENTS = 2500;
  const MAX_TOTAL_CHARS = 140000;

  function isVisible(el) {
    if (!el) return false;
    const style = window.getComputedStyle(el);
    return style.display !== 'none' && style.visibility !== 'hidden';
  }

  function shouldSkipElement(el) {
    if (!el || !isVisible(el)) return true;

    if (
      el.closest(
        '#mw-navigation, #catlinks, .navbox, .metadata, .mw-editsection, .reflist, .reference, .sidebar, .infobox, .toc, .thumbcaption, .hatnote, .shortdescription, .portalbox, .vertical-navbox, table.infobox, .mw-parser-output > table'
      )
    ) {
      return true;
    }

    const text = (el.textContent || '').trim();
    if (!text) return true;
    if (!/[A-Za-z]/.test(text)) return true;

    return false;
  }

  function shouldSkipTextNode(node) {
    if (!node || !node.parentElement) return true;
    const parent = node.parentElement;
    const tag = parent.tagName;

    if (/^(SCRIPT|STYLE|NOSCRIPT|CODE|PRE|KBD|SAMP|MATH)$/.test(tag)) return true;

    if (parent.closest('sup.reference, .mw-editsection, .reflist, .reference')) return true;

    const text = node.textContent || '';
    const trimmed = text.trim();
    if (!trimmed) return true;
    if (trimmed.length < 2) return true;
    if (!/[A-Za-z]/.test(trimmed)) return true;

    return false;
  }

  function getArticleRoot() {
    return document.querySelector('#mw-content-text, #bodyContent, #content, article') || document.body;
  }

  function collectBlocks() {
    const root = getArticleRoot();
    const selectors = ['h1', 'h2', 'h3', 'h4', 'p', 'li', 'blockquote', 'figcaption', 'dt', 'dd'].join(',');
    const all = Array.from(root.querySelectorAll(selectors));
    return all.filter((el) => !shouldSkipElement(el));
  }

  function collectTranslatableTextNodes() {
    const blocks = collectBlocks();
    const segments = [];

    for (const block of blocks) {
      const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT);
      let node;
      while ((node = walker.nextNode())) {
        if (shouldSkipTextNode(node)) continue;
        segments.push(node);
      }
    }

    return segments;
  }

  function normalizeLine(text) {
    return (text || '').replace(/\s+/g, ' ').trim();
  }

  function blockToWikiLine(el) {
    const tag = (el.tagName || '').toUpperCase();
    const text = normalizeLine(el.textContent || '');
    if (!text) return '';

    if (tag === 'H1') return `= ${text} =`;
    if (tag === 'H2') return `== ${text} ==`;
    if (tag === 'H3') return `=== ${text} ===`;
    if (tag === 'H4') return `==== ${text} ====`;
    if (tag === 'LI') return `* ${text}`;
    if (tag === 'BLOCKQUOTE') return `: ${text}`;

    return text;
  }

  window.__sunbirdCollectTexts = () => {
    const nodes = collectTranslatableTextNodes();
    if (!nodes.length) {
      return { ok: false, error: 'No translatable article text found.' };
    }

    if (nodes.length > MAX_SEGMENTS) {
      return { ok: false, error: `Page too large (${nodes.length} text segments). Limit is ${MAX_SEGMENTS}.` };
    }

    const texts = nodes.map((n) => n.textContent || '');
    const totalChars = texts.reduce((sum, t) => sum + t.length, 0);

    if (totalChars > MAX_TOTAL_CHARS) {
      return { ok: false, error: `Page text too large (${totalChars} chars). Limit is ${MAX_TOTAL_CHARS}.` };
    }

    return {
      ok: true,
      texts,
      totalNodes: nodes.length,
      totalChars,
    };
  };

  window.__sunbirdApplyTranslations = (translations) => {
    if (!Array.isArray(translations)) {
      return { ok: false, error: 'Translations must be an array.' };
    }

    const nodes = collectTranslatableTextNodes();
    const count = Math.min(nodes.length, translations.length);

    if (!window.__sunbirdRestoreSnapshot || !Array.isArray(window.__sunbirdRestoreSnapshot) || !window.__sunbirdRestoreSnapshot.length) {
      window.__sunbirdRestoreSnapshot = nodes.map((node) => ({ node, original: node.textContent }));
    }

    let applied = 0;
    for (let i = 0; i < count; i++) {
      const out = translations[i];
      if (typeof out === 'string' && out.trim()) {
        nodes[i].textContent = out;
        applied += 1;
      }
    }

    return { ok: true, appliedCount: applied, totalNodes: nodes.length };
  };

  window.__sunbirdGetSourceText = () => {
    const blocks = collectBlocks();
    if (!blocks.length) {
      return { ok: false, error: 'No article text found to copy.' };
    }

    const lines = blocks
      .map((el) => normalizeLine(el.textContent || ''))
      .filter(Boolean);

    return {
      ok: true,
      source: lines.join('\n\n').trim(),
      blockCount: lines.length,
    };
  };

  window.__sunbirdGetWikiDraft = () => {
    const blocks = collectBlocks();
    if (!blocks.length) {
      return { ok: false, error: 'No article text found to draft.' };
    }

    const lines = blocks
      .map((el) => blockToWikiLine(el))
      .filter(Boolean);

    return {
      ok: true,
      draft: lines.join('\n\n').trim(),
      blockCount: lines.length,
    };
  };

  window.__sunbirdRestorePage = () => {
    const snap = window.__sunbirdRestoreSnapshot;
    if (!Array.isArray(snap) || !snap.length) {
      return { ok: true, restoredCount: 0 };
    }

    let restored = 0;
    for (const item of snap) {
      if (item?.node?.isConnected) {
        item.node.textContent = item.original;
        restored += 1;
      }
    }

    window.__sunbirdRestoreSnapshot = [];
    return { ok: true, restoredCount: restored };
  };
})();
