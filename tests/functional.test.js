const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { chromium } = require('playwright');

const extensionPath = path.resolve(__dirname, '..');
const pdfFixture = path.join(__dirname, 'fixtures', 'text.pdf');

const chatHtml = `<!doctype html>
<html><head><meta charset="utf-8"><title>DeepSeek</title></head>
<body style="margin:0;padding:24px">
  <textarea id="chat-input" style="width:100%;height:120px"></textarea>
  <button data-testid="send-button" onclick="window.sent=document.querySelector('#chat-input').value">Send</button>
</body></html>`;

const articleHtml = `<!doctype html>
<html><head><meta charset="utf-8"><title>Article</title></head>
<body style="padding:80px">
  <h1>Extension test</h1>
  <p id="pick">This highlighted sentence should be inserted into the chat input automatically.</p>
</body></html>`;

let context;
let extensionId;
let server;
let pdfUrl;

async function waitFor(check, { timeout = 15000, interval = 200, message = 'condition' } = {}) {
  const start = Date.now();
  let lastError = null;
  while (Date.now() - start < timeout) {
    try {
      const value = await check();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, interval));
  }
  throw new Error(`Timed out waiting for ${message}${lastError ? `: ${lastError.message}` : ''}`);
}

async function setup() {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-sidebar-ext-'));
  context = await chromium.launchPersistentContext(userDataDir, {
    headless: process.env.PW_HEADLESS === '1',
    channel: process.env.PW_CHANNEL || undefined,
    timeout: 60000,
    viewport: { width: 1200, height: 900 },
    args: [
      `--disable-extensions-except=${extensionPath}`,
      `--load-extension=${extensionPath}`,
      '--no-sandbox',
      '--disable-dev-shm-usage'
    ]
  });
  context.setDefaultTimeout(20000);
  context.setDefaultNavigationTimeout(30000);

  await context.route('https://chat.deepseek.com/**', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'text/html; charset=utf-8',
      body: route.request().resourceType() === 'document' ? chatHtml : ''
    });
  });
  await context.route('https://example.com/article', async (route) => {
    await route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: articleHtml });
  });

  if (!context.serviceWorkers().length) {
    await context.waitForEvent('serviceworker', { timeout: 20000 });
  }
  const worker = context.serviceWorkers().find((item) => item.url().startsWith('chrome-extension://'));
  assert.ok(worker, 'extension service worker not found');
  extensionId = new URL(worker.url()).host;

  server = http.createServer((request, response) => {
    if (request.url !== '/text.pdf') {
      response.writeHead(404);
      response.end('not found');
      return;
    }
    const body = fs.readFileSync(pdfFixture);
    response.writeHead(200, {
      'content-type': 'application/pdf',
      'content-length': body.length
    });
    response.end(body);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  pdfUrl = `http://127.0.0.1:${server.address().port}/text.pdf`;
}

async function openSidebar() {
  const page = await context.newPage();
  page.on('pageerror', (error) => console.error('[sidebar pageerror]', error.message));
  await page.goto(`chrome-extension://${extensionId}/src/sidebar.html`);
  await waitFor(() => page.evaluate(() => window.__DS_TEST__?.bridgeReady === true), {
    timeout: 20000,
    message: 'sidebar bridge'
  });
  return page;
}

async function chatFrame(sidebar) {
  const frame = await waitFor(() => sidebar.frames().find((item) => item.url().includes('chat.deepseek.com')), {
    message: 'chat iframe'
  });
  return frame;
}

async function selectArticleText(article) {
  await article.evaluate(() => {
    const range = document.createRange();
    range.selectNodeContents(document.querySelector('#pick').firstChild);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    document.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, clientX: 200, clientY: 150 }));
  });
}

async function testWebRelay() {
  const sidebar = await openSidebar();
  const article = await context.newPage();
  article.on('pageerror', (error) => console.error('[article pageerror]', error.message));
  await article.goto('https://example.com/article');
  await article.bringToFront();
  await selectArticleText(article);

  const chat = await chatFrame(sidebar);
  await waitFor(async () => (await chat.locator('#chat-input').inputValue()).includes('This highlighted sentence'), {
    message: 'selection fill'
  });
  await waitFor(() => article.evaluate(() => document.activeElement?.id === 'ds-type-relay'), {
    message: 'floating input focus'
  });
  await waitFor(() => article.evaluate(() => window.getSelection()?.toString() === ''), {
    message: 'selection toolbar dismissal'
  });

  await article.evaluate(() => {
    const input = document.querySelector('#ds-type-relay').shadowRoot.querySelector('input');
    input.focus();
    input.dispatchEvent(new CompositionEvent('compositionstart', { data: '' }));
    input.value = '中文';
    input.dispatchEvent(new InputEvent('input', { data: '中文', isComposing: true, bubbles: true }));
    input.dispatchEvent(new CompositionEvent('compositionend', { data: '中文' }));
  });
  await waitFor(async () => (await chat.locator('#chat-input').inputValue()).includes('中文'), {
    message: 'Chinese IME composition relay'
  });

  await article.keyboard.type(' DIRECT TYPING');
  await waitFor(async () => (await chat.locator('#chat-input').inputValue()).includes('DIRECT TYPING'), {
    message: 'direct typing relay'
  });

  await article.keyboard.press('Control+Z');
  await waitFor(async () => (await chat.locator('#chat-input').inputValue()) === '', {
    message: 'Ctrl+Z undo'
  });

  await article.close();
  await sidebar.close();
  console.log('PASS web selection relay + direct typing + Ctrl+Z');
}

async function testEnterSends() {
  const sidebar = await openSidebar();
  const article = await context.newPage();
  await article.goto('https://example.com/article');
  await article.bringToFront();
  await selectArticleText(article);

  const chat = await chatFrame(sidebar);
  await waitFor(async () => (await chat.locator('#chat-input').inputValue()).includes('This highlighted sentence'), {
    message: 'selection fill'
  });
  await waitFor(() => article.evaluate(() => document.activeElement?.id === 'ds-type-relay'), {
    message: 'floating input focus'
  });
  await article.keyboard.type(' SEND THIS');
  await article.keyboard.press('Enter');
  await waitFor(() => chat.evaluate(() => (window.sent || '').includes('SEND THIS')), {
    message: 'Enter send'
  });

  await article.close();
  await sidebar.close();
  console.log('PASS Enter sends composed message');
}

async function testPdfFollowAndSend() {
  const sidebar = await openSidebar();
  const reader = await context.newPage();
  await reader.goto(
    `chrome-extension://${extensionId}/src/pdf-reader.html?file=${encodeURIComponent(pdfUrl)}&name=text.pdf`
  );

  const frame = await waitFor(() => reader.frames().find((item) => item.url().includes('pdfjs-viewer.html')), {
    timeout: 25000,
    message: 'PDF.js iframe'
  });
  await frame.waitForSelector('.textLayer span', { state: 'attached', timeout: 25000 });
  await frame.waitForTimeout(500);

  const selected = await frame.evaluate(() => {
    const span = document.querySelectorAll('.textLayer span')[1] || document.querySelector('.textLayer span');
    const range = document.createRange();
    range.selectNodeContents(span);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    span.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
    const rect = range.getBoundingClientRect();
    return { text: span.textContent, bottom: rect.bottom };
  });

  const chat = await chatFrame(sidebar);
  await waitFor(async () => (await chat.locator('#chat-input').inputValue()).includes(selected.text.slice(0, 20)), {
    message: 'PDF selection fill'
  });

  const layout = await reader.evaluate(() => {
    const frameElement = document.querySelector('#pdfjs-frame').getBoundingClientRect();
    const input = document.querySelector('#ds-type-relay').getBoundingClientRect();
    return {
      frameTop: frameElement.top,
      top: input.top,
      display: getComputedStyle(document.querySelector('#ds-type-relay')).display
    };
  });
  assert.equal(layout.display, 'block', 'PDF floating input should be visible');
  assert.ok(
    layout.top >= layout.frameTop + selected.bottom - 4,
    `PDF floating input should be below selection (input=${layout.top}, selection=${layout.frameTop + selected.bottom})`
  );

  await reader.evaluate(() => {
    const input = document.querySelector('#ds-type-relay');
    input.focus();
    input.dispatchEvent(new CompositionEvent('compositionstart', { data: '' }));
    input.value = '中文';
    input.dispatchEvent(new InputEvent('input', { data: '中文', isComposing: true, bubbles: true }));
    input.dispatchEvent(new CompositionEvent('compositionend', { data: '中文' }));
  });
  await waitFor(async () => (await chat.locator('#chat-input').inputValue()).includes('中文'), {
    message: 'PDF Chinese IME composition relay'
  });

  await reader.keyboard.type(' PDF SEND');
  await reader.keyboard.press('Enter');
  await waitFor(() => chat.evaluate(() => (window.sent || '').includes('PDF SEND')), {
    message: 'PDF Enter send'
  });

  await reader.close();
  await sidebar.close();
  console.log('PASS PDF.js follow selection + Enter send');
}

const watchdog = setTimeout(() => {
  console.error('FUNCTIONAL TEST WATCHDOG TIMEOUT');
  process.exit(1);
}, 8 * 60 * 1000);

(async () => {
  try {
    await setup();
    await testWebRelay();
    await testEnterSends();
    await testPdfFollowAndSend();
    console.log('ALL FUNCTIONAL TESTS PASSED');
  } catch (error) {
    console.error('FUNCTIONAL TEST FAILED');
    console.error(error.stack || error.message);
    if (context) {
      try {
        fs.mkdirSync('test-results', { recursive: true });
        const page = context.pages()[0];
        if (page) await page.screenshot({ path: 'test-results/failure.png', fullPage: true });
      } catch {
        // Ignore screenshot failures.
      }
    }
    process.exitCode = 1;
  } finally {
    clearTimeout(watchdog);
    const exitCode = process.exitCode || 0;
    if (server) {
      server.closeAllConnections?.();
      await new Promise((resolve) => server.close(resolve));
    }
    if (context) {
      await Promise.race([
        context.close().catch(() => {}),
        new Promise((resolve) => setTimeout(resolve, 15000))
      ]);
    }
    process.exit(exitCode);
  }
})();
