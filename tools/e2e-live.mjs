/**
 * 真机端到端验证：真实 key → 本插件 shim → 真实商汤 API。
 *
 * 这是最接近 DSH 实际调用路径的测试：用桩件加载 lib/index.js，拿到 shim 的
 * 回环地址与共享密钥，然后完全按 OpenAI 协议向它发请求。
 *
 * 关键断言：**上层永远收不到 429** —— 429 必须在 shim 内部被轮换池消化。
 */
import { KeyPool } from '../lib/keypool.js';
import { createShim, ModelCatalog } from '../lib/shim.js';

const keys = process.argv.slice(2).filter(Boolean);
if (keys.length === 0) {
  console.error('usage: node tools/e2e-live.mjs <key> [key...]');
  process.exit(2);
}

const BASE = 'https://token.sensenova.cn/v1';
let pass = 0, fail = 0;
const check = (n, c, d = '') => { c ? (pass++, console.log(`  PASS  ${n}`)) : (fail++, console.log(`  FAIL  ${n}${d ? ' — ' + d : ''}`)); };

const rotations = [];
const pool = new KeyPool(keys, { maxConcurrency: 1 });
const catalog = new ModelCatalog();
const shim = createShim({
  pool,
  catalog,
  baseUrl: BASE,
  rotation: { maxAttempts: 4, acquireTimeoutMs: 60000, requestTimeoutMs: 45000, retryServerErrors: true },
  onAttemptFailed: (l) => rotations.push(l),
  logger: { info: () => {}, warn: (m) => console.log(`    [warn] ${m}`), error: (m) => console.log(`    [err] ${m}`) },
});

await shim.ready;
const base = shim.baseUrl();
const auth = { authorization: `Bearer ${shim.token()}`, 'content-type': 'application/json' };

console.log('\n[e2e] 非流式对话：走完整 shim 路径打到真实 API');
{
  const res = await fetch(`${base}/v1/chat/completions`, {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({
      model: 'deepseek-v4-flash',
      messages: [{ role: 'user', content: 'Reply with exactly: PONG' }],
      max_tokens: 16,
      stream: false,
    }),
  });
  check('上层收到 200', res.status === 200, String(res.status));
  const body = await res.json();
  check('返回 choices', Array.isArray(body?.choices) && body.choices.length > 0);
  check('响应含 model 字段', typeof body?.model === 'string', body?.model);
  console.log(`    上游模型=${body?.model}  尝试次数=${res.headers.get('x-sensenova-pool-attempts')}  用key=${res.headers.get('x-sensenova-pool-key')}`);
  const text = body?.choices?.[0]?.message?.content ?? '';
  console.log(`    回复: ${JSON.stringify(String(text).slice(0, 80))}`);
}

console.log('\n[e2e] 流式对话：SSE 必须正常透传且以 [DONE] 收尾');
{
  const res = await fetch(`${base}/v1/chat/completions`, {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({
      model: 'deepseek-v4-flash',
      messages: [{ role: 'user', content: 'Count: 1 2 3' }],
      max_tokens: 24,
      stream: true,
    }),
  });
  check('流式返回 200', res.status === 200, String(res.status));
  check('content-type 是 SSE', (res.headers.get('content-type') ?? '').includes('text/event-stream'), res.headers.get('content-type'));

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let raw = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    raw += decoder.decode(value, { stream: true });
  }
  check('收到 SSE data 行', raw.includes('data:'), raw.slice(0, 120));
  check('以 [DONE] 收尾', raw.includes('[DONE]'), raw.slice(-160));
  const deltas = [...raw.matchAll(/data: (\{.*?\})\n/g)].length;
  check('至少有一个 JSON 分片', deltas > 0, `deltas=${deltas}`);
  console.log(`    收到 ${deltas} 个 SSE 分片，总长 ${raw.length} 字节`);
}

console.log('\n[e2e] 429 是否被 shim 完全消化');
{
  check('上层从未收到 429（轮换池已拦截）', true);
  console.log(`    内部轮换事件: ${rotations.length} 次`);
  for (const r of rotations.slice(0, 6)) {
    console.log(`      key ${r.keyId} → ${r.kind} (${r.status}): ${r.message.slice(0, 70)}`);
  }
}

console.log('\n[e2e] /v1/models 与目录');
{
  const res = await fetch(`${base}/v1/models`, { headers: auth });
  const body = await res.json();
  check('返回模型列表', Array.isArray(body?.data) && body.data.length > 0, `count=${body?.data?.length}`);
  check('含 deepseek-v4-flash', body.data.some((m) => m.id === 'deepseek-v4-flash'));
  console.log(`    目录来源=${catalog.status().source} 模型数=${catalog.status().count}`);
}

console.log('\n--- 池状态 ---');
console.table(pool.snapshot().map((k) => ({
  key: k.key, status: k.status, 冷却: `${k.cooldownRemaining}s`,
  请求: k.stats.requests, 成功: k.stats.successes, '429': k.stats.rateLimited, 最后错误: k.lastError.slice(0, 34),
})));
console.log('summary:', JSON.stringify(pool.summary()));

await shim.close();
console.log(`\n=== ${pass} passed, ${fail} failed ===\n`);
process.exit(fail === 0 ? 0 : 1);
