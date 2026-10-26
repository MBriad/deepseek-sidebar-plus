/* DeepSeek Sidebar+ — page tools content script
 *
 * Runs on normal web pages. Two jobs:
 *   1. Capture text the user highlights and hand it to the side panel.
 *   2. Extract readable page content when the side panel asks for it.
 *
 * The script is deliberately dormant until one of those things happens.
 */
(() => {
  if (window.__DS_PAGE_TOOLS__) return;
  window.__DS_PAGE_TOOLS__ = true;
  try {
    document.documentElement.dataset.dsPageTools = '1';
  } catch {
    // Ignore pages where the root element is not available.
  }

  const MAX_SELECTION = 20000;
  const SKIP_TAGS = new Set([
    'script', 'style', 'noscript', 'template', 'svg', 'canvas', 'iframe',
    'object', 'embed', 'video', 'audio', 'form', 'button', 'input', 'select',
    'textarea', 'nav', 'footer', 'aside', 'dialog', 'menu'
  ]);
  const BLOCK_TAGS = new Set([
    'div', 'section', 'article', 'main', 'header', 'footer', 'figure',
    'figcaption', 'details', 'summary', 'dl', 'dt', 'dd', 'address',
    'fieldset', 'legend', 'center'
  ]);
  const REMOVE_SELECTORS = [
    'nav', 'footer', 'aside', 'form', 'button', 'input', 'select', 'textarea',
    'script', 'style', 'noscript', 'template', 'svg', 'canvas', 'iframe',
    'object', 'embed', 'video', 'audio', 'dialog', 'menu',
    '[role="navigation"]', '[role="banner"]', '[role="contentinfo"]',
    '[role="complementary"]', '[role="dialog"]', '[role="menu"]',
    '[role="toolbar"]', '[role="search"]', '[aria-hidden="true"]', '[hidden]',
    '.sidebar', '.side-bar', '.site-header', '.site-footer', '.page-header',
    '.nav', '.navbar', '.menu', '.advert', '.ads',
    '.advertisement', '.promo', '.promotion', '.related', '.recommend',
    '.recommendation', '.share', '.social', '.newsletter', '.subscribe',
    '.subscription', '.cookie', '.cookies', '.breadcrumb', '.pagination',
    '.comment', '.comments', '.comment-list', '.modal', '.popup', '.login',
    '.toolbar', '.rating', '.tags', '.tag-list', '.byline',
    '.author-bio', '.post-nav', '.post-navigation', '.toc', '#comments',
    '#sidebar', '#footer', '#header', '#nav', '#menu'
  ];
  const NEGATIVE = /(?:^|[\s_-])(comment|comments|sidebar|side-bar|site-header|site-footer|page-header|nav|navbar|menu|advert|ads|advertisement|banner|promo|promotion|related|recommend|recommendation|share|social|breadcrumb|pagination|modal|popup|subscribe|newsletter|login|cookie|rating|toolbar|byline|author-bio|post-nav|toc)(?:$|[\s_-])/i;
  const POSITIVE = /article|content|post|entry|main|markdown|story|blog|body|text|rich_media/i;

  let toastEnabled = true;
  let toastHost = null;
  let toastTimer = null;
  let lastSelectionText = '';
  let lastSelectionAt = 0;
  let selectionTimer = null;
  let selectionClearTimer = null;
  let selectionSeq = 0;
  let activeSelectionId = '';
  let suppressClearUntil = 0;
  let ignoreSyntheticClear = false;
  let typeRelay = null;
  let typeRelayHost = null;
  let typeRelayAnchor = null;
  let typeRelayActive = false;
  let typeRelayComposing = false;
  let typeRelayShortcut = 'Ctrl+Z';
  let lastSelectionRect = null;
  let lastPointer = null;
  let pdfBridgeInstalled = false;
  let pdfBridgeTried = false;
  let pdfListenerAttached = false;
  let pdfSelectionSeq = 0;
  const pdfSelectionPending = new Map();

  loadToastSetting();
  installSelectionCapture();
  setupPdfBridge();
  setTimeout(setupPdfBridge, 800);
  setTimeout(setupPdfBridge, 2000);
  setTimeout(setupPdfBridge, 5000);

  /* ---------------------------------------------------------------- */
  /* Settings                                                         */
  /* ---------------------------------------------------------------- */

  function loadToastSetting() {
    try {
      chrome.storage.local.get('settings', (stored) => {
        if (chrome.runtime.lastError) return;
        const settings = stored?.settings || {};
        if (typeof settings.showPageToast === 'boolean') toastEnabled = settings.showPageToast;
      });
      chrome.storage.onChanged.addListener((changes, area) => {
        if (area !== 'local' || !changes.settings) return;
        const next = changes.settings.newValue || {};
        if (typeof next.showPageToast === 'boolean') toastEnabled = next.showPageToast;
      });
    } catch {
      // Extension context can be invalidated during a reload; ignore.
    }
  }

  /* ---------------------------------------------------------------- */
  /* Selection capture                                                */
  /* ---------------------------------------------------------------- */

  function handlePageRelayKey(event) {
    if (!typeRelayActive) return;
    if (event.target === typeRelay) return;
    if (event.isComposing || event.keyCode === 229) return;

    const target = event.target;
    if (target?.closest?.('input, textarea, select, [contenteditable="true"], [role="textbox"]')) {
      return;
    }

    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      event.stopPropagation();
      stopTypeRelay(false, true);
      return;
    }
    if (event.key === 'Escape' || shortcutMatches(event, typeRelayShortcut)) {
      event.preventDefault();
      event.stopPropagation();
      stopTypeRelay(true);
      return;
    }
    if (event.key === 'Backspace') {
      event.preventDefault();
      event.stopPropagation();
      typeRelay.value = typeRelay.value.slice(0, -1);
      relaySend('DS_TYPE_RELAY_TEXT', { text: typeRelay.value });
      return;
    }

    let character = event.key.length === 1 ? event.key : '';
    if (!character && event.code === 'Space') character = ' ';
    if (!character && /^Key[A-Z]$/.test(event.code || '')) character = event.code.slice(3).toLowerCase();
    if (!character && /^Digit[0-9]$/.test(event.code || '')) character = event.code.slice(5);
    if (character && !event.ctrlKey && !event.metaKey && !event.altKey) {
      event.preventDefault();
      event.stopPropagation();
      typeRelay.value += character;
      relaySend('DS_TYPE_RELAY_TEXT', { text: typeRelay.value });
    }
  }

  function installSelectionCapture() {
    const schedule = () => {
      clearTimeout(selectionTimer);
      selectionTimer = setTimeout(captureSelection, 40);
    };

    document.addEventListener('pointerup', (event) => {
      lastPointer = { x: Number(event.clientX) || 0, y: Number(event.clientY) || 0 };
      // Capture and clear synchronously on mouseup. Waiting 160ms lets Edge
      // open its copy/search mini toolbar first, which then takes longer to
      // retract and can steal focus from the floating input. A short retry is
      // still needed: some pages finalize the selection just after pointerup.
      clearTimeout(selectionTimer);
      captureSelection();
      selectionTimer = setTimeout(captureSelection, 40);
    }, true);
    document.addEventListener('touchend', (event) => {
      const touch = event.changedTouches?.[0];
      if (touch) lastPointer = { x: touch.clientX, y: touch.clientY };
      clearTimeout(selectionTimer);
      selectionTimer = setTimeout(captureSelection, 0);
    }, true);

    // A real click on the page is an explicit cancel/return: end any focus
    // suppression immediately and re-check the selection.
    document.addEventListener('pointerdown', (event) => {
      if (!activeSelectionId) return;
      if (typeRelayHost && event.composedPath().includes(typeRelayHost)) return;
      ignoreSyntheticClear = false;
      suppressClearUntil = 0;
      clearTimeout(selectionClearTimer);
      selectionClearTimer = setTimeout(notifySelectionCleared, 180);
    }, true);
    document.addEventListener('keyup', (event) => {
      if (event.key === 'Shift' || event.shiftKey) schedule();
    }, true);

    document.addEventListener('keydown', handlePageRelayKey, true);
    document.addEventListener('selectionchange', () => {
      const selection = window.getSelection();
      if (selection && !selection.isCollapsed && selection.rangeCount > 0) {
        clearTimeout(selectionClearTimer);
        return;
      }
      if (!activeSelectionId) return;
      clearTimeout(selectionClearTimer);
      selectionClearTimer = setTimeout(notifySelectionCleared, 260);
    });

    try {
      chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
        if (message?.type === 'DS_SUPPRESS_SELECTION_CLEAR') {
          suppressClearUntil = Date.now() + Math.max(0, Math.min(Number(message.ms) || 900, 2000));
          sendResponse({ ok: true });
          return;
        }
        if (message?.type === 'DS_START_TYPE_RELAY') {
          startTypeRelay(String(message.shortcut || 'Ctrl+Z'));
          sendResponse({ ok: typeRelayActive });
          return;
        }
        if (message?.type === 'DS_STOP_TYPE_RELAY') {
          stopTypeRelay(Boolean(message.cancel));
          sendResponse({ ok: true });
        }
      });
    } catch {
      // Extension context can be invalidated during a reload.
    }

    // Do not clear while the page has lost focus to the side panel; check
    // again when the user returns to the page.
    window.addEventListener('focus', () => {
      suppressClearUntil = 0;
      if (!activeSelectionId) return;
      clearTimeout(selectionClearTimer);
      selectionClearTimer = setTimeout(notifySelectionCleared, 120);
      // Catch a click/focus that collapses the selection slightly later.
      setTimeout(() => {
        if (activeSelectionId) notifySelectionCleared();
      }, 460);
    });
  }

  function notifySelectionCleared() {
    if (!activeSelectionId) return;
    if (typeRelayActive) return;
    if (ignoreSyntheticClear) return;
    if (Date.now() < suppressClearUntil) return;
    // We clear the DOM selection ourselves immediately after capturing it so
    // Edge's copy/search mini toolbar goes away. Do not report that synthetic
    // clear as a user cancel while the sidebar is still filling/starting the
    // relay, otherwise no floating input is created.
    if (Date.now() - lastSelectionAt < 6000) return;
    if (!document.hasFocus()) return;

    const selection = window.getSelection();
    if (selection && !selection.isCollapsed && selection.rangeCount > 0) return;

    const selectionId = activeSelectionId;
    activeSelectionId = '';
    lastSelectionText = '';
    lastSelectionAt = 0;

    try {
      chrome.runtime.sendMessage({
        type: 'DS_PAGE_SELECTION_CLEARED',
        selectionId,
        url: location.href
      }, () => {
        void chrome.runtime.lastError;
      });
    } catch {
      // Extension context invalidated.
    }
  }

  function sendSelectionCleared(selectionId) {
    if (!selectionId) return;
    if (ignoreSyntheticClear) return;
    if (Date.now() - lastSelectionAt < 6000) return;
    if (activeSelectionId && activeSelectionId !== selectionId) return;

    activeSelectionId = '';
    lastSelectionText = '';
    lastSelectionAt = 0;

    try {
      chrome.runtime.sendMessage({
        type: 'DS_PAGE_SELECTION_CLEARED',
        selectionId,
        url: location.href
      }, () => {
        void chrome.runtime.lastError;
      });
    } catch {
      // Ignore.
    }
  }

  function shortcutMatches(event, shortcut) {
    const parts = String(shortcut || 'Ctrl+Z').split('+').map((part) => part.trim()).filter(Boolean);
    const key = parts.pop() || 'Z';
    const ctrl = parts.some((part) => /^(ctrl|control|cmd|command|meta)$/i.test(part));
    const alt = parts.some((part) => /^alt$/i.test(part));
    const shift = parts.some((part) => /^shift$/i.test(part));
    const hasCtrl = event.ctrlKey || event.metaKey;
    return hasCtrl === ctrl
      && event.altKey === alt
      && event.shiftKey === shift
      && String(event.key || '').toLowerCase() === key.toLowerCase();
  }

  function relaySend(type, payload = {}) {
    try {
      chrome.storage.local.set({
        dsTypeRelay: {
          type,
          ...payload,
          seq: Date.now()
        }
      }).catch(() => {});
    } catch {
      // Extension context invalidated.
    }
  }

  function positionTypeRelay() {
    if (!typeRelayHost) return;
    const width = Math.min(320, Math.max(220, window.innerWidth - 16));
    typeRelayHost.style.width = `${width}px`;

    let left = 8;
    let top = Math.max(8, window.innerHeight - 58);
    if (typeRelayAnchor) {
      const anchorLeft = typeRelayAnchor.left - window.scrollX;
      const anchorTop = typeRelayAnchor.top - window.scrollY;
      const anchorBottom = typeRelayAnchor.bottom - window.scrollY;
      left = Math.min(Math.max(8, anchorLeft), Math.max(8, window.innerWidth - width - 8));
      top = anchorBottom + 8;
      if (top + 42 > window.innerHeight - 8) top = Math.max(8, anchorTop - 50);
    }
    typeRelayHost.style.left = `${left}px`;
    typeRelayHost.style.top = `${top}px`;
  }

  function ensureTypeRelay() {
    if (typeRelayHost) return typeRelay;

    typeRelayHost = document.createElement('div');
    typeRelayHost.id = 'ds-type-relay';
    typeRelayHost.style.cssText = 'all:initial;position:fixed;z-index:2147483647;display:none;';
    const root = typeRelayHost.attachShadow({ mode: 'open' });
    root.innerHTML = `
      <style>
        * { box-sizing: border-box; }
        .panel {
          display: flex;
          align-items: center;
          gap: 8px;
          padding: 7px 9px;
          border: 1px solid #4d6bfe;
          border-radius: 10px;
          background: #fff;
          color: #1b1f2a;
          box-shadow: 0 10px 30px rgba(15, 23, 42, .22);
          font: 12px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", "Microsoft YaHei", sans-serif;
        }
        .dot {
          flex: none;
          width: 7px;
          height: 7px;
          border-radius: 50%;
          background: #4d6bfe;
        }
        input {
          min-width: 0;
          flex: 1;
          border: 0;
          outline: 0;
          background: transparent;
          color: #1b1f2a;
          font: 13px/1.4 inherit;
        }
        input::placeholder { color: #8a96a8; }
        .hint {
          flex: none;
          color: #8a96a8;
          font-size: 9.5px;
          white-space: nowrap;
        }
      </style>
      <div class="panel">
        <span class="dot"></span>
        <input id="ds-type-relay-input" type="text" autocomplete="off" spellcheck="false" placeholder="直接输入…">
        <span class="hint">Enter 完成 · Ctrl+Z 撤回</span>
      </div>`;
    document.documentElement.appendChild(typeRelayHost);

    typeRelay = root.querySelector('#ds-type-relay-input');
    root.querySelector('.hint').textContent = `${typeRelayShortcut} 撤回`;

    typeRelay.addEventListener('compositionstart', () => {
      typeRelayComposing = true;
    });
    typeRelay.addEventListener('compositionend', () => {
      typeRelayComposing = false;
      if (typeRelayActive) relaySend('DS_TYPE_RELAY_TEXT', { text: typeRelay.value });
    });
    typeRelay.addEventListener('input', () => {
      if (!typeRelayActive || typeRelayComposing) return;
      relaySend('DS_TYPE_RELAY_TEXT', { text: typeRelay.value });
    });
    typeRelay.addEventListener('keydown', (event) => {
      if (!typeRelayActive) return;
      if (event.isComposing || event.keyCode === 229) return;
      if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation();
        stopTypeRelay(false, true);
        return;
      }
      if (event.key === 'Escape' || shortcutMatches(event, typeRelayShortcut)) {
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation();
        stopTypeRelay(true);
      }
    }, true);
    typeRelay.addEventListener('blur', () => {
      if (!typeRelayActive) return;
      setTimeout(() => {
        if (!typeRelayActive) return;
        if (!typeRelayHost?.shadowRoot?.activeElement) stopTypeRelay(false);
      }, 0);
    });
    typeRelayHost.addEventListener('pointerdown', (event) => {
      event.stopPropagation();
    });
    window.addEventListener('scroll', positionTypeRelay, true);
    window.addEventListener('resize', positionTypeRelay);

    return typeRelay;
  }

  function startTypeRelay(shortcut) {
    if (!activeSelectionId) return;
    typeRelayShortcut = shortcut || 'Ctrl+Z';

    typeRelayAnchor = lastSelectionRect
      ? { ...lastSelectionRect }
      : lastPointer
        ? {
            left: lastPointer.x + window.scrollX,
            top: lastPointer.y + window.scrollY,
            right: lastPointer.x + window.scrollX,
            bottom: lastPointer.y + window.scrollY,
            width: 0,
            height: 0
          }
        : null;

    const relay = ensureTypeRelay();
    relay.value = '';
    const hint = typeRelayHost?.shadowRoot?.querySelector('.hint');
    if (hint) hint.textContent = `Enter 完成 · ${typeRelayShortcut} 撤回`;
    typeRelayHost.style.display = 'block';
    positionTypeRelay();
    typeRelayActive = true;
    typeRelayComposing = false;
    const focusRelay = () => {
      try {
        relay.focus({ preventScroll: true });
      } catch {
        // Focus is best-effort.
      }
    };
    focusRelay();
    if (typeRelayHost.shadowRoot?.activeElement !== relay) {
      // Edge may keep focus in the browser selection toolbar. Keep the relay
      // alive and retry; the document-level key handler is a second path.
      setTimeout(() => {
        if (typeRelayActive) focusRelay();
      }, 80);
    }
    // Dismiss Edge's floating copy/paste selection toolbar. Do not do this on
    // the native PDF viewer: clearing its selection mid-drag interrupts the
    // user's highlight. The PDF bridge reports the final text itself.
    if (!isPdfViewer()) {
      try {
        window.getSelection()?.removeAllRanges();
      } catch {
        // Ignore.
      }
    }
    showToast(`可直接输入 · ${typeRelayShortcut} 撤回`);
  }

  function stopTypeRelay(cancel, send = false) {
    if (!typeRelayActive) return;
    typeRelayActive = false;
    typeRelayComposing = false;
    ignoreSyntheticClear = false;
    activeSelectionId = '';
    lastSelectionText = '';
    lastSelectionAt = 0;
    try {
      typeRelay?.blur();
      if (typeRelay) typeRelay.value = '';
      if (typeRelayHost) typeRelayHost.style.display = 'none';
      typeRelayAnchor = null;
    } catch {
      // Ignore.
    }

    if (cancel) {
      try {
        window.getSelection()?.removeAllRanges();
      } catch {
        // Ignore.
      }
      relaySend('DS_TYPE_RELAY_CANCEL');
      showToast('已撤回自动填入');
    } else {
      relaySend('DS_TYPE_RELAY_END', send ? { send: true } : {});
    }
  }

  function captureSelectionRect() {
    try {
      const selection = window.getSelection();
      if (!selection || !selection.rangeCount) return;
      const range = selection.getRangeAt(0);
      const rects = Array.from(range.getClientRects()).filter((rect) => rect.width || rect.height);
      const rect = rects[rects.length - 1] || range.getBoundingClientRect();
      if (rect && (rect.width || rect.height)) {
        lastSelectionRect = {
          left: rect.left + window.scrollX,
          top: rect.top + window.scrollY,
          right: rect.right + window.scrollX,
          bottom: rect.bottom + window.scrollY,
          width: rect.width,
          height: rect.height
        };
        return;
      }
    } catch {
      // Ignore unusual selections.
    }
    if (lastPointer) {
      lastSelectionRect = {
        left: lastPointer.x + window.scrollX,
        top: lastPointer.y + window.scrollY,
        right: lastPointer.x + window.scrollX,
        bottom: lastPointer.y + window.scrollY,
        width: 0,
        height: 0
      };
    }
  }

  function captureSelection() {
    try {
      const selection = window.getSelection();
      if (!selection || selection.isCollapsed || selection.rangeCount === 0) return;

      const raw = selection.toString().replace(/\u00a0/g, ' ').trim();
      if (raw.length < 2) return;

      const anchor = selection.anchorNode;
      const anchorElement = anchor?.nodeType === Node.ELEMENT_NODE ? anchor : anchor?.parentElement;
      if (!anchorElement) return;

      // Never lift text out of form fields / editors on the page.
      if (anchorElement.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="textbox"]')) {
        return;
      }

      captureSelectionRect();
      sendSelection(raw, document.title || '', location.href);
      // Clear the DOM selection immediately after capturing its rect. Edge's
      // native copy/search mini toolbar is driven by the selection and would
      // otherwise stay above the floating input and swallow Enter. The native
      // PDF bridge owns its own selection; clearing it here interrupts drag.
      if (!isPdfViewer()) {
        try {
          selection.removeAllRanges();
        } catch {
          // Ignore.
        }
      }
    } catch {
      // The extension was reloaded, or this page has an unusual selection.
    }
  }

  function sendSelection(rawText, title, url, externalSelectionId = '') {
    try {
      const raw = String(rawText || '').replace(/\u00a0/g, ' ').trim();
      if (raw.length < 2) return;

      const text = raw.slice(0, MAX_SELECTION);
      const now = Date.now();
      if (text === lastSelectionText && now - lastSelectionAt < 4000) return;

      const selectionId = externalSelectionId ||
        `${now}-${++selectionSeq}-${Math.random().toString(36).slice(2, 6)}`;
      activeSelectionId = selectionId;
      ignoreSyntheticClear = true;
      clearTimeout(selectionClearTimer);
      lastSelectionText = text;
      lastSelectionAt = now;

      chrome.runtime.sendMessage({
        type: 'DS_PAGE_SELECTION',
        text,
        selectionId,
        title: title || document.title || '',
        url: url || location.href,
        ts: now
      }, (response) => {
        if (chrome.runtime.lastError) return;
        if (!response?.stored || !toastEnabled) return;
        showToast(response.delivered
          ? '已发送到 DeepSeek 侧边栏'
          : '已暂存，打开 DeepSeek 侧边栏后填入');
      });
    } catch {
      // The extension was reloaded; ignore.
    }
  }

  function showToast(message) {
    try {
      if (!toastHost || !toastHost.isConnected) {
        toastHost = document.createElement('div');
        toastHost.id = 'ds-plus-page-toast-host';
        toastHost.style.cssText = 'all:initial;position:fixed;right:16px;bottom:16px;z-index:2147483647;pointer-events:none;';
        const root = toastHost.attachShadow({ mode: 'open' });
        root.innerHTML = `
          <style>
            .pill {
              font: 500 12px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", "Microsoft YaHei", sans-serif;
              color: #fff;
              background: rgba(24, 26, 33, .94);
              border: 1px solid rgba(255, 255, 255, .12);
              padding: 8px 12px;
              border-radius: 999px;
              box-shadow: 0 6px 24px rgba(0, 0, 0, .22);
              opacity: 0;
              transform: translateY(6px);
              transition: opacity .18s ease, transform .18s ease;
              white-space: nowrap;
              max-width: 70vw;
              overflow: hidden;
              text-overflow: ellipsis;
            }
            .pill.show { opacity: 1; transform: translateY(0); }
          </style>
          <div class="pill" role="status" aria-live="polite"></div>
        `;
        document.documentElement.appendChild(toastHost);
      }
      const pill = toastHost.shadowRoot.querySelector('.pill');
      pill.textContent = message;
      pill.classList.add('show');
      clearTimeout(toastTimer);
      toastTimer = setTimeout(() => pill.classList.remove('show'), 2200);
    } catch {
      // Ignore UI failures.
    }
  }

  function currentSelection() {
    try {
      const selection = window.getSelection();
      if (!selection || selection.isCollapsed) return '';
      return selection.toString().replace(/\u00a0/g, ' ').trim().slice(0, MAX_SELECTION);
    } catch {
      return '';
    }
  }

  /* ---------------------------------------------------------------- */
  /* PDF selection bridge                                             */
  /* ---------------------------------------------------------------- */

  function findPdfEmbed() {
    try {
      return document.querySelector('embed[type="application/pdf"], object[type="application/pdf"]');
    } catch {
      return null;
    }
  }

  function isPdfViewer() {
    return Boolean(findPdfEmbed());
  }

  function setupPdfBridge() {
    if (pdfBridgeInstalled || pdfBridgeTried) return;
    if (!findPdfEmbed()) return;

    pdfBridgeTried = true;
    if (!pdfListenerAttached) {
      window.addEventListener('message', onPdfBridgeMessage);
      pdfListenerAttached = true;
    }

    try {
      const script = document.createElement('script');
      script.src = chrome.runtime.getURL('src/content/pdf-main.js');
      script.onload = () => {
        pdfBridgeInstalled = true;
        script.remove();
      };
      script.onerror = () => {
        pdfBridgeTried = false;
        try {
          script.remove();
        } catch {
          // Ignore.
        }
      };
      (document.head || document.documentElement).appendChild(script);
    } catch {
      pdfBridgeTried = false;
    }
  }

  function onPdfBridgeMessage(event) {
    if (event.source !== window) return;
    const data = event.data;
    if (!data || data.source !== 'ds-pdf-main') return;

    if (data.type === 'selection') {
      sendSelection(data.text, data.title, data.url, data.selectionId);
      return;
    }

    if (data.type === 'selection-clear') {
      sendSelectionCleared(data.selectionId);
      return;
    }

    if (data.type === 'selection-reply') {
      const pending = pdfSelectionPending.get(data.id);
      if (!pending) return;
      clearTimeout(pending.timer);
      pdfSelectionPending.delete(data.id);
      pending.resolve(String(data.text || ''));
    }
  }

  function requestPdfSelection() {
    return new Promise((resolve, reject) => {
      if (!findPdfEmbed()) {
        reject(new Error('没有找到 PDF 阅读器'));
        return;
      }

      setupPdfBridge();

      const id = ++pdfSelectionSeq;
      const timer = setTimeout(() => {
        pdfSelectionPending.delete(id);
        resolve('');
      }, 2800);

      pdfSelectionPending.set(id, { resolve, reject, timer });

      let attempts = 0;
      const send = () => {
        if (!pdfSelectionPending.has(id)) return;
        try {
          window.postMessage({ source: 'ds-pdf-host', type: 'get-selection', id }, '*');
        } catch {
          // Ignore.
        }
        attempts += 1;
        if (attempts < 4) setTimeout(send, 320);
      };
      send();
    });
  }

  function pdfTitle() {
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

  /* ---------------------------------------------------------------- */
  /* Message handling                                                 */
  /* ---------------------------------------------------------------- */

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!message || typeof message !== 'object') return;

    if (message.type === 'DS_GET_SELECTION') {
      if (isPdfViewer()) {
        requestPdfSelection()
          .then((text) => sendResponse({
            ok: true,
            text,
            title: pdfTitle(),
            url: location.href
          }))
          .catch((error) => sendResponse({ ok: false, error: error.message }));
        return true;
      }

      sendResponse({
        ok: true,
        text: currentSelection(),
        title: document.title || '',
        url: location.href
      });
      return false;
    }

    if (message.type === 'DS_EXTRACT_PAGE') {
      try {
        // Some PDF paths have no .pdf suffix; the PDF wrapper has almost no
        // DOM text, so report it as a PDF tab and let the side panel attach the
        // file to DeepSeek instead of trying to extract DOM text.
        if (isPdfViewer() && (document.body?.innerText || '').trim().length < 40) {
          sendResponse({
            ok: false,
            code: 'pdf-tab',
            pdfUrl: location.href,
            title: pdfTitle(),
            error: '这是一个 PDF 文件，请上传到 DeepSeek 读取。'
          });
          return false;
        }

        const maxChars = clamp(Number(message.maxChars) || 12000, 1000, 50000);
        const mode = message.mode === 'full' ? 'full' : 'readable';
        sendResponse(extractPage(maxChars, mode));
      } catch (error) {
        sendResponse({ ok: false, error: error.message || '网页正文提取失败。' });
      }
      return false;
    }
  });

  /* ---------------------------------------------------------------- */
  /* Page extraction                                                  */
  /* ---------------------------------------------------------------- */

  function extractPage(maxChars, mode) {
    const meta = readMetadata();
    const body = document.body;
    const documentElement = document.documentElement;
    const fullText = cleanPlainText(body?.innerText || documentElement?.innerText || '');
    const totalChars = fullText.length;

    let text = '';
    let usedMode = mode;
    let warning = '';

    if (mode === 'readable') {
      const candidate = pickBestCandidate();
      if (candidate) {
        try {
          text = markdownFrom(candidate);
        } catch {
          text = '';
        }
      }

      // A tiny "readable" result usually means the heuristic picked a nav box.
      // Also fall back when the candidate only covers a small part of the page:
      // Yuanbao-style page reading uses document.body.innerText, so err on the
      // side of including more text instead of silently dropping content.
      const candidateLength = text.trim().length;
      const coverage = fullText.length > 0 ? candidateLength / fullText.length : 1;
      if (
        (candidateLength < 200 && fullText.length > 400) ||
        (fullText.length > 800 && coverage < 0.45)
      ) {
        text = fullText;
        usedMode = 'full';
        warning = '智能正文覆盖不足，已自动改用整页文本。';
      }
    }

    if (mode === 'full' || !text.trim()) {
      text = fullText;
      usedMode = 'full';
    }

    text = cleanMarkdown(text);
    if (!text.trim()) {
      return {
        ok: false,
        error: '这个页面没有可读取的文字内容（可能是 PDF、纯图片或特殊页面）。'
      };
    }

    const limited = limitText(text, maxChars);
    return {
      ok: true,
      ...meta,
      text: limited.text,
      charCount: limited.text.length,
      totalCharCount: totalChars,
      truncated: limited.truncated,
      mode: usedMode,
      warning
    };
  }

  function readMetadata() {
    const meta = (selector) => {
      const el = document.querySelector(selector);
      return el?.getAttribute('content')?.trim() || '';
    };
    const link = (selector) => {
      const el = document.querySelector(selector);
      return el?.getAttribute('href')?.trim() || '';
    };

    const canonical = link('link[rel="canonical"]');
    const title = meta('meta[property="og:title"]') || meta('meta[name="twitter:title"]') || document.title || '';
    const siteName = meta('meta[property="og:site_name"]') || '';
    const description = meta('meta[name="description"]') || meta('meta[property="og:description"]') || '';

    return {
      title: title.trim(),
      url: canonical && /^https?:/i.test(canonical) ? canonical : location.href,
      siteName: siteName.trim(),
      description: description.trim(),
      author: (meta('meta[name="author"]') || meta('meta[property="article:author"]')).trim(),
      published: (meta('meta[property="article:published_time"]') || meta('meta[name="date"]') || meta('meta[name="pubdate"]')).trim()
    };
  }

  function pickBestCandidate() {
    const selectors = [
      'article', 'main', '[role="main"]', '.article', '.post', '.entry-content',
      '.post-content', '.article-content', '.article-body', '.article__body',
      '.markdown-body', '.rich_media_content', '.story', '.blog-post', '.entry',
      '.page-content', '.content', '#content', '#main'
    ];

    const nodes = new Set();
    for (const selector of selectors) {
      try {
        document.querySelectorAll(selector).forEach((node) => nodes.add(node));
      } catch {
        // Ignore an invalid selector on an exotic page.
      }
    }
    if (document.body) nodes.add(document.body);

    const scored = [];
    for (const node of nodes) {
      if (!node || node === document.documentElement) continue;
      const textLength = (node.innerText || '').trim().length;
      if (textLength < 180) continue;
      scored.push({ node, length: textLength, score: scoreCandidate(node, textLength) });
    }

    scored.sort((a, b) => b.score - a.score);
    return scored[0]?.node || null;
  }

  function scoreCandidate(node, textLength) {
    let score = Math.min(textLength, 15000);
    const paragraphs = node.querySelectorAll('p').length;
    const headings = node.querySelectorAll('h1, h2, h3, h4').length;
    score += Math.min(paragraphs, 100) * 110;
    score += Math.min(headings, 24) * 55;

    const tag = node.tagName;
    if (tag === 'ARTICLE') score += 1800;
    if (tag === 'MAIN') score += 900;

    const className = typeof node.className === 'string' ? node.className : '';
    const id = node.id || '';
    const signature = `${className} ${id}`;
    if (POSITIVE.test(signature)) score += 1200;
    if (NEGATIVE.test(signature)) score -= 3500;

    // Text inside links is rarely article prose.
    let linkLength = 0;
    node.querySelectorAll('a').forEach((a) => {
      linkLength += (a.innerText || '').trim().length;
    });
    const linkDensity = Math.min(linkLength / Math.max(textLength, 1), 0.9);
    score *= (1 - linkDensity);

    // The body element is a fallback; prefer semantic containers.
    if (tag === 'BODY') score *= 0.72;
    return score;
  }

  function markdownFrom(root) {
    const clone = root.cloneNode(true);
    cleanClone(clone);
    const markdown = elementToMarkdown(clone);
    return cleanMarkdown(markdown);
  }

  function cleanClone(clone) {
    for (const selector of REMOVE_SELECTORS) {
      try {
        clone.querySelectorAll(selector).forEach((node) => node.remove());
      } catch {
        // Ignore invalid selectors.
      }
    }

    // Remove obvious non-content blocks by class/id, but never the root itself.
    clone.querySelectorAll('*').forEach((node) => {
      const className = typeof node.className === 'string' ? node.className : '';
      const signature = `${className} ${node.id || ''}`;
      if (NEGATIVE.test(signature)) node.remove();
    });
  }

  function elementToMarkdown(node) {
    if (!node) return '';
    if (node.nodeType === Node.TEXT_NODE) {
      return normalizeInlineText(node.nodeValue || '');
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return '';

    const tag = node.tagName.toLowerCase();
    if (SKIP_TAGS.has(tag)) return '';
    if (node.hidden || node.getAttribute('aria-hidden') === 'true') return '';

    switch (tag) {
      case 'br':
        return '\n';
      case 'hr':
        return '\n\n---\n\n';
      case 'h1':
      case 'h2':
      case 'h3':
      case 'h4':
      case 'h5':
      case 'h6': {
        const level = Number(tag.slice(1));
        const text = inlineContent(node);
        return text ? `\n\n${'#'.repeat(level)} ${text}\n\n` : '';
      }
      case 'p':
        return `\n\n${inlineContent(node)}\n\n`;
      case 'li':
        return `\n- ${inlineContent(node)}\n`;
      case 'blockquote': {
        const text = inlineContent(node);
        return text ? `\n\n${text.split('\n').map((line) => `> ${line}`).join('\n')}\n\n` : '';
      }
      case 'pre':
        return codeBlock(node);
      case 'code':
        return `\`${String(node.textContent || '').replace(/`/g, '\\`')}\``;
      case 'table':
        return tableToMarkdown(node);
      case 'ul':
      case 'ol':
        return listToMarkdown(node);
      case 'strong':
      case 'b': {
        const text = inlineContent(node);
        return text ? `**${text}**` : '';
      }
      case 'em':
      case 'i': {
        const text = inlineContent(node);
        return text ? `*${text}*` : '';
      }
      case 'del':
      case 's':
      case 'strike': {
        const text = inlineContent(node);
        return text ? `~~${text}~~` : '';
      }
      case 'a':
        return inlineContent(node);
      case 'img':
        return '';
      case 'dt':
        return `\n**${inlineContent(node)}**\n`;
      case 'dd':
        return `\n${inlineContent(node)}\n`;
      case 'figcaption':
        return `\n${inlineContent(node)}\n`;
      default:
        if (BLOCK_TAGS.has(tag)) {
          return `\n\n${childNodesToMarkdown(node)}\n\n`;
        }
        return childNodesToMarkdown(node);
    }
  }

  function inlineContent(node) {
    const value = childNodesToMarkdown(node);
    return value
      .replace(/[ \t]+/g, ' ')
      .replace(/ *\n */g, ' ')
      .trim();
  }

  function childNodesToMarkdown(node) {
    return Array.from(node.childNodes).map(elementToMarkdown).join('');
  }

  function codeBlock(node) {
    const code = node.querySelector('code') || node;
    const className = typeof code.className === 'string' ? code.className : '';
    const match = className.match(/language-([\w+-]+)/);
    const language = match ? match[1] : '';
    const content = String(code.textContent || '').replace(/\n+$/, '');
    return `\n\n\`\`\`${language}\n${content}\n\`\`\`\n\n`;
  }

  function listToMarkdown(node) {
    const ordered = node.tagName.toLowerCase() === 'ol';
    let index = 1;
    const lines = [];

    for (const child of node.children) {
      if (child.tagName.toLowerCase() !== 'li') continue;
      const text = inlineContent(child).replace(/\s*\n+\s*/g, ' ').trim();
      if (!text) continue;
      lines.push(`${ordered ? `${index}.` : '-'} ${text}`);
      index += 1;
    }

    return lines.length ? `\n${lines.join('\n')}\n` : '';
  }

  function tableToMarkdown(node) {
    const rows = Array.from(node.querySelectorAll('tr'));
    if (!rows.length) return '';

    const values = rows.map((row) => Array.from(row.querySelectorAll('th, td')).map((cell) => (
      inlineContent(cell).replace(/\|/g, '\\|').replace(/\s+/g, ' ').trim()
    ))).filter((row) => row.length);

    if (!values.length) return '';

    const width = Math.max(...values.map((row) => row.length));
    const normalized = values.map((row) => {
      const copy = row.slice();
      while (copy.length < width) copy.push('');
      return copy;
    });

    const header = normalized[0];
    const separator = header.map(() => '---');
    const body = normalized.slice(1);
    return `\n\n| ${header.join(' | ')} |\n| ${separator.join(' | ')} |\n${body.map((row) => `| ${row.join(' | ')} |`).join('\n')}\n\n`;
  }

  function normalizeInlineText(value) {
    return String(value)
      .replace(/\u00a0/g, ' ')
      .replace(/[\u200b-\u200d\ufeff]/g, '')
      .replace(/\s+/g, ' ');
  }

  function cleanMarkdown(value) {
    return String(value)
      .replace(/\r\n/g, '\n')
      .replace(/[ \t]+\n/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .replace(/^\s+|\s+$/g, '');
  }

  function cleanPlainText(value) {
    return String(value)
      .replace(/\r\n/g, '\n')
      .replace(/\u00a0/g, ' ')
      .replace(/[\u200b-\u200d\ufeff]/g, '')
      .replace(/[ \t]+\n/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .replace(/^\s+|\s+$/g, '');
  }

  function limitText(value, maxChars) {
    const text = String(value || '').trim();
    if (text.length <= maxChars) {
      return { text, truncated: false };
    }

    let cut = text.slice(0, maxChars);
    const breakAt = Math.max(
      cut.lastIndexOf('\n\n'),
      cut.lastIndexOf('\n'),
      cut.lastIndexOf('。'),
      cut.lastIndexOf('. ')
    );
    if (breakAt > maxChars * 0.6) cut = cut.slice(0, breakAt + 1);
    cut = cut.trim();

    return {
      text: `${cut}\n\n【内容已截断，原文约 ${text.length.toLocaleString()} 字】`,
      truncated: true
    };
  }

  function clamp(value, min, max) {
    return Math.min(max, Math.max(min, Math.round(value)));
  }
})();


