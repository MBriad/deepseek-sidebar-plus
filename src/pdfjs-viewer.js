import * as pdfjsLib from './vendor/pdfjs/build/pdf.mjs';

const params = new URLSearchParams(location.search);
const fileUrl = params.get('file') || '';
const scale = Number(params.get('scale')) || 1.4;
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
  page.scrollIntoView({ block: 'start', behavior: 'smooth' });
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
    document.getElementById('pdfjs-outline')?.classList.toggle('open');
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
  const defaultViewport = firstPage.getViewport({ scale });
  const pageElements = new Map();
  const renderedPages = new Set();
  const renderingPages = new Set();

  // Create page placeholders immediately. Large PDFs (hundreds of pages) were
  // previously blocked until every canvas and text layer finished rendering.
  for (let number = 1; number <= pdfDocument.numPages; number += 1) {
    const pageElement = document.createElement('div');
    pageElement.className = 'pdfjs-page';
    pageElement.dataset.pageNumber = String(number);
    pageElement.style.width = `${Math.floor(defaultViewport.width)}px`;
    pageElement.style.height = `${Math.floor(defaultViewport.height)}px`;
    pageElement.style.setProperty('--scale-factor', String(defaultViewport.scale));
    pageElement.style.setProperty('--total-scale-factor', String(defaultViewport.scale));
    pageElement.style.setProperty('--user-unit', '1');
    viewer.appendChild(pageElement);
    pageElements.set(number, pageElement);
  }

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
      canvas.width = Math.floor(viewport.width);
      canvas.height = Math.floor(viewport.height);
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

      await page.render({ canvasContext: context, viewport }).promise;

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
  toggle.addEventListener('click', () => panel.classList.toggle('open'));

  function pageButton(pageNumber, label, depth = 1) {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = label;
    button.className = `pdfjs-outline-depth-${Math.min(depth, 4)}`;
    if (pageNumber) {
      button.dataset.pageNumber = String(pageNumber);
      button.addEventListener('click', () => {
        scrollToPdfPage(pageNumber);
        schedulePersist();
      });
    } else {
      button.disabled = true;
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
