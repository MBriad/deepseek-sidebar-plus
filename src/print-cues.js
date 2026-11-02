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

  // 超过一小时就整份用 h:mm:ss，避免同一行里出现两种写法。
  const withHours = Number(cues[cues.length - 1]?.start) >= 3600;
  const stamp = (seconds) => {
    const total = Math.max(0, Math.round(Number(seconds) || 0));
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    const pad = (n) => String(n).padStart(2, '0');
    return withHours ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
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
  const chapters = [];
  for (const cue of cues) {
    const start = Number(cue.start) || 0;
    const index = Math.floor(start / CHAPTER);
    let bucket = chapters[chapters.length - 1];
    if (!bucket || bucket.index !== index) {
      bucket = { index, start: index * CHAPTER, cues: [] };
      chapters.push(bucket);
    }
    bucket.cues.push({ start, text: String(cue.text || '') });
  }

  // 目录只在多章时才值得占一页。
  if (chapters.length >= 3) {
    const toc = el('nav', 'toc');
    toc.append(el('h2', 'toc-title', 'Contents'));
    const list = el('ol', 'toc-list');
    for (const bucket of chapters) {
      const item = el('li', 'toc-item');
      item.append(
        el('span', 'toc-time', `${stamp(bucket.start)} – ${stamp(bucket.start + CHAPTER)}`),
        el('span', 'toc-lead'),
        el('span', 'toc-count', `${bucket.cues.length} lines`)
      );
      list.append(item);
    }
    toc.append(list);
    doc.append(toc);
  }

  for (const bucket of chapters) {
    doc.append(el('h2', 'chapter', `${stamp(bucket.start)} – ${stamp(bucket.start + CHAPTER)}`));
    for (const cue of bucket.cues) {
      const row = el('div', 'cue');
      row.append(el('span', 't', stamp(cue.start)), el('span', 'x', cue.text));
      doc.append(row);
    }
  }

  document.title = title || '字幕稿';

  // 字号：先给个能看的效果，调好再点打印；选择记在本地，下次沿用。
  const bar = document.getElementById('bar');
  const sizeInput = document.getElementById('size');
  const sizeValue = document.getElementById('size-value');

  const applySize = (size) => {
    document.documentElement.style.setProperty('--base-size', `${size}pt`);
    if (sizeValue) sizeValue.textContent = `${size} pt`;
  };

  const stored = await new Promise((resolve) => {
    try {
      chrome.storage.local.get('cuesPrintSize', (data) => {
        void chrome.runtime.lastError;
        resolve(Number(data?.cuesPrintSize) || 0);
      });
    } catch {
      resolve(0);
    }
  });
  const initial = stored >= 9 && stored <= 18 ? stored : 12;
  applySize(initial);
  if (sizeInput) sizeInput.value = String(initial);
  if (bar) bar.hidden = false;

  sizeInput?.addEventListener('input', () => {
    applySize(Number(sizeInput.value) || 12);
  });
  sizeInput?.addEventListener('change', () => {
    try { chrome.storage.local.set({ cuesPrintSize: Number(sizeInput.value) || 12 }); } catch { /* 忽略 */ }
  });

  document.getElementById('print')?.addEventListener('click', () => {
    try { window.print(); } catch { /* 忽略 */ }
  });

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
})();
