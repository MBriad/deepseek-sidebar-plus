# v1.13.1 — DeepSeek Sidebar Enhanced (Unofficial)

Edge 侧边栏增强版 v1.13.1（2026-10-31）。非官方扩展，与 DeepSeek、OpenAI/ChatGPT 官方均无关联。

## 新功能：导出当前对话为 PDF

- 工具栏新增 **导出 PDF**：**侧边栏内**弹出「导出对话」，可选格式（PDF）、你的称呼 / AI 的称呼、字体大小（9–18pt，带参考样张）。
- 点 **导出** 后打开一个**自动关闭的打印窗口**（侧边栏面板本身不能调起浏览器打印），在窗口里渲染纸面文档并弹出打印对话框；选 **另存为 PDF** 保存，打印完成或取消后窗口自动关闭，不留常驻标签页。
- 纸面排版：彩色封面（居中标题、渐变色分隔线、时间、消息/代码/公式/图片统计、会话链接，单独一页）→ 正文逐条 `T1 / T2 …`，每条左侧竖线区分用户（暖色）与 AI（蓝色）；代码块带语言标签，列表/引用/表格保留。
- **公式不截图**：从 MathML 的 `annotation` 取回原始 TeX，MathML 子树按白名单净化后渲染；取不到就退回 `$tex$` 原文。
- 用户上传的图片与文件：图片尽量内联（直接从页面已渲染元素取像素，再退回 fetch，上限 20 张 / 单张 3MB / 合计 12MB），文件按「📎 文件名」列出。
- **不引入任何 PDF 库**（也没有新增权限）：靠浏览器原生打印生成 PDF，中文可选中、体积小。代价是必须经过一次打印对话框。
- 数据只在内存里转一手，不写进 `chrome.storage`；弹层关闭后不留下缓存。
- 结构识别按站点做：ChatGPT 用 `<user-query>` / `<model-response>`（老结构退回 `data-message-author-role`），DeepSeek 用 `.ds-message` + 助手内容容器。DeepSeek 会话是虚拟列表，导出时边滚边收并去重；识别失败时退回整页文本，并在打印文档与控制台给出诊断计数。

## 已知问题

- **部分图片可能无法进入 PDF**：需要登录态或防盗链的图片，打印窗口（扩展源）加载不到，会显示 `[图片未能载入：<原链接>]`。文字、代码、公式、表格不受影响。跟踪：[issue #22](https://github.com/MBriad/deepseek-sidebar-plus/issues/22)。
- 封面之后的页码/页脚由浏览器打印对话框的「页眉和页脚」选项决定，扩展不能自定义（Chrome 不支持 `@page` 计数器）。

## 上一版做了什么

v1.12.0 删掉了网页标签、收藏整理和工具栏“从剪贴板填入”，侧边栏只保留读本页、划词、提示词库、PDF 与设置。本版在这个最小壳上加回一件与聊天直接相关的事：把对话带走。

## 权限

无新增。仍然是 `tabs`、`sidePanel`、`scripting`、`storage`、`contextMenus`、`clipboardRead`、`clipboardWrite`、`declarativeNetRequestWithHostAccess` 与 `<all_urls>` 主机权限；DNR 仍只对三个聊天域的 `sub_frame` 生效。

## 下载

- `deepseek-sidebar-plus-v1.13.1-portable.zip` — 推荐分享给他人；含 `INSTALL.md`、隐私政策和扩展文件。
- `deepseek-sidebar-plus-v1.13.1.zip` — 完整开发包；含文档、商店素材和提交工作表。
- `deepseek-sidebar-plus-v1.13.1-store.zip` — 最小 Edge Add-ons 包；审核结束后再提交（v1.9.3 仍在审核中）。

## 安装

1. 解压到一个固定文件夹，确保直接包含 `manifest.json`。
2. 打开 `edge://extensions/`，开启 **开发人员模式**。
3. **加载解压缩的扩展** → 选择该文件夹。
4. 允许权限，打开侧边栏，登录 DeepSeek。
5. 本地 PDF：扩展 **详细信息** → 打开 **允许访问文件 URL**。

详细说明见仓库中的 [INSTALL.md](INSTALL.md)。

## License

源码、文档、原创图标和商店宣传图采用 MIT License（见 [LICENSE](LICENSE)）。DeepSeek 名称和相关商标不包含在 MIT 内，详见 [NOTICE](NOTICE)。非官方项目，与 DeepSeek 官方无关联。
