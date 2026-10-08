/**
 * 浏览器半的构建步骤。
 *
 * 为什么需要它：DSH 的客户端半必须是**已构建好的纯 JavaScript**，且以
 * `window.__ModuleLoader__.load({ id, factory })` 的全局工厂形态存在。宿主在
 * 启动时按 `exports["./client"]` 去找这个文件，**找不到就直接判定插件激活失败**
 * （MissingClientBundleError）。所以这一步不是可选的收尾，而是加载的前置条件。
 *
 * 本脚本做三件事：
 *   1. 把 `src/client.js` 复制到 `lib/client.js`；
 *   2. 校验它确实是全局工厂形态，且 `id` 与 npm 包名逐字一致
 *      （不一致会导致浏览器半挂不到 Loader 行上，卡片永远不出现）；
 *   3. 校验它没有 import 冻结表之外的模块（只用 `react` / `react/jsx-runtime`）。
 *
 * 校验失败一律以非零码退出，避免"构建成功但一启动就红屏"。
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');

const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const pkgName = pkg.name;
const clientExport = pkg.exports?.['./client'];

if (typeof clientExport !== 'string') {
  console.error('package.json 缺少 exports["./client"]，DSH 无法加载浏览器半');
  process.exit(1);
}

const source = join(root, 'src', 'client.js');
const target = join(root, clientExport.replace(/^\.\//, ''));

if (!existsSync(source)) {
  console.error(`缺少浏览器半源文件：${source}`);
  process.exit(1);
}

const code = readFileSync(source, 'utf8');
const problems = [];

// 1. 必须是全局工厂注册形态。
if (!code.includes('window.__ModuleLoader__.load(')) {
  problems.push('未找到 window.__ModuleLoader__.load(...) 包装');
}

// 2. id 必须与包名逐字相同。
const idMatch = code.match(/__ModuleLoader__\.load\(\s*\{\s*id:\s*['"`]([^'"`]+)['"`]/);
if (!idMatch) {
  problems.push('无法解析 __ModuleLoader__.load 的 id');
} else if (idMatch[1] !== pkgName) {
  problems.push(`id "${idMatch[1]}" 与包名 "${pkgName}" 不一致（必须逐字相同）`);
}

// 3. 不允许顶层 ESM 语法：客户端半是工厂函数，不能 export / import。
if (/^\s*(export|import)\s/m.test(code)) {
  problems.push('出现顶层 import/export —— 浏览器半必须是工厂函数，不能是 ESM 模块');
}

// 4. 只允许 require 冻结表里的模块。
const allowed = new Set(['react', 'react/jsx-runtime', 'react-dom', 'react-dom/client']);
const required = [...code.matchAll(/require\(\s*['"`]([^'"`]+)['"`]\s*\)/g)].map((m) => m[1]);
for (const spec of required) {
  if (!allowed.has(spec)) problems.push(`require("${spec}") 不在宿主冻结模块表内`);
}

// 5. 禁止浏览器定时器全局量：动态客户端包内使用会直接抛错。
for (const banned of ['setInterval', 'setTimeout']) {
  // 允许出现在注释里，只检查真实调用。
  const callPattern = new RegExp(`(^|[^.\\w])${banned}\\s*\\(`, 'm');
  const stripped = code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  if (callPattern.test(stripped)) {
    problems.push(`使用了 ${banned}() —— 动态客户端包禁止浏览器定时器全局量`);
  }
}

if (problems.length > 0) {
  console.error('浏览器半校验失败：');
  for (const problem of problems) console.error(`  - ${problem}`);
  process.exit(1);
}

mkdirSync(dirname(target), { recursive: true });
writeFileSync(target, code, 'utf8');

const bytes = Buffer.byteLength(code, 'utf8');
console.log(`client bundle -> ${clientExport} (${bytes} bytes)`);
console.log(`  id=${pkgName}  require=${JSON.stringify([...new Set(required)])}`);
