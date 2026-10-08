/**
 * 用**真实 schemastery** 校验本插件的 Config schema 能解析 patch 文件里的配置。
 *
 * 为什么必须单独验：离线测试用的是桩件，桩件的 .default() 永远返回自身，
 * 因此「schema 写错了」这类问题只有拿真实 schemastery 才能暴露 —— 而它一旦
 * 出错，插件会在加载阶段直接失败，表现为「模型分组不出现」。
 */
const asarRoot = process.env.DSH_ASAR ?? "C:/Users/X/AppData/Local/Programs/DeepSeek Harness/resources/app.asar";
const mods = `${asarRoot}/dsh/node_modules`;

let pass = 0, fail = 0;
const check = (n, c, d = '') => { c ? (pass++, console.log(`  PASS  ${n}`)) : (fail++, console.log(`  FAIL  ${n}${d ? ' — ' + d : ''}`)); };

const { register } = await import('node:module');
const { pathToFileURL } = await import('node:url');
const { writeFileSync, mkdirSync } = await import('node:fs');

mkdirSync(repoPath('.ref/hooks'), { recursive: true });
const map = {
  '@deepseek-ai/schemastery': `${mods}/@deepseek-ai/schemastery/lib/index.mjs`,
  '@deepseek-ai/dsh-llm-pi-ai': `${mods}/@deepseek-ai/dsh-llm-pi-ai/lib/index.js`,
  '@deepseek-ai/dsh-llm': `${mods}/@deepseek-ai/dsh-llm/lib/index.js`,
  '@earendil-works/pi-ai': `${mods}/@earendil-works/pi-ai/dist/index.js`,
  '@earendil-works/pi-ai/api/openai-completions.lazy': `${mods}/@earendil-works/pi-ai/dist/api/openai-completions.lazy.js`,
};
const hookPath = repoPath('.ref/hooks/schema-hook.mjs');
writeFileSync(hookPath, `const M=${JSON.stringify(map)};export async function resolve(s,c,n){const h=M[s];return h?{url:'file:///'+h,shortCircuit:true}:n(s,c);}`, 'utf8');
register(pathToFileURL(hookPath).href);

console.log('\n[schema] 真实 schemastery 解析');
const { Config } = await import(pathToFileURL(repoPath('lib/index.js')).href);

/** 仓库内相对路径（基于本文件位置，避免硬编码绝对路径）。 */
function repoPath(rel) {
  return new URL('../' + rel, import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
}

check('Config 已导出', Config !== undefined);

// patch 文件里真实使用的配置。
const fromPatch = { rpmLimit: 2, maxAttempts: 6, maxConcurrency: 1 };
try {
  const parsed = Config(fromPatch);
  check('解析 patch 配置成功', parsed !== undefined);
  check('rpmLimit 保留为 2', parsed.rpmLimit === 2, String(parsed.rpmLimit));
  check('maxAttempts 保留为 6', parsed.maxAttempts === 6, String(parsed.maxAttempts));
  check('maxConcurrency 保留为 1', parsed.maxConcurrency === 1, String(parsed.maxConcurrency));
  // 未提供的字段应取默认值。
  check('baseUrl 取到默认值', typeof parsed.baseUrl === 'string' && parsed.baseUrl.includes('sensenova'), String(parsed.baseUrl));
  check('acquireTimeoutMs 取到默认值', parsed.acquireTimeoutMs === 180000, String(parsed.acquireTimeoutMs));
  check('requestTimeoutMs 取到默认值', parsed.requestTimeoutMs === 60000, String(parsed.requestTimeoutMs));
  console.log('    解析结果:', JSON.stringify(parsed));
} catch (e) {
  check('解析 patch 配置成功', false, e.message.slice(0, 300));
}

// 空配置（用户没写 config 时）。
try {
  const parsed = Config({});
  check('空配置也能解析（全部取默认）', parsed.rpmLimit === 2 && parsed.maxConcurrency === 1, JSON.stringify(parsed));
} catch (e) {
  check('空配置也能解析', false, e.message.slice(0, 300));
}

// 非法配置应被拒绝（schemastery 的 .number() 会挡字符串）。
try {
  Config({ rpmLimit: 'not-a-number' });
  check('非法类型被拒绝', false, '未抛错');
} catch {
  check('非法类型被拒绝', true);
}

console.log(`\n=== ${pass} passed, ${fail} failed ===\n`);
process.exit(fail === 0 ? 0 : 1);
