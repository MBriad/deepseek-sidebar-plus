# REVIEW.md — content scripts

<!-- Owner-authored. 只在 diff 触及本模块时加载;reviewer 不得修改本文件。 -->

Covers: `src/content/chat-bridge.js`, `src/content/page-tools.js`,
`src/content/pdf-main.js`

## What failure looks like here
- 划词后文字没进输入框:`DS_PAGE_SELECTION` 这条链在 page-tools 或 chat-bridge 中途断掉。
- 同一次页面加载里内容脚本被注入两次,浮动按钮出现两个。
- PDF 选区不跟随滚动:pdf-main 用了旧的滚动位置。
- `chat-bridge` 的 `event.origin !== parentOrigin` 判断被放宽:任意页面都能驱动聊天框。
- 页面正文、选区、剪贴板被写进 storage。

## Paths to skip
- `src/vendor/pdfjs/` 下的任何文件:上游整包。
- 有意的 `chrome.runtime.lastError` 静默分支:对端已关闭时是预期情况。
- 站点 DOM 选择器的多级兜底:选择器会随站点改版,本身不算缺陷。

## Evidence format
- 必须说明:哪个站点、哪一步操作(例如"选中一段话后松开鼠标")。
- 改选择器时附改动前后的 console 输出或截图。

## Nit budget
- 至多 3 条。
