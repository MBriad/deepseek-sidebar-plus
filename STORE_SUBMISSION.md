# Edge Add-ons Submission Pack — v1.9.3

This is the submission worksheet for **DeepSeek Sidebar Enhanced (Unofficial)**.  
It is not a guarantee of approval; it prepares the package and the answers reviewers will look for.

> **v1.9.3 is the version currently in Microsoft certification.** v1.10.0 adds webpage tags and is a local/GitHub update only; do not replace the v1.9.3 store package while the review is in progress. Update this worksheet when v1.10.0 is ready for resubmission.

**Screenshots are ready in `docs/store/screenshots/`. Remaining before submitting: decide how to handle DeepSeek login for reviewers (test account or a clear note) and complete the Partner Center upload. Privacy URL, publisher, and support contact are filled for `lllhcbjj`.**

---

## 1. Identity and listing fields

| Field | Value |
| --- | --- |
| Extension name (en) | `DeepSeek Sidebar Enhanced (Unofficial)` |
| Extension name (zh-CN) | `DeepSeek 侧边栏增强版（非官方）` |
| Version | `1.9.3` |
| Category | Productivity |
| Languages | en-US, zh-CN (from `_locales`) |
| Publisher display name | `lllhcbjj` |
| Support contact | `https://github.com/lllhcbjj/deepseek-sidebar-plus/issues` |
| Website (optional) | `https://github.com/lllhcbjj/deepseek-sidebar-plus` |
| Privacy policy URL | `https://lllhcbjj.github.io/deepseek-sidebar-plus/privacy.html` |
| Short description (en) | Unofficial DeepSeek sidebar: page documents, tab @ mentions, selection autofill, prompt commands, and PDF support. |
| Short description (zh) | 非官方 DeepSeek 侧边栏：网页文档、@ 标签页、划词填入、提示词命令、PDF 支持。 |

The manifest uses `__MSG_extName__` / `__MSG_extDescription__`; Partner Center reads the localized values from `_locales/`.

---

## 2. Detailed description (zh-CN)

DeepSeek 侧边栏增强版（非官方）是一个独立的第三方 Edge 扩展，把 DeepSeek 聊天放进浏览器侧边栏，并为阅读、写作和提示词工作流补上上下文工具。它不是 DeepSeek 官方产品，与 DeepSeek 官方无关联。

主要功能：

- **读取当前网页**：一键提取当前标签页的标题、链接和正文。预览后可以把完整正文整理成 `.txt` 文件附加到 DeepSeek，**不修改输入框、不自动填写提示词**；也可以选择“填入正文”，把正文直接写进输入框。
- **划词自动填入 / 取消撤回**：在普通网页中高亮选中文字后自动填入 DeepSeek；点击空白处或取消选区时自动恢复之前的草稿。如果已经手动改过输入框，则不会误删。
- **引用 DeepSeek 对话**：在 DeepSeek 回复里选中文字，点浮出的“引用”按钮或右键菜单，把选中内容以 Markdown `>` 引用格式插入输入框。
- **提示词库**：保存当前输入，或从剪贴板粘贴创建提示词；支持自定义 `/命令`、搜索、编辑、置顶、删除和 JSON 导入/导出。在 DeepSeek 输入框输入 `/` 会显示命令列表和对应提示词预览，Enter 插入。提示词保存在浏览器本地存储中。
- **@ 读取标签页（含当前页）**：在 DeepSeek 输入框输入 `@`，当前页作为第一项置顶，下面列出所有窗口的其他标签页；`@` 后直接 Enter 会把当前页正文作为 `.txt` 文档附加，选择其他标签页也同样直接附加，输入框内容保持不变。
- **PDF 支持**：识别 PDF 并只把文件附加给 DeepSeek，不自动填写提示词；本地 PDF 的“读本页”会附加文件并默认自动打开增强阅读器，恢复划词和引用（可在设置关闭自动打开）。
- **其他工具**：从剪贴板填入、复制正文、在标签页打开 DeepSeek、重新加载侧边栏。

隐私与数据：

- 扩展没有开发者服务器，不包含广告、分析、遥测或追踪 SDK，不出售数据。
- 只有在用户主动点击“读本页”、划词、填入、引用、剪贴板或 PDF 操作时才访问相应内容。
- 网页正文、选中的文字、DeepSeek 输入内容和本地 PDF 只在用户主动使用时处理；内容在填入、发送或附加时进入 DeepSeek，受 DeepSeek 隐私政策约束。
- 设置、待填入划词和提示词库保存在浏览器本地存储，用户可删除或卸载清除。

限制：

- 需要 DeepSeek 账号并登录。
- 这是 Edge 桌面版扩展；手机 Edge 官方版通常不支持这类 sidePanel 扩展。
- 非官方扩展，DeepSeek 名称仅用于说明兼容性。

---

## 3. Detailed description (en-US)

DeepSeek Sidebar Enhanced (Unofficial) is an independent third-party Edge extension that puts DeepSeek chat in the browser sidebar and adds practical context tools for reading, writing, and prompt workflows. It is not an official DeepSeek product and is not affiliated with DeepSeek.

Features:

- **Read the current page**: extract the active tab's title, URL, and body text. Preview it, then attach the full text as a `.txt` document to DeepSeek **without changing the input or injecting a prompt**, or fill the text directly into the input box.
- **Selection autofill and undo**: highlight text on a web page to fill it into DeepSeek automatically. Clearing the selection restores the previous draft; if you manually edited the input, your edit is preserved.
- **Quote DeepSeek replies**: select text in a DeepSeek response and use the floating “Quote” button or the right-click menu to insert it as a Markdown block quote.
- **Prompt library**: save the current input or paste text to create a prompt; supports custom `/commands`, search, edit, pin, delete, and JSON import/export. Type `/` in the DeepSeek input to see matching commands with a prompt preview; press Enter to insert. Prompts are stored locally.
- **@ tabs (including current page)**: type `@` in the DeepSeek input to show the current page as the first item, followed by other open tabs across all windows. Pressing Enter immediately after `@` attaches the current page as a `.txt` document; selecting another tab attaches that tab's content. The input text is unchanged.
- **PDF support**: detect PDFs and attach them without injecting a prompt; local PDF “Read this page” attaches the file and by default opens the enhanced reader for selection and quoting (can be disabled in settings).
- **Extra tools**: paste from clipboard, copy page text, open DeepSeek in a tab, and reload the sidebar.

Privacy:

- No developer server, ads, analytics, telemetry, or tracking SDK. Data is not sold.
- Data is accessed only when you click Read this page, select text, fill, quote, use the clipboard button, or open/attach a PDF.
- Page text, selections, DeepSeek input text, and local PDFs are processed only for the feature you invoke. Content enters DeepSeek when you fill, send, or attach it and is governed by DeepSeek's privacy policy.
- Settings, pending selections, and prompts are stored in browser local storage and can be deleted or removed by uninstalling.

Limitations:

- A DeepSeek account and login are required.
- This is an Edge desktop extension; the official Edge mobile app generally does not support this type of sidePanel extension.
- Unofficial extension. The DeepSeek name is used only to describe compatibility.

---

## 4. Single purpose statement

> Provide an unofficial DeepSeek chat sidebar for Microsoft Edge, with user-invoked tools that bring the current page, selected text, PDFs, chat quotes, and saved prompts into the DeepSeek conversation.

Use this exact framing in Partner Center. Do not describe it as a general-purpose scraper, automation bot, or “AI assistant for everything”; the features are all in service of the DeepSeek sidebar workflow.

---

## 5. Permission justifications

Paste these into **Privacy → Permission justification**:

| Permission | Justification |
| --- | --- |
| `tabs` | Read the active tab's title and URL, detect PDF tabs, and open related pages when the user chooses. |
| `sidePanel` | Display the extension's DeepSeek sidebar UI in Microsoft Edge. |
| `scripting` | Inject page extraction, selection capture, and PDF bridge scripts only when the user invokes those features, including on tabs that were already open before installation. |
| `storage` | Persist user settings, a temporary pending selection, and the user's local prompt library. |
| `contextMenus` | Provide the optional “send selection”, “read page”, and “quote to input” context-menu actions. |
| `clipboardRead` | Read clipboard text only when the user clicks the “Paste from clipboard” toolbar button. No background clipboard monitoring. |
| `clipboardWrite` | Copy page text only when the user clicks the “Copy” button in the page preview. |
| `declarativeNetRequestWithHostAccess` | Apply a header rule only to `chat.deepseek.com` so the DeepSeek page can render inside the extension side panel. The rule does not target other domains. |
| `<all_urls>` host permission | Capture a user's text selection and extract the current page's body only when the user has enabled selection autofill or clicked “Read this page”. No automatic background collection or upload. |
| `web_accessible_resources` (`pdf-main.js`) | Expose the PDF selection bridge script to PDF pages so the extension can read the Edge PDF viewer's selected text. |

### Important transparency note for reviewers

The extension embeds `https://chat.deepseek.com` in its side panel. To make that possible, `rules.json` removes `X-Frame-Options` and `Content-Security-Policy` from `sub_frame` responses for `chat.deepseek.com`. It does not set a CORS wildcard and does not modify other domains. Do not hide this from reviewers; explain it in the certification notes.

If review objects to the header modification, the fallback is a “lite” build that opens DeepSeek in a normal tab (no iframe/header rule) or moves page access to optional host permissions.

---

## 6. Remote code declaration

Select **No, I am not using remote code**.

Rationale:

- The extension does not load or execute remote JavaScript.
- It does not use `eval` or dynamically fetched scripts.
- `chat.deepseek.com` is a third-party website displayed in an iframe for the user; it is not extension code.
- All extension code is packaged in the ZIP.

If a reviewer asks about the iframe, use the explanation above.

---

## 7. Data usage disclosures

In **Privacy → Data usage**, disclose at least:

- **Website content** — read only on user action (Read this page / selection).
- **Personal communications** — selected DeepSeek chat text and user-entered input, only when the user chooses quote/fill/save prompt.
- **User-generated content** — prompt library, stored locally.
- **Web browsing activity** — active tab URL/title and PDF detection only; no history collection.

Do **not** select financial, health, authentication, or location data: the extension does not collect them.

Certify:

- Data is not sold or shared with data brokers.
- Data is not used for advertising or creditworthiness.
- Data is not used for purposes unrelated to the single purpose.
- The privacy policy URL is accurate and up to date.

Privacy policy: **https://lllhcbjj.github.io/deepseek-sidebar-plus/privacy.html** (source: `docs/privacy.html`, published from GitHub Pages `/docs`).

---

## 8. Certification testing notes

Paste into **Notes for certification**:

```text
This is an unofficial DeepSeek sidebar extension. DeepSeek login is required for chat features.

1. Load the extension and click the toolbar icon. The DeepSeek side panel opens (or a full-page sidebar tab on browsers without sidePanel).
2. Log in to DeepSeek with a normal free account. No test account is bundled because the extension uses the reviewer's own DeepSeek session; login is handled by chat.deepseek.com.
3. Open any article in another tab, click the extension's "读本页 / Read this page" button, then try "附加文档" (attach page as .txt, input must remain unchanged) or "填入正文" (fill raw text, no prompt).
4. Select text on a page with selection autofill enabled, then clear the selection to verify the previous draft is restored.
5. In the DeepSeek sidebar, select text in a reply and click the floating "引用 / Quote" button.
6. Open the prompt library, paste-create a prompt, set a custom command, then type `/` in the DeepSeek input and verify the command preview and Enter insertion.
7. Open two other tabs, type `@` in the DeepSeek input: the current page is the first item, and other tabs from all windows follow. Press Enter to attach the current page as a document; repeat and select another tab and verify its content attaches without changing the input.
8. Open a PDF URL and use the PDF attach flow; the input should remain unchanged.
9. The declarativeNetRequest rule only targets chat.deepseek.com and exists to allow the DeepSeek page to render in the side panel. It does not modify other sites.
10. The extension never clicks DeepSeek's Send button automatically.

For local file:// PDFs, Edge's "Allow access to file URLs" setting must be enabled by the user; test with a web PDF if file access is disabled.
```

If you can create a dedicated test DeepSeek account, add its credentials here; otherwise explain that login is required and reviewers should use a free account. Store policy requires the product to be testable; this is a review risk.

---

## 9. Store assets

Required / recommended:

| Asset | Spec | File |
| --- | --- | --- |
| Logo | 300×300 recommended, minimum 128×128, 1:1 | `docs/store/logo-300.png` |
| Screenshots | 1280×800, max 6 | `docs/store/screenshots/store-01-page.png` … `store-05-page-tags.png` |
| Small promotional tile | 440×280, optional | `docs/store/small-promo-440x280.png` |
| Large promotional tile | 1400×560, optional | `docs/store/large-promo-1400x560.png` |

Ready screenshots (actual UI, 1280×800, demo article/prompt/PDF/tagged-page content; no DeepSeek login required). The v1.9.3 upload used the first four; v1.10.0 adds the fifth:

1. `store-01-page.png` — page preview with “附加文档 / 填入正文 / 复制”
2. `store-02-prompts.png` — prompt library with paste-create, command chips, tags
3. `store-03-pdf.png` — local PDF enhanced reader with selection hint
4. `store-04-settings.png` — settings including “本地 PDF 自动打开阅读器”
5. `store-05-page-tags.png` — webpage tags, tag filters, and local semantic search (v1.10.0)

Capture at 1280×800 (browser window) or 640×480; keep text readable and do not stretch. If you only have a narrow side panel capture, place it on a clean 1280×800 canvas without fake chat text.

---

## 10. Package

Build the minimal store package (no dev docs, no README, no privacy page inside):

```powershell
$root = "C:\path\to\deepseek-sidebar-plus"
$dist = Join-Path $env:TEMP "deepseek-sidebar-store\v1.9.3"
Remove-Item -Recurse -Force $dist -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force -Path $dist | Out-Null
Copy-Item "$root\manifest.json","$root\background.js","$root\rules.json" $dist
Copy-Item "$root\icons" $dist -Recurse
Copy-Item "$root\src" $dist -Recurse
Copy-Item "$root\_locales" $dist -Recurse
Compress-Archive -Path "$dist\*" -DestinationPath (Join-Path $env:TEMP "deepseek-sidebar-plus-v1.9.3-store.zip") -Force
```

The ZIP must have `manifest.json` at its root. Do not add `key` or `update_url`; Partner Center assigns those for store packages.

Validate before uploading:

- `manifest.json` parses and version is `1.9.3`.
- `_locales/en` and `_locales/zh_CN` exist and `default_locale` is `en`.
- No `key` / `update_url` in the store manifest.
- The extension loads unpacked and the side panel opens.
- `rules.json` is present and only targets `chat.deepseek.com`.

---

## 11. Submission checklist

- [x] Publisher/contact set to `lllhcbjj` / GitHub Issues in `docs/privacy.html` and `PRIVACY.md`.
- [x] Verify `https://lllhcbjj.github.io/deepseek-sidebar-plus/privacy.html` is live (GitHub Pages `/docs`, status built).
- [ ] Capture real screenshots at 1280×800 or 640×480.
- [x] Logo 300×300 and optional tiles generated in `docs/store/`.
- [ ] Create/verify Partner Center individual account (free).
- [ ] Create extension; upload `deepseek-sidebar-plus-v1.9.3-store.zip`.
- [ ] Properties: Productivity; support contact; optional website.
- [ ] Privacy: single purpose; permission justifications; remote code = No; data usage; privacy URL.
- [ ] Store listing: en-US and zh-CN descriptions, logo, screenshots.
- [ ] Certification notes with login/test flow and DNR explanation.
- [ ] Submit; certification can take up to 7 business days.
- [ ] If rejected: read the exact policy cited; consider optional host permissions or a lite no-iframe build.

## 12. Known risks (read before submitting)

1. **Header modification / iframe** — the original “Deepseek Chat Sidebar (Unofficial)” used the same header-removal approach and was published, so this is not automatically disqualifying. This build narrows the rule to `sub_frame` for `chat.deepseek.com` and no longer sets a CORS wildcard. It is still a policy grey area; explain it and be ready to ship a no-iframe fallback.
2. **Trademark / unofficial status** — keep “Unofficial / 非官方” in the name, description, and UI; do not use DeepSeek logos. DeepSeek's terms restrict use of its marks; permission is better than a disclaimer.
3. **`<all_urls>` + clipboard** — the biggest difference from the original. The privacy policy and permission justifications must be complete and truthful. Optional host permissions are the fallback if reviewers object.
4. **Mobile** — this is a desktop Edge extension; Edge mobile generally does not support sidePanel extensions. Do not claim mobile support in the listing.
5. **Testability** — DeepSeek login is required. A dedicated test account (or clear reviewer instructions) reduces rejection risk.
