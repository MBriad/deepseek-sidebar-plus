import * as pdfjsLib from './vendor/pdfjs/build/pdf.mjs';

const params = new URLSearchParams(location.search);
const fileUrl = params.get('file') || '';
const scale = Number(params.get('scale')) || 1.4;
const initialPage = Math.max(1, Number(params.get('page')) || 1);

pdfjsLib.GlobalWorkerOptions.workerSrc = chrome.runtime.getURL('src/vendor/pdfjs/build/pdf.worker.mjs');

const viewer = document.getElementById('pdfjs-viewer');
let selectionReportTimer = null;
let pendingOutlinePage = 0;

function scrollToPdfPage(pageNumber) {
  const page = viewer.querySelector(`.pdfjs-page[data-page-number="${pageNumber}"]`);
  if (!page) {
    pendingOutlinePage = pageNumber;
    return;
  }
  page.scrollIntoView({ block: 'start', behavior: 'smooth' });
}

function reportSelectionToParent() {
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed || !selection.rangeCount) return;
  const text = selection.toString().replace(/\u00a0/g, ' ').trim();
  if (!text) {
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

  // Clear immediately after reporting so Edge's native copy/search mini menu
  // does not stay on top of the floating input and swallow Enter.
  selection.removeAllRanges();
}

document.addEventListener('pointerup', () => {
  clearTimeout(selectionReportTimer);
  selectionReportTimer = setTimeout(reportSelectionToParent, 20);
}, true);

window.addEventListener('message', (event) => {
  if (event.data?.source !== 'ds-pdf-host' || event.data?.type !== 'toggle-outline') return;
  document.getElementById('pdfjs-outline')?.classList.toggle('open');
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

  // Build the directory immediately, in parallel with page rendering. Large
  // PDFs can take a long time to render every canvas/text layer; the outline
  // and page list should not wait for that.
  const outlineReady = renderOutline(pdfDocument);

  for (let number = 1; number <= pdfDocument.numPages; number += 1) {
    const page = await pdfDocument.getPage(number);
    const viewport = page.getViewport({ scale });
    const pageElement = document.createElement('div');
    pageElement.className = 'pdfjs-page';
    pageElement.dataset.pageNumber = String(number);
    pageElement.style.width = `${Math.floor(viewport.width)}px`;
    pageElement.style.height = `${Math.floor(viewport.height)}px`;
    pageElement.style.setProperty('--scale-factor', String(viewport.scale));
    pageElement.style.setProperty('--user-unit', '1');

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
    textLayerElement.style.setProperty('--user-unit', '1');
    pageElement.appendChild(textLayerElement);

    viewer.appendChild(pageElement);
    if (pendingOutlinePage === number) {
      pendingOutlinePage = 0;
      pageElement.scrollIntoView({ block: 'start' });
    }

    await page.render({ canvasContext: context, viewport }).promise;

    const textLayer = new pdfjsLib.TextLayer({
      textContentSource: page.streamTextContent(),
      container: textLayerElement,
      viewport
    });
    await textLayer.render();
  }

  if (initialPage > 1) {
    const initialPageElement = viewer.querySelector(`.pdfjs-page[data-page-number="${initialPage}"]`);
    initialPageElement?.scrollIntoView({ block: 'start' });
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
      button.addEventListener('click', () => scrollToPdfPage(pageNumber));
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
