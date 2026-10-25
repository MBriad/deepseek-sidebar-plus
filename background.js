/* DeepSeek 侧边栏增强版 — background service worker */

const SIDEBAR_PATH = 'src/sidebar.html';
const MENU_SELECTION = 'ds-send-selection';
const MENU_PAGE = 'ds-read-page';
const MENU_QUOTE = 'ds-quote-selection';
const PENDING_TTL = 3 * 60 * 1000;
const MAX_SELECTION = 20000;

const DEFAULT_SETTINGS = {
  autoFillSelection: true,
  selectionMode: 'smart',
  attachPageInfo: false,
  maxPageChars: 12000,
  extractMode: 'readable',
  showPageToast: true,
  autoOpenLocalPdfReader: true
};

/* ------------------------------------------------------------------ */
/* Setup                                                               */
/* ------------------------------------------------------------------ */

chrome.runtime.onInstalled.addListener(() => {
  setupExtension();
});

chrome.runtime.onStartup.addListener(() => {
  setupExtension();
});

setupExtension();

async function setupExtension() {
  try {
    await chrome.sidePanel.setOptions({ path: SIDEBAR_PATH, enabled: true });
    await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
  } catch (error) {
    console.warn('[DS+] sidePanel setup failed:', error);
  }
  createContextMenus();
}

function createContextMenus() {
  try {
    chrome.contextMenus.removeAll(() => {
      const lastError = chrome.runtime.lastError;
      if (lastError) {
        // Ignore races during startup.
      }
      chrome.contextMenus.create({
        id: MENU_SELECTION,
        title: '发送选中文字到 DeepSeek 侧边栏',
        contexts: ['selection']
      });
      chrome.contextMenus.create({
        id: MENU_PAGE,
        title: '读取本页正文到 DeepSeek',
        contexts: ['page', 'frame']
      });
      chrome.contextMenus.create({
        id: MENU_QUOTE,
        title: '引用到 DeepSeek 输入框',
        contexts: ['selection'],
        documentUrlPatterns: ['*://chat.deepseek.com/*']
      });
    });
  } catch (error) {
    console.warn('[DS+] context menu setup failed:', error);
  }
}

chrome.action.onClicked.addListener((tab) => {
  if (!tab?.windowId) return;

  const openFallback = () => {
    chrome.tabs.create({ url: chrome.runtime.getURL(SIDEBAR_PATH) }).catch((error) => {
      console.warn('[DS+] open sidebar tab failed:', error);
    });
  };

  if (!chrome.sidePanel?.open) {
    openFallback();
    return;
  }

  chrome.sidePanel.open({ windowId: tab.windowId }).catch((error) => {
    console.warn('[DS+] open side panel failed:', error);
    openFallback();
  });
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (!tab?.id) return;

  if (info.menuItemId === MENU_SELECTION) {
    const text = String(info.selectionText || '').trim().slice(0, MAX_SELECTION);
    if (!text) return;

    // Open synchronously within the user gesture; do not await other work first.
    openSidePanel(tab.windowId);
    const selection = {
      text,
      title: tab.title || '',
      url: tab.url || '',
      windowId: tab.windowId,
      ts: Date.now(),
      source: 'context-menu'
    };
    storePendingSelection(selection)
      .then(() => forwardToSidePanel({ type: 'DS_PENDING_SELECTION', selection }))
      .catch((error) => console.warn('[DS+] selection menu failed:', error));
    return;
  }

  if (info.menuItemId === MENU_QUOTE) {
    const text = String(info.selectionText || '').trim().slice(0, MAX_SELECTION);
    if (!text) return;
    forwardToSidePanel({ type: 'DS_QUOTE_TEXT', text })
      .catch((error) => console.warn('[DS+] quote menu failed:', error));
    return;
  }

  if (info.menuItemId === MENU_PAGE) {
    openSidePanel(tab.windowId);
    (async () => {
      const settings = await loadSettings();
      const result = await extractFromTab(tab.id, 50000, settings.extractMode);
      if (result.ok) {
        const pendingPage = { ...result, windowId: tab.windowId, ts: Date.now() };
        await chrome.storage.session.set({ pendingPage });
        await forwardToSidePanel({ type: 'DS_PENDING_PAGE', page: pendingPage });
      } else {
        await forwardToSidePanel({
          type: 'DS_NOTICE',
          level: 'error',
          message: result.error || '读取网页失败。',
          windowId: tab.windowId
        });
      }
    })().catch((error) => console.warn('[DS+] page menu failed:', error));
  }
});

async function openSidePanel(windowId) {
  if (!windowId) return false;

  if (!chrome.sidePanel?.open) {
    try {
      await chrome.tabs.create({ url: chrome.runtime.getURL(SIDEBAR_PATH) });
      return true;
    } catch (error) {
      console.warn('[DS+] open sidebar tab failed:', error);
      return false;
    }
  }

  try {
    await chrome.sidePanel.open({ windowId });
    return true;
  } catch (error) {
    console.warn('[DS+] sidePanel.open failed:', error);
    try {
      await chrome.tabs.create({ url: chrome.runtime.getURL(SIDEBAR_PATH) });
      return true;
    } catch (fallbackError) {
      console.warn('[DS+] open sidebar tab failed:', fallbackError);
      return false;
    }
  }
}

/* ------------------------------------------------------------------ */
/* Runtime messages                                                    */
/* ------------------------------------------------------------------ */

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || typeof message !== 'object') return;

  switch (message.type) {
    case 'DS_PAGE_SELECTION':
      handlePageSelection(message, sender)
        .then(sendResponse)
        .catch((error) => {
          console.warn('[DS+] selection handling failed:', error);
          sendResponse({ ok: false, stored: false, delivered: false });
        });
      return true;

    case 'DS_PAGE_SELECTION_CLEARED':
      handlePageSelectionCleared(message, sender)
        .then(sendResponse)
        .catch((error) => sendResponse({ ok: false, error: error.message }));
      return true;

    case 'DS_GET_PENDING':
      consumePending()
        .then(sendResponse)
        .catch((error) => sendResponse({ error: error.message }));
      return true;

    case 'DS_EXTRACT_ACTIVE_PAGE':
      extractActivePage(message)
        .then(sendResponse)
        .catch((error) => sendResponse({ ok: false, error: error.message }));
      return true;

    case 'DS_GET_ACTIVE_SELECTION':
      getActiveSelection()
        .then(sendResponse)
        .catch((error) => sendResponse({ ok: false, error: error.message }));
      return true;

    case 'DS_GET_ACTIVE_TAB':
      getActiveTab()
        .then((tab) => sendResponse({ ok: Boolean(tab), tab: publicTab(tab) }))
        .catch((error) => sendResponse({ ok: false, error: error.message }));
      return true;

    default:
      return;
  }
});

async function handlePageSelection(message, sender) {
  const raw = String(message.text || '').trim();
  if (!raw) return { ok: true, stored: false, delivered: false };

  const selection = {
    text: raw.slice(0, MAX_SELECTION),
    truncated: raw.length > MAX_SELECTION,
    selectionId: String(message.selectionId || ''),
    title: String(message.title || sender.tab?.title || ''),
    url: String(message.url || sender.tab?.url || ''),
    windowId: sender.tab?.windowId,
    ts: Number(message.ts) || Date.now(),
    source: 'page'
  };

  await storePendingSelection(selection);
  const delivered = await forwardToSidePanel({ type: 'DS_PENDING_SELECTION', selection });
  return { ok: true, stored: true, delivered };
}

async function handlePageSelectionCleared(message, sender) {
  const selectionId = String(message.selectionId || '');
  const stored = await chrome.storage.session.get('pendingSelection');

  if (
    stored.pendingSelection &&
    (!selectionId || !stored.pendingSelection.selectionId || stored.pendingSelection.selectionId === selectionId)
  ) {
    await chrome.storage.session.remove('pendingSelection');
  }

  const delivered = await forwardToSidePanel({
    type: 'DS_PENDING_SELECTION_CLEARED',
    selectionId,
    url: message.url || sender.tab?.url || ''
  });

  return { ok: true, delivered };
}

async function storePendingSelection(selection) {
  await chrome.storage.session.set({ pendingSelection: selection });
}

async function consumePending() {
  const stored = await chrome.storage.session.get(['pendingSelection', 'pendingPage']);
  const now = Date.now();
  const result = {};

  if (stored.pendingSelection && now - Number(stored.pendingSelection.ts || 0) < PENDING_TTL) {
    result.selection = stored.pendingSelection;
  }
  if (stored.pendingPage && now - Number(stored.pendingPage.ts || 0) < PENDING_TTL) {
    result.page = stored.pendingPage;
  }

  await chrome.storage.session.remove(['pendingSelection', 'pendingPage']);
  return result;
}

/**
 * Sends a message to every open side panel. Resolves to true when at least one
 * side panel received it and acknowledged with an object where ok !== false.
 */
function forwardToSidePanel(payload) {
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage(payload, (response) => {
        if (chrome.runtime.lastError) {
          resolve(false);
          return;
        }
        resolve(response?.ok !== false);
      });
    } catch {
      resolve(false);
    }
  });
}

async function extractActivePage(message) {
  const tab = message?.tabId ? await chrome.tabs.get(Number(message.tabId)).catch(() => null) : await getActiveTab();
  if (!tab?.id) {
    return { ok: false, code: 'no-tab', error: '没有找到当前标签页。' };
  }
  const settings = await loadSettings();
  const maxChars = clampNumber(message?.maxChars, 1000, 50000, settings.maxPageChars);
  const mode = message?.mode === 'full' ? 'full' : settings.extractMode;
  return extractFromTab(tab.id, maxChars, mode, tab);
}

async function extractFromTab(tabId, maxChars = 12000, mode = 'readable', knownTab = null) {
  const tab = knownTab || (await chrome.tabs.get(tabId).catch(() => null));
  if (!tab) {
    return { ok: false, code: 'no-tab', error: '找不到这个标签页，可能已经关闭。' };
  }

  const url = String(tab.url || '');
  if (isPdfUrl(url)) {
    return {
      ok: true,
      pdf: true,
      pdfUrl: url,
      title: pdfNameFromUrl(url),
      tab: publicTab(tab)
    };
  }
  if (isRestrictedUrl(url)) {
    return {
      ok: false,
      code: 'restricted',
      error: '浏览器内部页面或扩展商店不允许读取，请切换到普通网页后重试。'
    };
  }

  const request = { type: 'DS_EXTRACT_PAGE', maxChars, mode };

  try {
    const response = await sendTabMessage(tab.id, request, 9000);
    if (response?.ok) {
      return { ok: true, page: normalizePage(response, tab), tab: publicTab(tab) };
    }
    const pdf = pdfResultFromResponse(response, tab);
    if (pdf) return pdf;
  } catch {
    // Content script may be missing on tabs opened before the extension was
    // installed. Fall through to an explicit injection below.
  }

  try {
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ['src/content/page-tools.js']
    });
    const response = await sendTabMessage(tab.id, request, 9000);
    if (response?.ok) {
      return { ok: true, page: normalizePage(response, tab), tab: publicTab(tab) };
    }
    const pdf = pdfResultFromResponse(response, tab);
    if (pdf) return pdf;
    return { ok: false, code: 'extract-failed', error: response?.error || '没有提取到网页正文。' };
  } catch (error) {
    return {
      ok: false,
      code: 'inject-failed',
      error: `无法读取此页面：${error.message || '站点不允许注入脚本'}`
    };
  }
}

async function getActiveSelection() {
  const tab = await getActiveTab();
  if (!tab?.id) return { ok: false, error: '没有找到当前标签页。' };
  if (isRestrictedUrl(tab.url || '')) {
    return { ok: false, code: 'restricted', error: '当前页面不允许读取选中文字。' };
  }

  const request = { type: 'DS_GET_SELECTION' };
  try {
    const response = await sendTabMessage(tab.id, request, 5000);
    if (response?.ok) {
      return {
        ok: true,
        text: response.text || '',
        title: response.title || tab.title || '',
        url: response.url || tab.url || ''
      };
    }
  } catch {
    // Try injecting the helper on demand.
  }

  try {
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ['src/content/page-tools.js']
    });
    const response = await sendTabMessage(tab.id, request, 5000);
    return {
      ok: true,
      text: response?.text || '',
      title: response?.title || tab.title || '',
      url: response?.url || tab.url || ''
    };
  } catch (error) {
    return { ok: false, code: 'inject-failed', error: error.message || '无法读取选中文字。' };
  }
}

function sendTabMessage(tabId, message, timeout = 8000) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error('页面响应超时'));
    }, timeout);

    try {
      chrome.tabs.sendMessage(tabId, message, (response) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        const error = chrome.runtime.lastError;
        if (error) reject(new Error(error.message));
        else resolve(response);
      });
    } catch (error) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    }
  });
}

async function getActiveTab() {
  try {
    const win = await chrome.windows.getLastFocused({ windowTypes: ['normal'] });
    if (win?.id != null) {
      const [tab] = await chrome.tabs.query({ active: true, windowId: win.id });
      if (tab) return tab;
    }
  } catch {
    // Fall back below.
  }
  try {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    return tab || null;
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

function pdfResultFromResponse(response, tab) {
  if (!response || response.code !== 'pdf-tab' || !response.pdfUrl) return null;
  return {
    ok: true,
    pdf: true,
    pdfUrl: response.pdfUrl,
    title: response.title || pdfNameFromUrl(response.pdfUrl),
    tab: publicTab(tab)
  };
}

function normalizePage(raw, tab) {
  return {
    ok: true,
    title: String(raw.title || tab.title || ''),
    url: String(raw.url || tab.url || ''),
    siteName: String(raw.siteName || ''),
    description: String(raw.description || ''),
    author: String(raw.author || ''),
    published: String(raw.published || ''),
    text: String(raw.text || ''),
    charCount: Number(raw.charCount || raw.text?.length || 0),
    totalCharCount: Number(raw.totalCharCount || raw.charCount || raw.text?.length || 0),
    truncated: Boolean(raw.truncated),
    mode: raw.mode || 'readable',
    warning: String(raw.warning || ''),
    extractedAt: Date.now()
  };
}

function publicTab(tab) {
  if (!tab) return null;
  return {
    id: tab.id,
    windowId: tab.windowId,
    title: tab.title || '',
    url: tab.url || '',
    favIconUrl: tab.favIconUrl || ''
  };
}

function isPdfUrl(url) {
  if (!url) return false;
  return /^(https?|file):/i.test(url) && /\.pdf(?:$|[?#])/i.test(url);
}

function pdfNameFromUrl(url) {
  try {
    const parsed = new URL(url);
    const name = decodeURIComponent(parsed.pathname.split('/').filter(Boolean).pop() || '');
    return name || 'PDF 文档';
  } catch {
    return 'PDF 文档';
  }
}

function isRestrictedUrl(url) {
  if (!url) return false;
  return (
    /^(chrome|edge|about|devtools|view-source|chrome-extension|extension):/i.test(url) ||
    url.startsWith('https://chromewebstore.google.com') ||
    url.startsWith('https://chrome.google.com/webstore') ||
    url.startsWith('https://microsoftedge.microsoft.com/addons')
  );
}

function clampNumber(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, Math.round(number)));
}

async function loadSettings() {
  try {
    const stored = await chrome.storage.local.get('settings');
    return { ...DEFAULT_SETTINGS, ...(stored.settings || {}) };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}
