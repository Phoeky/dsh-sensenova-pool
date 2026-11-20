/** 双站完整实例隔离回归：全部上游请求离线拦截。 */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
const { apply } = await import('../lib/index.js');
globalThis.__capture = { adapters: [], providers: [] };
const realFetch = globalThis.fetch;
const seen = [];
globalThis.fetch = async (input, init) => {
  const url = String(input);
  if (url.startsWith('http://127.0.0.1')) return realFetch(input, init);
  seen.push({ url, authorization: new Headers(init?.headers).get('authorization') });
  if (url.endsWith('/models')) return Response.json({ data: [] });
  return Response.json({ id: 'offline', object: 'chat.completion', choices: [] });
};
const prefix = (site) => '/plugins/dsh-sensenova-pool' + (site === 'intl' ? '/intl' : '');
const recordId = (site) => 'dsh-sensenova-pool/keys-' + site;
const providerId = (site) => 'sensenova-pool' + (site === 'intl' ? '-intl' : '');
const model = 'sensenova-6.8-flash';
const wait = () => new Promise((resolve) => setTimeout(resolve, 80));
let checks = 0;
function check(name, condition) { assert.ok(condition, name); checks++; console.log('  PASS  ' + name); }
async function start(initial = new Map(), config = {}) {
  const records = new Map(structuredClone([...initial]));
  const routes = new Map(), handlers = [], effects = [], adapters = new Map(), errors = [];
  const services = {
    credentials: {
      async readRecord(id) { return records.get(id); },
      async modifyRecord(id, update) { records.set(id, await update(records.get(id))); },
    },
    webServer: { register({ path, handler }) { assert.ok(!routes.has(path), '路由不得重复'); routes.set(path, handler); return () => routes.delete(path); } },
  };
  const ctx = {
    logger: { info() {}, warn() {}, error(message) { errors.push(message); } },
    get: (name) => services[name],
    effect(fn) { effects.push(fn()); }, emit() {},
    on(name, handler) { if (name === 'credentials/record-updated') handlers.push(handler); },
    inject(deps, callback) { const child = Object.create(ctx); for (const name of deps) child[name] = services[name]; callback(child); },
    llm: { registerAdapter(ids, adapter) { adapters.set(ids[0], adapter); return Object.assign(() => {}, { replace() {} }); } },
  };
  apply(ctx, { rpmLimit: 0, ...config });
  await wait();
  const server = createServer((req, res) => {
    const handler = routes.get(new URL(req.url, 'http://127.0.0.1').pathname);
    if (!handler) { res.writeHead(404); res.end(); return; }
    void handler(req, res);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = 'http://127.0.0.1:' + server.address().port;
  const status = async (site) => (await realFetch(origin + prefix(site) + '/status')).json();
  const post = async (site, body, adminKey) => {
    const current = await status(site);
    const response = await realFetch(origin + prefix(site) + '/keys', { method: 'POST', headers: { 'content-type': 'application/json', 'x-sensenova-pool-admin': adminKey ?? current.adminKey }, body: JSON.stringify(body) });
    const result = await response.json();
    return { status: response.status, body: result };
  };
  return {
    records, status, post, handlers,
    models(site) { return adapters.get(providerId(site)).profiles().get(providerId(site)).piProvider.getModels(); },
    async close() { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); for (const dispose of effects) await dispose?.(); assert.deepEqual(errors, []); },
  };
}
const grant = (payload) => ({ kind: 'grant', payload });
console.log('\n[site-isolation] 独立池、模型、窗口、令牌与并发上游');
let app = await start();
try {
  for (const site of ['cn', 'intl']) {
    const added = await app.post(site, { action: 'add', keys: 'sk-' + site + '-independent00000001' });
    check(site + ' 独立添加 key 成功', added.status === 200 && added.body.added === 1);
  }
  let cn = await app.status('cn'), intl = await app.status('intl');
  check('两个独立 key 池各一把', cn.keys.length === 1 && intl.keys.length === 1 && cn.keys[0].id !== intl.keys[0].id);
  check('外部端口和 token 均独立', cn.endpoint.port !== intl.endpoint.port && cn.endpoint.apiKey !== intl.endpoint.apiKey);
  check('跨站管理令牌拒绝写入', (await app.post('intl', { action: 'clear' }, cn.adminKey)).status === 403);
  check('中国站初始窗口 1M', app.models('cn').find((m) => m.id === model).contextWindow === 1048576);
  check('国际站初始窗口 256K', app.models('intl').find((m) => m.id === model).contextWindow === 262144);
  check('修改中国站窗口成功', (await app.post('cn', { action: 'set-model-limits', id: model, contextWindow: 524288, maxTokens: 8192 })).status === 200);
  check('窗口覆盖不污染另一站', app.models('cn').find((m) => m.id === model).contextWindow === 524288 && app.models('intl').find((m) => m.id === model).contextWindow === 262144);
  check('隐藏中国站模型成功', (await app.post('cn', { action: 'set-model', id: model, enabled: false })).status === 200);
  check('同名模型可见性彼此独立', !app.models('cn').some((m) => m.id === model) && app.models('intl').some((m) => m.id === model));
  check('独立记录不串写', app.records.get(recordId('cn')).payload.disabledModels.includes(model) && !app.records.get(recordId('intl')).payload.disabledModels.includes(model));
  const request = async (endpoint, token = endpoint.apiKey) => {
    const response = await realFetch(endpoint.baseUrl + '/chat/completions', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + token }, body: JSON.stringify({ model, messages: [{ role: 'user', content: 'hi' }] }) });
    await response.text(); return response.status;
  };
  check('跨站外部 token 被拒绝', await request(intl.endpoint, cn.endpoint.apiKey) === 401);
  const before = seen.length;
  const responses = await Promise.all([request(cn.endpoint), request(intl.endpoint), app.post('cn', { action: 'set-endpoint', id: 'intl' }), app.post('intl', { action: 'set-endpoint', id: 'cn' })]);
  check('同时请求两站成功且禁止切换上游', responses[0] === 200 && responses[1] === 200 && responses[2].status === 400 && responses[3].status === 400);
  const calls = seen.slice(before).filter((call) => call.url.endsWith('/chat/completions'));
  check('中国 key 只发中国固定上游', calls.some((call) => call.url === 'https://token.sensenova.cn/v1/chat/completions' && call.authorization === 'Bearer sk-cn-independent00000001'));
  check('国际 key 只发国际固定上游', calls.some((call) => call.url === 'https://token.sensenova.ai/v1/chat/completions' && call.authorization === 'Bearer sk-intl-independent00000001'));
  const current = app.records.get(recordId('cn'));
  current.payload.keys = [];
  current.payload.disabledModels = [];
  current.payload.modelLimits = { [model]: { contextWindow: 131072, maxTokens: 4096 } };
  for (const handler of app.handlers) handler(recordId('cn'));
  await wait();
  check('凭据事件同步删除中国 key', (await app.status('cn')).keys.length === 0);
  check('无新增 key 的凭据事件仍刷新模型与窗口', app.models('cn').find((m) => m.id === model)?.contextWindow === 131072);
  check('凭据事件不修改国际站', (await app.status('intl')).keys.length === 1 && app.models('intl').find((m) => m.id === model).contextWindow === 262144);
  current.payload.modelLimits = { [model]: { contextWindow: 65536, maxTokens: 4096 } };
  check('显式 reload 成功', (await app.post('cn', { action: 'reload' })).status === 200);
  check('无新增 key 的 reload 仍刷新窗口', app.models('cn').find((m) => m.id === model)?.contextWindow === 65536);
  check('清空中国池不影响国际池', (await app.post('cn', { action: 'clear' })).status === 200 && (await app.status('intl')).keys.length === 1);
} finally { await app.close(); }
console.log('\n[site-isolation] 旧记录迁移只归属原站，保留全部元数据');
for (const site of ['cn', 'intl']) {
  const legacy = grant({ endpoint: site, keys: ['sk-legacy-' + site + '-0000000001'], externalKey: 'sk-legacy-external-' + site + '-00000001', disabledModels: [model], modelLimits: { [model]: { contextWindow: 131072, maxTokens: 4096 } } });
  app = await start(new Map([['dsh-sensenova-pool/keys', legacy]]));
  try {
    const other = site === 'cn' ? 'intl' : 'cn';
    check(site + ' 旧 key 只迁移到原站', (await app.status(site)).keys.length === 1 && (await app.status(other)).keys.length === 0);
    check(site + ' 旧 token 原样继承且另一站独立', (await app.status(site)).endpoint.apiKey === legacy.payload.externalKey && (await app.status(other)).endpoint.apiKey !== legacy.payload.externalKey);
    const migrated = app.records.get(recordId(site));
    check(site + ' 已有外部 token 也立即落盘独立记录', migrated?.payload?.keys[0] === legacy.payload.keys[0]);
    check(site + ' 可见性与窗口覆盖完整迁移', migrated.payload.disabledModels.includes(model) && migrated.payload.modelLimits[model].contextWindow === 131072 && !app.models(site).some((m) => m.id === model) && app.models(other).some((m) => m.id === model));
    check(site + ' 保留旧记录供回退', JSON.stringify(app.records.get('dsh-sensenova-pool/keys')) === JSON.stringify(legacy));
    const persisted = new Map(app.records);
    await app.close(); app = await start(persisted);
    check(site + ' 重启仍使用独立记录', (await app.status(site)).endpoint.apiKey === legacy.payload.externalKey && (await app.status(other)).keys.length === 0);
  } finally { await app.close(); }
}
app = await start(new Map([['dsh-sensenova-pool/keys', grant({ keys: ['sk-config-legacy000001'] })]]), { endpoint: 'intl', baseUrl: 'https://gateway.example/v1' });
try {
  check('无 endpoint 旧记录按旧配置归属国际站', (await app.status('intl')).keys.length === 1 && (await app.status('cn')).keys.length === 0);
  check('自定义网关只覆盖配置归属站', (await app.status('intl')).upstreamEndpoint.upstream === 'https://gateway.example/v1' && (await app.status('cn')).upstreamEndpoint.upstream === 'https://token.sensenova.cn/v1');
} finally { await app.close(); }
app = await start(new Map([
  ['dsh-sensenova-pool/keys', grant({ keys: ['sk-default-cn-legacy0001'], externalKey: 'sk-default-cn-external0001' })],
  [recordId('intl'), grant({ keys: ['sk-existing-intl00000001'], externalKey: 'sk-existing-intl-external0001' })],
]));
try {
  check('无旧 endpoint 且无配置默认只迁移中国站', app.records.get(recordId('cn'))?.payload.keys[0] === 'sk-default-cn-legacy0001');
  check('已有独立国际站记录优先且不被旧记录覆盖', app.records.get(recordId('intl')).payload.keys[0] === 'sk-existing-intl00000001' && (await app.status('intl')).endpoint.apiKey === 'sk-existing-intl-external0001');
} finally { await app.close(); }
globalThis.fetch = realFetch;
console.log('\n=== ' + checks + ' passed, 0 failed ===');
