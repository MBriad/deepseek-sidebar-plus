/* 会话 PDF 打印页。
 *
 * 数据来源:侧边栏把「导出 PDF」读到的对话放在内存里,经 runtime 消息交过来。
 * 不落盘,侧边栏关掉就取不到 —— 所以这里失败时要给人话,而不是白屏。
 *
 * 输出方式:浏览器原生打印(用户选“另存为 PDF”)。不引入 PDF 库是为了
 * 中文可选中、体积小;代价是必须经过打印对话框。
 */

const docEl = document.getElementById('doc');
const titleEl = document.getElementById('doc-title');
const metaEl = document.getElementById('doc-meta');
const hintEl = document.getElementById('print-hint');
const printButton = document.getElementById('btn-print');
const closeButton = document.getElementById('btn-close');
const filtersEl = document.getElementById('doc-filters');

let payload = null;
let filter = 'all';

// 关闭按钮在**所有**状态下都要能用,包括失败页,所以放在模块级注册。
closeButton.addEventListener('click', () => {
  try {
    window.close();
  } catch {
    // Ignore.
  }
});

start().catch((error) => {
  showFailure(`打印页出错:${error?.message || error}`);
});

async function start() {
  payload = await loadPayload();
  if (!payload) {
    showFailure('没有可打印的对话,请回到侧边栏重新点击「导出 PDF」。');
    return;
  }

  render();
  const title = payload.title || '对话';
  // 文件名默认取会话标题;标题等于站点名时不再拼一遍。
  document.title = payload.provider && payload.provider !== title ? `${title} - ${payload.provider}` : title;

  bindFilters();
  printButton.addEventListener('click', () => {
    try {
      window.print();
    } catch {
      // 打印被拒绝时按钮仍可再点。
    }
  });

  // 打开即弹打印对话框;失败也不影响手动点按钮。
  setTimeout(() => {
    try {
      window.print();
    } catch {
      // Ignore.
    }
  }, 350);
}

async function loadPayload() {
  // 侧边栏可能刚好在重建监听,重试几次再报错。
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const response = await askSidebar();
    if (response?.ok && response.payload) return response.payload;
    if (response && response.ok === false && response.error) {
      // 明确被告知没有数据时不再重试。
      return null;
    }
    await sleep(150);
  }
  return null;
}

function askSidebar() {
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage({ type: 'DS_GET_PRINT_PAYLOAD' }, (response) => {
        void chrome.runtime.lastError;
        resolve(response || null);
      });
    } catch {
      resolve(null);
    }
  });
}

function showFailure(message) {
  titleEl.textContent = '无法导出';
  metaEl.textContent = '';
  hintEl.textContent = message;
  printButton.disabled = true;
  filtersEl.hidden = true;
}

function bindFilters() {
  for (const button of filtersEl.querySelectorAll('[data-filter]')) {
    button.addEventListener('click', () => {
      filter = button.dataset.filter || 'all';
      for (const other of filtersEl.querySelectorAll('[data-filter]')) {
        other.classList.toggle('active', other === button);
      }
      render();
    });
  }
}

function render() {
  const turns = Array.isArray(payload.turns) ? payload.turns : [];
  const counts = {
    all: turns.length,
    user: turns.filter((turn) => turn.role === 'user').length,
    assistant: turns.filter((turn) => turn.role === 'assistant').length
  };
  for (const button of filtersEl.querySelectorAll('[data-filter]')) {
    const key = button.dataset.filter || 'all';
    button.textContent = `${filterLabel(key)} ${counts[key] ?? 0}`;
    button.classList.toggle('active', key === filter);
  }

  docEl.textContent = '';
  titleEl.textContent = payload.title || '对话';
  metaEl.textContent = [payload.provider, formatTime(payload.exportedAt), `${turns.length} 条消息`]
    .filter(Boolean)
    .join(' · ');

  if (payload.degraded || payload.truncated) {
    const notice = document.createElement('p');
    notice.className = 'notice';
    if (payload.degraded) {
      const debug = payload.debug || {};
      notice.textContent =
        `没能识别出对话结构,已按整页文本导出;内容可能包含页面导航。` +
        `诊断:[data-message-author-role]=${debug.authorRoles ?? '?'}, ` +
        `.ds-message=${debug.dsMessages ?? '?'}, .ds-markdown=${debug.markdown ?? '?'}, ` +
        `article=${debug.articles ?? '?'}。`;
    } else {
      notice.textContent = '对话过长,已截断到可打印范围。';
    }
    docEl.appendChild(notice);
  }

  const cover = document.createElement('section');
  cover.className = 'cover';
  const heading = document.createElement('h1');
  heading.textContent = payload.title || '对话';
  const source = document.createElement('p');
  source.className = 'cover-source';
  source.textContent = [payload.provider, payload.url].filter(Boolean).join(' · ');
  cover.append(heading, source);
  docEl.appendChild(cover);

  const visible = turns.filter((turn) => {
    if (filter === 'all') return true;
    // 降级导出的整页文本没有角色,不被筛选吞掉。
    return turn.role === filter || turn.role === 'unknown';
  });

  if (!visible.length) {
    const empty = document.createElement('p');
    empty.className = 'notice';
    empty.textContent = '没有符合筛选的消息。';
    docEl.appendChild(empty);
    return;
  }

  for (const turn of visible) {
    const section = document.createElement('section');
    section.className = `turn turn-${turn.role || 'unknown'}`;
    const label = document.createElement('div');
    label.className = 'turn-label';
    label.textContent = roleLabel(turn.role);
    section.appendChild(label);
    for (const block of Array.isArray(turn.blocks) ? turn.blocks : []) {
      section.appendChild(renderBlock(block));
    }
    docEl.appendChild(section);
  }
}

function filterLabel(key) {
  if (key === 'user') return '只看用户';
  if (key === 'assistant') return '只看助手';
  return '全部';
}

function roleLabel(role) {
  if (role === 'user') return '用户';
  if (role === 'assistant') return '助手';
  return '内容';
}

function renderBlock(block) {
  const node = (tag, className, text) => {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (text !== undefined) element.textContent = text;
    return element;
  };

  switch (block?.type) {
    case 'heading': {
      const level = Math.min(6, Math.max(2, Number(block.level) + 1 || 2));
      return node(`h${level}`, 'block-heading', block.text);
    }
    case 'code': {
      const pre = node('pre', 'block-code');
      pre.appendChild(node('code', '', block.text));
      return pre;
    }
    case 'list': {
      const marker = block.ordered ? `${Number(block.index) || 1}.` : '•';
      return node('div', 'block-list-item', `${marker} ${block.text}`);
    }
    case 'quote':
      return node('blockquote', 'block-quote', block.text);
    case 'hr':
      return node('hr', '');
    case 'table': {
      const table = node('table', 'block-table');
      for (const row of Array.isArray(block.rows) ? block.rows : []) {
        const tr = document.createElement('tr');
        for (const cell of Array.isArray(row) ? row : []) {
          tr.appendChild(node('td', '', cell));
        }
        table.appendChild(tr);
      }
      return table;
    }
    default:
      return node('p', 'block-text', block?.text);
  }
}

function formatTime(value) {
  const date = new Date(Number(value) || Date.now());
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleString();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
