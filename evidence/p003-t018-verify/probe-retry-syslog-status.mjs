// P003-T018 发现 F1 的复现探针：重试一条「syslog 前缀但没有原始报文」的 ID，看 HTTP 状态码。
// 文档说 404（openapi.yaml retryTriage 的 '404'；docs/modules/triage-pipeline.md §5.4「抛 404」），
// 实测 502（与 docs/modules/http-api.md:353「其余回 502」一致，即文档自相矛盾）。
import { createServer } from '../../server.js';
import { TriageMonitor } from '../../src/contexts/triage/application/triage-monitor.js';
import { InvestigationStore } from '../../src/contexts/triage/infrastructure/investigation-store.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const directory = await mkdtemp(path.join(tmpdir(), 'probe-t18-f1-'));
const monitor = new TriageMonitor({
  file: path.join(directory, 'queue.json'), concurrency: 1,
  history: new InvestigationStore(path.join(directory, 'results')),
  service: { alerts: async () => ({ alerts: [], partial: false }) },
  investigator: { run: async () => { throw new Error('不该跑到研判'); } }
});
await monitor.load();
const server = createServer(null, null, null, null, null, monitor);
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;

const id = 'syslog:honeypot:aaaaaaaaaaaaaaaa:1763392800:6f1b6a4e-4d3a-4b8e-9a4e-2f6f1b6a4e43';
const response = await fetch(`${base}/api/agent/triage/${encodeURIComponent(id)}`, { method: 'POST' });
const text = await response.text();
console.log(`POST /api/agent/triage/{syslog-id}（无原始报文） → ${response.status} ${text}`);
console.log(`文档说：404（openapi retryTriage / triage-pipeline §5.4）；实测：${response.status}`);

server.closeAllConnections?.();
await new Promise(resolve => server.close(resolve));
await rm(directory, { recursive: true, force: true });
process.exitCode = response.status === 404 ? 0 : 1;
