# v1.13.0 — DeepSeek Sidebar Enhanced (Unofficial)

Edge 侧边栏增强版 v1.13.0（2026-10-31）。非官方扩展，与 DeepSeek、OpenAI/ChatGPT 官方均无关联。

## 新功能：导出当前对话为 PDF

- 工具栏新增 **导出 PDF** 按钮：读取当前聊天里的对话，打开一个打印页。
- 打印页自动弹出浏览器打印对话框，选 **另存为 PDF** 即可保存；也可以稍后点页面上的“打印 / 另存为 PDF”。
- 输出是**可选中、可搜索的文字**，不是截图：用户/助手按角色分段，代码块、列表、引用、表格都会保留。
- **不引入任何 PDF 库**（也没有新增权限）：靠浏览器原生打印生成 PDF，中文可选中、体积小。代价是必须经过一次打印对话框。
- 数据只在侧边栏内存里转一手，不写进 `chrome.storage`；侧边栏关掉后，打印页会提示回到侧边栏重新导出。
- 结构识别按站点做：ChatGPT 用官方的 `data-message-author-role`；DeepSeek 以 `.ds-markdown` 为锚点推断用户/助手。站点改版导致识别失败时，退回整页文本并明确提示，不会静默导出空内容。

## 上一版做了什么

v1.12.0 删掉了网页标签、收藏整理和工具栏“从剪贴板填入”，侧边栏只保留读本页、划词、提示词库、PDF 与设置。本版在这个最小壳上加回一件与聊天直接相关的事：把对话带走。

## 权限

无新增。仍然是 `tabs`、`sidePanel`、`scripting`、`storage`、`contextMenus`、`clipboardRead`、`clipboardWrite`、`declarativeNetRequestWithHostAccess` 与 `<all_urls>` 主机权限；DNR 仍只对三个聊天域的 `sub_frame` 生效。

## 下载

- `deepseek-sidebar-plus-v1.13.0-portable.zip` — 推荐分享给他人；含 `INSTALL.md`、隐私政策和扩展文件。
- `deepseek-sidebar-plus-v1.13.0.zip` — 完整开发包；含文档、商店素材和提交工作表。
- `deepseek-sidebar-plus-v1.13.0-store.zip` — 最小 Edge Add-ons 包；审核结束后再提交（v1.9.3 仍在审核中）。

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
- v1.9.3 是当前已提交 Microsoft 商店审核的版本；v1.12.0 与 v1.13.0 都暂不覆盖审核中的商店包。
- 未上架商店时不会自动更新；更新请覆盖同一文件夹后点“重新加载”。
- 未打包扩展的 ID 默认跟路径走；移动/换文件夹会丢失原设置和提示词库。
- 隐私政策：https://lllhcbjj.github.io/deepseek-sidebar-plus/privacy.html
- 项目主页：https://github.com/lllhcbjj/deepseek-sidebar-plus
