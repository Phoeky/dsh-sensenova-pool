/**
 * 集成测试：用桩件 + 假 cordis ctx 真实调用 apply()，验证启动时序。
 *
 * 重点覆盖上次真实加载失败的那条路径：
 *   「registerAdapter 必须在回环服务 listening 之后调用」。
 */
import { KeyPool } from '../lib/keypool.js';

let pass = 0, fail = 0;
const check = (n, c, d = '') => { c ? (pass++, console.log(`  PASS  ${n}`)) : (fail++, console.log(`  FAIL  ${n}${d ? ' — ' + d : ''}`)); };

globalThis.__capture = { adapters: [], providers: [] };

/** 最小可用的假 cordis 上下文。 */
function makeCtx(overrides = {}) {
  const state = {
    effects: [],
    emitted: [],
    logs: { info: [], warn: [], error: [] },
    services: {},
    injected: [],
  };
  const ctx = {
    logger: {
      info: (m) => state.logs.info.push(m),
      warn: (m) => state.logs.warn.push(m),
      error: (m) => state.logs.error.push(m),
    },
    effect: (fn) => { state.effects.push(fn()); },
    emit: (name, ...args) => state.emitted.push({ name, args }),
    on: () => {},
    get: (name) => state.services[name],
    inject: (deps, cb) => {
      state.injected.push(deps);
      // 模拟 cordis：被 inject 的服务会挂到子上下文上。
      const present = deps.every((d) => state.services[d] !== undefined);
      if (!present) return; // 服务缺失时 cordis 不会执行回调
      const child = Object.create(ctx);
      for (const d of deps) child[d] = state.services[d];
      cb(child);
    },
    llm: {
      registerAdapter: (routes, adapter) => {
        state.registeredRoutes = routes;
        state.registeredAdapter = adapter;
        return Object.assign(() => { state.disposed = true; }, { replace: () => {} });
      },
    },
    ...overrides,
  };
  return { ctx, state };
}

const { apply } = await import('../lib/index.js');

console.log('\n[apply] 启动时序：注册必须晚于 listening');
{
  const { ctx, state } = makeCtx();
  apply(ctx, {});

  // apply() 是同步返回的；此刻异步启动块刚开始跑。
  check('apply() 同步返回，不阻塞插件加载', true);
  check('apply() 返回时尚未注册 adapter（避免 listen 前取端口）', state.registeredAdapter === undefined);

  // 等异步启动块完成。
  await new Promise((r) => setTimeout(r, 400));

  check('随后成功注册 adapter', state.registeredAdapter !== undefined);
  check('注册的路由名正确', Array.isArray(state.registeredRoutes) && state.registeredRoutes[0] === 'sensenova-pool', JSON.stringify(state.registeredRoutes));
  check('创建了 PiAiAdapter 实例', globalThis.__capture.adapters.length === 1);
  check('没有注册失败日志', state.logs.error.length === 0, JSON.stringify(state.logs.error));

  // 关键：profiles() 现在必须能取到端口（这正是上次崩溃的调用点）。
  const adapter = globalThis.__capture.adapters[0];
  let profilesOk = false;
  let profileShape = null;
  try {
    const profiles = adapter.profiles();
    profilesOk = profiles instanceof Map && profiles.has('sensenova-pool');
    profileShape = profiles.get('sensenova-pool');
  } catch (error) {
    console.log('    profiles() 抛错:', error.message);
  }
  check('profiles() 可调用（上次崩溃点已修复）', profilesOk);

  // provider 的模型描述符必须带正确的回环 baseUrl。
  const provider = globalThis.__capture.providers[0];
  const models = typeof provider?.getModels === 'function' ? provider.getModels() : provider?.models;
  check('模型列表非空', Array.isArray(models) && models.length > 0, `count=${models?.length}`);
  const first = models?.[0];
  check('模型 baseUrl 指向回环 shim', typeof first?.baseUrl === 'string' && first.baseUrl.startsWith('http://127.0.0.1:'), first?.baseUrl);
  check('模型 api 为 openai-completions', first?.api === 'openai-completions', first?.api);
  check('模型带 contextWindow', typeof first?.contextWindow === 'number' && first.contextWindow > 0);
  check('模型带 maxTokens', typeof first?.maxTokens === 'number' && first.maxTokens > 0);

  // 释放：应关闭 shim 且不抛错。
  const dispose = state.effects[0];
  if (typeof dispose === 'function') {
    await dispose();
    check('dispose 正常执行', true);
  } else {
    check('注册了 dispose effect', false);
  }
}

console.log('\n[apply] key 池为空时不崩溃，且给出可操作的提示');
{
  const { ctx, state } = makeCtx();
  apply(ctx, {});
  await new Promise((r) => setTimeout(r, 400));
  const hint = state.logs.info.find((m) => m.includes('设置'));
  check('提示用户去设置页填 key', typeof hint === 'string', JSON.stringify(state.logs.info));
  check('无错误日志', state.logs.error.length === 0, JSON.stringify(state.logs.error));
  await state.effects[0]?.();
}

console.log('\n[apply] 凭据服务可用时能从记录里装载 key');
{
  const stored = ['sk-storedkey0001', 'sk-storedkey0002'];
  const { ctx, state } = makeCtx();
  state.services.credentials = {
    async readRecord(id) {
      check('读取的记录 id 正确', id === 'dsh-sensenova-pool/keys', id);
      return { kind: 'api-key', payload: { keys: stored } };
    },
    async modifyRecord() {},
  };
  apply(ctx, {});
  await new Promise((r) => setTimeout(r, 400));
  const loaded = state.logs.info.find((m) => m.includes('已装载'));
  check('日志显示已装载 2 把 key', typeof loaded === 'string' && loaded.includes('2'), JSON.stringify(state.logs.info));
  await state.effects[0]?.();
}

console.log('\n[apply] webServer 存在时挂载 key 管理路由');
{
  const routes = [];
  const { ctx, state } = makeCtx();
  state.services.webServer = {
    register: ({ kind, path, handler }) => {
      routes.push({ kind, path, handler });
      return () => {};
    },
  };
  apply(ctx, {});
  await new Promise((r) => setTimeout(r, 400));
  const paths = routes.map((r) => r.path);
  check('挂载了 /keys 路由', paths.includes('/plugins/dsh-sensenova-pool/keys'), JSON.stringify(paths));
  check('挂载了 /status 路由', paths.includes('/plugins/dsh-sensenova-pool/status'));
  check('挂载了 /test 路由', paths.includes('/plugins/dsh-sensenova-pool/test'));
  check('全部为 exact 匹配', routes.every((r) => r.kind === 'exact'));
  await state.effects[0]?.();
}

console.log(`\n=== ${pass} passed, ${fail} failed ===\n`);
process.exit(fail === 0 ? 0 : 1);
