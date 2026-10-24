# 用 Antigravity 反代 Gemini 接进 DSH（完整说明）

> 仓库里**只有桥接侧**的兼容改动（`src/config.js` 允许把 `reasoningEffort` 留空）和这份文档；
> DSH 的 provider 配置在 `~/.dsh/profiles/*/cordis.patch.yml`，反代程序在 `E:\dsh\antigravity`，
> 都不属于本仓库，需要按下面在新设备上重建。

## 它是什么

[antigravity-proxy](https://github.com/frieser/antigravity-proxy) 把 Google Antigravity（Cloud Code）背后的
Gemini/Claude 模型包装成 **OpenAI 兼容接口**（`/v1/chat/completions`、`/v1/models`，支持流式和 tool calls）。
DSH 自带一个默认挂载但空转的 `dsh-llm-pi-ai` 适配器，可以声明任意 OpenAI 兼容 provider，于是：

```
qq-bridge → DSH(sdk profile) → llm-pi-ai → http://127.0.0.1:3457/v1 → antigravity-proxy → Google Cloud Code
```

DSH 仍然负责会话、工具、MCP、技能；只是模型从 DeepSeek 换成了 Gemini。

## 0. 前置条件

- Windows、能科学上网（**HK / 大陆出口不行**，会报 `UNSUPPORTED_LOCATION`；SG / US / JP 可以）
- 一个能登录 Antigravity 的 Google 账号（免费版有额度限制）
- Node/Bun、DSH 桌面版

## 1. 装 Bun 和反代

反代是 Bun 项目。用 DSH 自带的 pnpm 装（会从 npm 拉 Bun 的 Windows 二进制，不走 GitHub）：

```bash
mkdir E:\dsh\antigravity && cd E:\dsh\antigravity
pnpm add bun antigravity-proxy
```

pnpm 会提示 `Ignored build scripts: bun`，不影响——二进制在
`node_modules/.pnpm/@oven+bun-windows-x64@*/node_modules/@oven/bun-windows-x64/bin/bun.exe`。
验证：`bun.exe --version`。

把包复制到工作目录（配置和账号文件会落在 cwd）：

```bash
cp -r node_modules/antigravity-proxy proxy
cd proxy
```

## 2. 改三处源码（不改会踩坑）

### 2.1 端口

默认 3000 会和 SnowLuma 的 OneBot HTTP 撞。`src/server.ts`：

```ts
Bun.serve({
  port: Number(process.env.PROXY_PORT || process.env.PORT || 3457),
  hostname: "127.0.0.1",
```

### 2.2 OAuth 回调地址

`src/utils/headers.ts` 里写死了 `http://localhost:3000/oauth-callback`，但我们的服务在 3457：

```ts
redirectUri: process.env.OAUTH_REDIRECT_URI || "http://localhost:3000/oauth-callback"
```

（Google 的桌面客户端允许 loopback 任意端口，改端口不会 `redirect_uri_mismatch`。）

### 2.3 工具结果名字（**关键**）

DSH 发回来的 `role: "tool"` 消息**没有 `name` 字段**，反代原来统一填 `function_result`，
Gemini 要求 `functionResponse.name` 和之前 `functionCall.name` 一致，于是第二轮请求直接
`400 Request contains an invalid argument`——表现就是「模型第一轮能调工具，拿到结果后就失败」。

`src/utils/transform.ts`，在 `const contents = otherMessages.map(...)` 之前建索引：

```ts
const toolNameById = new Map<string, string>();
for (const m of openaiBody.messages) {
  if (Array.isArray(m.tool_calls)) {
    for (const tc of m.tool_calls) {
      if (tc?.id && tc?.function?.name) toolNameById.set(String(tc.id), String(tc.function.name));
    }
  }
}
```

然后把 tool 分支的 `name` 改成：

```ts
name: msg.name || toolNameById.get(String(msg.tool_call_id)) || "function_result",
```

## 2.4 客户端版本决定能用的模型（**想用 3.8 必看**）

Google 的 `v1internal:fetchAvailableModels` 会**按客户端版本**返回模型目录：

- 伪装 `antigravity/1.15.8`：只返回 Gemini 3.5 一代（`gemini-3.5-flash-lite`、`gemini-3.5-flash-low`…）
- 伪装 `antigravity/2.5.5`（或更新）：多出 **`gemini-3.8-flash-low` / `gemini-3.8-flash-medium` / `gemini-3.8-flash-high`**

所以两处都要改：

1. `src/utils/headers.ts`：把版本改成当前 Antigravity 客户端的版本（写死或走环境变量）

```ts
const ANTIGRAVITY_VERSION = process.env.ANTIGRAVITY_VERSION || "2.5.5";
```

2. `src/api/quota.ts`：拉模型列表时**不要**把 UA 覆盖成 `"antigravity"`，否则版本信息丢了，目录又退回旧版

```ts
headers: {
  ...getImpersonationHeaders(account.accessToken, account.fingerprint),
},
```

改完重启反代，`/v1/models` 里就会出现 3.8 系列。实测（同账号、SG 节点）：

| 模型 | 首字耗时 | 工具调用 |
| --- | --- | --- |
| `gemini-3.8-flash-high` | ~5.9s | 正常 |
| `gemini-3.8-flash-medium` | ~4.6s | 正常 |
| `gemini-3.8-flash-low` | ~3.0s | 正常 |

> 顺带一提：旧模型 id 现在会被 Google 映射到新模型，例如 `gemini-2.5-flash` 拿到的是「Gemini 3.5 Flash Lite」、
> `gemini-3-flash-agent` 是「Gemini 3.5 Flash (High)」。想要确定的新模型，直接用 `gemini-3.8-flash-*` 这种显式 id。

## 3. 登录 Google 账号

反代需要能访问 `accounts.google.com` / `oauth2.googleapis.com` / `cloudcode-pa.googleapis.com`，
所以启动时要把代理环境变量带上（下面假设梯子的 HTTP 端口是 `127.0.0.1:2712`）：

```
HTTPS_PROXY=http://127.0.0.1:2712
HTTP_PROXY=http://127.0.0.1:2712
NO_PROXY=127.0.0.1,localhost
OAUTH_REDIRECT_URI=http://localhost:3457/oauth-callback
PROXY_PORT=3457
```

启动后打开 `http://127.0.0.1:3457/oauth/start`，浏览器里用 Google 账号登录并同意。
回调会落到 3457，账号写进 `proxy/antigravity-accounts.json`。

### 3.1 还可能要装一次 Antigravity IDE

如果 `/v1/chat/completions` 报：

- `403 UNSUPPORTED_LOCATION`：节点地区不对，换 SG/US/JP
- `403 SUBSCRIPTION_REQUIRED (#3501)`：账号没有许可。用同一个 Google 账号装一次
  [Antigravity IDE](https://antigravity.google/download)（Windows x64 约 217MB），登录后
  会为账号开通 Antigravity 许可，反代这边不用改配置，重试即可

IDE 装完直接启动登录一次就行，之后可以关掉；许可跟着账号走。

## 4. 接进 DSH

### 4.1 provider（`desktop` 和 `sdk` 两个 profile 都要加）

编辑 `~/.dsh/profiles/<profile>/cordis.patch.yml`，追加：

```yaml
- id: llm-pi-ai
  config:
    providers:
      antigravity:
        displayName: Antigravity Gemini
        apiKeyEnv: ANTIGRAVITY_API_KEY
        api: openai-completions
        baseURL: http://127.0.0.1:3457/v1
        models:
          - id: gemini-3-flash
            name: Gemini 3 Flash (Antigravity)
            contextWindow: 1048576
            maxTokens: 65536
            input: [text, image]
          - id: gemini-2.5-pro
            name: Gemini 2.5 Pro (Antigravity)
            contextWindow: 1048576
            maxTokens: 65536
            input: [text, image]
          - id: gemini-3.8-flash-high
            name: Gemini 3.8 Flash High (Antigravity)
            contextWindow: 1048576
            maxTokens: 65536
            input: [text, image]
          - id: gemini-3.8-flash-medium
            name: Gemini 3.8 Flash Medium (Antigravity)
            contextWindow: 1048576
            maxTokens: 65536
            input: [text, image]
          - id: gemini-3.8-flash-low
            name: Gemini 3.8 Flash Low (Antigravity)
            contextWindow: 1048576
            maxTokens: 65536
            input: [text, image]
```

> `qq-bridge` 用的是 `sdk` profile（`config.dsh.profile`）；DSH 桌面 GUI 用 `desktop`。
> 只配一个的话，另一个仍然走原模型。

### 4.2 凭据

`~/.dsh/.credentials.yaml` 的 `refs` 里加一行（反代不校验 key，占位即可）：

```yaml
refs:
  ANTIGRAVITY_API_KEY: antigravity-local
```

### 4.3 桥接配置

`qq-bridge/config.json`：

```json
"dsh": {
  "provider": "antigravity",
  "model": "gemini-3.8-flash-medium",
  "reasoningEffort": ""
}
```

`reasoningEffort` 必须留空：这些模型没有声明 reasoning 档位，DSH 传 `low/high` 会直接抛
`does not support reasoning effort`。本仓库的 `src/config.js` 已改成「空字符串 = 不传」（默认仍是 `low`）。

## 5. 启动与自检

反代启动脚本（`start-proxy.cmd`，放哪都行）：

```bat
set HTTPS_PROXY=http://127.0.0.1:2712
set HTTP_PROXY=http://127.0.0.1:2712
set NO_PROXY=127.0.0.1,localhost
set OAUTH_REDIRECT_URI=http://localhost:3457/oauth-callback
set PROXY_PORT=3457
cd /d E:\dsh\antigravity\proxy
start "" /min "E:\dsh\antigravity\node_modules\.pnpm\@oven+bun-windows-x64@1.4.4\node_modules\@oven\bun-windows-x64\bin\bun.exe" src/server.ts
```

自检顺序：

1. `curl http://127.0.0.1:3457/v1/models` → 应返回模型列表（空数组说明没账号/没登录成功）
2. `curl -X POST http://127.0.0.1:3457/v1/chat/completions -H "content-type: application/json" -H "authorization: Bearer x" -d '{"model":"gemini-3.8-flash-medium","messages":[{"role":"user","content":"hi"}]}'` → 应返回 JSON
3. 带 tools 再打一次，确认返回 `tool_calls`
4. 起桥接，控制台显示 `DSH：已就绪 · gemini-3.8-flash-medium`

## 6. 常见问题

| 现象 | 原因 / 处理 |
| --- | --- |
| `403 UNSUPPORTED_LOCATION` | 出口 IP 在 HK/大陆；换 SG/US/JP 节点（**不用重启反代**，它走的是 `127.0.0.1:2712`） |
| `403 SUBSCRIPTION_REQUIRED (#3501)` | 账号没有 Antigravity 许可；用同一账号装/登录一次 Antigravity IDE |
| `429 Resource exhausted` | 额度用完；等冷却，面板里能看账号额度和冷却 |
| `404 model_not_found` | 模型名不在 `/v1/models` 里（例如 `claude-sonnet-4-6` 在这个账号没开） |
| 第一轮能调工具、之后 400 | 2.3 的 `functionResponse.name` 修复没打 |
| 回复很慢 / 偶发不回 | 看反代面板账号 `healthScore`，多次失败会进冷却；`POST /api/accounts/reset-all` 可清冷却。`gemini-3-flash` 走 sandbox 池，`gemini-2.5-*` 走 CLI 池，后者没许可时更容易 403 |
| 桥接日志 `session ... already exists / owned by active write handle` | 是 DSH 会话锁，不是反代问题；桥接已内置「换新会话 id 重试」 |

## 7. 安全

- `proxy/antigravity-accounts.json` 里有 Google refresh token，**不要提交、不要外发**。
- 反代只监听 `127.0.0.1`，不要改成 `0.0.0.0` 暴露到局域网。
- 本仓库的 `.gitignore` 已排除 `config.json`、`state/`、`dsh/*.generated.yml`。
