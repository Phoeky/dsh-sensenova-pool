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
const clientPath = pkg.exports['./client'].replace(/^\.\//, '');

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
check('注册 locale 字典', code.includes('locale.register'));
check('含中文文案', code.includes('商汤日日新'));
check('含英文文案', code.includes('SenseNova Key Pool'));
check('有错误隔离（guardClientContribution）', code.includes('guardClientContribution'));
check('用主题 token 而非硬编码颜色', code.includes('--dsw-alias-'));

console.log('\n[client] 与宿主路由的契约');
// 客户端用 BASE 常量 + 后缀拼 URL（比散落的字面量更不易写错），因此这里
// 同时校验 BASE 与各后缀都出现。
const baseMatch = code.match(/const BASE = '([^']+)'/);
check('定义了路由 BASE', Boolean(baseMatch), String(baseMatch?.[1]));
check('BASE 指向本插件路由前缀', baseMatch?.[1] === '/plugins/dsh-sensenova-pool', String(baseMatch?.[1]));
for (const suffix of ['/status', '/keys', '/test']) {
  check(`请求 BASE${suffix}`, code.includes(`\${BASE}${suffix}`), suffix);
}
check('写操作带令牌头', code.includes('x-sensenova-pool-admin'));
check('GET 用 same-origin 凭据', code.includes("credentials: 'same-origin'"));

console.log(`\n=== ${pass} passed, ${fail} failed ===\n`);
process.exit(fail === 0 ? 0 : 1);
