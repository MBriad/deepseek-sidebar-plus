/* 打印窗口:侧边栏不能直接调打印,所以由这个独立窗口负责"渲染 + 打印 + 自己关闭"。
 *
 * 数据由侧边栏通过 runtime 消息给出(只在内存里),不落盘。
 */
(async () => {
  const response = await askSidebar();
  if (!response?.ok || !response.payload) {
    document.title = '没有可导出的对话';
    document.body.textContent = '没有可导出的对话,请回到侧边栏重新点击「导出 PDF」。';
    return;
  }

  const root = document.getElementById('print-doc');
  const payload = response.payload;
  const options = response.options || {};

  try {
    window.DSPrintDoc.render(root, payload, options);
  } catch (error) {
    document.body.textContent = `生成打印文档失败:${error?.message || error}`;
    return;
  }

  const title = payload.title || '对话';
  document.title = payload.provider && payload.provider !== title ? `${title} - ${payload.provider}` : title;

  // 打印完成(或取消)后自动关掉这个窗口,不给用户留一个常驻标签页。
  const closeSelf = () => {
    try {
      chrome.windows.getCurrent((win) => {
        if (win?.id) chrome.windows.remove(win.id);
        else window.close();
      });
    } catch {
      try {
        window.close();
      } catch {
        // Ignore.
      }
    }
  };
  window.addEventListener('afterprint', () => setTimeout(closeSelf, 400), { once: true });

  // 打印前把图片都等到位:远程图(CDN/带 cookie)常常 300ms 内还没加载完,
  // 直接打印会印出 alt 文本。先尝试用本窗口重新抓一次,再等 decode。
  await hydrateImages(root);
  await waitForImages(root, 5000);

  // 等一帧让排版生效,再调打印。
  setTimeout(() => {
    try {
      window.print();
    } catch {
      // 打印失败时窗口保持打开,用户可以手动 Ctrl+P。
    }
  }, 300);
})();

// 远程图片在扩展页里可能因为 cookie/Referer 加载失败;用 fetch 重取一次换成 blob URL。
async function hydrateImages(root) {
  const images = Array.from(root.querySelectorAll('img')).filter((img) => !img.src.startsWith('data:'));
  await Promise.all(
    images.map(async (img) => {
      try {
        const response = await fetch(img.src, { credentials: 'include' });
        if (!response.ok) return;
        const blob = await response.blob();
        if (!blob.type.startsWith('image/')) return;
        img.src = URL.createObjectURL(blob);
      } catch {
        // 保持原链接,让浏览器再试一次。
      }
    })
  );
}

async function waitForImages(root, timeoutMs) {
  const images = Array.from(root.querySelectorAll('img'));
  await Promise.all(
    images.map((img) => {
      const ready = img.complete && img.naturalWidth > 0 ? Promise.resolve() : img.decode?.().catch(() => {}) || Promise.resolve();
      return Promise.race([ready, sleep(timeoutMs)]);
    })
  );
}

function askSidebar() {
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage({ type: 'DS_GET_PRINT_PAYLOAD' }, (response) => {
        void chrome.runtime.lastError;
        resolve(response || null);
      });
    } catch {
      resolve(null);
    }
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
