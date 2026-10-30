// searchPlan 单测：权重必须真正参与取样
import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizePreferences, searchPlan } from '../plugins/surfcore/tools/lib/feed-core.mjs';

const entries = () => normalizePreferences({
  like: ['人文历史', 'AIGC', '科学科普'],
  keywords: [],
  weights: { '人文历史': 2.5, 'AIGC': 1, '科学科普': 1 },
}).enabled;

const countBy = (plan) => {
  const m = new Map();
  for (const p of plan) m.set(p.label, (m.get(p.label) || 0) + 1);
  return m;
};

test('每个启用偏好至少取样 1 次', () => {
  const plan = searchPlan(entries(), { seed: '2026-10-30' });
  const by = countBy(plan);
  for (const label of ['人文历史', 'AIGC', '科学科普']) {
    assert.ok((by.get(label) || 0) >= 1, `${label} 至少要 1 次`);
  }
});

test('权重高的偏好取样次数严格多于权重低的', () => {
  const plan = searchPlan(entries(), { seed: '2026-10-30', extraRatio: 0.8 });
  const by = countBy(plan);
  assert.ok(by.get('人文历史') > by.get('AIGC'), `人文历史 ${by.get('人文历史')} 应 > AIGC ${by.get('AIGC')}`);
});

test('extraRatio=0 时退回「每个偏好 1 次」', () => {
  const plan = searchPlan(entries(), { seed: '2026-10-30', extraRatio: 0 });
  assert.equal(plan.length, 3);
  const by = countBy(plan);
  for (const v of by.values()) assert.equal(v, 1);
});

test('同一偏好内的 (order,page) 组合不重复', () => {
  const plan = searchPlan(entries(), { seed: '2026-10-30', extraRatio: 1.5, maxQueriesPerEntry: 3 });
  const seen = new Map();
  for (const p of plan) {
    const key = `${p.label}|${p.order}|${p.page}`;
    assert.ok(!seen.has(key), `重复组合：${key}`);
    seen.set(key, true);
  }
});

test('同一天结果稳定，跨天会轮换', () => {
  const a1 = searchPlan(entries(), { seed: '2026-10-30' }).map((p) => `${p.label}|${p.order}|${p.page}`).join(',');
  const a2 = searchPlan(entries(), { seed: '2026-10-30' }).map((p) => `${p.label}|${p.order}|${p.page}`).join(',');
  const b = searchPlan(entries(), { seed: '2026-10-31' }).map((p) => `${p.label}|${p.order}|${p.page}`).join(',');
  assert.equal(a1, a2, '同一 seed 必须一致');
  assert.notEqual(a1, b, '不同 seed 应轮换');
});

test('权重为 0 的偏好不参与取样', () => {
  const list = normalizePreferences({ like: ['人文历史', '带货'], weights: { '人文历史': 2, '带货': 0 } }).enabled;
  const plan = searchPlan(list, { seed: '2026-10-30' });
  assert.ok(plan.every((p) => p.label !== '带货'));
});
