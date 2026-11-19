# P003-T027 字段口径核对：真管道日志 vs docs/architecture.md 事件表

来源：`node evidence/test/P003-T027/acceptance-e2e.mjs`（真 `node server.js` + 真 UDP + 真 stdout，本目录 `real-pipeline-after.txt` 为全文），从 stdout 里抓 `syslog.match_failed` 行逐键对照文档。

## 1 文档那一行（`docs/architecture.md:134`）写的字段

```text
rule msgid type reason mismatch missing candidates nearest_gap_seconds window_seconds
```

## 2 真日志逐条（键集合）

- rule=`payload` → time, level, event, rule, msgid, missing, reason
- rule=`event_id` → time, level, event, rule, type, msgid, event_id, mismatch, reason
- rule=`time_window` → time, level, event, rule, type, msgid, host_ip, window_seconds, candidates, nearest_gap_seconds, reason
- rule=`time_window` → time, level, event, rule, type, msgid, host_ip, reason

四条分支键的并集：candidates, event, event_id, host_ip, level, mismatch, missing, msgid, nearest_gap_seconds, reason, rule, time, type, window_seconds

## 3 结论

- 真日志里**没有 `event_type`**，有的是 `type`；文档已改成 `type`（本轮改动）。
- 文档写的每个字段都在真日志里出现过：rule✓ msgid✓ type✓ reason✓ mismatch✓ missing✓ candidates✓ nearest_gap_seconds✓ window_seconds✓
- `payload` 分支没有 `type`（事件类型已知但该分支不带），文档已注明；`event_type` 只属于 `syslog.received`（`triage-monitor.js:362`）。
