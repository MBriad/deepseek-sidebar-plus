import * as pdfjsLib from './vendor/pdfjs/build/pdf.mjs';

const params = new URLSearchParams(location.search);
const fileUrl = params.get('file') || '';
// 100% 的定义按打印行业来：1 PDF 点 = 1/72 英寸，CSS 像素 = 1/96 英寸，
// 所以 1 点 = 96/72 = 4/3 像素（A4 宽 595 点 → 794 CSS px，和 Chrome 内置阅读器一致）。
// 浏览器缩放按 origin 生效，扩展页和侧边栏同源，所以缩放必须自己做。
const CSS_PX_PER_POINT = 96 / 72;
const MIN_ZOOM = 0.5;
const MAX_ZOOM = 4;
let zoom = Number(params.get('zoom')) || 1;
let scale = zoom * CSS_PX_PER_POINT;
const initialPage = Math.max(1, Number(params.get('page')) || 1);
const docKey = params.get('doc') || '';
const POSITIONS_KEY = 'pdfReadingPositions';
const MAX_POSITIONS = 80;
let persistTimer = null;
// 由宿主传进来的页码是"上次读到第几页";这里只负责在滚动/点目录时把当前位置写回去。
let schedulePersist = () => {};

pdfjsLib.GlobalWorkerOptions.workerSrc = chrome.runtime.getURL('src/vendor/pdfjs/build/pdf.worker.mjs');

const viewer = document.getElementById('pdfjs-viewer');
const scrollContainer = document.getElementById('pdfjs-container');
let selectionReportTimer = null;
let requestPageRender = () => {};
let highlightElements = [];

function clearSelectionHighlight() {
  for (const element of highlightElements) element.remove();
  highlightElements = [];
}

function mergeSelectionRects(rects) {
  const list = rects
    .filter((rect) => rect && rect.width > 1 && rect.height > 1)
    .map((rect) => ({
      left: rect.left,
      top: rect.top,
      right: rect.right,
      bottom: rect.bottom,
      width: rect.width,
      height: rect.height
    }))
    .sort((a, b) => a.top - b.top || a.left - b.left);

  const merged = [];
  for (const rect of list) {
    const target = merged.find((item) => {
      const overlap = Math.min(item.bottom, rect.bottom) - Math.max(item.top, rect.top);
      // Merge every fragment on the same visual line, including large gaps
      // introduced by justified text / PDF.js span positioning. A native
      // selection paints the whole line; the custom overlay should too.
      return overlap >= Math.min(item.height, rect.height) * 0.6;
    });
    if (!target) {
      merged.push(rect);
      continue;
    }
    target.left = Math.min(target.left, rect.left);
    target.top = Math.min(target.top, rect.top);
    target.right = Math.max(target.right, rect.right);
    target.bottom = Math.max(target.bottom, rect.bottom);
    target.width = target.right - target.left;
    target.height = target.bottom - target.top;
  }
  return merged;
}

function paintSelectionHighlight(rects) {
  clearSelectionHighlight();
  const viewerRect = viewer.getBoundingClientRect();
  for (const rect of mergeSelectionRects(rects)) {
    const element = document.createElement('div');
    element.className = 'ds-pdf-selection-highlight';
    element.style.cssText = [
      'position:absolute',
      `left:${rect.left - viewerRect.left}px`,
      `top:${rect.top - viewerRect.top}px`,
      `width:${rect.width}px`,
      `height:${rect.height}px`,
      'background:rgba(77,107,254,.22)',
      'border-radius:2px',
      'pointer-events:none',
      'z-index:2147483000'
    ].join(';');
    viewer.appendChild(element);
    highlightElements.push(element);
  }
}

function scrollToPdfPage(pageNumber) {
  const page = viewer.querySelector(`.pdfjs-page[data-page-number="${pageNumber}"]`);
  if (!page) return;
  // 按两者顶边的实际差值滚动：容器有内边距、页面有外边距时，
  // scrollIntoView 的 block:'start' 会差出十几像素，看起来就像跳歪了。
  const delta = page.getBoundingClientRect().top - scrollContainer.getBoundingClientRect().top;
  scrollContainer.scrollTop += delta;
  requestPageRender(pageNumber);
  setTimeout(() => requestPageRender(pageNumber), 250);
  setTimeout(() => requestPageRender(pageNumber), 800);
}

function reportSelectionToParent() {
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed || !selection.rangeCount) return;
  const text = selection.toString().replace(/\u00a0/g, ' ').trim();
  if (!text) {
    clearSelectionHighlight();
    window.parent.postMessage({ source: 'ds-pdf-viewer', type: 'selection-clear' }, '*');
    return;
  }

  const range = selection.getRangeAt(0);
  const rects = Array.from(range.getClientRects()).filter((rect) => rect.width || rect.height);
  const rect = rects[rects.length - 1] || range.getBoundingClientRect();
  if (rect && (rect.width || rect.height)) {
    window.parent.postMessage({
      source: 'ds-pdf-viewer',
      type: 'selection',
      text,
      rect: {
        left: rect.left,
        top: rect.top,
        right: rect.right,
        bottom: rect.bottom,
        width: rect.width,
        height: rect.height
      }
    }, '*');
  } else {
    window.parent.postMessage({ source: 'ds-pdf-viewer', type: 'selection', text }, '*');
  }

  // Keep the browser/PDF.js native selection visible. It is the most accurate
  // highlight (including spaces and justified text), and custom fixed/absolute
  // overlays looked broken on some pages. Clear it only when relay stops.
}

document.addEventListener('pointerdown', clearSelectionHighlight, true);
document.addEventListener('pointerup', () => {
  clearTimeout(selectionReportTimer);
  selectionReportTimer = setTimeout(reportSelectionToParent, 20);
}, true);


window.addEventListener('message', (event) => {
  if (event.data?.source !== 'ds-pdf-host') return;
  if (event.data?.type === 'toggle-outline') {
    const outline = document.getElementById('pdfjs-outline');
    if (outline) {
      const next = !outline.classList.contains('open');
      outline.classList.toggle('open', next);
      const toggle = document.getElementById('pdfjs-outline-toggle');
      if (toggle) toggle.hidden = next;
    }
  } else if (event.data?.type === 'clear-highlight') {
    clearSelectionHighlight();
  }
});

try {
  const task = pdfjsLib.getDocument({
    url: fileUrl,
    cMapUrl: chrome.runtime.getURL('src/vendor/pdfjs/cmaps/'),
    cMapPacked: true,
    standardFontDataUrl: chrome.runtime.getURL('src/vendor/pdfjs/standard_fonts/'),
    wasmUrl: chrome.runtime.getURL('src/vendor/pdfjs/wasm/')
  });
  const pdfDocument = await task.promise;

  const firstPage = await pdfDocument.getPage(1);
  const pageElements = new Map();
  const renderedPages = new Set();
  const renderingPages = new Set();

  // Create page placeholders immediately. Large PDFs (hundreds of pages) were
  // previously blocked until every canvas and text layer finished rendering.
  const buildPages = () => {
    const pageViewport = firstPage.getViewport({ scale });
    for (let number = 1; number <= pdfDocument.numPages; number += 1) {
      const pageElement = document.createElement('div');
      pageElement.className = 'pdfjs-page';
      pageElement.dataset.pageNumber = String(number);
      pageElement.style.width = `${Math.floor(pageViewport.width)}px`;
      pageElement.style.height = `${Math.floor(pageViewport.height)}px`;
      pageElement.style.setProperty('--scale-factor', String(pageViewport.scale));
      pageElement.style.setProperty('--total-scale-factor', String(pageViewport.scale));
      pageElement.style.setProperty('--user-unit', '1');
      viewer.appendChild(pageElement);
      pageElements.set(number, pageElement);
    }
  };
  buildPages();

  async function renderPage(number) {
    if (renderedPages.has(number) || renderingPages.has(number)) return;
    renderingPages.add(number);
    const pageElement = pageElements.get(number);
    if (!pageElement) return;

    try {
      const page = number === 1 ? firstPage : await pdfDocument.getPage(number);
      const viewport = page.getViewport({ scale });
      pageElement.style.width = `${Math.floor(viewport.width)}px`;
      pageElement.style.height = `${Math.floor(viewport.height)}px`;
      pageElement.style.setProperty('--scale-factor', String(viewport.scale));
      pageElement.style.setProperty('--total-scale-factor', String(viewport.scale));

      const canvas = document.createElement('canvas');
      const context = canvas.getContext('2d', { alpha: false });
      // 按设备像素比渲染，否则 125%/150% 缩放的屏幕上会被拉伸成糊的。
      // 上限 2：再高的 DPR 收益很小，内存和渲染时间翻倍。
      const outputScale = Math.min(Math.max(window.devicePixelRatio || 1, 1), 2);
      canvas.width = Math.floor(viewport.width * outputScale);
      canvas.height = Math.floor(viewport.height * outputScale);
      canvas.style.width = `${Math.floor(viewport.width)}px`;
      canvas.style.height = `${Math.floor(viewport.height)}px`;
      pageElement.appendChild(canvas);

      const textLayerElement = document.createElement('div');
      textLayerElement.className = 'textLayer';
      textLayerElement.style.width = `${Math.floor(viewport.width)}px`;
      textLayerElement.style.height = `${Math.floor(viewport.height)}px`;
      textLayerElement.style.setProperty('--scale-factor', String(viewport.scale));
      textLayerElement.style.setProperty('--total-scale-factor', String(viewport.scale));
      textLayerElement.style.setProperty('--user-unit', '1');
      pageElement.appendChild(textLayerElement);

      const transform = outputScale === 1 ? null : [outputScale, 0, 0, outputScale, 0, 0];
      await page.render({ canvasContext: context, viewport, transform }).promise;

      const textLayer = new pdfjsLib.TextLayer({
        textContentSource: page.streamTextContent(),
        container: textLayerElement,
        viewport
      });
      await textLayer.render();
      renderedPages.add(number);
    } finally {
      renderingPages.delete(number);
    }
  }

  requestPageRender = (number) => {
    renderPage(number).catch(() => {});
  };
  window.__dsPdfRenderPage = requestPageRender;

  const observer = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      const number = Number(entry.target.dataset.pageNumber);
      if (number) renderPage(number).catch(() => {});
    }
  }, {
    root: scrollContainer,
    rootMargin: '1400px 0px'
  });

  for (const pageElement of pageElements.values()) observer.observe(pageElement);

  // 缩放后要回到原处：记「哪一页 + 页内比例」，不能拿 scrollTop / 页高当页码——
  // 滚动偏移里混着顶部内边距和页间距，它们不随缩放变化，比例会一步步漂，
  // 连缩几次就跳到相邻页去了。
  function anchorAtViewportTop() {
    const containerTop = scrollContainer.getBoundingClientRect().top;
    let last = { page: 1, ratio: 0 };
    for (const [number, element] of pageElements) {
      const rect = element.getBoundingClientRect();
      if (rect.bottom <= containerTop) {
        last = { page: number, ratio: 0 };
        continue;
      }
      const height = rect.height || 1;
      return { page: number, ratio: Math.min(1, Math.max(0, (containerTop - rect.top) / height)) };
    }
    return last;
  }

  // 缩放：自己重排重渲染。入参是用户看到的百分比（1 = 100%）。
  function applyScale(nextZoom) {
    const target = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, Number(nextZoom) || 1));
    if (Math.abs(target - zoom) < 0.005) return;

    const anchor = anchorAtViewportTop();

    zoom = target;
    scale = zoom * CSS_PX_PER_POINT;
    renderedPages.clear();
    renderingPages.clear();
    for (const element of pageElements.values()) element.remove();
    pageElements.clear();
    buildPages();
    for (const element of pageElements.values()) observer.observe(element);

    const targetPage = pageElements.get(anchor.page);
    if (targetPage) {
      // offsetTop 是相对 #pdfjs-viewer 的，直接就是容器里的滚动坐标。
      scrollContainer.scrollTop = targetPage.offsetTop + anchor.ratio * (targetPage.offsetHeight || 0);
    }
    renderPage(anchor.page).catch(() => {});

    // 让宿主更新工具栏上的百分比，并记进 URL
    try {
      window.parent.postMessage({ source: 'ds-pdf-viewer', type: 'zoom', zoom }, '*');
    } catch {
      // Ignore.
    }
  }

  // Ctrl+滚轮一秒能来十几次。每次 applyScale 都要拆掉重建全部页面元素，
  // 挨个处理会把布局撕开、锚点量到正在被替换的节点，看起来就是"跳页"。
  // 所以只在最后一次停下时重排一次。
  let pendingZoom = null;
  let zoomTimer = null;
  function requestZoom(next) {
    pendingZoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, Number(next) || 1));
    if (zoomTimer) return;
    zoomTimer = setTimeout(() => {
      zoomTimer = null;
      const target = pendingZoom;
      pendingZoom = null;
      if (target != null) applyScale(target);
    }, 140);
  }

  // Ctrl+滚轮只缩放 PDF，不让浏览器缩放整个扩展 origin（那会把侧边栏一起放大）。
  window.addEventListener('wheel', (event) => {
    if (!event.ctrlKey) return;
    event.preventDefault();
    requestZoom((pendingZoom ?? zoom) * (event.deltaY < 0 ? 1.1 : 1 / 1.1));
  }, { passive: false });

  // 宿主工具栏的 +/- 走这里；截图也走同一根通道
  window.addEventListener('message', async (event) => {
    if (event.data?.source !== 'ds-pdf-host') return;
    if (event.data.type === 'set-zoom') {
      requestZoom(event.data.zoom);
      return;
    }
    if (event.data.type === 'capture-page') {
      try {
        const shot = await capturePage(anchorAtViewportTop().page);
        window.parent.postMessage({ source: 'ds-pdf-viewer', type: 'page-image', page: shot.page, blob: shot.blob }, '*');
      } catch (error) {
        window.parent.postMessage({
          source: 'ds-pdf-viewer',
          type: 'page-image',
          error: String(error?.message || error)
        }, '*');
      }
    }
  });

  // 整页按 2× 重新渲染：和当前缩放无关，字号和线条都是重绘的，不是屏幕截图。
  async function capturePage(pageNumber) {
    const number = Math.min(pdfDocument.numPages, Math.max(1, Number(pageNumber) || 1));
    const page = number === 1 ? firstPage : await pdfDocument.getPage(number);
    const viewport = page.getViewport({ scale: 2 });
    const canvas = document.createElement('canvas');
    canvas.width = Math.floor(viewport.width);
    canvas.height = Math.floor(viewport.height);
    const context = canvas.getContext('2d', { alpha: false });
    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvasContext: context, viewport }).promise;
    const blob = await new Promise((resolve) => canvas.toBlob((value) => resolve(value), 'image/png'));
    if (!blob) throw new Error('生成 PNG 失败');
    return { page: number, blob };
  }

  // 记住读到第几页。以"容器顶部上沿落在哪一页"为准,不存像素偏移——
  // 换窗口宽度或缩放比例时,像素值会指向完全不同的地方。
  if (docKey) {
    const currentPageNumber = () => {
      // 以"哪一页在视口里露得最多"为准,而不是"上沿落在哪一页"——
      // scrollIntoView 之后上沿常常还差几十像素,按上沿判断会记成上一页。
      const container = scrollContainer.getBoundingClientRect();
      let current = 1;
      let bestVisible = -1;
      for (const [number, element] of pageElements) {
        const rect = element.getBoundingClientRect();
        if (rect.bottom <= container.top) continue;
        if (rect.top >= container.bottom) break;
        const visible = Math.min(rect.bottom, container.bottom) - Math.max(rect.top, container.top);
        if (visible > bestVisible) {
          bestVisible = visible;
          current = number;
        }
      }
      return current;
    };

    const persistPosition = () => {
      // pagehide 时布局已经塌成 0,这时量出来的页码是假的 —— 宁可不写,
      // 也不能用一个错误的 1 去覆盖用户真实读到的位置。
      if (!scrollContainer.getBoundingClientRect().height) return;
      const page = currentPageNumber();
      chrome.storage.local.get(POSITIONS_KEY).then((stored) => {
        const map = stored?.[POSITIONS_KEY] && typeof stored[POSITIONS_KEY] === 'object'
          ? stored[POSITIONS_KEY]
          : {};
        map[docKey] = { page, ts: Date.now() };
        const kept = Object.entries(map)
          .sort((a, b) => Number(b[1]?.ts || 0) - Number(a[1]?.ts || 0))
          .slice(0, MAX_POSITIONS);
        return chrome.storage.local.set({ [POSITIONS_KEY]: Object.fromEntries(kept) });
      }).catch(() => {});
    };

    schedulePersist = () => {
      clearTimeout(persistTimer);
      persistTimer = setTimeout(persistPosition, 400);
    };
    scrollContainer.addEventListener('scroll', schedulePersist, { passive: true });
    window.addEventListener('pagehide', persistPosition);
    // 打开就用上次的位置,顺便立刻记一次,免得"只读了一页就关掉"什么都不剩。
    schedulePersist();
  }

  // Build the directory before canvases/text layers; it is independent of page
  // rendering and should be available almost immediately.
  const outlineReady = renderOutline(pdfDocument);

  if (initialPage > 1) {
    requestAnimationFrame(() => scrollToPdfPage(initialPage));
  }

  await outlineReady;
  document.documentElement.dataset.pdfjsReady = '1';
} catch (error) {
  document.documentElement.dataset.pdfjsError = String(error?.message || error);
  throw error;
}

async function resolvePageNumber(pdfDocument, destination) {
  try {
    const explicit = typeof destination === 'string'
      ? await pdfDocument.getDestination(destination)
      : destination;
    if (!Array.isArray(explicit) || !explicit.length) return null;
    const reference = explicit[0];
    if (typeof reference === 'number') return reference + 1;
    if (reference && typeof reference === 'object') {
      return (await pdfDocument.getPageIndex(reference)) + 1;
    }
  } catch {
    // Some named destinations cannot be resolved.
  }
  return null;
}

async function renderOutline(pdfDocument) {
  const outline = await pdfDocument.getOutline().catch(() => null);

  const toggle = document.getElementById('pdfjs-outline-toggle');
  const panel = document.getElementById('pdfjs-outline');
  const list = document.getElementById('pdfjs-outline-list');
  toggle.hidden = false;
  const setOutlineOpen = (open) => {
    panel.classList.toggle('open', open);
    // 目录占位时把入口按钮藏起来，否则它会压在目录标题上。
    toggle.hidden = open;
  };
  toggle.addEventListener('click', () => setOutlineOpen(!panel.classList.contains('open')));
  document.getElementById('pdfjs-outline-close')?.addEventListener('click', () => setOutlineOpen(false));

  function pageButton(pageNumber, label, depth = 1) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'outline-item';
    button.style.setProperty('--depth', String(Math.min(depth, 6)));

    const title = document.createElement('span');
    title.className = 'outline-item-title';
    title.textContent = label;
    button.appendChild(title);

    if (pageNumber) {
      button.dataset.pageNumber = String(pageNumber);
      const pageTag = document.createElement('span');
      pageTag.className = 'outline-item-page';
      pageTag.textContent = String(pageNumber);
      button.appendChild(pageTag);
      button.addEventListener('click', () => {
        for (const item of list.querySelectorAll('.outline-item.active')) item.classList.remove('active');
        button.classList.add('active');
        scrollToPdfPage(pageNumber);
        schedulePersist();
      });
    } else {
      button.disabled = true;
      button.style.cursor = 'default';
      button.style.color = '#9aa3b5';
    }
    list.appendChild(button);
  }

  async function renderItems(items, depth) {
    const valid = items.filter((item) => item?.title);
    const resolved = await Promise.all(valid.map(async (item) => ({
      item,
      pageNumber: item.dest ? await resolvePageNumber(pdfDocument, item.dest) : null
    })));
    for (const { item, pageNumber } of resolved) {
      pageButton(pageNumber, String(item.title).trim(), depth);
      if (item.items?.length) await renderItems(item.items, depth + 1);
    }
  }

  if (outline?.length) {
    await renderItems(outline, 1);
    return;
  }

  // Some PDFs have no bookmarks. Keep a page list so the enhanced reader
  // still has a usable directory instead of silently hiding the panel.
  for (let page = 1; page <= pdfDocument.numPages; page += 1) {
    pageButton(page, `第 ${page} 页`, 1);
  }
}
