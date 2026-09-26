## 上游嵌入

- 工作方式：整仓魔改（主流）— **真实树在 `$AGNX_HOME/apps/boujoy-harness/`**（禁止跨仓软链当真相）
- 推荐模式：Wrap 原 Boujoy Web UI + Sidecar 网关；Agent 优先靠 `host.config` + 极薄 `boujoy_*` 工具拉起流水线
- 上游：asen-goat-mine/boujoy-harness（本目录 `git remote origin`）；本地初始提交含 Agnx 胶水
- Port 切片：`tools/ensure-boujoy-gateway.mjs`；`web/boujoy_server.py` 支持 `BOUJOY_DISABLE_PARENT_WATCH` / `BOUJOY_ALLOW_IFRAME`
- 健康判定：须 `/api/health` 或 `/api/heartbeat` **2xx + Boujoy JSON 指纹**（含 `instanceId`），且 reuse 时与 process-registry 标记一致（禁止把同口其它 HTTP 当网关）
- **supervised**：`manifest.sidecar.supervised=true`；`ensure --supervised` 只输出 plan，由 daemon spawn
- 默认值：Vault=`demo-vault/`；网关 `127.0.0.1:8766`；状态 `apps/data/<appId>/boujoy-gateway.json`
- **引擎口**：Boujoy 自管 DSH 用 `3180`（knowledge）/ `3181`（clean），避开 deepseek-harness 默认 `3080`
- **ensure**：supervised 也会先拉起 DSH（stdout 取 `?token=`），plan 带 `--knowledge-auth-url` / `--clean-auth-url`；网关 `_proxy_harness_rpc` 换 Cookie + 旧点号 RPC→新斜杠 API
