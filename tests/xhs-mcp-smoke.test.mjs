// 小红书只读 MCP 冒烟测试：真启动子进程，走 MCP 协议
// 验证：① 只暴露两个只读工具 ② 上游没启动时 xhs_check_status 明确报错 ③ 恶意/无效输入不崩
import test from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const ENTRY = new URL('../src/mcp-xhs-reader-safe.js', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');

test('xhs-reader MCP：只读工具面与错误路径', async () => {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [ENTRY],
    env: { ...process.env, XHS_BASE_URL: 'http://127.0.0.1:1' }, // 故意指向一个不可达端口
    stderr: 'ignore',
  });
  const client = new Client({ name: 'xhs-smoke', version: '0.0.1' }, { capabilities: {} });
  await client.connect(transport);

  const list = await client.listTools();
  const names = list.tools.map((t) => t.name).sort();
  assert.deepEqual(names, ['xhs_check_status', 'xhs_read_note_from_share_url']);

  // 不允许出现任何写操作
  for (const banned of ['publish_content', 'publish_video', 'post_comment', 'reply_comment', 'like_feed', 'favorite_feed', 'delete_cookies']) {
    assert.ok(!names.includes(banned), `不应暴露写工具：${banned}`);
  }

  // 上游不可达 → 明确错误，不抛异常
  const status = await client.callTool({ name: 'xhs_check_status', arguments: {} });
  const payload = JSON.parse(status.content[0].text);
  assert.equal(payload.ok, false);
  assert.ok(['upstream_unreachable', 'upstream_timeout'].includes(payload.code));

  // 没有链接 → 明确 no_xhs_url
  const none = await client.callTool({
    name: 'xhs_read_note_from_share_url',
    arguments: { text: '今天天气不错' },
  });
  const nonePayload = JSON.parse(none.content[0].text);
  assert.equal(nonePayload.ok, false);
  assert.equal(nonePayload.code, 'no_xhs_url');

  // 恶意域名 → host_not_allowed
  const evil = await client.callTool({
    name: 'xhs_read_note_from_share_url',
    arguments: { text: 'https://evil.com/explore/665f1a2b3c4d5e6f7a8b9c0d?xsec_token=x' },
  });
  const evilPayload = JSON.parse(evil.content[0].text);
  assert.equal(evilPayload.ok, false);
  assert.equal(evilPayload.code, 'no_xhs_url'); // 非小红书域在抽取阶段就被丢弃

  await client.close();
});
