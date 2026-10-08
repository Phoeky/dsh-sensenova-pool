/**
 * 关键验证：并发猛打 **shim**（而不是直接打轮换池），确认 429 在 shim 内部
 * 被完全消化 —— 这正是 DSH 实际经历的路径。
 *
 * 判定标准不是「全部成功」（单把 key 的 rpm 上限是物理事实，再多重试也变不出
 * 额度），而是：
 *   1. 上层收到的每一个非 200 响应都不是 429；
 *   2. 池内的 429 计数 > 0，证明确实发生过限流并被拦下；
 *   3. 没有任何请求挂起。
 */
import { KeyPool } from '../lib/keypool.js';
import { createShim, ModelCatalog } from '../lib/shim.js';

const keys = process.argv.slice(2).filter(Boolean);
if (keys.length === 0) {
  console.error('usage: node tools/e2e-storm-shim.mjs <key> [key...]');
  process.exit(2);
}

const BASE = 'https://token.sensenova.cn/v1';
const N = 10;
const rotations = [];

const pool = new KeyPool(keys, { maxConcurrency: 1 });
const shim = createShim({
  pool,
  catalog: new ModelCatalog(),
  baseUrl: BASE,
  rotation: { maxAttempts: 3, acquireTimeoutMs: 25000, requestTimeoutMs: 40000, retryServerErrors: true },
  onAttemptFailed: (l) => rotations.push(l),
  logger: { info: () => {}, warn: () => {}, error: () => {} },
});

await shim.ready;
const base = shim.baseUrl();
const auth = { authorization: `Bearer ${shim.token()}`, 'content-type': 'application/json' };

let ok = 0;
let leaked429 = 0;
const other = [];
const started = Date.now();

await Promise.all(
  Array.from({ length: N }, async (_, i) => {
    try {
      const res = await fetch(`${base}/v1/chat/completions`, {
        method: 'POST',
        headers: auth,
        body: JSON.stringify({
          model: 'deepseek-v4-flash',
          messages: [{ role: 'user', content: `ping ${i}` }],
          max_tokens: 4,
        }),
      });
      if (res.status === 200) ok += 1;
      else if (res.status === 429) leaked429 += 1;
      else other.push(res.status);
      await res.text();
    } catch (error) {
      other.push(`throw:${error.message}`);
    }
  }),
);

const elapsed = ((Date.now() - started) / 1000).toFixed(1);
const snap = pool.snapshot();
const total429 = snap.reduce((s, k) => s + k.stats.rateLimited, 0);

console.log(`\n并发 ${N} 个请求经 shim 打到真实商汤 API，耗时 ${elapsed}s`);
console.log(`  上层 200: ${ok}`);
console.log(`  上层 429: ${leaked429}   ← 必须为 0`);
console.log(`  其他: ${JSON.stringify(other)}`);
console.log(`  池内 429 计数: ${total429}   ← >0 才说明确实触发了限流`);
console.log(`  shim 内部轮换次数: ${rotations.length}`);
console.log(`  summary: ${JSON.stringify(pool.summary())}`);

let pass = 0, fail = 0;
const check = (n, c, d = '') => { c ? (pass++, console.log(`  PASS  ${n}`)) : (fail++, console.log(`  FAIL  ${n}${d ? ' — ' + d : ''}`)); };
console.log('');
check('上层收到的 429 数量为 0（限流被完全屏蔽）', leaked429 === 0, `leaked=${leaked429}`);
check('确实发生过限流并被拦下（池内 429 计数 > 0）', total429 > 0, `count=${total429}`);
check('没有请求异常抛出', other.filter((x) => String(x).startsWith('throw')).length === 0, JSON.stringify(other));
check('至少部分请求成功', ok > 0, `ok=${ok}`);
check('所有 key 都已归还（inflight 归零）', pool.summary().inflight === 0, JSON.stringify(pool.summary()));

await shim.close();
console.log(`\n=== ${pass} passed, ${fail} failed ===\n`);
process.exit(fail === 0 ? 0 : 1);
