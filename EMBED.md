## 上游嵌入

- 工作方式：整仓魔改（主流）— **真实树在 `$AGNX_HOME/apps/boujoy-harness/`**（禁止跨仓软链当真相）
- 推荐模式：Wrap 原 Boujoy Web UI + Sidecar 网关；Agent 优先靠 `host.config` + 极薄 `boujoy_*` 工具拉起流水线
- 上游：asen-goat-mine/boujoy-harness（本目录 `git remote origin`）；本地初始提交含 Agnx 胶水
- Port 切片：`tools/ensure-boujoy-gateway.mjs`；`web/boujoy_server.py` 支持 `BOUJOY_DISABLE_PARENT_WATCH` / `BOUJOY_ALLOW_IFRAME`
- 健康判定：须 `/api/health` 或 `/api/heartbeat` **2xx + Boujoy JSON 指纹**，且 reuse 时 pid 须仍为 `boujoy_server.py`（禁止把同口其它 HTTP 当网关）
- 默认值：Vault=`demo-vault/`；网关 `127.0.0.1:8766`；状态 `apps/data/<appId>/boujoy-gateway.json`
