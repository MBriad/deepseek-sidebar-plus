// DSH 页面的桥:把文字填进输入框。带日志,方便定位选择器;不采集、不上传、不自动发送。
(() => {
  const log = (...args) => console.warn('[DS+ dsh-bridge]', ...args);
  log('loaded', location.href);

  function candidates() {
    const list = [];
    const push = (selector) => {
      for (const element of document.querySelectorAll(selector)) {
        if (element && !list.includes(element)) list.push(element);
      }
    };
    push('textarea');
    push('[contenteditable="true"]');
    push('[role="textbox"]');
    push('div[contenteditable]');
    return list;
  }

  function describe(element) {
    if (!element) return 'null';
    const cls = typeof element.className === 'string' ? element.className : '';
    return `${element.tagName.toLowerCase()}${cls ? `.${cls.split(/\s+/).slice(0, 2).join('.')}` : ''}`;
  }

  function findComposer() {
    const list = candidates();
    if (!list.length) return null;
    const active = document.activeElement;
    if (active && list.includes(active)) return active;
    return list[0];
  }

  function setNativeValue(element, value) {
    const proto = element.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
    if (setter) setter.call(element, value);
    else element.value = value;
    element.dispatchEvent(new Event('input', { bubbles: true }));
  }

  function insertIntoEditable(element, value) {
    element.focus();
    const selection = window.getSelection();
    selection?.selectAllChildren(element);
    selection?.collapseToEnd();
    let ok = false;
    try {
      ok = document.execCommand('insertText', false, value);
    } catch {
      ok = false;
    }
    if (!ok && element.isContentEditable) {
      element.textContent = value;
      ok = true;
    }
    element.dispatchEvent(new InputEvent('input', { bubbles: true, data: value, inputType: 'insertText' }));
    return ok;
  }

  function fill(text) {
    const composer = findComposer();
    log('fill', { composer: describe(composer), candidates: candidates().map(describe) });
    if (!composer) return false;
    const value = String(text || '');
    if (composer.tagName === 'TEXTAREA' || composer.tagName === 'INPUT') {
      composer.focus();
      setNativeValue(composer, value);
      return true;
    }
    const ok = insertIntoEditable(composer, value);
    log('editable insert', { ok });
    return ok;
  }

  window.addEventListener('message', (event) => {
    const data = event.data;
    if (!data || data.source !== 'ds-sidebar') return;
    log('message', data.type, Boolean(data.text ?? data.value));
    const isQuote = data.type === 'DS_QUOTE_TEXT';
    if (data.type !== 'DS_FILL_INPUT' && data.type !== 'DS_DSH_FILL' && !isQuote) return;
    const raw = data.text !== undefined ? data.text : data.value;
    const text = isQuote && raw ? `> ${String(raw).replace(/\r?\n/g, '\n> ')}\n\n` : raw;
    const ok = fill(text);
    log('result', ok);
    try {
      event.source?.postMessage(
        { source: 'ds-dsh', type: isQuote ? 'QUOTE_RESULT' : 'FILL_RESULT', requestId: data.requestId, ok },
        event.origin || '*'
      );
    } catch {
      // ignore
    }
  });
})();