# v1.9.0 — DeepSeek Sidebar Enhanced (Unofficial)

Edge 侧边栏增强版 v1.9.0。非官方扩展，与 DeepSeek 官方无关联。

## 功能

- **读取当前网页**：提取标题、链接和正文；**只附加 `.txt` 文档，不修改输入框、不自动填写提示词**；也可以“填入正文”。
- **划词自动填入 / 取消撤回**：高亮选中自动填入；取消选区恢复之前的草稿；手动改过则不误删。
- **引用对话**：选中 DeepSeek 回复中的文字，点浮出的“引用”或右键，插入 Markdown `>` 引用。
- **提示词库**：保存当前输入，或直接粘贴文本创建；支持自定义 `/命令`、搜索/编辑/置顶/删除、JSON 导入导出，本地保存。
- **命令行调用**：在 DeepSeek 输入框输入 `/`，显示命令列表和对应提示词预览；`↑↓` 选择、`Enter` 插入、`Esc` 关闭。
- **PDF**：只附加文件，不填提示词；本地 PDF 可用增强阅读器恢复划词。
- **移动/窄屏**：320–430px 响应式布局、触摸目标、安全区；无 `sidePanel` 时回退到全页标签。
- **商店候选**：非官方名称、en/zh 本地化、隐私政策、权限说明、商店文案和素材。

## 下载

- `deepseek-sidebar-plus-v1.9.0-portable.zip` — 推荐分享给他人；含 `INSTALL.md`、隐私政策和扩展文件。
- `deepseek-sidebar-plus-v1.9.0.zip` — 完整开发包；含文档、商店素材和提交工作表。
- `deepseek-sidebar-plus-v1.9.0-store.zip` — 最小 Edge Add-ons 提交包；不含开发文档。

## 安装

1. 解压到一个固定文件夹，确保直接包含 `manifest.json`。
2. 打开 `edge://extensions/`，开启 **开发人员模式**。
3. **加载解压缩的扩展** → 选择该文件夹。
4. 允许权限，打开侧边栏，登录 DeepSeek。
5. 本地 PDF：扩展 **详细信息** → 打开 **允许访问文件 URL**。

详细说明见仓库中的 [INSTALL.md](INSTALL.md)。

## License

源代码和文档采用 MIT License（见 `LICENSE`）。`icons/` 狐狸图标、`docs/store/` 衍生宣传图和 DeepSeek 商标不包含在 MIT 内，详见 `NOTICE`。非官方项目，与 DeepSeek 官方无关联。

## 注意

- 需要 Microsoft Edge 桌面版 116+；手机 Edge 不支持这类侧边栏扩展。
- 未上架商店时不会自动更新；更新请覆盖同一文件夹后点“重新加载”。
- 未打包扩展的 ID 默认跟路径走；移动/换文件夹会丢失原设置和提示词库。
- 隐私政策：https://lllhcbjj.github.io/deepseek-sidebar-plus/privacy.html
- 项目主页：https://github.com/lllhcbjj/deepseek-sidebar-plus
