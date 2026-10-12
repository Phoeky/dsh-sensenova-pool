/**
 * 把**真实** credentials-local 及其依赖从 DSH 的 app.asar 提取到 `_e2e/node_modules`。
 *
 * 为什么需要：`tools/e2e-real-credentials.mjs` 要用真实的凭据提供者来验证启动时序，
 * 而这些包只随 DSH 桌面版分发（不在本仓库的依赖里）。提取后即可离线复用，
 * 不必每次跑都联网或装 DSH。
 *
 * 用法：node tools/e2e-extract-deps.mjs [app.asar 路径]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ASAR =
  process.argv[2] ??
  process.env.DSH_ASAR ??
  'C:\\Users\\X\\AppData\\Local\\Programs\\DeepSeek Harness\\resources\\app.asar';

if (!fs.existsSync(ASAR)) {
  console.error(`找不到 app.asar：${ASAR}`);
  console.error('请用 `node tools/e2e-extract-deps.mjs <app.asar 路径>` 指定。');
  process.exit(1);
}

// ---- 读取 asar 头部（pickle 格式）------------------------------------------
const fd = fs.openSync(ASAR, 'r');
const sizeBuf = Buffer.alloc(8);
fs.readSync(fd, sizeBuf, 0, 8, 0);
const headerSize = sizeBuf.readUInt32LE(4);
const headerBuf = Buffer.alloc(headerSize);
fs.readSync(fd, headerBuf, 0, headerSize, 8);
const headerJson = headerBuf.toString('utf8');
const header = JSON.parse(headerJson.slice(headerJson.indexOf('{'), headerJson.lastIndexOf('}') + 1));
const baseOffset = 8 + headerSize;

const files = [];
(function walk(node, prefix) {
  for (const [name, entry] of Object.entries(node.files ?? {})) {
    const p = `${prefix}/${name}`;
    if (entry.files) walk(entry, p);
    else files.push({ path: p, size: entry.size, offset: entry.offset });
  }
})(header, '');

/** 需要提取的包（凭据链 + 其运行时依赖）。 */
const WANT = [
  '@deepseek-ai/dsh-credentials/',
  '@deepseek-ai/dsh-credentials-local/',
  '@deepseek-ai/dsh-atomic-write/',
  '@deepseek-ai/dsh-home-paths/',
  '@deepseek-ai/dsh-launch-environment/',
  '@deepseek-ai/dsh-brand/',
  '@deepseek-ai/cosmokit/',
  '@deepseek-ai/schemastery/',
  '@deepseek-ai/cordis/',
  'yaml/',
  'chokidar/',
  'readdirp/',
].map((p) => `/dsh/node_modules/${p}`);

const outRoot = path.join(repoRoot, '_e2e', 'node_modules');
let count = 0;
for (const f of files) {
  if (!WANT.some((w) => f.path.startsWith(w))) continue;
  const rel = f.path.replace('/dsh/node_modules/', '');
  const dest = path.join(outRoot, rel.replace(/\//g, path.sep));
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const buf = Buffer.alloc(f.size);
  fs.readSync(fd, buf, 0, f.size, baseOffset + Number(f.offset));
  fs.writeFileSync(dest, buf);
  count += 1;
}
fs.closeSync(fd);

console.log(`已提取 ${count} 个文件 -> ${outRoot}`);
console.log('现在可以运行：node --import ./tools/e2e-loader.mjs tools/e2e-real-credentials.mjs');
