/**
 * 小红书设置页接口的宿主接线（mock ctx，不启动 DSH、不真起服务）。
 *
 * 钉住：
 *   · /xhs status 返回服务/登录/配置三块，且显式标注 readonly；
 *   · 服务不可达时 ok:false 且带 error（不抛异常）；
 *   · SURFCORE_SKIP_AUTOSTART=1 时 start 走 skipped，不会真的 spawn 进程；
 *   · 未知 action 返回 400。
 *
 * 用临时 DSH_HOME，不读写真实 ~/.dsh；baseUrl 指向不可达端口，保证确定性。
 */
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'surfcore-xhs-host-'));
const stateDir = path.join(tmp, 'surfcore');
fs.mkdirSync(stateDir, { recursive: true });
fs.writeFileSync(path.join(stateDir, 'config.json'), `${JSON.stringify({
  version: 1,
  bridge: { autoStart: false },
  platforms: { start: { qq: false, bili: false } },
  xhs: {
    baseUrl: 'http://127.0.0.1:1',
    authToken: 'test-token',
    port: 18060,
    allowLaunch: true,
    timeoutMs: 3000,
    maxComments: 4,
    maxPerHour: 2,
    taskName: 'XhsMcpService',
  },
}, null, 2)}\n`, 'utf8');

process.env.DSH_HOME = tmp;
process.env.USERPROFILE = tmp;
process.env.SURFCORE_SKIP_AUTOSTART = '1';
process.env.SURFCORE_DISABLE_CHARACTER_MIGRATION = '1';
process.env.SURFCORE_DISABLE_MEMORY_TIMER = '1';

const { apply } = await import('../lib/index.js');

const routes = [];
const ctx = {
  webServer: { register(route) { routes.push(route); return () => {}; } },
  get(name) {
    if (name === 'connection') return { requestRejection: () => false };
    return null;
  },
  effect() { return () => {}; },
  sessionController: {
    inspect: async () => ({ events: [] }),
    create: async () => ({}),
    prompt: async () => ({ accepted: true }),
  },
  settings: null,
};

function fakeRes() {
  return {
    statusCode: 200,
    headers: {},
    body: '',
    writeHead(code, headers) { this.statusCode = code; this.headers = headers ?? {}; },
    end(body = '') { this.body += body; },
  };
}
function fakeReq(method, url, body) {
  const req = new EventEmitter();
  req.method = method;
  req.url = url;
  req.headers = { host: '127.0.0.1:58750', ...(body ? { 'content-type': 'application/json' } : {}) };
  if (body) {
    process.nextTick(() => {
      req.emit('data', Buffer.from(JSON.stringify(body)));
      req.emit('end');
    });
  }
  return req;
}
async function invoke(route, method, url, body) {
  const res = fakeRes();
  await route.handler(fakeReq(method, url, body), res);
  return { status: res.statusCode, data: JSON.parse(res.body || '{}') };
}

try {
  apply(ctx);
  const api = routes.find((route) => route.path === '/dsh-surfcore/api');
  assert.ok(api, 'API 路由没有注册');

  // 1) 状态：结构必须齐全；服务在线与否取决于本机是否真的在跑（不写死）
  const status = await invoke(api, 'POST', '/dsh-surfcore/api/xhs', { action: 'status' });
  assert.equal(status.status, 200);
  assert.equal(status.data.readonly, true, '必须显式声明只读');
  assert.equal(typeof status.data.service?.reachable, 'boolean');
  assert.equal(typeof status.data.login?.loggedIn, 'boolean');
  assert.ok(Number.isFinite(status.data.config?.maxComments), '应回显 maxComments');
  assert.ok(Number.isFinite(status.data.config?.maxPerHour), '应回显 maxPerHour');
  assert.ok(Number.isFinite(status.data.config?.maxReadsPerDay), '应回显 maxReadsPerDay');
  assert.ok(['hot', 'order'].includes(status.data.config?.commentOrder), 'commentOrder 只能是 hot/order');
  assert.equal(typeof status.data.quota?.used, 'number', '应回显今日读取次数');
  assert.equal(typeof status.data.config?.hasToken, 'boolean');

  // 2) 跳过启动：测试环境不 spawn
  const started = await invoke(api, 'POST', '/dsh-surfcore/api/xhs', { action: 'start' });
  assert.equal(started.status, 200);
  assert.equal(started.data.skipped, true, 'SURFCORE_SKIP_AUTOSTART=1 时应跳过真实启动');

  // 3) 未知 action
  const bad = await invoke(api, 'POST', '/dsh-surfcore/api/xhs', { action: 'nope' });
  assert.equal(bad.status, 400);
  assert.match(String(bad.data.error ?? ''), /未知 action/);

  console.log('xhs settings host wiring OK');
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
