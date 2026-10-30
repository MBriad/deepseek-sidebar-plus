# REVIEW.md — platform (service worker, permissions, DNR, CI)

<!-- Owner-authored. 只在 diff 触及本模块时加载;reviewer 不得修改本文件。 -->

Covers: `background.js`, `rules.json`, `manifest.json`, `.github/`

## What failure looks like here
- `rules.json` 少一条规则:对应域的侧边栏直接白屏(iframe 被 X-Frame-Options / CSP 拒绝)。
- 任一条规则的 `resourceTypes` 从 `sub_frame` 扩到 `main_frame`:那不是修 bug,是拦所有顶层导航。
- `manifest.json` 新增或扩大权限(尤其 `host_permissions` 已经是最宽的 `<all_urls>`)而没有写明用途。
- `background.js` 里 `chrome.scripting.executeScript` 的目标页面范围被放宽。
- 评审流水线里让 PR 内容与 API key 同处一个 job,或让 PR 改到真正要跑的 workflow。

## Paths to skip
- `rules.json` 三条规则的同构重复:是刻意的,不要建议合并。
- `src/vendor/pdfjs/**`:上游整包。
- `collect-diff.mjs` 用 `git show` 取文件内容:刻意不走文件系统,不是绕路。

## Evidence format
- 权限或 DNR 改动:贴 `npm run classify` 输出,并说明"改前哪个站点白屏 / 改后恢复"。
- workflow 改动:合并后必须有一次真实 run 的结论;PR 里的绿灯不算数。

## Nit budget
- 至多 3 条;涉及权限与注入面的不受预算限制。
