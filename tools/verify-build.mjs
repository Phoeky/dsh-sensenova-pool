import { readFileSync } from 'node:fs';

const lib = readFileSync('lib/index.js', 'utf8');
const clientLib = readFileSync('lib/client.js', 'utf8');
const clientSrc = readFileSync('src/client.js', 'utf8');

console.log('index.js 含 rpm 默认值 2:', /DEFAULT_RPM_LIMIT\s*=\s*2/.test(lib));
console.log('index.js off -> none      :', /off:\s*['"]none['"]/.test(lib));
console.log('index.js max -> xhigh     :', /max:\s*['"]xhigh['"]/.test(lib));
console.log('index.js 无 off->off 残留 :', !/off:\s*['"]off['"]/.test(lib));
console.log('index.js 无 max->max 残留 :', !/max:\s*['"]max['"]/.test(lib));
console.log('client.js 与 src 一致     :', clientLib === clientSrc);
