/**
 * 浏览器半的静态校验：确保它符合 DSH 客户端包的加载契约。
 *
 * 这一步不启动浏览器，只做结构性检查 —— 那些一旦出错就会让整页红屏、
 * 而错误信息又极难定位的问题。
 */
import { readFileSync, existsSync } from 'node:fs';

let pass = 0, fail = 0;
const check = (n, c, d = '') => { c ? (pass++, console.log(`  PASS  ${n}`)) : (fail++, console.log(`  FAIL  ${n}${d ? ' — ' + d : ''}`)); };

const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
const clientPath = process.argv.includes('--source') ? 'src/client.js' : pkg.exports['./client'].replace(/^\.\//, '');

console.log('\n[client] 打包契约');
check('exports["./client"] 已声明', typeof pkg.exports['./client'] === 'string');
check('dsh.client.platform === "web"', pkg.dsh?.client?.platform === 'web');
check(`客户端文件存在（${clientPath}）`, existsSync(clientPath));

const code = readFileSync(clientPath, 'utf8');

console.log('\n[client] 加载器契约');
check('使用 __ModuleLoader__.load 全局工厂形态', code.includes('window.__ModuleLoader__.load('));
const idMatch = code.match(/__ModuleLoader__\.load\(\s*\{\s*id:\s*['"`]([^'"`]+)['"`]/);
check('id 可解析', Boolean(idMatch));
check('id 与包名逐字一致', idMatch?.[1] === pkg.name, `${idMatch?.[1]} vs ${pkg.name}`);
check('factory 形态（非 ESM export）', /factory\s*\(\s*require\s*\)/.test(code) && !/^\s*export\s/m.test(code));

console.log('\n[client] 依赖约束');
const required = [...new Set([...code.matchAll(/require\(\s*['"`]([^'"`]+)['"`]\s*\)/g)].map((m) => m[1]))];
check('只依赖 react（对宿主包改名免疫）', required.every((s) => s === 'react' || s === 'react/jsx-runtime'), JSON.stringify(required));
const stripped = code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
check('未使用 setInterval（动态包禁止）', !/(^|[^.\w])setInterval\s*\(/m.test(stripped));
check('未使用 setTimeout（动态包禁止）', !/(^|[^.\w])setTimeout\s*\(/m.test(stripped));

console.log('\n[client] 槽位与文案');
check('注册 plugins.bundle.config（现行槽位）', code.includes("'plugins.bundle.config'"));
check('key 等于包名', code.includes(`key: BUNDLE_NAME`) || code.includes(`key: '${pkg.name}'`));
check('注册 settings.section（设置一级分区）', code.includes("'settings.section'"));
check('设置分区带 id', /name:\s*'settings\.section'[\s\S]{0,200}?id:\s*'sensenova-pool'/.test(code));
check('设置分区带 order 与 label', /name:\s*'settings\.section'[\s\S]{0,300}?order:\s*\d+[\s\S]{0,200}?label:/.test(code));
check('注册 locale 字典', code.includes('locale.register'));
check('含中文文案', code.includes('商汤日日新'));
check('含英文文案', code.includes('SenseNova Key Pool'));
check('有错误隔离（guardClientContribution）', code.includes('guardClientContribution'));
check('用主题 token 而非硬编码颜色', code.includes('--dsw-alias-'));

console.log('\n[client] 新增功能面');
check('展示接口地址', code.includes('endpoint.baseUrl'));
check('展示对外 API Key', code.includes('endpoint.apiKey'));
check('栏目名用包名', code.includes('label: () => BUNDLE_NAME'));
check('提供复制能力', code.includes('copyText'));
check('模型可见性开关（set-model）', code.includes("action: 'set-model'"));
check('模型列表来自 /status', code.includes('status.models'));

console.log('\n[client] 模型窗口设置（issue #4）');
check('调用 set-model-limits 接口', code.includes("action: 'set-model-limits'"));
check('入口是「设置」按钮，不再是内联输入', code.includes("t('limitsEdit')") && !code.includes('saveLimits'));
check('字段名用「上下文窗口 / 最大输出 token 数」', code.includes("'上下文窗口'") && code.includes("'最大输出 token 数'"));
check('保存/取消/恢复默认三个动作齐全',
  code.includes("t('limitsSave')") && code.includes("t('cancel')") && code.includes("t('limitsResetButton')"));
check('保存前只改草稿（value 受控）', code.includes('value: limitWindow') && code.includes('value: limitOutput'));
check('输入框是文本框（才输得进 1M / 128K）', code.includes("inputMode: 'numeric'") && !code.includes("type: 'number'"));
check('提示里说明支持 1M / 128K', code.includes('1M / 128K'));

console.log('\n[client] 双站独立管理');
check('不调用 set-endpoint 接口', !code.includes("action: 'set-endpoint'"));
check('从 /status 取只读上游状态', code.includes('status.upstreamEndpoint'));
check('Tab 只更新本地可见站点', code.includes('onClick: () => setSite(option.id)'));
check('每站独立挂载管理卡', code.includes('h(KeyCard, { key: option.id, t, base: option.base })'));
check('隐藏而非卸载另一站卡片', code.includes('hidden: site !== option.id'));
check('显示当前上游地址', code.includes('epUpstream'));
check('文案说明 Key 池独立与两站同时可用', code.includes('Key 池独立') && code.includes('同时可用') && code.includes('不是切换上游'));

console.log('\n[client] 文案键完整性');
{
  // 界面里的 t('key') 必须在中英文字典里都有 —— 漏一个就会在页面上显示成键名。
  const usedKeys = new Set([...code.matchAll(/\bt\('([A-Za-z0-9_]+)'/g)].map((m) => m[1]));
  const blockKeys = (start) => {
    const end = code.indexOf('\n    };', start);
    const block = code.slice(start, end);
    return new Set([...block.matchAll(/^\s{6}([A-Za-z0-9_]+):/gm)].map((m) => m[1]));
  };
  const enKeys = blockKeys(code.indexOf('    const en = {'));
  const zhKeys = blockKeys(code.indexOf('    const zh = {'));
  const missing = [...usedKeys].filter((key) => !enKeys.has(key) || !zhKeys.has(key));
  check('所有 t() 键都有中英文案', missing.length === 0, JSON.stringify(missing));
  const mismatch = [...enKeys].filter((key) => !zhKeys.has(key)).concat([...zhKeys].filter((key) => !enKeys.has(key)));
  check('中英文字案键一一对应', mismatch.length === 0, JSON.stringify(mismatch));
}

console.log('\n[client] 与宿主路由的契约');
// 每张管理卡只使用所属站点的固定 base 拼接管理路由。
check('中国站兼容旧路由', code.includes("id: 'cn', base: '/plugins/dsh-sensenova-pool'"));
check('国际站使用独立路由', code.includes("id: 'intl', base: '/plugins/dsh-sensenova-pool/intl'"));
for (const suffix of ['/status', '/keys', '/test']) {
  check(`请求站点 base${suffix}`, code.includes(`\${base}${suffix}`), suffix);
}
check('写操作带令牌头', code.includes('x-sensenova-pool-admin'));
check('GET 用 same-origin 凭据', code.includes("credentials: 'same-origin'"));

console.log(`\n=== ${pass} passed, ${fail} failed ===\n`);
process.exit(fail === 0 ? 0 : 1);
