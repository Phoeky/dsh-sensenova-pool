/**
 * 一次跑完全部离线测试。
 *
 * 用法：node tools/test-all.mjs
 *
 * 真机测试（需要真实 key、会消耗额度）单独跑：
 *   node tools/e2e-live.mjs <key>
 *   node tools/e2e-storm-shim.mjs <key>
 *   ELECTRON_RUN_AS_NODE=1 "<DSH exe>" tools/test-real-sdk.mjs
 *   ELECTRON_RUN_AS_NODE=1 "<DSH exe>" tools/test-real-apply.mjs <key>
 *
 * 用**真实**凭据提供者（credentials-local）跑端到端时序验证（不联网、不消耗额度）：
 *   node tools/e2e-extract-deps.mjs          # 首次：从 DSH 的 app.asar 提取依赖
 *   node --import ./tools/e2e-loader.mjs tools/e2e-real-credentials.mjs
 */
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));

const SUITES = [
  { name: 'key 轮换池逻辑', file: 'test-rotate.mjs', args: [] },
  { name: '回环 shim 协议', file: 'test-shim.mjs', args: [] },
  { name: 'apply() 启动时序', file: 'test-apply.mjs', args: ['--import', './tools/stub-loader.mjs'] },
  { name: '凭据记录 schema', file: 'test-credentials-record.mjs', args: ['--import', './tools/stub-loader.mjs'] },
  { name: '启动期凭据竞态（issue #1）', file: 'test-credentials-race.mjs', args: ['--import', './tools/stub-loader.mjs'] },
  { name: 'Web 路由与令牌', file: 'test-routes.mjs', args: [] },
  { name: '浏览器半契约', file: 'test-client.mjs', args: [] },
  { name: '浏览器半渲染冒烟', file: 'test-client-render.mjs', args: [] },
];

let failed = 0;
const results = [];

for (const suite of SUITES) {
  process.stdout.write(`\n${'='.repeat(64)}\n${suite.name}  (${suite.file})\n${'='.repeat(64)}\n`);
  const result = spawnSync(process.execPath, [...suite.args, join(here, suite.file)], {
    stdio: 'inherit',
    cwd: join(here, '..'),
  });
  const ok = result.status === 0;
  if (!ok) failed += 1;
  results.push({ name: suite.name, ok });
}

console.log(`\n${'='.repeat(64)}\n汇总\n${'='.repeat(64)}`);
for (const r of results) console.log(`  ${r.ok ? 'PASS' : 'FAIL'}  ${r.name}`);
console.log(`\n${results.length - failed}/${results.length} 个测试套件通过\n`);
process.exit(failed === 0 ? 0 : 1);
