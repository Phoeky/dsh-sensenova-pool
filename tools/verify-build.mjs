import { readFileSync } from 'node:fs';

const lib = readFileSync('lib/index.js', 'utf8');
const catalogLib = readFileSync('lib/catalog.js', 'utf8');
const clientLib = readFileSync('lib/client.js', 'utf8');
const clientSrc = readFileSync('src/client.js', 'utf8');

console.log('index.js 含 rpm 默认值 2        :', /DEFAULT_RPM_LIMIT\s*=\s*2/.test(lib));
// issue #3：推理档位改由 catalog.ts 按模型生成，不再有全局映射表字面量。
console.log('index.js 用 thinkingLevelMapFor :', /thinkingLevelMapFor/.test(lib));
console.log('catalog.js 含逐模型词表(glm-5.3):', catalogLib.includes("'glm-5.3'"));
console.log('catalog.js 含保守默认词表       :', /DEFAULT_REASONING_EFFORTS/.test(catalogLib));
console.log('index.js 无旧全局映射 max→xhigh :', !/max:\s*['"]xhigh['"]/.test(lib));
console.log('index.js 无旧全局映射 off→none  :', !/off:\s*['"]none['"]/.test(lib));
console.log('client.js 与 src 一致           :', clientLib === clientSrc);
