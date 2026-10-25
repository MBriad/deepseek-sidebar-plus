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
  let lastInserted = '';
  let autoSelection = null;
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
  let rootsCache = null;
  let rootsCacheAt = 0;

  window.addEventListener('message', onMessage);
  installQuoteSelection();
  installCommandPalette();
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
        error: '请先在侧边栏中登录 DeepSeek，然后再试一次。'
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
          error: '没有找到 DeepSeek 输入框，请确认已经登录并等待页面加载完成。'
        });
        return;
      }

      const kind = isValueInput(input) ? 'value' : 'editable';
      const current = readValue(input, kind);
      // If the input still contains exactly the previous auto-fill, undo
      // should go back to the draft before that fill, not to the previous
      // selection text.
      const previousValue = previousAuto && current === previousAuto.nextValue
        ? previousAuto.previousValue
        : current;
      const mode = ['replace', 'append', 'smart'].includes(data.mode) ? data.mode : 'smart';
      const next = composeValue(current, incoming, mode);

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
            nextValue: finalValue
          };
        }
        showToast(`已填入 ${formatChars(incoming.length)}`);
      }

      post('FILL_RESULT', {
        requestId,
        ok: success,
        code: success ? 'ok' : 'not-applied',
        error: success ? '' : '文字已写入，但 DeepSeek 输入框没有接收，请手动粘贴。',
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

      // If the user edited the input after the auto-fill, never delete their
      // changes; only undo our own untouched insertion.
      if (current !== record.nextValue) {
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
        setValueInput(input, record.previousValue, { focus: false });
      } else {
        setEditableInput(input, record.previousValue, { focus: false });
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
    button.title = '引用到 DeepSeek 输入框';
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
      showToast('没有找到 DeepSeek 输入框');
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
    showToast('已引用到输入框');
    return true;
  }

  function handleGetInputRequest(data) {
    const input = findInput();
    if (!input) {
      post('INPUT_RESULT', {
        requestId: data.requestId,
        ok: false,
        error: '没有找到 DeepSeek 输入框'
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
    document.addEventListener('keydown', handleCommandKeyDown, true);

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
    if (!commandHost || commandHost.style.display === 'none') return;
    if (event.isComposing || event.keyCode === 229) return;

    const input = findInput();
    if (!input) return;
    if (!(event.target === input || input.contains(event.target))) return;

    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      event.stopPropagation();
      const direction = event.key === 'ArrowDown' ? 1 : -1;
      commandIndex = (commandIndex + direction + commandItems.length) % commandItems.length;
      renderCommandPalette();
      return;
    }

    if (event.key === 'Enter' || event.key === 'Tab') {
      event.preventDefault();
      event.stopPropagation();
      chooseCommand(commandIndex);
      return;
    }

    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
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
        if (!target) throw new Error('没有找到 DeepSeek 的文件上传入口。');

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
        error: error?.message || '无法把文件添加到 DeepSeek。'
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

    if (!candidates.length) {
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

  function formatChars(count) {
    if (count < 1000) return `${count} 字`;
    return `${(count / 1000).toFixed(count < 10000 ? 1 : 0)}k 字`;
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
})();
