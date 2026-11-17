/**
 * shim 端到端验证：起真实的回环 HTTP 服务，走完整 OpenAI 协议，
 * 用假的 upstream 注入 429，确认上层看到的是「从不 429」的稳定端点。
 */
import { reasoningEffortsFor } from '../lib/catalog.js';
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

console.log('\n[shim] 对外密钥切换（setToken）');
{
  const pool = new KeyPool(['sk-test0001'], {});
  const catalog = new ModelCatalog();
  const shim = createShim({ pool, catalog, baseUrl: UPSTREAM });
  await shim.ready;
  const base = shim.baseUrl();
  const before = shim.token();

  const persisted = 'sk-dsh-persisted-external-key-0001';
  shim.setToken(persisted);
  check('token() 返回新密钥', shim.token() === persisted, shim.token());
  check('端口可读且为正整数', Number.isInteger(shim.port()) && shim.port() > 0, String(shim.port()));

  const withNew = await realFetch(`${base}/healthz`, { headers: { authorization: `Bearer ${persisted}` } });
  check('新密钥可用', withNew.status === 200, String(withNew.status));
  await withNew.text();

  // 旧密钥继续被接受：pi-ai 可能缓存了 resolveApiKey 的结果，切换瞬间不该 401。
  const withOld = await realFetch(`${base}/healthz`, { headers: { authorization: `Bearer ${before}` } });
  check('旧密钥仍被接受（避免在途请求 401）', withOld.status === 200, String(withOld.status));
  await withOld.text();

  const empty = await realFetch(`${base}/healthz`, { headers: { authorization: 'Bearer ' } });
  check('空 Bearer 仍被拒 401', empty.status === 401, String(empty.status));
  await empty.text();

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

console.log('\n[shim] 请求体清洗：Agent 合法但商汤不认的写法在转发前被修好（issue #2）');
{
  const pool = new KeyPool(['sk-clean'], { maxConcurrency: 4 });
  const catalog = new ModelCatalog();
  const logs = [];
  const shim = createShim({
    pool,
    catalog,
    baseUrl: UPSTREAM,
    logger: { info: (m) => logs.push(m), warn: (m) => logs.push(m), error: (m) => logs.push(m) },
    debugRequestOn400: true,
  });
  await shim.ready;
  const base = shim.baseUrl();

  // 假上游：完全复刻商汤实测会 400 的判定（任何一个没被清洗掉就回 400）。
  const realFetch3 = realFetch;
  let lastSent = null;
  globalThis.fetch = async (url, init) => {
    if (String(url).includes('token.sensenova.cn')) {
      lastSent = JSON.parse(init.body);
      const reject = (msg) =>
        new Response(JSON.stringify({ error: { message: msg, type: 'invalid_request_error', code: '3' } }), {
          status: 400,
          headers: { 'content-type': 'application/json' },
        });

      for (const f of ['logprobs', 'top_logprobs', 'metadata']) if (f in lastSent) return reject('invalid arguments');
      for (const f of ['temperature', 'top_p', 'frequency_penalty', 'presence_penalty']) {
        if (f in lastSent && typeof lastSent[f] !== 'number') return reject('invalid arguments');
      }
      // 商汤的合法词表是**按模型**判定的（issue #3）：glm-5.3 只认 low/high/max，
      // glm-5.2 七档全收。这里直接复用插件的词表，假上游才和真上游一样严格。
      if (
        lastSent.reasoning_effort !== undefined &&
        !reasoningEffortsFor(lastSent.model).includes(lastSent.reasoning_effort)
      ) {
        return reject('field ReasoningEffort invalid');
      }
      for (const m of lastSent.messages ?? []) {
        if (!['system', 'user', 'assistant', 'tool'].includes(m.role)) return reject('inference request is invalid');
        const hasTc = Array.isArray(m.tool_calls) && m.tool_calls.length > 0;
        if (m.role !== 'user' && !hasTc && (m.content === null || m.content === undefined)) {
          return reject('inference request is invalid');
        }
        if (m.content !== null && m.content !== undefined && typeof m.content !== 'string' && !Array.isArray(m.content)) {
          return reject('invalid arguments');
        }
        for (const c of m.tool_calls ?? []) {
          if (c.function && typeof c.function.arguments !== 'string') return reject('invalid arguments');
        }
      }
      return new Response(JSON.stringify({ id: 'x', choices: [{ message: { role: 'assistant', content: 'ok' } }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    return realFetch3(url, init);
  };

  const dirty = {
    model: 'deepseek-v4-flash',
    stream: false,
    messages: [
      { role: 'developer', content: null },
      { role: 'user', content: 42 },
      {
        role: 'assistant',
        content: null,
        tool_calls: [{ id: 'c1', type: 'function', function: { name: 'f', arguments: { a: 1 } } }],
      },
      { role: 'tool', tool_call_id: 'c1' },
    ],
    reasoning_effort: 'off',
    temperature: '0.2',
    metadata: { trace: 'x' },
    logprobs: true,
  };

  const res = await realFetch(`${base}/v1/chat/completions`, {
    method: 'POST',
    headers: { authorization: `Bearer ${shim.token()}`, 'content-type': 'application/json' },
    body: JSON.stringify(dirty),
  });
  await res.text();

  check('上游收到 200（清洗生效，未撞 400）', res.status === 200, String(res.status));
  check('developer 已映射成 system', lastSent?.messages?.[0]?.role === 'system', lastSent?.messages?.[0]?.role);
  check('developer 的 null content 已补 ""', lastSent?.messages?.[0]?.content === '');
  check('user 数字 content 已转字符串', lastSent?.messages?.[1]?.content === '42', String(lastSent?.messages?.[1]?.content));
  check('tool_calls.arguments 已序列化', typeof lastSent?.messages?.[2]?.tool_calls?.[0]?.function?.arguments === 'string');
  check('tool 缺 content 已补 ""', lastSent?.messages?.[3]?.content === '');
  check('reasoning_effort off → none', lastSent?.reasoning_effort === 'none', String(lastSent?.reasoning_effort));
  check('temperature 已转数字', lastSent?.temperature === 0.2, String(lastSent?.temperature));
  check('metadata 已摘除', !('metadata' in (lastSent ?? {})));
  check('logprobs 已摘除', !('logprobs' in (lastSent ?? {})));
  check('日志记录了规范化', logs.some((l) => l.includes('已规范化请求体字段')), JSON.stringify(logs.slice(-3)));

  globalThis.fetch = realFetch3;
  await shim.close();
}

console.log('\n[shim] 干净请求原样转发（清洗不引入多余改动）');
{
  const pool = new KeyPool(['sk-clean2'], { maxConcurrency: 4 });
  const catalog = new ModelCatalog();
  const shim = createShim({ pool, catalog, baseUrl: UPSTREAM });
  await shim.ready;
  const base = shim.baseUrl();

  const realFetch4 = realFetch;
  let rawSent = null;
  globalThis.fetch = async (url, init) => {
    if (String(url).includes('token.sensenova.cn')) {
      rawSent = init.body;
      return new Response(JSON.stringify({ id: 'y', choices: [{ message: { role: 'assistant', content: 'ok' } }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    return realFetch4(url, init);
  };

  const cleanBody = JSON.stringify({
    model: 'deepseek-v4-flash',
    stream: false,
    temperature: 0.3,
    reasoning_effort: 'low',
    messages: [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'hi' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [{ id: 'c1', type: 'function', function: { name: 'f', arguments: '{}' } }],
      },
      { role: 'tool', tool_call_id: 'c1', content: 'ok' },
    ],
  });
  const res = await realFetch(`${base}/v1/chat/completions`, {
    method: 'POST',
    headers: { authorization: `Bearer ${shim.token()}`, 'content-type': 'application/json' },
    body: cleanBody,
  });
  await res.text();

  check('干净请求返回 200', res.status === 200, String(res.status));
  check('请求体逐字节原样转发', rawSent === cleanBody, 'body 被改写');
  check('带 tool_calls 的 content:null 未被改动', JSON.parse(rawSent).messages[2].content === null);

  globalThis.fetch = realFetch4;
  await shim.close();
}

console.log('\n[shim] 推理档按模型纠正：glm-5.3 收到 xhigh 时改发 max（issue #3）');
{
  const pool = new KeyPool(['sk-effort'], { maxConcurrency: 4 });
  const catalog = new ModelCatalog();
  const logs = [];
  const shim = createShim({
    pool,
    catalog,
    baseUrl: UPSTREAM,
    logger: { info: (m) => logs.push(m), warn: (m) => logs.push(m), error: (m) => logs.push(m) },
  });
  await shim.ready;
  const base = shim.baseUrl();

  const realFetch5 = realFetch;
  let sent = null;
  globalThis.fetch = async (url, init) => {
    if (String(url).includes('token.sensenova.cn')) {
      sent = JSON.parse(init.body);
      const vocab = reasoningEffortsFor(sent.model);
      if (sent.reasoning_effort !== undefined && !vocab.includes(sent.reasoning_effort)) {
        return new Response(
          JSON.stringify({
            error: { message: `field ReasoningEffort invalid, should be one of: ${vocab.join(', ')}`, type: 'invalid_request_error', code: '3' },
          }),
          { status: 400, headers: { 'content-type': 'application/json' } },
        );
      }
      return new Response(JSON.stringify({ id: 'z', choices: [{ message: { role: 'assistant', content: 'ok' } }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    return realFetch5(url, init);
  };

  const res = await realFetch(`${base}/v1/chat/completions`, {
    method: 'POST',
    headers: { authorization: `Bearer ${shim.token()}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'glm-5.3',
      stream: false,
      reasoning_effort: 'xhigh',
      messages: [{ role: 'user', content: 'hi' }],
    }),
  });
  await res.text();

  check('glm-5.3 + xhigh 没有被上游拒绝', res.status === 200, String(res.status));
  check('上游实际收到 max（不是 xhigh）', sent?.reasoning_effort === 'max', String(sent?.reasoning_effort));
  check('日志记录了规范化', logs.some((l) => l.includes('已规范化请求体字段')), JSON.stringify(logs.slice(-3)));

  globalThis.fetch = realFetch5;
  await shim.close();
}

console.log('\n[shim] 上游 400 时记录实际发出的请求体（排障开关）');
{
  const pool = new KeyPool(['sk-dbg'], { maxConcurrency: 4 });
  const catalog = new ModelCatalog();
  const warnings = [];
  const shim = createShim({
    pool,
    catalog,
    baseUrl: UPSTREAM,
    logger: { info: () => {}, warn: (m) => warnings.push(m), error: () => {} },
    debugRequestOn400: true,
  });
  await shim.ready;
  const base = shim.baseUrl();

  const realFetch5 = realFetch;
  globalThis.fetch = async (url, init) => {
    if (String(url).includes('token.sensenova.cn')) {
      // 模拟一个清洗层没能覆盖的新字段导致 400
      return new Response(
        JSON.stringify({ error: { message: 'inference request is invalid', type: 'invalid_request_error', code: '3' } }),
        { status: 400, headers: { 'content-type': 'application/json' } },
      );
    }
    return realFetch5(url, init);
  };

  const res = await realFetch(`${base}/v1/chat/completions`, {
    method: 'POST',
    headers: { authorization: `Bearer ${shim.token()}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'deepseek-v4-flash', messages: [{ role: 'user', content: 'hi' }] }),
  });
  await res.text();

  check('400 如实上报给上层', res.status === 400, String(res.status));
  check(
    '日志包含实际请求体',
    warnings.some((w) => w.includes('实际发出的请求体') && w.includes('deepseek-v4-flash')),
    JSON.stringify(warnings.slice(-2)),
  );

  globalThis.fetch = realFetch5;
  await shim.close();
}

console.log(`\n=== ${pass} passed, ${fail} failed ===\n`);
process.exit(fail === 0 ? 0 : 1);
