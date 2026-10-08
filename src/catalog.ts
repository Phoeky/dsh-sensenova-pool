/**
 * 商汤日日新（SenseNova）模型目录与上游错误分类。
 *
 * 目录来自 `GET https://token.sensenova.cn/v1/models` 的实测结果（2026-10）。
 * 这里固化一份「保守基线」，用途有二：
 *   1. 插件启动时即可注册模型（不需要网络），实现真正的开箱可用；
 *   2. 拿到有效 key 后，用 `/v1/models` 的结果覆盖它，因此新模型无需改代码。
 */

export interface SenseNovaModel {
  id: string;
  name: string;
  contextWindow: number;
  maxTokens: number;
  /** 是否支持图片输入。 */
  supportsImages: boolean;
  /** 是否为「只推理」模型（无法关闭思考）。 */
  reasoning: boolean;
}

/**
 * 内置基线目录（实测自 token.sensenova.cn）。
 *
 * contextWindow 严格取自 `context_length`，maxTokens 取自 `max_output_length`。
 * 刻意不写 `sensenova-u1-fast` / `sensenova-u1.5-lite`：它们实测返回 404
 * （`output_modalities: ["image"]`，属图像生成模型，不是对话模型），列出来只会
 * 让用户选到必然失败的模型。
 */
export const BUILTIN_MODELS: readonly SenseNovaModel[] = [
  { id: 'deepseek-v4.1-flash', name: 'DeepSeek V4.1 Flash', contextWindow: 1048576, maxTokens: 65536, supportsImages: false, reasoning: true },
  { id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash', contextWindow: 1048576, maxTokens: 65536, supportsImages: false, reasoning: true },
  { id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro', contextWindow: 1048576, maxTokens: 65536, supportsImages: false, reasoning: true },
  { id: 'deepseek-flash', name: 'DeepSeek Flash', contextWindow: 1048576, maxTokens: 65536, supportsImages: false, reasoning: true },
  { id: 'glm-5.2', name: 'GLM-5.2', contextWindow: 1048576, maxTokens: 131072, supportsImages: false, reasoning: true },
  { id: 'kimi-k3', name: 'Kimi K3', contextWindow: 1048576, maxTokens: 65536, supportsImages: false, reasoning: true },
  { id: 'sensenova-6.8-flash-lite', name: 'SenseNova 6.8 Flash-Lite', contextWindow: 262144, maxTokens: 65536, supportsImages: true, reasoning: true },
];

export const DEFAULT_BASE_URL = 'https://token.sensenova.cn/v1';

/** `/v1/models` 返回的条目形状（只声明用到的字段）。 */
interface RawModelEntry {
  id?: unknown;
  name?: unknown;
  context_length?: unknown;
  max_output_length?: unknown;
  input_modalities?: unknown;
  supported_features?: unknown;
}

/**
 * 把 `/v1/models` 的原始响应解析成目录。
 *
 * 宽容解析：字段缺失就回落到基线/默认值，任何一条坏数据都不应该让整个目录失败。
 */
export function parseModelCatalog(payload: unknown): SenseNovaModel[] {
  const data = (payload as { data?: unknown })?.data;
  if (!Array.isArray(data)) return [];
  const out: SenseNovaModel[] = [];
  for (const raw of data as RawModelEntry[]) {
    const id = typeof raw?.id === 'string' ? raw.id.trim() : '';
    if (!id) continue;
    const modalities = Array.isArray(raw.input_modalities) ? raw.input_modalities : [];
    const features = Array.isArray(raw.supported_features) ? raw.supported_features : [];
    const baseline = BUILTIN_MODELS.find((model) => model.id === id);
    // 只保留文本输出模型：图像生成模型（output_modalities 无 text）无法用于对话。
    const outputs = Array.isArray((raw as { output_modalities?: unknown }).output_modalities)
      ? ((raw as { output_modalities: unknown[] }).output_modalities as unknown[])
      : undefined;
    if (outputs && outputs.length > 0 && !outputs.includes('text')) continue;
    out.push({
      id,
      name: typeof raw.name === 'string' && raw.name.trim() ? raw.name.trim() : id,
      contextWindow:
        typeof raw.context_length === 'number' && raw.context_length > 0
          ? raw.context_length
          : baseline?.contextWindow ?? 262144,
      maxTokens:
        typeof raw.max_output_length === 'number' && raw.max_output_length > 0
          ? raw.max_output_length
          : baseline?.maxTokens ?? 32768,
      supportsImages: modalities.includes('image'),
      reasoning: features.includes('reasoning'),
    });
  }
  return out;
}

// ---------------------------------------------------------------- 错误分类

export type UpstreamErrorKind =
  | 'rate_limit'
  | 'invalid_credential'
  | 'not_found'
  | 'server'
  | 'client';

export interface ClassifiedError {
  kind: UpstreamErrorKind;
  status: number;
  message: string;
  /** 服务端建议的重试等待毫秒数（来自 Retry-After）。 */
  retryAfterMs?: number;
}

/**
 * 解析 Retry-After（秒数或 HTTP-date）。
 *
 * 商汤实测**不返回** Retry-After，所以这只是尽力而为；真正决定冷却时长的是
 * keypool 的指数退避。
 */
export function parseRetryAfter(header: string | null): number | undefined {
  if (!header) return undefined;
  const trimmed = header.trim();
  if (!trimmed) return undefined;
  const seconds = Number(trimmed);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000);
  const date = Date.parse(trimmed);
  if (!Number.isNaN(date)) return Math.max(0, date - Date.now());
  return undefined;
}

/** 从响应体里尽力提取人类可读的错误消息。 */
export function extractErrorMessage(body: string): string {
  if (!body) return '';
  try {
    const parsed = JSON.parse(body) as { error?: { message?: unknown }; message?: unknown };
    const message = parsed?.error?.message ?? parsed?.message;
    if (typeof message === 'string') return message;
  } catch {
    // 非 JSON：退化为截断的原文。
  }
  return body.slice(0, 400);
}

/**
 * 把上游 HTTP 状态分类成轮换决策所需的语义。
 *
 * 关键判定（实测商汤行为）：
 * - 429 `ModelAccountTpmRateLimitExceeded` → 限流，**换 key 重试**。
 * - 401/403 `permission_denied_error` (code 7) → 该 key 对该模型无权限。
 *   注意：这**不代表 key 失效**，只代表这个模型不在当前套餐里；因此归类为
 *   `client`（不冷却、不换 key 空转），而不是 `invalid_credential`。
 *   实测 `deepseek-v4.1-flash` 对现有 key 返回 403，而 `glm-5.2` 返回 200。
 * - 403 若消息含鉴权字样（invalid api key 等）才算凭据失效。
 * - 404 → 模型不存在，换 key 也没用。
 * - 5xx → 上游抖动，短冷却后重试。
 */
export function classifyError(status: number, body: string, retryAfterHeader?: string | null): ClassifiedError {
  const message = extractErrorMessage(body);
  const retryAfterMs = parseRetryAfter(retryAfterHeader ?? null);
  const lower = message.toLowerCase();

  if (status === 429) return { kind: 'rate_limit', status, message, retryAfterMs };

  if (status === 401) return { kind: 'invalid_credential', status, message };

  if (status === 403) {
    // 只有在消息明确指向凭据问题时才算 key 失效；
    // 「model is not available in the current token plan」是套餐/权限问题。
    const credentialish =
      lower.includes('invalid api key') ||
      lower.includes('api key') && lower.includes('invalid') ||
      lower.includes('unauthorized') ||
      lower.includes('authentication') ||
      lower.includes('invalid_authentication');
    if (credentialish) return { kind: 'invalid_credential', status, message };
    return { kind: 'client', status, message };
  }

  if (status === 404) return { kind: 'not_found', status, message };
  if (status >= 500) return { kind: 'server', status, message };
  return { kind: 'client', status, message };
}

/**
 * 该错误是否值得「换一把 key 再试」。
 *
 * - `rate_limit`：本插件存在的理由 —— 必须换。
 * - `server`：上游抖动，换一把往往就好了。
 * - `invalid_credential`：这一把废了，但**池里其他 key 仍然可用**，所以必须继续
 *   换下一把。若在这里放弃，只要池里混进一把坏 key，整个池子就会连带不可用 ——
 *   那正是「池」要避免的事。
 * - `not_found` / `client`（含 403 套餐不含该模型）：换 key 解决不了，立即上报。
 */
export function isRetryableAcrossKeys(kind: UpstreamErrorKind): boolean {
  return kind === 'rate_limit' || kind === 'server' || kind === 'invalid_credential';
}
