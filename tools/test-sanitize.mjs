/**
 * 请求体清洗（issue #2 的 400）单元测试。
 *
 * 每条规则都对应一次对真实上游的实测：清洗前 400、清洗后 200。
 * 用**离线**断言固定行为，避免回归；真实链路由 e2e-live 覆盖。
 */
import { sanitizeChatRequest } from '../lib/sanitize.js';

let pass = 0, fail = 0;
const check = (name, cond, detail = '') => {
  cond ? (pass++, console.log(`  PASS  ${name}`)) : (fail++, console.log(`  FAIL  ${name}${detail ? ' — ' + detail : ''}`));
};

const BASE = {
  model: 'deepseek-v4-flash',
  messages: [{ role: 'user', content: 'hi' }],
};

const sanitize = (extra = {}, messages = BASE.messages) => {
  const input = { ...BASE, ...extra, messages };
  const { body, changes } = sanitizeChatRequest(input);
  return { body, changes };
};

console.log('\n[sanitize] 角色名映射（developer → system）');
{
  const { body, changes } = sanitize({}, [
    { role: 'developer', content: 'you are a coding agent' },
    { role: 'user', content: 'hi' },
  ]);
  check('developer 被映射成 system', body.messages[0].role === 'system', body.messages[0].role);
  check('记录了改动', changes.includes('messages[0].role'));
  check('内容保持不变', body.messages[0].content === 'you are a coding agent');
  check('未触碰 user 消息', body.messages[1].role === 'user');
}

console.log('\n[sanitize] content 缺失 / null');
{
  const { body } = sanitize({}, [
    { role: 'user', content: 'hi' },
    { role: 'assistant', content: null },
  ]);
  check('assistant content:null → ""', body.messages[1].content === '');

  const { body: b2 } = sanitize({}, [
    { role: 'user', content: 'hi' },
    { role: 'assistant' },
  ]);
  check('assistant 缺 content → ""', b2.messages[1].content === '');

  const { body: b3 } = sanitize({}, [
    { role: 'system', content: null },
    { role: 'user', content: 'hi' },
  ]);
  check('system content:null → ""', b3.messages[0].content === '');

  const { body: b4 } = sanitize({}, [
    { role: 'user', content: 'hi' },
    { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'f', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 'c1', content: null },
  ]);
  check('带 tool_calls 的 assistant 保持 null', b4.messages[1].content === null);
  check('tool content:null → ""', b4.messages[2].content === '');
}

console.log('\n[sanitize] tool_calls.arguments 必须是字符串');
{
  const { body, changes } = sanitize({}, [
    { role: 'user', content: 'hi' },
    {
      role: 'assistant',
      content: null,
      tool_calls: [{ id: 'c1', type: 'function', function: { name: 'f', arguments: { a: 1 } } }],
    },
  ]);
  const args = body.messages[1].tool_calls[0].function.arguments;
  check('对象被序列化成字符串', typeof args === 'string', typeof args);
  check('序列化内容正确', JSON.parse(args).a === 1, args);
  check('记录了改动', changes.some((c) => c.endsWith('.arguments')));

  const { body: b2, changes: c2 } = sanitize({}, [
    { role: 'user', content: 'hi' },
    { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'f', arguments: '{"a":1}' } }] },
  ]);
  check('已是字符串则原样保留', b2.messages[1].tool_calls[0].function.arguments === '{"a":1}');
  check('无改动', c2.length === 0, JSON.stringify(c2));
}

console.log('\n[sanitize] content 标量');
{
  const { body } = sanitize({}, [{ role: 'user', content: 123 }]);
  check('数字 → "123"', body.messages[0].content === '123');

  const { body: b2 } = sanitize({}, [{ role: 'user', content: true }]);
  check('布尔 → "true"', b2.messages[0].content === 'true');

  const { body: b3, changes: c3 } = sanitize({}, [
    { role: 'user', content: [{ type: 'text', text: '看图' }] },
  ]);
  check('多模态数组原样保留', Array.isArray(b3.messages[0].content));
  check('无改动', c3.length === 0);
}

console.log('\n[sanitize] 采样参数类型');
{
  const { body } = sanitize({ temperature: '0.7' });
  check('temperature 字符串 → 数字', body.temperature === 0.7, String(body.temperature));

  const { body: b2 } = sanitize({ top_p: '0.9', frequency_penalty: '0' });
  check('top_p 转数字', b2.top_p === 0.9);
  check('frequency_penalty 转数字', b2.frequency_penalty === 0);

  // 越界值不代改：上游报错信息足够明确，改它等于篡改用户意图。
  const { body: b3, changes: c3 } = sanitize({ temperature: 3 });
  check('越界 temperature 不被篡改', b3.temperature === 3);
  check('不做无用改动', !c3.includes('temperature'));
}

console.log('\n[sanitize] 不支持字段');
{
  const { body, changes } = sanitize({ logprobs: true, top_logprobs: 3, metadata: { a: 1 } });
  check('logprobs 被摘除', !('logprobs' in body));
  check('top_logprobs 被摘除', !('top_logprobs' in body));
  check('metadata 被摘除', !('metadata' in body));
  check('记录了改动', changes.includes('logprobs') && changes.includes('metadata'));
}

console.log('\n[sanitize] reasoning_effort（issue #2 的怀疑点）');
{
  // 实测上游报错原文：should be one of: none, minimal, low, medium, high, xhigh, max
  // 注意 minimal / max 都是合法值，不能被"降级"映射掉。
  const valid = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
  let allOk = true;
  for (const value of valid) {
    const { body } = sanitize({ reasoning_effort: value });
    if (body.reasoning_effort !== value) allOk = false;
  }
  check('全部合法取值原样保留', allOk);

  const { body: b1 } = sanitize({ reasoning_effort: 'off' });
  check('off → none', b1.reasoning_effort === 'none', String(b1.reasoning_effort));

  const { body: b2, changes: c2 } = sanitize({ reasoning_effort: 'max' });
  check('max 保持 max（不降级成 xhigh）', b2.reasoning_effort === 'max');
  check('max 无需改动', c2.length === 0, JSON.stringify(c2));

  const { body: b3, changes: c3 } = sanitize({ reasoning_effort: 'minimal' });
  check('minimal 保持 minimal', b3.reasoning_effort === 'minimal');
  check('minimal 无需改动', c3.length === 0, JSON.stringify(c3));

  const { body: b4 } = sanitize({ reasoning_effort: 'LOW' });
  check('大写被归一成小写', b4.reasoning_effort === 'low');

  const { body: b5, changes: c5 } = sanitize({ reasoning_effort: 'ultra' });
  check('未知取值被摘除（不瞎映射）', !('reasoning_effort' in b5));
  check('记录了改动', c5.includes('reasoning_effort'));
}

console.log('\n[sanitize] 组合与幂等');
{
  const input = {
    ...BASE,
    messages: [
      { role: 'developer', content: null },
      { role: 'user', content: 42 },
      { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'f', arguments: { a: 1 } } }] },
      { role: 'tool', tool_call_id: 'c1' },
    ],
    reasoning_effort: 'off',
    temperature: '0.2',
    metadata: { trace: 'x' },
  };
  const { body, changes } = sanitizeChatRequest(input);
  check('developer+null 同时修好', body.messages[0].role === 'system' && body.messages[0].content === '');
  check('user 数字被转成字符串', body.messages[1].content === '42');
  check('tool 缺 content 被补齐', body.messages[3].content === '');
  check('reasoning_effort 已归一', body.reasoning_effort === 'none');
  check('metadata 已摘除', !('metadata' in body));
  check('改动清单非空', changes.length >= 6, `${changes.length}`);

  // 幂等：清洗过的请求再清洗一次不应再有改动
  const { changes: again } = sanitizeChatRequest(body);
  check('已清洗的请求再次清洗无改动', again.length === 0, JSON.stringify(again));

  // 不修改入参（避免调用方拿到被改过的对象）
  check('不修改原始输入', input.messages[0].role === 'developer' && input.messages[0].content === null);
}

console.log('\n[sanitize] 边界');
{
  const { body: b1 } = sanitizeChatRequest(null);
  check('null 原样返回', b1 === null);
  const { body: b2 } = sanitizeChatRequest('oops');
  check('字符串原样返回', b2 === 'oops');
  const { body: b3, changes: c3 } = sanitizeChatRequest({ model: 'deepseek-v4-flash', messages: 'not-an-array' });
  check('messages 非数组不炸', b3.messages === 'not-an-array' && c3.length === 0, JSON.stringify(c3));
  const { body: b4 } = sanitize({}, [null, 'str', 42]);
  check('messages 含非对象元素不炸', Array.isArray(b4.messages) && b4.messages.length === 3);
}

console.log(`\n=== ${pass} passed, ${fail} failed ===\n`);
process.exit(fail === 0 ? 0 : 1);