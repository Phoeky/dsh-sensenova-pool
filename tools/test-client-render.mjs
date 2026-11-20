/**
 * 浏览器半的**渲染**冒烟测试：用一个极小的 React 替身真正调用卡片组件。
 *
 * 为什么需要它：`test-client.mjs` 只做静态字符串检查，能发现「槽位名写错」，
 * 却发现不了「组件里某一层 createElement 结构崩了」——那类错误只在用户点开
 * 设置页时才炸，且报错信息是一整页的插件加载失败，极难定位。
 *
 * 这里不做真实渲染（没有 react-dom），只验证：
 *   1. 三个槽位都能注册，且注册参数形状正确（settings.section 需要 id/order/label）；
 *   2. 组件能被调用、返回元素树，且树里确实有三块内容（接口 / Key / 模型）；
 *   3. 初始状态（没有任何数据）下不会因为 `undefined.x` 之类的解引用而抛错。
 *
 * 骨架测试的 `useState` setter 是空操作；双站交互测试另用独立 Hook 槽
 * 验证 Tab 可见性、草稿、延迟响应和写请求令牌不串站。
 */
import { readFileSync } from 'node:fs';

let pass = 0, fail = 0;
const check = (n, c, d = '') => { c ? (pass++, console.log(`  PASS  ${n}`)) : (fail++, console.log(`  FAIL  ${n}${d ? ' — ' + d : ''}`)); };

// ---- 极小的 React 替身 -----------------------------------------------------
const React = {
  createElement: (type, props, ...children) => ({ type, props: { ...(props || {}), children } }),
  useState: (init) => [typeof init === 'function' ? init() : init, () => {}],
  useCallback: (fn) => fn,
  useEffect: () => {},
  useMemo: (fn) => fn(),
  useRef: (value) => ({ current: value }),
};

// ---- 加载浏览器半（它是一个 window 全局工厂） -------------------------------
const code = readFileSync(process.argv.includes('--source') ? 'src/client.js' : 'lib/client.js', 'utf8');
let entry;
new Function('window', code)({ __ModuleLoader__: { load: (value) => { entry = value; } } });

check('捕获到全局工厂注册', entry !== undefined && typeof entry.factory === 'function');

const registered = [];
const ctx = {
  effect: (fn) => { try { fn(); } catch { /* 字典注册失败不影响渲染 */ } },
  locale: { register: () => {}, bind: () => (key, vars) => `${key}${vars ? JSON.stringify(vars) : ''}` },
  slots: {
    inject: (_name, cb) => { cb(); },
    register: (options, Component) => { registered.push({ options, Component }); return () => {}; },
  },
};

const module = entry.factory((id) => {
  if (id === 'react') return React;
  throw new Error(`浏览器半 require 了非冻结模块：${id}`);
});

let applyError = '';
try {
  module.apply(ctx);
} catch (error) {
  applyError = error instanceof Error ? error.message : String(error);
}
check('apply() 不抛错', applyError === '', applyError);

// ---- 槽位契约 ---------------------------------------------------------------
const byName = (name) => registered.find((row) => row.options.name === name);

console.log('\n[render] 槽位注册');
check('注册了 settings.section', byName('settings.section') !== undefined, JSON.stringify(registered.map((r) => r.options.name)));
check('注册了 plugins.bundle.config', byName('plugins.bundle.config') !== undefined);
check('注册了 settings.plugins.tab', byName('settings.plugins.tab') !== undefined);

const section = byName('settings.section');
check('settings.section 带 id', section?.options.id === 'sensenova-pool', String(section?.options.id));
check('settings.section 带数字 order', typeof section?.options.order === 'number', String(section?.options.order));
check('settings.section 的 label 是函数（随语言变化）', typeof section?.options.label === 'function');
check('settings.section 的 label 可求值', typeof section?.options.label() === 'string', String(section?.options.label()));
check('settings.section 通过 inject 提供 t', typeof section?.options.inject?.().t === 'function');
check('plugins.bundle.config 的 key 等于包名', byName('plugins.bundle.config')?.options.key === 'dsh-sensenova-pool');

// ---- 渲染 -------------------------------------------------------------------
/** 递归展开函数组件，得到一棵纯元素树。 */
function expand(node, depth = 0) {
  if (node === null || node === undefined || typeof node !== 'object') return node;
  if (Array.isArray(node)) return node.map((child) => expand(child, depth));
  if (typeof node.type === 'function') {
    if (depth > 12) throw new Error('组件嵌套过深');
    return expand(node.type({ ...node.props }), depth + 1);
  }
  return { type: node.type, props: { ...node.props, children: expand(node.props.children, depth + 1) } };
}

console.log('\n[render] 组件渲染');
for (const row of registered) {
  const props = row.options.inject ? row.options.inject() : {};
  let tree;
  let error = '';
  try {
    tree = expand(row.Component({ ...props, view: 'full', t: props.t || ((key) => key) }));
  } catch (cause) {
    error = cause instanceof Error ? cause.message : String(cause);
  }
  const text = error === '' ? JSON.stringify(tree) : '';
  check(`${row.options.name} 渲染不抛错`, error === '', error);
  check(`${row.options.name} 含接口区块`, text.includes('endpointTitle'));
  check(`${row.options.name} 含 Key 池区块`, text.includes('keysTitle'));
  check(`${row.options.name} 含模型区块`, text.includes('modelsTitle'));
}

console.log('\n[render] 端点区（无状态时不出错）');
{
  // 初始状态下 upstream 为 undefined：端点区应整块不渲染，而不是崩掉。
  const row = byName('settings.section');
  const props = row.options.inject();
  const tree = JSON.stringify(expand(row.Component({ ...props, view: 'full', t: props.t })));
  check('没有端点状态时也能渲染', tree.length > 0);
  check('没有端点状态时不渲染端点区', !tree.includes('endpoint-pick'));
}

console.log('\n[render] 摘要视图');
{
  const row = byName('plugins.bundle.config');
  const props = row.options.inject();
  const summary = row.Component({ ...props, view: 'summary', t: props.t });
  check('summary 视图返回一句说明而不是整张卡片', typeof summary === 'string' && summary.length > 0, JSON.stringify(summary));
}

// ---- 双站交互：为每个组件维护独立的 Hook 槽，模拟跨 Tab 的异步响应 -----------
console.log('\n[render] 双站状态与请求隔离');
{
  const originalFetch = globalThis.fetch;
  const originalState = React.useState;
  const originalEffect = React.useEffect;
  let current;
  React.useState = (init) => {
    const owner = current;
    const index = owner.index++;
    if (!(index in owner.states)) owner.states[index] = typeof init === 'function' ? init() : init;
    return [owner.states[index], (value) => {
      owner.states[index] = typeof value === 'function' ? value(owner.states[index]) : value;
    }];
  };
  React.useEffect = (effect) => { current.effects.push(effect); };
  const instance = (element) => ({ element, states: [], effects: [], index: 0 });
  const render = (owner) => {
    current = owner;
    owner.index = 0;
    owner.effects = [];
    return owner.element.type(owner.element.props);
  };
  const nodes = (tree, predicate) => {
    const found = [];
    const visit = (node) => {
      if (Array.isArray(node)) return node.forEach(visit);
      if (!node || typeof node !== 'object') return;
      if (predicate(node)) found.push(node);
      visit(node.props?.children);
    };
    visit(tree);
    return found;
  };
  const calls = [];
  const cnBase = '/plugins/dsh-sensenova-pool';
  const intlBase = cnBase + '/intl';
  let releaseCn;
  let pendingCn = true;
  const status = (base) => ({ keys: [], models: [], adminKey: base + '-admin', endpoint: { baseUrl: base + '/v1', apiKey: base + '-api' } });
  const response = (value) => ({ ok: true, json: async () => value });
  globalThis.fetch = async (url, options) => {
    calls.push({ url, options });
    if (url === cnBase + '/status' && pendingCn) {
      pendingCn = false;
      return new Promise((resolve) => { releaseCn = () => resolve(response(status(cnBase))); });
    }
    if (url.endsWith('/status')) return response(status(url.slice(0, -7)));
    return response({ added: 1, duplicate: 0 });
  };
  try {
    const row = byName('settings.section');
    const tabs = instance(row.Component(row.options.inject()));
    let tree = render(tabs);
    let panels = nodes(tree, (node) => node.props?.role === 'tabpanel');
    check('两站管理卡均常驻且有独立 key', panels.length === 2 && panels[0].props.children[0].props.key === 'cn' && panels[1].props.children[0].props.key === 'intl');
    const cn = instance(panels[0].props.children[0]);
    const intl = instance(panels[1].props.children[0]);
    render(cn); cn.effects.forEach((effect) => effect());
    render(intl); intl.effects.forEach((effect) => effect());
    await new Promise((resolve) => setImmediate(resolve));
    const initialCalls = calls.length;
    nodes(tree, (node) => node.props?.role === 'tab')[1].props.onClick();
    tree = render(tabs);
    panels = nodes(tree, (node) => node.props?.role === 'tabpanel');
    check('Tab 仅改变可见卡片，不发请求', panels[0].props.hidden === true && panels[1].props.hidden === false && calls.length === initialCalls);
    nodes(render(intl), (node) => node.type === 'textarea')[0].props.onChange({ target: { value: 'sk-intl-draft' } });
    releaseCn();
    await new Promise((resolve) => setImmediate(resolve));
    check('中国站延迟响应不覆盖国际站草稿', nodes(render(intl), (node) => node.type === 'textarea')[0].props.value === 'sk-intl-draft');
    check('中国站草稿独立为空', nodes(render(cn), (node) => node.type === 'textarea')[0].props.value === '');
    for (const [owner, base, draft] of [[cn, cnBase, 'sk-cn-draft'], [intl, intlBase, 'sk-intl-draft']]) {
      nodes(render(owner), (node) => node.type === 'textarea')[0].props.onChange({ target: { value: draft } });
      const card = render(owner);
      const add = nodes(card, (node) => node.type === 'button' && node.props.children.includes('save'))[0];
      await add.props.onClick();
      const call = calls.find((item) => item.url === base + '/keys');
      check(base + ' 写入使用本站草稿与令牌', JSON.parse(call?.options.body || '{}').keys === draft && call?.options.headers['x-sensenova-pool-admin'] === base + '-admin');
    }
    check('所有请求均属于两套固定路由且无切上游动作', calls.every((call) => [cnBase + '/status', intlBase + '/status', cnBase + '/keys', intlBase + '/keys'].includes(call.url) && !call.options.body?.includes('set-endpoint')));
  } finally {
    globalThis.fetch = originalFetch;
    React.useState = originalState;
    React.useEffect = originalEffect;
  }
}

console.log(`\n=== ${pass} passed, ${fail} failed ===\n`);
process.exit(fail === 0 ? 0 : 1);
