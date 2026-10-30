// 小红书只读 MCP 适配层（stdio）。
//
// 为什么要有这一层：上游 xpzouying/xiaohongshu-mcp 同时暴露读和写
// （publish / post_comment / like / favorite / delete_cookies）。QQ 群是
// 不可信输入源，绝不能把这些能力交给群里的模型。这里只保留两个只读工具：
//
//   xhs_check_status            服务 + 登录态体检
//   xhs_read_note_from_share_url 从"分享文案/长链/短链"读一篇笔记
//
// 它自己不做浏览器自动化：所有真实抓取都由本地运行的上游 HTTP 服务完成
// （默认 127.0.0.1:18060，AUTH_TOKEN 保护）。这样登录态只有一份，
// 也不会出现两个网页端互相踢 Cookie 的问题。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { resolveShareText, extractXhsUrls } from './xhs-link.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

// ── 配置 ──────────────────────────────────────────────────────────────────
function loadConfig() {
  try {
    let text = fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8');
    if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
    return JSON.parse(text);
  } catch {
    return {};
  }
}

/** 上游服务地址 / token：环境变量优先，其次是 config.json 的 xhs 段。 */
function upstream() {
  const cfg = loadConfig();
  const x = cfg?.xhs ?? {};
  const baseUrl = String(process.env.XHS_BASE_URL || x.baseUrl || 'http://127.0.0.1:18060').replace(/\/+$/, '');
  const token = String(process.env.XHS_AUTH_TOKEN || x.authToken || '');
  const timeoutMs = Number(process.env.XHS_TIMEOUT_MS || x.timeoutMs || 20000);
  return { baseUrl, token, timeoutMs };
}

// ── 每日读取配额（单独限制；总 token 限制由桥接的 tokenGuard 统一负责）────────
// 说明：真正的模型花费走 DSH 会话，被 tokenGuard / token-budget 统一管；
// 这里只管"今天读了几篇"，防止有人连发链接把额度烧光，也给用户一个可预期的上限。
const QUOTA_PATH = path.join(ROOT, 'state', 'xhs-quota.json');
function todayKey() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function readQuota() {
  try {
    const j = JSON.parse(fs.readFileSync(QUOTA_PATH, 'utf8'));
    const day = todayKey();
    if (j?.day === day) return { day, count: Number(j.count) || 0 };
  } catch { /* 缺文件/坏文件都当今天 0 次 */ }
  return { day: todayKey(), count: 0 };
}
function bumpQuota() {
  const q = readQuota();
  q.count += 1;
  try {
    fs.mkdirSync(path.dirname(QUOTA_PATH), { recursive: true });
    fs.writeFileSync(QUOTA_PATH, JSON.stringify(q), 'utf8');
  } catch { /* 配额写不进去不影响读取本身 */ }
  return q;
}

// ── 极简并发闸 + 结果缓存（防止群里连发链接把上游打爆）────────────────────
const MAX_CONCURRENCY = 2;
let running = 0;
const waiters = [];
async function withSlot(fn) {
  if (running >= MAX_CONCURRENCY) await new Promise((resolve) => waiters.push(resolve));
  running += 1;
  try {
    return await fn();
  } finally {
    running -= 1;
    const next = waiters.shift();
    if (next) next();
  }
}

const CACHE_TTL_MS = 10 * 60 * 1000;const CACHE_MAX = 50;
const cache = new Map();
function cacheGet(key) {
  const hit = cache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.at > CACHE_TTL_MS) { cache.delete(key); return null; }
  return hit.value;
}
function cacheSet(key, value) {
  cache.set(key, { at: Date.now(), value });
  while (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
}

// ── HTTP 调用 ─────────────────────────────────────────────────────────────
async function callUpstream(method, apiPath, body) {
  const { baseUrl, token, timeoutMs } = upstream();
  const url = `${baseUrl}${apiPath}`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method,
      signal: ctrl.signal,
      headers: {
        ...(body ? { 'content-type': 'application/json' } : {}),
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { /* 非 JSON */ }
    if (res.status === 401) {
      return { ok: false, code: 'upstream_unauthorized', message: '上游服务要求鉴权（AUTH_TOKEN 不匹配）', status: 401 };
    }
    if (!res.ok) {
      return {
        ok: false,
        code: json?.code || `upstream_http_${res.status}`,
        message: json?.error || json?.message || `上游返回 ${res.status}`,
        details: json?.details ?? text.slice(0, 500),
        status: res.status,
      };
    }
    if (!json) return { ok: false, code: 'upstream_bad_json', message: '上游返回的不是 JSON', details: text.slice(0, 500) };
    return { ok: true, json };
  } catch (error) {
    const code = error?.name === 'AbortError' ? 'upstream_timeout' : 'upstream_unreachable';
    const message = error?.name === 'AbortError'
      ? `上游服务 ${timeoutMs}ms 内没有响应`
      : `连不上上游服务（${baseUrl}）：${String(error?.message ?? error)}`;
    return { ok: false, code, message, hint: '确认 xiaohongshu-mcp 已启动并监听 127.0.0.1:18060', status: 0 };
  } finally {
    clearTimeout(timer);
  }
}

function authHint(result) {
  if (result?.code === 'upstream_unauthorized') return '检查 XHS_AUTH_TOKEN 与服务端 AUTH_TOKEN 是否一致';
  if (result?.code === 'upstream_unreachable' || result?.code === 'upstream_timeout') return '先启动 xiaohongshu-mcp 服务（默认 http://127.0.0.1:18060）';
  return undefined;
}

// ── 数据规范化 ────────────────────────────────────────────────────────────
function pick(...values) {
  for (const v of values) {
    if (v !== undefined && v !== null && v !== '') return v;
  }
  return undefined;
}

function normalizeImages(data) {
  const list = pick(data?.imageList, data?.image_list, data?.images, data?.note_card?.image_list) ?? [];
  if (!Array.isArray(list)) return [];
  return list.map((it, i) => {
    if (typeof it === 'string') return { index: i, url: it };
    return {
      index: i,
      url: pick(it?.urlDefault, it?.url, it?.url_default, it?.urlPre, it?.url_pre) ?? '',
      width: it?.width ?? it?.widthDefault,
      height: it?.height ?? it?.heightDefault,
      live: Boolean(it?.livePhoto ?? it?.live_photo),
      text: typeof it?.text === 'string' ? it.text : undefined,
    };
  }).filter((it) => it.url);
}

function normalizeComments(data, maxComments, order = 'hot') {
  // 上游实际结构：{ comments: { list: [...] } }；也兼容直接给数组的老版本。
  const raw = pick(data?.comments?.list, data?.comments, data?.comment_list, data?.commentList) ?? [];
  const list = Array.isArray(raw) ? raw : [];
  const mapped = [];
  for (const c of list) {
    const user = pick(c?.userInfo?.nickname, c?.userInfo?.nickName, c?.user?.nickname, c?.nickname, '');
    const content = pick(c?.content, c?.text, c?.note ?? '');
    if (!content) continue;
    mapped.push({
      user,
      content: String(content).slice(0, 300),
      likes: Number(pick(c?.likeCount, c?.like_count, c?.liked_count, 0)) || 0,
      isAuthor: Boolean(c?.isAuthor ?? c?.is_author),
      replies: Number(pick(c?.subCommentCount, c?.sub_comment_count, Array.isArray(c?.subComments) ? c.subComments.length : 0)) || 0,
    });
  }
  // 排序：hot = 按点赞降序（"最热前 N 条"）；order = 保持上游原始顺序
  if (String(order).toLowerCase() === 'hot') {
    mapped.sort((a, b) => b.likes - a.likes);
  }
  // 取前 N 条；作者自己的回复排前面没有意义，这里不特殊处理，保持点赞口径一致
  return maxComments > 0 ? mapped.slice(0, maxComments) : [];
}

function normalizeNote(data, context) {
  // 上游 /api/v1/feeds/detail 的真实结构是 { feed_id, data: { note, comments } }，
  // 这里先拆平两层 data，再兼容 note_card 之类的旧字段名。
  const root = data?.data && typeof data.data === 'object' ? data.data : data;
  const note = root?.note ?? root?.note_card ?? root?.items?.[0]?.note_card ?? root ?? {};
  const user = note?.user ?? root?.user ?? {};
  const interact = note?.interactInfo ?? note?.interact_info ?? root?.interact_info ?? {};
  const video = note?.video ?? root?.video ?? null;
  const title = String(pick(note?.title, note?.display_title, root?.title, '') ?? '');
  const desc = String(pick(note?.desc, note?.description, root?.desc, root?.description, '') ?? '');
  return {
    id: context.noteId,
    url: context.url,
    sourceUrl: context.originalUrl,
    resolvedVia: context.via,
    title,
    desc,
    descChars: desc.length,
    type: video ? 'video' : 'image',
    author: {
      id: String(pick(user?.userId, user?.user_id, user?.id, '') ?? ''),
      name: String(pick(user?.nickname, user?.nick_name, user?.name, '') ?? ''),
      avatar: pick(user?.avatar, user?.image, ''),
    },
    interact: {
      likes: Number(pick(interact?.likedCount, interact?.liked_count, data?.liked_count, 0)) || 0,
      collects: Number(pick(interact?.collectedCount, interact?.collected_count, data?.collected_count, 0)) || 0,
      comments: Number(pick(interact?.commentCount, interact?.comment_count, data?.comment_count, 0)) || 0,
      shares: Number(pick(interact?.shareCount, interact?.share_count, 0)) || 0,
    },
    images: normalizeImages(note),
    video: video ? {
      duration: video?.duration ?? note?.video?.duration,
      cover: pick(video?.image?.urlDefault, video?.cover, ''),
      subtitleUrl: pick(video?.subtitles?.[0]?.url, video?.subtitle_url, ''),
      hasSubtitles: Boolean(video?.subtitles?.length || video?.subtitle_url),
      streamCount: Array.isArray(video?.media?.stream?.h264) ? video.media.stream.h264.length : undefined,
    } : null,
    comments: normalizeComments(root, context.maxComments, context.commentOrder),
    fetchedAt: new Date().toISOString(),
  };
}

// ── 工具实现 ──────────────────────────────────────────────────────────────
async function checkStatus() {
  const health = await callUpstream('GET', '/health');
  if (!health.ok) {
    return { ok: false, code: health.code, message: health.message, hint: authHint(health), service: upstream().baseUrl };
  }
  const login = await callUpstream('GET', '/api/v1/login/status');
  const data = login.ok ? (login.json?.data ?? {}) : {};
  const loggedIn = Boolean(pick(data?.is_logged_in, data?.isLoggedIn, data?.logged_in, data?.login));
  return {
    ok: true,
    service: {
      reachable: true,
      baseUrl: upstream().baseUrl,
      status: health.json?.data?.status ?? 'unknown',
      account: health.json?.data?.account ?? undefined,
    },
    login: {
      loggedIn,
      nickname: pick(data?.username, data?.nickname, data?.nick_name),
      userId: pick(data?.user_id, data?.userId),
      hint: loggedIn ? undefined : '小红书未登录或登录已失效：在服务器上用 login 工具扫码（二维码），或访问 /api/v1/login/qrcode',
    },
    quota: (() => {
      const q = readQuota();
      const limit = Math.max(0, Number(loadConfig()?.xhs?.maxReadsPerDay) || 0);
      return { day: q.day, used: q.count, limit, remaining: limit > 0 ? Math.max(0, limit - q.count) : null };
    })(),
  };
}

async function readNote({ text, maxComments = 6 }) {
  // 设置页的「附带评论条数」是硬上限：模型传再多也不越过（0 = 不带评论）
  const cfg = loadConfig()?.xhs ?? {};
  const cfgCapRaw = Number(cfg.maxComments);
  const cap = Number.isFinite(cfgCapRaw) ? Math.max(0, Math.min(20, cfgCapRaw)) : 6;
  const effectiveComments = Math.max(0, Math.min(Number(maxComments) || 0, cap));
  const commentOrder = String(cfg.commentOrder || 'hot').toLowerCase() === 'order' ? 'order' : 'hot';
  const urls = extractXhsUrls(text);
  if (!urls.length) {
    return { ok: false, code: 'no_xhs_url', message: '这段文字里没有小红书链接' };
  }
  const resolved = await resolveShareText(text);
  if (!resolved.ok) {
    return {
      ok: false,
      code: resolved.code,
      message: resolved.reason || resolved.message || '链接解析失败',
      originalUrl: resolved.originalUrl,
      chain: resolved.chain,
      hint: resolved.code === 'note_id_not_found'
        ? '这是笔记主页以外的链接（例如用户主页/搜索结果），请让对方发"笔记分享"链接'
        : undefined,
    };
  }
  if (!resolved.xsecToken) {
    return {
      ok: false,
      code: 'missing_xsec_token',
      message: '链接里缺少 xsec_token，上游接口无法读取该笔记（小红书对无 token 的详情请求会拒绝）',
      noteId: resolved.noteId,
      originalUrl: resolved.originalUrl,
      hint: '请让对方用 App 里「分享 → 复制链接」再发一次（那条会带 xsec_token）；或直接把笔记标题/作者发来，我按关键词搜索后再核对。',
    };
  }
  const cacheKey = `${resolved.noteId}:${resolved.xsecToken}:${effectiveComments}:${commentOrder}`;
  const cached = cacheGet(cacheKey);
  if (cached) return { ...cached, cached: true };

  // 每日读取上限（单独限制；0 = 不限）。缓存命中不计次。
  const dailyLimit = Math.max(0, Number(cfg.maxReadsPerDay) || 0);
  const quotaBefore = readQuota();
  if (dailyLimit > 0 && quotaBefore.count >= dailyLimit) {
    return {
      ok: false,
      code: 'xhs_daily_limit',
      message: `今天的小红书读取次数已用完（${quotaBefore.count}/${dailyLimit}）`,
      quota: { day: quotaBefore.day, used: quotaBefore.count, limit: dailyLimit },
      hint: '明天 0 点自动重置；要放宽就到设置页「小红书」把「每天最多读取」调大',
    };
  }

  const detail = await withSlot(() => callUpstream('POST', '/api/v1/feeds/detail', {
    feed_id: resolved.noteId,
    xsec_token: resolved.xsecToken,
    load_all_comments: false,
  }));
  if (!detail.ok) {
    return {
      ok: false,
      code: detail.code,
      message: detail.message,
      details: detail.details,
      hint: authHint(detail),
      noteId: resolved.noteId,
    };
  }
  const data = detail.json?.data ?? detail.json ?? {};
  const note = normalizeNote(data, {
    noteId: resolved.noteId,
    url: resolved.url,
    originalUrl: resolved.originalUrl,
    via: resolved.via,
    maxComments: effectiveComments,
    commentOrder,
  });
  const result = { ok: true, note };
  cacheSet(cacheKey, result);
  bumpQuota();
  void writeNoteMemory(note).catch(() => {});
  return result;
}

/**
 * 把"读了什么"写进专门记忆（platform=shared / source=xhs-read）。
 * 直接追加到活动角色的 memory-inbox.jsonl：不经过 QQ 消息通道，也不会被当成群聊发言。
 * 先试桥接口（有 console token 时），没 token 就直写 —— 两条路径都失败则静默忽略。
 */
function memoryInboxPath() {
  // 角色记忆目录：~/.dsh/surfcore/characters/<id>/memory/memory-inbox.jsonl
  const home = process.env.DSH_HOME || path.join(process.env.USERPROFILE || process.env.HOME || '', '.dsh');
  const root = path.join(home, 'surfcore', 'characters');
  try {
    const dirs = fs.readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory());
    let best = null;
    for (const d of dirs) {
      const inbox = path.join(root, d.name, 'memory', 'memory-inbox.jsonl');
      try {
        const st = fs.statSync(inbox);
        if (!best || st.mtimeMs > best.mtimeMs) best = { path: inbox, mtimeMs: st.mtimeMs };
      } catch { /* 该角色没有记忆文件 */ }
    }
    return best?.path ?? null;
  } catch {
    return null;
  }
}

async function writeNoteMemory(note) {
  try {
    const inbox = memoryInboxPath();
    if (!inbox) return;
    const summary = String(note?.desc ?? '').replace(/\s+/g, ' ').slice(0, 200);
    const topComment = String(note?.comments?.[0]?.content ?? '').slice(0, 120);
    const text = `【小红书】读了《${String(note?.title || '无标题').slice(0, 100)}》`
      + `${note?.author?.name ? `（${String(note.author.name).slice(0, 40)}）` : ''}：${summary}`
      + `${topComment ? ` ｜热评：${topComment}` : ''}`;
    fs.appendFileSync(inbox, `${JSON.stringify({
      at: new Date().toISOString(),
      platform: 'shared',
      kind: 'event',
      sender: '小红书',
      senderId: '',
      groupId: '',
      isOwner: false,
      isSelf: false,
      private: false,
      direct: true,
      text,
      quoteSelf: false,
      source: 'xhs-read',
    })}\n`, 'utf8');
  } catch { /* 记忆写不进去不该让读取失败 */ }
}

// ── MCP server ────────────────────────────────────────────────────────────
const server = new McpServer({ name: 'xhs-reader', version: '1.0.0' });

function asText(payload) {
  return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }] };
}

server.registerTool('xhs_check_status', {
  title: '小红书服务与登录状态',
  description: '检查本地小红书 MCP 服务是否可用、是否已登录。读笔记失败时先调它排查。',
  inputSchema: {},
  annotations: { readOnlyHint: true },
}, async () => {
  try {
    return asText(await checkStatus());
  } catch (error) {
    return asText({ ok: false, code: 'internal_error', message: String(error?.message ?? error) });
  }
});

server.registerTool('xhs_read_note_from_share_url', {
  title: '读取小红书笔记（只读）',
  description: [
    '从 QQ 群里收到的小红书分享内容里读取笔记真实内容：支持长链接、xhslink.com 短链、以及带分享文案的整段文本。',
    '返回标题、正文、作者、图片列表、视频信息、互动数据和少量评论。',
    '只读：不能发布、评论、点赞、收藏。',
    '如果返回 ok:false，必须如实告诉群友没读到（附 reason），绝不假装看过。',
  ].join(' '),
  inputSchema: {
    text: z.string().min(1).max(4000).describe('包含小红书链接的原始文本（可以直接把群消息整段贴进来）'),
    maxComments: z.number().int().min(0).max(20).optional().describe('附带几条一级评论，默认 6；0 表示不带'),
  },
  annotations: { readOnlyHint: true },
}, async ({ text, maxComments }) => {
  try {
    return asText(await readNote({ text, maxComments: maxComments ?? 6 }));
  } catch (error) {
    return asText({ ok: false, code: 'internal_error', message: String(error?.message ?? error) });
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
