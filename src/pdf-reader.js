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

  const viewer = document.getElementById('viewer');
  const overlay = document.getElementById('overlay');
  const overlayText = document.getElementById('overlay-text');
  const status = document.getElementById('status');
  const toast = document.getElementById('toast');

  let embed = null;
  let objectUrl = '';
  let lastText = '';
  let lastSelectionId = '';
  let selectionSeq = 0;
  let selectionClearTimer = null;
  let toastTimer = null;

  document.title = `${fileName} - DeepSeek PDF`;
  document.getElementById('file-name').textContent = fileName;

  document.getElementById('btn-open-side').addEventListener('click', openSidePanel);
  document.getElementById('btn-reload').addEventListener('click', () => location.reload());

  window.addEventListener('message', onPdfMessage);
  window.addEventListener('pagehide', () => {
    if (objectUrl) URL.revokeObjectURL(objectUrl);
  });

  loadPdf();

  async function loadPdf() {
    if (!fileUrl) {
      showError('缺少 PDF 地址。');
      return;
    }

    try {
      const response = await fetchWithTimeout(fileUrl, 60000);
      if (!response.ok) throw new Error(`无法下载 PDF（HTTP ${response.status}）。`);

      const length = Number(response.headers.get('content-length') || 0);
      if (length > 200 * 1024 * 1024) throw new Error('PDF 超过 200 MB。');

      const blob = await response.blob();
      if (!blob.size) throw new Error('PDF 文件为空。');
      if (blob.size > 200 * 1024 * 1024) throw new Error('PDF 超过 200 MB。');

      const head = new TextDecoder().decode(await blob.slice(0, 1024).arrayBuffer());
      if (!head.includes('%PDF')) {
        throw new Error('返回的内容不是 PDF；如果这是本地文件，请在扩展详情里允许访问文件网址。');
      }

      objectUrl = URL.createObjectURL(blob);
      embed = document.createElement('embed');
      embed.type = 'application/pdf';
      embed.src = objectUrl;
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

  function handleSelection(raw) {
    const value = raw.replace(/\u00a0/g, ' ').trim();

    if (!value) {
      lastText = '';
      if (!lastSelectionId) return;

      clearTimeout(selectionClearTimer);
      selectionClearTimer = setTimeout(() => {
        if (lastText) return;
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
