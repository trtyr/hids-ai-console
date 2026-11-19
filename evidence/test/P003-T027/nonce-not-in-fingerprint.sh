#!/usr/bin/env bash
# 「nonce 不进指纹」的可复跑脚本（何东阳 / 后端测试）
#
# 依据：docs/modules/triage-pipeline.md §4.1 把参与指纹的字段逐项列死
#   （固定部分 = 主机 IP / MsgId / 事件名；honeypot 类型再加 source_ip / target_ip / target_port），
#   nonce 不在任何一档。用法照文档给的 fingerprint(parsed) 写法（同节示例代码）。
#
# 三行输出：
#   1) nonce=run1-1 的指纹
#   2) nonce=run2-2 的指纹
#   3) 换 nonce 后指纹是否相同     → 必须 true（否则说明 nonce 进了指纹，报告结论作废）
#   对照：改 source_ip（honeypot 的参与字段）后指纹是否改变 → 必须 true（证明本脚本量得出变化，不是恒等）
#
# 跑法：bash evidence/test/P003-T027/nonce-not-in-fingerprint.sh
# 退出码 0 = 结论成立；1 = 结论不成立或探针不可信。
set -u
cd "$(dirname "$0")/../../.." || exit 1
timeout 60 node --input-type=module <<'EOF'
import { fingerprint } from './syslog-input.js';
const mk = (nonce, sourceIp = '192.0.2.76') => ({
  msgid: 'cloudwalker-honeypot',
  ts: '2026-11-17T10:00:00Z',
  payload: { host_ip: '10.0.0.5', event_name: 'honeypot', source_ip: sourceIp, nonce },
});
const a = fingerprint(mk('run1-1'));
const b = fingerprint(mk('run2-2'));
const c = fingerprint(mk('run1-1', '192.0.2.99'));
console.log('nonce=run1-1 ->', a);
console.log('nonce=run2-2 ->', b);
console.log('换 nonce 后指纹是否相同 ->', a === b);
console.log('对照：只改 source_ip 后指纹是否改变 ->', a !== c);
process.exit(a === b && a !== c ? 0 : 1);
EOF
