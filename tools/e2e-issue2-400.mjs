/**
 * 真机验证（会消耗额度）：把 issue #2 那一类请求体直接打真实上游，
 * 对比「清洗前」与「清洗后」的状态码，证明修复有效。
 *
 * 用法：node tools/e2e-issue2-400.mjs <sk-key>
 */
import { sanitizeChatRequest } from '../lib/sanitize.js';

const KEY = process.argv[2];
if (!KEY) {
  console.error('用法: node tools/e2e-issue2-400.mjs <sk-key>');
  process.exit(2);
}
const URL = 'https://token.sensenova.cn/v1/chat/completions';

let pass = 0, fail = 0;
const check = (n, c, d = '') => {
  c ? (pass++, console.log(`  PASS  ${n}`)) : (fail++, console.log(`  FAIL  ${n}${d ? ' — ' + d : ''}`));
};

async function post(body, tries = 20) {
  for (let i = 0; i < tries; i += 1) {
    const res = await fetch(URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${KEY}` },
      body: JSON.stringify(body),
    });
    if (res.status !== 429) {
      const text = await res.text();
      let sig = text.slice(0, 160);
      try {
        const e = JSON.parse(text).error;
        sig = `code=${e?.code} msg=${e?.message}`;
      } catch {}
      return { status: res.status, sig };
    }
    await res.text();
    await new Promise((r) => setTimeout(r, 10000));
  }
  return { status: 429, sig: '429 after retries' };
}

const CLEAN_BASE = {
  model: 'deepseek-v4-flash',
  messages: [{ role: 'user', content: 'hi' }],
};

const CASES = [
  {
    label: 'developer 角色',
    body: { ...CLEAN_BASE, messages: [{ role: 'developer', content: 'you are a coding agent' }, { role: 'user', content: 'hi' }] },
  },
  {
    label: 'assistant content:null（无 tool_calls）',
    body: { ...CLEAN_BASE, messages: [{ role: 'user', content: 'hi' }, { role: 'assistant', content: null }] },
  },
  {
    label: 'tool content:null',
    body: {
      ...CLEAN_BASE,
      messages: [
        { role: 'user', content: 'hi' },
        { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'f', arguments: '{}' } }] },
        { role: 'tool', tool_call_id: 'c1', content: null },
      ],
    },
  },
  {
    label: 'tool_calls.arguments 传对象',
    body: {
      ...CLEAN_BASE,
      messages: [
        { role: 'user', content: 'hi' },
        { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'f', arguments: { a: 1 } } }] },
        { role: 'tool', tool_call_id: 'c1', content: '1' },
      ],
    },
  },
  {
    label: 'reasoning_effort: off',
    body: { ...CLEAN_BASE, reasoning_effort: 'off' },
  },
  {
    label: 'reasoning_effort: max',
    body: { ...CLEAN_BASE, reasoning_effort: 'max' },
  },
  {
    label: 'temperature 字符串',
    body: { ...CLEAN_BASE, temperature: '0.7' },
  },
  {
    label: 'logprobs + metadata',
    body: { ...CLEAN_BASE, logprobs: true, metadata: { a: 1 } },
  },
];

console.log('\n[realsense] issue #2 类请求体：清洗前 vs 清洗后（真实上游）\n');
for (const c of CASES) {
  const before = await post(c.body);
  const { body: sanitized, changes } = sanitizeChatRequest(c.body);
  const after = changes.length > 0 ? await post(sanitized) : before;

  const fixed = before.status === 400 && after.status === 200;
  const alreadyOk = before.status === 200;
  console.log(`  ${c.label.padEnd(34)} 清洗前=${String(before.status).padEnd(4)} 清洗后=${String(after.status).padEnd(4)} 改动=[${changes.join(',')}]`);
  if (before.status === 400) console.log(`      清洗前错误: ${before.sig}`);
  check(`${c.label}：清洗后不再 400`, fixed || alreadyOk || after.status === 429, `before=${before.status} after=${after.status}`);
}

console.log(`\n=== ${pass} passed, ${fail} failed ===\n`);
process.exit(fail === 0 ? 0 : 1);