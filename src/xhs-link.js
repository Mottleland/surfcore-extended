// 小红书分享链接解析（纯函数，可单测）
//
// 目标：把 QQ 群里粘来的各种形态统一成 { noteId, xsecToken }，交给上游
// xiaohongshu-mcp 的 /api/v1/feeds/detail 使用。
//
// 覆盖的形态：
//   https://www.xiaohongshu.com/explore/<noteId>?xsec_token=...&xsec_source=...
//   https://www.xiaohongshu.com/discovery/item/<noteId>?xsec_token=...
//   https://www.xiaohongshu.com/note/<noteId>
//   https://xhslink.com/<short>
//   https://www.xhs.cn/<short>（部分分享走这个域）
//   以及"复制文案 + 链接"的整段文本
//
// 安全：只允许小红书官方域，只允许 http(s)，禁止 IP/端口/userinfo，
// 短链重定向逐跳校验，跳数上限 5，超时 5s —— 防 SSRF。

export const ALLOWED_HOSTS = new Set([
  'xiaohongshu.com',
  'www.xiaohongshu.com',
  'xhslink.com',
  'www.xhslink.com',
  // 小红书 App 新版分享会走 xhslink.cn（带 /o/ 或 /m/ 路径），2026-10 实测存在
  'xhslink.cn',
  'www.xhslink.cn',
  'xhs.cn',
  'www.xhs.cn',
]);

/** 从一段自由文本里抽出所有小红书链接（去重、保序、最多 5 条）。 */
export function extractXhsUrls(text) {
  const raw = String(text ?? '');
  const re = /https?:\/\/[^\s<>"'）)】\]]+/gi;
  const out = [];
  const seen = new Set();
  for (const m of raw.matchAll(re)) {
    let url = m[0];
    // 去掉紧跟的中英文标点/常见尾巴
    url = url.replace(/[，。、；：！？,.;:!?）)】\]»…]+$/u, '');
    if (!isAllowedXhsUrl(url)) continue;
    if (seen.has(url)) continue;
    seen.add(url);
    out.push(url);
    if (out.length >= 5) break;
  }
  return out;
}

/** URL 是否属于允许的小红书域（含协议/端口/userinfo 校验）。 */
export function isAllowedXhsUrl(raw) {
  let u;
  try {
    u = new URL(String(raw ?? ''));
  } catch {
    return false;
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return false;
  if (u.username || u.password) return false;
  if (u.port && u.port !== '80' && u.port !== '443') return false;
  const host = u.hostname.toLowerCase();
  if (!ALLOWED_HOSTS.has(host)) return false;
  // 防止 http://xhslink.com.evil.com 这类前缀欺骗
  if (!ALLOWED_HOSTS.has(host)) return false;
  return true;
}

const NOTE_ID_RE = /\/(?:explore|discovery\/item|note)\/([0-9a-f]{24})(?:[/?#]|$)/i;

/** 解析长链接：拿 noteId + xsec_token；短链返回 kind='short'。 */
export function parseNoteFromUrl(raw) {
  let u;
  try {
    u = new URL(String(raw ?? ''));
  } catch {
    return { ok: false, code: 'invalid_url', reason: '不是合法 URL' };
  }
  if (!isAllowedXhsUrl(u.href)) {
    return { ok: false, code: 'host_not_allowed', reason: `不是小红书官方域名：${u.hostname}` };
  }
  const host = u.hostname.toLowerCase();
  const isShort = host === 'xhslink.com' || host === 'www.xhslink.com'
    || host === 'xhslink.cn' || host === 'www.xhslink.cn'
    || host === 'xhs.cn' || host === 'www.xhs.cn';
  if (isShort) {
    return { ok: true, kind: 'short', url: u.href, shortUrl: u.href };
  }
  const m = NOTE_ID_RE.exec(u.pathname);
  const noteId = m ? m[1] : (u.searchParams.get('noteId') ?? '');
  if (!/^[0-9a-f]{24}$/i.test(noteId)) {
    return { ok: false, code: 'note_id_not_found', reason: '链接里找不到 24 位笔记 ID', url: u.href };
  }
  const xsecToken = u.searchParams.get('xsec_token') ?? '';
  const xsecSource = u.searchParams.get('xsec_source') ?? '';
  return {
    ok: true,
    kind: 'long',
    url: u.href,
    noteId,
    xsecToken,
    xsecSource,
    hasToken: Boolean(xsecToken),
  };
}

/**
 * 跟随短链重定向（逐跳校验域名 + 限跳数 + 超时）。
 * 返回最终长链；失败时给出明确 code。
 */
export async function resolveShortLink(shortUrl, {
  fetchImpl = globalThis.fetch,
  maxHops = 5,
  timeoutMs = 5000,
} = {}) {
  let current = shortUrl;
  const chain = [];
  for (let hop = 0; hop < maxHops; hop += 1) {
    if (!isAllowedXhsUrl(current)) {
      return { ok: false, code: 'redirect_host_not_allowed', reason: `重定向到了非小红书域名：${safeHost(current)}`, chain };
    }
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    let res;
    try {
      res = await fetchImpl(current, {
        method: 'GET',
        redirect: 'manual',
        signal: ctrl.signal,
        headers: {
          // 移动端 UA 更容易拿到长链
          'user-agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
          'accept': 'text/html,application/xhtml+xml',
        },
      });
    } catch (error) {
      clearTimeout(timer);
      return { ok: false, code: 'short_link_fetch_failed', reason: String(error?.message ?? error), chain };
    }
    clearTimeout(timer);
    chain.push({ url: current, status: res.status });
    const location = res.headers.get('location');
    if (!location) {
      // 有些短链直接 200 + HTML，里面用 JS 跳转；这里只在 HTML 里找一条 xiaohongshu.com 长链
      let body = '';
      try { body = await res.text(); } catch { /* 忽略 */ }
      const found = extractXhsUrls(body).find((u) => !u.includes('xhslink.com') && !u.includes('xhs.cn'));
      if (found) return { ok: true, finalUrl: found, chain, via: 'html' };
      return { ok: false, code: 'short_link_no_redirect', reason: '短链没有返回重定向，页面里也没有长链', chain };
    }
    current = new URL(location, current).href;
    const parsed = parseNoteFromUrl(current);
    if (parsed.ok && parsed.kind === 'long') {
      return { ok: true, finalUrl: current, chain, via: 'redirect' };
    }
    if (!isAllowedXhsUrl(current)) {
      return { ok: false, code: 'redirect_host_not_allowed', reason: `重定向到了非小红书域名：${safeHost(current)}`, chain };
    }
  }
  return { ok: false, code: 'too_many_redirects', reason: `超过 ${maxHops} 次重定向`, chain };
}

/** 把一整段分享文案解析成「待读取的笔记」；失败时给出可展示的原因。 */
export async function resolveShareText(text, options = {}) {
  const urls = extractXhsUrls(text);
  if (!urls.length) {
    return { ok: false, code: 'no_xhs_url', reason: '这段文字里没有小红书链接' };
  }
  const first = urls[0];
  const parsed = parseNoteFromUrl(first);
  if (!parsed.ok) return parsed;
  if (parsed.kind === 'long') {
    return { ok: true, noteId: parsed.noteId, xsecToken: parsed.xsecToken, url: parsed.url, originalUrl: first, via: 'long' };
  }
  const resolved = await resolveShortLink(first, options);
  if (!resolved.ok) return { ...resolved, originalUrl: first };
  const longParsed = parseNoteFromUrl(resolved.finalUrl);
  if (!longParsed.ok) return longParsed;
  return {
    ok: true,
    noteId: longParsed.noteId,
    xsecToken: longParsed.xsecToken,
    url: longParsed.url,
    originalUrl: first,
    via: `short:${resolved.via}`,
    chain: resolved.chain,
  };
}

function safeHost(raw) {
  try { return new URL(String(raw)).hostname; } catch { return '(unparseable)'; }
}
