// DSH 页面的桥:只做"把文字填进输入框",不采集、不上传、不自动发送。
(() => {
  console.debug('[DS+ dsh-bridge] loaded');

  function findComposer() {
    const candidates = [
      'textarea',
      '[contenteditable="true"]',
      'div[role="textbox"]',
      '.composer textarea',
      '[class*="composer"] textarea'
    ];
    for (const selector of candidates) {
      const element = document.querySelector(selector);
      if (element) return element;
    }
    return null;
  }

  function fill(text) {
    const composer = findComposer();
    if (!composer) return false;
    const value = String(text || '');
    if (composer.tagName === 'TEXTAREA' || composer.tagName === 'INPUT') {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set;
      const inputSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
      if (composer.tagName === 'TEXTAREA' && setter) setter.call(composer, value);
      else if (inputSetter) inputSetter.call(composer, value);
      else composer.value = value;
      composer.dispatchEvent(new Event('input', { bubbles: true }));
      composer.focus();
      return true;
    }
    if (composer.isContentEditable) {
      composer.focus();
      document.execCommand('insertText', false, value);
      composer.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    }
    return false;
  }

  window.addEventListener('message', (event) => {
    const data = event.data;
    if (!data || data.source !== 'ds-sidebar' || data.type !== 'DS_DSH_FILL') return;
    const ok = fill(data.text);
    try {
      event.source?.postMessage({ source: 'ds-dsh', type: 'DS_DSH_FILL_RESULT', ok }, event.origin || '*');
    } catch {
      // ignore
    }
  });
})();