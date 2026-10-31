/* 把会话渲染成一份"纸面文档",供侧边栏直接打印。
 *
 * 只做渲染:不取数据、不调打印、不加任何 UI。数据来自 chat-bridge,
 * 由侧边栏传进来。数据来自网页,所以这里只用 textContent 和白名单重建的
 * MathML,不把网页 HTML 原样塞进扩展页。
 */
(() => {
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
  const HEADING_LEVELS = { 1: 2, 2: 3, 3: 3, 4: 4, 5: 5, 6: 6 };

  function render(root, payload, options = {}) {
    const turns = payload.turns || [];
    const labels = {
      user: options.userLabel || '用户',
      assistant: options.aiLabel || '助手'
    };
    const fontPt = Math.min(18, Math.max(9, Number(options.fontPt) || 13));

    root.textContent = '';
    root.style.setProperty('--base-font', `${fontPt}pt`);

    const stats = summarize(turns);
    root.appendChild(renderCover(payload, turns, stats, labels));

    if (payload.degraded || payload.incomplete) {
      const notice = document.createElement('p');
      notice.className = 'pd-notice';
      notice.textContent = payload.degraded
        ? '未能识别出对话结构，已按整页文本导出；内容可能包含页面导航。'
        : '此次导出可能不完整：未能确认对话的起点、终点或消息顺序。';
      root.appendChild(notice);
    }

    turns.forEach((turn, index) => {
      root.appendChild(renderTurn(turn, index, labels));
    });
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

  function renderCover(payload, turns, stats, labels) {
    const cover = document.createElement('section');
    cover.className = 'pd-cover';

    const eyebrow = document.createElement('p');
    eyebrow.className = 'pd-eyebrow';
    eyebrow.textContent = `${payload.provider || '对话'} · 对话导出`;

    const heading = document.createElement('h1');
    heading.textContent = payload.title || '对话';

    const subtitle = document.createElement('p');
    subtitle.className = 'pd-subtitle';
    subtitle.textContent = `导出于 ${formatTime(payload.exportedAt)} · 共 ${turns.length} 条消息`;

    const meta = document.createElement('dl');
    meta.className = 'pd-meta';
    const rows = [
      ['来源', payload.provider || ''],
      ['会话', payload.url || ''],
      ['统计', `${labels.user} ${stats.users} 条 · ${labels.assistant} ${stats.assistants} 条 · 代码块 ${stats.codes} 个 · 公式 ${stats.math} 处`]
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

  function renderTurn(turn, index, labels) {
    const section = document.createElement('section');
    section.className = `pd-turn pd-turn-${turn.role || 'unknown'}`;

    const label = document.createElement('div');
    label.className = 'pd-turn-label';
    const role = turn.role === 'user' ? labels.user : turn.role === 'assistant' ? labels.assistant : '内容';
    label.textContent = `T${index + 1} · ${role}`;
    section.appendChild(label);

    for (const block of Array.isArray(turn.blocks) ? turn.blocks : []) {
      section.appendChild(renderBlock(block));
    }
    return section;
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
        const level = HEADING_LEVELS[Math.min(6, Math.max(1, Number(block.level) || 2))] || 3;
        const heading = node(`h${level}`, 'pd-heading');
        if (!appendRuns(heading, block)) heading.textContent = block.text;
        return heading;
      }
      case 'code': {
        const figure = node('figure', 'pd-code');
        if (block.language) {
          figure.appendChild(node('figcaption', 'pd-code-lang', String(block.language).toUpperCase()));
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
        const item = node('div', 'pd-list-item');
        item.appendChild(node('span', 'pd-list-marker', marker));
        if (!appendRuns(item, block)) item.appendChild(document.createTextNode(block.text || ''));
        return item;
      }
      case 'quote': {
        const quote = node('blockquote', 'pd-quote');
        if (!appendRuns(quote, block)) quote.textContent = block.text;
        return quote;
      }
      case 'hr':
        return node('hr', '');
      case 'image':
        return renderImage(block, false);
      case 'file': {
        const line = node('div', 'pd-file');
        line.textContent = `📎 ${block.name || '附件'}`;
        return line;
      }
      case 'table': {
        const table = node('table', 'pd-table');
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
        return node('p', 'pd-text', block?.text);
    }
  }

  function renderRuns(block) {
    const paragraph = document.createElement('p');
    paragraph.className = 'pd-text';
    appendRuns(paragraph, block);
    return paragraph;
  }

  function appendRuns(parent, block) {
    if (!Array.isArray(block?.runs)) return false;
    for (const run of block.runs) {
      if (run.type === 'math') parent.appendChild(renderInlineMath(run));
      else if (run.type === 'image') parent.appendChild(renderImage(run, true));
      else parent.appendChild(document.createTextNode(String(run.text || '')));
    }
    return true;
  }

  function renderImage(block, inline) {
    if (!block?.src) {
      const missing = document.createElement(inline ? 'span' : 'div');
      missing.className = inline ? 'pd-image-missing pd-image-missing-inline' : 'pd-image-missing';
      missing.textContent = `[图片${block?.alt ? `：${block.alt}` : ''}]`;
      return missing;
    }

    const img = document.createElement('img');
    img.src = block.src;
    img.alt = block.alt || '';
    img.loading = 'eager';

    // 大图(截图、图表)单独成块;小图(表情、图标)留在文字里。
    const big = Number(block.width) > 240;
    if (inline && !big) {
      img.className = 'pd-image-inline';
      return img;
    }

    const figure = document.createElement('figure');
    figure.className = 'pd-image';
    img.addEventListener('error', () => {
      img.remove();
      figure.classList.add('pd-image-missing');
      figure.textContent = `[图片${block.alt ? `：${block.alt}` : ''}]`;
    });
    figure.appendChild(img);
    if (block.alt) {
      const caption = document.createElement('figcaption');
      caption.className = 'pd-image-alt';
      caption.textContent = block.alt.slice(0, 200);
      figure.appendChild(caption);
    }
    return figure;
  }

  function renderMathBlock(block) {
    const wrapper = document.createElement('div');
    wrapper.className = 'pd-math';
    const math = sanitizeMathml(block.mathml);
    if (math) {
      math.setAttribute('display', 'block');
      wrapper.appendChild(math);
      return wrapper;
    }
    wrapper.classList.add('pd-math-tex');
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
    span.className = 'pd-math-inline';
    span.textContent = block.tex ? `$${block.tex}$` : '[公式]';
    return span;
  }

  // MathML 来自网页,不可信:只保留白名单标签/属性,文本重建。
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

  window.DSPrintDoc = { render };
})();
