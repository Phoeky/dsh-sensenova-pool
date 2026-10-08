/**
 * 轮换池的端到端离线测试：用假的 fetch 注入 429 / 403 / 404 / 5xx，
 * 验证「遇 429 切下一把 key」的核心承诺。
 *
 * 运行：node tools/test-rotate.mjs
 */
import { KeyPool } from '../lib/keypool.js';
import { requestWithRotation } from '../lib/rotate.js';
import { classifyError, parseModelCatalog, BUILTIN_MODELS } from '../lib/catalog.js';

let passed = 0;
let failed = 0;

function check(name, condition, detail = '') {
  if (condition) {
    passed += 1;
    console.log(`  PASS  ${name}`);
  } else {
    failed += 1;
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

function jsonResponse(status, body, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

const RATE_LIMIT_BODY = { error: { message: 'inference exceeds tpm/rpm limit', type: 'rate_limit_error', code: 'ModelAccountTpmRateLimitExceeded' } };
const PLAN_BODY = { error: { message: 'model is not available in the current token plan', type: 'permission_denied_error', code: '7' } };
const NOT_FOUND_BODY = { error: { message: 'model is not found', type: 'not_found_error', code: '5' } };
const AUTH_BODY = { error: { message: 'invalid api key', type: 'authentication_error', code: '8' } };

const FAST = { maxAttempts: 5, acquireTimeoutMs: 2000, requestTimeoutMs: 2000, retryServerErrors: true };

console.log('\n[1] 429 后会切到下一把 key，且最终成功');
{
  const pool = new KeyPool(['sk-aaaa1111', 'sk-bbbb2222', 'sk-cccc3333']);
  const seen = [];
  const result = await requestWithRotation(
    pool,
    FAST,
    async (apiKey) => {
      seen.push(apiKey);
      // 前两把限流，第三把成功。
      if (apiKey === 'sk-aaaa1111' || apiKey === 'sk-bbbb2222') return jsonResponse(429, RATE_LIMIT_BODY);
      return jsonResponse(200, { ok: true });
    },
  );
  check('最终成功', result.ok === true);
  check('用了 3 次尝试', result.attempts === 3, `attempts=${result.attempts}`);
  check('轮换了 3 把不同的 key', new Set(seen).size === 3, JSON.stringify(seen));
  const snap = pool.snapshot();
  check('两把 key 进入冷却', snap.filter((k) => k.status === 'cooldown').length === 2);
  check('一把 key 仍健康', snap.filter((k) => k.status === 'healthy').length === 1);
  check('429 计数正确', snap.filter((k) => k.stats.rateLimited === 1).length === 2);
}

console.log('\n[2] 全部 key 都 429 时如实失败，不伪装成功');
{
  const pool = new KeyPool(['sk-1111', 'sk-2222']);
  const result = await requestWithRotation(pool, { ...FAST, maxAttempts: 2 }, async () =>
    jsonResponse(429, RATE_LIMIT_BODY),
  );
  check('fail', result.ok === false);
  check('kind=rate_limit', result.error.kind === 'rate_limit', result.error.kind);
  check('尝试了 2 把', result.attempts === 2, `attempts=${result.attempts}`);
}

console.log('\n[3] 403「套餐不含该模型」不换 key 空转，立即上报');
{
  const pool = new KeyPool(['sk-aaaa', 'sk-bbbb', 'sk-cccc']);
  const seen = [];
  const result = await requestWithRotation(pool, FAST, async (apiKey) => {
    seen.push(apiKey);
    return jsonResponse(403, PLAN_BODY);
  });
  check('fail', result.ok === false);
  check('kind=client（不是 invalid_credential）', result.error.kind === 'client', result.error.kind);
  check('只试了 1 把，没有空转整池', seen.length === 1, `tried=${seen.length}`);
  check('key 没有被标记失效', pool.summary().invalid === 0);
}

console.log('\n[4] 403「invalid api key」标记该 key 失效并换下一把');
{
  const pool = new KeyPool(['sk-badkey', 'sk-goodkey']);
  const result = await requestWithRotation(pool, FAST, async (apiKey) =>
    apiKey === 'sk-badkey' ? jsonResponse(403, AUTH_BODY) : jsonResponse(200, { ok: true }),
  );
  check('坏 key 之后仍能成功（池里混入坏 key 不拖垮全池）', result.ok === true);
  check('坏 key 已标记失效', pool.summary().invalid === 1, JSON.stringify(pool.summary()));
  check('用了 2 次尝试', result.attempts === 2, `attempts=${result.attempts}`);
}

console.log('\n[4b] 池里全是坏 key 时如实失败');
{
  const pool = new KeyPool(['sk-bad1', 'sk-bad2']);
  const result = await requestWithRotation(pool, FAST, async () => jsonResponse(403, AUTH_BODY));
  check('fail', result.ok === false);
  check('两把都标记失效', pool.summary().invalid === 2, JSON.stringify(pool.summary()));
  check('上报的是鉴权失败', result.error.kind === 'invalid_credential', result.error.kind);
}

console.log('\n[5] 404 模型不存在：不轮换，直接上报');
{
  const pool = new KeyPool(['sk-aaaa', 'sk-bbbb']);
  const seen = [];
  const result = await requestWithRotation(pool, FAST, async (apiKey) => {
    seen.push(apiKey);
    return jsonResponse(404, NOT_FOUND_BODY);
  });
  check('kind=not_found', result.error.kind === 'not_found', result.error.kind);
  check('只试了 1 把', seen.length === 1);
}

console.log('\n[6] 5xx 换 key 重试，网络异常也换 key');
{
  const pool = new KeyPool(['sk-aaaa', 'sk-bbbb']);
  const result = await requestWithRotation(pool, FAST, async (apiKey) => {
    if (apiKey === 'sk-aaaa') throw new Error('ECONNRESET');
    return jsonResponse(200, { ok: true });
  });
  check('网络错误后换 key 成功', result.ok === true);
  check('尝试 2 次', result.attempts === 2, `attempts=${result.attempts}`);
}

console.log('\n[7] 冷却中的 key 不会被再次选中');
{
  const pool = new KeyPool(['sk-aaaa', 'sk-bbbb']);
  const entry = pool.find('sk-aaaa');
  pool.reportRateLimit(entry, 60000); // 冷却 60s
  const used = [];
  const result = await requestWithRotation(pool, { ...FAST, maxAttempts: 1 }, async (apiKey) => {
    used.push(apiKey);
    return jsonResponse(200, { ok: true });
  });
  check('成功', result.ok === true);
  check('只用健康的那把', used[0] === 'sk-bbbb', JSON.stringify(used));
}

console.log('\n[8] 本地 RPM 预限流：窗口满后不再选中该 key');
{
  const pool = new KeyPool(['sk-aaaa'], { rpmLimit: 2 });
  const entry = pool.find('sk-aaaa');
  // 手动灌满 60s 窗口。
  for (let i = 0; i < 2; i += 1) {
    entry.window.push(Date.now());
  }
  let acquired = true;
  try {
    await pool.acquire({ timeoutMs: 120 });
  } catch {
    acquired = false;
  }
  check('额度用尽后 acquire 超时（主动避让而非硬打）', acquired === false);
}

console.log('\n[9] 错误分类矩阵');
{
  check('429 → rate_limit', classifyError(429, JSON.stringify(RATE_LIMIT_BODY)).kind === 'rate_limit');
  check('401 → invalid_credential', classifyError(401, '{}').kind === 'invalid_credential');
  check('403 套餐 → client', classifyError(403, JSON.stringify(PLAN_BODY)).kind === 'client');
  check('403 鉴权 → invalid_credential', classifyError(403, JSON.stringify(AUTH_BODY)).kind === 'invalid_credential');
  check('404 → not_found', classifyError(404, JSON.stringify(NOT_FOUND_BODY)).kind === 'not_found');
  check('503 → server', classifyError(503, 'oops').kind === 'server');
  check('Retry-After 秒 → ms', classifyError(429, '{}', '12').retryAfterMs === 12000);
}

console.log('\n[10] 目录解析：过滤图像生成模型，保留上下文窗口');
{
  const parsed = parseModelCatalog({
    data: [
      { id: 'deepseek-v4.1-flash', name: 'DeepSeek V4.1 Flash', context_length: 1048576, max_output_length: 65536, input_modalities: ['text'], output_modalities: ['text'], supported_features: ['tools', 'reasoning'] },
      { id: 'sensenova-u1-fast', name: 'U1 Fast', context_length: 262144, output_modalities: ['image'], input_modalities: ['text'] },
      { id: 'sensenova-6.8-flash-lite', context_length: 262144, max_output_length: 65536, input_modalities: ['text', 'image'], output_modalities: ['text'] },
    ],
  });
  check('过滤掉图像生成模型', parsed.length === 2, `got ${parsed.length}`);
  check('保留 1M 上下文', parsed[0].contextWindow === 1048576);
  check('识别图片输入', parsed.find((m) => m.id === 'sensenova-6.8-flash-lite')?.supportsImages === true);
  check('缺 name 时回落 id', parsed.find((m) => m.id === 'sensenova-6.8-flash-lite')?.name === 'sensenova-6.8-flash-lite');
  check('内置基线非空', BUILTIN_MODELS.length > 0);
}

console.log('\n[11] 脱敏：日志里不出现完整 key');
{
  const { maskKey } = await import('../lib/keypool.js');
  const secret = 'sk-abcdefghijklmnopqrstuvwxyz012345';
  const masked = maskKey(secret);
  check('脱敏后不含完整 key', !masked.includes(secret));
  // 长 key 保留前 6 后 4，足以区分不同 key 又不泄漏原文。
  check('保留前 6 后 4', masked === `${secret.slice(0, 6)}...${secret.slice(-4)}`, masked);
  check('长度不短于原文 1/3（仍可人工辨认）', masked.length >= 13, masked);
}

console.log(`\n=== ${passed} passed, ${failed} failed ===\n`);
process.exit(failed === 0 ? 0 : 1);
