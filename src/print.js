/* 会话 PDF 打印页 —— 屏幕上可勾选/调字号,打印时是纸面文档。
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
const countEl = document.getElementById('sel-count');
const selAllButton = document.getElementById('sel-all');
const selUserButton = document.getElementById('sel-user');
const selAssistantButton = document.getElementById('sel-assistant');
const fontInput = document.getElementById('font-size');
const fontValue = document.getElementById('font-size-value');

// 侧边栏用隐藏 iframe 加载本页(embed=1):数据从父页面 postMessage 来,不显示工具栏。
const EMBEDDED = new URLSearchParams(location.search).get('embed') === '1';
let roleNames = { user: '用户', assistant: '助手' };

const MATHML_NAMESPACE = 'http://www.w3.org/1998/Math/MathML';
const MATHML_TAGS = new Set([
  'math', 'mrow', 'mi', 'mo', 'mn', 'mtext', 'ms', 'mspace', 'msup', 'msub', 'msubsup', 'mfrac',
  'msqrt', 'mroot', 'mstyle', 'mtable', 'mtr', 'mtd', 'munder', 'mover', 'munderover',
  'mmultiscripts', 'mprescripts', 'none', 'mphantom', 'menclose', 'merror', 'semantics', 'annotation'
]);
const MATHML_ATTRS = new Set([
  'display', 'mathvariant', 'scriptlevel', 'displaystyle', 'stretchy', 'fence', 'separator',
  'lspace', 'rspace', 'columnalign', 'rowalign', 'columnspan', 'rowspan', 'linethickness',
  'notation', 'encoding', 'mathsize', 'mathcolor', 'mathbackground', 'width', 'height', 'depth',
  'voffset', 'movablelimits', 'largeop', 'accent', 'accentunder', 'form'
]);

let payload = null;
let selected = new Set();

// 关闭按钮在**所有**状态下都要能用,包括失败页,所以放在模块级注册。
closeButton.addEventListener('click', () => {
  try {
    window.close();
  } catch {
    // Ignore.
  }
});

fontInput.addEventListener('input', applyFontSize);
applyFontSize();

if (EMBEDDED) {
  startEmbedded();
} else {
  start().catch((error) => {
    showFailure(`打印页出错:${error?.message || error}`);
  });
}

// 嵌入模式:等父页面把 payload 传进来,渲染完直接打印,不显示任何工具栏。
function startEmbedded() {
  document.body.classList.add('embed');
  window.addEventListener('message', (event) => {
    if (event.origin !== location.origin) return;
    const data = event.data;
    if (!data || data.type !== 'DS_PRINT_PAYLOAD') return;

    const options = data.options || {};
    roleNames = {
      user: options.userLabel || '用户',
      assistant: options.aiLabel || '助手'
    };
    if (options.fontPt) {
      fontInput.value = String(options.fontPt);
      applyFontSize();
    }

    payload = data.payload;
    render();

    const title = payload.title || '对话';
    document.title = payload.provider && payload.provider !== title ? `${title} - ${payload.provider}` : title;

    window.addEventListener(
      'afterprint',
      () => {
        try {
          window.parent.postMessage({ type: 'DS_PRINT_DONE' }, location.origin);
        } catch {
          // Ignore.
        }
      },
      { once: true }
    );

    setTimeout(() => {
      try {
        window.print();
      } catch {
        // Ignore.
      }
    }, 120);
  });
}

function applyFontSize() {
  const size = Math.min(20, Math.max(9, Number(fontInput.value) || 13));
  document.documentElement.style.setProperty('--base-font', `${size}pt`);
  fontValue.textContent = `${size}pt`;
}

async function start() {
  payload = await loadPayload();
  if (!payload) {
    showFailure('没有可打印的对话,请回到侧边栏重新点击「导出 PDF」。');
    return;
  }

  const turns = payload.turns || [];
  selected = new Set(turns.map((_, index) => index));

  render();
  refreshSelectionUI();

  const title = payload.title || '对话';
  document.title = payload.provider && payload.provider !== title ? `${title} - ${payload.provider}` : title;

  selAllButton.addEventListener('click', () => applyPreset('all'));
  selUserButton.addEventListener('click', () => applyPreset('user'));
  selAssistantButton.addEventListener('click', () => applyPreset('assistant'));
  printButton.addEventListener('click', () => {
    try {
      window.print();
    } catch {
      // 打印被拒绝时按钮仍可再点。
    }
  });

  // 打开即弹打印对话框;失败也不影响手动点按钮。
  setTimeout(() => {
    if (!selected.size) return;
    try {
      window.print();
    } catch {
      // Ignore.
    }
  }, 350);
}

function applyPreset(mode) {
  const turns = payload?.turns || [];
  selected = new Set();
  turns.forEach((turn, index) => {
    if (mode === 'all') selected.add(index);
    if (mode === 'user' && turn.role === 'user') selected.add(index);
    if (mode === 'assistant' && turn.role === 'assistant') selected.add(index);
  });
  markPreset(mode);
  render();
  refreshSelectionUI();
}

function markPreset(mode) {
  selAllButton.classList.toggle('active', mode === 'all');
  selUserButton.classList.toggle('active', mode === 'user');
  selAssistantButton.classList.toggle('active', mode === 'assistant');
}

function refreshSelectionUI() {
  const turns = payload?.turns || [];
  const count = selected.size;
  countEl.textContent = `已选择 ${count} / ${turns.length} 条`;
  printButton.disabled = count === 0;
  printButton.title = count === 0 ? '先勾选至少一条消息' : '';
  hintEl.textContent = count
    ? '在打印对话框里选择“另存为 PDF”。取消勾选的消息不会出现在 PDF 里。'
    : '还没有勾选任何消息。用上方的「全选 / 仅选用户 / 仅选模型」或逐条勾选。';
  if (count === 0) markPreset('');
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
  document.querySelector('.selection').hidden = true;
}

function render() {
  const turns = payload.turns || [];
  const stats = summarize(turns);

  docEl.textContent = '';
  titleEl.textContent = payload.title || '对话';
  metaEl.textContent = [payload.provider, formatTime(payload.exportedAt), `${turns.length} 条消息`]
    .filter(Boolean)
    .join(' · ');

  docEl.appendChild(renderCover(turns, stats));

  if (payload.degraded || payload.truncated || payload.incomplete) {
    const notice = document.createElement('p');
    notice.className = 'notice';
    if (payload.degraded) {
      const debug = payload.debug || {};
      notice.textContent =
        `未能识别出对话结构,已按整页文本导出;内容可能包含页面导航。` +
        `诊断:[data-message-author-role]=${debug.authorRoles ?? '?'}, ` +
        `.ds-message=${debug.dsMessages ?? '?'}, .ds-markdown=${debug.markdown ?? '?'}, ` +
        `user-query=${debug.userQueries ?? '?'}, model-response=${debug.modelResponses ?? '?'}。`;
    } else if (payload.incomplete) {
      notice.textContent = '此次导出可能不完整:未能确认对话的起点、终点或消息顺序。';
    } else {
      notice.textContent = '对话过长,已截断到可打印范围。';
    }
    docEl.appendChild(notice);
  }

  // 取不到 TeX/MathML 的公式只可能显示成 [公式];如实提示,不静默糊弄。
  if (payload.debug?.mathMissing) {
    const mathNotice = document.createElement('p');
    mathNotice.className = 'notice';
    mathNotice.textContent = `有 ${payload.debug.mathMissing} 处公式没能取到 TeX/MathML,已标成 [公式]。`;
    docEl.appendChild(mathNotice);
  }

  const list = document.createElement('section');
  list.className = 'turns';
  turns.forEach((turn, index) => {
    list.appendChild(renderTurn(turn, index));
  });
  docEl.appendChild(list);
}

function summarize(turns) {
  let users = 0;
  let assistants = 0;
  let codes = 0;
  let math = 0;
  for (const turn of turns) {
    if (turn.role === 'user') users += 1;
    if (turn.role === 'assistant') assistants += 1;
    for (const block of turn.blocks || []) {
      if (block.type === 'code') codes += 1;
      if (block.type === 'math') math += 1;
      if (Array.isArray(block.runs)) math += block.runs.filter((run) => run.type === 'math').length;
    }
  }
  return { users, assistants, codes, math };
}

function renderCover(turns, stats) {
  const cover = document.createElement('section');
  cover.className = 'cover';

  const eyebrow = document.createElement('p');
  eyebrow.className = 'cover-eyebrow';
  eyebrow.textContent = `${payload.provider || '对话'} · 对话导出`;

  const heading = document.createElement('h1');
  heading.textContent = payload.title || '对话';

  const subtitle = document.createElement('p');
  subtitle.className = 'cover-subtitle';
  subtitle.textContent = `导出于 ${formatTime(payload.exportedAt)} · 共 ${turns.length} 条消息`;

  const meta = document.createElement('dl');
  meta.className = 'cover-meta';
  const rows = [
    ['来源', payload.provider || ''],
    ['会话', payload.url || ''],
    ['统计', `${roleNames.user} ${stats.users} 条 · ${roleNames.assistant} ${stats.assistants} 条 · 代码块 ${stats.codes} 个 · 公式 ${stats.math} 处`]
  ];
  for (const [label, value] of rows) {
    if (!value) continue;
    const dt = document.createElement('dt');
    dt.textContent = label;
    const dd = document.createElement('dd');
    dd.textContent = value;
    meta.append(dt, dd);
  }

  cover.append(eyebrow, heading, subtitle, meta);
  return cover;
}

function renderTurn(turn, index) {
  const section = document.createElement('section');
  section.className = `turn turn-${turn.role || 'unknown'}`;
  section.dataset.index = String(index);

  const label = document.createElement('div');
  label.className = 'turn-label';

  const text = document.createElement('span');
  text.textContent = `T${index + 1} · ${roleLabel(turn.role)}`;

  if (EMBEDDED) {
    label.append(text);
  } else {
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.className = 'turn-select no-print';
    checkbox.checked = selected.has(index);
    checkbox.title = '勾选后才会出现在 PDF 里';
    checkbox.addEventListener('change', () => {
      if (checkbox.checked) selected.add(index);
      else selected.delete(index);
      section.classList.toggle('turn-off', !checkbox.checked);
      refreshSelectionUI();
    });
    section.classList.toggle('turn-off', !checkbox.checked);
    label.append(checkbox, text);
  }

  section.appendChild(label);

  for (const block of Array.isArray(turn.blocks) ? turn.blocks : []) {
    section.appendChild(renderBlock(block));
  }
  return section;
}

function roleLabel(role) {
  if (role === 'user') return roleNames.user;
  if (role === 'assistant') return roleNames.assistant;
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
      const heading = node(`h${level}`, 'block-heading');
      if (!appendRuns(heading, block)) heading.textContent = block.text;
      return heading;
    }
    case 'code': {
      const figure = node('figure', 'block-code');
      if (block.language) {
        const caption = node('figcaption', 'block-code-lang', String(block.language).toUpperCase());
        figure.appendChild(caption);
      }
      const pre = node('pre', '');
      pre.appendChild(node('code', '', block.text));
      figure.appendChild(pre);
      return figure;
    }
    case 'math':
      return renderMathBlock(block);
    case 'list': {
      const marker = block.ordered ? `${Number(block.index) || 1}.` : '•';
      const item = node('div', 'block-list-item');
      item.appendChild(node('span', 'list-marker', marker));
      if (!appendRuns(item, block)) item.appendChild(document.createTextNode(block.text || ''));
      return item;
    }
    case 'quote': {
      const quote = node('blockquote', 'block-quote');
      if (!appendRuns(quote, block)) quote.textContent = block.text;
      return quote;
    }
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
      if (Array.isArray(block?.runs)) return renderRuns(block);
      return node('p', 'block-text', block?.text);
  }
}

function renderRuns(block) {
  const paragraph = document.createElement('p');
  paragraph.className = 'block-text';
  appendRuns(paragraph, block);
  return paragraph;
}

// 把 text / inline math 的 runs 追加到任意容器;没有 runs 时返回 false,由调用方退回纯文本。
function appendRuns(parent, block) {
  if (!Array.isArray(block?.runs)) return false;
  for (const run of block.runs) {
    if (run.type === 'math') parent.appendChild(renderInlineMath(run));
    else parent.appendChild(document.createTextNode(String(run.text || '')));
  }
  return true;
}

function renderMathBlock(block) {
  const wrapper = document.createElement('div');
  wrapper.className = 'block-math';
  const math = sanitizeMathml(block.mathml);
  if (math) {
    math.setAttribute('display', 'block');
    wrapper.appendChild(math);
    return wrapper;
  }
  wrapper.classList.add('block-math-tex');
  wrapper.textContent = block.tex ? `$${block.tex}$` : '[公式]';
  return wrapper;
}

function renderInlineMath(block) {
  const math = sanitizeMathml(block.mathml);
  if (math) {
    math.setAttribute('display', 'inline');
    return math;
  }
  const span = document.createElement('span');
  span.className = 'block-math-inline';
  span.textContent = block.tex ? `$${block.tex}$` : '[公式]';
  return span;
}

// MathML 来自网页,属于不可信输入:只保留白名单标签/属性,文字节点重建成文本。
function sanitizeMathml(markup) {
  if (!markup) return null;
  let parsed;
  try {
    parsed = new DOMParser().parseFromString(markup, 'text/html');
  } catch {
    return null;
  }
  const source = parsed.querySelector('math');
  if (!source) return null;
  const root = document.createElementNS(MATHML_NAMESPACE, 'math');
  copyMath(source, root);
  return root.childNodes.length ? root : null;
}

function copyMath(from, to) {
  for (const child of from.childNodes) {
    if (child.nodeType === Node.TEXT_NODE) {
      to.appendChild(document.createTextNode(child.nodeValue));
      continue;
    }
    if (child.nodeType !== Node.ELEMENT_NODE) continue;
    const tag = child.tagName.toLowerCase();
    if (!MATHML_TAGS.has(tag)) continue;
    const element = document.createElementNS(MATHML_NAMESPACE, tag);
    for (const attribute of child.attributes) {
      if (MATHML_ATTRS.has(attribute.name.toLowerCase())) {
        element.setAttribute(attribute.name, attribute.value);
      }
    }
    copyMath(child, element);
    to.appendChild(element);
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
