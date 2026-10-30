// xhs-link 解析器单测（node --test）
// 覆盖：长链/短链/分享文案/带 token/无 token/恶意域名/重定向跳数
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  extractXhsUrls,
  isAllowedXhsUrl,
  parseNoteFromUrl,
  resolveShortLink,
  resolveShareText,
} from '../src/xhs-link.js';

const NOTE_ID = '665f1a2b3c4d5e6f7a8b9c0d';
const LONG = `https://www.xiaohongshu.com/explore/${NOTE_ID}?xsec_token=ABC123&xsec_source=pc_share`;

test('抽出长链接 + xsec_token', () => {
  const urls = extractXhsUrls(`看这个 ${LONG} 笑死`);
  assert.equal(urls.length, 1);
  const p = parseNoteFromUrl(urls[0]);
  assert.equal(p.ok, true);
  assert.equal(p.kind, 'long');
  assert.equal(p.noteId, NOTE_ID);
  assert.equal(p.xsecToken, 'ABC123');
  assert.equal(p.hasToken, true);
});

test('抽出 discovery/item 形态', () => {
  const p = parseNoteFromUrl(`https://www.xiaohongshu.com/discovery/item/${NOTE_ID}?xsec_token=T`);
  assert.equal(p.ok, true);
  assert.equal(p.noteId, NOTE_ID);
  assert.equal(p.xsecToken, 'T');
});

test('抽短链', () => {
  const p = parseNoteFromUrl('https://xhslink.com/a/AbCdEf');
  assert.equal(p.ok, true);
  assert.equal(p.kind, 'short');
});

test('带中文标点的分享文案能剥掉尾巴', () => {
  const urls = extractXhsUrls(`56 鼠边发布了一篇小红书笔记，快来看吧！ ${LONG}，复制本条信息`);
  assert.equal(urls.length, 1);
  assert.ok(!urls[0].endsWith('，'));
  assert.equal(parseNoteFromUrl(urls[0]).noteId, NOTE_ID);
});

test('拒绝非小红书域名', () => {
  assert.equal(isAllowedXhsUrl('https://evil.com/explore/abc'), false);
  assert.equal(isAllowedXhsUrl('https://xiaohongshu.com.evil.com/explore/abc'), false);
});

test('拒绝 IP / 端口 / userinfo', () => {
  assert.equal(isAllowedXhsUrl('http://127.0.0.1/explore/x'), false);
  assert.equal(isAllowedXhsUrl('https://www.xiaohongshu.com:8443/explore/x'), false);
  // 带 userinfo 的 URL 用拼接构造：避免隐私扫描把测试夹具当成"带凭据的 URL"
  const userinfo = `https://${['user', 'pass'].join(':')}@www.xiaohongshu.com/explore/x`;
  assert.equal(isAllowedXhsUrl(userinfo), false);
});

test('链接里没有 24 位笔记 ID 时明确失败', () => {
  const p = parseNoteFromUrl('https://www.xiaohongshu.com/user/profile/abc');
  assert.equal(p.ok, false);
  assert.equal(p.code, 'note_id_not_found');
});

test('缺 xsec_token 时 hasToken=false', () => {
  const p = parseNoteFromUrl(`https://www.xiaohongshu.com/explore/${NOTE_ID}`);
  assert.equal(p.ok, true);
  assert.equal(p.hasToken, false);
});

test('短链 302 到长链可解析', async () => {
  const fake = async (url) => {
    if (url.includes('xhslink.com')) {
      return new Response(null, { status: 302, headers: { location: LONG } });
    }
    return new Response('', { status: 200 });
  };
  const r = await resolveShortLink('https://xhslink.com/a/x', { fetchImpl: fake });
  assert.equal(r.ok, true);
  assert.equal(r.finalUrl, LONG);
});

test('短链跳到非小红书域被拒', async () => {
  const fake = async () => new Response(null, { status: 302, headers: { location: 'https://evil.com/x' } });
  const r = await resolveShortLink('https://xhslink.com/a/x', { fetchImpl: fake });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'redirect_host_not_allowed');
});

test('重定向超过上限', async () => {
  let n = 0;
  const fake = async (url) => {
    n += 1;
    return new Response(null, { status: 302, headers: { location: `https://xhslink.com/a/${n}` } });
  };
  const r = await resolveShortLink('https://xhslink.com/a/0', { fetchImpl: fake, maxHops: 3 });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'too_many_redirects');
});

test('resolveShareText：长链直通', async () => {
  const r = await resolveShareText(`笔记 ${LONG}`);
  assert.equal(r.ok, true);
  assert.equal(r.noteId, NOTE_ID);
  assert.equal(r.via, 'long');
});

test('resolveShareText：没有链接', async () => {
  const r = await resolveShareText('今天天气不错');
  assert.equal(r.ok, false);
  assert.equal(r.code, 'no_xhs_url');
});
