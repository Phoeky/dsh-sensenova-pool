/**
 * shim 端到端验证：起真实的回环 HTTP 服务，走完整 OpenAI 协议，
 * 用假的 upstream 注入 429，确认上层看到的是「从不 429」的稳定端点。
 */
import { KeyPool } from '../lib/keypool.js';
import { ModelCatalog } from '../lib/shim.js';
import { createShim } from '../lib/shim.js';

let pass = 0, fail = 0;
const check = (n, c, d = '') => { c ? (pass++, console.log(`  PASS  ${n}`)) : (fail++, console.log(`  FAIL  ${n}${d ? ' — ' + d : ''}`)); };

const UPSTREAM = 'https://token.sensenova.cn/v1';
const realFetch = globalThis.fetch;

console.log('\n[shim] 认证与安全边界');
{
  const pool = new KeyPool(['sk-test0001'], {});
  const catalog = new ModelCatalog();
  const shim = createShim({ pool, catalog, baseUrl: UPSTREAM });
  await shim.ready;
  const base = shim.baseUrl();
  check('监听回环地址', base.startsWith('http://127.0.0.1:'));

  const noAuth = await realFetch(`${base}/healthz`);
  check('无 Bearer 被拒 401', noAuth.status === 401, String(noAuth.status));

  const badAuth = await realFetch(`${base}/healthz`, { headers: { authorization: 'Bearer wrong' } });
  check('错误 Bearer 被拒 401', badAuth.status === 401, String(badAuth.status));

  const good = await realFetch(`${base}/healthz`, { headers: { authorization: `Bearer ${shim.token()}` } });
  check('正确 Bearer 放行 200', good.status === 200, String(good.status));
  const health = await good.json();
  check('healthz 回报池状态', health.ok === true && typeof health.total === 'number');

  const models = await realFetch(`${base}/v1/models`, { headers: { authorization: `Bearer ${shim.token()}` } });
  const modelsBody = await models.json();
  check('/v1/models 返回目录', Array.isArray(modelsBody.data) && modelsBody.data.length > 0);
  check('目录含 deepseek-v4-flash', modelsBody.data.some((m) => m.id === 'deepseek-v4-flash'));

  // 恶意 Host 头（DNS rebinding 防护）。
  // 注意：fetch 规范禁止调用方覆盖 Host，必须用 node:http 才能真实构造该请求。
  const { request } = await import('node:http');
  const port = new URL(base).port;
  const hitWithHost = (host) =>
    new Promise((resolve) => {
      const req = request(
        { host: '127.0.0.1', port, path: '/healthz', method: 'GET',
          headers: { authorization: `Bearer ${shim.token()}`, host } },
        (r) => { r.resume(); resolve(r.statusCode); },
      );
      req.on('error', () => resolve(-1));
      req.end();
    });
  check('非回环 Host 被拒 403', (await hitWithHost('evil.example.com')) === 403);
  check('前缀伪装 Host 被拒 403', (await hitWithHost('127.0.0.1.evil.com')) === 403);
  check('回环 Host 正常放行', (await hitWithHost(`127.0.0.1:${port}`)) === 200);

  await shim.close();
}

console.log('\n[shim] 429 在 shim 内部被消化，上层看不到 429');
{
  const pool = new KeyPool(['sk-key1', 'sk-key2', 'sk-key3'], { maxConcurrency: 4 });
  const catalog = new ModelCatalog();
  const rotations = [];
  const shim = createShim({
    pool,
    catalog,
    baseUrl: UPSTREAM,
    onAttemptFailed: (l) => rotations.push(l),
  });
  await shim.ready;
  const base = shim.baseUrl();

  // 拦截并伪造上游：前两把 key 429，第三把成功。
  let call = 0;
  globalThis.fetch = async (url, init) => {
    if (String(url).includes('token.sensenova.cn')) {
      call += 1;
      if (call <= 2) {
        return new Response(JSON.stringify({ error: { message: 'inference exceeds tpm/rpm limit', type: 'rate_limit_error' } }), { status: 429 });
      }
      return new Response(JSON.stringify({ id: 'x', model: 'deepseek-v4-flash', choices: [{ message: { role: 'assistant', content: 'ok' } }] }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return realFetch(url, init);
  };

  const res = await realFetch(`${base}/v1/chat/completions`, {
    method: 'POST',
    headers: { authorization: `Bearer ${shim.token()}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'deepseek-v4-flash', messages: [{ role: 'user', content: 'hi' }], stream: false }),
  });
  const body = await res.json();

  check('上层收到 200（不是 429）', res.status === 200, String(res.status));
  check('内容正确透传', body.choices?.[0]?.message?.content === 'ok');
  check('暴露实际用了哪把 key', typeof res.headers.get('x-sensenova-pool-key') === 'string');
  check('暴露尝试次数', res.headers.get('x-sensenova-pool-attempts') === '3', res.headers.get('x-sensenova-pool-attempts'));
  check('内部记录 2 次轮换', rotations.length === 2, `rotations=${rotations.length}`);

  globalThis.fetch = realFetch;
  await shim.close();
}

console.log('\n[shim] 全部 key 都 429 时，上层收到明确的错误而非挂起');
{
  const pool = new KeyPool(['sk-only'], { maxConcurrency: 4 });
  const catalog = new ModelCatalog();
  const shim = createShim({ pool, catalog, baseUrl: UPSTREAM, rotation: { maxAttempts: 2, acquireTimeoutMs: 3000, requestTimeoutMs: 3000 } });
  await shim.ready;
  const base = shim.baseUrl();

  const realFetch2 = realFetch;
  globalThis.fetch = async (url, init) => {
    if (String(url).includes('token.sensenova.cn')) {
      return new Response(JSON.stringify({ error: { message: 'rpm exhausted', type: 'rate_limit_error' } }), { status: 429 });
    }
    return realFetch2(url, init);
  };

  const started = Date.now();
  const res = await realFetch(`${base}/v1/chat/completions`, {
    method: 'POST',
    headers: { authorization: `Bearer ${shim.token()}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'deepseek-v4-flash', messages: [{ role: 'user', content: 'hi' }] }),
  });
  const elapsed = Date.now() - started;
  const body = await res.json();
  // 核心承诺：429 绝不穿透到上层，改报 503 + Retry-After，让 DSH 退避重试。
  check('上层收到 503（不是 429）', res.status === 503, String(res.status));
  check('带 Retry-After 头', res.headers.get('retry-after') !== null, String(res.headers.get('retry-after')));
  check('错误体是 OpenAI 形状', typeof body?.error?.message === 'string');
  check('在预算内返回，没有无限挂起', elapsed < 12000, `${elapsed}ms`);

  globalThis.fetch = realFetch;
  await shim.close();
}

console.log(`\n=== ${pass} passed, ${fail} failed ===\n`);
process.exit(fail === 0 ? 0 : 1);
