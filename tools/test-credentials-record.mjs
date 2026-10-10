/**
 * 回归测试：插件写进凭据库的记录必须符合 credentials-local 的 schema。
 *
 * 背景（真实事故）：saveKeys() 曾经用 `kind: 'api-key'` + `payload` 写记录。
 * credentials-local 对记录做白名单校验（assertFields），两种标签允许的字段是
 * **互斥**的：
 *
 *   kind: api-key  →  只认 kind / key / env
 *   kind: grant    →  只认 kind / payload
 *
 * 而写入路径的 assertStorableApiKey 只检查 key 是否为空、env 值是否为空，
 * **不查未知字段**，于是坏记录顺利落盘。下次启动时 credentials-local 在
 * loadInitial 阶段解析失败 → credentials 插件激活失败 → 整个 dsh 启动中止
 * （弹「The application could not start or stopped unexpectedly」）。
 *
 * 一条记录写错就能锁死整个应用，所以这里放一个「按 schema 校验」的凭据服务桩，
 * 把「填 key → 落盘」这条路径焊死：写出的记录一旦不符合 schema，测试直接失败。
 *
 * 用法：node --import ./tools/stub-loader.mjs tools/test-credentials-record.mjs
 */
import { createServer } from 'node:http';

/**
 * credentials-local 的字段白名单。
 * 真源：dsh-credentials-local/lib/index.js 的 parseRecord()。
 */
const ALLOWED_FIELDS = {
  'api-key': ['kind', 'key', 'env'],
  grant: ['kind', 'payload'],
};

const RECORD_ID = 'dsh-sensenova-pool/keys';

let pass = 0, fail = 0;
const check = (n, c, d = '') => { c ? (pass++, console.log(`  PASS  ${n}`)) : (fail++, console.log(`  FAIL  ${n}${d ? ' — ' + d : ''}`)); };

globalThis.__capture = { adapters: [], providers: [] };

/** 复刻 parseRecord：标签未知、字段越界、grant 缺 payload 都要拒。 */
function validateRecord(key, record) {
  if (key !== RECORD_ID) throw new Error(`记录 id 不对：${key}`);
  if (record === null || typeof record !== 'object' || Array.isArray(record)) throw new Error('记录必须是 mapping');
  const allowed = ALLOWED_FIELDS[record.kind];
  if (allowed === undefined) throw new Error(`未知 kind ${JSON.stringify(record.kind)}`);
  for (const field of Object.keys(record)) {
    if (!allowed.includes(field)) throw new Error(`记录 "${key}" 有未知字段 "${field}"`);
  }
  if (record.kind === 'grant' && !('payload' in record)) throw new Error(`记录 "${key}" 缺 payload`);
  if (record.kind === 'api-key' && record.key !== undefined && record.key.length === 0) throw new Error('key 不能为空字符串');
}

// ---- 假的 cordis ctx：credentials + webServer ------------------------------
const routes = new Map();
const written = [];
const warnings = [];
let validationError = '';

const state = { effects: [], logs: { info: [], warn: [], error: [] }, services: {} };
const ctx = {
  logger: {
    info: (m) => state.logs.info.push(m),
    warn: (m) => { state.logs.warn.push(m); warnings.push(m); },
    error: (m) => state.logs.error.push(m),
  },
  effect: (fn) => { state.effects.push(fn()); },
  emit: () => {},
  on: () => {},
  get: (name) => state.services[name],
  inject: (deps, cb) => {
    const present = deps.every((d) => state.services[d] !== undefined);
    if (!present) return;
    const child = Object.create(ctx);
    for (const d of deps) child[d] = state.services[d];
    cb(child);
  },
  llm: {
    registerAdapter: () => Object.assign(() => {}, { replace: () => {} }),
  },
};

state.services.credentials = {
  async readRecord() { return undefined; },
  async modifyRecord(key, updater) {
    const record = await updater();
    // 写入路径不校验未知字段（这正是事故的成因），这里补上校验。
    try {
      validateRecord(key, record);
    } catch (error) {
      validationError = error.message;
      throw error;
    }
    written.push({ key, record });
  },
};

state.services.webServer = {
  register({ path, handler }) {
    routes.set(path, handler);
    return () => routes.delete(path);
  },
};

// ---- 真实调用 apply() ------------------------------------------------------
const { apply } = await import('../lib/index.js');
apply(ctx, {});
await new Promise((r) => setTimeout(r, 400));

check('插件完成启动，无错误日志', state.logs.error.length === 0, JSON.stringify(state.logs.error));
check('挂载了 /keys 路由', routes.has('/plugins/dsh-sensenova-pool/keys'));

// ---- 起 HTTP 服务，走「填 key → 落盘」的真实路径 ---------------------------
const server = createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  const handler = routes.get(url.pathname);
  if (!handler) { res.writeHead(404); res.end('{}'); return; }
  handler(req, res);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const origin = `http://127.0.0.1:${server.address().port}`;

const status = await (await fetch(`${origin}/plugins/dsh-sensenova-pool/status`)).json();
const adminKey = status.adminKey;
check('从 /status 拿到写入令牌', typeof adminKey === 'string' && adminKey.length > 20);

const addRes = await fetch(`${origin}/plugins/dsh-sensenova-pool/keys`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-sensenova-pool-admin': adminKey },
  body: JSON.stringify({ action: 'add', keys: 'sk-credentialsrecord01\nsk-credentialsrecord02' }),
});
check('POST /keys → 200（落盘未抛错）', addRes.status === 200, `status=${addRes.status}`);
const addBody = await addRes.json();
check('两把 key 都已加入', addBody.added === 2, JSON.stringify(addBody));

// ---- 断言：写出的记录符合 credentials-local 的 schema ----------------------
check('确实调用了 modifyRecord 落盘', written.length === 1, `count=${written.length}`);
check('记录 id 为 <owner>/<id> 形式', written[0]?.key === RECORD_ID, written[0]?.key);
check('记录通过了 schema 校验', validationError === '', validationError);

const record = written[0]?.record;
check('kind 是 grant（唯一允许任意 payload 的标签）', record?.kind === 'grant', JSON.stringify(record?.kind));
check('字段只有 kind / payload', JSON.stringify(Object.keys(record ?? {}).sort()) === '["kind","payload"]', JSON.stringify(Object.keys(record ?? {})));
check('payload.keys 保存了 2 把 key', Array.isArray(record?.payload?.keys) && record.payload.keys.length === 2, JSON.stringify(record?.payload));

// 反向保险：如果哪天有人改回 api-key + payload，上面的 validateRecord 必须报错。
let rejectsBadShape = false;
try {
  validateRecord(RECORD_ID, { kind: 'api-key', payload: { keys: ['sk-x'] } });
} catch {
  rejectsBadShape = true;
}
check('校验桩能识破 api-key + payload 的坏形状', rejectsBadShape);

check('落盘过程没有 warn 日志', !warnings.some((m) => m.includes('keys route')), JSON.stringify(warnings));

await new Promise((r) => server.close(r));
await state.effects[0]?.();

console.log(`\n=== ${pass} passed, ${fail} failed ===\n`);
process.exit(fail === 0 ? 0 : 1);
