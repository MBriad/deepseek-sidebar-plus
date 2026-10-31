# REVIEW.md — extension pages (side panel, PDF reader)

<!-- Owner-authored. 只在 diff 触及本模块时加载;reviewer 不得修改本文件。 -->

Covers: `src/sidebar.html`, `src/sidebar.css`, `src/sidebar.js`,
`src/pdf-reader.*`, `src/pdfjs-viewer.*`

## What failure looks like here
- 设置改了不生效:要求重新打开侧边栏才变化。
- 划词自动填充失效:`autoFillSelection` / `selectionMode` 改动后,选区进不了输入框。
- 侧边栏白屏或 iframe 不加载:`CHAT_URL` 与 `frame` 的源对不上。
- 超过 50MB 的 PDF 直接失败且没有任何提示。
- 页面正文或选区被写进 `chrome.storage`。
- PDF 的章节列表与上次打开的记录没有保存:重开一份 PDF 等于从头来。
- 扫码登录在侧边栏里失效,必须先在普通标签页登录,插件里的页面才能用。
- PDF导出功能不正常

## Paths to skip
- `DEFAULT_SETTINGS` 里已有键的默认值调整(键名不变就不算存储格式变更)。
- `sidebar.js` 里大段 DOM 构建的顺序问题:能跑就别报。

## Evidence format
- 侧边栏类改动:附改动前后的截图(能看出差异即可)。
- 设置类改动:说明点了哪个开关、期望界面变成什么。

## Nit budget
- 至多 2 条。
