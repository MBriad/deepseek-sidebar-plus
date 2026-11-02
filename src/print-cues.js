/* 字幕稿的打印窗口：侧边栏给数据 → 在这里排版 → 调打印 → 自己关掉。
 * 侧边栏面板本身调不起浏览器打印（Edge 会忽略），所以和「导出对话」一样走独立窗口。
 * 数据只在内存里过一手，不写 storage。 */
(async () => {
  const response = await new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage({ type: 'DS_GET_CUES_PAYLOAD' }, (reply) => {
        void chrome.runtime.lastError;
        resolve(reply);
      });
    } catch {
      resolve(null);
    }
  });

  const doc = document.getElementById('doc');
  if (!response?.ok || !response.payload) {
    doc.innerHTML = '<p class="empty">没有可打印的字幕。请回到侧边栏，重新读一页视频再点「生成 PDF」。</p>';
    return;
  }

  const { title, url, platform, cues } = response.payload;

  const stamp = (seconds) => {
    const total = Math.max(0, Math.round(Number(seconds) || 0));
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    const pad = (n) => String(n).padStart(2, '0');
    return h ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
  };

  const el = (tag, className, text) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  };

  const cover = el('header', 'cover');
  cover.append(
    el('p', 'eyebrow', 'Video transcript'),
    el('h1', '', title || 'Video transcript')
  );
  const meta = el('p', 'meta');
  const parts = [platform, stamp(cues[cues.length - 1]?.start), `${cues.length} lines`].filter(Boolean);
  meta.append(el('strong', '', parts.shift() || ''));
  if (parts.length) meta.append(document.createTextNode(` · ${parts.join(' · ')}`));
  cover.append(meta);
  if (url) cover.append(el('p', 'meta', url));
  doc.append(cover);

  // 没有语义章节可用，就按 5 分钟切段，至少让长视频有节奏。
  const CHAPTER = 300;
  let currentChapter = -1;
  for (const cue of cues) {
    const start = Number(cue.start) || 0;
    const chapter = Math.floor(start / CHAPTER);
    if (chapter !== currentChapter) {
      currentChapter = chapter;
      doc.append(el('h2', 'chapter', `${stamp(chapter * CHAPTER)} – ${stamp((chapter + 1) * CHAPTER)}`));
    }
    const row = el('div', 'cue');
    row.append(el('span', 't', stamp(start)), el('span', 'x', String(cue.text || '')));
    doc.append(row);
  }

  document.title = title || '字幕稿';

  const closeSelf = () => {
    try {
      chrome.windows.getCurrent((win) => {
        if (win?.id) chrome.windows.remove(win.id);
        else window.close();
      });
    } catch {
      try { window.close(); } catch { /* 忽略 */ }
    }
  };
  window.addEventListener('afterprint', () => setTimeout(closeSelf, 400), { once: true });

  setTimeout(() => {
    try { window.print(); } catch { /* 忽略 */ }
  }, 120);
})();
