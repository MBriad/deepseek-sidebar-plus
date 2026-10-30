# REVIEW.md 五份草稿（供你审阅，尚未写入）

每一行都指向仓库里真实存在的代码。**你只需要做三件事**：划掉不对的、改掉不准的、补一句只有你知道的。

---

## 1. 根 `REVIEW.md` — 平台（`background.js`、`rules.json`、`manifest.json`、`.github/`）

```md
# REVIEW.md — platform (service worker, permissions, DNR, CI)

Covers: `background.js`, `rules.json`, `manifest.json`, `.github/`

## What failure looks like here
- `rules.json` 少一条规则:对应域的侧边栏直接白屏(iframe 被 X-Frame-Options/CSP 拒绝)。
- 任一条规则的 `resourceTypes` 从 `sub_frame` 扩到 `main_frame`:那不是修 bug,是拦所有顶层导航。
- `manifest.json` 新增或扩大权限(尤其 `host_permissions` 已是最宽的 `<all_urls>`)而没有写明用途。
- `background.js` 里 `chrome.scripting.executeScript` 的目标页面范围被放宽。
- 评审流水线里让 PR 内容与 API key 同处一个 job,或让 PR 改到要跑的 workflow。

## Paths to skip
- `rules.json` 三条规则的同构重复:是刻意的,不要建议合并。
- `src/vendor/pdfjs/**`:上游整包。
- `collect-diff.mjs` 用 `git show` 取文件内容:这是刻意不走文件系统,不是绕路。

## Evidence format
- 权限或 DNR 改动:贴 `npm run classify` 输出,并说明"改前哪个站点白屏 / 改后恢复"。
- workflow 改动:合并后必须有一次真实 run 的结论;PR 里的绿灯不算数。

## Nit budget
- 至多 3 条;涉及权限与注入面的不受预算限制。
```

---

## 2. `src/REVIEW.md` — 扩展页（`sidebar.*`、`pdf-reader.*`、`pdfjs-viewer.*`）

```md
# REVIEW.md — extension pages (side panel, PDF reader)

Covers: `src/sidebar.html`, `src/sidebar.css`, `src/sidebar.js`,
`src/pdf-reader.*`, `src/pdfjs-viewer.*`

## What failure looks like here
- 设置改了不生效:要求重新打开侧边栏才变化。
- 划词自动填充失效:`autoFillSelection` / `selectionMode` 改动后,选区进不了输入框。
- 侧边栏白屏或 iframe 不加载:`CHAT_URL` 与 `frame` 的源对不上。
- 超过 50MB 的 PDF 直接失败且没有任何提示。
- 页面正文或选区被写进 `chrome.storage`。

## Paths to skip
- `DEFAULT_SETTINGS` 里已有键的默认值调整(键名不变就不算存储格式变更)。
- `sidebar.js` 里大段 DOM 构建的顺序问题:能跑就别报。

## Evidence format
- 侧边栏类改动:附改动前后的截图(能看出差异即可)。
- 设置类改动:说明点了哪个开关、期望界面变成什么。

## Nit budget
- 至多 2 条。
```

---

## 3. `src/content/REVIEW.md` — 内容脚本

```md
# REVIEW.md — content scripts

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
```

---

## 4. `tests/REVIEW.md` — 验证

```md
# REVIEW.md — verification

Covers: `tests/`, `scripts/`

## What failure looks like here
- 断言写的是用户看不见的东西:函数名、storage 键名、CSS class。
- 用真实站点替换了 mock 站点(P-4):新用例必须另起一套,不许替换现有的。
- 为了让测试变绿而改断言,而不是改行为。
- 新增用例只有成功路径,没有任何失败路径。

## Paths to skip
- `tests/fixtures/*.pdf`:二进制夹具。
- `waitFor` 的轮询间隔与超时参数。
- 测试里 mock 页面的 HTML 写法:它不是产品代码。

## Evidence format
- 附 `npm test` 的真实输出。
- 新增用例要说明"它证明了哪个用户可见行为",而不是"提高了覆盖率"。

## Nit budget
- 至多 2 条。
```

---

## 5. `docs/REVIEW.md` — 文档与根级 markdown

```md
# REVIEW.md — documentation and store material

Covers: `docs/`, and root-level markdown — `README.md`, `STORE_SUBMISSION.md`,
`PRIVACY.md`, `NOTICE`, `RELEASE_NOTES.md`, `INSTALL.md`, `AGENTS.md`,
`docs/DECISIONS.md`

## What failure looks like here
- 链接或文件名指向不存在的东西(`npm run check` 会抓已提交的部分)。
- 陈述与代码矛盾:例如说某条权限不存在、某个命令不存在。
- 两处说法互相矛盾(上一轮的 DNR 三域范围就出过这个)。
- 把"待办"写成"已完成"。

## Paths to skip
- `docs/store/` 下的商店素材与生成脚本。
- 措辞、排版、标题风格这类偏好。

## Evidence format
- 文档类改动给渲染截图;纯文本修改按 D-9 可省略,但要在 PR 里写明"纯文本"。

## Nit budget
- 至多 3 条。
```

---

## 起草依据（免得你以为是我编的）

| 写进去的东西 | 来自哪里 |
|---|---|
| DNR 三条规则、`sub_frame` 范围 | `rules.json` 三条规则 + P-2 |
| `<all_urls>`、8 个权限、`web_accessible_resources` | `manifest.json` |
| `executeScript` 与注入范围 | `background.js:367`、`background.js:410` |
| `DEFAULT_SETTINGS` 十个键与 50MB 上限 | `src/sidebar.js:23`、`src/sidebar.js:30-41` |
| `DS_PAGE_SELECTION` 消息链 | `src/content/page-tools.js:636` |
| `event.origin !== parentOrigin` | `src/content/chat-bridge.js:97` |
| mock 站点与 `waitFor` | `tests/functional.test.js:11-73`、`30` |

## 你审的时候只需要回答三个问题

1. 哪一条**根本不是问题**？（我会删）
2. 哪一条**说得不准**？（你改一句，我照抄）
3. 有没有只有你知道、但 reviewer 一定会踩的坑？补一条。
