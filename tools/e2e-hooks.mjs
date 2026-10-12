/**
 * e2e 专用解析钩子：只把**平台 provider 包**换成桩件，
 * 让 `@deepseek-ai/schemastery` 等仍解析到**真实**实现。
 *
 * 为什么不能直接用 tools/stub-loader.mjs：那个 loader 连 schemastery 一起桩掉，
 * 而真实的 credentials-local 需要 schemastery 的完整链式 API（`.min()` 等）。
 * 本 e2e 要验的是凭据时序，因此只桩掉与本测试无关的 provider 契约。
 */
import { pathToFileURL, fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const stubs = join(here, 'stubs');

const MAP = {
  '@deepseek-ai/dsh-llm-pi-ai': join(stubs, 'dsh-llm-pi-ai.mjs'),
  '@deepseek-ai/dsh-llm': join(stubs, 'dsh-llm.mjs'),
  '@earendil-works/pi-ai': join(stubs, 'pi-ai.mjs'),
  '@earendil-works/pi-ai/api/openai-completions.lazy': join(stubs, 'pi-ai-openai.mjs'),
};

export async function resolve(specifier, context, next) {
  const hit = MAP[specifier];
  if (hit) return { url: pathToFileURL(hit).href, shortCircuit: true };
  return next(specifier, context);
}
