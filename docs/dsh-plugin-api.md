# DSH 插件 ↔ 侧边栏扩展 的接口约定（v1）

扩展本身不逆向 DSH 的 WebSocket 协议，也不往 DSH 页面里注入 DOM。两边只通过**一个本地 HTTP 接口**通信，接口由 DSH 插件提供。

## 为什么这样切

浏览器侧三条路都走不通（均已实测）：

- 侧边栏内嵌 DSH 时，扩展页里的跨源 iframe **不注入 content script**；
- 标签页里写 DSH 输入框，DSH 用的是受控编辑器，写值无效；
- DSH 发消息走 WebSocket 私有协议，扩展复刻它既脆又易随版本失效。

因此：**DSH 侧提供接口，扩展只负责调用**。

## 接口

```
POST http://127.0.0.1:3080/api/plugin/sidebar/attach
Authorization: Bearer <token>
Content-Type: application/json

{
  "text": "要送进 DSH 的文本",
  "kind": "fill" | "quote"
}
```

### 语义

| kind | 行为 |
|---|---|
| `fill` | 把文本写进当前会话输入框，**不发送** |
| `quote` | 以引用块形式插入当前会话输入框，**不发送** |

扩展**永远不要求自动发送**；是否发送由用户在 DSH 里决定。

### 响应

```json
200 { "ok": true }
400 { "ok": false, "error": "empty text" }
401 { "ok": false, "error": "invalid token" }
409 { "ok": false, "error": "no active session" }
500 { "ok": false, "error": "..." }
```

扩展侧只依赖 `ok` 与 `error` 两个字段，其余忽略。

## 鉴权

- token 由插件生成（首次启动时随机生成即可），在 DSH 插件的设置界面里展示；
- 用户在扩展里粘贴一次，扩展存在自己的本地存储里（**新增存储键，属高风险改动，需单独确认**）；
- 请求头固定 `Authorization: Bearer <token>`；
- token 只在本机 `127.0.0.1` 上传输，不走公网。

## CORS

插件必须允许扩展来源：

```
Access-Control-Allow-Origin: chrome-extension://<扩展ID>
Access-Control-Allow-Headers: authorization, content-type
Access-Control-Allow-Methods: POST, OPTIONS
```

简化做法：允许 `chrome-extension://` 前缀的来源（校验 `Origin` 头前缀），并正确响应 `OPTIONS` 预检。

## 端口

- 默认沿用 DSH web 的 `3080`；
- 若端口被占用，插件可自行换端口，但需要在插件 UI 里显示实际地址，扩展里也要能改（扩展侧默认 `http://127.0.0.1:3080`）。

## 版本

- 路径里带 `v1`（`/api/plugin/sidebar/attach` 视为 v1）；
- 破坏性变更时改为 `/api/plugin/sidebar/v2/attach`，扩展按能力探测并回退。

## 自测（插件侧）

```bash
# 401
curl -i -X POST http://127.0.0.1:3080/api/plugin/sidebar/attach \
  -H 'Content-Type: application/json' -d '{"text":"hi","kind":"fill"}'

# 200
curl -i -X POST http://127.0.0.1:3080/api/plugin/sidebar/attach \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"text":"hi","kind":"fill"}'
```

## 扩展侧要做的（后续 PR）

1. 设置里增加一个输入框保存 token（新增存储键，高风险项，需所有者确认）；
2. 「填入 / 划词引用」时：若当前 provider 是 DSH，改为 `fetch` 上面的接口；
3. 失败时提示“DSH 插件未运行或 token 无效”，并给出重试入口；
4. 不做自动发送。

## 不在本契约内

- 读取 DSH 的会话内容（只写不读）；
- 上传文件（DSH 已有 `/api/session/uploadFileBinary`，另行约定）；
- 任何跨设备/公网访问。
