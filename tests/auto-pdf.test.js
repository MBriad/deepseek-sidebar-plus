const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { chromium } = require('playwright');

const extensionPath = path.resolve(__dirname, '..');
const pdfFixture = path.join(__dirname, 'fixtures', 'text.pdf');

let context;
let server;

const watchdog = setTimeout(() => {
  console.error('AUTO PDF TEST WATCHDOG TIMEOUT');
  process.exit(1);
}, 3 * 60 * 1000);

async function waitFor(check, timeout = 20000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    try {
      const value = await check();
      if (value) return value;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error('timeout');
}

(async () => {
  try {
    const body = fs.readFileSync(pdfFixture);
    server = http.createServer((request, response) => {
      response.writeHead(200, { 'content-type': 'application/pdf', 'content-length': body.length });
      response.end(body);
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const pdfUrl = `http://127.0.0.1:${server.address().port}/text.pdf`;

    context = await chromium.launchPersistentContext(fs.mkdtempSync(path.join(os.tmpdir(), 'ds-auto-pdf-')), {
      headless: false,
      channel: process.env.PW_CHANNEL || undefined,
      timeout: 60000,
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
      await route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: '<!doctype html><title>chat</title><textarea id="chat-input"></textarea>' });
    });
    if (!context.serviceWorkers().length) await context.waitForEvent('serviceworker', { timeout: 20000 });
    const worker = context.serviceWorkers().find((item) => item.url().startsWith('chrome-extension://'));
    const id = new URL(worker.url()).host;

    const side = await context.newPage();
    await side.goto(`chrome-extension://${id}/src/sidebar.html`);
    await waitFor(() => side.evaluate(() => window.__DS_TEST__?.bridgeReady === true));

    const pdf = await context.newPage();
    await pdf.goto(pdfUrl);
    await pdf.bringToFront();

    const reader = await waitFor(() => context.pages().find((page) => page.url().includes('/src/pdf-reader.html?file=')));
    console.log('AUTO PDF URL', reader.url());
    assert.ok(reader.url().startsWith(`chrome-extension://${id}/src/pdf-reader.html`), 'PDF tab was not redirected');
    await waitFor(() => reader.frames().some((frame) => frame.url().includes('pdfjs-viewer.html')));
    console.log('AUTO PDF REDIRECT PASSED');
  } finally {
    clearTimeout(watchdog);
    const exitCode = process.exitCode || 0;
    if (server) await new Promise((resolve) => server.close(resolve));
    if (context) {
      await Promise.race([
        context.close().catch(() => {}),
        new Promise((resolve) => setTimeout(resolve, 15000))
      ]);
    }
    process.exit(exitCode);
  }
})().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
