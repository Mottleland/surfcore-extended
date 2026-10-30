// 小红书链路体检：npm run xhs:doctor 或 node scripts/xhs-doctor.mjs
//
// 目的：新用户 clone 之后，不用读文档就能知道「差什么」。
// 只读：不改配置、不起进程、不登录。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

function loadConfig() {
  const p = path.join(ROOT, 'config.json');
  if (!fs.existsSync(p)) return { config: null, path: p };
  try {
    let text = fs.readFileSync(p, 'utf8');
    if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
    return { config: JSON.parse(text), path: p };
  } catch (error) {
    return { config: null, path: p, error: String(error?.message ?? error) };
  }
}

const ok = (s) => `  ✅ ${s}`;
const bad = (s) => `  ❌ ${s}`;
const warn = (s) => `  ⚠️  ${s}`;

async function httpJson(url, { token = '', timeoutMs = 3000 } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: token ? { authorization: `Bearer ${token}` } : {},
    });
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { /* 非 JSON */ }
    return { ok: res.ok, status: res.status, json, text };
  } catch (error) {
    return { ok: false, status: 0, error: String(error?.message ?? error) };
  } finally {
    clearTimeout(timer);
  }
}

const problems = [];
const hints = [];

console.log('小红书链路体检\n');

// 1) 配置
const { config, path: cfgPath, error: cfgError } = loadConfig();
if (!config) {
  console.log(bad(`读不到 ${cfgPath}${cfgError ? `：${cfgError}` : ''}`));
  console.log('     → 复制 config.example.json 为 config.json 后重试');
  process.exit(1);
}
const xhs = config.xhs ?? {};
console.log('【配置】');
console.log(fs.existsSync(cfgPath) ? ok(`config.json 存在：${cfgPath}`) : bad('config.json 不存在'));

if (xhs.enabled === false) {
  console.log(warn('xhs.enabled = false：整条链路已关闭（群里发链接不会触发）'));
  hints.push('想启用：把 config.json 里 xhs.enabled 改成 true');
}
const baseUrl = String(xhs.baseUrl || 'http://127.0.0.1:18060').replace(/\/+$/, '');
if (xhs.baseUrl) console.log(ok(`服务地址：${baseUrl}`));
else console.log(warn(`没配 xhs.baseUrl，使用默认 ${baseUrl}`));

const token = String(xhs.authToken || process.env.XHS_AUTH_TOKEN || '');
if (!token) {
  console.log(bad('xhs.authToken 为空：服务端启用了 AUTH_TOKEN 时会 401'));
  problems.push('authToken');
  hints.push('生成一个随机串，同时写进 config.json 的 xhs.authToken 与服务启动环境变量 AUTH_TOKEN');
} else {
  console.log(ok(`鉴权 token：已配置（${token.length} 字符）`));
}

// 2) 服务探活
console.log('\n【服务】');
const health = await httpJson(`${baseUrl}/health`);
if (!health.ok) {
  console.log(bad(`连不上 ${baseUrl}/health${health.error ? `（${health.error}）` : `（HTTP ${health.status}）`}`));
  problems.push('service');
  hints.push('启动 xiaohongshu-mcp（默认监听 127.0.0.1:18060）；首次运行会下载内置浏览器');
} else {
  console.log(ok(`服务在线（${health.json?.data?.status ?? 'ok'}）`));
}

// 3) 登录态
console.log('\n【登录】');
if (health.ok) {
  // 登录态查询会真的去问小红书，慢一点；给 20 秒（实测要 7~8 秒）
  const login = await httpJson(`${baseUrl}/api/v1/login/status`, { token, timeoutMs: 20000 });
  if (login.status === 401) {
    console.log(bad('服务端要求鉴权但 token 不匹配（HTTP 401）'));
    problems.push('auth');
    hints.push('让 config.json 的 xhs.authToken 与服务端 AUTH_TOKEN 完全一致');
  } else if (!login.ok) {
    console.log(bad(`查询登录态失败${login.error ? `（${login.error}）` : `（HTTP ${login.status}）`}`));
    problems.push('login-check');
    hints.push('确认服务已启动且未卡在浏览器初始化；稍后重试，或直接看服务端日志');
  } else if (login.json?.data?.is_logged_in) {
    console.log(ok(`已登录：${login.json.data.username ?? '(未知昵称)'}`));
  } else {
    console.log(bad('未登录：小红书需要扫码'));
    problems.push('login');
    hints.push('运行 xiaohongshu-login-windows-amd64.exe 用手机扫码（登录态存在本机，只需一次）');
  }
}

// 4) 读取配额
console.log('\n【配额】');
const quotaPath = path.join(ROOT, 'state', 'xhs-quota.json');
let used = 0;
try {
  const q = JSON.parse(fs.readFileSync(quotaPath, 'utf8'));
  const d = new Date();
  const today = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  used = q.day === today ? Number(q.count) || 0 : 0;
} catch { /* 没读过就是 0 */ }
const limit = Number(xhs.maxReadsPerDay) || 0;
console.log(ok(`今日读取 ${used} 次${limit > 0 ? ` / ${limit}` : '（不限）'}`));
console.log(ok(`每群每小时最多触发 ${Number(xhs.maxPerHour) > 0 ? xhs.maxPerHour : '不限'} 次`));
console.log(ok(`附带评论 ${Number(xhs.maxComments) ?? 5} 条 · 排序 ${xhs.commentOrder || 'hot'}`));

// 5) 启动脚本 / 计划任务
console.log('\n【启动方式】');
const script = String(xhs.launchScript || '');
if (!script) {
  console.log(warn('未配置 xhs.launchScript：一键启动时无法兜底拉起服务'));
  hints.push('可选：填一个启动脚本路径（例如 run-xhs-mcp.bat），或在设置页「小红书」里点「启动服务」');
} else if (!fs.existsSync(script)) {
  console.log(bad(`启动脚本不存在：${script}`));
  problems.push('launchScript');
} else {
  console.log(ok(`启动脚本：${script}`));
}

// 6) 结论
console.log('\n' + '─'.repeat(46));
if (!problems.length) {
  console.log('结论：链路就绪 ✅ 群里发一条带 xsec_token 的小红书链接即可。');
  if (hints.length) {
    console.log('\n可选优化：');
    hints.forEach((h) => console.log('  · ' + h));
  }
} else {
  console.log(`结论：还差 ${problems.length} 项 → ${problems.join(', ')}`);
  console.log('\n按顺序做：');
  hints.forEach((h, i) => console.log(`  ${i + 1}. ${h}`));
  console.log('\n详细说明见 docs/guides/XHS.md');
  process.exitCode = 1;
}
