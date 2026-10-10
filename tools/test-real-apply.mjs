/**
 * 用 **DSH 真实 SDK** 跑通 apply() 全流程（不是桩件）。
 *
 * 这是最有说服力的离线验证：把真实的 PiAiAdapter / createProvider /
 * schemastery / resolveRetryPolicy 装进一个假 cordis ctx，然后调用本插件的
 * apply()，检查它是否真的注册了 provider、模型描述符是否合法、
 * 以及 shim 是否真的在回环上可用。
 *
 * 用 Electron 运行（app.asar 只有 Electron 能读）：
 *   ELECTRON_RUN_AS_NODE=1 "DeepSeek Harness.exe" tools/test-real-apply.mjs <key>
 */
const asarRoot = process.env.DSH_ASAR ?? "C:/Users/X/AppData/Local/Programs/DeepSeek Harness/resources/app.asar";
const mods = `${asarRoot}/dsh/node_modules`;

let pass = 0, fail = 0;
const check = (n, c, d = '') => { c ? (pass++, console.log(`  PASS  ${n}`)) : (fail++, console.log(`  FAIL  ${n}${d ? ' — ' + d : ''}`)); };

// ---- 把真实 SDK 挂到 import 解析路径上 -------------------------------------
// lib/index.js 里是裸包名 import；这里用 module.register 的解析钩子把它们
// 指到 asar 里的真实文件，从而无需改动插件代码即可加载真实 SDK。
const { register } = await import('node:module');
const { pathToFileURL } = await import('node:url');
const { writeFileSync, mkdirSync } = await import('node:fs');

/** 仓库内相对路径（基于本文件位置，避免硬编码绝对路径）。 */
function repoPath(rel) {
  return new URL('../' + rel, import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
}


const hookDir = repoPath('.ref/hooks');
mkdirSync(hookDir, { recursive: true });
const map = {
  '@deepseek-ai/schemastery': `${mods}/@deepseek-ai/schemastery/lib/index.mjs`,
  '@deepseek-ai/dsh-llm-pi-ai': `${mods}/@deepseek-ai/dsh-llm-pi-ai/lib/index.js`,
  '@deepseek-ai/dsh-llm': `${mods}/@deepseek-ai/dsh-llm/lib/index.js`,
  '@earendil-works/pi-ai': `${mods}/@earendil-works/pi-ai/dist/index.js`,
  '@earendil-works/pi-ai/api/openai-completions.lazy': `${mods}/@earendil-works/pi-ai/dist/api/openai-completions.lazy.js`,
};
const hookPath = `${hookDir}/real-hook.mjs`;
writeFileSync(hookPath, `
const MAP = ${JSON.stringify(map, null, 2)};
export async function resolve(specifier, context, next) {
  const hit = MAP[specifier];
  if (hit) return { url: 'file:///' + hit, shortCircuit: true };
  return next(specifier, context);
}
`, 'utf8');
register(pathToFileURL(hookPath).href);

console.log('\n[real-apply] 用真实 DSH SDK 调用本插件的 apply()');

const capture = { adapters: [], providers: [], registered: undefined, logs: [] };

function makeCtx() {
  const state = { effects: [], services: {}, emitted: [] };
  const ctx = {
    logger: {
      info: (m) => { capture.logs.push(`info: ${m}`); },
      warn: (m) => { capture.logs.push(`warn: ${m}`); },
      error: (m) => { capture.logs.push(`error: ${m}`); },
    },
    effect: (fn) => { state.effects.push(fn()); },
    emit: (name) => state.emitted.push(name),
    on: () => {},
    get: (n) => state.services[n],
    inject: (deps, cb) => {
      if (!deps.every((d) => state.services[d] !== undefined)) return;
      const child = Object.create(ctx);
      for (const d of deps) child[d] = state.services[d];
      cb(child);
    },
    llm: {
      registerAdapter: (routes, adapter) => {
        capture.registered = routes;
        capture.adapters.push(adapter);
        return Object.assign(() => {}, { replace: () => {} });
      },
    },
  };
  return { ctx, state };
}

const keys = process.argv.slice(2).filter((a) => !a.startsWith('-'));
const { apply } = await import(pathToFileURL(repoPath('lib/index.js')).href);

const { ctx, state } = makeCtx();
// 提供凭据服务，让插件能装载 key（模拟 DSH 的 credentials 记录）。
state.services.credentials = {
  async readRecord(id) {
    return { kind: 'grant', payload: { keys } };
  },
  async modifyRecord() {},
};

apply(ctx, {});
check('apply() 同步返回', true);

// 等异步启动块（listen + 注册 + 装载 key）完成。
await new Promise((r) => setTimeout(r, 1200));

const errors = capture.logs.filter((l) => l.startsWith('error'));
check('无 error 日志', errors.length === 0, JSON.stringify(errors));
check('注册了 provider 路由', Array.isArray(capture.registered) && capture.registered[0] === 'sensenova-pool', JSON.stringify(capture.registered));
check('创建了真实 PiAiAdapter 实例', capture.adapters.length === 1, `n=${capture.adapters.length}`);

const adapter = capture.adapters[0];

// ---- 真实 adapter 的只读接口必须可用 ---------------------------------------
try {
  const info = adapter.providerInfo('sensenova-pool');
  check('providerInfo 可用', info?.id === 'sensenova-pool', JSON.stringify(info));
} catch (e) { check('providerInfo 可用', false, e.message.slice(0, 160)); }

let models = [];
try {
  models = await adapter.listModels('sensenova-pool');
  check('listModels 返回模型（profile 形状被真实 SDK 接受）', Array.isArray(models) && models.length > 0, `n=${models?.length}`);
  console.log(`    模型: ${models.map((m) => m.id).join(', ')}`);
} catch (e) { check('listModels 返回模型', false, e.message.slice(0, 200)); }

// ---- 模型能力解析（真实 SDK 会校验 contextWindow 等字段） ------------------
try {
  const resolved = await adapter.resolveModel('sensenova-pool', models[0]?.id ?? 'deepseek-v4-flash');
  check('resolveModel 返回上下文窗口', typeof resolved?.context?.contextWindow === 'number' && resolved.context.contextWindow > 0, JSON.stringify(resolved?.context));
  check('resolveModel 返回 provider/model', resolved?.provider === 'sensenova-pool' && typeof resolved?.id === 'string');
} catch (e) { check('resolveModel 可用', false, e.message.slice(0, 200)); }

// ---- prepareCall 是 DSH 真正发请求前的路径 ---------------------------------
try {
  const prepared = await adapter.prepareCall('sensenova-pool', models[0]?.id ?? 'deepseek-v4-flash');
  check('prepareCall 返回 stream 方法', typeof prepared?.stream === 'function');
  // PreparedAdapterCall 只有 { model, stream }；retryPolicy 在 LlmRuntime 的
  // PreparedLlmCall 上，由 providerRetryPolicy 提供（下面单独断言）。
  check('prepareCall 带已解析的 model', prepared?.model !== undefined && typeof prepared.model.context?.contextWindow === 'number', JSON.stringify(prepared?.model?.context));
} catch (e) { check('prepareCall 可用', false, e.message.slice(0, 200)); }

// ---- 真实 SDK 的 resolveRetryPolicy 结果被正确挂上 -------------------------
try {
  const policy = adapter.providerRetryPolicy('sensenova-pool');
  check('providerRetryPolicy 可用', policy !== undefined && typeof policy.mode === 'string', JSON.stringify(policy));
  check('RATE_LIMIT 在可重试码里（503 会被 DSH 重试）', policy.retryableCodes.includes('RATE_LIMIT'), JSON.stringify(policy.retryableCodes));
  check('SERVER 在可重试码里（我们的 503 会退避重试）', policy.retryableCodes.includes('SERVER'));
} catch (e) { check('providerRetryPolicy 可用', false, e.message.slice(0, 200)); }

// ---- 关键：真的通过 adapter 发一次流式请求，走完整真实路径 ----------------
if (keys.length > 0) {
  console.log('\n[real-apply] 通过真实 PiAiAdapter 发一次真实请求');
  try {
    const { prepareCall } = adapter;
    const prepared = await prepareCall.call(adapter, 'sensenova-pool', 'deepseek-v4-flash');
    const chunks = [];
    const options = {
      provider: 'sensenova-pool',
      model: 'deepseek-v4-flash',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'Reply with exactly: OK' }] }],
      maxTokens: 32,
    };
    for await (const chunk of prepared.stream(options)) {
      chunks.push(chunk);
      if (chunks.length > 400) break;
    }
    const kinds = [...new Set(chunks.map((c) => c.type))];
    check('收到流式 chunk', chunks.length > 0, `n=${chunks.length}`);
    check('包含文本增量或结束块', kinds.includes('text-delta') || kinds.includes('finish'), JSON.stringify(kinds));
    check('以 finish 收尾', chunks[chunks.length - 1]?.type === 'finish', String(chunks[chunks.length - 1]?.type));
    const text = chunks.filter((c) => c.type === 'text-delta').map((c) => c.text).join('');
    console.log(`    chunk 类型: ${kinds.join(', ')}`);
    console.log(`    文本: ${JSON.stringify(text.slice(0, 60))}`);
    const finish = chunks[chunks.length - 1];
    const reason = finish?.reason ?? finish;
    console.log(`    finish: ${JSON.stringify(reason)}`);
    // 关键断言：真实 SDK 的 finish reason 必须是 stop —— 说明整条链路
    // （DSH → pi-ai → 本插件 shim → 轮换池 → 商汤）真的跑通了。
    check('finish reason 为 stop（真实请求成功）', reason?.kind === 'stop', JSON.stringify(reason));
    check('没有 429 泄漏到 finish', JSON.stringify(reason).includes('429') === false, JSON.stringify(reason));
  } catch (e) {
    check('通过真实 adapter 发请求', false, `${e.message}`.slice(0, 300));
  }
} else {
  console.log('\n[real-apply] 未提供 key，跳过真实请求（传 key 作为参数可启用）');
}

await state.effects[0]?.();
console.log(`\n=== ${pass} passed, ${fail} failed ===\n`);
process.exit(fail === 0 ? 0 : 1);
