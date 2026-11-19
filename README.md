# HIDS 智能研判平台 · 后端

从 `2026_ai_coding_sme_core` 的 `02-AI-Code-Lab/2026-11-12-hids-refresh/backend` 拆出的独立仓库。只含业务后端，不含客户前端和维护页面。

业务 API、Syslog 接收与研判服务默认监听 `127.0.0.1:8080`。独立维护 API 默认监听 `127.0.0.1:18081`。接口见 `openapi.yaml`。

需要 Node.js 20+。复制 `.env.example` 为 `.env.local` 后：

```bash
node --env-file=.env.local server.js
npm test                 # 后端单测（node --test --test-timeout=60000 --test-force-exit *.test.js）
```

运行中的案件、研判记录与配置落在机器全局的数据根：`HIDS_DATA_DIR` 指到哪就落哪，没设就是 `~/.local/share/hids-ai-console/`（仓库里不写任何运行态）。Wiki 与提示词在 `wiki/`、`prompts/`。
