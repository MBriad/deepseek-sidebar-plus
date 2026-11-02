# AI 侧边栏增强版（非官方）

> 在 Edge 侧边栏里使用 DeepSeek / ChatGPT，并把网页内容送进本地 DSH。

Manifest V3，无构建步骤、无框架、无运行时依赖。基于 [deepseek-sidebar-plus](https://github.com/lllhcbjj/deepseek-sidebar-plus) 重写增强，本仓库是 [MBriad](https://github.com/MBriad) 维护的 fork。

## 功能

- **读本页** — 提取当前标签页标题、链接、正文；预览后另存为 `.txt` 附件或填进输入框，不替你写提示词。
- **划词填入** — 网页高亮选中即填入；选中后可直接在网页上打字，`Ctrl+Z` / `Esc` 撤回并恢复草稿。
- **@ 选标签页** — 输入 `@` 列出所有窗口的标签页，选中后把正文作为文档附给当前聊天。
- **提示词库** — 保存当前输入、自定义 `/命令`、搜索、置顶、JSON 导入导出。
- **PDF** — 在线/本地 PDF 已支持增强阅读器（pdf.js），可划词填入；浏览器原生阅读器里选区拿不到。
- **字幕稿打印** — 抓到字幕的视频页可排成 A4 打印成 PDF，字号 9–18pt 可调，中文字幕默认关闭。
- **DSH 视图** — 顶部 `dsh` 小标切到对话视图，把网页发给本地 DSH 插件（配套插件见 [ds-bridge](https://github.com/MBriad/ds-bridge)）。

## 安装

1. `edge://extensions/` → 打开左下角**开发人员模式**。
2. **加载解压缩的扩展** → 选本目录（`manifest.json` 所在处）。
3. 固定图标，点开侧边栏；首次加载按提示允许权限。

想用 DSH 那部分，还需要装配套插件并在设置里填同一个 `token`，见 [ds-bridge README](https://github.com/MBriad/ds-bridge)。

## 开发

```powershell
npm ci            # 只装 Playwright
npm run check     # 全部 JS 语法 + manifest 版本一致 + Markdown 链接
npm test          # Playwright 端到端（三个站点全部 mock）
npm run build     # 打包 dist/ 下的 portable zip
```

扩展没有编译步骤：改完在 `edge://extensions/` 点「重新加载」，已打开的网页要刷新一次。

## 结构

```
manifest.json        MV3 清单
background.js        侧边栏、右键菜单、页面提取调度
rules.json           三个聊天域的 X-Frame-Options / CSP 剥离（仅 sub_frame）
src/
  sidebar.html|js|css 侧边栏页：工具栏、iframe、DSH 视图、设置
  content/            内容脚本：page-tools（读页/划词）、chat-bridge（写输入框）、pdf-main（PDF 选区）
  pdf-reader.*        增强阅读器（file:// 与在线 PDF）
  print-cues.*        字幕稿打印页
  vendor/pdfjs/       vendored pdf.js，不手改
```

## 已知边界

- **测试全 mock**：真实站点改版时 CI 不会红，端到端仍要靠手动点。
- **原生 PDF 阅读器读不到选区**：这是浏览器私有接口，只能用增强阅读器。
- **扩展 ID 跟目录绑定**：换目录加载会变成新 ID，设置和提示词库不跟着走。

## 许可证

MIT，见 [LICENSE](LICENSE)。DeepSeek、ChatGPT 等商标归各自所有者，本项目为非官方版本。
