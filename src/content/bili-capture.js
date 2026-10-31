// 只读缓存:包装 fetch 与 XHR,把播放器请求到的字幕响应留一份,给扩展读。
// 不修改响应、不阻断播放、不落盘、不上传;任何异常都透传原调用。
(() => {
  const MATCH = /subtitle|player\/v2|player\/wbi\/v2/i;
  let latest = null;

  const broadcast = (url, text) => {
    if (!text || text.length < 40) return;
    latest = { url, text };
    window.__dsBiliSubtitle = latest;
    try {
      window.postMessage({ source: 'ds-bili', type: 'subtitle', url, text }, '*');
    } catch {
      // ignore
    }
  };

  const originalFetch = window.fetch;
  if (typeof originalFetch === 'function') {
    window.fetch = function patchedFetch(...args) {
      const input = args[0];
      const url = String((input && input.url) || input || '');
      const result = originalFetch.apply(this, args);
      if (MATCH.test(url) && result && typeof result.then === 'function') {
        result
          .then((response) => {
            try {
              response.clone().text().then((text) => broadcast(url, text)).catch(() => {});
            } catch {
              // ignore
            }
          })
          .catch(() => {});
      }
      return result;
    };
  }

  const OriginalXhr = window.XMLHttpRequest;
  if (OriginalXhr) {
    const open = OriginalXhr.prototype.open;
    const send = OriginalXhr.prototype.send;
    OriginalXhr.prototype.open = function patchedOpen(method, url, ...rest) {
      this.__dsUrl = String(url || '');
      return open.call(this, method, url, ...rest);
    };
    OriginalXhr.prototype.send = function patchedSend(...args) {
      try {
        this.addEventListener('load', () => {
          const url = this.__dsUrl || '';
          if (!MATCH.test(url)) return;
          try {
            if (this.responseType === '' || this.responseType === 'text') {
              broadcast(url, this.responseText);
            } else if (this.responseType === 'json' && this.response) {
              broadcast(url, JSON.stringify(this.response));
            }
          } catch {
            // ignore
          }
        });
      } catch {
        // ignore
      }
      return send.apply(this, args);
    };
  }
})();