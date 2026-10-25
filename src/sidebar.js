/* DeepSeek Sidebar+ — side panel controller */

'use strict';

const CHAT_PROVIDERS = {
  deepseek: {
    id: 'deepseek',
    name: 'DeepSeek',
    url: 'https://chat.deepseek.com/',
    origin: 'https://chat.deepseek.com'
  },
  chatgpt: {
    id: 'chatgpt',
    name: 'ChatGPT',
    url: 'https://chatgpt.com/',
    origin: 'https://chatgpt.com'
  }
};
const PROVIDER_KEY = 'chatProvider';
let chatProvider = 'deepseek';
let CHAT_URL = CHAT_PROVIDERS.deepseek.url;
let CHAT_ORIGIN = CHAT_PROVIDERS.deepseek.origin;
const MAX_PDF_BYTES = 50 * 1024 * 1024;
const PAGE_EXTRACT_MAX = 50000;
const PROMPT_STORAGE_KEY = 'promptLibrary';
const PAGE_TAG_KEY = 'pageTagLibrary';
const PAGE_TAG_REGISTRY_KEY = 'pageTagRegistry';
const PAGE_TAG_AUTO_KEY = 'pageTagAutoClassify';

const DEFAULT_SETTINGS = {
  autoFillSelection: true,
  selectionMode: 'smart',
  attachPageInfo: false,
  maxPageChars: 12000,
  extractMode: 'readable',
  showPageToast: true,
  autoOpenLocalPdfReader: true
};

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));

const frame = $('#ds-frame');

let settings = { ...DEFAULT_SETTINGS };
let bridgeReady = false;
let frameLoaded = false;
let frameLoadWatchdog = null;
let requestSeq = 0;
const pendingRequests = new Map();
let pingToken = 0;
let connectHintTimer = null;
let bannerTimer = null;
let bannerKind = '';
let toastTimer = null;
let pageData = null;
let pendingSelection = null;
let activeSelectionId = '';
let lastClearedSelectionId = '';
let prompts = [];
let taggedPages = [];
let pageTags = [];
const activePageTags = new Set();
let pageTagTab = null;
let pageTagCurrentEntry = null;
let pageTagBusy = false;
let pageTagAutoClassify = true;
let pageTagRefreshTimer = 0;
const pageSemanticCache = new Map();
let promptFormMode = '';
let promptEditId = '';
let promptSearchTerm = '';
let reading = false;
let fileAttaching = false;
let mentionReading = false;
let lastPdfAttachUrl = '';
let lastPdfAttachAt = 0;
let fillChain = Promise.resolve();
let pendingRequested = false;
const sheetTimers = new Map();

/* ------------------------------------------------------------------ */
/* Boot                                                               */
/* ------------------------------------------------------------------ */

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init, { once: true });
} else {
  init();
}

async function init() {
  bindFrame();
  bindUI();

  await loadChatProvider();
  await loadSettings();
  applySettingsToUI();
  updateAutofillButton();

  setConnection('connecting');
  showFrameLoading(`正在加载 ${currentProvider().name}…`);

  try {
    frame.src = CHAT_URL;
    startFrameWatchdog();
  } catch (error) {
    showBanner(`无法加载 ${currentProvider().name}：${error.message}`, '重试', reloadFrame, { type: 'error' });
  }

  // Pending selections/pages are fetched once the DeepSeek frame has actually
  // navigated; posting into an un-navigated iframe would target the wrong origin.
  setTimeout(() => {
    if (pendingRequested) return;
    pendingRequested = true;
    requestPending();
  }, 8000);

  setInterval(heartbeat, 15000);

  refreshLocalPdfHint();
  chrome.tabs.onActivated.addListener(() => refreshLocalPdfHint());
  chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    if (tab.active && (changeInfo.url || changeInfo.status === 'complete')) {
      refreshLocalPdfHint(tab);
    }
  });

  console.info('[DS+] side panel ready');
}

/* ------------------------------------------------------------------ */
/* Chat providers                                                     */
/* ------------------------------------------------------------------ */

function currentProvider() {
  return CHAT_PROVIDERS[chatProvider] || CHAT_PROVIDERS.deepseek;
}

function providerName() {
  return currentProvider().name;
}

async function loadChatProvider() {
  try {
    const stored = await chrome.storage.local.get(PROVIDER_KEY);
    const id = CHAT_PROVIDERS[stored?.[PROVIDER_KEY]] ? stored[PROVIDER_KEY] : 'deepseek';
    applyChatProvider(id, { persist: false, reload: false });
  } catch {
    applyChatProvider('deepseek', { persist: false, reload: false });
  }
}

function applyChatProvider(id, { persist = true, reload = true } = {}) {
  const provider = CHAT_PROVIDERS[id] || CHAT_PROVIDERS.deepseek;
  const changed = chatProvider !== provider.id;
  chatProvider = provider.id;
  CHAT_URL = provider.url;
  CHAT_ORIGIN = provider.origin;

  $$('.provider-tab').forEach((button) => {
    const active = button.getAttribute('data-provider') === provider.id;
    button.classList.toggle('active', active);
    button.setAttribute('aria-selected', String(active));
  });
  frame.title = provider.name;
  const openTab = $('#btn-open-tab');
  if (openTab) openTab.textContent = `在标签页打开 ${provider.name}`;

  if (persist) {
    chrome.storage.local.set({ [PROVIDER_KEY]: provider.id }).catch(() => {});
  }
  if (!reload || !changed) return;

  bridgeReady = false;
  frameLoaded = false;
  pingToken += 1;
  clearTimeout(connectHintTimer);
  clearTimeout(frameLoadWatchdog);
  setConnection('connecting');
  showFrameLoading(`正在加载 ${provider.name}…`);
  try {
    frame.src = `${provider.url}?dsplus=${Date.now()}`;
    startFrameWatchdog();
  } catch (error) {
    showBanner(`无法加载 ${provider.name}：${error.message}`, '重试', reloadFrame, { type: 'error' });
  }
}

/* ------------------------------------------------------------------ */
/* Frame bridge                                                       */
/* ------------------------------------------------------------------ */

function bindFrame() {
  frame.addEventListener('load', onFrameLoad);
  window.addEventListener('message', onFrameMessage);
}

function onFrameLoad() {
  if (!frame.src || !frame.src.startsWith(CHAT_URL)) return;

  clearTimeout(frameLoadWatchdog);
  frameLoaded = true;
  hideFrameLoading();
  setConnection(bridgeReady ? 'ready' : 'connecting');

  if (!pendingRequested) {
    pendingRequested = true;
    requestPending();
  }

  clearTimeout(connectHintTimer);
  connectHintTimer = setTimeout(() => {
    if (bridgeReady) return;
    showBanner(
      `${providerName()} 页面已加载，但还没有连接到输入框。请确认已经登录；如果页面要求验证，请先在浏览器标签页打开 ${CHAT_URL} 完成登录。`,
      '重新加载',
      reloadFrame,
      { type: 'error', kind: 'connection' }
    );
  }, 20000);

  pingBurst(8);
}

function onFrameMessage(event) {
  if (event.source !== frame.contentWindow) return;
  if (event.origin !== CHAT_ORIGIN) return;

  const data = event.data;
  if (!data || typeof data !== 'object' || data.source !== 'ds-chat') return;

  if (data.type === 'GET_TABS_REQUEST') {
    respondTabsRequest(event.source, data.requestId);
    return;
  }

  if (data.type === 'READ_TAB_REQUEST') {
    handleMentionTab(data.tabId);
    return;
  }

  if (data.type === 'READY') {
    markBridgeReady();

    if (data.requestId && pendingRequests.has(data.requestId)) {
      const resolve = pendingRequests.get(data.requestId);
      pendingRequests.delete(data.requestId);
      resolve({ ...data, ok: true });
    }
    return;
  }

  if (
    data.type === 'FILL_RESULT' ||
    data.type === 'STATE_RESULT' ||
    data.type === 'ATTACH_RESULT' ||
    data.type === 'CLEAR_SELECTION_RESULT' ||
    data.type === 'QUOTE_RESULT' ||
    data.type === 'INPUT_RESULT'
  ) {
    const resolve = pendingRequests.get(data.requestId);
    if (resolve) {
      pendingRequests.delete(data.requestId);
      resolve(data);
    }
    if (data.type === 'FILL_RESULT') {
      console.debug('[DS+] fill result:', data.ok, data.code || '');
    }
    if (data.type === 'ATTACH_RESULT') {
      console.debug('[DS+] attach result:', data.ok, data.method || data.error || '');
    }
    if (data.type === 'CLEAR_SELECTION_RESULT') {
      console.debug('[DS+] clear selection:', data.cleared, data.reason || data.error || '');
    }
    if (data.type === 'QUOTE_RESULT') {
      console.debug('[DS+] quote result:', data.ok, data.error || '');
    }
    if (data.type === 'INPUT_RESULT') {
      console.debug('[DS+] input result:', data.ok, data.error || '');
    }
  }
}

function sendToFrame(type, payload = {}, timeout = 8000, transfer = []) {
  const requestId = ++requestSeq;

  return new Promise((resolve) => {
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      pendingRequests.delete(requestId);
      resolve({ ok: false, code: 'timeout', error: `连接 ${providerName()} 超时` });
    }, timeout);

    pendingRequests.set(requestId, (response) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(response);
    });

    try {
      const target = frame.contentWindow;
      if (!target) throw new Error(`侧边栏尚未加载 ${providerName()} 页面`);

      // Before navigation the iframe is still same-origin (about:blank / the
      // extension page), so posting with the chat origin throws.
      // Skip those attempts instead of generating a console warning.
      try {
        const href = target.location.href;
        if (!href.startsWith(CHAT_URL)) {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          pendingRequests.delete(requestId);
          resolve({ ok: false, code: 'not-ready', error: `${providerName()} 页面尚未加载` });
          return;
        }
      } catch {
        // Cross-origin: the frame has navigated to the chat page.
      }

      target.postMessage({ source: 'ds-sidebar', type, requestId, ...payload }, CHAT_ORIGIN, transfer);
    } catch (error) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      pendingRequests.delete(requestId);
      resolve({ ok: false, code: 'post-failed', error: error.message });
    }
  });
}

function markBridgeReady() {
  const wasReady = bridgeReady;
  bridgeReady = true;
  setConnection('ready');
  hideFrameLoading();
  clearTimeout(connectHintTimer);

  if (bannerKind === 'connection') hideBanner();

  if (!wasReady) console.debug('[DS+] bridge ready:', frame.src);
}

async function pingBurst(attempts = 6) {
  const token = ++pingToken;

  for (let index = 0; index < attempts; index += 1) {
    if (token !== pingToken || bridgeReady) return;

    const response = await sendToFrame('DS_PING', {}, 2200);
    if (token !== pingToken) return;

    if (response?.ok) {
      markBridgeReady();
      if (response.hasInput && bannerKind === 'connection') hideBanner();
      return;
    }

    await sleep(400);
  }

  if (token === pingToken && !bridgeReady) setConnection('offline');
}

async function waitForBridge(timeout = 9000) {
  if (bridgeReady) return true;

  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (bridgeReady) return true;

    const response = await sendToFrame('DS_PING', {}, 2200);
    if (response?.ok) {
      markBridgeReady();
      return true;
    }
    if (bridgeReady) return true;

    await sleep(250);
  }

  return false;
}

async function heartbeat() {
  if (!frameLoaded || document.visibilityState === 'hidden') return;

  if (!bridgeReady) {
    pingBurst(2);
    return;
  }

  const response = await sendToFrame('DS_PING', {}, 3000);
  if (response?.ok) {
    if (response.hasInput && bannerKind === 'connection') hideBanner();
    return;
  }

  bridgeReady = false;
  setConnection('offline');
  pingBurst(3);
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && frameLoaded && !bridgeReady) {
    pingBurst(3);
  }
});

/* ------------------------------------------------------------------ */
/* Fill                                                               */
/* ------------------------------------------------------------------ */

function focusChatFrame() {
  const apply = () => {
    try { window.focus(); } catch { /* Ignore. */ }
    try { frame.focus(); } catch { /* Ignore. */ }
    try {
      frame.contentWindow?.postMessage({
        source: 'ds-sidebar',
        type: 'DS_FOCUS_INPUT'
      }, CHAT_ORIGIN);
    } catch {
      // The frame may still be navigating.
    }
  };

  apply();
  setTimeout(apply, 80);
  setTimeout(apply, 260);
}

function fillChat(text, mode = 'smart', options = {}) {
  const task = fillChain.then(
    () => fillChatInternal(text, mode, options),
    () => fillChatInternal(text, mode, options)
  );
  fillChain = task.catch(() => {});
  return task;
}

async function fillChatInternal(text, mode = 'smart', options = {}) {
  const value = String(text || '').trim();
  const selectionId = String(options.selectionId || '');
  if (!value) {
    showToast('没有可填入的文字', 'error');
    return false;
  }

  if (!bridgeReady) {
    const ready = await waitForBridge(9000);
    if (!ready) {
      setConnection('offline');
      showBanner(`还没有连接到 ${providerName()}。请检查侧边栏里的页面是否已经登录并加载完成。`, '重新加载', reloadFrame, { type: 'error', kind: 'connection' });
      return false;
    }
  }

  const response = await sendToFrame('DS_FILL_INPUT', { text: value, mode, selectionId }, 22000);

  if (response?.ok) {
    setConnection('ready');
    activeSelectionId = selectionId;
    hideBanner();
    focusChatFrame();
    return true;
  }

  if (response?.code === 'no-input') {
    setConnection('offline');
    showBanner(response.error || `没有找到 ${providerName()} 输入框。请确认已经登录，或点击重新加载。`, '重新加载', reloadFrame, { type: 'error', kind: 'connection' });
    return false;
  }

  if (response?.code === 'timeout') {
    bridgeReady = false;
    setConnection('offline');
    showBanner(`连接 ${providerName()} 超时，请重新加载侧边栏。`, '重新加载', reloadFrame, { type: 'error', kind: 'connection' });
    return false;
  }

  showBanner(response?.error || '填入失败，请重试。', '重试', () => fillChat(value, mode), { type: 'error' });
  return false;
}

function buildSelectionText(selection) {
  let text = String(selection?.text || '').trim();
  if (!text) return '';

  if (settings.attachPageInfo) {
    const source = [];
    if (selection.title) source.push(`《${selection.title}》`);
    if (selection.url) source.push(selection.url);
    if (source.length) text += `\n\n—— 来自 ${source.join(' ')}`;
  }

  return text;
}

async function fillSelection(selection, { auto = false } = {}) {
  if (!selection?.text?.trim()) return false;

  const text = buildSelectionText(selection);
  const ok = await fillChat(text, settings.selectionMode, {
    selectionId: selection.selectionId || ''
  });

  if (ok) {
    let clearedAfterFill = false;
    if (selection.selectionId && selection.selectionId === lastClearedSelectionId) {
      clearedAfterFill = true;
      await handleSelectionCleared(selection.selectionId);
    }

    pendingSelection = null;
    await clearPendingSelection();
    hideBanner();
    if (!clearedAfterFill) {
      showToast(auto ? `已填入选中文字 · ${formatChars(text.length)}` : '已填入选中文字');
    }
  }

  return ok;
}

async function handleIncomingSelection(selection, { auto = true } = {}) {
  if (!selection?.text?.trim()) return;
  pendingSelection = selection;

  if (auto && settings.autoFillSelection) {
    const ok = await fillSelection(selection, { auto: true });
    if (!ok && !isBannerVisible()) showSelectionBanner(selection);
    return;
  }

  showSelectionBanner(selection);
}

function showSelectionBanner(selection) {
  const preview = String(selection.text || '').replace(/\s+/g, ' ').slice(0, 46);
  const suffix = String(selection.text || '').length > 46 ? '…' : '';
  showBanner(`已捕获选中文字：${preview}${suffix}`, '填入', async () => {
    hideBanner();
    await fillSelection(selection, { auto: false });
  }, { kind: 'selection' });
}

async function handleSelectionCleared(selectionId) {
  const id = String(selectionId || '');
  lastClearedSelectionId = id;

  if (activeSelectionId && id && activeSelectionId !== id) {
    // A new selection may still be filling while the previous one is active.
    // Do not ignore a clear for the current pending selection.
    const pendingMatches = pendingSelection?.selectionId && pendingSelection.selectionId === id;
    if (!pendingMatches) return;
  }
  if (pendingSelection?.selectionId && id && pendingSelection.selectionId !== id) return;

  if (activeSelectionId && (!id || activeSelectionId === id)) {
    const clearId = activeSelectionId;
    activeSelectionId = '';
    try {
      await sendToFrame('DS_CLEAR_SELECTION', { selectionId: clearId }, 5000);
    } catch {
      // Ignore; the input will be left as-is if the frame is gone.
    }
  }

  if (!id || !pendingSelection?.selectionId || pendingSelection.selectionId === id) {
    pendingSelection = null;
  }
  if (bannerKind === 'selection') hideBanner();
}

function clearPendingSelection() {
  return new Promise((resolve) => {
    try {
      chrome.storage.session.remove('pendingSelection', () => {
        void chrome.runtime.lastError;
        resolve();
      });
    } catch {
      resolve();
    }
  });
}

async function quoteInChat(text) {
  const value = String(text || '').trim();
  if (!value) return;

  const response = await sendToFrame('DS_QUOTE_TEXT', { text: value }, 6000);
  if (response?.ok) showToast('已引用到输入框');
  else showToast(response?.error || '引用失败', 'error', 4000);
}

async function pasteFromClipboard() {
  try {
    const text = String(await navigator.clipboard.readText() || '').trim();
    if (!text) {
      showToast('剪贴板里没有文字');
      return;
    }

    const ok = await fillChat(text, settings.selectionMode);
    if (ok) showToast('已从剪贴板填入');
  } catch (error) {
    showToast(`读取剪贴板失败：${error.message}`, 'error', 4000);
  }
}

async function openSidebarInTab() {
  try {
    await chrome.tabs.create({ url: chrome.runtime.getURL('src/sidebar.html') });
    closeSheet('#settings-sheet');
  } catch (error) {
    showToast(`打开侧边栏页面失败：${error.message}`, 'error', 4000);
  }
}

async function openChatInTab() {
  try {
    await chrome.tabs.create({ url: CHAT_URL });
    showToast(`已在新标签页打开 ${providerName()}`);
  } catch (error) {
    showToast(`打开失败：${error.message}`, 'error', 4000);
  }
}

function isPdfTabUrl(url) {
  return /^(https?|file):/i.test(url || '') && /\.pdf(?:$|[?#])/i.test(url || '');
}

async function openPdfReader(pdfUrl, title) {
  const readerUrl = chrome.runtime.getURL(
    `src/pdf-reader.html?file=${encodeURIComponent(pdfUrl)}&name=${encodeURIComponent(title || 'PDF 文档')}`
  );
  await chrome.tabs.create({ url: readerUrl });
  hideBanner();
}

async function openExtensionDetails() {
  try {
    await chrome.tabs.create({ url: `edge://extensions/?id=${chrome.runtime.id}` });
  } catch {
    showToast('请手动打开 edge://extensions，找到本扩展 → 详细信息 → 允许访问文件 URL', 'info', 7000);
  }
}

async function isFileSchemeAllowed() {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(Boolean(value));
    };
    try {
      if (!chrome.extension?.isAllowedFileSchemeAccess) {
        finish(true);
        return;
      }
      chrome.extension.isAllowedFileSchemeAccess((allowed) => finish(allowed));
      setTimeout(() => finish(true), 600);
    } catch {
      finish(true);
    }
  });
}

async function openCurrentPdfReader() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (!tab?.url || !isPdfTabUrl(tab.url)) {
      showToast('当前标签页不是 PDF');
      return;
    }
    closeSheet('#settings-sheet');
    await openPdfReader(tab.url, tab.title);
  } catch (error) {
    showToast(`打开增强阅读器失败：${error.message}`, 'error', 4000);
  }
}

async function refreshLocalPdfHint(tab = null) {
  try {
    if (!tab) {
      [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    }

    const isLocalPdf = tab?.url && /^file:/i.test(tab.url) && isPdfTabUrl(tab.url);
    if (isLocalPdf) {
      if (isBannerVisible() && bannerKind !== 'local-pdf') return;
      showBanner(
        '本地 PDF 的自动划词受 Edge 限制。用增强阅读器打开同一份 PDF，就能自动选中/撤回。',
        '打开增强阅读器',
        () => openPdfReader(tab.url, tab.title),
        { kind: 'local-pdf' }
      );
      return;
    }

    if (bannerKind === 'local-pdf') hideBanner();
  } catch {
    // Ignore tab lookup failures.
  }
}

async function grabCurrentSelection() {
  try {
    const response = await sendBackground({ type: 'DS_GET_ACTIVE_SELECTION' });
    if (!response?.ok) {
      showBanner(response?.error || '读取选中文字失败。', '重试', grabCurrentSelection);
      return;
    }
    if (!response.text) {
      showToast('请先在网页中高亮选中文字');
      return;
    }

    closeSheet('#settings-sheet');
    const selection = {
      text: response.text,
      title: response.title || '',
      url: response.url || ''
    };
    await fillSelection(selection, { auto: false });
  } catch (error) {
    showToast(`读取选中文字失败：${error.message}`, 'error', 4000);
  }
}

/* ------------------------------------------------------------------ */
/* Page reading                                                       */
/* ------------------------------------------------------------------ */

async function readPage() {
  return extractAndShow({});
}

async function extractAndShow(extra = {}) {
  if (reading) return null;
  reading = true;
  setReadButtonLoading(true);

  try {
    const response = await sendBackground({
      type: 'DS_EXTRACT_ACTIVE_PAGE',
      ...extra,
      maxChars: PAGE_EXTRACT_MAX,
      mode: settings.extractMode
    });

    if (response?.pdf) {
      return attachPdfToChat(response);
    }

    if (!response?.ok) {
      showBanner(response?.error || '读取网页失败。', '重试', () => extractAndShow(extra));
      return null;
    }

    pageData = response.page;
    hideBanner();
    renderPageSheet(pageData);
    openSheet('#page-sheet');
    return pageData;
  } catch (error) {
    showBanner(`读取网页失败：${error.message}`, '重试', () => extractAndShow(extra));
    return null;
  } finally {
    reading = false;
    setReadButtonLoading(false);
  }
}

async function attachPdfToChat(info) {
  if (fileAttaching) return null;
  if (info?.pdfUrl && info.pdfUrl === lastPdfAttachUrl && Date.now() - lastPdfAttachAt < 10000) {
    return null;
  }
  if (!info?.pdfUrl) {
    showBanner('没有找到这个 PDF 的下载地址。', '重试', () => attachPdfToChat(info), { type: 'error' });
    return null;
  }

  fileAttaching = true;
  const title = info.title || 'PDF 文档';

  try {
    showBanner(`正在获取 PDF：${title}…`, '', null, { kind: 'pdf' });
    const file = await fetchPdfFile(info.pdfUrl);

    if (!bridgeReady) {
      const ready = await waitForBridge(10000);
      if (!ready) throw new Error(`还没有连接到 ${providerName()}，请先登录并等待页面加载完成。`);
    }

    showBanner(`正在把 PDF 添加到 ${providerName()}：${file.name}…`, '', null, { kind: 'pdf' });
    const buffer = await file.arrayBuffer();
    const result = await sendToFrame('DS_ATTACH_FILE', {
      name: file.name,
      mime: 'application/pdf',
      size: file.size,
      buffer
    }, 45000, [buffer]);

    if (!result?.ok) throw new Error(result?.error || `无法把 PDF 添加到 ${providerName()}。`);

    const isLocalFile = /^file:/i.test(info.pdfUrl);
    let readerOpened = false;

    if (isLocalFile && settings.autoOpenLocalPdfReader) {
      try {
        await openPdfReader(info.pdfUrl, title);
        readerOpened = true;
      } catch {
        // Fall back to the banner action below.
      }
    }

    if (isLocalFile) {
      showBanner(
        readerOpened
          ? `PDF 已附加到 ${providerName()}；增强阅读器已打开，选中文字会自动填入。`
          : `PDF 已附加到 ${providerName()}。输入框没有改动；可以打开增强阅读器划词。`,
        readerOpened ? '知道了' : '打开增强阅读器',
        readerOpened ? hideBanner : () => openPdfReader(info.pdfUrl, title),
        { type: 'success' }
      );
    } else {
      showBanner(
        `PDF 已附加到 ${providerName()}。输入框没有改动，请自行输入问题。`,
        '知道了',
        hideBanner,
        { type: 'success' }
      );
    }
    showToast('PDF 已附加');
    lastPdfAttachUrl = info.pdfUrl;
    lastPdfAttachAt = Date.now();
    return { pdf: true, attached: true, name: file.name };
  } catch (error) {
    const isLocalFile = /^file:/i.test(info.pdfUrl || '');
    showBanner(
      `PDF 处理失败：${error.message}`,
      isLocalFile ? '打开扩展详情' : '重试',
      isLocalFile ? openExtensionDetails : () => attachPdfToChat(info),
      { type: 'error' }
    );
    return null;
  } finally {
    fileAttaching = false;
  }
}

async function fetchPdfFile(url) {
  if (!/^(https?|file):/i.test(url)) {
    throw new Error('这个 PDF 地址不支持读取。');
  }

  const isLocalFile = /^file:/i.test(url);
  if (isLocalFile && !(await isFileSchemeAllowed())) {
    throw new Error('本地 PDF 需要允许访问文件 URL。请打开 edge://extensions → 本扩展“详细信息” → 开启“允许访问文件 URL”，然后重试。');
  }

  let response;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 60000);
  try {
    response = await fetch(url, {
      credentials: isLocalFile ? 'omit' : 'include',
      redirect: 'follow',
      cache: 'no-cache',
      signal: controller.signal
    });
  } catch (error) {
    if (isLocalFile && error.name !== 'AbortError') {
      try {
        response = await fetch(url, { cache: 'no-store', signal: controller.signal });
      } catch (retryError) {
        throw new Error(retryError.name === 'AbortError' ? '下载 PDF 超时。' : `无法读取本地 PDF：${retryError.message}`);
      }
    } else {
      throw new Error(error.name === 'AbortError' ? '下载 PDF 超时。' : `无法下载 PDF：${error.message}`);
    }
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok) {
    throw new Error(`无法下载 PDF（HTTP ${response.status}）。`);
  }

  const contentLength = Number(response.headers.get('content-length') || 0);
  if (contentLength && contentLength > MAX_PDF_BYTES) {
    throw new Error(`PDF 超过 ${Math.round(MAX_PDF_BYTES / 1024 / 1024)} MB。`);
  }

  const blob = await response.blob();
  if (!blob.size) throw new Error('PDF 文件为空。');
  if (blob.size > MAX_PDF_BYTES) {
    throw new Error(`PDF 超过 ${Math.round(MAX_PDF_BYTES / 1024 / 1024)} MB。`);
  }

  const head = new TextDecoder().decode(await blob.slice(0, 1024).arrayBuffer());
  if (!head.includes('%PDF')) {
    throw new Error('下载到的内容不是 PDF（可能需要登录，或链接已失效）。');
  }

  let name = 'document.pdf';
  try {
    const parsed = new URL(url);
    const decoded = decodeURIComponent(parsed.pathname.split('/').filter(Boolean).pop() || '');
    if (decoded) name = decoded;
  } catch {
    // Keep the fallback name.
  }
  if (!/\.pdf$/i.test(name)) name = 'document.pdf';

  return new File([blob], name, { type: 'application/pdf' });
}

function renderPageSheet(page) {
  if (!page) return;
  pageData = page;

  $('#page-sheet-title').textContent = page.title || '网页正文';

  const meta = [];
  if (page.siteName) meta.push(page.siteName);
  try {
    const host = new URL(page.url).hostname.replace(/^www\./, '');
    if (host && !meta.includes(host)) meta.push(host);
  } catch {
    // Ignore malformed URLs.
  }
  meta.push(`${Number(page.charCount || 0).toLocaleString()} 字`);
  if (page.mode === 'full') meta.push('整页');
  if (page.mode === 'pdf') meta.push('PDF');
  if (page.truncated) meta.push('已截断');
  if (page.author) meta.push(page.author);
  $('#page-meta').textContent = meta.join(' · ');

  const warning = $('#page-warning');
  if (page.warning) {
    warning.textContent = page.warning;
    warning.classList.remove('hidden');
  } else {
    warning.classList.add('hidden');
  }

  $('#page-preview').textContent = page.text || '';
  $('#page-preview').scrollTop = 0;

  const hasText = Boolean(String(page.text || '').trim());
  for (const selector of ['#btn-attach-page', '#btn-fill-raw', '#btn-copy-page']) {
    $(selector).disabled = !hasText;
  }
}

function truncateText(text, maxChars) {
  const value = String(text || '');
  if (!maxChars || value.length <= maxChars) return value;

  let cut = value.slice(0, maxChars);
  const breakAt = Math.max(
    cut.lastIndexOf('\n\n'),
    cut.lastIndexOf('\n'),
    cut.lastIndexOf('。')
  );
  if (breakAt > maxChars * 0.6) cut = cut.slice(0, breakAt + 1);

  return `${cut.trim()}\n\n【内容已截断，原文约 ${value.length.toLocaleString()} 字】`;
}

function sanitizeFileName(name) {
  return String(name || '')
    .replace(/[\\/:*?"<>|\r\n\t]+/g, '-')
    .replace(/\s+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || '网页内容';
}

function buildPageFile(page) {
  const now = new Date();
  const stamp = [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, '0'),
    String(now.getDate()).padStart(2, '0')
  ].join('') + '-' + [
    String(now.getHours()).padStart(2, '0'),
    String(now.getMinutes()).padStart(2, '0')
  ].join('');

  const name = `网页内容-${sanitizeFileName(page.title || page.siteName)}-${stamp}.txt`;
  const lines = [
    '网页内容资料',
    '====================',
    `标题：${page.title || ''}`,
    `链接：${page.url || ''}`,
    `网站：${page.siteName || ''}`,
    `作者：${page.author || ''}`,
    `发布时间：${page.published || ''}`,
    `读取时间：${now.toLocaleString('zh-CN')}`,
    `字数：${String(page.text || '').length}`,
    ...(page.truncated ? ['注意：网页内容超过 50,000 字，已在提取时截断。'] : []),
    '',
    '====================',
    '',
    page.text,
    ''
  ];

  return new File([lines.join('\n')], name, { type: 'text/plain' });
}

async function fillPageText() {
  if (!pageData?.text) return false;

  const text = truncateText(pageData.text, settings.maxPageChars);
  closeSheet('#page-sheet');
  showToast('正在填入网页正文…', 'info', 1400);

  const ok = await fillChat(text, 'replace');
  if (ok) showToast('已填入网页正文');
  return ok;
}

async function attachPageFile(page) {
  if (fileAttaching) return false;
  fileAttaching = true;

  try {
    if (!bridgeReady) {
      const ready = await waitForBridge(10000);
      if (!ready) throw new Error(`还没有连接到 ${providerName()}，请先登录并等待页面加载完成。`);
    }

    const file = buildPageFile(page);
    closeSheet('#page-sheet');
    showBanner(`正在把网页文档附加到 ${providerName()}：${file.name}…`, '', null, { kind: 'page-file' });

    const buffer = await file.arrayBuffer();
    const result = await sendToFrame('DS_ATTACH_FILE', {
      name: file.name,
      mime: file.type,
      size: file.size,
      buffer
    }, 45000, [buffer]);

    if (!result?.ok) throw new Error(result?.error || `无法把网页文档附加到 ${providerName()}。`);

    showBanner(
      `网页文档《${file.name}》已附加到 ${providerName()}。输入框没有改动，请自行输入问题。`,
      '知道了',
      hideBanner,
      { type: 'success' }
    );
    showToast('网页文档已附加');
    return true;
  } catch (error) {
    showBanner(`网页文档附加失败：${error.message}`, '改为填入正文', () => fillPageText(), { type: 'error' });
    return false;
  } finally {
    fileAttaching = false;
  }
}

function mentionTabSummary(tab) {
  return {
    id: tab.id,
    title: String(tab.title || tab.url || '').slice(0, 140),
    url: tab.url || '',
    windowId: tab.windowId,
    active: Boolean(tab.active),
    pdf: isPdfTabUrl(tab.url)
  };
}

async function listOpenTabs() {
  const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const currentWindowId = activeTab?.windowId;
  const tabs = await chrome.tabs.query({});

  return tabs
    // The current page is handled by the “读本页” flow and is exposed as a
    // separate “当前页” item; the normal tab list is for all OTHER tabs.
    .filter((tab) => tab?.id && tab.id !== activeTab?.id && /^(https?|file):/i.test(tab.url || ''))
    .map(mentionTabSummary)
    .sort((a, b) => {
      const aCurrentWindow = a.windowId === currentWindowId ? 0 : 1;
      const bCurrentWindow = b.windowId === currentWindowId ? 0 : 1;
      return aCurrentWindow - bCurrentWindow
        || (b.active ? 1 : 0) - (a.active ? 1 : 0)
        || a.title.localeCompare(b.title);
    })
    .slice(0, 200);
}

async function getCurrentMentionTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id || !/^(https?|file):/i.test(tab.url || '')) return null;
  return { ...mentionTabSummary(tab), current: true };
}

async function respondTabsRequest(source, requestId) {
  try {
    const [tabs, current] = await Promise.all([listOpenTabs(), getCurrentMentionTab()]);
    source.postMessage({ source: 'ds-sidebar', type: 'TABS_RESULT', requestId, tabs, current }, CHAT_ORIGIN);
  } catch (error) {
    source.postMessage({
      source: 'ds-sidebar',
      type: 'TABS_RESULT',
      requestId,
      tabs: [],
      current: null,
      error: error.message || '读取标签页列表失败'
    }, CHAT_ORIGIN);
  }
}

async function handleMentionTab(tabId) {
  if (mentionReading) return;
  mentionReading = true;

  try {
    const tab = await chrome.tabs.get(Number(tabId)).catch(() => null);
    if (!tab?.id || !tab.url) throw new Error('标签页已经关闭或无法访问。');

    showBanner(`正在读取标签页「${tab.title || tab.url}」…`, '', null, { kind: 'mention-tab' });
    const response = await sendBackground({
      type: 'DS_EXTRACT_ACTIVE_PAGE',
      tabId: tab.id,
      maxChars: PAGE_EXTRACT_MAX,
      mode: settings.extractMode
    });

    if (response?.pdf) {
      await attachPdfToChat(response);
      return;
    }
    if (!response?.ok) throw new Error(response?.error || '读取标签页失败。');

    await attachPageFile(response.page);
  } catch (error) {
    showBanner(`读取标签页失败：${error.message}`, '重试', () => handleMentionTab(tabId), { type: 'error' });
  } finally {
    mentionReading = false;
  }
}

async function copyPage() {
  if (!pageData?.text) return;

  try {
    await navigator.clipboard.writeText(pageData.text);
    showToast('网页正文已复制', 'success');
    return;
  } catch {
    // Fall through to the legacy copy path.
  }

  try {
    const textarea = document.createElement('textarea');
    textarea.value = pageData.text;
    textarea.style.cssText = 'position:fixed;left:-9999px;top:0;';
    document.body.appendChild(textarea);
    textarea.select();
    document.execCommand('copy');
    textarea.remove();
    showToast('网页正文已复制', 'success');
  } catch {
    showToast('复制失败，请手动选择文本', 'error', 4000);
  }
}

/* ------------------------------------------------------------------ */
/* Page tags                                                          */
/* ------------------------------------------------------------------ */

const PAGE_TAG_STOP = new Set([
  '的', '了', '和', '是', '我', '你', '请', '帮', '找', '一', '个', '要', '把', '到',
  '用', '与', '或', '在', '有', '这', '那', '些', '吗', '呢', '它', '他', '她',
  'the', 'a', 'an', 'to', 'for', 'of', 'and', 'or', 'in', 'on', 'with', 'please',
  'help', 'find', 'me', 'my', 'i', 'you', 'it', 'this', 'that', 'is', 'are'
]);

const PAGE_TAG_SYNONYMS = {
  '翻译': 'translate english translation 英文 英语',
  '总结': 'summary summarize notes 摘要 要点',
  '摘要': 'summary 总结',
  '代码': 'code coding programming 编程',
  '审查': 'review audit 检查',
  '润色': 'polish edit 修改',
  '写作': 'writing write 文案',
  '提示词': 'prompt command 指令',
  '命令': 'command prompt',
  '标签': 'tag tags',
  '网页': 'page web article 页面',
  '页面': 'page web 网页',
  '文章': 'article page 网页',
  '引用': 'quote citation',
  '对话': 'chat conversation',
  '文档': 'document pdf documentation docs',
  '教程': 'tutorial guide 指南',
  '研究': 'research study',
  '待读': 'read later 稍后读',
  '工具': 'tool 工具',
  '设计': 'design ui ux',
  '新闻': 'news',
  '数据': 'data analysis',
  '人工智能': 'ai artificial intelligence',
  'ai': '人工智能 artificial intelligence',
  'design': '设计 ui ux',
  'research': '研究 study',
  'tutorial': '教程 guide',
  'read later': '待读 稍后读',
  '技术': 'technology tech code',
  '设计': 'design',
  '研究': 'research study',
  '学习': 'learn learning course',
  '文档': 'docs documentation',
  '新闻': 'news',
  '工具': 'tool',
  '视频': 'video',
  '阅读': 'read article',
  '购物': 'shop shopping',
  '生活': 'life'
};

const PAGE_AUTO_CATEGORIES = [
  {
    name: '技术',
    words: ['编程', '代码', '开发', '技术', '人工智能', '模型', '算法', '数据库', '架构', '开源', 'programming', 'code', 'developer', 'software', 'api', 'github', 'javascript', 'typescript', 'python', 'linux', 'docker', 'database', 'ai', 'machine learning'],
    domains: ['github.com', 'gitlab.com', 'stackoverflow.com', 'developer.mozilla.org', 'dev.to']
  },
  {
    name: '设计',
    words: ['设计', '交互', '视觉', '字体', '配色', '排版', '原型', 'design', 'ui', 'ux', 'figma', 'typography', 'layout', 'prototype'],
    domains: ['figma.com', 'dribbble.com', 'behance.net']
  },
  {
    name: '研究',
    words: ['研究', '论文', '实验', '学术', '数据集', '调研', 'research', 'paper', 'study', 'experiment', 'survey', 'dataset', 'arxiv'],
    domains: ['arxiv.org', 'scholar.google.com', 'researchgate.net', 'pubmed.ncbi.nlm.nih.gov']
  },
  {
    name: '学习',
    words: ['教程', '入门', '学习', '课程', '指南', '教学', 'tutorial', 'course', 'guide', 'learn', 'how to', 'lesson'],
    domains: ['coursera.org', 'udemy.com', 'freecodecamp.org', 'w3schools.com', 'khanacademy.org']
  },
  {
    name: '文档',
    words: ['文档', '手册', '参考', '规范', '说明书', 'documentation', 'docs', 'manual', 'reference', 'specification'],
    domains: ['docs.', 'learn.microsoft.com', 'developer.apple.com', 'developer.chrome.com']
  },
  {
    name: '新闻',
    words: ['新闻', '发布', '报道', '最新', '宣布', 'news', 'release', 'announce', 'launch', 'update'],
    domains: ['techcrunch.com', 'theverge.com', '36kr.com', 'sspai.com']
  },
  {
    name: '工具',
    words: ['工具', '生成器', '转换', '在线', '计算器', 'tool', 'generator', 'converter', 'online', 'calculator'],
    domains: ['tools.', 'tool.', 'tinypng.com', 'remove.bg']
  },
  {
    name: '视频',
    words: ['视频', '影片', '教程视频', 'video', 'youtube', 'bilibili', 'watch', 'vlog'],
    domains: ['youtube.com', 'youtu.be', 'bilibili.com', 'vimeo.com']
  },
  {
    name: '阅读',
    words: ['阅读', '文章', '博客', '长文', '专栏', 'read', 'article', 'blog', 'essay', 'newsletter'],
    domains: ['medium.com', 'substack.com', 'sspai.com']
  },
  {
    name: '购物',
    words: ['购买', '价格', '优惠', '购物', '商城', 'buy', 'price', 'shop', 'deal', 'amazon'],
    domains: ['amazon.com', 'taobao.com', 'jd.com', 'tmall.com', 'ebay.com']
  },
  {
    name: '生活',
    words: ['健康', '旅行', '美食', '菜谱', '生活', 'health', 'travel', 'food', 'recipe', 'life'],
    domains: []
  }
];

const PAGE_CATEGORY_NAMES = new Set(PAGE_AUTO_CATEGORIES.map((category) => category.name));

function normalizePageTagName(value) {
  return String(value || '')
    .trim()
    .replace(/^#+/, '')
    .replace(/[,，\n\r\t]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 20);
}

function normalizePageTagList(value) {
  const list = Array.isArray(value) ? value : [];
  const result = [];
  for (const item of list) {
    const tag = normalizePageTagName(item);
    if (tag && !result.includes(tag)) result.push(tag);
  }
  return result;
}

function parsePageTagInput(value) {
  return [...new Set(String(value || '')
    .split(/[,，\n]/)
    .map((tag) => normalizePageTagName(tag))
    .filter(Boolean))].slice(0, 12);
}

function canonicalPageUrl(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  try {
    const url = new URL(raw);
    url.hash = '';
    return url.href;
  } catch {
    return raw;
  }
}

function pageDomain(value) {
  try {
    return new URL(value).hostname.replace(/^www\./i, '');
  } catch {
    return '';
  }
}

function isPageTagUrl(value) {
  return /^(https?|file):/i.test(String(value || ''));
}

function makePageTagId() {
  try {
    return crypto.randomUUID();
  } catch {
    return `page-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  }
}

function addPageTagToRegistryInMemory(value) {
  const tag = normalizePageTagName(value);
  if (!tag) return false;
  if (pageTags.includes(tag)) return false;
  pageTags.push(tag);
  pageTags.sort((a, b) => a.localeCompare(b, 'zh-CN'));
  return true;
}

function allPageTags() {
  const tags = new Set(pageTags);
  for (const entry of taggedPages) {
    for (const tag of entry.tags) tags.add(tag);
  }
  return [...tags].sort((a, b) => a.localeCompare(b, 'zh-CN'));
}

function pageTagCounts() {
  const counts = new Map();
  for (const entry of taggedPages) {
    for (const tag of entry.tags) counts.set(tag, (counts.get(tag) || 0) + 1);
  }
  return counts;
}

async function saveTaggedPages() {
  try {
    await chrome.storage.local.set({ [PAGE_TAG_KEY]: taggedPages });
  } catch {
    // Ignore storage failures.
  }
}

async function savePageTagRegistry() {
  try {
    await chrome.storage.local.set({ [PAGE_TAG_REGISTRY_KEY]: pageTags });
  } catch {
    // Ignore storage failures.
  }
}

async function savePageTagState() {
  await Promise.all([saveTaggedPages(), savePageTagRegistry()]);
}

async function loadTaggedPages() {
  try {
    const stored = await chrome.storage.local.get([PAGE_TAG_KEY, PAGE_TAG_REGISTRY_KEY]);
    const raw = stored?.[PAGE_TAG_KEY];
    const list = Array.isArray(raw)
      ? raw
      : Array.isArray(raw?.pages)
        ? raw.pages
        : [];

    const byUrl = new Map();
    for (const item of list) {
      if (!item || typeof item !== 'object') continue;
      const url = canonicalPageUrl(item.url);
      if (!url || !isPageTagUrl(url)) continue;
      const tags = normalizePageTagList(item.tags);
      if (!tags.length) continue;
      const title = String(item.title || url).trim().slice(0, 200);
      const excerpt = String(item.excerpt || '').replace(/\s+/g, ' ').trim().slice(0, 1200);
      const createdAt = Number(item.createdAt) || Date.now();
      const updatedAt = Number(item.updatedAt) || createdAt;
      const existing = byUrl.get(url);
      if (existing) {
        existing.tags = [...new Set([...existing.tags, ...tags])].slice(0, 20);
        existing.updatedAt = Math.max(existing.updatedAt, updatedAt);
        if (!existing.excerpt && excerpt) existing.excerpt = excerpt;
      } else {
        byUrl.set(url, {
          id: String(item.id || '') || makePageTagId(),
          url,
          title,
          excerpt,
          tags: tags.slice(0, 20),
          createdAt,
          updatedAt
        });
      }
    }

    taggedPages = [...byUrl.values()]
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, 500);
    pageTags = normalizePageTagList(stored?.[PAGE_TAG_REGISTRY_KEY]);
    for (const entry of taggedPages) {
      for (const tag of entry.tags) addPageTagToRegistryInMemory(tag);
    }
    pageSemanticCache.clear();
  } catch {
    taggedPages = [];
    pageTags = [];
  }
}

async function openPageTags() {
  await loadTaggedPages();
  const autoState = await chrome.storage.local.get(PAGE_TAG_AUTO_KEY);
  pageTagAutoClassify = autoState?.[PAGE_TAG_AUTO_KEY] !== false;
  $('#page-tag-auto-classify').checked = pageTagAutoClassify;
  activePageTags.clear();
  $('#page-tag-search').value = '';
  $('#page-tag-manager').classList.add('hidden');
  pageTagBusy = false;

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  pageTagTab = tab?.id && isPageTagUrl(tab.url)
    ? { id: tab.id, url: canonicalPageUrl(tab.url), title: tab.title || tab.url }
    : null;
  pageTagCurrentEntry = pageTagTab
    ? taggedPages.find((entry) => entry.url === pageTagTab.url) || null
    : null;

  renderPageTagCurrent();
  renderPageTagBar();
  renderPageTagManager();
  renderPageTagList();
  openSheet('#page-tags-sheet');
  setTimeout(() => {
    if (pageTagTab) $('#page-tag-input')?.focus({ preventScroll: true });
  }, 100);
}

function schedulePageTagRefresh() {
  if (!isSheetOpen('#page-tags-sheet')) return;
  clearTimeout(pageTagRefreshTimer);
  pageTagRefreshTimer = setTimeout(() => {
    refreshCurrentPageTab().catch(() => {});
  }, 120);
}

async function refreshCurrentPageTab() {
  if (!isSheetOpen('#page-tags-sheet') || pageTagBusy) return;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const next = tab?.id && isPageTagUrl(tab.url)
    ? {
        id: tab.id,
        url: canonicalPageUrl(tab.url),
        title: tab.title || tab.url
      }
    : null;

  if (
    (pageTagTab?.id || 0) === (next?.id || 0)
    && (pageTagTab?.url || '') === (next?.url || '')
    && (pageTagTab?.title || '') === (next?.title || '')
  ) {
    return;
  }

  pageTagTab = next;
  pageTagCurrentEntry = next
    ? taggedPages.find((entry) => entry.url === next.url) || null
    : null;
  renderPageTagCurrent();
  renderPageTagList();
}

function renderPageTagCurrent() {
  const title = $('#page-tag-current-title');
  const domain = $('#page-tag-current-domain');
  const status = $('#page-tag-current-status');
  const input = $('#page-tag-input');
  const add = $('#btn-page-tag-add');
  const tags = $('#page-tag-current-tags');
  const suggestions = $('#page-tag-suggestions');
  if (!title || !domain || !status || !input || !add || !tags || !suggestions) return;

  tags.textContent = '';
  suggestions.textContent = '';
  const available = Boolean(pageTagTab);
  input.disabled = !available || pageTagBusy;
  add.disabled = !available || pageTagBusy;

  if (!available) {
    title.textContent = '当前页不可标记';
    domain.textContent = '只支持 http(s) 或本地文件页面';
    status.textContent = '不可用';
    status.classList.remove('saved');
    input.placeholder = '切换到一个普通网页后再试';
    return;
  }

  title.textContent = pageTagTab.title || pageTagTab.url;
  title.title = title.textContent;
  domain.textContent = pageDomain(pageTagTab.url) || pageTagTab.url;
  status.textContent = pageTagCurrentEntry
    ? `已标记 · ${pageTagCurrentEntry.tags.length} 个标签`
    : '未标记';
  status.classList.toggle('saved', Boolean(pageTagCurrentEntry));
  input.placeholder = pageTagCurrentEntry
    ? '继续加标签，Enter 保存'
    : '输入标签，Enter 保存当前页';

  for (const tag of pageTagCurrentEntry?.tags || []) {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'page-tag-current-tag';
    chip.title = `移除标签：${tag}`;
    chip.textContent = `${tag} ×`;
    chip.addEventListener('click', () => removeCurrentPageTag(tag));
    tags.appendChild(chip);
  }

  const onPage = new Set(pageTagCurrentEntry?.tags || []);
  const quick = allPageTags().filter((tag) => !onPage.has(tag)).slice(0, 10);
  for (const tag of quick) {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'page-tag-suggestion';
    chip.textContent = `+ ${tag}`;
    chip.title = `给当前页加上「${tag}」`;
    chip.addEventListener('click', () => addTagsToCurrentPage([tag]));
    suggestions.appendChild(chip);
  }
}

async function addTagsToCurrentPage(values) {
  if (pageTagBusy || !pageTagTab) return;
  const names = (Array.isArray(values) ? values : parsePageTagInput(values))
    .map(normalizePageTagName)
    .filter(Boolean);
  if (!names.length) return;

  pageTagBusy = true;
  const input = $('#page-tag-input');
  const add = $('#btn-page-tag-add');
  input.disabled = true;
  add.disabled = true;

  try {
    let entry = pageTagCurrentEntry;
    if (!entry) {
      entry = {
        id: makePageTagId(),
        url: pageTagTab.url,
        title: pageTagTab.title || pageTagTab.url,
        excerpt: '',
        tags: [],
        createdAt: Date.now(),
        updatedAt: Date.now()
      };
      taggedPages.unshift(entry);
      pageTagCurrentEntry = entry;
    }

    for (const tag of names) {
      addPageTagToRegistryInMemory(tag);
      if (!entry.tags.includes(tag)) entry.tags.push(tag);
    }
    entry.title = pageTagTab.title || entry.title;
    entry.updatedAt = Date.now();
    pageSemanticCache.clear();
    await savePageTagState();

    input.value = '';
    renderPageTagCurrent();
    renderPageTagBar();
    renderPageTagManager();
    renderPageTagList();
    showToast(`已标记：${names.join('、')}`);

    const shouldAutoClassify = pageTagAutoClassify && pageTagCurrentEntry?.id === entry.id;
    if (!entry.excerpt) {
      capturePageExcerpt(entry, pageTagTab.id).finally(() => {
        if (shouldAutoClassify && pageTagAutoClassify && pageTagCurrentEntry?.id === entry.id) {
          autoClassifyEntry(entry).catch(() => {});
        }
      });
    } else if (shouldAutoClassify) {
      autoClassifyEntry(entry).catch(() => {});
    }
  } finally {
    pageTagBusy = false;
    renderPageTagCurrent();
    schedulePageTagRefresh();
  }
}

async function capturePageExcerpt(entry, tabId) {
  try {
    const response = await chrome.runtime.sendMessage({
      type: 'DS_EXTRACT_ACTIVE_PAGE',
      tabId,
      maxChars: 1600,
      mode: 'readable'
    });
    if (!response?.ok || !response.page) return;
    const excerpt = String(response.page.text || response.page.description || '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 1200);
    if (!excerpt) return;
    entry.excerpt = excerpt;
    entry.title = String(response.page.title || entry.title).slice(0, 200);
    entry.updatedAt = Date.now();
    pageSemanticCache.clear();
    await saveTaggedPages();
    if (pageTagCurrentEntry?.id === entry.id) renderPageTagCurrent();
    renderPageTagList();
  } catch {
    // A PDF/restricted page may not have readable text; title/URL are still saved.
  }
}

async function removeCurrentPageTag(value) {
  const tag = normalizePageTagName(value);
  const entry = pageTagCurrentEntry;
  if (!tag || !entry) return;
  entry.tags = entry.tags.filter((item) => item !== tag);
  entry.updatedAt = Date.now();
  pageSemanticCache.clear();
  if (!entry.tags.length) {
    taggedPages = taggedPages.filter((item) => item.id !== entry.id);
    pageTagCurrentEntry = null;
  }
  await savePageTagState();
  renderPageTagCurrent();
  renderPageTagBar();
  renderPageTagManager();
  renderPageTagList();
  showToast(`已移除标签「${tag}」`);
}

function togglePageTagFilter(value) {
  const tag = normalizePageTagName(value);
  if (!tag) return;
  if (activePageTags.has(tag)) activePageTags.delete(tag);
  else activePageTags.add(tag);
  renderPageTagBar();
  renderPageTagList();
}

function renderPageTagBar() {
  const bar = $('#page-tag-bar');
  if (!bar) return;
  bar.textContent = '';
  const tags = allPageTags();
  const counts = pageTagCounts();

  const all = document.createElement('button');
  all.type = 'button';
  all.className = `tag-chip${activePageTags.size ? '' : ' active'}`;
  all.textContent = '全部';
  all.title = '清除标签筛选';
  all.addEventListener('click', () => {
    activePageTags.clear();
    renderPageTagBar();
    renderPageTagList();
  });
  bar.appendChild(all);

  for (const tag of tags) {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = `tag-chip${activePageTags.has(tag) ? ' active' : ''}`;
    chip.title = `筛选标签：${tag}`;
    const label = document.createElement('span');
    label.textContent = tag;
    const count = document.createElement('span');
    count.className = 'tag-count';
    count.textContent = String(counts.get(tag) || 0);
    chip.append(label, count);
    chip.addEventListener('click', () => togglePageTagFilter(tag));
    bar.appendChild(chip);
  }

  const manage = document.createElement('button');
  manage.type = 'button';
  manage.className = 'tag-chip manage';
  manage.textContent = '管理';
  manage.title = '管理网页标签';
  manage.addEventListener('click', () => {
    const manager = $('#page-tag-manager');
    manager.classList.toggle('hidden');
    if (!manager.classList.contains('hidden')) {
      renderPageTagManager();
      manager.scrollIntoView({ block: 'nearest' });
    }
  });
  bar.appendChild(manage);
}

function renderPageTagManager() {
  const list = $('#page-tag-manager-list');
  if (!list) return;
  list.textContent = '';
  const tags = allPageTags();
  const counts = pageTagCounts();

  if (!tags.length) {
    const empty = document.createElement('div');
    empty.className = 'page-tag-empty';
    empty.textContent = '还没有标签。给当前页加一个，或在下方新建。';
    list.appendChild(empty);
    return;
  }

  for (const tag of tags) {
    const row = document.createElement('div');
    row.className = 'tag-row';

    const name = document.createElement('span');
    name.className = 'tag-row-name';
    name.textContent = tag;
    name.title = tag;

    const count = document.createElement('span');
    count.className = 'tag-row-count';
    count.textContent = `${counts.get(tag) || 0} 个网页`;

    const actions = document.createElement('div');
    actions.className = 'tag-row-actions';

    const rename = document.createElement('button');
    rename.type = 'button';
    rename.textContent = '改名';
    rename.addEventListener('click', () => beginPageTagRename(row, tag));

    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'danger';
    remove.textContent = '删除';
    remove.addEventListener('click', () => deletePageTag(tag));

    actions.append(rename, remove);
    row.append(name, count, actions);
    list.appendChild(row);
  }
}

function beginPageTagRename(row, tag) {
  const name = row.querySelector('.tag-row-name');
  if (!name) return;
  const input = document.createElement('input');
  input.className = 'tag-rename-input';
  input.type = 'text';
  input.maxLength = 20;
  input.value = tag;
  name.replaceWith(input);
  input.focus();
  input.select();

  let done = false;
  const finish = async (save) => {
    if (done) return;
    done = true;
    if (save) await renamePageTag(tag, input.value);
    else renderPageTagManager();
  };

  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      finish(true);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      finish(false);
    }
  });
  input.addEventListener('blur', () => finish(true));
}

async function addPageTag(value) {
  const tag = normalizePageTagName(value);
  if (!tag) return;
  if (allPageTags().includes(tag)) {
    showToast(`标签「${tag}」已存在`);
    return;
  }
  addPageTagToRegistryInMemory(tag);
  await savePageTagRegistry();
  renderPageTagBar();
  renderPageTagManager();
  renderPageTagCurrent();
  showToast(`已新建标签「${tag}」`);
}

async function renamePageTag(oldValue, newValue) {
  const oldTag = normalizePageTagName(oldValue);
  const newTag = normalizePageTagName(newValue);
  if (!oldTag) return;
  if (!newTag || oldTag === newTag) {
    renderPageTagManager();
    return;
  }

  const exists = allPageTags().includes(newTag);
  pageTags = pageTags.filter((tag) => tag !== oldTag);
  if (!pageTags.includes(newTag)) pageTags.push(newTag);
  for (const entry of taggedPages) {
    if (!entry.tags.includes(oldTag)) continue;
    entry.tags = [...new Set(entry.tags.map((tag) => (tag === oldTag ? newTag : tag)))];
    entry.updatedAt = Date.now();
  }
  if (activePageTags.delete(oldTag)) activePageTags.add(newTag);
  pageSemanticCache.clear();
  await savePageTagState();
  renderPageTagBar();
  renderPageTagManager();
  renderPageTagCurrent();
  renderPageTagList();
  showToast(exists ? `已合并到「${newTag}」` : `已改名为「${newTag}」`);
}

async function deletePageTag(value) {
  const tag = normalizePageTagName(value);
  if (!tag) return;
  pageTags = pageTags.filter((item) => item !== tag);
  for (const entry of taggedPages) {
    if (!entry.tags.includes(tag)) continue;
    entry.tags = entry.tags.filter((item) => item !== tag);
    entry.updatedAt = Date.now();
  }
  taggedPages = taggedPages.filter((entry) => entry.tags.length);
  if (pageTagCurrentEntry && !taggedPages.some((entry) => entry.id === pageTagCurrentEntry.id)) {
    pageTagCurrentEntry = null;
  }
  activePageTags.delete(tag);
  pageSemanticCache.clear();
  await savePageTagState();
  renderPageTagBar();
  renderPageTagManager();
  renderPageTagCurrent();
  renderPageTagList();
  showToast(`已删除标签「${tag}」`);
}

function pageSemanticTerms(raw) {
  const text = String(raw || '').toLowerCase().normalize('NFKC');
  const terms = new Set();
  const add = (value) => {
    const term = String(value || '').trim();
    if (!term || PAGE_TAG_STOP.has(term)) return;
    terms.add(term);
  };

  for (const word of text.match(/[a-z0-9][a-z0-9+#./_-]*/g) || []) add(word);
  for (const sequence of text.match(/[\u4e00-\u9fa5]+/g) || []) {
    if (sequence.length === 1) add(sequence);
    for (let i = 0; i + 1 < sequence.length; i += 1) {
      add(sequence.slice(i, i + 2));
      if (i + 2 < sequence.length) add(sequence.slice(i, i + 3));
    }
  }

  for (const term of [...terms]) {
    const synonyms = PAGE_TAG_SYNONYMS[term];
    if (!synonyms) continue;
    for (const synonym of synonyms.split(/\s+/)) add(synonym);
  }
  return terms;
}

function pageEntryTerms(entry) {
  const key = `${entry.id}:${entry.updatedAt}`;
  if (pageSemanticCache.has(key)) return pageSemanticCache.get(key);
  const terms = pageSemanticTerms([
    entry.title,
    entry.url,
    entry.tags.join(' '),
    entry.excerpt.slice(0, 1200)
  ].join('\n'));
  pageSemanticCache.set(key, terms);
  return terms;
}

function pageSemanticScore(entry, term, queryTerms = pageSemanticTerms(term)) {
  const query = term.toLowerCase();
  const title = String(entry.title || '').toLowerCase();
  const url = String(entry.url || '').toLowerCase();
  const tags = entry.tags.join(' ').toLowerCase();
  const excerpt = String(entry.excerpt || '').toLowerCase();
  let score = 0;

  if (title.includes(query)) score += 26;
  if (tags.includes(query)) score += 20;
  if (url.includes(query)) score += 10;
  if (excerpt.includes(query)) score += 8;

  const docTerms = pageEntryTerms(entry);
  let overlap = 0;
  for (const item of queryTerms) {
    if (docTerms.has(item)) overlap += item.length >= 2 ? 2 : 1;
  }
  if (overlap) score += (overlap / Math.sqrt(docTerms.size + 1)) * 10;
  for (const tag of entry.tags) {
    if (queryTerms.has(tag.toLowerCase())) score += 8;
  }
  return score;
}

function pageContainsTerm(text, term) {
  const haystack = String(text || '').toLowerCase();
  const needle = String(term || '').toLowerCase();
  if (!haystack || !needle) return false;
  if (/^[a-z0-9+#. /_-]+$/i.test(needle)) {
    const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`(^|[^a-z0-9])${escaped}($|[^a-z0-9])`, 'i').test(haystack);
  }
  return haystack.includes(needle);
}

function classifyPage(entry) {
  const title = String(entry.title || '').toLowerCase();
  const excerpt = String(entry.excerpt || '').toLowerCase().slice(0, 1200);
  const url = String(entry.url || '').toLowerCase();
  const tags = entry.tags.join(' ').toLowerCase();
  const host = pageDomain(entry.url).toLowerCase();

  const scored = PAGE_AUTO_CATEGORIES.map((category) => {
    let score = 0;
    for (const word of category.words) {
      if (pageContainsTerm(title, word)) score += 5;
      else if (pageContainsTerm(host, word)) score += 2;
      else if (pageContainsTerm(excerpt, word)) score += 1;
      if (pageContainsTerm(tags, word)) score += 2;
    }
    if (category.domains.some((domain) => host === domain || host.endsWith(`.${domain}`) || host.includes(domain))) {
      score += 8;
    }
    return { name: category.name, score };
  }).sort((a, b) => b.score - a.score);

  if (!scored.length || scored[0].score < 4) return null;
  return scored[0];
}

async function autoClassifyEntry(entry, { manual = false } = {}) {
  if (!entry || !taggedPages.some((item) => item.id === entry.id)) return false;
  const existing = entry.tags.find((tag) => PAGE_CATEGORY_NAMES.has(tag));
  if (existing) {
    if (manual) showToast(`这个网页已经有分类：${existing}`);
    return false;
  }

  const category = classifyPage(entry);
  if (!category) {
    if (manual) showToast('没有识别到明确分类，可手动加标签', 'info', 3200);
    return false;
  }

  addPageTagToRegistryInMemory(category.name);
  entry.tags.push(category.name);
  entry.updatedAt = Date.now();
  pageSemanticCache.clear();
  await savePageTagState();
  renderPageTagCurrent();
  renderPageTagBar();
  renderPageTagManager();
  renderPageTagList();
  showToast(`已自动分类：${category.name}`);
  return true;
}

async function autoClassifyCurrentPage() {
  if (!pageTagTab) {
    showToast('当前页不可分类');
    return;
  }
  if (pageTagCurrentEntry) {
    await autoClassifyEntry(pageTagCurrentEntry, { manual: true });
    return;
  }

  const entry = {
    id: makePageTagId(),
    url: pageTagTab.url,
    title: pageTagTab.title || pageTagTab.url,
    excerpt: '',
    tags: [],
    createdAt: Date.now(),
    updatedAt: Date.now()
  };
  const category = classifyPage(entry);
  if (!category) {
    showToast('没有识别到明确分类，可手动加标签', 'info', 3200);
    return;
  }

  entry.tags.push(category.name);
  taggedPages.unshift(entry);
  pageTagCurrentEntry = entry;
  addPageTagToRegistryInMemory(category.name);
  pageSemanticCache.clear();
  await savePageTagState();
  renderPageTagCurrent();
  renderPageTagBar();
  renderPageTagManager();
  renderPageTagList();
  showToast(`已自动分类：${category.name}`);
}

function renderPageTagList() {
  const list = $('#page-tag-list');
  if (!list) return;
  list.textContent = '';

  const term = $('#page-tag-search').value.trim();
  const queryTerms = term ? pageSemanticTerms(term) : null;
  const tagFiltered = taggedPages.filter((entry) =>
    [...activePageTags].every((tag) => entry.tags.includes(tag))
  );

  let sorted;
  if (term) {
    sorted = tagFiltered
      .map((entry) => ({ entry, score: pageSemanticScore(entry, term, queryTerms) }))
      .filter((item) => item.score > 0)
      .sort((a, b) => b.score - a.score || b.entry.updatedAt - a.entry.updatedAt)
      .map((item) => item.entry);
  } else {
    sorted = [...tagFiltered].sort((a, b) => b.updatedAt - a.updatedAt);
  }

  const count = $('#page-tag-count');
  if (count) {
    count.textContent = term || activePageTags.size
      ? `${sorted.length} / ${taggedPages.length} 个网页`
      : `${taggedPages.length} 个已标记网页`;
  }

  if (!sorted.length) {
    const empty = document.createElement('div');
    empty.className = 'page-tag-empty';
    empty.textContent = taggedPages.length
      ? '没有匹配的网页。试试更自然的描述，或清除标签筛选。'
      : '还没有标记网页。给当前页输入一个标签即可开始；标签只保存在本机。';
    list.appendChild(empty);
    return;
  }

  for (const entry of sorted) {
    list.appendChild(createPageTagElement(entry));
  }
}

function createPageTagElement(entry) {
  const item = document.createElement('div');
  item.className = 'page-tag-item';

  const head = document.createElement('div');
  head.className = 'page-tag-item-head';

  const copy = document.createElement('div');
  copy.className = 'page-tag-item-copy';

  const title = document.createElement('span');
  title.className = 'page-tag-item-title';
  title.textContent = entry.title || entry.url;
  title.title = title.textContent;

  const domain = document.createElement('span');
  domain.className = 'page-tag-item-domain';
  domain.textContent = pageDomain(entry.url) || entry.url;

  copy.append(title, domain);
  head.appendChild(copy);

  if (pageTagTab?.url === entry.url) {
    const badge = document.createElement('span');
    badge.className = 'page-tag-current-badge';
    badge.textContent = '当前';
    head.appendChild(badge);
  }

  const tags = document.createElement('div');
  tags.className = 'page-tag-item-tags';
  for (const tag of entry.tags) {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'page-tag-item-tag';
    chip.textContent = tag;
    chip.title = `筛选标签：${tag}`;
    chip.addEventListener('click', () => togglePageTagFilter(tag));
    tags.appendChild(chip);
  }

  const excerpt = document.createElement('p');
  excerpt.className = 'page-tag-item-excerpt';
  excerpt.textContent = entry.excerpt || '打开后可继续标记；暂未读取正文摘要。';

  const actions = document.createElement('div');
  actions.className = 'page-tag-item-actions';

  const open = document.createElement('button');
  open.type = 'button';
  open.className = 'btn primary';
  open.textContent = '打开';
  open.addEventListener('click', () => {
    chrome.tabs.create({ url: entry.url }).catch(() => showToast('打开网页失败', 'error', 4000));
  });

  const remove = document.createElement('button');
  remove.type = 'button';
  remove.className = 'btn ghost danger';
  remove.textContent = '移除';
  remove.addEventListener('click', async () => {
    if (!window.confirm(`移除「${entry.title || entry.url}」的网页标签记录？`)) return;
    taggedPages = taggedPages.filter((item) => item.id !== entry.id);
    if (pageTagCurrentEntry?.id === entry.id) pageTagCurrentEntry = null;
    pageSemanticCache.clear();
    await saveTaggedPages();
    renderPageTagCurrent();
    renderPageTagBar();
    renderPageTagManager();
    renderPageTagList();
    showToast('已移除网页记录');
  });

  actions.append(open, remove);
  item.append(head, tags, excerpt, actions);
  return item;
}

/* ------------------------------------------------------------------ */
/* Prompt library                                                     */
/* ------------------------------------------------------------------ */

async function openPromptLibrary() {
  await loadPrompts();
  promptSearchTerm = '';
  $('#prompt-search').value = '';
  hidePromptForm();
  renderPromptList();
  openSheet('#prompt-sheet');
}

async function loadPrompts() {
  try {
    const stored = await chrome.storage.local.get(PROMPT_STORAGE_KEY);
    const raw = stored?.[PROMPT_STORAGE_KEY];
    const list = Array.isArray(raw)
      ? raw
      : Array.isArray(raw?.prompts)
        ? raw.prompts
        : Array.isArray(raw?.items)
          ? raw.items
          : [];

    const seen = new Set();
    const seenCommands = new Set();
    const normalized = [];
    for (const item of list) {
      const prompt = normalizePrompt(item);
      if (!prompt) continue;
      if (!prompt.id || seen.has(prompt.id)) prompt.id = makePromptId();
      seen.add(prompt.id);
      prompt.command = makeUniquePromptCommand(prompt.command, seenCommands);
      seenCommands.add(prompt.command);
      normalized.push(prompt);
    }
    prompts = normalized;
  } catch {
    prompts = [];
  }
}

function normalizePrompt(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const text = String(raw.text ?? raw.content ?? '').trim();
  if (!text) return null;

  const name = String(raw.name ?? raw.title ?? '').trim() || autoPromptName(text);
  const tags = Array.isArray(raw.tags)
    ? [...new Set(raw.tags.map((tag) => String(tag).trim()).filter(Boolean))].slice(0, 20)
    : [];

  return {
    id: String(raw.id || ''),
    name: name.slice(0, 80),
    text: text.slice(0, 50000),
    tags,
    command: normalizePromptCommand(raw.command) || autoPromptCommand(name),
    createdAt: Number(raw.createdAt) || Date.now(),
    updatedAt: Number(raw.updatedAt) || Number(raw.createdAt) || Date.now(),
    pinnedAt: Number(raw.pinnedAt) || 0
  };
}

function autoPromptName(text) {
  const line = String(text || '').replace(/\s+/g, ' ').trim();
  return line.slice(0, 40) || '未命名提示词';
}

function normalizePromptCommand(value) {
  let command = String(value || '').trim();
  if (!command) return '';
  if (!command.startsWith('/')) command = `/${command}`;
  command = command.replace(/\s+/g, '-').replace(/[^\w\u4e00-\u9fa5\-/]/g, '');
  if (command === '/' || command === '/-') return '';
  return command.slice(0, 40);
}

function autoPromptCommand(name) {
  const base = normalizePromptCommand(`/${String(name || '').replace(/\s+/g, '-')}`);
  return base || '/prompt';
}

function makeUniquePromptCommand(base, used) {
  const command = normalizePromptCommand(base) || '/prompt';
  let candidate = command;
  let index = 2;
  while (used.has(candidate)) {
    candidate = `${command}-${index}`;
    index += 1;
  }
  return candidate;
}

function uniquePromptCommand(base, excludeId = '') {
  const used = new Set(
    prompts
      .filter((prompt) => prompt.id !== excludeId)
      .map((prompt) => prompt.command)
      .filter(Boolean)
  );
  return makeUniquePromptCommand(base, used);
}

function makePromptId() {
  try {
    return crypto.randomUUID();
  } catch {
    return `p-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  }
}

async function savePrompts() {
  try {
    await chrome.storage.local.set({ [PROMPT_STORAGE_KEY]: prompts });
  } catch {
    // Ignore storage failures.
  }
}

function renderPromptList() {
  const listElement = $('#prompt-list');
  if (!listElement) return;
  listElement.textContent = '';

  const term = promptSearchTerm.trim().toLowerCase();
  const filtered = prompts.filter((prompt) => {
    if (!term) return true;
    return `${prompt.name}\n${prompt.command}\n${prompt.text}\n${prompt.tags.join(' ')}`.toLowerCase().includes(term);
  });

  const sorted = [...filtered].sort((a, b) => {
    const pinned = (b.pinnedAt ? 1 : 0) - (a.pinnedAt ? 1 : 0);
    return pinned || b.createdAt - a.createdAt;
  });

  $('#prompt-count').textContent = term
    ? `${sorted.length} / ${prompts.length} 条`
    : `${prompts.length} 条提示词`;

  if (!sorted.length) {
    const empty = document.createElement('div');
    empty.className = 'prompt-empty';
    empty.textContent = term
      ? '没有匹配的提示词。'
      : '还没有保存的提示词。点“粘贴创建”或直接 Ctrl+V 新建，也可以保存当前输入。';
    listElement.appendChild(empty);
    return;
  }

  for (const prompt of sorted) {
    listElement.appendChild(createPromptElement(prompt));
  }
}

function createPromptElement(prompt) {
  const item = document.createElement('div');
  item.className = `prompt-item${prompt.pinnedAt ? ' pinned' : ''}`;

  const head = document.createElement('div');
  head.className = 'prompt-item-head';

  const name = document.createElement('div');
  name.className = 'prompt-name';
  name.textContent = prompt.name;
  name.title = prompt.name;

  const pin = document.createElement('button');
  pin.type = 'button';
  pin.className = `prompt-pin${prompt.pinnedAt ? ' active' : ''}`;
  pin.textContent = prompt.pinnedAt ? '★' : '☆';
  pin.title = prompt.pinnedAt ? '取消置顶' : '置顶';
  pin.addEventListener('click', async () => {
    prompt.pinnedAt = prompt.pinnedAt ? 0 : Date.now();
    prompt.updatedAt = Date.now();
    await savePrompts();
    renderPromptList();
  });

  head.appendChild(name);
  head.appendChild(pin);

  const command = document.createElement('div');
  command.className = 'prompt-command';
  command.textContent = prompt.command;
  command.title = `在 ${providerName()} 输入框输入 / 调用此提示词`;

  const text = document.createElement('div');
  text.className = 'prompt-text';
  text.textContent = prompt.text;
  text.title = prompt.text;

  const tags = document.createElement('div');
  tags.className = 'prompt-tags';
  for (const tag of prompt.tags) {
    const chip = document.createElement('span');
    chip.className = 'prompt-tag';
    chip.textContent = tag;
    tags.appendChild(chip);
  }

  const actions = document.createElement('div');
  actions.className = 'prompt-actions';

  const fill = document.createElement('button');
  fill.type = 'button';
  fill.className = 'btn primary';
  fill.textContent = '填入';
  fill.addEventListener('click', () => fillPrompt(prompt));

  const edit = document.createElement('button');
  edit.type = 'button';
  edit.className = 'btn';
  edit.textContent = '编辑';
  edit.addEventListener('click', () => showPromptForm('edit', prompt));

  const remove = document.createElement('button');
  remove.type = 'button';
  remove.className = 'btn ghost danger';
  remove.textContent = '删除';
  remove.addEventListener('click', async () => {
    if (!window.confirm(`删除提示词「${prompt.name}」？`)) return;
    prompts = prompts.filter((itemPrompt) => itemPrompt.id !== prompt.id);
    await savePrompts();
    renderPromptList();
    showToast('已删除提示词');
  });

  actions.appendChild(fill);
  actions.appendChild(edit);
  actions.appendChild(remove);

  item.appendChild(head);
  item.appendChild(command);
  item.appendChild(text);
  if (prompt.tags.length) item.appendChild(tags);
  item.appendChild(actions);
  return item;
}

async function fillPrompt(prompt) {
  closeSheet('#prompt-sheet');
  const ok = await fillChat(prompt.text, 'replace');
  if (ok) showToast(`已填入提示词「${prompt.name}」`);
}

function showPromptForm(mode, prompt = null) {
  promptFormMode = mode;
  promptEditId = prompt?.id || '';
  $('#prompt-name').value = prompt?.name || '';
  $('#prompt-tags').value = prompt?.tags?.join(', ') || '';
  $('#prompt-command').value = prompt?.command || '';
  $('#prompt-text').value = prompt?.text || '';
  $('#prompt-form-hint').textContent = mode === 'edit' ? '编辑提示词' : '新建提示词；可直接 Ctrl+V 粘贴';
  $('#prompt-form').classList.remove('hidden');
  $('#prompt-name').focus();
}

function hidePromptForm() {
  promptFormMode = '';
  promptEditId = '';
  const form = $('#prompt-form');
  if (!form) return;
  form.classList.add('hidden');
  $('#prompt-name').value = '';
  $('#prompt-tags').value = '';
  $('#prompt-command').value = '';
  $('#prompt-text').value = '';
  $('#prompt-form-hint').textContent = '';
}

function startNewPrompt(text = '', hint = '') {
  promptFormMode = 'new';
  promptEditId = '';
  const clean = String(text || '').trim();
  const name = clean ? autoPromptName(clean) : '';
  $('#prompt-name').value = name;
  $('#prompt-tags').value = '';
  $('#prompt-command').value = name ? autoPromptCommand(name) : '';
  $('#prompt-text').value = clean;
  $('#prompt-form-hint').textContent = hint || '新建提示词；可直接 Ctrl+V 粘贴';
  $('#prompt-form').classList.remove('hidden');
  if (clean) $('#prompt-text').focus();
  else $('#prompt-name').focus();
}

async function startSaveCurrentPrompt() {
  try {
    const text = String(await getChatInputText() || '').trim();
    if (!text) {
      showToast(`${providerName()} 输入框为空`);
      return;
    }
    startNewPrompt(text, `保存当前 ${providerName()} 输入框内容`);
    $('#prompt-name').focus();
    $('#prompt-name').select();
  } catch (error) {
    showToast(`读取输入框失败：${error.message}`, 'error', 4000);
  }
}

async function pasteCreatePrompt() {
  try {
    const text = String(await navigator.clipboard.readText() || '').trim();
    if (!text) {
      startNewPrompt('', '剪贴板为空；请在文本框中粘贴提示词');
      showToast('剪贴板为空，请直接粘贴文本');
      return;
    }
    startNewPrompt(text, '已从剪贴板创建；可修改名称/命令后保存');
    showToast('已从剪贴板创建提示词');
  } catch {
    startNewPrompt('', '无法读取剪贴板；请在文本框中按 Ctrl+V');
    showToast('无法读取剪贴板，请在文本框中按 Ctrl+V', 'info', 4000);
  }
}

async function savePromptForm() {
  const text = $('#prompt-text').value.trim();
  if (!text) {
    $('#prompt-form-hint').textContent = '提示词内容不能为空';
    return;
  }

  const wasEdit = promptFormMode === 'edit';
  const name = ($('#prompt-name').value.trim() || autoPromptName(text)).slice(0, 80);
  const tags = parsePromptTags($('#prompt-tags').value);
  const command = uniquePromptCommand(
    normalizePromptCommand($('#prompt-command').value) || autoPromptCommand(name),
    wasEdit ? promptEditId : ''
  );
  const now = Date.now();

  if (wasEdit && promptEditId) {
    const index = prompts.findIndex((prompt) => prompt.id === promptEditId);
    if (index >= 0) {
      prompts[index] = {
        ...prompts[index],
        name,
        text: text.slice(0, 50000),
        tags,
        command,
        updatedAt: now
      };
    }
  } else {
    prompts.unshift({
      id: makePromptId(),
      name,
      text: text.slice(0, 50000),
      tags,
      command,
      createdAt: now,
      updatedAt: now,
      pinnedAt: 0
    });
  }

  await savePrompts();
  hidePromptForm();
  renderPromptList();
  showToast(wasEdit ? '提示词已更新' : '提示词已保存');
}

function parsePromptTags(value) {
  return [...new Set(String(value || '')
    .split(/[,，\n]/)
    .map((tag) => tag.trim().replace(/^#/, ''))
    .filter(Boolean))].slice(0, 20);
}

async function getChatInputText() {
  if (!bridgeReady) {
    const ready = await waitForBridge(5000);
    if (!ready) throw new Error(`还没有连接到 ${providerName()}`);
  }
  const response = await sendToFrame('DS_GET_INPUT', {}, 5000);
  if (!response?.ok) throw new Error(response?.error || '没有找到输入框');
  return String(response.text || '');
}

async function importPrompts(event) {
  const file = event.target.files?.[0];
  event.target.value = '';
  if (!file) return;

  try {
    const data = JSON.parse(await file.text());
    const list = Array.isArray(data)
      ? data
      : Array.isArray(data?.prompts)
        ? data.prompts
        : Array.isArray(data?.items)
          ? data.items
          : [];
    if (!list.length) throw new Error('没有找到提示词');

    const existingTexts = new Set(prompts.map((prompt) => prompt.text.trim()));
    let added = 0;
    for (const raw of list) {
      if (added >= 500) break;
      const prompt = normalizePrompt(raw);
      if (!prompt) continue;
      if (existingTexts.has(prompt.text.trim())) continue;
      if (!prompt.id || prompts.some((item) => item.id === prompt.id)) prompt.id = makePromptId();
      prompts.unshift(prompt);
      existingTexts.add(prompt.text.trim());
      added += 1;
    }

    await savePrompts();
    renderPromptList();
    showToast(`已导入 ${added} 条提示词`);
  } catch (error) {
    showToast(`导入失败：${error.message}`, 'error', 4000);
  }
}

function exportPrompts() {
  if (!prompts.length) {
    showToast('提示词库为空');
    return;
  }

  const payload = {
    version: 1,
    exportedAt: new Date().toISOString(),
    prompts
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `deepseek-prompts-${new Date().toISOString().slice(0, 10)}.json`;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  showToast(`已导出 ${prompts.length} 条提示词`);
}

/* ------------------------------------------------------------------ */
/* Background messages                                                */
/* ------------------------------------------------------------------ */

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || typeof message !== 'object') return;

  switch (message.type) {
    case 'DS_PENDING_SELECTION':
      handleIncomingSelection(message.selection, { auto: true }).catch(() => {});
      sendResponse({ ok: true });
      return false;

    case 'DS_PENDING_SELECTION_CLEARED':
      handleSelectionCleared(message.selectionId).catch(() => {});
      sendResponse({ ok: true });
      return false;

    case 'DS_PENDING_PAGE':
      handlePendingPage(message.page);
      sendResponse({ ok: true });
      return false;

    case 'DS_QUOTE_TEXT':
      quoteInChat(message.text).catch(() => {});
      sendResponse({ ok: true });
      return false;

    case 'DS_NOTICE':
      showBanner(message.message || '操作失败。', '重试', readPage, {
        type: message.level === 'error' ? 'error' : 'info',
        kind: 'notice'
      });
      sendResponse({ ok: true });
      return false;

    default:
      return;
  }
});

async function requestPending() {
  try {
    const pending = await sendBackground({ type: 'DS_GET_PENDING' });
    if (!pending) return;

    if (pending.page) handlePendingPage(pending.page);
    if (pending.selection) handleIncomingSelection(pending.selection, { auto: true });
  } catch (error) {
    console.debug('[DS+] pending state unavailable:', error.message);
  }
}

function handlePendingPage(pending) {
  const page = pending?.page || pending;
  if (page?.pdf) {
    attachPdfToChat(page);
    return;
  }
  if (!page?.text) return;
  if (isSheetOpen('#settings-sheet')) closeSheet('#settings-sheet');
  renderPageSheet(page);
  openSheet('#page-sheet');
}

function sendBackground(message) {
  return new Promise((resolve, reject) => {
    try {
      chrome.runtime.sendMessage(message, (response) => {
        const error = chrome.runtime.lastError;
        if (error) reject(new Error(error.message));
        else resolve(response);
      });
    } catch (error) {
      reject(error);
    }
  });
}

/* ------------------------------------------------------------------ */
/* Sheets                                                             */
/* ------------------------------------------------------------------ */

function openSheet(selector) {
  const sheet = $(selector);
  if (!sheet) return;

  const existingTimer = sheetTimers.get(sheet);
  if (existingTimer) clearTimeout(existingTimer);

  sheet.classList.remove('hidden');
  sheet.setAttribute('aria-hidden', 'false');
  requestAnimationFrame(() => sheet.classList.add('open'));

  const focusTarget = sheet.querySelector('.icon-btn, select, input, button');
  setTimeout(() => focusTarget?.focus({ preventScroll: true }), 80);
}

function closeSheet(selector) {
  const sheet = $(selector);
  if (!sheet || sheet.classList.contains('hidden')) return;

  sheet.classList.remove('open');
  sheet.setAttribute('aria-hidden', 'true');

  const timer = setTimeout(() => {
    sheet.classList.add('hidden');
    sheetTimers.delete(sheet);
  }, 200);
  sheetTimers.set(sheet, timer);
}

function isSheetOpen(selector) {
  const sheet = $(selector);
  return Boolean(sheet && !sheet.classList.contains('hidden') && sheet.classList.contains('open'));
}

/* ------------------------------------------------------------------ */
/* Settings                                                           */
/* ------------------------------------------------------------------ */

async function loadSettings() {
  try {
    const stored = await chrome.storage.local.get('settings');
    settings = normalizeSettings(stored?.settings || {});
  } catch {
    settings = { ...DEFAULT_SETTINGS };
  }
}

function normalizeSettings(value) {
  return {
    autoFillSelection: value.autoFillSelection !== false,
    selectionMode: ['smart', 'replace', 'append'].includes(value.selectionMode) ? value.selectionMode : 'smart',
    attachPageInfo: Boolean(value.attachPageInfo),
    showPageToast: value.showPageToast !== false,
    autoOpenLocalPdfReader: value.autoOpenLocalPdfReader !== false,
    extractMode: value.extractMode === 'full' ? 'full' : 'readable',
    maxPageChars: [6000, 12000, 20000, 30000].includes(Number(value.maxPageChars)) ? Number(value.maxPageChars) : 12000
  };
}

async function saveSettings() {
  try {
    await chrome.storage.local.set({ settings });
  } catch {
    // Ignore.
  }
}

function applySettingsToUI() {
  const autoFill = $('#setting-autofill');
  const mode = $('#setting-mode');
  const attach = $('#setting-attach');
  const pageToast = $('#setting-page-toast');
  const localPdfReader = $('#setting-local-pdf-reader');
  const extractMode = $('#setting-extract-mode');
  const maxChars = $('#setting-maxchars');

  if (autoFill) autoFill.checked = Boolean(settings.autoFillSelection);
  if (mode) mode.value = settings.selectionMode;
  if (attach) attach.checked = Boolean(settings.attachPageInfo);
  if (pageToast) pageToast.checked = Boolean(settings.showPageToast);
  if (localPdfReader) localPdfReader.checked = Boolean(settings.autoOpenLocalPdfReader);
  if (extractMode) extractMode.value = settings.extractMode;
  if (maxChars) maxChars.value = String(settings.maxPageChars);

  updateAutofillButton();
}

function updateAutofillButton() {
  const button = $('#btn-autofill');
  if (!button) return;
  button.classList.toggle('active', Boolean(settings.autoFillSelection));
  button.setAttribute('aria-pressed', String(Boolean(settings.autoFillSelection)));
  button.title = settings.autoFillSelection
    ? '划词自动填入：开（点击关闭）'
    : '划词自动填入：关（点击开启）';
}

function toggleAutofill() {
  settings.autoFillSelection = !settings.autoFillSelection;
  const checkbox = $('#setting-autofill');
  if (checkbox) checkbox.checked = settings.autoFillSelection;
  updateAutofillButton();
  saveSettings();
  showToast(settings.autoFillSelection ? '划词自动填入已开启' : '划词自动填入已关闭');
}

function restoreDefaults() {
  settings = { ...DEFAULT_SETTINGS };
  applySettingsToUI();
  saveSettings();
  showToast('已恢复默认设置');
}

/* ------------------------------------------------------------------ */
/* UI wiring                                                          */
/* ------------------------------------------------------------------ */

function bindUI() {
  $$('.provider-tab').forEach((button) => {
    button.addEventListener('click', () => {
      applyChatProvider(button.getAttribute('data-provider'));
    });
  });

  $('#btn-read').addEventListener('click', readPage);
  $('#btn-autofill').addEventListener('click', toggleAutofill);
  $('#btn-settings').addEventListener('click', () => {
    applySettingsToUI();
    openSheet('#settings-sheet');
  });

  $('#btn-attach-page').addEventListener('click', () => {
    if (pageData?.text) attachPageFile(pageData);
  });
  $('#btn-fill-raw').addEventListener('click', fillPageText);
  $('#btn-copy-page').addEventListener('click', copyPage);

  $('#setting-autofill').addEventListener('change', (event) => {
    settings.autoFillSelection = event.target.checked;
    updateAutofillButton();
    saveSettings();
    showToast(settings.autoFillSelection ? '划词自动填入已开启' : '划词自动填入已关闭');
  });

  $('#setting-mode').addEventListener('change', (event) => {
    settings.selectionMode = event.target.value;
    saveSettings();
  });

  $('#setting-attach').addEventListener('change', (event) => {
    settings.attachPageInfo = event.target.checked;
    saveSettings();
  });

  $('#setting-page-toast').addEventListener('change', (event) => {
    settings.showPageToast = event.target.checked;
    saveSettings();
  });

  $('#setting-local-pdf-reader').addEventListener('change', (event) => {
    settings.autoOpenLocalPdfReader = event.target.checked;
    saveSettings();
  });

  $('#setting-extract-mode').addEventListener('change', (event) => {
    settings.extractMode = event.target.value === 'full' ? 'full' : 'readable';
    saveSettings();
  });

  $('#setting-maxchars').addEventListener('change', (event) => {
    settings.maxPageChars = Number(event.target.value) || DEFAULT_SETTINGS.maxPageChars;
    saveSettings();
  });

  $('#btn-page-tags').addEventListener('click', () => {
    openPageTags().catch((error) => showToast(`打开网页标签失败：${error.message}`, 'error', 4000));
  });
  $('#btn-page-tag-add').addEventListener('click', () => {
    addTagsToCurrentPage($('#page-tag-input').value)
      .catch((error) => showToast(`保存标签失败：${error.message}`, 'error', 4000));
  });
  $('#page-tag-input').addEventListener('keydown', (event) => {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    $('#btn-page-tag-add').click();
  });
  $('#page-tag-auto-classify').addEventListener('change', (event) => {
    pageTagAutoClassify = Boolean(event.target.checked);
    chrome.storage.local.set({ [PAGE_TAG_AUTO_KEY]: pageTagAutoClassify }).catch(() => {});
    if (pageTagAutoClassify && pageTagCurrentEntry) {
      autoClassifyEntry(pageTagCurrentEntry).catch(() => {});
    }
  });
  $('#btn-page-tag-auto').addEventListener('click', () => {
    autoClassifyCurrentPage().catch((error) => showToast(`自动分类失败：${error.message}`, 'error', 4000));
  });
  $('#page-tag-search').addEventListener('input', renderPageTagList);
  $('#btn-page-tag-manager-close').addEventListener('click', () => {
    $('#page-tag-manager').classList.add('hidden');
  });
  $('#btn-page-tag-registry-add').addEventListener('click', () => {
    const input = $('#page-tag-new-name');
    addPageTag(input.value)
      .then(() => { input.value = ''; input.focus(); })
      .catch((error) => showToast(`新建标签失败：${error.message}`, 'error', 4000));
  });
  $('#page-tag-new-name').addEventListener('keydown', (event) => {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    $('#btn-page-tag-registry-add').click();
  });
  chrome.tabs.onActivated.addListener(schedulePageTagRefresh);
  chrome.tabs.onUpdated.addListener((_tabId, changeInfo) => {
    if (changeInfo.url || changeInfo.title) schedulePageTagRefresh();
  });
  chrome.windows.onFocusChanged.addListener(schedulePageTagRefresh);
  $('#btn-prompts').addEventListener('click', () => {
    openPromptLibrary().catch((error) => showToast(`打开提示词库失败：${error.message}`, 'error', 4000));
  });
  $('#btn-paste-prompt').addEventListener('click', pasteCreatePrompt);
  $('#btn-save-input').addEventListener('click', startSaveCurrentPrompt);
  $('#prompt-search').addEventListener('input', (event) => {
    promptSearchTerm = event.target.value;
    renderPromptList();
  });
  document.addEventListener('paste', (event) => {
    if (!isSheetOpen('#prompt-sheet') || promptFormMode) return;
    const target = event.target;
    if (target instanceof Element && target.closest('input, textarea, [contenteditable]')) return;
    const text = event.clipboardData?.getData('text/plain');
    if (!text?.trim()) return;
    event.preventDefault();
    startNewPrompt(text, '已粘贴为新提示词；可修改后保存');
    showToast('已粘贴为新提示词');
  });
  $('#btn-prompt-save').addEventListener('click', savePromptForm);
  $('#btn-prompt-cancel').addEventListener('click', hidePromptForm);
  $('#prompt-text').addEventListener('keydown', (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
      event.preventDefault();
      savePromptForm();
    }
  });
  $('#btn-prompt-import').addEventListener('click', () => $('#prompt-import-file').click());
  $('#prompt-import-file').addEventListener('change', importPrompts);
  $('#btn-prompt-export').addEventListener('click', exportPrompts);

  $('#btn-paste').addEventListener('click', pasteFromClipboard);
  $('#btn-grab-selection').addEventListener('click', grabCurrentSelection);
  $('#btn-open-tab').addEventListener('click', openChatInTab);
  $('#btn-open-reader').addEventListener('click', openCurrentPdfReader);
  $('#btn-open-sidebar-tab').addEventListener('click', openSidebarInTab);
  $('#btn-reload-frame').addEventListener('click', () => {
    closeSheet('#settings-sheet');
    reloadFrame();
  });
  $('#btn-reset-settings').addEventListener('click', restoreDefaults);

  $('#conn').addEventListener('click', () => {
    if (bridgeReady) {
      showToast(`${providerName()} 已连接`);
    } else {
      reloadFrame();
    }
  });

  $('#frame-retry').addEventListener('click', reloadFrame);
  $('#banner-close').addEventListener('click', hideBanner);

  $$('[data-close]').forEach((element) => {
    element.addEventListener('click', () => {
      const target = element.getAttribute('data-close');
      const selector = target === 'page'
        ? '#page-sheet'
        : target === 'prompt'
          ? '#prompt-sheet'
          : target === 'page-tags'
            ? '#page-tags-sheet'
            : '#settings-sheet';
      closeSheet(selector);
    });
  });

  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    if (isSheetOpen('#page-sheet')) closeSheet('#page-sheet');
    else if (isSheetOpen('#prompt-sheet')) closeSheet('#prompt-sheet');
    else if (isSheetOpen('#page-tags-sheet')) closeSheet('#page-tags-sheet');
    else if (isSheetOpen('#settings-sheet')) closeSheet('#settings-sheet');
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !changes.settings) return;
    settings = normalizeSettings(changes.settings.newValue || {});
    applySettingsToUI();
  });
}

function setConnection(state) {
  const connection = $('#conn');
  if (!connection) return;

  connection.dataset.state = state;
  connection.classList.remove('ready', 'connecting', 'offline');
  connection.classList.add(state);
  connection.title = state === 'ready'
    ? `已连接 ${providerName()}`
    : state === 'connecting'
      ? `正在连接 ${providerName()}…`
      : `${providerName()} 连接断开，点击重新加载`;
}

function reloadFrame() {
  bridgeReady = false;
  frameLoaded = false;
  setConnection('connecting');
  showFrameLoading(`正在重新加载 ${providerName()}…`);
  hideBanner();
  clearTimeout(connectHintTimer);

  try {
    frame.src = `${CHAT_URL}?dsplus=${Date.now()}`;
    startFrameWatchdog();
  } catch (error) {
    showBanner(`重新加载失败：${error.message}`, '重试', reloadFrame, { type: 'error' });
  }
}

function startFrameWatchdog() {
  clearTimeout(frameLoadWatchdog);
  frameLoadWatchdog = setTimeout(() => {
    if (frameLoaded) return;
    const text = $('#frame-loading-text');
    if (text) text.textContent = `${providerName()} 加载较慢，请检查网络后重试。`;
    $('#frame-retry')?.classList.remove('hidden');
  }, 20000);
}

function showFrameLoading(text) {
  const overlay = $('#frame-loading');
  if (!overlay) return;
  $('#frame-loading-text').textContent = text;
  overlay.classList.remove('hidden');
  $('#frame-retry').classList.add('hidden');
}

function hideFrameLoading() {
  $('#frame-loading')?.classList.add('hidden');
}

function setReadButtonLoading(loading) {
  const button = $('#btn-read');
  if (!button) return;
  button.disabled = loading;
  button.classList.toggle('loading', loading);
}

function showBanner(text, actionLabel = '', action = null, options = {}) {
  const banner = $('#banner');
  const button = $('#banner-action');
  if (!banner) return;

  banner.classList.remove('hidden');
  banner.dataset.type = options.type || 'info';
  $('#banner-text').textContent = text;
  bannerKind = options.kind || '';

  if (actionLabel && typeof action === 'function') {
    button.textContent = actionLabel;
    button.classList.remove('hidden');
    button.onclick = () => {
      Promise.resolve(action()).catch(() => {});
    };
  } else {
    button.classList.add('hidden');
    button.onclick = null;
  }

  clearTimeout(bannerTimer);
  if (options.timeout) {
    bannerTimer = setTimeout(hideBanner, options.timeout);
  }
}

function hideBanner() {
  $('#banner')?.classList.add('hidden');
  bannerKind = '';
}

function isBannerVisible() {
  return !$('#banner')?.classList.contains('hidden');
}

function showToast(text, type = 'info', timeout = 2600) {
  const toast = $('#toast');
  if (!toast) return;

  toast.textContent = text;
  toast.className = `toast show ${type}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    toast.className = 'toast';
  }, timeout);
}

function formatChars(count) {
  if (count < 1000) return `${count} 字`;
  return `${(count / 1000).toFixed(count < 10000 ? 1 : 0)}k 字`;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/* ------------------------------------------------------------------ */
/* Test hooks (extension page only; harmless in production)           */
/* ------------------------------------------------------------------ */

window.__DS_TEST__ = {
  fillChat,
  fillSelection,
  attachPageFile,
  fillPageText,
  listOpenTabs,
  getCurrentMentionTab,
  handleMentionTab,
  readPage,
  extractAndShow,
  grabCurrentSelection,
  handleIncomingSelection,
  handleSelectionCleared,
  get settings() {
    return { ...settings };
  },
  get pageData() {
    return pageData;
  },
  get bridgeReady() {
    return bridgeReady;
  },
  get pendingSelection() {
    return pendingSelection;
  },
  get frameLoaded() {
    return frameLoaded;
  }
};
