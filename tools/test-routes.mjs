/**
 * 路由端到端测试：起一个假的 webServer，挂上本插件的路由，用真实 HTTP 请求
 * 验证「填 key → 列表 → 测试 → 删除」这条用户路径，以及写入令牌守卫。
 */
import { createServer } from 'node:http';
import { KeyPool } from '../lib/keypool.js';
import { registerKeyRoutes } from '../lib/routes.js';

let pass = 0, fail = 0;
const check = (n, c, d = '') => { c ? (pass++, console.log(`  PASS  ${n}`)) : (fail++, console.log(`  FAIL  ${n}${d ? ' — ' + d : ''}`)); };

// ---- 假的 webServer + cordis ctx -------------------------------------------
const routes = new Map();
const webServer = {
  register({ path, handler }) {
    routes.set(path, handler);
    return () => routes.delete(path);
  },
};

const saved = [];
const ctx = {
  logger: { info() {}, warn() {}, error() {} },
  effect: () => {},
  inject: (deps, cb) => {
    if (deps.includes('webServer')) cb({ ...ctx, webServer });
  },
};

const pool = new KeyPool([], {});
const modelRows = [
  { id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash', contextWindow: 1048576, maxTokens: 65536, defaults: { contextWindow: 1048576, maxTokens: 65536 }, overridden: false, enabled: true },
  { id: 'glm-5.2', name: 'GLM-5.2', contextWindow: 1048576, maxTokens: 131072, defaults: { contextWindow: 1048576, maxTokens: 131072 }, overridden: false, enabled: true },
];
const modelsChanged = [];
const limitsChanged = [];
const endpointChanged = [];
// 端点状态是**可变**的：切端点后 /status 与 /test 都应看到新值。
const endpointState = {
  current: 'cn',
  upstream: 'https://token.sensenova.cn/v1',
  pinned: false,
  rpmLimit: 2,
  options: [
    { id: 'cn', label: '中国站', baseUrl: 'https://token.sensenova.cn/v1', active: true },
    { id: 'intl', label: '国际站', baseUrl: 'https://token.sensenova.ai/v1', active: false },
  ],
};
const ENDPOINTS = endpointState.options.map((o) => ({ id: o.id, label: o.label, baseUrl: o.baseUrl }));
registerKeyRoutes(ctx, {
  status: {
    pool: () => pool.snapshot(),
    summary: () => pool.summary(),
    catalog: () => ({ source: 'builtin', count: 7, fetchedAt: 0, error: '' }),
    rotations: () => [],
    endpoint: () => ({ baseUrl: 'http://127.0.0.1:54321/v1', port: 54321, apiKey: 'sk-dsh-test-external-key' }),
    models: () => modelRows.map((row) => ({ ...row })),
    providerId: 'sensenova-pool',
    providerName: '商汤日日新（Key 轮换池）',
    get baseUrl() {
      return endpointState.upstream;
    },
    upstreamEndpoint: () => ({
      current: endpointState.current,
      upstream: endpointState.upstream,
      pinned: endpointState.pinned,
      rpmLimit: endpointState.rpmLimit,
      options: ENDPOINTS.map((option) => ({ ...option, active: option.id === endpointState.current })),
    }),
  },
  pool,
  logger: { info() {}, warn() {}, error() {} },
  onKeysChanged: async () => { saved.push(pool.keys()); },
  onModelsChanged: async (disabled) => {
    modelsChanged.push(disabled);
    for (const row of modelRows) row.enabled = !disabled.includes(row.id);
  },
  onModelLimitsChanged: async (id, limits) => {
    limitsChanged.push({ id, limits });
    const row = modelRows.find((r) => r.id === id);
    if (!row) return;
    if (limits.contextWindow === undefined && limits.maxTokens === undefined) {
      row.contextWindow = row.defaults.contextWindow;
      row.maxTokens = row.defaults.maxTokens;
      row.overridden = false;
      return;
    }
    if (limits.contextWindow !== undefined) row.contextWindow = limits.contextWindow;
    if (limits.maxTokens !== undefined) row.maxTokens = limits.maxTokens;
    row.overridden = true;
  },
  onEndpointChanged: async (id) => {
    endpointChanged.push(id);
    const target = ENDPOINTS.find((option) => option.id === id);
    if (target === undefined) throw new Error(`未知端点：${id}`);
    endpointState.current = id;
    endpointState.upstream = target.baseUrl;
    endpointState.rpmLimit = id === 'intl' ? 3 : 2;
    // 换站 = 换模型目录：模拟成国际站只有 sensenova 系列。
    if (id === 'intl') {
      modelRows.length = 0;
      modelRows.push({ id: 'sensenova-6.8-flash', name: 'SenseNova 6.8 Flash', contextWindow: 262144, maxTokens: 65536, defaults: { contextWindow: 262144, maxTokens: 65536 }, overridden: false, enabled: true });
    }
  },
  reload: async () => {},
  fetchCatalog: async () => {},
});

check('挂载了 3 条路由', routes.size === 3, JSON.stringify([...routes.keys()]));

// ---- 起 HTTP 服务，把路由接上 ----------------------------------------------
const server = createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  const handler = routes.get(url.pathname);
  if (!handler) { res.writeHead(404); res.end('{}'); return; }
  handler(req, res);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;
const origin = `http://127.0.0.1:${port}`;

const get = async (path) => {
  const r = await fetch(origin + path);
  return { status: r.status, body: await r.json().catch(() => ({})) };
};
const post = async (path, body, headers = {}) => {
  const r = await fetch(origin + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  return { status: r.status, body: await r.json().catch(() => ({})) };
};

console.log('\n[route] 状态与令牌下发');
let adminKey;
{
  const r = await get('/plugins/dsh-sensenova-pool/status');
  check('GET /status → 200', r.status === 200, String(r.status));
  check('返回池 summary', typeof r.body.summary?.total === 'number');
  check('返回目录信息', r.body.catalog?.source === 'builtin');
  check('下发写入令牌', typeof r.body.adminKey === 'string' && r.body.adminKey.length > 20);
  check('状态里带 keys 数组', Array.isArray(r.body.keys));
  adminKey = r.body.adminKey;
}

console.log('\n[route] 对外接口信息');
{
  const r = await get('/plugins/dsh-sensenova-pool/status');
  check('返回接口地址', r.body.endpoint?.baseUrl === 'http://127.0.0.1:54321/v1', JSON.stringify(r.body.endpoint));
  check('返回端口', r.body.endpoint?.port === 54321, String(r.body.endpoint?.port));
  check('返回对外 API Key', r.body.endpoint?.apiKey === 'sk-dsh-test-external-key', JSON.stringify(r.body.endpoint));
  check('返回模型列表（含可见性）', Array.isArray(r.body.models) && r.body.models.length === 2, JSON.stringify(r.body.models));
  check('模型带 enabled 标记', r.body.models.every((m) => typeof m.enabled === 'boolean'));
}

console.log('\n[route] 写入令牌守卫（回环 ≠ 认证）');
{
  const noToken = await post('/plugins/dsh-sensenova-pool/keys', { action: 'add', keys: 'sk-shouldnotwork123' });
  check('无令牌写入被拒 403', noToken.status === 403, String(noToken.status));
  check('被拒后池仍为空', pool.size === 0);

  const wrong = await post('/plugins/dsh-sensenova-pool/keys', { action: 'add', keys: 'sk-shouldnotwork123' }, { 'x-sensenova-pool-admin': 'wrong' });
  check('错误令牌被拒 403', wrong.status === 403, String(wrong.status));
  check('池仍为空', pool.size === 0);
}

console.log('\n[route] 添加 key（含多把粘贴与清洗）');
{
  const r = await post(
    '/plugins/dsh-sensenova-pool/keys',
    // 故意混入换行、逗号、Bearer 前缀、引号、重复项与过短垃圾
    { action: 'add', keys: 'sk-aaaabbbbccccdddd1111\nsk-eeeeffffgggghhhh2222, Bearer sk-iiiijjjjkkkkllll3333\n"sk-aaaabbbbccccdddd1111"\nxx' },
    { 'x-sensenova-pool-admin': adminKey },
  );
  check('添加成功 200', r.status === 200, JSON.stringify(r.body));
  check('解析出 3 把（去重 + 过滤垃圾）', r.body.added === 3, `added=${r.body.added}`);
  // 粘贴内部的重复在解析阶段就被静默去重了，所以 duplicate 为 0；
  // duplicate 统计的是「池里已有的 key」，下面单独验证。
  check('粘贴内重复被静默去重', r.body.duplicate === 0, `dup=${r.body.duplicate}`);
  check('池里有 3 把', pool.size === 3, `size=${pool.size}`);
  check('变更被持久化回调', saved.length === 1);

  // 关键：响应里绝不能出现明文 key
  const raw = JSON.stringify(r.body);
  check('响应不含明文 key', !raw.includes('sk-aaaabbbbccccdddd1111'), raw.slice(0, 200));
  check('响应含脱敏值', raw.includes('...'), raw.slice(0, 200));

  // 再把池里已有的一把粘一遍：这次应计入 duplicate。
  const again = await post(
    '/plugins/dsh-sensenova-pool/keys',
    { action: 'add', keys: 'sk-aaaabbbbccccdddd1111\nsk-newkey9999888877776666' },
    { 'x-sensenova-pool-admin': adminKey },
  );
  check('已存在的 key 计入 duplicate', again.body.duplicate === 1, `dup=${again.body.duplicate}`);
  check('新增 1 把', again.body.added === 1, `added=${again.body.added}`);
  check('池里有 4 把', pool.size === 4, `size=${pool.size}`);

  // 复原到 3 把，便于后续断言。
  await post('/plugins/dsh-sensenova-pool/keys', { action: 'remove', id: again.body.keys.find((k) => k.key.startsWith('sk-new')).id }, { 'x-sensenova-pool-admin': adminKey });
  check('复原为 3 把', pool.size === 3, `size=${pool.size}`);
}

console.log('\n[route] 列表永远脱敏');
{
  const r = await get('/plugins/dsh-sensenova-pool/keys');
  check('GET /keys → 200', r.status === 200);
  check('返回 3 条', r.body.keys?.length === 3, `n=${r.body.keys?.length}`);
  const raw = JSON.stringify(r.body);
  check('列表不含任何明文 key', !raw.includes('sk-aaaabbbbccccdddd1111') && !raw.includes('sk-eeeeffffgggghhhh2222'), raw.slice(0, 300));
  check('每条都有稳定 id', r.body.keys.every((k) => typeof k.id === 'string' && k.id.length === 12));
  check('每条状态为 healthy', r.body.keys.every((k) => k.status === 'healthy'));
}

console.log('\n[route] 删除与清空');
{
  const list = (await get('/plugins/dsh-sensenova-pool/keys')).body.keys;
  const target = list[0].id;
  const r = await post('/plugins/dsh-sensenova-pool/keys', { action: 'remove', id: target }, { 'x-sensenova-pool-admin': adminKey });
  check('删除成功', r.body.removed === true);
  check('剩 2 把', pool.size === 2, `size=${pool.size}`);

  const clear = await post('/plugins/dsh-sensenova-pool/keys', { action: 'clear' }, { 'x-sensenova-pool-admin': adminKey });
  check('清空成功', clear.body.cleared === true);
  check('池为空', pool.size === 0);
}

console.log('\n[route] 模型可见性');
{
  const noToken = await post('/plugins/dsh-sensenova-pool/keys', { action: 'set-model', id: 'glm-5.2', enabled: false });
  check('无令牌切换模型被拒 403', noToken.status === 403, String(noToken.status));

  const hide = await post('/plugins/dsh-sensenova-pool/keys', { action: 'set-model', id: 'glm-5.2', enabled: false }, { 'x-sensenova-pool-admin': adminKey });
  check('隐藏模型 200', hide.status === 200, JSON.stringify(hide.body));
  check('回调收到「被隐藏」列表', modelsChanged.at(-1)?.join(',') === 'glm-5.2', JSON.stringify(modelsChanged.at(-1)));
  check('响应里 glm-5.2 已隐藏', hide.body.models.find((m) => m.id === 'glm-5.2')?.enabled === false);

  const show = await post('/plugins/dsh-sensenova-pool/keys', { action: 'set-model', id: 'glm-5.2', enabled: true }, { 'x-sensenova-pool-admin': adminKey });
  check('恢复展示 200', show.status === 200, JSON.stringify(show.body));
  check('回调收到空列表', Array.isArray(modelsChanged.at(-1)) && modelsChanged.at(-1).length === 0, JSON.stringify(modelsChanged.at(-1)));

  const unknown = await post('/plugins/dsh-sensenova-pool/keys', { action: 'set-model', id: 'no-such-model', enabled: false }, { 'x-sensenova-pool-admin': adminKey });
  check('未知模型 → 404', unknown.status === 404, String(unknown.status));

  const noId = await post('/plugins/dsh-sensenova-pool/keys', { action: 'set-model' }, { 'x-sensenova-pool-admin': adminKey });
  check('缺 id → 400', noId.status === 400, String(noId.status));
}

console.log('\n[route] 模型窗口/输出上限（issue #4）');
{
  const base = '/plugins/dsh-sensenova-pool/keys';
  const admin = { 'x-sensenova-pool-admin': adminKey };

  const saved1 = await post(base, { action: 'set-model-limits', id: 'deepseek-v4-flash', contextWindow: '2000000', maxTokens: '32000' }, admin);
  check('保存窗口/输出 → 200', saved1.status === 200, JSON.stringify(saved1.body).slice(0, 160));
  const row1 = saved1.body.models?.find((m) => m.id === 'deepseek-v4-flash');
  check('生效值已更新', row1?.contextWindow === 2000000 && row1?.maxTokens === 32000, JSON.stringify(row1));
  check('标记为自定义', row1?.overridden === true, JSON.stringify(row1?.overridden));
  check('默认值保持不变', row1?.defaults?.contextWindow === 1048576, JSON.stringify(row1?.defaults));
  check('回调收到完整值', limitsChanged.at(-1)?.limits?.contextWindow === 2000000, JSON.stringify(limitsChanged.at(-1)));

  const noToken = await post(base, { action: 'set-model-limits', id: 'glm-5.2', contextWindow: '2000000' });
  check('无令牌被拒 403', noToken.status === 403, String(noToken.status));

  const bad = await post(base, { action: 'set-model-limits', id: 'glm-5.2', contextWindow: 'abc' }, admin);
  check('非数字 → 400', bad.status === 400, String(bad.status));

  const tooSmall = await post(base, { action: 'set-model-limits', id: 'glm-5.2', contextWindow: '100' }, admin);
  check('窗口小于 1024 → 400', tooSmall.status === 400, String(tooSmall.status));

  const outTooBig = await post(base, { action: 'set-model-limits', id: 'glm-5.2', contextWindow: '200000', maxTokens: '200000' }, admin);
  check('输出不小于窗口 → 400', outTooBig.status === 400, String(outTooBig.status));

  const unknownModel = await post(base, { action: 'set-model-limits', id: 'no-such-model', contextWindow: '200000' }, admin);
  check('未知模型 → 404', unknownModel.status === 404, String(unknownModel.status));

  // 缩写：1M / 128K（与宿主模型配置页一致）。
  const abbrev = await post(base, { action: 'set-model-limits', id: 'glm-5.2', contextWindow: '2M', maxTokens: '128K' }, admin);
  const rowAbbr = abbrev.body.models?.find((m) => m.id === 'glm-5.2');
  check('2M / 128K 缩写被解析', rowAbbr?.contextWindow === 2097152 && rowAbbr?.maxTokens === 131072, JSON.stringify(rowAbbr));

  const decimal = await post(base, { action: 'set-model-limits', id: 'glm-5.2', contextWindow: '1.5M', maxTokens: '32k' }, admin);
  const rowDec = decimal.body.models?.find((m) => m.id === 'glm-5.2');
  check('小数与大小写都认（1.5M / 32k）', rowDec?.contextWindow === 1572864 && rowDec?.maxTokens === 32768, JSON.stringify(rowDec));

  const spaced = await post(base, { action: 'set-model-limits', id: 'glm-5.2', contextWindow: ' 3 m ', maxTokens: ' 64 K ' }, admin);
  const rowSpaced = spaced.body.models?.find((m) => m.id === 'glm-5.2');
  check('空格随意（3 m / 64 K）', rowSpaced?.contextWindow === 3145728 && rowSpaced?.maxTokens === 65536, JSON.stringify(rowSpaced));

  const badUnit = await post(base, { action: 'set-model-limits', id: 'glm-5.2', contextWindow: '1MB' }, admin);
  check('非法单位（1MB）→ 400', badUnit.status === 400, String(badUnit.status));

  const zeroUnit = await post(base, { action: 'set-model-limits', id: 'glm-5.2', contextWindow: '0K' }, admin);
  check('0K → 400', zeroUnit.status === 400, String(zeroUnit.status));

  const negative = await post(base, { action: 'set-model-limits', id: 'glm-5.2', contextWindow: '-1M' }, admin);
  check('负数 → 400', negative.status === 400, String(negative.status));

  // 复原，避免影响后面的断言。
  await post(base, { action: 'set-model-limits', id: 'glm-5.2', contextWindow: '', maxTokens: '' }, admin);

  // 传回默认值 = 恢复默认（服务端归一成 undefined，不落库）。
  const reset = await post(base, { action: 'set-model-limits', id: 'deepseek-v4-flash', contextWindow: '1048576', maxTokens: '65536' }, admin);
  const row2 = reset.body.models?.find((m) => m.id === 'deepseek-v4-flash');
  check('传回默认值 → 恢复默认', row2?.overridden === false && row2?.contextWindow === 1048576, JSON.stringify(row2));
  check('恢复默认时两字段都未传',
    limitsChanged.at(-1)?.limits?.contextWindow === undefined && limitsChanged.at(-1)?.limits?.maxTokens === undefined,
    JSON.stringify(limitsChanged.at(-1)));
}

console.log('\n[route] 上游端点切换');
{
  const base = '/plugins/dsh-sensenova-pool/keys';
  const admin = { 'x-sensenova-pool-admin': adminKey };

  const initial = await get('/plugins/dsh-sensenova-pool/status');
  check('默认端点是中国站', initial.body.upstreamEndpoint?.current === 'cn', JSON.stringify(initial.body.upstreamEndpoint));
  check('下发两个可选端点', initial.body.upstreamEndpoint?.options?.length === 2, JSON.stringify(initial.body.upstreamEndpoint?.options));
  check('国际站地址是 token.sensenova.ai',
    initial.body.upstreamEndpoint?.options?.some((o) => o.id === 'intl' && o.baseUrl === 'https://token.sensenova.ai/v1'),
    JSON.stringify(initial.body.upstreamEndpoint?.options));
  check('上游地址不是回环地址', initial.body.baseUrl === 'https://token.sensenova.cn/v1', String(initial.body.baseUrl));

  const noToken = await post(base, { action: 'set-endpoint', id: 'intl' });
  check('无令牌切换端点被拒 403', noToken.status === 403, String(noToken.status));
  check('被拒后仍是 cn', endpointChanged.length === 0, JSON.stringify(endpointChanged));

  const unknown = await post(base, { action: 'set-endpoint', id: 'moon' }, admin);
  check('未知端点 → 400', unknown.status === 400, String(unknown.status));
  check('错误信息列出可选项', typeof unknown.body.error === 'string' && unknown.body.error.includes('cn'), String(unknown.body.error));

  const empty = await post(base, { action: 'set-endpoint' }, admin);
  check('缺 id → 400', empty.status === 400, String(empty.status));

  const switched = await post(base, { action: 'set-endpoint', id: 'intl' }, admin);
  check('切换国际站 → 200', switched.status === 200, JSON.stringify(switched.body).slice(0, 200));
  check('回调收到 intl', endpointChanged.at(-1) === 'intl', JSON.stringify(endpointChanged));
  check('响应里当前端点已切换', switched.body.upstreamEndpoint?.current === 'intl', JSON.stringify(switched.body.upstreamEndpoint));
  check('模型目录整批换成国际站', switched.body.models?.length === 1 && switched.body.models[0].id === 'sensenova-6.8-flash',
    JSON.stringify(switched.body.models?.map((m) => m.id)));
  check('RPM 额度随端点调整', switched.body.upstreamEndpoint?.rpmLimit === 3, String(switched.body.upstreamEndpoint?.rpmLimit));

  const after = await get('/plugins/dsh-sensenova-pool/status');
  check('/status 反映新端点', after.body.upstreamEndpoint?.current === 'intl', JSON.stringify(after.body.upstreamEndpoint));
  check('/status 的上游地址已更新', after.body.baseUrl === 'https://token.sensenova.ai/v1', String(after.body.baseUrl));

  // 切回中国站，方便后续断言（并顺带验证可来回切）。
  await post(base, { action: 'set-endpoint', id: 'cn' }, admin);
  const back = await get('/plugins/dsh-sensenova-pool/status');
  check('可以切回中国站', back.body.upstreamEndpoint?.current === 'cn', JSON.stringify(back.body.upstreamEndpoint));
  // 模型目录在测试桩里只重置不回填，这里补回后续用例需要的两条。
  modelRows.length = 0;
  modelRows.push(
    { id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash', contextWindow: 1048576, maxTokens: 65536, defaults: { contextWindow: 1048576, maxTokens: 65536 }, overridden: false, enabled: true },
    { id: 'glm-5.2', name: 'GLM-5.2', contextWindow: 1048576, maxTokens: 131072, defaults: { contextWindow: 1048576, maxTokens: 131072 }, overridden: false, enabled: true },
  );
}

console.log('\n[route] 未知操作与错误处理');
{
  const r = await post('/plugins/dsh-sensenova-pool/keys', { action: 'nonsense' }, { 'x-sensenova-pool-admin': adminKey });
  check('未知 action → 400', r.status === 400, String(r.status));
  check('错误信息可读', typeof r.body.error === 'string');

  const empty = await post('/plugins/dsh-sensenova-pool/keys', { action: 'add', keys: '' }, { 'x-sensenova-pool-admin': adminKey });
  check('空输入 → 400', empty.status === 400, String(empty.status));

  const badMethod = await fetch(origin + '/plugins/dsh-sensenova-pool/keys', { method: 'DELETE' });
  check('不支持的 method → 405', badMethod.status === 405, String(badMethod.status));
  await badMethod.text();
}

console.log('\n[route] 非回环 Host 被拒（DNS rebinding 防护）');
{
  const { request } = await import('node:http');
  const status = await new Promise((resolve) => {
    const req = request(
      { host: '127.0.0.1', port, path: '/plugins/dsh-sensenova-pool/keys', method: 'GET', headers: { host: 'evil.example.com' } },
      (r) => { r.resume(); resolve(r.statusCode); },
    );
    req.on('error', () => resolve(-1));
    req.end();
  });
  check('恶意 Host → 403', status === 403, String(status));
}

console.log('\n[route] 测试单把 key（无有效 key 时应给出可读错误）');
{
  // 先放一把格式合法但无效的 key。
  await post('/plugins/dsh-sensenova-pool/keys', { action: 'add', keys: 'sk-0000000000000000000000000000' }, { 'x-sensenova-pool-admin': adminKey });
  const list = (await get('/plugins/dsh-sensenova-pool/keys')).body.keys;
  const r = await post('/plugins/dsh-sensenova-pool/test', { id: list[0].id }, { 'x-sensenova-pool-admin': adminKey });
  check('测试接口返回 200（结果在 body 里）', r.status === 200, String(r.status));
  check('ok 为 false（key 无效）', r.body.ok === false, JSON.stringify(r.body));
  check('带可读失败信息', typeof r.body.message === 'string' && r.body.message.length > 0, JSON.stringify(r.body));

  const missing = await post('/plugins/dsh-sensenova-pool/test', { id: 'doesnotexist' }, { 'x-sensenova-pool-admin': adminKey });
  check('不存在的 id → 404', missing.status === 404, String(missing.status));
}

server.close();
console.log(`\n=== ${pass} passed, ${fail} failed ===\n`);
process.exit(fail === 0 ? 0 : 1);
