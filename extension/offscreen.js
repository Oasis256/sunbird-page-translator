chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.target !== 'offscreen-clipboard' || msg?.action !== 'COPY_TO_CLIPBOARD') {
    return false;
  }

  const text = String(msg.text ?? '');

  (async () => {
    try {
      await navigator.clipboard.writeText(text);
      sendResponse({ ok: true });
      return;
    } catch (_err) {
      try {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.setAttribute('readonly', '');
        ta.style.position = 'fixed';
        ta.style.left = '-9999px';
        ta.style.top = '0';
        document.body.appendChild(ta);
        ta.focus();
        ta.select();

        const ok = document.execCommand('copy');
        ta.remove();

        if (!ok) {
          throw new Error('Clipboard copy failed.');
        }

        sendResponse({ ok: true });
      } catch (err) {
        sendResponse({ ok: false, error: err?.message || 'Clipboard copy failed.' });
      }
    }
  })();

  return true;
});
