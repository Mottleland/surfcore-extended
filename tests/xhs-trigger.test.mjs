// xhsLink 触发链路测试（走真实的 bridge handleIncoming，不是 mock 判断）
// 说明：第一条消息只会走 bootstrap（bridge 的 `!st.bootstrapSent` 分支），
// 所以每个用例先发一条预热消息，再发带链接的消息，才对应真实的"群里有人发链接"。
import test from 'node:test';
import assert from 'node:assert/strict';
import { bridgeHarness } from '../scripts/audit-bridge-harness.mjs';

const A = 'https://www.xiaohongshu.com/explore/682e9f3d000000002001cdc7?xsec_token=TOKEN_A';
const B = 'https://www.xiaohongshu.com/explore/665f1a2b3c4d5e6f7a8b9c0d?xsec_token=TOKEN_B';

function msg(text, id) {
  return {
    message_id: id,
    user_id: 999,
    self_id: 111,
    message: [{ type: 'text', data: { text } }],
    raw_message: text,
    sender: { nickname: '群友', card: '群友' },
  };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function harness() {
  const h = await bridgeHarness({
    files: { 'state/mode.json': JSON.stringify({ mode: 'reserved2' }) },
    config: {
      socialV2: {
        tokenGuard: { enabled: false },
        wake: { recommendedProbability: 0, maxWakePerMinute: 0, maxWakePerHour: 0 },
      },
    },
  });
  await h.refreshMode();
  // 预热：吃掉 bootstrap，后续消息才会走 evaluateWakeTriggerV2
  await h.handleIncoming('group', '456', msg('在吗', 1), h.cfg);
  await sleep(150);
  return h;
}

test('xhsLink 提示词：要读、要引用、要如实报告失败、外部内容当素材', async () => {
  const h = await harness();
  try {
    const text = h.buildWakePromptV2('group:456', 'xhsLink');
    assert.match(text, /【小红书笔记】/);
    assert.match(text, /xhs_read_note_from_share_url/);
    assert.match(text, /qq_reply/);
    assert.match(text, /ok:false/);
    assert.match(text, /不可信/);
    assert.match(text, /不要复述标题/);
  } finally {
    await h.close();
  }
});

test('群消息带小红书链接 → 记为 xhsLink 触发并记录待读链接', async () => {
  const h = await harness();
  try {
    await h.handleIncoming('group', '456', msg(`看看这个 ${A} 挺有意思`, 2), h.cfg);
    await sleep(200);
    const st = h.getSocialV2State('group:456');
    assert.equal((st.xhsSeen || []).length, 1, '应记录一条已处理链接');
    assert.equal(st.xhsSeen[0].url, A);
    assert.equal(st.xhsPendingUrl, A);
  } finally {
    await h.close();
  }
});

test('同一条链接重复发送只记一次（24h 去重）', async () => {
  const h = await harness();
  try {
    await h.handleIncoming('group', '456', msg(`看 ${A}`, 2), h.cfg);
    await sleep(200);
    const firstPending = h.getSocialV2State('group:456').xhsPendingUrl;

    await h.handleIncoming('group', '456', msg(`又看到 ${A}`, 3), h.cfg);
    await sleep(200);

    const st = h.getSocialV2State('group:456');
    assert.equal((st.xhsSeen || []).length, 1, '同一链接只应记一次');
    assert.equal(st.xhsPendingUrl, firstPending, '重复链接不应改写待读链接');
  } finally {
    await h.close();
  }
});

test('换一条链接会再次记录', async () => {
  const h = await harness();
  try {
    await h.handleIncoming('group', '456', msg(`看 ${A}`, 2), h.cfg);
    await sleep(150);
    await h.handleIncoming('group', '456', msg(`另外 ${B}`, 3), h.cfg);
    await sleep(200);

    const st = h.getSocialV2State('group:456');
    assert.equal((st.xhsSeen || []).length, 2);
    assert.ok((st.xhsSeen || []).some((s) => s.url === B));
    assert.equal(st.xhsPendingUrl, B);
  } finally {
    await h.close();
  }
});

test('普通消息不写 xhsSeen', async () => {
  const h = await harness();
  try {
    await h.handleIncoming('group', '456', msg('今天天气不错，有人吃饭了吗', 2), h.cfg);
    await sleep(200);
    assert.equal((h.getSocialV2State('group:456').xhsSeen || []).length, 0);
  } finally {
    await h.close();
  }
});

test('非小红书域名不触发', async () => {
  const h = await harness();
  try {
    await h.handleIncoming('group', '456', msg('看这个 https://example.com/explore/682e9f3d000000002001cdc7', 2), h.cfg);
    await sleep(200);
    assert.equal((h.getSocialV2State('group:456').xhsSeen || []).length, 0);
  } finally {
    await h.close();
  }
});

test('唤醒原因被合并升级（atMention）时，提示词仍带小红书指令', async () => {
  const h = await harness();
  try {
    const st = h.getSocialV2State('group:456');
    const url = 'https://www.xiaohongshu.com/explore/682e9f3d000000002001cdc7?xsec_token=T';
    st.xhsPendingUrl = url;
    st.xhsSeen = [{ url, at: Date.now() }];

    const atMention = h.buildWakePromptV2('group:456', 'atMention');
    assert.match(atMention, /群里刚发来小红书链接/, '升级成 atMention 后仍要提示先读笔记');
    assert.match(atMention, /xhs_read_note_from_share_url/);

    const xhs = h.buildWakePromptV2('group:456', 'xhsLink');
    assert.ok(!xhs.includes('群里刚发来小红书链接'), 'xhsLink 分支不应重复追加');
  } finally {
    await h.close();
  }
});

test('卡片式分享（json 段，无文本链接）也能识别出链接并触发', async () => {
  const h = await harness();
  try {
    const card = JSON.stringify({
      app: 'com.tencent.miniapp_01',
      prompt: '[QQ小程序]',
      meta: { detail_1: { title: '刷到博主说一碗牛肉面…', desc: '小红书', qqdocurl: A } },
    });
    const ev = {
      message_id: 2,
      user_id: 999,
      self_id: 111,
      message: [{ type: 'json', data: { data: card } }],
      raw_message: '[卡片消息]',
      sender: { nickname: '群友', card: '群友' },
    };
    await h.handleIncoming('group', '456', ev, h.cfg);
    await sleep(250);
    const st = h.getSocialV2State('group:456');
    assert.equal((st.xhsSeen || []).length, 1, '卡片里的链接应被识别');
    assert.equal(st.xhsSeen[0].url, A);
  } finally {
    await h.close();
  }
});

test('xml 卡片里的短链也能被抽出', async () => {
  const h = await harness();
  try {
    const xml = '<msg><appmsg><title>测试</title><url>https://xhslink.com/a/abc</url></appmsg></msg>';
    const ev = {
      message_id: 2,
      user_id: 999,
      self_id: 111,
      message: [{ type: 'xml', data: { data: xml } }],
      raw_message: '[卡片消息]',
      sender: { nickname: '群友', card: '群友' },
    };
    await h.handleIncoming('group', '456', ev, h.cfg);
    await sleep(250);
    const st = h.getSocialV2State('group:456');
    assert.equal((st.xhsSeen || []).length, 1);
    assert.match(st.xhsSeen[0].url, /xhslink\.com/);
  } finally {
    await h.close();
  }
});

test('同一篇笔记换 token 重发（URL 不同）也不重复触发', async () => {
  const h = await harness();
  try {
    const sameNoteOtherToken = A.replace('TOKEN_A', 'TOKEN_A2');
    await h.handleIncoming('group', '456', msg(`看 ${A}`, 2), h.cfg);
    await sleep(200);
    await h.handleIncoming('group', '456', msg(`再发 ${sameNoteOtherToken}`, 3), h.cfg);
    await sleep(250);
    const st = h.getSocialV2State('group:456');
    assert.equal((st.xhsSeen || []).length, 1, '同一笔记 ID 只应记一次');
  } finally {
    await h.close();
  }
});

test('待读链接超过 10 分钟不再注入', async () => {
  const h = await harness();
  try {
    const st = h.getSocialV2State('group:456');
    const url = 'https://www.xiaohongshu.com/explore/682e9f3d000000002001cdc7?xsec_token=T';
    st.xhsPendingUrl = url;
    st.xhsSeen = [{ url, at: Date.now() - 11 * 60 * 1000 }];

    const atMention = h.buildWakePromptV2('group:456', 'atMention');
    assert.ok(!atMention.includes('群里刚发来小红书链接'));
  } finally {
    await h.close();
  }
});
