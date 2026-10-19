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
 * 限制：`useState` 的 setter 是空操作，所以列表始终为空 —— 列表行的渲染由
 * 宿主里的真实使用覆盖，这里只保证骨架不崩。
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
const code = readFileSync('lib/client.js', 'utf8');
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
    if (depth > 4) return { type: '[component]' };
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

console.log('\n[render] 摘要视图');
{
  const row = byName('plugins.bundle.config');
  const props = row.options.inject();
  const summary = row.Component({ ...props, view: 'summary', t: props.t });
  check('summary 视图返回一句说明而不是整张卡片', typeof summary === 'string' && summary.length > 0, JSON.stringify(summary));
}

console.log(`\n=== ${pass} passed, ${fail} failed ===\n`);
process.exit(fail === 0 ? 0 : 1);
