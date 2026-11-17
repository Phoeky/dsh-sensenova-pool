/**
 * 推理档位按模型映射（issue #3）单元测试。
 *
 * 背景：商汤 `reasoning_effort` 的合法词表**每个模型不同**（glm-5.3 只认
 * low/high/max，glm-5.2 七档全收；2026-11-17 真机复验一致）。这里用离线断言固定：
 *   1. 注册给 pi-ai 的 `thinkingLevelMap` **只声明实测支持的档位**，其余为 `null`
 *      —— 于是 glm-5.3 的下拉只有 Low / High / Max，不会有「选了却发别的」的假档位；
 *   2. 声明的每个拼写都在该模型词表内（越界就是 400）；
 *   3. 清洗层遇到非法值时按「饱和档不降级、其余向下取」就近归位；
 *   4. 未实测的模型走保守词表，不会被我们猜着改。
 */
import {
  DEFAULT_REASONING_EFFORTS,
  MODEL_REASONING_EFFORTS,
  REASONING_EFFORTS,
  THINKING_LEVELS,
  coerceReasoningEffort,
  hasMeasuredReasoningEfforts,
  reasoningEffortsFor,
  thinkingEffortFor,
  thinkingLevelMapFor,
} from '../lib/catalog.js';
import { sanitizeChatRequest } from '../lib/sanitize.js';

let pass = 0, fail = 0;
const check = (name, cond, detail = '') => {
  cond ? (pass++, console.log(`  PASS  ${name}`)) : (fail++, console.log(`  FAIL  ${name}${detail ? ' — ' + detail : ''}`));
};

const MAP = (modelId, expected) => {
  const map = thinkingLevelMapFor(modelId);
  const bad = THINKING_LEVELS.filter((level) => map[level] !== expected[level]);
  check(`${modelId} 的七档声明`, bad.length === 0,
    bad.map((level) => `${level}: 期望 ${JSON.stringify(expected[level])} 实得 ${JSON.stringify(map[level])}`).join('; ')
      + ` | 实得 ${JSON.stringify(map)}`);
};

const DECLARED = (modelId) => THINKING_LEVELS.filter((level) => thinkingLevelMapFor(modelId)[level] !== null);

console.log('\n[reasoning] 词表本身的形状');
{
  check('上游七档拼写齐全', REASONING_EFFORTS.length === 7, REASONING_EFFORTS.join(','));
  check('DSH 七档与上游一一对应', THINKING_LEVELS.length === REASONING_EFFORTS.length,
    `${THINKING_LEVELS.length} vs ${REASONING_EFFORTS.length}`);
  check('默认词表是全员交集 low/high',
    DEFAULT_REASONING_EFFORTS.length === 2
      && DEFAULT_REASONING_EFFORTS.includes('low')
      && DEFAULT_REASONING_EFFORTS.includes('high'),
    DEFAULT_REASONING_EFFORTS.join(','));
}

console.log('\n[reasoning] glm-5.3：只声明 Low / High / Max（真机 xhigh、none 均 400）');
{
  MAP('glm-5.3', {
    off: null,
    minimal: null,
    low: 'low',
    medium: null,
    high: 'high',
    xhigh: null,
    max: 'max',
  });
  check('下拉里只剩 3 档', DECLARED('glm-5.3').join(',') === 'low,high,max', DECLARED('glm-5.3').join(','));
  check('不再显示 Off（模型关不掉思考）', thinkingLevelMapFor('glm-5.3').off === null);
  check('不再显示 Xhigh（模型不认这个拼写）', thinkingLevelMapFor('glm-5.3').xhigh === null);
}

console.log('\n[reasoning] glm-5.2 / deepseek-v4-flash 等：七档全收');
{
  const full = { off: 'none', minimal: 'minimal', low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh', max: 'max' };
  MAP('glm-5.2', full);
  MAP('deepseek-v4-flash', full);
  MAP('sensenova-6.8-flash', full);
  MAP('sensenova-6.8-flash-lite', full);
  check('七档全部可选', DECLARED('glm-5.2').length === 7, DECLARED('glm-5.2').join(','));
}

console.log('\n[reasoning] kimi-k3（max 未确认）/ deepseek-flash（xhigh 未确认）');
{
  MAP('kimi-k3', { off: 'none', minimal: 'minimal', low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh', max: null });
  check('不声明未确认的 max', thinkingLevelMapFor('kimi-k3').max === null);
  MAP('deepseek-flash', { off: 'none', minimal: 'minimal', low: 'low', medium: 'medium', high: 'high', xhigh: null, max: 'max' });
  check('不声明未确认的 xhigh', thinkingLevelMapFor('deepseek-flash').xhigh === null);
}

console.log('\n[reasoning] 未实测模型：只声明保守词表 low / high');
{
  MAP('brand-new-model', { off: null, minimal: null, low: 'low', medium: null, high: 'high', xhigh: null, max: null });
  check('默认词表只含 low/high', JSON.stringify(reasoningEffortsFor('brand-new-model')) === '["low","high"]');
  check('未实测模型只声明 2 档', DECLARED('brand-new-model').join(',') === 'low,high', DECLARED('brand-new-model').join(','));
  check('未实测模型没有实测标记', hasMeasuredReasoningEfforts('brand-new-model') === false);
  check('已知模型有实测标记', hasMeasuredReasoningEfforts('glm-5.3') === true);
  check('模型 id 大小写不敏感', JSON.stringify(thinkingLevelMapFor('GLM-5.3')) === JSON.stringify(thinkingLevelMapFor('glm-5.3')));
}

console.log('\n[reasoning] 核心不变量：声明的拼写一定合法，null 一定是真的不支持');
{
  const ids = [...Object.keys(MODEL_REASONING_EFFORTS), 'brand-new-model', '', undefined];
  const violations = [];
  for (const id of ids) {
    const vocab = reasoningEffortsFor(id);
    const map = thinkingLevelMapFor(id);
    for (const level of THINKING_LEVELS) {
      const value = map[level];
      const spelling = level === 'off' ? 'none' : level;
      if (value === null) {
        // null 必须是「词表里真没有这个拼写」，而不是我们随便摘掉的。
        if (vocab.includes(spelling)) violations.push(`${id ?? '(缺省)'}:${level} 应为 ${spelling} 却是 null`);
      } else if (!vocab.includes(value)) {
        violations.push(`${id ?? '(缺省)'}:${level}→${value} 不在词表内`);
      }
    }
    if (Object.keys(map).length !== THINKING_LEVELS.length) violations.push(`${id ?? '(缺省)'} 键不全`);
  }
  check('没有越界声明、也没有多余的 null', violations.length === 0, violations.join(', '));
}

console.log('\n[reasoning] thinkingEffortFor：清洗层的就近归位');
{
  const cases = [
    ['glm-5.3', 'off', 'low', '关不掉思考时给最低档'],
    ['glm-5.3', 'minimal', 'low', '缺 minimal 时向下取'],
    ['glm-5.3', 'medium', 'low', '缺 medium 时向下取（不悄悄抬高成本）'],
    ['glm-5.3', 'xhigh', 'max', '饱和档由最强档承接（不降级）'],
    ['glm-5.3', 'max', 'max', '同名直接用'],
    ['kimi-k3', 'max', 'xhigh', '物理上没有更高档'],
    ['deepseek-flash', 'xhigh', 'max', '不降级'],
    ['brand-new-model', 'max', 'high', '未知模型上限压到 high'],
  ];
  for (const [id, level, expected, why] of cases) {
    const got = thinkingEffortFor(id, level);
    check(`${id} 的 ${level} → ${expected}（${why}）`, got === expected, String(got));
  }
}

console.log('\n[reasoning] coerceReasoningEffort（清洗层）');
{
  const c1 = coerceReasoningEffort('glm-5.3', 'xhigh');
  check('glm-5.3 + xhigh → max', c1.value === 'max' && c1.changed === true, JSON.stringify(c1));

  const c2 = coerceReasoningEffort('glm-5.3', 'max');
  check('glm-5.3 + max 原样保留', c2.value === 'max' && c2.changed === false, JSON.stringify(c2));

  const c3 = coerceReasoningEffort('glm-5.3', 'none');
  check('glm-5.3 + none → low', c3.value === 'low', String(c3.value));

  const c4 = coerceReasoningEffort('glm-5.2', 'xhigh');
  check('glm-5.2 + xhigh 原样保留', c4.value === 'xhigh' && c4.changed === false, JSON.stringify(c4));

  const c5 = coerceReasoningEffort('GLM-5.3', 'HIGH');
  check('大写被归一', c5.value === 'high' && c5.changed === true, JSON.stringify(c5));

  const c6 = coerceReasoningEffort('brand-new-model', 'max');
  check('未实测模型不猜（max 原样放行）', c6.value === 'max' && c6.changed === false, JSON.stringify(c6));

  const c7 = coerceReasoningEffort('glm-5.3', 'ultra');
  check('认不出来的取值返回 undefined', c7.value === undefined, String(c7.value));

  const c8 = coerceReasoningEffort(undefined, 'max');
  check('请求体没有 model 时不猜', c8.value === 'max' && c8.changed === false, JSON.stringify(c8));

  let current = 'xhigh';
  let rounds = 0;
  for (; rounds < 5; rounds++) {
    const next = coerceReasoningEffort('glm-5.3', current);
    if (next.value === undefined || next.changed) { current = next.value; continue; }
    break;
  }
  check('多轮清洗收敛（幂等）', rounds === 1 && current === 'max', `rounds=${rounds} current=${current}`);
}

console.log('\n[reasoning] sanitizeChatRequest 集成');
{
  const base = { messages: [{ role: 'user', content: 'hi' }] };

  const r1 = sanitizeChatRequest({ ...base, model: 'glm-5.3', reasoning_effort: 'xhigh' });
  check('glm-5.3 的 xhigh 在转发前被改成 max', r1.body.reasoning_effort === 'max', String(r1.body.reasoning_effort));
  check('记录了改动', r1.changes.includes('reasoning_effort'));

  const r2 = sanitizeChatRequest({ ...base, model: 'glm-5.3', reasoning_effort: 'off' });
  check('glm-5.3 的 off 落成 low', r2.body.reasoning_effort === 'low', String(r2.body.reasoning_effort));

  const r3 = sanitizeChatRequest({ ...base, model: 'glm-5.2', reasoning_effort: 'xhigh' });
  check('glm-5.2 的 xhigh 不动', r3.body.reasoning_effort === 'xhigh' && r3.changes.length === 0,
    JSON.stringify(r3.changes));

  const r4 = sanitizeChatRequest({ ...base, model: 'glm-5.3', reasoning_effort: 'max' });
  check('glm-5.3 的 max 不动（不降级）', r4.body.reasoning_effort === 'max' && r4.changes.length === 0);

  const r5 = sanitizeChatRequest({ ...base, reasoning_effort: 'max' });
  check('缺 model 时不动 max', r5.body.reasoning_effort === 'max' && r5.changes.length === 0);

  const again = sanitizeChatRequest(r1.body);
  check('清洗结果再清洗无改动', again.changes.length === 0, JSON.stringify(again.changes));
}

console.log(`\n=== ${pass} passed, ${fail} failed ===\n`);
process.exit(fail === 0 ? 0 : 1);
