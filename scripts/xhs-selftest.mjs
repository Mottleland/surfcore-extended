// 小红书链路自测（不经过 QQ，直接走真实 MCP 协议）
//
// 用法：
//   node scripts/xhs-selftest.mjs "https://www.xiaohongshu.com/explore/<id>?xsec_token=..."
//   node scripts/xhs-selftest.mjs "整段分享文案，带链接也行"
//
// 它做两件事：
//   1) 起一个和 DSH 完全相同的 stdio MCP 客户端，调用 xhs_check_status
//   2) 调用 xhs_read_note_from_share_url，把归一化结果摘要打出来
// 任何一步失败都会打印明确的 code / hint —— 这就是群里 AI 会看到的东西。
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ENTRY = path.join(__dirname, '..', 'src', 'mcp-xhs-reader-safe.js');

const input = process.argv.slice(2).join(' ').trim();
if (!input) {
  console.error('用法: node scripts/xhs-selftest.mjs "<分享链接或整段文案>"');
  process.exit(2);
}

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [ENTRY],
  env: { ...process.env },
  stderr: 'inherit',
});
const client = new Client({ name: 'xhs-selftest', version: '1.0.0' }, { capabilities: {} });

function brief(payload) {
  if (!payload?.ok) {
    return `❌ ${payload?.code || 'unknown'}: ${payload?.message || ''}${payload?.hint ? `\n   hint: ${payload.hint}` : ''}`;
  }
  const n = payload.note;
  const lines = [
    `✅ ${n.title || '(无标题)'}`,
    `   作者: ${n.author?.name || '?'} | 类型: ${n.type} | 图片: ${n.images?.length ?? 0} 张 | 视频: ${n.video ? '有' : '无'}`,
    `   互动: 赞 ${n.interact?.likes} / 藏 ${n.interact?.collects} / 评 ${n.interact?.comments}`,
    `   正文: ${n.descChars} 字${n.desc ? ` | 开头「${n.desc.slice(0, 40).replace(/\s+/g, ' ')}…」` : ''}`,
    `   评论: ${n.comments?.length ?? 0} 条${n.comments?.[0] ? ` | 首条「${n.comments[0].content.slice(0, 30)}」` : ''}`,
    `   解析路径: ${n.resolvedVia}`,
  ];
  return lines.join('\n');
}

try {
  await client.connect(transport);

  const status = await client.callTool({ name: 'xhs_check_status', arguments: {} });
  const s = JSON.parse(status.content[0].text);
  console.log('【服务状态】');
  console.log(s.ok
    ? `✅ ${s.service?.baseUrl} healthy | 登录: ${s.login?.loggedIn ? '是（' + (s.login?.nickname || '?') + '）' : '否，需扫码'}`
    : `❌ ${s.code}: ${s.message}${s.hint ? `\n   hint: ${s.hint}` : ''}`);

  console.log('\n【读取笔记】');
  const read = await client.callTool({
    name: 'xhs_read_note_from_share_url',
    arguments: { text: input, maxComments: 3 },
  });
  console.log(brief(JSON.parse(read.content[0].text)));

  const payload = JSON.parse(read.content[0].text);
  process.exitCode = payload.ok ? 0 : 1;
} catch (error) {
  console.error('❌ 自测异常:', error?.message ?? error);
  process.exitCode = 1;
} finally {
  try { await client.close(); } catch {}
}
