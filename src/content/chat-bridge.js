/* DeepSeek Sidebar+ — chat bridge content script
 *
 * Runs inside the chat.deepseek.com iframe that the side panel embeds.
 * The side panel posts a message into the iframe; this script writes the
 * requested text into DeepSeek's input box and reports back.
 */
(() => {
  if (window.__DS_CHAT_BRIDGE__) return;

  const parentOrigin = getParentOrigin();
  if (!parentOrigin || !parentOrigin.startsWith('chrome-extension://')) return;

  window.__DS_CHAT_BRIDGE__ = true;
  try {
    document.documentElement.dataset.dsChatBridge = '1';
  } catch {
    // Ignore.
  }

  const SOURCE = 'ds-chat';
  const PARENT_SOURCE = 'ds-sidebar';
  const CHAT_NAME = /(^|\.)chatgpt\.com$|(^|\.)openai\.com$/i.test(location.hostname)
    ? 'ChatGPT'
    : 'DeepSeek';
  let lastInserted = '';
  let autoSelection = null;
  let relayActive = false;
  let relayBase = '';
  let toastHost = null;
  let toastTimer = null;
  let quoteHost = null;
  let quoteText = '';
  let quoteTimer = null;
  let commandHost = null;
  let commandItems = [];
  let commandIndex = 0;
  let commandMatch = null;
  let commandTimer = null;
  let promptCommands = [];
  let mentionHost = null;
  let mentionItems = [];
  let mentionIndex = 0;
  let mentionMatch = null;
  let mentionTimer = null;
  let mentionSeq = 0;
  let mentionRequestSeq = 0;
  let mentionCache = { tabs: [], current: null, at: 0 };
  const pendingTabRequests = new Map();
  let rootsCache = null;
  let rootsCacheAt = 0;

  window.addEventListener('message', onMessage);
  installQuoteSelection();
  installCommandPalette();
  installMentionPalette();
  loadPromptCommands();
  announceReady();
  setTimeout(announceReady, 900);

  /* ---------------------------------------------------------------- */
  /* Messaging                                                        */
  /* ---------------------------------------------------------------- */

  function getParentOrigin() {
    try {
      if (location.ancestorOrigins && location.ancestorOrigins.length > 0) {
        return location.ancestorOrigins[0] || '';
      }
    } catch {
      // Fall through to the referrer.
    }
    try {
      if (document.referrer) return new URL(document.referrer).origin;
    } catch {
      // Ignore malformed referrers.
    }
    return '';
  }

  function post(type, payload = {}) {
    try {
      window.parent.postMessage({ source: SOURCE, type, ...payload }, parentOrigin);
    } catch {
      // The parent may be navigating.
    }
  }

  function announceReady() {
    post('READY', {
      href: location.href,
      hasInput: Boolean(findInput())
    });
  }

  function onMessage(event) {
    if (event.source !== window.parent) return;
    if (event.origin !== parentOrigin) return;

    const data = event.data;
    if (!data || typeof data !== 'object' || data.source !== PARENT_SOURCE) return;

    switch (data.type) {
      case 'DS_PING':
        post('READY', {
          requestId: data.requestId,
          href: location.href,
          hasInput: Boolean(findInput())
        });
        break;

      case 'DS_GET_STATE':
        post('STATE_RESULT', {
          requestId: data.requestId,
          ok: true,
          hasInput: Boolean(findInput()),
          href: location.href
        });
        break;

      case 'DS_FILL_INPUT':
        handleFillRequest(data);
        break;

      case 'DS_ATTACH_FILE':
        handleAttachRequest(data);
        break;

      case 'DS_CLEAR_SELECTION':
        handleClearSelection(data);
        break;

      case 'DS_QUOTE_TEXT':
        handleQuoteRequest(data);
        break;

      case 'DS_GET_INPUT':
        handleGetInputRequest(data);
        break;

      case 'DS_FOCUS_INPUT': {
        const input = findInput();
        if (input) focusInputEnd(input, isValueInput(input) ? 'value' : 'editable');
        break;
      }

      case 'DS_SEND_MESSAGE': {
        const ok = sendCurrentMessage();
        post('SEND_RESULT', { requestId: data.requestId, ok });
        break;
      }

      case 'DS_EXPORT_PDF':
        // 虚拟列表要边滚边收,所以这里是异步的;结果晚一点回。
        (async () => {
          try {
            post('EXPORT_RESULT', {
              requestId: data.requestId,
              ok: true,
              conversation: await collectConversation()
            });
          } catch (error) {
            post('EXPORT_RESULT', {
              requestId: data.requestId,
              ok: false,
              error: error?.message || '读取对话失败'
            });
          }
        })();
        break;

      case 'DS_RELAY_START': {
        const input = findInput();
        if (input) {
          const kind = isValueInput(input) ? 'value' : 'editable';
          relayBase = readValue(input, kind);
          relayActive = true;
          post('RELAY_RESULT', { requestId: data.requestId, ok: true });
        } else {
          relayActive = false;
          post('RELAY_RESULT', { requestId: data.requestId, ok: false, error: '没有找到输入框' });
        }
        break;
      }

      case 'DS_RELAY_SET': {
        if (!relayActive) {
          post('RELAY_RESULT', { requestId: data.requestId, ok: false, error: '没有开始直接输入' });
          break;
        }
        const input = findInput();
        if (!input) {
          post('RELAY_RESULT', { requestId: data.requestId, ok: false, error: '没有找到输入框' });
          break;
        }
        const kind = isValueInput(input) ? 'value' : 'editable';
        const next = `${relayBase}${String(data.text || '')}`;
        if (kind === 'value') setValueInput(input, next, { focus: false });
        else setEditableInput(input, next, { focus: false });
        post('RELAY_RESULT', { requestId: data.requestId, ok: true });
        break;
      }

      case 'DS_RELAY_END':
        relayActive = false;
        relayBase = '';
        autoSelection = null;
        post('RELAY_RESULT', { requestId: data.requestId, ok: true });
        break;

      case 'DS_RELAY_CANCEL': {
        relayActive = false;
        relayBase = '';
        const input = findInput();
        const previous = autoSelection?.previousValue ?? '';
        autoSelection = null;
        if (input) {
          const kind = isValueInput(input) ? 'value' : 'editable';
          if (kind === 'value') setValueInput(input, previous, { focus: false });
          else setEditableInput(input, previous, { focus: false });
        }
        post('RELAY_RESULT', { requestId: data.requestId, ok: true });
        break;
      }

      case 'TABS_RESULT':
        handleTabsResult(data);
        break;

      default:
        break;
    }
  }

  /* ---------------------------------------------------------------- */
  /* Fill                                                             */
  /* ---------------------------------------------------------------- */

  async function handleFillRequest(data) {
    const requestId = data.requestId;
    const selectionId = String(data.selectionId || '');
    const incoming = String(data.text || '').replace(/\r\n/g, '\n');

    // A new fill (selection or page content) invalidates the previous
    // selection record; only the latest auto-filled selection can be undone.
    const previousAuto = autoSelection;
    autoSelection = null;

    if (!incoming.trim()) {
      post('FILL_RESULT', {
        requestId,
        ok: false,
        code: 'empty',
        error: '要填入的文字为空。'
      });
      return;
    }

    if (/\/(sign_in|login)(\/|$)/i.test(location.pathname)) {
      post('FILL_RESULT', {
        requestId,
        ok: false,
        code: 'no-input',
        error: `请先在侧边栏中登录 ${CHAT_NAME}，然后再试一次。`
      });
      return;
    }

    try {
      const input = await waitForInput(Math.min(Number(data.waitMs) || 12000, 20000));
      if (!input) {
        post('FILL_RESULT', {
          requestId,
          ok: false,
          code: 'no-input',
          error: `没有找到 ${CHAT_NAME} 输入框，请确认已经登录并等待页面加载完成。`
        });
        return;
      }

      const kind = isValueInput(input) ? 'value' : 'editable';
      const current = readValue(input, kind);
      // If the input still contains exactly the previous auto-fill, a new
      // selection replaces that auto-fill instead of appending to it. Without
      // this, slow PDF selections can accumulate several partial highlights and
      // suddenly produce a much larger block of text.
      const replacingAuto = Boolean(selectionId && previousAuto && current === previousAuto.nextValue);
      const baseValue = replacingAuto ? previousAuto.previousValue : current;
      const previousValue = baseValue;
      const mode = ['replace', 'append', 'smart'].includes(data.mode) ? data.mode : 'smart';
      const next = composeValue(baseValue, incoming, mode);

      if (kind === 'value') {
        setValueInput(input, next);
      } else {
        setEditableInput(input, next);
      }

      // Some React inputs silently reset a programmatic value. Give the
      // framework a tick, then try the insertText fallback once.
      const verified = await verifyValue(input, kind, next);
      if (!verified) {
        fallbackInsert(input, kind, next);
        await verifyValue(input, kind, next, 120);
      }

      const finalValue = readValue(input, kind);
      const success = inputContains(finalValue, incoming);
      if (success) {
        if (mode !== 'append') lastInserted = incoming;
        if (selectionId) {
          autoSelection = {
            id: selectionId,
            previousValue,
            nextValue: finalValue,
            insertedText: incoming,
            mode
          };
        }
        showToast(`已填入 ${formatChars(incoming.length)}`);
        focusInputEnd(input, kind);
        setTimeout(() => {
          const latest = findInput();
          if (latest) focusInputEnd(latest, isValueInput(latest) ? 'value' : 'editable');
        }, 60);
      }

      post('FILL_RESULT', {
        requestId,
        ok: success,
        code: success ? 'ok' : 'not-applied',
        error: success ? '' : `文字已写入，但 ${CHAT_NAME} 输入框没有接收，请手动粘贴。`,
        inputKind: kind,
        mode,
        chars: incoming.length,
        valueLength: finalValue.length,
        href: location.href
      });
    } catch (error) {
      post('FILL_RESULT', {
        requestId,
        ok: false,
        code: 'exception',
        error: error?.message || '填入文字时出现异常。'
      });
    }
  }

  function computeAutoUndoValue(current, record) {
    if (!record) return null;
    const next = String(record.nextValue ?? '');
    const previous = String(record.previousValue ?? '');
    const inserted = String(record.insertedText ?? '');
    const currentValue = String(current ?? '');
    const normalize = (value) => value.replace(/\r\n/g, '\n').trim();

    if (currentValue === next) return previous;
    if (normalize(currentValue) === normalize(next)) return previous;

    const cur = currentValue.replace(/\r\n/g, '\n');
    const ins = inserted.replace(/\r\n/g, '\n');
    if (!ins) return null;

    if (record.mode === 'replace') {
      if (normalize(cur) === normalize(ins)) return previous;
      const index = cur.indexOf(ins);
      if (index >= 0 && !normalize(cur.slice(0, index) + cur.slice(index + ins.length))) {
        return previous;
      }
      return null;
    }

    // Smart/append: remove one inserted block and restore the draft when the
    // remainder is still the original draft. This tolerates framework
    // normalization (extra newlines/zero-width spaces) on ChatGPT.
    const index = cur.lastIndexOf(ins);
    if (index < 0) return null;
    let without = cur.slice(0, index) + cur.slice(index + ins.length);
    without = without.replace(/[\u200b-\u200d\ufeff]/g, '');
    if (normalize(without) === normalize(previous)) return previous;
    if (!previous.trim() && !without.trim()) return '';
    return null;
  }

  function handleClearSelection(data) {
    const requestId = data.requestId;
    const id = String(data.selectionId || '');

    try {
      const record = autoSelection;
      if (!record || (id && record.id !== id)) {
        post('CLEAR_SELECTION_RESULT', {
          requestId,
          ok: true,
          cleared: false,
          reason: 'stale'
        });
        return;
      }

      const input = findInput();
      if (!input) {
        autoSelection = null;
        post('CLEAR_SELECTION_RESULT', {
          requestId,
          ok: false,
          cleared: false,
          reason: 'no-input'
        });
        return;
      }

      const kind = isValueInput(input) ? 'value' : 'editable';
      const current = readValue(input, kind);
      const previousValue = computeAutoUndoValue(current, record);

      // If the user edited the input after the auto-fill, never delete their
      // changes; only undo our own untouched insertion.
      if (previousValue === null) {
        autoSelection = null;
        post('CLEAR_SELECTION_RESULT', {
          requestId,
          ok: true,
          cleared: false,
          reason: 'modified'
        });
        return;
      }

      if (kind === 'value') {
        setValueInput(input, previousValue, { focus: false });
      } else {
        setEditableInput(input, previousValue, { focus: false });
      }

      autoSelection = null;
      post('CLEAR_SELECTION_RESULT', {
        requestId,
        ok: true,
        cleared: true,
        valueLength: record.previousValue.length
      });
    } catch (error) {
      post('CLEAR_SELECTION_RESULT', {
        requestId,
        ok: false,
        cleared: false,
        error: error?.message || '撤销划词填入时出现异常。'
      });
    }
  }

  /* ---------------------------------------------------------------- */
  /* Quote selected chat text into the input                          */
  /* ---------------------------------------------------------------- */

  function installQuoteSelection() {
    const schedule = () => {
      clearTimeout(quoteTimer);
      quoteTimer = setTimeout(updateQuoteButton, 120);
    };

    document.addEventListener('mouseup', schedule, true);
    document.addEventListener('keyup', (event) => {
      if (event.key === 'Shift' || event.shiftKey) schedule();
    }, true);
    document.addEventListener('selectionchange', schedule);

    window.addEventListener('scroll', () => hideQuoteButton(), true);
    window.addEventListener('resize', () => hideQuoteButton());

    document.addEventListener('mousedown', (event) => {
      if (quoteHost && event.composedPath().includes(quoteHost)) return;
      hideQuoteButton();
    }, true);
  }

  function updateQuoteButton() {
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed || selection.rangeCount === 0) {
      quoteText = '';
      hideQuoteButton();
      return;
    }

    const text = selection.toString().replace(/\r\n/g, '\n').replace(/\u00a0/g, ' ').trim();
    if (text.length < 2) {
      quoteText = '';
      hideQuoteButton();
      return;
    }

    const anchor = selection.anchorNode;
    const element = anchor?.nodeType === Node.ELEMENT_NODE ? anchor : anchor?.parentElement;
    if (!element) {
      quoteText = '';
      hideQuoteButton();
      return;
    }

    if (element.closest('textarea, input, select, [contenteditable]:not([contenteditable="false"]), [role="textbox"]')) {
      quoteText = '';
      hideQuoteButton();
      return;
    }

    quoteText = text;
    showQuoteButton(selection);
  }

  function createQuoteHost() {
    if (quoteHost) return;

    quoteHost = document.createElement('div');
    quoteHost.id = 'ds-plus-quote-host';
    quoteHost.style.cssText = 'all:initial;position:fixed;z-index:2147483646;display:none;pointer-events:none;';

    const root = quoteHost.attachShadow({ mode: 'open' });
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = '❝ 引用';
    button.title = `引用到 ${CHAT_NAME} 输入框`;
    button.style.cssText = [
      'pointer-events:auto',
      'display:inline-flex',
      'align-items:center',
      'height:32px',
      'padding:0 12px',
      'border:1px solid rgba(255,255,255,.22)',
      'border-radius:999px',
      'background:#4d6bfe',
      'color:#fff',
      'font:500 12px/1 -apple-system,BlinkMacSystemFont,"Segoe UI","Microsoft YaHei",sans-serif',
      'box-shadow:0 6px 20px rgba(0,0,0,.25)',
      'cursor:pointer',
      'white-space:nowrap'
    ].join(';');

    button.addEventListener('mousedown', (event) => {
      event.preventDefault();
      event.stopPropagation();
    });
    button.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      insertQuote(quoteText);
    });

    root.appendChild(button);
    document.documentElement.appendChild(quoteHost);
  }

  function showQuoteButton(selection) {
    createQuoteHost();

    let rect = null;
    try {
      rect = selection.getRangeAt(0).getBoundingClientRect();
    } catch {
      // Fall back to a fixed position.
    }

    const width = 72;
    const height = 34;
    let left = rect && rect.width ? rect.right - width / 2 : window.innerWidth - width - 16;
    let top = rect && rect.height ? rect.bottom + 8 : window.innerHeight - 100;

    if (rect && rect.height && top + height > window.innerHeight - 8) {
      top = rect.top - height - 8;
    }

    left = Math.max(8, Math.min(window.innerWidth - width - 8, left));
    top = Math.max(8, Math.min(window.innerHeight - height - 8, top));

    quoteHost.style.left = `${left}px`;
    quoteHost.style.top = `${top}px`;
    quoteHost.style.display = 'block';
  }

  function hideQuoteButton() {
    if (quoteHost) quoteHost.style.display = 'none';
  }

  function insertQuote(raw) {
    const text = String(raw || '').trim();
    if (!text) return false;

    const input = findInput();
    if (!input) {
      showToast(`没有找到 ${CHAT_NAME} 输入框`);
      return false;
    }

    const kind = isValueInput(input) ? 'value' : 'editable';
    const current = readValue(input, kind);
    const quote = text.split('\n').map((line) => (line.length ? `> ${line}` : '>')).join('\n');
    const next = current.trim()
      ? `${current.replace(/\s+$/, '')}\n\n${quote}\n\n`
      : `${quote}\n\n`;

    if (kind === 'value') setValueInput(input, next);
    else setEditableInput(input, next);

    // A quote is a deliberate edit, not an undoable page selection.
    autoSelection = null;
    quoteText = '';
    hideQuoteButton();
    focusInputEnd(input, kind);
    showToast('已引用到输入框');
    return true;
  }

  function handleGetInputRequest(data) {
    const input = findInput();
    if (!input) {
      post('INPUT_RESULT', {
        requestId: data.requestId,
        ok: false,
        error: `没有找到 ${CHAT_NAME} 输入框`
      });
      return;
    }

    const kind = isValueInput(input) ? 'value' : 'editable';
    post('INPUT_RESULT', {
      requestId: data.requestId,
      ok: true,
      text: readValue(input, kind),
      kind
    });
  }

  function handleQuoteRequest(data) {
    const requestId = data.requestId;
    try {
      const ok = insertQuote(data.text);
      post('QUOTE_RESULT', {
        requestId,
        ok,
        error: ok ? '' : '没有找到 DeepSeek 输入框'
      });
    } catch (error) {
      post('QUOTE_RESULT', {
        requestId,
        ok: false,
        error: error?.message || '引用失败'
      });
    }
  }

  /* ---------------------------------------------------------------- */
  /* Slash-command palette for saved prompts                          */
  /* ---------------------------------------------------------------- */

  function installCommandPalette() {
    document.addEventListener('input', scheduleCommandPalette, true);
    window.addEventListener('keydown', handleCommandKeyDown, true);
    document.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' || event.isComposing) return;
      const selection = window.getSelection();
      if (selection && !selection.isCollapsed) selection.removeAllRanges();
    }, true);

    document.addEventListener('mousedown', (event) => {
      if (commandHost && event.composedPath().includes(commandHost)) return;
      hideCommandPalette();
    }, true);

    window.addEventListener('scroll', () => hideCommandPalette(), true);
    window.addEventListener('resize', () => hideCommandPalette());

    try {
      chrome.storage.onChanged.addListener((changes, area) => {
        if (area === 'local' && changes.promptLibrary) loadPromptCommands();
      });
    } catch {
      // Ignore storage access failures.
    }
  }

  async function loadPromptCommands() {
    try {
      const stored = await chrome.storage.local.get('promptLibrary');
      const raw = stored?.promptLibrary;
      const list = Array.isArray(raw)
        ? raw
        : Array.isArray(raw?.prompts)
          ? raw.prompts
          : Array.isArray(raw?.items)
            ? raw.items
            : [];

      const used = new Set();
      const commands = [];
      for (const item of list) {
        const prompt = normalizeCommandPrompt(item);
        if (!prompt) continue;
        prompt.command = makeUniqueCommand(prompt.command, used);
        used.add(prompt.command);
        commands.push(prompt);
      }
      promptCommands = commands;
      if (commandMatch) renderCommandPalette();
    } catch {
      promptCommands = [];
    }
  }

  function normalizeCommandPrompt(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const text = String(raw.text ?? raw.content ?? '').trim();
    if (!text) return null;

    const name = String(raw.name ?? raw.title ?? '').trim() || text.slice(0, 40).replace(/\s+/g, ' ');
    let command = String(raw.command || '').trim();
    if (!command) command = `/${name.replace(/\s+/g, '-')}`;
    if (!command.startsWith('/')) command = `/${command}`;
    command = command.replace(/\s+/g, '-').replace(/[^\w\u4e00-\u9fa5\-/]/g, '');
    command = `/${command.slice(1).replace(/\//g, '-')}`.slice(0, 40);
    if (command === '/' || command === '/-') return null;

    return {
      name: name.slice(0, 80),
      command,
      text
    };
  }

  function makeUniqueCommand(base, used) {
    const command = base || '/prompt';
    let candidate = command;
    let index = 2;
    while (used.has(candidate)) {
      candidate = `${command}-${index}`;
      index += 1;
    }
    return candidate;
  }

  function scheduleCommandPalette() {
    clearTimeout(commandTimer);
    commandTimer = setTimeout(updateCommandPalette, 90);
  }

  function updateCommandPalette() {
    const input = findInput();
    if (!input) {
      hideCommandPalette();
      return;
    }

    const match = getCommandMatch(input);
    if (!match) {
      hideCommandPalette();
      return;
    }

    commandMatch = match;
    commandIndex = 0;
    renderCommandPalette();
  }

  function getCommandMatch(input) {
    const kind = isValueInput(input) ? 'value' : 'editable';
    const text = readValue(input, kind);
    let before = '';
    let caret = 0;

    if (kind === 'value') {
      if (input.selectionStart !== input.selectionEnd) return null;
      caret = input.selectionStart ?? text.length;
      before = text.slice(0, caret);
    } else {
      const selection = window.getSelection();
      if (!selection || !selection.rangeCount || !selection.isCollapsed) return null;
      const range = selection.getRangeAt(0);
      if (!input.contains(range.startContainer)) return null;
      const beforeRange = document.createRange();
      beforeRange.selectNodeContents(input);
      try {
        beforeRange.setEnd(range.startContainer, range.startOffset);
      } catch {
        return null;
      }
      before = beforeRange.toString();
      caret = before.length;
    }

    const match = before.match(/(^|[\s\n])\/([^\s/]*)$/);
    if (!match) return null;

    const query = match[2];
    const start = caret - query.length - 1;
    if (start < 0) return null;

    return {
      input,
      kind,
      text,
      caret,
      start,
      end: caret,
      query
    };
  }

  function createCommandHost() {
    if (commandHost) return;

    commandHost = document.createElement('div');
    commandHost.id = 'ds-command-host';
    commandHost.style.cssText = 'all:initial;position:fixed;z-index:2147483645;display:none;pointer-events:none;';

    const root = commandHost.attachShadow({ mode: 'open' });
    root.innerHTML = `
      <style>
        * { box-sizing: border-box; }
        .panel {
          overflow: hidden;
          border: 1px solid #d8dde7;
          border-radius: 10px;
          background: #fff;
          color: #1b1f2a;
          box-shadow: 0 12px 32px rgba(15, 23, 42, .25);
          font: 12px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", "Microsoft YaHei", sans-serif;
          pointer-events: auto;
        }
        .head {
          display: flex;
          align-items: baseline;
          justify-content: space-between;
          gap: 8px;
          padding: 7px 10px 6px;
          border-bottom: 1px solid #eef1f5;
        }
        .title { color: #3d63dd; font-size: 10.5px; font-weight: 700; letter-spacing: .05em; text-transform: uppercase; }
        .hint { color: #8a96a8; font-size: 10px; white-space: nowrap; }
        .list { max-height: 132px; overflow: auto; padding: 4px; }
        .item {
          display: block;
          width: 100%;
          padding: 6px 7px;
          border: 0;
          border-radius: 7px;
          background: transparent;
          color: #1b1f2a;
          text-align: left;
          cursor: pointer;
        }
        .item.active { background: #eef2ff; }
        .cmd { color: #3d63dd; font: 11px/1.4 Consolas, "Cascadia Code", monospace; }
        .name { margin-left: 6px; font-size: 12px; font-weight: 600; }
        .preview { border-top: 1px solid #eef1f5; background: #f8faff; padding: 7px 10px; }
        .preview-title { margin-bottom: 3px; color: #3d63dd; font: 10.5px/1.4 Consolas, monospace; }
        .preview-text {
          max-height: 118px;
          overflow: auto;
          color: #445066;
          font-size: 11.5px;
          line-height: 1.55;
          white-space: pre-wrap;
          overflow-wrap: anywhere;
        }
      </style>
      <div class="panel">
        <div class="head"><span class="title">提示词命令</span><span class="hint">↑↓ 选择 · Enter 插入 · Esc 关闭</span></div>
        <div class="list"></div>
        <div class="preview"><div class="preview-title"></div><div class="preview-text"></div></div>
      </div>`;

    document.documentElement.appendChild(commandHost);
  }

  function renderCommandPalette() {
    if (!commandMatch) {
      hideCommandPalette();
      return;
    }

    const query = commandMatch.query.toLowerCase();
    const matches = promptCommands
      .filter((prompt) => {
        if (!query) return true;
        return prompt.command.toLowerCase().includes(query)
          || prompt.name.toLowerCase().includes(query)
          || prompt.text.toLowerCase().includes(query);
      })
      .sort((a, b) => {
        const aStarts = a.command.toLowerCase().startsWith(`/${query}`) ? 0 : 1;
        const bStarts = b.command.toLowerCase().startsWith(`/${query}`) ? 0 : 1;
        return aStarts - bStarts || a.command.localeCompare(b.command);
      })
      .slice(0, 8);

    if (!matches.length) {
      hideCommandPalette();
      return;
    }

    createCommandHost();
    commandItems = matches;
    if (commandIndex >= matches.length) commandIndex = 0;

    const root = commandHost.shadowRoot;
    const list = root.querySelector('.list');
    list.textContent = '';

    matches.forEach((prompt, index) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = `item${index === commandIndex ? ' active' : ''}`;
      button.title = prompt.text;

      const command = document.createElement('span');
      command.className = 'cmd';
      command.textContent = prompt.command;

      const name = document.createElement('span');
      name.className = 'name';
      name.textContent = prompt.name;

      button.appendChild(command);
      button.appendChild(name);
      button.addEventListener('mousedown', (event) => {
        event.preventDefault();
        event.stopPropagation();
      });
      button.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        chooseCommand(index);
      });
      button.addEventListener('mouseenter', () => {
        commandIndex = index;
        updateCommandPreview();
      });
      list.appendChild(button);
    });

    updateCommandPreview();
    positionCommandHost();
    commandHost.style.display = 'block';
  }

  function updateCommandPreview() {
    if (!commandHost) return;
    const root = commandHost.shadowRoot;
    const prompt = commandItems[commandIndex];
    if (!prompt) return;

    const title = root.querySelector('.preview-title');
    const text = root.querySelector('.preview-text');
    if (title) title.textContent = `${prompt.command} · ${prompt.name}`;
    if (text) text.textContent = prompt.text;

    root.querySelectorAll('.item').forEach((item, index) => {
      item.classList.toggle('active', index === commandIndex);
    });
  }

  function positionCommandHost() {
    if (!commandHost || !commandMatch) return;
    const input = commandMatch.input;
    const rect = input.getBoundingClientRect();
    const width = Math.min(420, Math.max(280, rect.width));
    const left = Math.max(8, Math.min(window.innerWidth - width - 8, rect.left));

    commandHost.style.width = `${width}px`;
    commandHost.style.left = `${left}px`;

    if (rect.top > 320) {
      commandHost.style.top = 'auto';
      commandHost.style.bottom = `${Math.max(8, window.innerHeight - rect.top + 8)}px`;
    } else {
      commandHost.style.top = `${Math.min(window.innerHeight - 300, rect.bottom + 8)}px`;
      commandHost.style.bottom = 'auto';
    }
  }

  function handleCommandKeyDown(event) {
    if (event.isComposing || event.keyCode === 229) return;

    const visible = Boolean(commandHost && commandHost.style.display !== 'none');
    const input = visible && commandMatch?.input?.isConnected
      ? commandMatch.input
      : findInput();
    if (!input) return;
    if (!visible && !(event.target === input || input.contains(event.target))) return;

    const wantsEnter = event.key === 'Enter' || event.key === 'Tab';
    const wantsArrow = event.key === 'ArrowDown' || event.key === 'ArrowUp';
    if (!visible && !wantsEnter && !wantsArrow) return;

    const match = getCommandMatch(input);
    if (!match) {
      if (visible && (wantsEnter || wantsArrow)) hideCommandPalette();
      return;
    }

    const query = match.query.toLowerCase();
    const hasPromptMatch = promptCommands.some((prompt) =>
      !query
      || prompt.command.toLowerCase().includes(query)
      || prompt.name.toLowerCase().includes(query)
      || prompt.text.toLowerCase().includes(query)
    );
    if (!hasPromptMatch) {
      // Do not hijack ChatGPT's own slash commands when no saved prompt matches.
      if (visible) hideCommandPalette();
      return;
    }

    if (wantsEnter) {
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
    }

    // ChatGPT/React can intercept the final Enter before the debounced
    // palette is painted. Resolve the match synchronously and stop the
    // native keydown so "/f" inserts the saved prompt instead of being
    // submitted as a chat command.
    if (!visible || wantsEnter) {
      commandMatch = match;
      commandIndex = 0;
      renderCommandPalette();
    }

    if (!commandItems.length) {
      if (visible || wantsEnter) {
        hideCommandPalette();
        showToast('没有匹配的提示词命令');
      }
      return;
    }

    if (wantsArrow) {
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
      const direction = event.key === 'ArrowDown' ? 1 : -1;
      commandIndex = (commandIndex + direction + commandItems.length) % commandItems.length;
      renderCommandPalette();
      return;
    }

    if (wantsEnter) {
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
      chooseCommand(commandIndex);
      return;
    }

    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
      hideCommandPalette();
    }
  }

  function chooseCommand(index) {
    const prompt = commandItems[index];
    if (!prompt || !commandMatch) return;

    const { input, kind, text, start, end } = commandMatch;
    if (!text.slice(start, end).startsWith('/')) {
      hideCommandPalette();
      return;
    }

    const next = `${text.slice(0, start)}${prompt.text}${text.slice(end)}`;
    if (kind === 'value') {
      setValueInput(input, next);
      const caret = start + prompt.text.length;
      try {
        input.setSelectionRange(caret, caret);
      } catch {
        // Ignore.
      }
    } else {
      setEditableInput(input, next);
    }

    autoSelection = null;
    hideCommandPalette();
    showToast(`已插入 ${prompt.command}`);
  }

  function hideCommandPalette() {
    if (commandHost) commandHost.style.display = 'none';
    commandMatch = null;
    commandItems = [];
    commandIndex = 0;
  }

  /* ---------------------------------------------------------------- */
  /* @ mention palette for already-open tabs                          */
  /* ---------------------------------------------------------------- */

  function installMentionPalette() {
    document.addEventListener('input', scheduleMentionPalette, true);
    document.addEventListener('keydown', handleMentionKeyDown, true);

    document.addEventListener('mousedown', (event) => {
      if (mentionHost && event.composedPath().includes(mentionHost)) return;
      hideMentionPalette();
    }, true);

    window.addEventListener('scroll', () => hideMentionPalette(), true);
    window.addEventListener('resize', () => hideMentionPalette());
  }

  function scheduleMentionPalette() {
    clearTimeout(mentionTimer);
    mentionTimer = setTimeout(updateMentionPalette, 90);
  }

  async function updateMentionPalette() {
    const input = findInput();
    if (!input) {
      hideMentionPalette();
      return;
    }

    const match = getMentionMatch(input);
    if (!match) {
      hideMentionPalette();
      return;
    }

    mentionMatch = match;
    hideCommandPalette();
    const requestSeq = ++mentionRequestSeq;
    const cache = await requestTabs();
    if (requestSeq !== mentionRequestSeq || !mentionMatch) return;

    const query = match.query.toLowerCase();
    const tabs = Array.isArray(cache.tabs) ? cache.tabs : [];
    const current = cache.current || null;
    const currentAliases = ['本页', '当前页', '当前', 'current', 'this'];
    const currentMatches = Boolean(current) && (
      !query
      || currentAliases.includes(query)
      || String(current.title || '').toLowerCase().includes(query)
      || String(current.url || '').toLowerCase().includes(query)
    );

    mentionItems = [
      ...(currentMatches ? [current] : []),
      ...tabs.filter((tab) => {
        if (!query) return true;
        return String(tab.title || '').toLowerCase().includes(query)
          || String(tab.url || '').toLowerCase().includes(query);
      })
    ];

    mentionIndex = 0;
    renderMentionPalette();
  }

  function requestTabs() {
    const now = Date.now();
    if (now - mentionCache.at < 1500) return Promise.resolve(mentionCache);

    const requestId = ++mentionSeq;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        pendingTabRequests.delete(requestId);
        resolve({ tabs: [], current: null });
      }, 4000);

      pendingTabRequests.set(requestId, { resolve, timer });
      post('GET_TABS_REQUEST', { requestId });
    });
  }

  function handleTabsResult(data) {
    const pending = pendingTabRequests.get(data.requestId);
    if (!pending) return;
    clearTimeout(pending.timer);
    pendingTabRequests.delete(data.requestId);
    const tabs = Array.isArray(data.tabs) ? data.tabs : [];
    const current = data.current || null;
    mentionCache = { tabs, current, at: Date.now() };
    pending.resolve(mentionCache);
  }

  function getMentionMatch(input) {
    const kind = isValueInput(input) ? 'value' : 'editable';
    const text = readValue(input, kind);
    let before = '';
    let caret = 0;

    if (kind === 'value') {
      if (input.selectionStart !== input.selectionEnd) return null;
      caret = input.selectionStart ?? text.length;
      before = text.slice(0, caret);
    } else {
      const selection = window.getSelection();
      if (!selection || !selection.rangeCount || !selection.isCollapsed) return null;
      const range = selection.getRangeAt(0);
      if (!input.contains(range.startContainer)) return null;
      const beforeRange = document.createRange();
      beforeRange.selectNodeContents(input);
      try {
        beforeRange.setEnd(range.startContainer, range.startOffset);
      } catch {
        return null;
      }
      before = beforeRange.toString();
      caret = before.length;
    }

    const match = before.match(/(^|[\s\n])@([^\s@]*)$/);
    if (!match) return null;

    const query = match[2];
    const start = caret - query.length - 1;
    if (start < 0) return null;

    return { input, kind, text, caret, start, end: caret, query };
  }

  function createMentionHost() {
    if (mentionHost) return;

    mentionHost = document.createElement('div');
    mentionHost.id = 'ds-mention-host';
    mentionHost.style.cssText = 'all:initial;position:fixed;z-index:2147483645;display:none;pointer-events:none;';

    const root = mentionHost.attachShadow({ mode: 'open' });
    root.innerHTML = `
      <style>
        * { box-sizing: border-box; }
        .panel {
          overflow: hidden;
          border: 1px solid #d8dde7;
          border-radius: 10px;
          background: #fff;
          color: #1b1f2a;
          box-shadow: 0 12px 32px rgba(15, 23, 42, .25);
          font: 12px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", "Microsoft YaHei", sans-serif;
          pointer-events: auto;
        }
        .head {
          display: flex;
          align-items: baseline;
          justify-content: space-between;
          gap: 8px;
          padding: 7px 10px 6px;
          border-bottom: 1px solid #eef1f5;
        }
        .title { color: #3d63dd; font-size: 10.5px; font-weight: 700; letter-spacing: .05em; text-transform: uppercase; }
        .hint { color: #8a96a8; font-size: 10px; white-space: nowrap; }
        .list { max-height: 230px; overflow: auto; padding: 4px; }
        .item {
          display: block;
          width: 100%;
          padding: 7px 8px;
          border: 0;
          border-radius: 7px;
          background: transparent;
          color: #1b1f2a;
          text-align: left;
          cursor: pointer;
        }
        .item.active { background: #eef2ff; }
        .item-title { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12px; font-weight: 600; }
        .item-url { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; margin-top: 2px; color: #8a96a8; font-size: 10px; }
        .badge { display: inline-block; margin-left: 6px; padding: 1px 5px; border-radius: 4px; background: #e8edff; color: #3d63dd; font-size: 9px; font-weight: 700; vertical-align: 1px; }
        .badge.current { background: #e6f6ec; color: #1f7a4d; }
      </style>
      <div class="panel">
        <div class="head"><span class="title">打开标签页</span><span class="hint">↑↓ 选择 · Enter 读取 · Esc 关闭</span></div>
        <div class="list"></div>
      </div>`;

    document.documentElement.appendChild(mentionHost);
  }

  function renderMentionPalette() {
    if (!mentionMatch || !mentionItems.length) {
      hideMentionPalette();
      return;
    }

    createMentionHost();
    if (mentionIndex >= mentionItems.length) mentionIndex = 0;

    const root = mentionHost.shadowRoot;
    const list = root.querySelector('.list');
    list.textContent = '';

    mentionItems.forEach((tab, index) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = `item${index === mentionIndex ? ' active' : ''}`;
      button.title = tab.url;

      const title = document.createElement('span');
      title.className = 'item-title';
      title.textContent = tab.title || tab.url;

      if (tab.current) {
        const badge = document.createElement('span');
        badge.className = 'badge current';
        badge.textContent = '当前页';
        title.appendChild(badge);
      }

      if (tab.pdf) {
        const badge = document.createElement('span');
        badge.className = 'badge';
        badge.textContent = 'PDF';
        title.appendChild(badge);
      }

      const url = document.createElement('span');
      url.className = 'item-url';
      url.textContent = tab.url;

      button.appendChild(title);
      button.appendChild(url);
      button.addEventListener('mousedown', (event) => {
        event.preventDefault();
        event.stopPropagation();
      });
      button.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        chooseMention(index);
      });
      button.addEventListener('mouseenter', () => {
        mentionIndex = index;
        updateMentionActive();
      });
      list.appendChild(button);
    });

    updateMentionActive();
    positionMentionHost();
    mentionHost.style.display = 'block';
  }

  function updateMentionActive() {
    if (!mentionHost) return;
    mentionHost.shadowRoot.querySelectorAll('.item').forEach((item, index) => {
      item.classList.toggle('active', index === mentionIndex);
    });
  }

  function positionMentionHost() {
    if (!mentionHost || !mentionMatch) return;
    const rect = mentionMatch.input.getBoundingClientRect();
    const width = Math.min(460, Math.max(280, rect.width));
    const left = Math.max(8, Math.min(window.innerWidth - width - 8, rect.left));

    mentionHost.style.width = `${width}px`;
    mentionHost.style.left = `${left}px`;

    if (rect.top > 330) {
      mentionHost.style.top = 'auto';
      mentionHost.style.bottom = `${Math.max(8, window.innerHeight - rect.top + 8)}px`;
    } else {
      mentionHost.style.top = `${Math.min(window.innerHeight - 320, rect.bottom + 8)}px`;
      mentionHost.style.bottom = 'auto';
    }
  }

  function handleMentionKeyDown(event) {
    if (!mentionHost || mentionHost.style.display === 'none') return;
    if (event.isComposing || event.keyCode === 229) return;

    const input = findInput();
    if (!input) return;
    if (!(event.target === input || input.contains(event.target))) return;

    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      event.stopPropagation();
      const direction = event.key === 'ArrowDown' ? 1 : -1;
      mentionIndex = (mentionIndex + direction + mentionItems.length) % mentionItems.length;
      updateMentionActive();
      return;
    }

    if (event.key === 'Enter' || event.key === 'Tab') {
      event.preventDefault();
      event.stopPropagation();
      chooseMention(mentionIndex);
      return;
    }

    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      hideMentionPalette();
    }
  }

  function chooseMention(index) {
    const tab = mentionItems[index];
    if (!tab || !mentionMatch) return;

    const { input, kind, text, start, end } = mentionMatch;
    if (!text.slice(start, end).startsWith('@')) {
      hideMentionPalette();
      return;
    }

    const next = `${text.slice(0, start)}${text.slice(end)}`;
    if (kind === 'value') {
      setValueInput(input, next);
      try {
        input.setSelectionRange(start, start);
      } catch {
        // Ignore.
      }
    } else {
      setEditableInput(input, next);
    }

    autoSelection = null;
    hideMentionPalette();
    showToast(`正在读取标签页：${tab.title || tab.url}`);
    post('READ_TAB_REQUEST', { tabId: tab.id });
  }

  function hideMentionPalette() {
    if (mentionHost) mentionHost.style.display = 'none';
    mentionMatch = null;
    mentionItems = [];
    mentionIndex = 0;
  }

  function composeValue(current, incoming, mode) {
    const base = String(current || '');
    if (mode === 'replace') return incoming;
    if (mode === 'append') {
      return base.trim() ? `${base.replace(/\s+$/, '')}\n\n${incoming}` : incoming;
    }

    // smart: replace an empty box, remember our own last insert, otherwise append.
    if (!base.trim()) return incoming;
    if (lastInserted && base.endsWith(lastInserted)) {
      const prefix = base.slice(0, base.length - lastInserted.length).replace(/\s+$/, '');
      return prefix ? `${prefix}\n\n${incoming}` : incoming;
    }
    return `${base.replace(/\s+$/, '')}\n\n${incoming}`;
  }

  function isValueInput(element) {
    return element instanceof HTMLTextAreaElement || element instanceof HTMLInputElement;
  }

  function readValue(element, kind) {
    if (kind === 'value') return String(element.value || '');
    return String(element.innerText || element.textContent || '');
  }

  function setValueInput(element, value, { focus = true } = {}) {
    if (focus) element.focus({ preventScroll: true });

    const prototype = element instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype;
    const descriptor = Object.getOwnPropertyDescriptor(prototype, 'value');

    try {
      if (descriptor?.set) descriptor.set.call(element, value);
      else element.value = value;
    } catch {
      element.value = value;
    }

    dispatchInputEvents(element, value);

    if (!focus) return;

    try {
      const length = element.value.length;
      element.setSelectionRange(length, length);
    } catch {
      // Inputs such as number/email do not support selection ranges.
    }

    element.focus({ preventScroll: true });
    try {
      element.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    } catch {
      // Ignore.
    }
  }

  function setEditableInput(element, value, { focus = true } = {}) {
    if (!focus) {
      element.textContent = value;
      dispatchInputEvents(element, value);
      return;
    }

    element.focus({ preventScroll: true });

    const selection = window.getSelection();
    if (selection) {
      const range = document.createRange();
      range.selectNodeContents(element);
      selection.removeAllRanges();
      selection.addRange(range);
    }

    let inserted = false;
    try {
      inserted = document.execCommand('insertText', false, value);
    } catch {
      inserted = false;
    }

    const after = String(element.innerText || element.textContent || '');
    if (!inserted || (value.trim() && !after.includes(value.trim().slice(0, 64)))) {
      element.textContent = value;
      dispatchInputEvents(element, value);
    }

    try {
      const range = document.createRange();
      range.selectNodeContents(element);
      range.collapse(false);
      const activeSelection = window.getSelection();
      activeSelection.removeAllRanges();
      activeSelection.addRange(range);
    } catch {
      // Ignore.
    }

    try {
      element.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    } catch {
      // Ignore.
    }
  }

  function focusInputEnd(element, kind) {
    try {
      element.focus({ preventScroll: true });
      if (kind === 'value') {
        const length = String(element.value || '').length;
        if (typeof element.setSelectionRange === 'function') element.setSelectionRange(length, length);
      } else {
        const range = document.createRange();
        range.selectNodeContents(element);
        range.collapse(false);
        const selection = window.getSelection();
        selection.removeAllRanges();
        selection.addRange(range);
      }
      element.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    } catch {
      // Focus is best-effort; the input may have been re-rendered.
    }
  }

  function sendCurrentMessage() {
    const input = findInput();
    if (!input) return false;
    const kind = isValueInput(input) ? 'value' : 'editable';
    const value = readValue(input, kind).trim();
    if (!value) return false;

    focusInputEnd(input, kind);

    const selectors = [
      '[data-testid="send-button"]',
      'button[aria-label="Send prompt"]',
      'button[aria-label*="Send message"]',
      'button[aria-label*="发送"]',
      'button[aria-label*="Send"]',
      '#send-button',
      'button[data-testid*="send"]',
      'button[class*="send" i]'
    ];
    for (const selector of selectors) {
      for (const button of document.querySelectorAll(selector)) {
        const rect = button.getBoundingClientRect();
        const style = getComputedStyle(button);
        if (rect.width < 1 || rect.height < 1) continue;
        if (style.visibility === 'hidden' || style.display === 'none') continue;
        if (button.disabled || button.getAttribute('aria-disabled') === 'true') continue;
        button.click();
        return true;
      }
    }

    input.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'Enter',
      code: 'Enter',
      keyCode: 13,
      which: 13,
      bubbles: true,
      cancelable: true,
      composed: true
    }));
    input.dispatchEvent(new KeyboardEvent('keyup', {
      key: 'Enter',
      code: 'Enter',
      keyCode: 13,
      which: 13,
      bubbles: true,
      cancelable: true,
      composed: true
    }));
    return true;
  }

  function dispatchInputEvents(element, value) {
    try {
      element.dispatchEvent(new InputEvent('input', {
        bubbles: true,
        composed: true,
        inputType: 'insertText',
        data: value
      }));
    } catch {
      element.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
    }

    try {
      element.dispatchEvent(new Event('change', { bubbles: true }));
    } catch {
      // Ignore.
    }
  }

  function fallbackInsert(element, kind, value) {
    try {
      element.focus({ preventScroll: true });
      if (kind === 'value' && typeof element.select === 'function') element.select();
      else if (kind === 'editable') {
        const range = document.createRange();
        range.selectNodeContents(element);
        const selection = window.getSelection();
        selection.removeAllRanges();
        selection.addRange(range);
      }
      document.execCommand('insertText', false, value);
    } catch {
      // Last resort below.
    }

    const current = readValue(element, kind);
    if (!inputContains(current, value.slice(0, 64))) {
      if (kind === 'value') setValueInput(element, value);
      else {
        element.textContent = value;
        dispatchInputEvents(element, value);
      }
    }
  }

  async function verifyValue(element, kind, expected, delay = 60) {
    await sleep(delay);
    return inputContains(readValue(element, kind), expected);
  }

  function inputContains(actual, expected) {
    if (!expected) return true;
    const a = String(actual || '');
    const b = String(expected || '');
    if (a.includes(b.slice(0, 64))) return true;
    const normalize = (text) => text.replace(/\s+/g, ' ').trim();
    return normalize(a).includes(normalize(b).slice(0, 64));
  }

  /* ---------------------------------------------------------------- */
  /* File attachment (PDF upload → DeepSeek's own parser)             */
  /* ---------------------------------------------------------------- */

  async function handleAttachRequest(data) {
    const requestId = data.requestId;

    try {
      const bytes = data.buffer instanceof ArrayBuffer ? data.buffer : data.buffer?.buffer;
      if (!bytes || !bytes.byteLength) throw new Error('PDF 数据为空。');

      const name = String(data.name || 'document.pdf');
      const file = new File([bytes], name, { type: data.mime || 'application/pdf' });
      let method = '';

      const input = findFileInput(file);
      if (input) {
        const transfer = new DataTransfer();
        transfer.items.add(file);
        input.files = transfer.files;
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
        method = 'input';
      } else {
        const target = findDropTarget();
        if (!target) throw new Error(`没有找到 ${CHAT_NAME} 的文件上传入口。`);

        const transfer = new DataTransfer();
        transfer.items.add(file);
        for (const type of ['dragenter', 'dragover', 'drop']) {
          target.dispatchEvent(new DragEvent(type, {
            bubbles: true,
            cancelable: true,
            dataTransfer: transfer
          }));
        }
        method = 'drop';
      }

      showToast(`已添加 ${name}`);
      try {
        findInput()?.focus({ preventScroll: true });
      } catch {
        // Ignore.
      }

      post('ATTACH_RESULT', {
        requestId,
        ok: true,
        method,
        name: file.name,
        size: file.size
      });
    } catch (error) {
      post('ATTACH_RESULT', {
        requestId,
        ok: false,
        error: error?.message || `无法把文件添加到 ${CHAT_NAME}。`
      });
    }
  }

  function findFileInput(file) {
    const inputs = [];
    for (const root of collectRoots()) {
      try {
        inputs.push(...Array.from(root.querySelectorAll('input[type="file"]')));
      } catch {
        // Ignore.
      }
    }
    const usable = inputs.filter((input) => !input.disabled && !input.closest('[aria-hidden="true"]'));
    const editor = findInput();
    const composer = editor?.closest('form') || editor?.parentElement || null;
    const name = String(file?.name || '').toLowerCase();
    const ext = name.includes('.') ? `.${name.split('.').pop()}` : '';
    const mime = String(file?.type || '').toLowerCase();

    const scored = usable.map((input) => {
      const accept = String(input.accept || '').toLowerCase();
      let score = 0;

      if (ext && accept.includes(ext)) score += 100;
      if (mime && accept.includes(mime)) score += 90;
      if (ext === '.pdf' && accept.includes('pdf')) score += 100;
      if ((ext === '.txt' || ext === '.md') && /(text\/|\.txt|\.md)/.test(accept)) score += 80;
      if (!accept || accept.includes('*/*')) score += 30;
      if (accept.includes('application/octet-stream')) score += 20;
      if (accept.includes('image') && !mime.startsWith('image/')) score -= 50;
      if (composer && composer.contains(input)) score += 40;

      try {
        if (input.getBoundingClientRect().width > 0) score += 5;
      } catch {
        // Ignore.
      }

      return { input, score };
    }).filter((item) => item.score >= 0);

    scored.sort((a, b) => b.score - a.score);
    return scored[0]?.input || null;
  }

  function findDropTarget() {
    const editor = findInput();
    if (editor) return editor.closest('form') || editor.parentElement || editor;
    return document.querySelector('main') || document.body;
  }

  /* ---------------------------------------------------------------- */
  /* Locating the input                                               */
  /* ---------------------------------------------------------------- */

  function waitForInput(timeout) {
    return new Promise((resolve) => {
      const existing = findInput();
      if (existing) {
        resolve(existing);
        return;
      }

      let finished = false;
      const start = Date.now();
      const timer = setInterval(() => {
        const found = findInput();
        if (found) finish(found);
        else if (Date.now() - start > timeout) finish(null);
      }, 320);

      let observer = null;
      try {
        observer = new MutationObserver(() => {
          const found = findInput();
          if (found) finish(found);
        });
        observer.observe(document.documentElement, { childList: true, subtree: true });
      } catch {
        // Ignore.
      }

      function finish(value) {
        if (finished) return;
        finished = true;
        clearInterval(timer);
        try {
          observer?.disconnect();
        } catch {
          // Ignore.
        }
        resolve(value);
      }
    });
  }

  function findInput() {
    const candidates = [];

    for (const root of collectRoots()) {
      let textareas = [];
      try {
        textareas = Array.from(root.querySelectorAll('textarea'));
      } catch {
        continue;
      }
      for (const element of textareas) {
        if (!isUsable(element)) continue;
        candidates.push({ element, score: scoreInput(element, 'textarea') });
      }
    }

    for (const root of collectRoots()) {
      let editables = [];
      try {
        editables = Array.from(root.querySelectorAll(
          '[contenteditable="true"], [contenteditable=""], [contenteditable="plaintext-only"], [role="textbox"]'
        ));
      } catch {
        continue;
      }
      for (const element of editables) {
        if (element.tagName === 'TEXTAREA' || element.tagName === 'INPUT') continue;
        if (!isUsable(element)) continue;
        candidates.push({ element, score: scoreInput(element, 'editable') });
      }
    }

    candidates.sort((a, b) => b.score - a.score);
    return candidates[0]?.element || null;
  }

  function collectRoots() {
    const now = Date.now();
    if (rootsCache && now - rootsCacheAt < 1500) return rootsCache;

    const roots = [document];
    try {
      for (const element of document.querySelectorAll('*')) {
        if (element.shadowRoot) roots.push(element.shadowRoot);
      }
    } catch {
      // Ignore.
    }
    rootsCache = roots;
    rootsCacheAt = now;
    return roots;
  }

  function scoreInput(element, kind) {
    let score = 0;
    const rect = element.getBoundingClientRect();
    score += Math.min(rect.width * rect.height, 200000) / 1000;

    if (kind === 'textarea') score += 500;
    if (kind === 'editable') score += 100;

    if (
      element.id === 'prompt-textarea'
      || element.getAttribute('data-testid') === 'prompt-textarea'
      || element.getAttribute('data-testid') === 'composer-input'
    ) {
      score += 3000;
    }
    if (element.id === 'mobile-composer-prompt') {
      score -= 1200;
    }

    const placeholder = String(element.getAttribute('placeholder') || '').toLowerCase();
    if (placeholder.includes('deepseek') || placeholder.includes('发送') || placeholder.includes('消息') || placeholder.includes('message')) {
      score += 800;
    }

    const ariaLabel = String(element.getAttribute('aria-label') || '').toLowerCase();
    if (ariaLabel.includes('message') || ariaLabel.includes('消息') || ariaLabel.includes('prompt')) {
      score += 300;
    }

    // Chat inputs usually sit near the bottom of the viewport.
    if (rect.bottom > window.innerHeight * 0.55) score += 250;
    if (element.closest('form')) score += 50;
    return score;
  }

  function isUsable(element) {
    if (!element || !element.isConnected) return false;
    if (element.disabled || element.readOnly) return false;
    if (element.closest('[aria-hidden="true"]')) return false;

    const style = window.getComputedStyle(element);
    if (!style || style.display === 'none' || style.visibility === 'hidden') return false;
    if (Number(style.opacity) === 0) return false;

    const rect = element.getBoundingClientRect();
    if (rect.width < 30 || rect.height < 10) return false;
    if (rect.bottom < 0 || rect.top > window.innerHeight + 50) return false;
    return true;
  }

  /* ---------------------------------------------------------------- */
  /* Small feedback toast                                             */
  /* ---------------------------------------------------------------- */

  function showToast(message) {
    try {
      if (!toastHost || !toastHost.isConnected) {
        toastHost = document.createElement('div');
        toastHost.id = 'ds-plus-chat-toast-host';
        toastHost.style.cssText = 'all:initial;position:fixed;right:16px;bottom:100px;z-index:2147483647;pointer-events:none;';
        const root = toastHost.attachShadow({ mode: 'open' });
        root.innerHTML = `
          <style>
            .pill {
              font: 500 12px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", "Microsoft YaHei", sans-serif;
              color: #fff;
              background: rgba(24, 26, 33, .94);
              border: 1px solid rgba(255, 255, 255, .12);
              padding: 8px 12px;
              border-radius: 999px;
              box-shadow: 0 6px 24px rgba(0, 0, 0, .22);
              opacity: 0;
              transform: translateY(6px);
              transition: opacity .18s ease, transform .18s ease;
            }
            .pill.show { opacity: 1; transform: translateY(0); }
          </style>
          <div class="pill" role="status" aria-live="polite"></div>
        `;
        document.documentElement.appendChild(toastHost);
      }

      const pill = toastHost.shadowRoot.querySelector('.pill');
      pill.textContent = message;
      pill.classList.add('show');
      clearTimeout(toastTimer);
      toastTimer = setTimeout(() => pill.classList.remove('show'), 1800);
    } catch {
      // Ignore.
    }
  }

  /* ---------------------------------------------------------------- */
  /* 对话导出(PDF 打印页用)                                             */
  /* ---------------------------------------------------------------- */
  //
  // 只产出**纯数据**:标题、角色、文本/代码/表格块。不复制页面 HTML ——
  // 打印页是扩展自己的页面,网页里的标记不能直接进去。
  // DeepSeek 侧唯一稳定的锚点是 .ds-markdown(助手内容);用户消息按兄弟块推断,
  // 推断失败就退回整页文本,宁可降级也不空手而归。

  const EXPORT_SKIP_TAGS = new Set([
    'BUTTON', 'SVG', 'SCRIPT', 'STYLE', 'NOSCRIPT', 'TEXTAREA', 'INPUT', 'SELECT', 'NAV', 'FORM', 'IFRAME'
  ]);
  const EXPORT_HEADINGS = { H1: 1, H2: 2, H3: 3, H4: 4, H5: 5, H6: 6 };
  // 公式容器:KaTeX / MathJax / DeepSeek 的 ds-markdown-math 都覆盖到。
  const EXPORT_MATH_SELECTOR = '.ds-markdown-math, .ds-markdown-math-display, mjx-container, .katex, math';
  const EXPORT_DISPLAY_MATH_SELECTOR = '.ds-markdown-math-display, .katex-display, mjx-container[display="true"]';

  function matchesMath(element) {
    try {
      return element.matches(EXPORT_MATH_SELECTOR);
    } catch {
      return false;
    }
  }

  // 公式取两样东西:原始 TeX(annotation / alttext)和白名单内的 MathML。
  // 取不到可视化 MathML 时,打印页退回显示 TeX 原文 —— 宁可显示源码,也不能乱码。
  function mathOf(node) {
    const container = node.matches?.('math') ? node : node.querySelector?.('math');
    if (!container) {
      const latex = String(node.getAttribute?.('data-latex') || '').trim();
      return latex ? { tex: latex, mathml: '' } : null;
    }

    const annotation = container.querySelector(
      'annotation[encoding="application/x-tex"], annotation[encoding="TeX"]'
    );
    const tex = String(annotation?.textContent || container.getAttribute('alttext') || '').trim();
    const visual = container.querySelector(
      'mi, mo, mn, mrow, mfrac, msqrt, mroot, msup, msub, mtext, mtable, mover, munder, menclose, mmultiscripts'
    );
    if (!tex && !visual) return null;

    return {
      tex,
      mathml: visual ? String(container.outerHTML || '').slice(0, 60000) : ''
    };
  }

  // 虚拟列表只渲染视口附近的几条消息,所以滚动扫一遍,按消息 key 去重合并。
  async function collectConversation() {
    const debug = exportDebug();
    const scroller = findScroller();
    const restoreTop = scroller ? scroller.scrollTop : 0;
    const merged = new Map();
    let incomplete = false;

    try {
      if (scroller && scroller.scrollHeight > scroller.clientHeight + 80) {
        const steps = Math.min(60, Math.max(8, Math.ceil(scroller.scrollHeight / Math.max(240, scroller.clientHeight)) + 4));
        let lastHeight = scroller.scrollHeight;
        let grew = false;
        for (let step = 0; step < steps; step += 1) {
          const max = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
          scroller.scrollTop = Math.round((max * step) / Math.max(1, steps - 1));
          await sleep(160);
          mergeTurns(merged, snapshotTurns());
          if (scroller.scrollHeight !== lastHeight) {
            grew = true;
            lastHeight = scroller.scrollHeight;
          }
        }
        // 走完还有没加载出来的内容,或最后没真正到底:如实标记可能不完整。
        const atBottom = scroller.scrollTop >= scroller.scrollHeight - scroller.clientHeight - 2;
        incomplete = !atBottom || (grew && steps >= 60);
      } else {
        mergeTurns(merged, snapshotTurns());
      }
    } finally {
      if (scroller) scroller.scrollTop = restoreTop;
    }

    const turns = Array.from(merged.values()).filter((turn) => turn.blocks && turn.blocks.length);
    debug.collectedTurns = turns.length;

    // 用户上传的图片/附件也要进 PDF:能取到字节就内联成 data URL,取不到保留原链接。
    debug.images = await inlineExportMedia(turns);

    if (!turns.length) {
      // 站点改版时不再猜结构:退回整页可见文本,至少给一份可读的 PDF。
      // 同时带上诊断计数,方便下一轮直接照着真实 DOM 修选择器。
      const text = textOf(document.body).slice(0, 200000);
      if (!text) throw new Error('没有找到可导出的对话内容');
      return {
        title: conversationTitle(),
        url: location.href,
        provider: CHAT_NAME,
        turns: [{ role: 'unknown', blocks: [{ type: 'text', text }] }],
        degraded: true,
        incomplete,
        debug
      };
    }

    return {
      title: conversationTitle(),
      url: location.href,
      provider: CHAT_NAME,
      turns,
      degraded: false,
      incomplete,
      debug
    };
  }

  function snapshotTurns() {
    return CHAT_NAME === 'ChatGPT' ? collectChatGptTurns() : collectDeepSeekTurns();
  }

  function mergeTurns(target, turns) {
    for (const turn of turns) {
      const key = turnKey(turn);
      if (!target.has(key)) target.set(key, turn);
    }
  }

  function turnKey(turn) {
    const first = turn.blocks[0];
    const text = String((first && first.text) || first?.rows?.flat?.().join(' ') || '').slice(0, 120);
    return `${turn.role}|${turn.id || ''}|${text}`;
  }

  function findScroller() {
    const candidates =
      CHAT_NAME === 'ChatGPT'
        ? ['main', '[data-scroll-root]', '[class*="scroll"]']
        : ['.ds-virtual-list.ds-scroll-area', '.ds-scroll-area', '[class*="virtual"]', '[class*="scroll"]'];

    for (const selector of candidates) {
      for (const element of Array.from(document.querySelectorAll(selector))) {
        if (element.scrollHeight <= element.clientHeight + 40) continue;
        const overflow = getComputedStyle(element).overflowY;
        if (/(auto|scroll|overlay)/.test(overflow)) return element;
      }
    }
    const fallback = document.scrollingElement;
    return fallback && fallback.scrollHeight > fallback.clientHeight + 40 ? fallback : null;
  }

  // 结构识别的诊断计数。导出降级时由侧边栏打到控制台,不用再让用户翻 DOM。
  function exportDebug() {
    const count = (selector) => {
      try {
        return document.querySelectorAll(selector).length;
      } catch {
        return -1;
      }
    };
    const sample = (selector, limit = 3) => {
      try {
        return Array.from(document.querySelectorAll(selector))
          .slice(0, limit)
          .map((element) => String(element.className || element.getAttribute('data-testid') || element.tagName).slice(0, 80));
      } catch {
        return [];
      }
    };
    const mathMissing = (() => {
      try {
        const nodes = Array.from(document.querySelectorAll(EXPORT_MATH_SELECTOR));
        return nodes.filter((node) => {
          const math = node.matches?.('math') ? node : node.querySelector?.('math');
          if (!math) return true;
          const annotation = math.querySelector('annotation[encoding="application/x-tex"], annotation[encoding="TeX"]');
          return !annotation && !math.getAttribute('alttext');
        }).length;
      } catch {
        return 0;
      }
    })();

    return {
      provider: CHAT_NAME,
      url: location.href,
      authorRoles: count('[data-message-author-role]'),
      userQueries: count('user-query'),
      modelResponses: count('model-response'),
      dsMessages: count('.ds-message'),
      dsAssistant: count('.ds-assistant-message-main-content'),
      markdown: count('.ds-markdown'),
      mathMissing,
      articles: count('article'),
      sample: sample('[data-message-author-role], .ds-message, user-query, model-response, article')
    };
  }

  // ChatGPT(2026 DOM):轮次是 <user-query> / <model-response>;老结构退回气泡/属性。
  function collectChatGptTurns() {
    let nodes = Array.from(document.querySelectorAll('user-query, model-response'));
    if (!nodes.length) {
      nodes = Array.from(
        document.querySelectorAll('[data-user-message-bubble], [data-chatgpt-selection-message-id], [data-message-author-role]')
      );
    }

    return nodes
      .filter((element) => element.getClientRects().length)
      .map((element) => {
        const role = roleOfTurn(element);
        const content =
          role === 'assistant'
            ? element.querySelector('[data-markdown-text-style="assistant-message"]') ||
              element.querySelector('.markdown, .markdown-main-panel') ||
              element
            : element;
        return {
          id: element.getAttribute('data-message-id') || element.getAttribute('data-testid') || '',
          role,
          blocks: blocksOf(content)
        };
      })
      .filter((turn) => turn.blocks.length);
  }

  function roleOfTurn(element) {
    const tag = element.tagName.toLowerCase();
    if (tag === 'user-query') return 'user';
    if (tag === 'model-response') return 'assistant';
    if (element.hasAttribute('data-user-message-bubble')) return 'user';
    if (element.hasAttribute('data-chatgpt-selection-message-id')) return 'assistant';

    const attribute = element.getAttribute('data-message-author-role');
    if (attribute) return attribute === 'user' ? 'user' : 'assistant';

    const inner = element.querySelector('[data-message-author-role]');
    if (inner) return inner.getAttribute('data-message-author-role') === 'user' ? 'user' : 'assistant';

    const heading = String(element.querySelector('h5, h6, h4')?.textContent || '').trim();
    if (/you said|你说|用户/i.test(heading)) return 'user';
    if (/chatgpt said|assistant|助手|deepseek/i.test(heading)) return 'assistant';

    if (element.querySelector('[class*="user-turn"], [class*="user-message"], [data-testid*="user"]')) return 'user';
    return 'assistant';
  }

  function collectDeepSeekTurns() {
    // DeepSeek(2026 DOM):每条消息是 .ds-message;助手消息里再套
    // .ds-assistant-message-main-content / .ds-think-content / .ds-markdown。
    const messages = Array.from(document.querySelectorAll('.ds-message')).filter(
      (element) => element.getClientRects().length
    );
    if (messages.length) {
      return messages.map((element) => {
        const assistantContent = element.querySelector(
          '.ds-assistant-message-main-content, .ds-think-content'
        );
        const markdown =
          element.querySelector('.ds-markdown') ||
          element.querySelector('.ds-assistant-message-main-content') ||
          element;
        return {
          id: element.getAttribute('data-message-id') || element.getAttribute('data-testid') || '',
          role: assistantContent ? 'assistant' : 'user',
          blocks: blocksOf(markdown)
        };
      });
    }

    const marks = Array.from(document.querySelectorAll('.ds-markdown')).filter(
      (element) => element.getClientRects().length
    );
    if (!marks.length) return [];

    const root = marks.length > 1 ? commonAncestor(marks) : findDeepSeekRoot(marks[0]);
    if (!root) return [];

    const turns = [];
    for (const child of Array.from(root.children)) {
      if (child.querySelector('textarea, [contenteditable="true"], input')) continue;

      if (child.querySelector('.ds-markdown')) {
        const blocks = blocksOf(child);
        if (blocks.length) turns.push({ role: 'assistant', blocks });
        continue;
      }

      const text = textOf(child);
      if (text) turns.push({ role: 'user', blocks: [{ type: 'text', text }] });
    }

    // 一层包装的结构会让上面的分类只拿到助手块;这时改成"每个助手块 + 它前面的兄弟文本"。
    if (!turns.some((turn) => turn.role === 'user')) {
      const rebuilt = [];
      for (const mark of marks) {
        let wrapper = mark;
        while (wrapper.parentElement && wrapper.parentElement !== root) wrapper = wrapper.parentElement;
        const previous = wrapper.previousElementSibling;
        const previousText = previous ? textOf(previous) : '';
        if (previousText && !previous.querySelector('.ds-markdown')) {
          rebuilt.push({ role: 'user', blocks: [{ type: 'text', text: previousText }] });
        }
        const blocks = blocksOf(wrapper);
        if (blocks.length) rebuilt.push({ role: 'assistant', blocks });
      }
      if (rebuilt.some((turn) => turn.role === 'user')) return rebuilt;
    }

    return turns;
  }

  function commonAncestor(nodes) {
    let ancestor = nodes[0];
    for (const node of nodes.slice(1)) {
      while (ancestor && !ancestor.contains(node)) ancestor = ancestor.parentElement;
      if (!ancestor) return document.body;
    }
    return ancestor;
  }

  // 单个助手块时,往上找到"同级里还有用户文字"的那一层作为对话容器。
  function findDeepSeekRoot(mark) {
    let node = mark;
    while (node.parentElement && node.parentElement !== document.documentElement) {
      const parent = node.parentElement;
      const hasUserSibling = Array.from(parent.children).some(
        (child) => child !== node && !child.contains(mark) && textOf(child)
      );
      if (hasUserSibling) return parent;
      node = parent;
    }
    return mark.parentElement || document.body;
  }

  function textOf(node) {
    let out = '';
    const walk = (current) => {
      if (current.nodeType === Node.TEXT_NODE) {
        out += current.nodeValue;
        return;
      }
      if (current.nodeType !== Node.ELEMENT_NODE) return;

      const tag = current.tagName;
      if (EXPORT_SKIP_TAGS.has(tag)) return;
      if (current.getAttribute('aria-hidden') === 'true') return;
      if (current.getAttribute('role') === 'button') return;
      if (matchesMath(current)) {
        const math = mathOf(current);
        if (math?.tex) out += ` $${math.tex}$ `;
        else if (math) out += ' [公式] ';
        return;
      }
      if (tag === 'BR') {
        out += '\n';
        return;
      }
      for (const child of current.childNodes) walk(child);
    };
    walk(node);
    return out
      .replace(/\r/g, '')
      .replace(/[ \t]+\n/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  /* 图片内联:最多 20 张、单张 3MB、总计 12MB;超限或取不到就保留原链接。 */
  const EXPORT_IMAGE_LIMIT = 20;
  const EXPORT_IMAGE_BYTES = 3_000_000;
  const EXPORT_IMAGE_TOTAL = 12_000_000;

  async function inlineExportMedia(turns) {
    const images = [];
    for (const turn of turns) {
      for (const block of turn.blocks || []) {
        if (block.type === 'image') images.push(block);
        for (const run of block.runs || []) {
          if (run.type === 'image') images.push(run);
        }
      }
    }

    let count = 0;
    let total = 0;
    const stats = { found: images.length, inlined: 0, skipped: 0 };
    for (const image of images) {
      if (!image.src || count >= EXPORT_IMAGE_LIMIT || total >= EXPORT_IMAGE_TOTAL) {
        stats.skipped += 1;
        continue;
      }
      try {
        const dataUrl = await imageToDataUrl(image.src);
        if (!dataUrl || dataUrl.length > EXPORT_IMAGE_BYTES) {
          stats.skipped += 1;
          continue;
        }
        image.src = dataUrl;
        count += 1;
        total += dataUrl.length;
        stats.inlined += 1;
      } catch {
        // 取不到就保留原链接;打印窗口还会再试一次,都失败则显示 [图片]。
        stats.skipped += 1;
      }
    }
    return stats;
  }

  async function imageToDataUrl(src) {
    if (/^data:/i.test(src)) return src;
    const response = await fetch(src, { credentials: 'include' });
    if (!response.ok) throw new Error(`image ${response.status}`);
    const blob = await response.blob();
    if (!blob.type.startsWith('image/')) return '';

    try {
      // 大图先缩到 1400px,避免 PDF 体积失控。
      const bitmap = await createImageBitmap(blob);
      const scale = Math.min(1, 1400 / Math.max(bitmap.width, bitmap.height));
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(bitmap.width * scale));
      canvas.height = Math.max(1, Math.round(bitmap.height * scale));
      canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      const type = blob.type === 'image/png' ? 'image/png' : 'image/jpeg';
      return canvas.toDataURL(type, 0.86);
    } catch {
      return blobToDataUrl(blob);
    }
  }

  function blobToDataUrl(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result || ''));
      reader.onerror = () => reject(reader.error || new Error('read failed'));
      reader.readAsDataURL(blob);
    });
  }

  function blocksOf(root) {
    const blocks = [];
    const pushText = (type, text, extra = {}) => {
      const value = String(text || '').trim();
      if (value) blocks.push({ type, text: value, ...extra });
    };

    const walk = (container) => {
      for (const child of Array.from(container.children)) {
        const tag = child.tagName;
        if (EXPORT_SKIP_TAGS.has(tag)) continue;

        if (mathesDisplay(child)) {
          const math = mathOf(child);
          if (math) {
            blocks.push({ type: 'math', display: true, tex: math.tex, mathml: math.mathml });
            continue;
          }
        }

        if (tag === 'A') {
          const href = child.getAttribute('href') || '';
          const name = textOf(child).trim();
          if (href && name && name.length <= 120 && /\.(pdf|docx?|xlsx?|pptx?|zip|rar|7z|txt|md|csv|json|png|jpe?g|gif|webp|mp3|mp4|wav)$/i.test(name)) {
            blocks.push({ type: 'file', name, href });
            continue;
          }
        }

        if (tag === 'PRE') {
          const code = child.querySelector('code') || child;
          const className = `${code.className || ''} ${child.className || ''}`;
          const language = (/(?:language|lang)-([\w+#.-]+)/.exec(className) || [])[1] || '';
          pushText('code', code.innerText ?? code.textContent, { language });
          continue;
        }
        if (EXPORT_HEADINGS[tag]) {
          blocks.push(blockWithRuns('heading', child, { level: EXPORT_HEADINGS[tag] }));
          continue;
        }
        if (tag === 'UL' || tag === 'OL') {
          let index = 0;
          for (const item of Array.from(child.children)) {
            if (item.tagName !== 'LI') continue;
            index += 1;
            blocks.push(blockWithRuns('list', item, { ordered: tag === 'OL', index }));
          }
          continue;
        }
        if (tag === 'BLOCKQUOTE') {
          blocks.push(blockWithRuns('quote', child));
          continue;
        }
        if (tag === 'TABLE') {
          const rows = [];
          for (const row of Array.from(child.querySelectorAll('tr'))) {
            const cells = Array.from(row.children)
              .filter((cell) => cell.tagName === 'TD' || cell.tagName === 'TH')
              .map((cell) => textOf(cell).replace(/\n+/g, ' '));
            if (cells.length) rows.push(cells);
          }
          if (rows.length) blocks.push({ type: 'table', rows });
          continue;
        }
        if (tag === 'HR') {
          blocks.push({ type: 'hr' });
          continue;
        }
        if (tag === 'FIGURE') {
          const image = child.querySelector('img');
          if (image) {
            const caption = child.querySelector('figcaption');
            blocks.push({
              type: 'image',
              src: image.currentSrc || image.src || '',
              alt: (caption?.innerText || image.alt || '').trim(),
              width: image.naturalWidth || 0,
              height: image.naturalHeight || 0
            });
            continue;
          }
        }
        if (tag === 'IMG') {
          blocks.push({
            type: 'image',
            src: child.currentSrc || child.src || child.getAttribute('src') || '',
            alt: (child.getAttribute('alt') || '').trim(),
            width: child.naturalWidth || 0,
            height: child.naturalHeight || 0
          });
          continue;
        }

        const blockChildren = Array.from(child.children).some((node) =>
          /^(P|UL|OL|PRE|BLOCKQUOTE|TABLE|H[1-6]|DIV|SECTION|ARTICLE|DETAILS|SUMMARY)$/.test(node.tagName)
        );
        if (!blockChildren) {
          const runs = runsOf(child);
          if (runs.some((run) => run.type === 'math' || run.type === 'image' || run.type === 'file')) {
            blocks.push({ type: 'text', runs });
          } else {
            pushText('text', textOf(child));
          }
          continue;
        }
        walk(child);
      }
    };

    walk(root);
    if (!blocks.length) {
      const text = textOf(root);
      if (text) blocks.push({ type: 'text', text });
    }
    return blocks;
  }

  function mathesDisplay(element) {
    try {
      return element.matches(EXPORT_DISPLAY_MATH_SELECTOR);
    } catch {
      return false;
    }
  }

  // 标题 / 列表项 / 引用里也可能有行内公式:有公式就记 runs,没有就退回纯文本。
  function blockWithRuns(type, element, extra = {}) {
    const runs = runsOf(element);
    if (runs.some((run) => run.type === 'math')) return { type, runs, ...extra };
    return { type, text: textOf(element), ...extra };
  }

  // 段落里的行内公式:把文字与公式拆成 runs,打印页才能既保留文字又排版公式。
  function runsOf(node) {
    const runs = [];
    let buffer = '';
    const flush = () => {
      if (buffer.trim()) runs.push({ type: 'text', text: buffer });
      buffer = '';
    };

    const walk = (current) => {
      if (current.nodeType === Node.TEXT_NODE) {
        buffer += current.nodeValue;
        return;
      }
      if (current.nodeType !== Node.ELEMENT_NODE) return;

      const tag = current.tagName;
      if (EXPORT_SKIP_TAGS.has(tag)) return;
      if (current.getAttribute('aria-hidden') === 'true') return;
      if (current.getAttribute('role') === 'button') return;
      if (tag === 'BR') {
        buffer += '\n';
        return;
      }
      if (matchesMath(current)) {
        const math = mathOf(current);
        if (math) {
          flush();
          runs.push({ type: 'math', tex: math.tex, mathml: math.mathml });
        }
        return;
      }
      if (tag === 'IMG') {
        flush();
        runs.push({
          type: 'image',
          src: current.currentSrc || current.src || current.getAttribute('src') || '',
          alt: (current.getAttribute('alt') || '').trim(),
          width: current.naturalWidth || 0,
          height: current.naturalHeight || 0
        });
        return;
      }
      for (const child of current.childNodes) walk(child);
    };

    walk(node);
    flush();

    if (runs.length) {
      const first = runs[0];
      if (first.type === 'text') first.text = first.text.replace(/^\s+/, '');
      const last = runs[runs.length - 1];
      if (last.type === 'text') last.text = last.text.replace(/\s+$/, '');
    }
    return runs.filter(
      (run) => run.type === 'math' || run.type === 'image' || run.type === 'file' || String(run.text || '').trim()
    );
  }

  function conversationTitle() {
    const selectors = ['[data-testid="conversation-title"]', 'header h1', 'main h1', 'h1'];
    for (const selector of selectors) {
      const text = String(document.querySelector(selector)?.textContent || '').trim();
      if (text && text.length <= 120) return text;
    }
    const fromDocument = String(document.title || '').split(/\s[|\-–—]\s/)[0].trim();
    return fromDocument || CHAT_NAME;
  }

  function formatChars(count) {
    if (count < 1000) return `${count} 字`;
    return `${(count / 1000).toFixed(count < 10000 ? 1 : 0)}k 字`;
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
})();
