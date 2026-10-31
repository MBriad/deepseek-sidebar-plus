/* DeepSeek Sidebar+ — local/web PDF reader
 *
 * Edge's built-in PDF viewer on a file:// tab uses an opaque origin, so its
 * getSelectedText replies are dropped. This page loads the same PDF as a blob
 * with chrome-extension:// origin, embeds Edge's native viewer, and reads the
 * selection from the extension page itself. It then talks to the background
 * exactly like page-tools.js, so selection auto-fill and clear-on-deselect
 * work for local PDFs too.
 */
(() => {
  const params = new URLSearchParams(location.search);
  const fileUrl = params.get('file') || '';
  const fileName = params.get('name') || deriveName(fileUrl);
  const initialPage = Math.max(1, Number(params.get('page')) || 1);
  // 显式给了 page 就听它的;没给才回落到"上次读到第几页"。
  const hasExplicitPage = params.has('page');
  const POSITIONS_KEY = 'pdfReadingPositions';
  // 原来的硬上限是 200MB,扫描版教材/手册经常超过这个数,结果是"文件能打开却先被我们拒掉"。
  // 但也不能放到 2GB:整份文件要先进内存再交给 pdf.js,放到 2GB 等于允许一个标签页自杀。
  // 512MB 覆盖绝大多数教材/手册,同时给内存留了余地。
  const MAX_PDF_BYTES = 512 * 1024 * 1024;
  const SLOW_NOTICE_BYTES = 80 * 1024 * 1024;
  const FETCH_TIMEOUT_MS = 5 * 60 * 1000;

  const viewer = document.getElementById('viewer');
  const pdfJsFrame = document.getElementById('pdfjs-frame');
  const overlay = document.getElementById('overlay');
  const overlayText = document.getElementById('overlay-text');
  const status = document.getElementById('status');
  const toast = document.getElementById('toast');
  const outlineButton = document.getElementById('btn-outline');
  const versionLabel = document.getElementById('reader-version');

  let embed = null;
  let objectUrl = '';
  let lastText = '';
  let lastSelectionId = '';
  let lastSelectionAt = 0;
  let selectionSeq = 0;
  let selectionClearTimer = null;
  let toastTimer = null;
  let typeRelay = null;
  let typeRelayActive = false;
  let typeRelayComposing = false;
  let typeRelayShortcut = 'Ctrl+Z';
  let lastPointer = null;
  let pdfSelectionRect = null;
  let pdfPollTimer = null;
  let pdfTabId = 0;

  document.title = `${fileName} - DeepSeek PDF`;
  document.getElementById('file-name').textContent = fileName;
  if (versionLabel) versionLabel.textContent = `v${chrome.runtime.getManifest().version}`;

  document.getElementById('btn-open-side').addEventListener('click', openSidePanel);
  document.getElementById('btn-reload').addEventListener('click', () => location.reload());
  outlineButton.addEventListener('click', () => {
    try {
      pdfJsFrame.contentWindow?.postMessage({ source: 'ds-pdf-host', type: 'toggle-outline' }, '*');
    } catch {
      // The PDF.js frame may not be ready.
    }
  });

  window.addEventListener('message', onPdfMessage);
  window.addEventListener('message', onPdfJsMessage);
  window.addEventListener('pagehide', () => {
    clearInterval(pdfPollTimer);
    if (objectUrl) URL.revokeObjectURL(objectUrl);
  });

  chrome.tabs.getCurrent((tab) => {
    pdfTabId = tab?.id || 0;
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;

    const start = changes.dsPdfRelayStart?.newValue;
    if (start && (!start.tabId || Number(start.tabId) === pdfTabId)) {
      startTypeRelay(String(start.shortcut || 'Ctrl+Z'));
    }

    const stop = changes.dsPdfRelayStop?.newValue;
    if (stop && (!stop.tabId || Number(stop.tabId) === pdfTabId)) {
      stopTypeRelay(Boolean(stop.cancel));
    }
  });

  document.addEventListener('pointerdown', (event) => {
    lastPointer = { x: Number(event.clientX) || 0, y: Number(event.clientY) || 0 };
  }, true);
  document.addEventListener('pointerup', (event) => {
    lastPointer = { x: Number(event.clientX) || 0, y: Number(event.clientY) || 0 };
    if (typeRelayActive) positionTypeRelay();
  }, true);
  window.addEventListener('resize', () => {
    if (typeRelayActive) positionTypeRelay();
  });

  document.addEventListener('keydown', (event) => {
    if (event.target === typeRelay) return;
    handlePdfRelayKey(event);
  }, true);

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type !== 'DS_START_TYPE_RELAY' && message?.type !== 'DS_STOP_TYPE_RELAY') return;

    const handle = () => {
      if (message.type === 'DS_START_TYPE_RELAY') {
        startTypeRelay(String(message.shortcut || 'Ctrl+Z'));
        sendResponse({ ok: typeRelayActive });
      } else {
        stopTypeRelay(Boolean(message.cancel));
        sendResponse({ ok: true });
      }
    };

    const target = Number(message.targetTabId || 0);
    if (!target) {
      handle();
      return;
    }
    chrome.tabs.getCurrent((tab) => {
      if (tab?.id && tab.id !== target) {
        sendResponse({ ok: false });
        return;
      }
      handle();
    });
    return true;
  });

  loadPdf();

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

  function ensureTypeRelay() {
    if (typeRelay) return typeRelay;
    typeRelay = document.createElement('input');
    typeRelay.type = 'text';
    typeRelay.id = 'ds-type-relay';
    typeRelay.setAttribute('aria-label', '直接输入到侧边栏');
    typeRelay.autocomplete = 'off';
    typeRelay.spellcheck = false;
    typeRelay.placeholder = '直接输入… Ctrl+Z 撤回';
    typeRelay.style.cssText = [
      'position:fixed',
      'left:50%',
      'bottom:22px',
      'transform:translateX(-50%)',
      'width:min(340px,calc(100vw - 32px))',
      'height:38px',
      'padding:0 12px',
      'border:1px solid #4d6bfe',
      'border-radius:10px',
      'background:#fff',
      'color:#1b1f2a',
      'box-shadow:0 10px 30px rgba(15,23,42,.22)',
      'z-index:2147483646',
      'font:13px/1.4 -apple-system,BlinkMacSystemFont,"Segoe UI","Microsoft YaHei",sans-serif',
      'outline:none',
      'caret-color:#1b1f2a',
      'display:none'
    ].join(';');
    document.documentElement.appendChild(typeRelay);

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
      if (event.key === 'Backspace' || event.key === 'Delete') {
        event.preventDefault();
        event.stopPropagation();
        deletePdfRelayCharacter(event.key === 'Delete');
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
        if (typeRelayActive && document.activeElement !== typeRelay) stopTypeRelay(false);
      }, 0);
    });
    return typeRelay;
  }

  function deletePdfRelayCharacter(forward = false) {
    if (!typeRelay) return;
    const value = typeRelay.value;
    const start = Number.isInteger(typeRelay.selectionStart) ? typeRelay.selectionStart : value.length;
    const end = Number.isInteger(typeRelay.selectionEnd) ? typeRelay.selectionEnd : start;
    let next;
    let caret;
    if (start !== end) {
      next = value.slice(0, start) + value.slice(end);
      caret = start;
    } else if (forward) {
      if (start >= value.length) return;
      next = value.slice(0, start) + value.slice(start + 1);
      caret = start;
    } else {
      if (start <= 0) return;
      next = value.slice(0, start - 1) + value.slice(start);
      caret = start - 1;
    }
    typeRelay.value = next;
    try {
      typeRelay.setSelectionRange(caret, caret);
    } catch {
      // Ignore.
    }
    relaySend('DS_TYPE_RELAY_TEXT', { text: next });
  }

  function positionTypeRelay() {
    if (!typeRelay) return;
    const width = Math.min(340, Math.max(220, window.innerWidth - 32));
    typeRelay.style.width = `${width}px`;
    let left = (window.innerWidth - width) / 2;
    let top = window.innerHeight - 60;
    if (pdfSelectionRect) {
      left = Math.min(Math.max(8, pdfSelectionRect.left), window.innerWidth - width - 8);
      top = pdfSelectionRect.bottom + 8;
      if (top + 42 > window.innerHeight - 8) top = Math.max(8, pdfSelectionRect.top - 52);
    } else if (lastPointer) {
      left = Math.min(Math.max(8, lastPointer.x - 24), window.innerWidth - width - 8);
      top = lastPointer.y + 16;
      if (top + 42 > window.innerHeight - 8) top = Math.max(8, lastPointer.y - 52);
    }
    typeRelay.style.left = `${left}px`;
    typeRelay.style.top = `${top}px`;
    typeRelay.style.bottom = 'auto';
    typeRelay.style.transform = 'none';
  }

  function startTypeRelay(shortcut) {
    if (!lastSelectionId) return;
    typeRelayShortcut = shortcut || 'Ctrl+Z';
    let pdfScrollTop = 0;
    try {
      pdfScrollTop = pdfJsFrame.contentWindow?.document
        ?.getElementById('pdfjs-container')?.scrollTop || 0;
    } catch {
      // PDF.js may still be loading.
    }
    const relay = ensureTypeRelay();
    relay.value = '';
    relay.style.display = 'block';
    positionTypeRelay();
    typeRelayActive = true;
    typeRelayComposing = false;
    try {
      relay.focus({ preventScroll: true });
    } catch {
      // Ignore.
    }
    setTimeout(() => {
      if (typeRelayActive && document.activeElement !== relay) {
        try {
          relay.focus({ preventScroll: true });
        } catch {
          // Ignore.
        }
      }
    }, 60);
    try {
      const frameWindow = pdfJsFrame.contentWindow;
      // Keep the PDF.js native selection visible; it is the accurate highlight.
      const frameContainer = frameWindow?.document?.getElementById('pdfjs-container');
      if (frameContainer) frameContainer.scrollTop = pdfScrollTop;
    } catch {
      // The PDF.js frame may still be navigating.
    }
    showToast(`可直接输入 · ${typeRelayShortcut} 撤回`);
  }

  function handlePdfRelayKey(event) {
    if (!typeRelayActive) return false;
    if (event.isComposing || event.keyCode === 229) return false;
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
      stopTypeRelay(false, true);
      return true;
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
      stopTypeRelay(true);
      return true;
    }
    if (event.key === 'Backspace' || event.key === 'Delete') {
      event.preventDefault();
      event.stopPropagation();
      deletePdfRelayCharacter(event.key === 'Delete');
      return true;
    }
    let character = event.key.length === 1 ? event.key : '';
    if (!character && event.code === 'Space') character = ' ';
    if (!character && /^Key[A-Z]$/.test(event.code || '')) character = event.code.slice(3).toLowerCase();
    if (!character && /^Digit[0-9]$/.test(event.code || '')) character = event.code.slice(5);
    if (character && !event.ctrlKey && !event.metaKey && !event.altKey) {
      event.preventDefault();
      event.stopPropagation();
      if (typeRelay) {
        typeRelay.value += character;
        relaySend('DS_TYPE_RELAY_TEXT', { text: typeRelay.value });
      }
      return true;
    }
    return false;
  }

  function stopTypeRelay(cancel, send = false) {
    if (!typeRelayActive) return;
    typeRelayActive = false;
    typeRelayComposing = false;
    lastSelectionId = '';
    try {
      typeRelay?.blur();
      if (typeRelay) {
        typeRelay.value = '';
        typeRelay.style.display = 'none';
      }
    } catch {
      // Ignore.
    }
    try {
      pdfJsFrame.contentWindow?.getSelection()?.removeAllRanges();
      pdfJsFrame.contentWindow?.postMessage({ source: 'ds-pdf-host', type: 'clear-highlight' }, '*');
    } catch {
      // The frame may be navigating.
    }
    relaySend(cancel ? 'DS_TYPE_RELAY_CANCEL' : 'DS_TYPE_RELAY_END', send ? { send: true } : {});
    if (cancel) showToast('已撤回自动填入');
  }

  function startPdfJs(blobUrl, startPage, docKey) {
    pdfJsFrame.hidden = false;
    outlineButton.hidden = false;
    pdfJsFrame.src = `${chrome.runtime.getURL('src/pdfjs-viewer.html')}?file=${encodeURIComponent(blobUrl)}`
      + `&page=${startPage}`
      + `&doc=${encodeURIComponent(docKey)}`;
    overlay.classList.add('hidden');
    status.textContent = '选中文字会自动填入';

    // Do not poll the selection while the user is still dragging. Polling saw
    // partial selections, filled the sidebar and cleared the PDF.js selection
    // mid-drag, which broke multi-line highlighting. The PDF.js frame reports
    // the final text and rect on pointerup instead.
    pdfJsFrame.addEventListener('load', () => {
      try {
        pdfJsFrame.contentWindow.addEventListener('keydown', handlePdfRelayKey, true);
      } catch {
        // The frame may not be ready yet.
      }
    }, { once: true });
  }

  // FNV-1a:只为把地址折成一个短键,不做安全用途。
  function hashDocKey(input) {
    let hash = 0x811c9dc5;
    for (let index = 0; index < input.length; index += 1) {
      hash ^= input.charCodeAt(index);
      hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return hash.toString(16).padStart(8, '0');
  }

  async function readSavedPage(docKey) {
    try {
      const stored = await chrome.storage.local.get(POSITIONS_KEY);
      const page = Number(stored?.[POSITIONS_KEY]?.[docKey]?.page);
      return Number.isFinite(page) && page > 0 ? page : 0;
    } catch {
      return 0;
    }
  }

  async function loadPdf() {
    if (!fileUrl) {
      showError('缺少 PDF 地址。');
      return;
    }

    try {
      const response = await fetchWithTimeout(fileUrl, FETCH_TIMEOUT_MS);
      if (!response.ok) throw new Error(`无法下载 PDF（HTTP ${response.status}）。`);

      const length = Number(response.headers.get('content-length') || 0);
      if (length > MAX_PDF_BYTES) throw new Error(`PDF 超过 ${formatSize(MAX_PDF_BYTES)},阅读器可能因此无响应。`);
      if (length > SLOW_NOTICE_BYTES) setOverlayText(`正在读取 PDF（${formatSize(length)}）…`);

      const blob = await response.blob();
      if (!blob.size) throw new Error('PDF 文件为空。');
      if (blob.size > MAX_PDF_BYTES) throw new Error(`PDF 超过 ${formatSize(MAX_PDF_BYTES)},阅读器可能因此无响应。`);
      // 有些服务器不给 content-length(分块传输),这时按下载完的真实体积再提示一次。
      if (blob.size > SLOW_NOTICE_BYTES) setOverlayText(`正在解析 PDF（${formatSize(blob.size)}）…`);

      const head = new TextDecoder().decode(await blob.slice(0, 1024).arrayBuffer());
      if (!head.includes('%PDF')) {
        throw new Error('返回的内容不是 PDF；如果这是本地文件，请在扩展详情里允许访问文件网址。');
      }

      objectUrl = URL.createObjectURL(blob);
      // 文档身份:原始地址 + 字节数,只存哈希——不把用户的本机路径原样写进 storage。
      // blob: URL 每次加载都不同,不能拿它当 key。
      const docKey = `${hashDocKey(fileUrl)}-${blob.size}`;
      const savedPage = hasExplicitPage ? 0 : await readSavedPage(docKey);
      const startPage = savedPage || initialPage;

      const stored = await chrome.storage.local.get('settings').catch(() => ({}));
      if (stored.settings?.pdfJsFollow !== false) {
        startPdfJs(objectUrl, startPage, docKey);
        return;
      }

      embed = document.createElement('embed');
      embed.type = 'application/pdf';
      // 内置 <embed> 阅读器的滚动位置读不到、也写不回去:这条路径不承诺记忆,
      // 否则用户会以为"换了模式就读不到上次的位置了"。
      embed.src = `${objectUrl}#page=${initialPage}`;
      embed.title = fileName;
      viewer.appendChild(embed);

      overlay.classList.add('hidden');
      status.textContent = '选中文字会自动填入';

      setTimeout(askSelected, 800);
      setInterval(() => {
        if (document.visibilityState === 'visible') askSelected();
      }, 700);
    } catch (error) {
      showError(error.message || 'PDF 加载失败。');
    }
  }

  function fetchWithTimeout(url, timeout) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    return fetch(url, {
      credentials: 'include',
      redirect: 'follow',
      cache: 'no-cache',
      signal: controller.signal
    }).catch((error) => {
      if (error.name === 'AbortError') throw new Error('读取 PDF 超时。');
      throw error;
    }).finally(() => clearTimeout(timer));
  }

  function askSelected() {
    if (!embed) return;
    try {
      embed.postMessage({ type: 'getSelectedText' });
    } catch {
      // The viewer may still be initializing; the next poll retries.
    }
  }

  function onPdfMessage(event) {
    const data = event.data;
    if (!data || data.type !== 'getSelectedTextReply') return;
    handleSelection(String(data.selectedText || ''));
  }

  function onPdfJsMessage(event) {
    if (event.source !== pdfJsFrame.contentWindow) return;
    const data = event.data;
    if (!data || data.source !== 'ds-pdf-viewer') return;
    if (data.type === 'selection-clear') {
      pdfSelectionRect = null;
      handleSelection('');
      return;
    }
    if (data.type !== 'selection') return;

    const text = String(data.text || '').replace(/\u00a0/g, ' ').trim();
    if (!text) return;

    const rect = data.rect;
    if (rect) {
      const frameRect = pdfJsFrame.getBoundingClientRect();
      pdfSelectionRect = {
        left: frameRect.left + rect.left,
        top: frameRect.top + rect.top,
        right: frameRect.left + rect.right,
        bottom: frameRect.top + rect.bottom,
        width: rect.width,
        height: rect.height
      };
      if (typeRelayActive) positionTypeRelay();
    }
    handleSelection(text);
  }

  function handleSelection(raw) {
    const value = raw.replace(/\u00a0/g, ' ').trim();

    if (!value) {
      lastText = '';
      if (typeRelayActive) return;
      if (!lastSelectionId) return;

      clearTimeout(selectionClearTimer);
      selectionClearTimer = setTimeout(() => {
        if (lastText || typeRelayActive) return;
        // A programmatic selection clear happens immediately after reporting;
        // do not turn that into a page-selection-clear while the sidebar is
        // still filling the input and starting the relay.
        if (Date.now() - lastSelectionAt < 2500) return;
        if (!document.hasFocus()) return;

        const selectionId = lastSelectionId;
        lastSelectionId = '';
        clearTimeout(selectionClearTimer);
        chrome.runtime.sendMessage({
          type: 'DS_PAGE_SELECTION_CLEARED',
          selectionId,
          url: fileUrl
        }, () => {
          void chrome.runtime.lastError;
        });
      }, 420);
      return;
    }

    if (value === lastText) return;

    lastText = value;
    lastSelectionAt = Date.now();
    lastSelectionId = `${Date.now()}-${++selectionSeq}-${Math.random().toString(36).slice(2, 6)}`;
    clearTimeout(selectionClearTimer);

    chrome.runtime.sendMessage({
      type: 'DS_PAGE_SELECTION',
      text: value.slice(0, 20000),
      selectionId: lastSelectionId,
      title: fileName,
      url: fileUrl,
      ts: Date.now()
    }, (response) => {
      if (chrome.runtime.lastError) return;
      if (!response?.stored) return;
      showToast(response.delivered
        ? '已发送到 DeepSeek 侧边栏'
        : '已暂存，打开 DeepSeek 侧边栏后填入');
    });
  }

  function openSidePanel() {
    chrome.tabs.getCurrent((tab) => {
      if (!tab?.windowId) {
        showToast('无法获取当前窗口');
        return;
      }
      chrome.sidePanel.open({ windowId: tab.windowId }).catch((error) => {
        showToast(`打开侧边栏失败：${error.message}`, 4000);
      });
    });
  }

  function setOverlayText(text) {
    if (overlayText) overlayText.textContent = text;
  }

  function formatSize(bytes) {
    if (bytes >= 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GB`;
    return `${Math.round(bytes / 1024 / 1024)} MB`;
  }

  function showError(message) {
    status.textContent = '加载失败';
    overlay.classList.remove('hidden');
    const spinner = overlay.querySelector('.spinner');
    if (spinner) spinner.style.display = 'none';
    overlayText.textContent = message;
  }

  function showToast(message, timeout = 2200) {
    toast.textContent = message;
    toast.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.classList.remove('show'), timeout);
  }

  function deriveName(url) {
    try {
      const parsed = new URL(url);
      const name = decodeURIComponent(parsed.pathname.split('/').filter(Boolean).pop() || '');
      if (name) return name;
    } catch {
      // Ignore.
    }
    return 'PDF 文档';
  }
})();
