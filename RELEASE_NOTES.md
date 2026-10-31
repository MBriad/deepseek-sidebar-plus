# v1.12.0 — DeepSeek Sidebar Enhanced (Unofficial)

Edge 侧边栏增强版 v1.12.0（2026-10-31）。非官方扩展，与 DeepSeek、OpenAI/ChatGPT 官方均无关联。

## 这版做减法

删掉三个和“在侧边栏里聊天”无关的功能，侧边栏回到最小可用集：

- 删除**网页标签**：工具栏标签按钮、标签筛选、标签管理、本地语义搜索与自动分类一并移除。
- 删除**收藏整理**：侧边栏不再读取或移动浏览器收藏，`bookmarks` 权限从 `manifest.json` 移除。
- 删除工具栏**从剪贴板填入**按钮；PDF 用户改为 `Ctrl+C` 复制后自行粘贴，或用“读本页”附加 PDF。提示词库里的“粘贴创建”保留，`clipboardRead` 只服务它。

旧版本写在 `chrome.storage.local` 里的网页标签数据不会被主动删除，只是不再读取；需要时可在 `edge://extensions` 里清除扩展数据。

## 保留的功能

- **双聊天服务**：顶部在 DeepSeek / ChatGPT 之间切换并记住选择。
- **读本页**：提取当前网页标题、链接和正文，附加为 `.txt` 文档或填入输入框，不替你写提示词。
- **划词自动填入**：选中即填入，小窗直接输入，`Enter` 发送（可关），`Ctrl+Z` / `Esc` 撤回并恢复草稿。
- **PDF**：只附加文件给当前聊天；需要跟随选区时用增强阅读器（本地 PDF.js，含目录、选区跟随、Enter 发送）。
- **@ 读取标签页**：`@` 列出所有窗口标签页，当前页置顶，选中后作为文档附加。
- **引用对话**：在回复里选中文字，以 `>` 引用格式插入输入框。
- **提示词库**：保存当前输入或粘贴创建，自定义 `/命令`，搜索、编辑、置顶、删除、JSON 导入导出。
- **设置**：划词开关、填入方式、撤销快捷键、网页来源、页面轻提示、PDF 跟随选区、Enter 发送、字数上限等；不再有标签与收藏相关项。

## 权限变化

- 移除 `bookmarks`。
- `clipboardRead` 保留（提示词库“粘贴创建”），`clipboardWrite` 保留（复制正文）。
- `<all_urls>`、`tabs`、`scripting`、`contextMenus`、`declarativeNetRequestWithHostAccess`、`sidePanel` 不变；DNR 仍只对三个聊天域的 `sub_frame` 生效。

## 下载

- `deepseek-sidebar-plus-v1.12.0-portable.zip` — 推荐分享给他人；含 `INSTALL.md`、隐私政策和扩展文件。
- `deepseek-sidebar-plus-v1.12.0.zip` — 完整开发包；含文档、商店素材和提交工作表。
- `deepseek-sidebar-plus-v1.12.0-store.zip` — 最小 Edge Add-ons 包；审核结束后再提交（v1.9.3 仍在审核中）。

## 安装

1. 解压到一个固定文件夹，确保直接包含 `manifest.json`。
2. 打开 `edge://extensions/`，开启 **开发人员模式**。
3. **加载解压缩的扩展** → 选择该文件夹。
4. 允许权限，打开侧边栏，登录 DeepSeek。
5. 本地 PDF：扩展 **详细信息** → 打开 **允许访问文件 URL**。

详细说明见仓库中的 [INSTALL.md](INSTALL.md)。

## License

源码、文档、原创图标和商店宣传图采用 MIT License（见 [LICENSE](LICENSE)）。DeepSeek 名称和相关商标不包含在 MIT 内，详见 [NOTICE](NOTICE)。非官方项目，与 DeepSeek 官方无关联。

## 注意

- 需要 Microsoft Edge 桌面版 116+；手机 Edge 不支持这类侧边栏扩展。
- v1.9.3 是当前已提交 Microsoft 商店审核的版本；v1.12.0 删除了网页标签、收藏整理和工具栏剪贴板按钮，暂不覆盖审核中的商店包。
- 未上架商店时不会自动更新；更新请覆盖同一文件夹后点“重新加载”。
- 未打包扩展的 ID 默认跟路径走；移动/换文件夹会丢失原设置和提示词库。
- 隐私政策：https://lllhcbjj.github.io/deepseek-sidebar-plus/privacy.html
- 项目主页：https://github.com/lllhcbjj/deepseek-sidebar-plus
