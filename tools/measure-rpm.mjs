/**
 * 测量单把 key 的真实 RPM 上限，用于设定合理的默认参数。
 *
 * 做法：串行发请求，记录每次的状态与时间戳，找出 429 出现的边界。
 */
const key = process.argv[2];
if (!key) { console.error('usage: node tools/measure-rpm.mjs <key>'); process.exit(2); }

const BASE = 'https://token.sensenova.cn/v1';
const N = 12;
const results = [];

console.log(`串行发送 ${N} 个请求，测量真实 RPM 边界...\n`);

for (let i = 0; i < N; i += 1) {
  const t0 = Date.now();
  let status = 0;
  let msg = '';
  try {
    const r = await fetch(`${BASE}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model: 'deepseek-v4-flash',
        messages: [{ role: 'user', content: `n${i}` }],
        max_tokens: 1,
      }),
      signal: AbortSignal.timeout(30000),
    });
    status = r.status;
    if (status !== 200) {
      const body = await r.text();
      try { msg = String(JSON.parse(body)?.error?.message ?? '').slice(0, 60); } catch { msg = body.slice(0, 60); }
    } else {
      await r.text();
    }
  } catch (e) {
    status = -1;
    msg = e.message;
  }
  const dt = Date.now() - t0;
  results.push({ i, status, dt });
  const mark = status === 200 ? 'OK  ' : 'FAIL';
  console.log(`  #${String(i).padStart(2)}  ${mark} ${String(status).padStart(4)}  ${String(dt).padStart(5)}ms  ${msg}`);
}

const ok = results.filter((r) => r.status === 200).length;
const limited = results.filter((r) => r.status === 429).length;
console.log(`\n成功 ${ok}/${N}，429 ${limited}/${N}`);
if (ok > 0) {
  const span = (results[results.length - 1].i - results[0].i);
  console.log(`在 ${span + 1} 次连续请求中成功 ${ok} 次 → 观察到约 ${ok} RPM 量级`);
}
