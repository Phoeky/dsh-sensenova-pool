/**
 * 端点（中国站 / 国际站）的单元测试。
 *
 * 覆盖三件事：
 *   1. 两端点的地址与内置基线各自独立 —— 国际站不应带出中国站独有的模型；
 *   2. 目录缓存能随端点重置，解析时用的是**该端点**的基线；
 *   3. shim 的上游地址可以在运行期切换，且**下一次请求**就打向新地址。
 */
import {
  BUILTIN_MODELS,
  DEFAULT_BASE_URL,
  DEFAULT_ENDPOINT_ID,
  ENDPOINTS,
  INTL_BUILTIN_MODELS,
  builtinModelsFor,
  endpointFor,
  isEndpointId,
  parseModelCatalog,
} from '../lib/catalog.js';
import { KeyPool } from '../lib/keypool.js';
import { ModelCatalog, createShim } from '../lib/shim.js';

let pass = 0, fail = 0;
const check = (n, c, d = '') => { c ? (pass++, console.log(`  PASS  ${n}`)) : (fail++, console.log(`  FAIL  ${n}${d ? ' — ' + d : ''}`)); };

console.log('\n[endpoints] 端点定义');
{
  check('共有两个端点', ENDPOINTS.length === 2, JSON.stringify(ENDPOINTS.map((e) => e.id)));
  check('默认端点是中国站（老用户升级后行为不变）', DEFAULT_ENDPOINT_ID === 'cn', DEFAULT_ENDPOINT_ID);
  check('中国站地址不变', endpointFor('cn').baseUrl === 'https://token.sensenova.cn/v1', endpointFor('cn').baseUrl);
  check('国际站地址为 token.sensenova.ai', endpointFor('intl').baseUrl === 'https://token.sensenova.ai/v1', endpointFor('intl').baseUrl);
  check('DEFAULT_BASE_URL 仍是中国站', DEFAULT_BASE_URL === 'https://token.sensenova.cn/v1', DEFAULT_BASE_URL);
  check('未知端点回落到中国站', endpointFor('moon').id === 'cn', endpointFor('moon').id);
  check('id 校验只认 cn / intl', isEndpointId('cn') && isEndpointId('intl') && !isEndpointId('CN') && !isEndpointId(undefined));
  check('两个端点都有中文标签', ENDPOINTS.every((e) => typeof e.label === 'string' && e.label.length > 0), JSON.stringify(ENDPOINTS.map((e) => e.label)));
}

console.log('\n[endpoints] 内置基线按端点区分');
{
  const ids = (list) => list.map((m) => m.id);
  check('中国站基线含 deepseek-v4-flash', ids(builtinModelsFor('cn')).includes('deepseek-v4-flash'), JSON.stringify(ids(builtinModelsFor('cn'))));
  check('国际站基线不含 deepseek-v4-flash', !ids(builtinModelsFor('intl')).includes('deepseek-v4-flash'), JSON.stringify(ids(builtinModelsFor('intl'))));
  check('国际站基线只含 sensenova 系列', builtinModelsFor('intl').every((m) => m.id.startsWith('sensenova-')), JSON.stringify(ids(builtinModelsFor('intl'))));
  check('国际站基线含 6.8-flash 与 6.8-flash-lite',
    ids(builtinModelsFor('intl')).includes('sensenova-6.8-flash') && ids(builtinModelsFor('intl')).includes('sensenova-6.8-flash-lite'),
    JSON.stringify(ids(builtinModelsFor('intl'))));
  // 用户明确要求「模型全放出来」：上游 /v1/models 列了什么，基线里就有什么。
  check('国际站基线列出全部 5 个上游模型',
    JSON.stringify([...ids(builtinModelsFor('intl'))].sort()) ===
      JSON.stringify(['sensenova-6.7-flash-lite', 'sensenova-6.8-flash', 'sensenova-6.8-flash-lite', 'sensenova-u1-fast', 'sensenova-u1.5-lite']),
    JSON.stringify(ids(builtinModelsFor('intl'))));
  check('生图模型（u1 系列）也在列', ids(builtinModelsFor('intl')).includes('sensenova-u1-fast') && ids(builtinModelsFor('intl')).includes('sensenova-u1.5-lite'),
    JSON.stringify(ids(builtinModelsFor('intl'))));
  check('国际站不覆盖上游窗口（没有国内站 issue #4 的证据）',
    INTL_BUILTIN_MODELS.every((m) => m.contextWindowOverridesUpstream !== true));
  check('未知端点回落到中国站基线', builtinModelsFor('nope') === BUILTIN_MODELS);
}

console.log('\n[endpoints] 目录解析使用该端点的基线');
{
  // 上游只报了 id：窗口/上限应取自该端点自己的基线，而不是中国站的。
  const payload = { data: [{ id: 'sensenova-6.8-flash' }, { id: 'sensenova-6.8-flash-lite' }] };
  const intl = parseModelCatalog(payload, INTL_BUILTIN_MODELS);
  check('国际站解析出 2 个模型', intl.length === 2, JSON.stringify(intl.map((m) => m.id)));
  check('国际站窗口取国际站基线（262144）', intl[0].contextWindow === 262144, String(intl[0].contextWindow));

  // 中国站同名模型带「覆盖上游」标记：用来证明基线确实按端点切换了。
  const cn = parseModelCatalog(payload, BUILTIN_MODELS);
  check('中国站窗口取中国站基线（1M，覆盖上游）', cn[0].contextWindow === 1048576, String(cn[0].contextWindow));

  // 跨界模型不会被另一套基线「误伤」：中国站独有的 id 在国际站解析时无基线可依。
  const cross = parseModelCatalog({ data: [{ id: 'glm-5.2' }] }, INTL_BUILTIN_MODELS);
  check('国际站解析中国站独有模型仍能回落到默认值', cross.length === 1 && cross[0].contextWindow === 262144, JSON.stringify(cross));

  // 「模型全放出来」：解析层不再按输出模态筛掉生图模型。
  const withImages = parseModelCatalog({
    data: [
      { id: 'sensenova-u1-fast', output_modalities: ['image'] },
      { id: 'sensenova-u1.5-lite', output_modalities: ['image'] },
      { id: 'sensenova-6.8-flash', output_modalities: ['text'] },
    ],
  }, INTL_BUILTIN_MODELS);
  check('生图模型不再被目录解析过滤', withImages.length === 3, JSON.stringify(withImages.map((m) => m.id)));
  check('生图模型按上游字段解析窗口', withImages[0].contextWindow === 262144, String(withImages[0].contextWindow));
}

console.log('\n[endpoints] 目录缓存可随端点重置');
{
  const catalog = new ModelCatalog();
  check('初始为中国站基线', catalog.current().some((m) => m.id === 'deepseek-v4-flash'));
  const applied = catalog.apply({ data: [{ id: 'sensenova-6.8-flash', context_length: 123456 }] }, INTL_BUILTIN_MODELS);
  check('apply 后为 live 目录', applied === 1 && catalog.status().source === 'live', JSON.stringify(catalog.status()));
  check('live 值来自上游', catalog.current()[0].contextWindow === 123456, String(catalog.current()[0].contextWindow));

  catalog.reset('intl');
  check('reset 到国际站 → 退回内置基线', catalog.status().source === 'builtin', JSON.stringify(catalog.status()));
  check('reset 后不含中国站独有模型', !catalog.current().some((m) => m.id === 'deepseek-v4-flash'), JSON.stringify(catalog.current().map((m) => m.id)));
  check('reset 后含国际站模型', catalog.current().some((m) => m.id === 'sensenova-6.8-flash'));

  catalog.reset('cn');
  check('reset 回中国站 → 恢复中国站基线', catalog.current().some((m) => m.id === 'deepseek-v4-flash'));
}

console.log('\n[endpoints] 两站目录实例互不影响');
{
  const cn = new ModelCatalog();
  const intl = new ModelCatalog();
  intl.reset('intl');
  cn.apply({ data: [{ id: 'cn-only-live', context_length: 65536 }] }, BUILTIN_MODELS);
  check('刷新中国目录不污染国际基线', intl.status().source === 'builtin' && !intl.current().some((m) => m.id === 'cn-only-live'));
  intl.apply({ data: [{ id: 'intl-only-live', context_length: 32768 }] }, INTL_BUILTIN_MODELS);
  check('刷新国际目录不覆盖中国 live 目录', cn.current().length === 1 && cn.current()[0].id === 'cn-only-live' && cn.current()[0].contextWindow === 65536);
}

console.log('\n[endpoints] key 池：额度可运行时调整');
{
  const pool = new KeyPool(['sk-a', 'sk-b'], { rpmLimit: 2, maxConcurrency: 1 });
  check('初始 RPM 为 2', pool.rpmLimitValue === 2, String(pool.rpmLimitValue));
  pool.setRpmLimit(3);
  check('切换到 3 立刻生效', pool.rpmLimitValue === 3, String(pool.rpmLimitValue));
  pool.setRpmLimit(null);
  check('传 null 表示不限流', pool.rpmLimitValue === null, String(pool.rpmLimitValue));
  pool.setMaxConcurrency(0);
  check('并发下限为 1', pool.maxConcurrencyValue === 1, String(pool.maxConcurrencyValue));

  // resetHealth：把冷却/失效的 key 拉回健康，但保留统计。
  const pool2 = new KeyPool(['sk-x'], {});
  const entry = pool2.find('sk-x');
  pool2.reportRateLimit(entry, 60_000);
  check('冷却后状态为 cooldown', pool2.snapshot()[0].status === 'cooldown', pool2.snapshot()[0].status);
  const reset = pool2.resetHealth();
  check('resetHealth 复活 1 把', reset === 1 && pool2.snapshot()[0].status === 'healthy', JSON.stringify({ reset, status: pool2.snapshot()[0].status }));
  check('resetHealth 保留累计统计', pool2.snapshot()[0].stats.rateLimited === 1, JSON.stringify(pool2.snapshot()[0].stats));
  check('再次 resetHealth 无事可做', pool2.resetHealth() === 0);
}

console.log('\n[endpoints] shim 运行期切换上游地址');
{
  const pool = new KeyPool(['sk-key1'], { maxConcurrency: 4 });
  const catalog = new ModelCatalog();
  const shim = createShim({ pool, catalog, baseUrl: endpointFor('cn').baseUrl });
  await shim.ready;
  const base = shim.baseUrl();
  check('初始上游为中国站', shim.upstream() === 'https://token.sensenova.cn/v1', shim.upstream());

  const seen = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const target = String(url);
    if (target.startsWith('http://127.0.0.1')) return realFetch(url, init);
    seen.push(target);
    return new Response(JSON.stringify({ id: 'x', object: 'chat.completion', choices: [] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };

  const call = () =>
    realFetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${shim.token()}` },
      body: JSON.stringify({ model: 'sensenova-6.8-flash', messages: [{ role: 'user', content: 'hi' }] }),
    });

  await (await call()).text();
  check('切换前请求打到中国站', seen.at(-1) === 'https://token.sensenova.cn/v1/chat/completions', seen.at(-1));

  shim.setUpstream(endpointFor('intl').baseUrl);
  check('upstream() 返回新地址', shim.upstream() === 'https://token.sensenova.ai/v1', shim.upstream());
  await (await call()).text();
  check('切换后立即打到国际站', seen.at(-1) === 'https://token.sensenova.ai/v1/chat/completions', seen.at(-1));
  check('回环端口不变', shim.port() > 0);

  shim.setUpstream('');
  check('忽略空地址', shim.upstream() === 'https://token.sensenova.ai/v1', shim.upstream());

  globalThis.fetch = realFetch;
  await shim.close();
}

console.log(`\n=== ${pass} passed, ${fail} failed ===\n`);
process.exit(fail === 0 ? 0 : 1);
