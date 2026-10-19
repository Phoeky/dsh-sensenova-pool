/**
 * 最强验证：**本插件真实的 apply()**（lib/index.js）+ **真实 cordis** +
 * **真实 credentials-local**，在一个真实的 `.credentials.yaml` 上跑完整启动路径。
 *
 * 与 tools/test-credentials-race.mjs 的分工：
 *   - 那个测试用桩件复刻 cordis 语义，快、离线、可进 `npm test`；
 *   - 这个测试用真家伙验证「桩件复刻的语义与真实实现一致」，并证明插件的
 *     启动路径在真实凭据提供者下确实能把 key 装载出来。
 *
 * 平台包（dsh-llm-pi-ai / dsh-llm / pi-ai）仍走桩件，因为它们属于 DSH 宿主
 * 私有契约；本测试要验的是**凭据时序**，不是 provider 注册。schemastery 则必须
 * 用**真实**实现（credentials-local 需要它的完整链式 API），因此用 e2e-loader。
 *
 * 前置：先跑 `node tools/e2e-extract-deps.mjs` 提取真实凭据链。
 * 运行：node --import ./tools/e2e-loader.mjs tools/e2e-real-credentials.mjs
 */
import { mkdtempSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const deps = join(repoRoot, '_e2e', 'node_modules');
const mod = (specifier) => pathToFileURL(join(deps, ...specifier.split('/'), 'lib', 'index.js')).href;

if (!existsSync(join(deps, '@deepseek-ai', 'dsh-credentials-local'))) {
  console.error('缺少真实凭据链依赖，请先运行：node tools/e2e-extract-deps.mjs');
  process.exit(2);
}

const { Context, Service } = await import(mod('@deepseek-ai/cordis'));
const { default: LocalCredentialProvider } = await import(
  pathToFileURL(join(deps, '@deepseek-ai', 'dsh-credentials-local', 'lib', 'index.js')).href
);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0;
let fail = 0;
const check = (n, c, d = '') => {
  c ? (pass++, console.log(`  PASS  ${n}`)) : (fail++, console.log(`  FAIL  ${n}${d ? ' — ' + d : ''}`));
};

// 插件会对外网拉模型目录；测试不该联网。
const realFetch = globalThis.fetch;
globalThis.fetch = async () => {
  throw new Error('offline: outbound fetch stubbed');
};

// ---- 真实的 .credentials.yaml ----------------------------------------------
const dshHome = mkdtempSync(join(tmpdir(), 'dsh-plugin-e2e-'));
mkdirSync(dshHome, { recursive: true });
const credentialsFile = join(dshHome, '.credentials.yaml');
const KEYS = ['sk-plugine2e00000000000001', 'sk-plugine2e00000000000002'];
writeFileSync(
  credentialsFile,
  `version: 1
records:
  dsh-sensenova-pool/keys:
    kind: grant
    payload:
      keys:
${KEYS.map((k) => `        - ${k}`).join('\n')}
`,
  'utf8',
);

/** 真实 cordis 上的 llm 服务替身（插件只用到 registerAdapter）。 */
class FakeLlm extends Service {
  constructor(ctx) {
    super(ctx, 'llm');
    this.registered = [];
  }
  registerAdapter(routes, adapter) {
    this.registered.push({ routes, adapter });
    return Object.assign(() => {}, { replace: () => {} });
  }
}

/** webServer 替身：记录插件挂载的路由。 */
class FakeWebServer extends Service {
  constructor(ctx) {
    super(ctx, 'webServer');
    this.routes = new Map();
  }
  register({ path, handler }) {
    this.routes.set(path, handler);
    return () => this.routes.delete(path);
  }
}

const root = new Context();
root.plugin(FakeLlm);
root.plugin(FakeWebServer);
// watch:false —— 只走 loadInitial()，避免 chokidar 干扰。
root.plugin(LocalCredentialProvider, { path: credentialsFile, dshHome, watch: false });

// 真实插件模块（ESM）。
const plugin = await import(pathToFileURL(join(repoRoot, 'lib', 'index.js')).href);

const logs = { info: [], warn: [], error: [] };

// 捕获插件日志：不覆盖 ctx.logger（cordis 的代理禁止直接赋值），
// 而是包一层真实 logger 的方法，写入 logs 后放行到原实现。
const originalLogger = root.logger;
for (const level of ['info', 'warn', 'error']) {
  const original = originalLogger[level].bind(originalLogger);
  originalLogger[level] = (...args) => {
    logs[level].push(args.map(String).join(' '));
    return original(...args);
  };
}

const fiber = root.plugin({
  name: plugin.name,
  inject: plugin.inject,
  apply: (ctx, config) => plugin.apply(ctx, config),
});

await fiber;
// 给启动块（listen + 注册 + 凭据就绪 + 装载）留足时间。
await sleep(2500);

const llm = root.get('llm');
const webServer = root.get('webServer');

console.log('\n[e2e-plugin] 真实插件 + 真实 cordis + 真实 credentials-local');
console.log(`    info 日志：${JSON.stringify(logs.info)}`);
if (logs.warn.length) console.log(`    warn 日志：${JSON.stringify(logs.warn)}`);
if (logs.error.length) console.log(`    error 日志：${JSON.stringify(logs.error)}`);

check('插件完成启动，无 error 日志', logs.error.length === 0, JSON.stringify(logs.error));
check('注册了 provider 路由', llm?.registered?.[0]?.routes?.[0] === 'sensenova-pool', JSON.stringify(llm?.registered?.map((r) => r.routes)));
check('挂载了 key 管理路由', webServer?.routes?.has('/plugins/dsh-sensenova-pool/keys') === true, JSON.stringify([...webServer?.routes?.keys() ?? []]));

const loaded = logs.info.find((m) => m.includes('已装载'));
check('从真实凭据文件装载出 2 把 key（核心）', typeof loaded === 'string' && loaded.includes('2'), JSON.stringify(logs.info));
check('未误报「key 池为空」', !logs.info.some((m) => m.includes('key 池为空')), JSON.stringify(logs.info));

// ---- 通过插件自己的 /status 路由确认池子内容 --------------------------------
if (webServer?.routes?.has('/plugins/dsh-sensenova-pool/status')) {
  const handler = webServer.routes.get('/plugins/dsh-sensenova-pool/status');
  const captured = await new Promise((resolve) => {
    const req = { method: 'GET', headers: { host: '127.0.0.1' } };
    const res = {
      writeHead() {},
      end(body) { resolve(body); },
    };
    Promise.resolve(handler(req, res)).catch(() => resolve('{}'));
  });
  let status = {};
  try { status = JSON.parse(captured); } catch { /* ignore */ }
  check('/status 报告池里有 2 把 key', status?.summary?.total === 2, JSON.stringify(status?.summary));
  check('/status 的 key 均已脱敏（不含明文）', (status?.keys ?? []).every((k) => !KEYS.includes(k.key)), JSON.stringify(status?.keys?.map((k) => k.key)));

  // 0.2.0 新增：对外接入信息与模型可见性。这里用**真实** shim，端口应真实可连。
  check(
    '/status 给出回环接口地址',
    typeof status?.endpoint?.baseUrl === 'string' && status.endpoint.baseUrl.startsWith('http://127.0.0.1:'),
    JSON.stringify(status?.endpoint),
  );
  check('接口地址的端口与 shim 实际监听一致', (() => {
    const port = Number(new URL(status.endpoint.baseUrl).port);
    return Number.isInteger(port) && port > 0 && status.endpoint.port === port;
  })(), JSON.stringify(status?.endpoint));
  check(
    '/status 给出对外 API Key',
    typeof status?.endpoint?.apiKey === 'string' && status.endpoint.apiKey.startsWith('sk-dsh-'),
    String(status?.endpoint?.apiKey),
  );
  check(
    '对外 API Key 与商汤 key 无关',
    !KEYS.includes(status?.endpoint?.apiKey),
    String(status?.endpoint?.apiKey),
  );
  check(
    '/status 列出模型且都带 enabled 标记',
    Array.isArray(status?.models) && status.models.length > 0 && status.models.every((m) => typeof m.enabled === 'boolean'),
    JSON.stringify(status?.models?.slice(0, 2)),
  );
}

globalThis.fetch = realFetch;
await root.fiber.dispose();

console.log(`\n=== ${pass} passed, ${fail} failed ===\n`);
process.exitCode = fail === 0 ? 0 : 1;
