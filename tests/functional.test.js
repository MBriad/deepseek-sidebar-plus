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
let twoPagePdfUrl;

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

  for (const pattern of ['https://chat.deepseek.com/**', 'https://chatgpt.com/**']) {
    await context.route(pattern, async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'text/html; charset=utf-8',
        body: route.request().resourceType() === 'document' ? chatHtml : ''
      });
    });
  }
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
    const send = (body) => {
      response.writeHead(200, {
        'content-type': 'application/pdf',
        'content-length': body.length
      });
      response.end(body);
    };
    if (request.url === '/text.pdf') {
      send(fs.readFileSync(pdfFixture));
      return;
    }
    if (request.url === '/two-pages.pdf') {
      send(twoPagePdf());
      return;
    }
    response.writeHead(404);
    response.end('not found');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  pdfUrl = `http://127.0.0.1:${server.address().port}/text.pdf`;
  twoPagePdfUrl = `http://127.0.0.1:${server.address().port}/two-pages.pdf`;
}

// 现造一份两页 PDF:夹具只有一页,而"记住读到第几页"必须跨页才验得出来。
function twoPagePdf() {
  const content = (text) => `BT /F1 24 Tf 40 300 Td (${text}) Tj ET`;
  const streams = [content('Page One'), content('Page Two')];
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R 6 0 R] /Count 2 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 400] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${streams[0].length} >>\nstream\n${streams[0]}\nendstream`,
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 400] /Resources << /Font << /F1 4 0 R >> >> /Contents 7 0 R >>',
    `<< /Length ${streams[1].length} >>\nstream\n${streams[1]}\nendstream`
  ];

  let pdf = '%PDF-1.4\n';
  const offsets = [];
  objects.forEach((body, index) => {
    offsets.push(pdf.length);
    pdf += `${index + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xrefAt = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) {
    pdf += `${String(offset).padStart(10, '0')} 00000 n \n`;
  }
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefAt}\n%%EOF\n`;
  return Buffer.from(pdf, 'latin1');
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

async function chatFrame(sidebar, host = 'chat.deepseek.com') {
  const frame = await waitFor(() => sidebar.frames().find((item) => item.url().includes(host)), {
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

  await article.keyboard.press('Backspace');
  await waitFor(async () => {
    const value = await chat.locator('#chat-input').inputValue();
    return value.endsWith('DIRECT TYPIN') && !value.endsWith('DIRECT TYPING');
  }, { message: 'Backspace relay' });

  await article.keyboard.press('Control+Z');
  await waitFor(async () => (await chat.locator('#chat-input').inputValue()) === '', {
    message: 'Ctrl+Z undo'
  });

  await article.close();
  await sidebar.close();
  console.log('PASS web selection relay + direct typing + Ctrl+Z');
}

async function testWebMouseSelection() {
  const sidebar = await openSidebar();
  const article = await context.newPage();
  await article.goto('https://example.com/article');
  await article.bringToFront();

  const box = await article.locator('#pick').boundingBox();
  assert.ok(box, 'article paragraph missing');
  await article.mouse.move(box.x + 4, box.y + box.height / 2);
  await article.mouse.down();
  await article.mouse.move(box.x + box.width - 4, box.y + box.height / 2, { steps: 12 });
  await article.mouse.up();

  const chat = await chatFrame(sidebar);
  await waitFor(async () => (await chat.locator('#chat-input').inputValue()).includes('This highlighted sentence'), {
    message: 'real mouse selection fill'
  });
  await waitFor(() => article.evaluate(() => document.activeElement?.id === 'ds-type-relay'), {
    message: 'real mouse floating input'
  });

  await article.close();
  await sidebar.close();
  console.log('PASS real mouse selection + floating input');
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
  await reader.waitForSelector('#btn-outline:not([hidden])', { timeout: 10000 });
  await frame.waitForSelector('#pdfjs-outline-toggle:not([hidden])', { timeout: 10000 });

  await reader.click('#btn-outline');
  await waitFor(() => frame.evaluate(() =>
    document.getElementById('pdfjs-outline')?.classList.contains('open')
    && document.querySelectorAll('#pdfjs-outline-list button').length > 0
  ), { message: 'PDF directory entries' });
  await reader.click('#btn-outline');
  await frame.waitForTimeout(200);

  const selectSpan = (index) => frame.evaluate((spanIndex) => {
    const span = document.querySelectorAll('.textLayer span')[spanIndex]
      || document.querySelector('.textLayer span');
    const range = document.createRange();
    range.selectNodeContents(span);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    span.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
    const rect = range.getBoundingClientRect();
    return { text: span.textContent, bottom: rect.bottom };
  }, index);

  const first = await selectSpan(0);
  const chat = await chatFrame(sidebar);
  await waitFor(async () => (await chat.locator('#chat-input').inputValue()).includes(first.text.slice(0, 20)), {
    message: 'PDF first selection fill'
  });

  const selected = await selectSpan(1);
  await waitFor(async () => {
    const value = await chat.locator('#chat-input').inputValue();
    return value.includes(selected.text.slice(0, 20)) && !value.includes(first.text);
  }, { message: 'PDF second selection replaces first' });

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

async function testPdfRemembersPosition() {
  const reader = await context.newPage();
  await reader.goto(
    `chrome-extension://${extensionId}/src/pdf-reader.html?file=${encodeURIComponent(twoPagePdfUrl)}&name=two-pages.pdf`
  );

  const frame = await waitFor(() => reader.frames().find((item) => item.url().includes('pdfjs-viewer.html')), {
    timeout: 25000,
    message: 'PDF.js iframe (two pages)'
  });
  await frame.waitForSelector('#pdfjs-outline-toggle:not([hidden])', { timeout: 25000 });
  await reader.click('#btn-outline');
  await waitFor(() => frame.evaluate(() =>
    document.querySelectorAll('#pdfjs-outline-list button').length >= 2
  ), { message: 'two-page directory' });

  await frame.evaluate(() => {
    const button = Array.from(document.querySelectorAll('#pdfjs-outline-list button'))
      .find((item) => item.textContent.trim() === '第 2 页');
    button?.click();
  });

  await waitFor(() => frame.evaluate(() => document.getElementById('pdfjs-container').scrollTop > 50), {
    message: 'scrolled to page 2'
  });
  await reader.waitForTimeout(700); // 等防抖的持久化写完

  await reader.reload();
  await waitFor(async () => {
    for (const candidate of reader.frames().filter((item) => item.url().includes('pdfjs-viewer.html'))) {
      try {
        if (await candidate.evaluate(() => document.getElementById('pdfjs-container')?.scrollTop > 50)) return true;
      } catch {
        // 旧 frame 在导航时会失效,忽略
      }
    }
    return false;
  }, { timeout: 20000, message: 'reading position restored' });

  // 显式给了 page 参数时,必须以参数为准,不能被历史位置盖掉。
  await reader.goto(
    `chrome-extension://${extensionId}/src/pdf-reader.html?file=${encodeURIComponent(twoPagePdfUrl)}&name=two-pages.pdf&page=1`
  );
  await waitFor(async () => {
    for (const candidate of reader.frames().filter((item) => item.url().includes('pdfjs-viewer.html'))) {
      try {
        if (await candidate.evaluate(() => document.querySelectorAll('.pdfjs-page').length >= 2)) return true;
      } catch {
        // 同上
      }
    }
    return false;
  }, { timeout: 20000, message: 'two-page viewer after explicit navigation' });
  await reader.waitForTimeout(1200);

  const explicitTops = [];
  for (const candidate of reader.frames().filter((item) => item.url().includes('pdfjs-viewer.html'))) {
    explicitTops.push(await candidate.evaluate(() => {
      const container = document.getElementById('pdfjs-container');
      if (!container) throw new Error('pdfjs container missing');
      return container.scrollTop;
    }));
  }
  // 没有可测的 frame 就等于什么都没证明——不能让空数组把断言"通过"掉。
  assert.ok(explicitTops.length > 0, 'no pdfjs frame to measure');
  assert.ok(
    explicitTops.every((top) => top === 0),
    `explicit ?page=1 should beat the saved position (scrollTop=${explicitTops.join(',')})`
  );

  await reader.close();
  console.log('PASS PDF remembers the last reading position');
}

const watchdog = setTimeout(() => {
  console.error('FUNCTIONAL TEST WATCHDOG TIMEOUT');
  process.exit(1);
}, 8 * 60 * 1000);

async function testBookmarkManager() {
  const sidebar = await openSidebar();

  const setup = await sidebar.evaluate(async () => {
    const [root] = await chrome.bookmarks.getTree();
    const bar = (root.children || []).find((node) => !node.url);
    const from = await chrome.bookmarks.create({ parentId: bar.id, title: '整理测试-来源' });
    const to = await chrome.bookmarks.create({ parentId: bar.id, title: '整理测试-目标' });
    const item = await chrome.bookmarks.create({
      parentId: from.id,
      title: '待移动的收藏',
      url: 'https://example.com/move-me'
    });
    return { fromId: from.id, toId: to.id, itemId: item.id };
  });

  await sidebar.click('#btn-bookmarks');
  // 夹具文件夹只在成功路径上删是不够的:断言一失败就会留下同名文件夹,
  // 下一次运行先匹配到它们,于是永久失败。清理放进 finally。
  try {
    await waitFor(() => sidebar.evaluate(() => document.querySelectorAll('#bm-folders .bm-folder').length > 0), {
      message: 'bookmark folders rendered'
    });

    await sidebar.evaluate(() => {
      const folder = [...document.querySelectorAll('#bm-folders .bm-folder')]
        .find((button) => button.textContent.includes('整理测试-来源'));
      folder?.click();
    });
    await waitFor(
      () => sidebar.evaluate(() => document.querySelectorAll('#bm-items input[type=checkbox]').length === 1),
      { message: 'bookmarks of the source folder' }
    );

    await sidebar.click('#bm-items input[type=checkbox]');
    await sidebar.evaluate((targetId) => {
      const select = document.getElementById('bm-target');
      select.value = targetId;
      select.dispatchEvent(new Event('change', { bubbles: true }));
    }, setup.toId);

    await waitFor(() => sidebar.evaluate(() => !document.getElementById('btn-bm-move').disabled), {
      message: 'move button enabled'
    });
    await sidebar.click('#btn-bm-move');

    await waitFor(async () => {
      const titles = await sidebar.evaluate(
        (id) => chrome.bookmarks.getChildren(id).then((nodes) => nodes.map((node) => node.title)),
        setup.toId
      );
      return titles.includes('待移动的收藏');
    }, { message: 'bookmark moved into the target folder' });
  } finally {
    // 清理本身也可能抛(页面已关/正在导航);不能让它把真正的断言错误盖掉。
    await sidebar.evaluate(({ fromId, toId }) => Promise.all([
      chrome.bookmarks.removeTree(fromId).catch(() => {}),
      chrome.bookmarks.removeTree(toId).catch(() => {})
    ]), setup).catch(() => {});
  }

  await sidebar.close();
  console.log('PASS bookmark manager moves a selected bookmark into a folder');
}

async function testChatgptProvider() {
  const sidebar = await openSidebar();
  await sidebar.click('.provider-tab[data-provider="chatgpt"]');
  await waitFor(() => sidebar.frames().some((item) => item.url().includes('chatgpt.com')), {
    timeout: 20000,
    message: 'ChatGPT frame'
  });
  await waitFor(() => sidebar.evaluate(() => window.__DS_TEST__?.bridgeReady === true), {
    timeout: 20000,
    message: 'ChatGPT bridge'
  });

  const article = await context.newPage();
  await article.goto('https://example.com/article');
  await article.bringToFront();
  await selectArticleText(article);

  const chat = await chatFrame(sidebar, 'chatgpt.com');
  await waitFor(async () => (await chat.locator('#chat-input').inputValue()).includes('This highlighted sentence'), {
    message: 'ChatGPT selection fill'
  });
  await waitFor(() => article.evaluate(() => document.activeElement?.id === 'ds-type-relay'), {
    message: 'ChatGPT floating input'
  });

  await article.keyboard.type(' CHATGPT TYPING');
  await waitFor(async () => (await chat.locator('#chat-input').inputValue()).includes('CHATGPT TYPING'), {
    message: 'ChatGPT direct typing'
  });

  await article.close();
  await sidebar.close();
  console.log('PASS ChatGPT provider selection, floating input and typing');
}

(async () => {
  try {
    await setup();
    await testWebRelay();
    await testWebMouseSelection();
    await testEnterSends();
    await testPdfFollowAndSend();
    await testPdfRemembersPosition();
    await testBookmarkManager();
    await testChatgptProvider();
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
