# 项目事实（供 PR reviewer 注入）

<!-- 精简上下文,≤30 行,会被 CI reviewer 注入到提示词里。
     只写"这个项目是什么",不写"怎么审"——审法在按模块的 REVIEW.md 里。
     本文件改动属于 docs 级,但会改变评审输入:改它等于改评审口径。 -->

## 是什么

Microsoft Edge 侧边栏扩展(Manifest V3)。无构建步骤、无运行时依赖、纯 JS,没有 TypeScript / lint。
侧边栏内嵌 `chat.deepseek.com` / `chatgpt.com` 官方页面,用 DOM 与消息操纵,**不自建聊天 UI**。

## 关键结构

- `rules.json`:三条同构 DNR 规则,仅作用于 `sub_frame`,剥离三个聊天域的 `X-Frame-Options` / CSP。删任一条,对应侧边栏直接白屏。
- `src/content/*`:内容脚本,是页面与侧边栏之间唯一的桥。
- `src/vendor/pdfjs/`:上游整包 vendored,**不手改**。
- 版本号:`manifest.json` 与 `package.json` 必须一致(`npm run check` 会查)。

## 不能碰的线

- 不引入远程代码(应用商店红线)。
- 不新增或扩大 `permissions` / `host_permissions`,除非所有者逐条确认。
- 不把页面正文、选区、剪贴板写进 storage;若确要写,`PRIVACY.md` 与 `docs/privacy.html` 必须同一轮更新。
- 存储键是数据格式,改名等于数据迁移。

## 验证

- `npm run check`:全部 JS 语法 + manifest/package 版本一致性。
- `npm test`:Playwright 端到端,三个站点**全部 mock**。
- 已知盲区:真实站点改版时 CI 依然绿——绿只说明没崩,不说明功能对。

## 非目标

不做账号体系、不做服务端、不自建聊天界面、不引入构建步骤或 lint。
