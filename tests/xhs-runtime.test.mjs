// 运行期回归：真正调用「合并后可能作用域漂移」的那几个函数。
//
// 背景（真实事故）：上游 0.7.14 把 `const cfg = loadConfig()` 从模块顶层移进 main()，
// 我们模块级 xhsServiceHealthy() 仍引用 cfg → `cfg is not defined`。
// 语法检查和普通单测都没抓到，因为没人真正调用它。
// 这个文件就是"真正调用一遍"：任何 ReferenceError / 未定义变量都会直接失败。
import test from 'node:test';
import assert from 'node:assert/strict';
import { bridgeHarness } from '../scripts/audit-bridge-harness.mjs';

const URL_A = 'https://www.xiaohongshu.com/explore/682e9f3d000000002001cdc7?xsec_token=TOKEN_A';

async function harness() {
  const h = await bridgeHarness({
    files: { 'state/mode.json': JSON.stringify({ mode: 'reserved2' }) },
    config: {
      socialV2: {
        tokenGuard: { enabled: false },
        wake: { recommendedProbability: 0, maxWakePerMinute: 0, maxWakePerHour: 0 },
      },
      xhs: { enabled: true, baseUrl: 'http://127.0.0.1:1' },
    },
  });
  await h.refreshMode();
  return h;
}

test('xhs 唤醒路径不抛未定义变量（health gate / 打点 / 提示词）', async () => {
  const h = await harness();
  try {
    const st = h.getSocialV2State('group:456');
    st.xhsPendingUrl = URL_A;
    st.xhsPendingAt = Date.now();
    st.xhsSeen = [{ url: URL_A, at: Date.now() }];

    // 1) 提示词构建：内部会读 cfg.xhs，覆盖不到就会 ReferenceError
    const prompt = h.buildWakePromptV2('group:456', 'xhsLink');
    assert.match(prompt, /【小红书笔记】/);

    // 2) 真正走一次投递：会经过 dropXhsMark / 健康门 / 打点
    //    baseUrl 故意指向不可达端口，健康门会拦下并撤回标记——这里只要求"不抛异常"。
    let error = null;
    try {
      await h.sendWakePromptV2('group:456', 'xhsLink');
    } catch (e) {
      error = e;
    }
    assert.equal(error, null, `sendWakePromptV2 抛异常：${error?.message}`);
    assert.ok(!/is not defined|is not a function/.test(String(error?.message ?? '')), '不应出现未定义变量');
  } finally {
    await h.close();
  }
});

test('合并升级后卡片解析与短链识别仍可用', async () => {
  const h = await harness();
  try {
    const card = JSON.stringify({ meta: { detail_1: { title: '标题', qqdocurl: URL_A } } });
    const text = await h.segmentsToText([{ type: 'json', data: { data: card } }], {});
    assert.match(text, /\[卡片\]/);
    assert.match(text, /xiaohongshu\.com/);
  } finally {
    await h.close();
  }
});

test('健康门在服务不可达时撤回链接标记（不把链接吞掉）', async () => {
  const h = await harness();
  try {
    const st = h.getSocialV2State('group:456');
    st.xhsPendingUrl = URL_A;
    st.xhsPendingAt = Date.now();
    st.xhsSeen = [{ url: URL_A, at: Date.now() }];

    await h.sendWakePromptV2('group:456', 'xhsLink');
    const after = h.getSocialV2State('group:456');
    assert.equal(after.xhsPendingUrl || '', '', '服务不可用时应撤回待读链接，便于服务恢复后重触发');
  } finally {
    await h.close();
  }
});
