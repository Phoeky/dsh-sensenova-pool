/**
 * 真机端到端验证（国际站 token.sensenova.ai）：真实 key → 本插件 shim → 真实 API。
 *
 * 中国站版本见 e2e-live.mjs；这里专门验证「切到国际站之后整条链路仍然成立」：
 *   - 目录刷新用的是国际站的 /v1/models；
 *   - 请求真的打到 token.sensenova.ai；
 *   - 流式/非流式都能正常透传；
 *   - 上层永远收不到 429。
 *
 * 用法：node tools/e2e-intl.mjs <intl-key>
 */
import { endpointFor, INTL_BUILTIN_MODELS } from '../lib/catalog.js';
import { KeyPool } from '../lib/keypool.js';
import { createShim, ModelCatalog } from '../lib/shim.js';

const keys = process.argv.slice(2).filter(Boolean);
if (keys.length === 0) {
  console.error('usage: node tools/e2e-intl.mjs <intl-key> [key...]');
  process.exit(2);
}

const intl = endpointFor('intl');
let pass = 0, fail = 0;
const check = (n, c, d = '') => { c ? (pass++, console.log(`  PASS  ${n}`)) : (fail++, console.log(`  FAIL  ${n}${d ? ' — ' + d : ''}`)); };

const rotations = [];
const pool = new KeyPool(keys, { maxConcurrency: 1, rpmLimit: 3 });
const catalog = new ModelCatalog();
catalog.reset('intl');
check('目录初始为国际站基线', catalog.current().every((m) => m.id.startsWith('sensenova-')), JSON.stringify(catalog.current().map((m) => m.id)));

const shim = createShim({
  pool,
  catalog,
  baseUrl: intl.baseUrl,
  rotation: { maxAttempts: 4, acquireTimeoutMs: 60000, requestTimeoutMs: 45000, retryServerErrors: true },
  onAttemptFailed: (l) => rotations.push(l),
  logger: { info: () => {}, warn: (m) => console.log(`    [warn] ${m}`), error: (m) => console.log(`    [err] ${m}`) },
});

await shim.ready;
const base = shim.baseUrl();
const auth = { authorization: `Bearer ${shim.token()}`, 'content-type': 'application/json' };
check('shim 上游指向国际站', shim.upstream() === 'https://token.sensenova.ai/v1', shim.upstream());

const MODEL = 'sensenova-6.8-flash';

console.log('\n[e2e-intl] 模型目录：用 key 拉真实 /v1/models');
{
  const entry = await pool.acquire({ timeoutMs: 15000 });
  try {
    const res = await fetch(`${intl.baseUrl}/models`, { headers: { authorization: `Bearer ${entry.key}` } });
    check('目录请求 200', res.ok, String(res.status));
    const payload = await res.json();
    const count = catalog.apply(payload, INTL_BUILTIN_MODELS);
    console.log(`    上游模型：${(payload.data ?? []).map((m) => m.id).join(', ')}`);
    check('目录已刷新（live）', count > 0 && catalog.status().source === 'live', JSON.stringify(catalog.status()));
    check('刷新后仍只含对话可用模型', catalog.current().every((m) => m.id.startsWith('sensenova-')), JSON.stringify(catalog.current().map((m) => m.id)));
  } finally {
    pool.release(entry);
  }
}

console.log('\n[e2e-intl] 非流式对话：走完整 shim 路径打到国际站');
{
  const res = await fetch(`${base}/v1/chat/completions`, {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({
      model: MODEL,
      messages: [{ role: 'user', content: 'Reply with exactly: PONG' }],
      max_tokens: 64,
      stream: false,
    }),
  });
  check('上层收到 200', res.status === 200, String(res.status));
  const body = await res.json().catch(() => ({}));
  check('返回 choices', Array.isArray(body?.choices) && body.choices.length > 0, JSON.stringify(body).slice(0, 200));
  console.log(`    上游模型=${body?.model}  尝试次数=${res.headers.get('x-sensenova-pool-attempts')}`);
}

console.log('\n[e2e-intl] 流式对话：SSE 正常透传并以 [DONE] 收尾');
{
  const res = await fetch(`${base}/v1/chat/completions`, {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({
      model: MODEL,
      messages: [{ role: 'user', content: '数到三' }],
      max_tokens: 64,
      stream: true,
    }),
  });
  check('流式上层收到 200', res.status === 200, String(res.status));
  const text = await res.text();
  check('含 data: 分片', text.includes('data: '));
  check('以 [DONE] 收尾', text.trimEnd().endsWith('data: [DONE]'));
}

console.log('\n[e2e-intl] 轮换情况');
// 单 key 时 429 会记进 rotations；无论是否发生，上面的请求都应已成功返回 200。
console.log(`    期间发生的 key 轮换：${rotations.length} 次`);
check('轮换记录可读', Array.isArray(rotations), String(rotations.length));

await shim.close();
console.log(`\n=== ${pass} passed, ${fail} failed ===\n`);
process.exit(fail === 0 ? 0 : 1);
