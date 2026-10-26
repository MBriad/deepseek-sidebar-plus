import * as pdfjsLib from './vendor/pdfjs/build/pdf.mjs';

const params = new URLSearchParams(location.search);
const fileUrl = params.get('file') || '';
const scale = Number(params.get('scale')) || 1.4;

pdfjsLib.GlobalWorkerOptions.workerSrc = chrome.runtime.getURL('src/vendor/pdfjs/build/pdf.worker.mjs');

const viewer = document.getElementById('pdfjs-viewer');

try {
  const task = pdfjsLib.getDocument({
    url: fileUrl,
    cMapUrl: chrome.runtime.getURL('src/vendor/pdfjs/cmaps/'),
    cMapPacked: true,
    standardFontDataUrl: chrome.runtime.getURL('src/vendor/pdfjs/standard_fonts/'),
    wasmUrl: chrome.runtime.getURL('src/vendor/pdfjs/wasm/')
  });
  const pdfDocument = await task.promise;

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

    await page.render({ canvasContext: context, viewport }).promise;

    const textLayer = new pdfjsLib.TextLayer({
      textContentSource: page.streamTextContent(),
      container: textLayerElement,
      viewport
    });
    await textLayer.render();
  }

  await renderOutline(pdfDocument);
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
  if (!outline?.length) return;

  const toggle = document.getElementById('pdfjs-outline-toggle');
  const panel = document.getElementById('pdfjs-outline');
  const list = document.getElementById('pdfjs-outline-list');
  toggle.hidden = false;
  toggle.addEventListener('click', () => panel.classList.toggle('open'));

  async function renderItems(items, depth) {
    for (const item of items) {
      if (!item?.title) continue;
      const pageNumber = item.dest ? await resolvePageNumber(pdfDocument, item.dest) : null;
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = String(item.title).trim();
      button.className = `pdfjs-outline-depth-${Math.min(depth, 4)}`;
      if (pageNumber) {
        button.dataset.pageNumber = String(pageNumber);
        button.addEventListener('click', () => {
          const page = viewer.querySelector(`.pdfjs-page[data-page-number="${pageNumber}"]`);
          page?.scrollIntoView({ block: 'start', behavior: 'smooth' });
        });
      } else {
        button.disabled = true;
      }
      list.appendChild(button);
      if (item.items?.length) await renderItems(item.items, depth + 1);
    }
  }

  await renderItems(outline, 1);
}
