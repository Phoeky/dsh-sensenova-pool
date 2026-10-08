/**
 * 解析钩子：把 DSH 平台包替换成本地桩件。
 *
 * 由 `stub-loader.mjs` 通过 module.register() 注册；单独运行无效。
 */
import { pathToFileURL, fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));

const MAP = {
  '@deepseek-ai/schemastery': join(here, 'stubs', 'schemastery.mjs'),
  '@deepseek-ai/dsh-llm-pi-ai': join(here, 'stubs', 'dsh-llm-pi-ai.mjs'),
  '@deepseek-ai/dsh-llm': join(here, 'stubs', 'dsh-llm.mjs'),
  '@earendil-works/pi-ai': join(here, 'stubs', 'pi-ai.mjs'),
  '@earendil-works/pi-ai/api/openai-completions.lazy': join(here, 'stubs', 'pi-ai-openai.mjs'),
};

export async function resolve(specifier, context, next) {
  const hit = MAP[specifier];
  if (hit) return { url: pathToFileURL(hit).href, shortCircuit: true };
  return next(specifier, context);
}
