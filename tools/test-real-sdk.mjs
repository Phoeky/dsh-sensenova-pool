
/** 仓库内相对路径（基于本文件位置，避免硬编码绝对路径）。 */
function repoPath(rel) {
  return new URL('../' + rel, import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
}

/**
 * 真机 SDK 验证：用 Electron（ELECTRON_RUN_AS_NODE）加载 **DSH 自带的真实 SDK**，
 * 然后实例化本插件的 provider/adapter，验证与真实 `PiAiAdapter`、
 * `createProvider`、`resolveRetryPolicy` 的契约是否吻合。
 *
 * 为什么需要：桩件只能验证我自己的逻辑，无法证明「我对 DSH 平台 API 的假设」
 * 是对的 —— profile 形状、PiAiAdapter 构造参数、createProvider 的入参都属私有
 * 契约，只有拿真实模块跑一遍才能确认。
 */
const asarRoot = process.env.DSH_ASAR ?? "C:/Users/X/AppData/Local/Programs/DeepSeek Harness/resources/app.asar";
const mods = `${asarRoot}/dsh/node_modules`;

let pass = 0, fail = 0;
const check = (n, c, d = '') => { c ? (pass++, console.log(`  PASS  ${n}`)) : (fail++, console.log(`  FAIL  ${n}${d ? ' — ' + d : ''}`)); };

console.log('\n[real-sdk] 加载 DSH 真实模块');
let PiAiAdapter, resolveRetryPolicy, createProvider, openAICompletionsApi, z;
try {
  ({ PiAiAdapter } = await import(`file:///${mods}/@deepseek-ai/dsh-llm-pi-ai/lib/index.js`));
  check('导入 PiAiAdapter', typeof PiAiAdapter === 'function');
} catch (e) { check('导入 PiAiAdapter', false, e.message.slice(0, 200)); }

try {
  ({ resolveRetryPolicy } = await import(`file:///${mods}/@deepseek-ai/dsh-llm/lib/index.js`));
  check('导入 resolveRetryPolicy', typeof resolveRetryPolicy === 'function');
} catch (e) { check('导入 resolveRetryPolicy', false, e.message.slice(0, 200)); }

try {
  ({ createProvider } = await import(`file:///${mods}/@earendil-works/pi-ai/dist/index.js`));
  check('导入 createProvider', typeof createProvider === 'function');
} catch (e) { check('导入 createProvider', false, e.message.slice(0, 200)); }

try {
  ({ openAICompletionsApi } = await import(`file:///${mods}/@earendil-works/pi-ai/dist/api/openai-completions.lazy.js`));
  check('导入 openAICompletionsApi', typeof openAICompletionsApi === 'function');
} catch (e) { check('导入 openAICompletionsApi', false, e.message.slice(0, 200)); }

try {
  const m = await import(`file:///${mods}/@deepseek-ai/schemastery/lib/index.mjs`);
  z = m?.default ?? m;
  check('导入 schemastery', z !== undefined && typeof z.object === 'function');
} catch (e) { check('导入 schemastery', false, e.message.slice(0, 200)); }

console.log('\n[real-sdk] resolveRetryPolicy 契约');
try {
  const policy = resolveRetryPolicy(undefined, 'test');
  check('返回对象', typeof policy === 'object' && policy !== null);
  check('含 mode', typeof policy.mode === 'string', JSON.stringify(policy));
  check('含 maxRetries', typeof policy.maxRetries === 'number');
  check('含 retryableCodes 数组', Array.isArray(policy.retryableCodes));
  console.log(`    policy = ${JSON.stringify(policy)}`);
} catch (e) { check('resolveRetryPolicy 可调用', false, e.message.slice(0, 200)); }

console.log('\n[real-sdk] createProvider 契约（本插件的 toPiModel 形状）');
try {
  const provider = createProvider({
    id: 'sensenova-pool',
    name: '商汤日日新（Key 轮换池）',
    auth: { apiKey: { name: 'test', async resolve() { return undefined; } } },
    models: [{
      id: 'deepseek-v4-flash',
      name: 'DeepSeek V4 Flash',
      api: 'openai-completions',
      provider: 'sensenova-pool',
      baseUrl: 'http://127.0.0.1:12345/v1',
      input: ['text'],
      reasoning: true,
      thinkingLevelMap: { off: 'off', minimal: null, low: 'low', medium: 'medium', high: 'high', xhigh: null, max: 'max' },
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 1048576,
      maxTokens: 65536,
      compat: { maxTokensField: 'max_tokens' },
    }],
    api: openAICompletionsApi(),
  });
  check('createProvider 返回对象', typeof provider === 'object' && provider !== null);
  check('含 id', provider.id === 'sensenova-pool', String(provider.id));
  // 真实契约：createProvider 暴露的是 getModels() 方法，而不是 models 数组。
  // 本插件正是用 getModels（而非 models）暴露模型，因此这里断言方法形态。
  check('暴露 getModels() 方法', typeof provider.getModels === 'function');
  const built = typeof provider.getModels === 'function' ? provider.getModels() : [];
  check('getModels() 返回模型数组', Array.isArray(built) && built.length === 1, `len=${built?.length}`);
  check('模型 id 正确', built?.[0]?.id === 'deepseek-v4-flash', String(built?.[0]?.id));
} catch (e) { check('createProvider 接受本插件的形状', false, e.message.slice(0, 300)); }

console.log('\n[real-sdk] PiAiAdapter 构造契约（profile 形状）');
try {
  const provider = createProvider({
    id: 'sensenova-pool',
    name: 'SenseNova Pool',
    auth: { apiKey: { name: 't', async resolve() { return undefined; } } },
    models: [],
    api: openAICompletionsApi(),
  });
  const profile = {
    provider: 'sensenova-pool',
    displayName: 'SenseNova Pool',
    streamIdleTimeoutMs: 300000,
    retryPolicy: resolveRetryPolicy(undefined, 'test'),
    configuredMaxTokens: new Map(),
    modelErrors: new Map(),
    maxRequestImageBytes: 20971520,
    requestImagePixelBudget: 4194304,
    requestImageMaxBytes: 1048576,
    piProvider: provider,
  };
  const profiles = new Map([['sensenova-pool', profile]]);
  const inertAuth = {
    credentials: { async read() {}, async list() { return []; }, async modify() { throw new Error('x'); }, async delete() {} },
    authContext: { async env() {}, async fileExists() { return false; } },
  };
  const adapter = new PiAiAdapter({ profiles: () => profiles, auth: inertAuth, resolveApiKey: async () => 'secret' });
  check('PiAiAdapter 构造成功', adapter !== undefined);

  // providerInfo / listModels 是最能暴露 profile 形状错误的两处。
  const info = adapter.providerInfo('sensenova-pool');
  check('providerInfo 可用', info?.id === 'sensenova-pool', JSON.stringify(info));

  const models = await adapter.listModels('sensenova-pool');
  check('listModels 可调用（profile 形状被接受）', Array.isArray(models), JSON.stringify(models).slice(0, 200));

  const policy = adapter.providerRetryPolicy('sensenova-pool');
  check('providerRetryPolicy 读到 profile.retryPolicy', policy !== undefined && typeof policy.mode === 'string', JSON.stringify(policy));
} catch (e) { check('PiAiAdapter 接受本插件的 profile 形状', false, `${e.message.slice(0, 300)}`); }

console.log('\n[real-sdk] 未知 provider 的错误语义');
try {
  // 注册了 A 却去问 B：这才是「路由不存在」的真实场景。
  const profiles = new Map([['provider-a', {
    provider: 'provider-a',
    displayName: 'A',
    streamIdleTimeoutMs: 300000,
    retryPolicy: resolveRetryPolicy(undefined, 'test'),
    configuredMaxTokens: new Map(),
    modelErrors: new Map(),
    maxRequestImageBytes: 20971520,
    requestImagePixelBudget: 4194304,
    requestImageMaxBytes: 1048576,
    piProvider: createProvider({ id: 'provider-a', name: 'A', auth: { apiKey: { name: 't', async resolve() {} } }, models: [], api: openAICompletionsApi() }),
  }]]);
  const adapter = new PiAiAdapter({
    profiles: () => profiles,
    auth: { credentials: { async read() {}, async list() { return []; }, async modify() {}, async delete() {} }, authContext: { async env() {}, async fileExists() { return false; } } },
    resolveApiKey: async () => 'x',
  });
  // 真实契约：providerInfo 对未知路由是「宽松」的（返回默认名，不抛错）；
  // 真正会抛 NO_ADAPTER 的是 listModels / resolveModel 这类需要 profile 的方法。
  const info = adapter.providerInfo('provider-b');
  check('providerInfo 对未知路由宽松（不抛错）', info?.id === 'provider-b', JSON.stringify(info));
  try {
    await adapter.listModels('provider-b');
    check('listModels 对未知路由抛错', false, '没有抛错');
  } catch (e) {
    check('listModels 对未知路由抛 NO_ADAPTER', String(e.code) === 'NO_ADAPTER' || /NO_ADAPTER/.test(String(e.message)), `${e.code} ${e.message}`.slice(0, 160));
  }
} catch (e) { check('未知 provider 场景可构造', false, e.message.slice(0, 200)); }

console.log(`\n=== ${pass} passed, ${fail} failed ===\n`);
process.exit(fail === 0 ? 0 : 1);
