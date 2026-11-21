// UDP 入站（P003-T075 批 2 归位）：牧云 syslog 推送的监听端。dgram 收包 → onLine 回调。
import dgram from 'node:dgram';
import { log } from '../../../shared/logging/log.js';

export class SyslogReceiver {
  constructor({ host = '127.0.0.1', port = 15514, onLine }) {
    this.host = host; this.port = port; this.onLine = onLine; this.socket = null;
  }

  async start() {
    const socket = dgram.createSocket('udp4');
    socket.on('message', data => void Promise.resolve(this.onLine(data.toString('utf8'))).catch(error =>
      log('syslog.handler_failed', { error: error.message }, 'error')));
    socket.on('error', error => log('syslog.receiver_error', { error: error.message }, 'error'));
    await new Promise((resolve, reject) => {
      socket.once('error', reject);
      socket.bind(this.port, this.host, () => { socket.off('error', reject); resolve(); });
    });
    this.socket = socket;
    return socket.address();
  }

  stop() { this.socket?.close(); this.socket = null; }
}
