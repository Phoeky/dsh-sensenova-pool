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
registerKeyRoutes(ctx, {
  status: {
    pool: () => pool.snapshot(),
    summary: () => pool.summary(),
    catalog: () => ({ source: 'builtin', count: 7, fetchedAt: 0, error: '' }),
    rotations: () => [],
    providerId: 'sensenova-pool',
    providerName: '商汤日日新（Key 轮换池）',
    baseUrl: 'https://token.sensenova.cn/v1',
  },
  pool,
  logger: { info() {}, warn() {}, error() {} },
  onKeysChanged: async () => { saved.push(pool.keys()); },
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
