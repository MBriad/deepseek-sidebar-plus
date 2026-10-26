/* DeepSeek Sidebar+ — PDF selection bridge (main world)
 *
 * Edge's built-in PDF viewer exposes a postMessage API on its <embed>:
 *   embed.postMessage({ type: 'getSelectedText' })
 *   → window message { type: 'getSelectedTextReply', selectedText: '...' }
 *
 * The API only works from the page's main world. page-tools.js injects this
 * file as a web-accessible script when it detects a PDF <embed>, then relays
 * the selected text to the extension's isolated content script.
 *
 * PDF *content* is not extracted here: the side panel attaches the PDF file to
 * chat.deepseek.com and lets DeepSeek parse it.
 */
(() => {
  if (window.__DS_PDF_MAIN__) return;

  const embed = document.querySelector('embed[type="application/pdf"], object[type="application/pdf"]');
  if (!embed) return;

  window.__DS_PDF_MAIN__ = true;
  try {
    document.documentElement.dataset.dsPdfBridge = '1';
  } catch {
    // Ignore.
  }

  const HOST_SOURCE = 'ds-pdf-host';
  const MAIN_SOURCE = 'ds-pdf-main';
  const POLL_MS = 700;
  let lastText = '';
  let lastSelectionId = '';
  let selectionSeq = 0;
  let selectionClearTimer = null;
  let selectionRequest = null;
  let pendingText = '';
  let settleTimer = null;

  function post(type, payload = {}) {
    try {
      window.postMessage({ source: MAIN_SOURCE, type, ...payload }, '*');
    } catch {
      // Ignore.
    }
  }

  function title() {
    try {
      const url = new URL(location.href);
      const file = url.searchParams.get('file');
      const source = file || url.pathname;
      const name = decodeURIComponent(source.split('/').filter(Boolean).pop() || '');
      if (name && !/^[0-9a-f-]{20,}$/i.test(name)) return name;
    } catch {
      // Fall through.
    }
    return document.title || 'PDF 文档';
  }

  function askSelected() {
    try {
      embed.postMessage({ type: 'getSelectedText' });
    } catch {
      // The viewer may still be loading; the next poll retries.
    }
  }

  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    const data = event.data;
    if (!data || data.source !== HOST_SOURCE) return;
    if (data.type === 'get-selection') {
      requestSelection(data.id);
    }
  });

  window.addEventListener('message', (event) => {
    const data = event.data;
    if (!data || data.type !== 'getSelectedTextReply') return;

    const text = String(data.selectedText || '');
    if (selectionRequest) {
      finishSelection(text);
      return;
    }
    handlePoll(text);
  });

  setInterval(() => {
    if (document.visibilityState !== 'visible') return;
    if (selectionRequest) return;
    askSelected();
  }, POLL_MS);

  setTimeout(askSelected, 900);

  function handlePoll(text) {
    const value = String(text || '').replace(/\u00a0/g, ' ').trim();

    if (!value) {
      lastText = '';
      pendingText = '';
      clearTimeout(settleTimer);
      if (lastSelectionId) {
        clearTimeout(selectionClearTimer);
        selectionClearTimer = setTimeout(() => {
          if (lastText) return;
          if (!document.hasFocus()) return;
          const selectionId = lastSelectionId;
          lastSelectionId = '';
          post('selection-clear', { selectionId });
        }, 420);
      }
      return;
    }

    if (value === lastText) return;

    // Wait for the selection to stop changing before reporting. Polling a
    // native PDF during a drag returns partial lines; filling the sidebar then
    // clearing the selection would interrupt the user's highlight mid-drag.
    if (value !== pendingText) {
      pendingText = value;
      clearTimeout(settleTimer);
      settleTimer = setTimeout(() => {
        if (pendingText !== value) return;
        lastText = value;
        lastSelectionId = `${Date.now()}-${++selectionSeq}-${Math.random().toString(36).slice(2, 6)}`;
        clearTimeout(selectionClearTimer);
        post('selection', {
          text: value.slice(0, 20000),
          selectionId: lastSelectionId,
          title: title(),
          url: location.href
        });
      }, 450);
    }
  }

  function requestSelection(id) {
    if (!id) return;

    if (selectionRequest) finishSelection('');

    selectionRequest = {
      id,
      timer: setTimeout(() => {
        if (selectionRequest?.id !== id) return;
        selectionRequest = null;
        post('selection-reply', { id, text: '' });
      }, 1800)
    };

    askSelected();
  }

  function finishSelection(text) {
    const request = selectionRequest;
    if (!request) return;
    selectionRequest = null;
    clearTimeout(request.timer);
    post('selection-reply', {
      id: request.id,
      text: String(text || '').slice(0, 20000)
    });
  }
})();
