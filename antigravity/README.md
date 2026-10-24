# Antigravity → Gemini 一键部署

这个目录把「Antigravity 反代 Gemini 接进 DSH」打包成脚本，免得每台设备手动改第三方源码。

```bat
install-antigravity.cmd
```

它会：

1. 用 DSH 自带的 pnpm 安装 `bun` + `antigravity-proxy@0.7.0` 到 `%USERPROFILE%\.dsh\antigravity`
2. 复制一份 proxy 工作目录，并自动打上必须的补丁：
   - 端口改成 `3457` 且只监听 `127.0.0.1`（避开 SnowLuma 的 3000）
   - OAuth 回调改成 `http://localhost:3457/oauth-callback`
   - 工具结果补 `functionResponse.name`（不打这个补丁，模型第二轮必 400）
   - 客户端版本改成 `2.5.5`（决定能不能看到 Gemini 3.8 Flash）
   - 拉模型列表时不再覆盖 UA（否则版本信息丢失，目录退回旧版）
   - 账号文件改成原子写（并发保存不会写坏）
3. 生成 `start-proxy.cmd`（带 `HTTPS_PROXY=http://127.0.0.1:2712`，按自己的梯子改）
4. 给 DSH 的 `sdk` / `desktop` profile 加 `llm-pi-ai` 的 `antigravity` provider，并写入凭据占位

## 装完之后

1. 开梯子（新加坡/美国/日本，HK 和大陆不行）
2. 运行 `%USERPROFILE%\.dsh\antigravity\start-proxy.cmd`
3. 浏览器打开 `http://127.0.0.1:3457/oauth/start`，用 Google 账号登录
   - 报 `#3501 SUBSCRIPTION_REQUIRED`：用同一账号装一次 Antigravity IDE 登录，拿许可
   - 报 `UNSUPPORTED_LOCATION`：换节点
4. `curl http://127.0.0.1:3457/v1/models`，应该能看到 `gemini-3.8-flash-high/medium/low`
5. 重启 DSH；qq-bridge 的 `config.json` 设：
   ```json
   "provider": "antigravity",
   "model": "gemini-3.8-flash-medium",
   "reasoningEffort": ""
   ```

## 可选参数

```bat
install-antigravity.cmd --dsh-home D:\dsh-home --port 3457 --vpn-proxy http://127.0.0.1:7890 --no-profiles
```

- `--dsh-home`：DSH 配置目录，默认 `%USERPROFILE%\.dsh`
- `--port`：反代端口，默认 3457
- `--vpn-proxy`：梯子的 HTTP 代理，默认 `http://127.0.0.1:2712`
- `--no-profiles`：只装反代，不改 DSH profile

完整原理和排错见 [docs/ANTIGRAVITY.md](../docs/ANTIGRAVITY.md)。
