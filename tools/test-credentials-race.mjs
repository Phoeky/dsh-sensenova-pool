/**
 * 回归测试：issue #1 —— 启动期凭据竞态导致「重启电脑后 Key 池为空」。
 *
 * 真实成因（已用真实 cordis 验证，见 tools/repro-race.mjs / repro-inject.mjs）：
 * 本插件只 `inject: ['llm']`，与 `credentials` 之间**没有顺序保证**。cordis 的
 * `Service` 在构造函数里就 `provide()`，但 `Service.init`（credentials-local 里
 * 负责 `loadInitial()` 读 `.credentials.yaml`）要更晚才跑完：
 *
 *   1. **已构造** —— `ctx.get('credentials')` 严格读取返回 undefined（fiber 未 ACTIVE）；
 *   2. **已就绪** —— `Service.init` 结束，内存快照已填充，严格读取才返回服务实例。
 *
 * 旧实现在启动块里只 `await loadKeys()` 一次。冷启动磁盘 IO 慢时它读到空快照 →
 * 池子为 0，且此后再无补载机制（`credentials/record-updated` 只在运行期写入时触发，
 * 覆盖不到启动装载）—— 于是「重启电脑后 Key 池为空」。
 *
 * 本测试用桩件复刻 cordis 的这套语义：凭据服务**先注册、后就绪**，并断言插件在
 * 服务就绪后确实把 key 装载进来。若哪天有人把 `ctx.inject(['credentials'])` 改回
 * 「启动时读一次就算」，这个测试会立刻失败。
 *
 * 用法：node --import ./tools/stub-loader.mjs tools/test-credentials-race.mjs
 */
let pass = 0;
let fail = 0;
const check = (n, c, d = '') => {
  c ? (pass++, console.log(`  PASS  ${n}`)) : (fail++, console.log(`  FAIL  ${n}${d ? ' — ' + d : ''}`));
};

globalThis.__capture = { adapters: [], providers: [] };

const RECORD_ID = 'dsh-sensenova-pool/keys';
const STORED_KEYS = ['sk-racekey0000000001', 'sk-racekey0000000002'];

/**
 * 假 ctx，刻意复刻 cordis 的「已注册 ≠ 已就绪」语义。
 *
 * - `get(name)`（严格）在服务就绪前返回 undefined —— 这正是旧实现读不到 key 的原因；
 * - `get(name, false)`（宽松）在已注册时就返回实例 —— 用于区分「在加载」与「不存在」；
 * - `inject(deps, cb)` 在依赖**就绪**时才回调，复刻 `ctx.inject` 的真实行为。
 */
function makeCtx({ withCredentials = true } = {}) {
  const state = {
    effects: [],
    logs: { info: [], warn: [], error: [] },
    /** 服务对象已注册（构造完成）。 */
    registered: withCredentials,
    /** 服务已就绪（init 完成、快照可用）。 */
    ready: false,
    pendingInject: [],
    recordHandlers: [],
    records: new Map(),
    /** 插件挂载的 Web 路由（path → handler）。 */
    routes: new Map(),
  };

  const credentials = {
    async readRecord(key) {
      return state.records.get(key);
    },
    async listRecords() {
      return [...state.records.keys()];
    },
    async modifyRecord(key, mutate) {
      state.records.set(key, await mutate(state.records.get(key)));
    },
  };

  const services = {
    credentials,
    webServer: {
      register({ path, handler }) {
        state.routes.set(path, handler);
        return () => state.routes.delete(path);
      },
    },
  };

  /** 依赖全部就绪时，回调才会触发（复刻 cordis 的 ctx.inject）。 */
  const isServiceReady = (name) => {
    if (name === 'credentials') return state.registered && state.ready;
    if (name === 'webServer') return true;
    return false;
  };

  const firePendingInject = () => {
    for (let i = state.pendingInject.length - 1; i >= 0; i -= 1) {
      const { deps, cb } = state.pendingInject[i];
      if (!deps.every(isServiceReady)) continue;
      state.pendingInject.splice(i, 1);
      const child = Object.create(ctx);
      for (const d of deps) child[d] = services[d];
      cb(child);
    }
  };

  const ctx = {
    logger: {
      info: (m) => state.logs.info.push(m),
      warn: (m) => state.logs.warn.push(m),
      error: (m) => state.logs.error.push(m),
    },
    effect: (fn) => {
      state.effects.push(fn());
    },
    emit: () => {},
    on: (name, handler) => {
      if (name === 'credentials/record-updated') state.recordHandlers.push(handler);
    },
    get: (name, strict = true) => {
      if (name === 'credentials') {
        if (!state.registered) return undefined;
        // 严格读取：只有就绪后才可见（与 cordis ReflectService.get 一致）。
        return strict ? (state.ready ? credentials : undefined) : credentials;
      }
      if (name === 'webServer') return services.webServer;
      return undefined;
    },
    inject: (deps, cb) => {
      state.pendingInject.push({ deps, cb });
      firePendingInject();
    },
    llm: {
      registerAdapter: () => Object.assign(() => {}, { replace: () => {} }),
    },
  };

  /** 模拟 credentials-local 的 loadInitial() 完成。 */
  state.becomeReady = (keys = STORED_KEYS) => {
    state.records.set(RECORD_ID, { kind: 'grant', payload: { keys } });
    state.ready = true;
    firePendingInject();
  };

  return { ctx, state };
}

const { apply } = await import('../lib/index.js');

// ---------------------------------------------------------------------------
console.log('\n[race] 凭据服务先注册、后就绪：就绪后必须补载 key');
{
  const { ctx, state } = makeCtx();
  apply(ctx, {});
  await new Promise((r) => setTimeout(r, 300));

  // 就绪之前：插件不该误报「池为空」——那是还没读到，不是真的没有 key。
  const prematureHint = state.logs.info.find((m) => m.includes('key 池为空'));
  check('服务仍在加载时不误报「池为空」', prematureHint === undefined, JSON.stringify(state.logs.info));

  // 模拟磁盘 IO 慢：此刻才把快照填好并宣告就绪。
  state.becomeReady();
  await new Promise((r) => setTimeout(r, 200));

  const loaded = state.logs.info.find((m) => m.includes('已装载'));
  check('服务就绪后自动补载 key（核心回归点）', typeof loaded === 'string', JSON.stringify(state.logs.info));
  check('装载了 2 把 key', typeof loaded === 'string' && loaded.includes('2'), loaded);
  check('没有错误日志', state.logs.error.length === 0, JSON.stringify(state.logs.error));

  for (const d of state.effects) await d?.();
}

// ---------------------------------------------------------------------------
console.log('\n[race] 凭据服务已就绪时（热重启）：立即装载');
{
  const { ctx, state } = makeCtx();
  // 先就绪，再启动插件 —— 对应「重启 DSH 且服务已就绪」的常见情况。
  state.becomeReady();
  apply(ctx, {});
  await new Promise((r) => setTimeout(r, 300));

  const loaded = state.logs.info.find((m) => m.includes('已装载'));
  check('就绪状态下启动即装载 2 把 key', typeof loaded === 'string' && loaded.includes('2'), JSON.stringify(state.logs.info));
  for (const d of state.effects) await d?.();
}

// ---------------------------------------------------------------------------
console.log('\n[race] 宿主没有凭据服务：给出可操作提示，且不挂起');
{
  const { ctx, state } = makeCtx({ withCredentials: false });
  apply(ctx, {});
  await new Promise((r) => setTimeout(r, 300));

  const hint = state.logs.info.find((m) => m.includes('设置'));
  check('提示用户去设置页填 key', typeof hint === 'string', JSON.stringify(state.logs.info));
  check('无错误日志', state.logs.error.length === 0, JSON.stringify(state.logs.error));
  for (const d of state.effects) await d?.();
}

// ---------------------------------------------------------------------------
console.log('\n[race] 快照为空（用户真的没填过 key）：正常提示，不误判');
{
  const { ctx, state } = makeCtx();
  state.becomeReady([]); // 就绪，但记录里没有 key
  apply(ctx, {});
  await new Promise((r) => setTimeout(r, 300));

  const hint = state.logs.info.find((m) => m.includes('key 池为空'));
  check('提示用户填 key', typeof hint === 'string', JSON.stringify(state.logs.info));
  check('没有错误日志', state.logs.error.length === 0, JSON.stringify(state.logs.error));
  for (const d of state.effects) await d?.();
}

// ---------------------------------------------------------------------------
console.log('\n[race] 首次装载完成前写入：不得用空池覆盖掉已存的 key');
{
  const { createServer } = await import('node:http');
  const { ctx, state } = makeCtx();
  apply(ctx, {});
  await new Promise((r) => setTimeout(r, 300));

  // 此刻凭据服务仍「在加载」、池子还是空的 —— 模拟用户手快，启动没完就点「添加 Key」。
  // 这一路会走到插件自己的 saveKeys()：它把 pool.keys() **整体覆盖**写回记录。
  // 若不等首次权威装载，磁盘上原有的 2 把 key 会被这次写入静默抹掉。
  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const handler = state.routes.get(url.pathname);
    if (!handler) {
      res.writeHead(404);
      res.end('{}');
      return;
    }
    void handler(req, res);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const origin = `http://127.0.0.1:${server.address().port}`;

  const status = await (await fetch(`${origin}/plugins/dsh-sensenova-pool/status`)).json();

  // 发出写入请求后，让凭据服务在片刻之后就绪 —— 这就是真实的冷启动：用户点
  // 「添加 Key」时快照还在读盘，几十毫秒后才可用。写入必须等它就绪，然后把
  // 「磁盘上原有的 2 把 + 刚加的 1 把」一起写回，而不是用空池覆盖。
  const addPromise = fetch(`${origin}/plugins/dsh-sensenova-pool/keys`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-sensenova-pool-admin': status.adminKey },
    body: JSON.stringify({ action: 'add', keys: 'sk-racekey0000000003' }),
  });
  await new Promise((r) => setTimeout(r, 50));
  state.becomeReady();
  const addRes = await addPromise;
  check('启动期写入返回 200', addRes.status === 200, `status=${addRes.status}`);

  // 关键断言：磁盘上原有的 2 把 + 新加的 1 把都在，没有被空池覆盖。
  const stored = state.records.get(RECORD_ID)?.payload?.keys ?? [];
  check('原有 2 把 key 未被空池覆盖', stored.includes(STORED_KEYS[0]) && stored.includes(STORED_KEYS[1]), JSON.stringify(stored));
  check('新加的 key 已落盘', stored.includes('sk-racekey0000000003'), JSON.stringify(stored));
  check('记录共 3 把 key', stored.length === 3, JSON.stringify(stored));

  server.closeAllConnections();
  await new Promise((r) => server.close(r));
  for (const d of state.effects) await d?.();
}

console.log(`\n=== ${pass} passed, ${fail} failed ===\n`);
process.exitCode = fail === 0 ? 0 : 1;
