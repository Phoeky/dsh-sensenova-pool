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
  /**
   * 基线窗口是否**覆盖**上游 `/v1/models` 的 `context_length`（issue #4）。
   *
   * 只给「实测确认上游报小了」的模型打开；默认 false（以上游为准，保住「新模型
   * 无需改代码」）。打开时必须在 {@link BUILTIN_MODELS} 的注释里写清实测依据与
   * 日期 —— 上游一旦把真实上限调小，这类覆盖就会变成超窗错误（400/413）的来源。
   *
   * 用户在设置页里给某个模型自定义的窗口优先级更高，见 index.ts 的 modelLimits。
   */
  contextWindowOverridesUpstream?: boolean;
}

/**
 * 内置基线目录（实测自 token.sensenova.cn）。
 *
 * contextWindow 严格取自 `context_length`，maxTokens 取自 `max_output_length`。
 * 不含 `sensenova-u1-fast` / `sensenova-u1.5-lite`：**中国站的 /v1/models 本来就不列
 * 这两个生图模型**（基线只镜像上游列出的内容；国际站的目录里它们有，见
 * {@link INTL_BUILTIN_MODELS}）。拿到 key 后刷新的目录同样不做任何筛选。
 *
 * 这是**中国站**的目录。国际站的目录不同，见 {@link INTL_BUILTIN_MODELS}。
 */
export const BUILTIN_MODELS: readonly SenseNovaModel[] = [
  { id: 'deepseek-v4.1-flash', name: 'DeepSeek V4.1 Flash', contextWindow: 1048576, maxTokens: 65536, supportsImages: false, reasoning: true },
  { id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash', contextWindow: 1048576, maxTokens: 65536, supportsImages: false, reasoning: true },
  { id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro', contextWindow: 1048576, maxTokens: 65536, supportsImages: false, reasoning: true },
  { id: 'deepseek-flash', name: 'DeepSeek Flash', contextWindow: 1048576, maxTokens: 65536, supportsImages: false, reasoning: true },
  { id: 'glm-5.2', name: 'GLM-5.2', contextWindow: 1048576, maxTokens: 131072, supportsImages: false, reasoning: true },
  { id: 'kimi-k3', name: 'Kimi K3', contextWindow: 1048576, maxTokens: 65536, supportsImages: false, reasoning: true },
  // 上游 /v1/models 对它报 context_length=262144，实测约 1M：2026-11-17 直连
  // 上游逐级加压，prompt_tokens=1,047,536 仍 200、≈1.05M 才 400 —— 边界正好落在
  // 2^20（1,048,576）。必须盖掉上游值，否则整条链路（插件 → DSH → 压缩代理）
  // 只按 256K 算，长会话在 20% 左右就开始压缩折叠（issue #4）。
  { id: 'sensenova-6.8-flash', name: 'SenseNova 6.8 Flash', contextWindow: 1048576, maxTokens: 65536, supportsImages: true, reasoning: true, contextWindowOverridesUpstream: true },
  // 对照组：同样报 262144，但实测 257,013 tokens 通过、275K 档就 400 —— 这是真值。
  { id: 'sensenova-6.8-flash-lite', name: 'SenseNova 6.8 Flash-Lite', contextWindow: 262144, maxTokens: 65536, supportsImages: true, reasoning: true },
];

// ------------------------------------------------------------------ 端点

/** 端点标识：'cn' = 中国站，'intl' = 国际站。 */
export type EndpointId = 'cn' | 'intl';

export interface SenseNovaEndpoint {
  id: EndpointId;
  /** 显示名（中英文一致：网页端点本身没有语言）。 */
  label: string;
  /** OpenAI 兼容根地址（含 `/v1`）。 */
  baseUrl: string;
}

/**
 * 可选的上游端点。
 *
 * 商汤分两个独立的 API 站点，**key 不通用**（在哪个站注册的 key 只能打哪个站），
 * 所以端点必须是用户自己的选择，不能靠「挨个试」自动判定 —— 拿 A 站的 key 打
 * B 站只会得到 401，而池子会把这把本来好用的 key 标成失效。
 *
 * 默认 'cn' 是刻意的：老用户的 key 与配置都指向中国站，升级后行为必须不变。
 */
export const ENDPOINTS: readonly SenseNovaEndpoint[] = [
  { id: 'cn', label: '中国站', baseUrl: 'https://token.sensenova.cn/v1' },
  { id: 'intl', label: '国际站', baseUrl: 'https://token.sensenova.ai/v1' },
];

export const DEFAULT_ENDPOINT_ID: EndpointId = 'cn';

/** 端点 id 归一；认不出来时回落到默认端点。 */
export function isEndpointId(value: unknown): value is EndpointId {
  return value === 'cn' || value === 'intl';
}

/** 按 id 取端点定义；未知 id 回落到默认端点。 */
export function endpointFor(id: unknown): SenseNovaEndpoint {
  const found = ENDPOINTS.find((endpoint) => endpoint.id === id);
  return found ?? (ENDPOINTS.find((endpoint) => endpoint.id === DEFAULT_ENDPOINT_ID) as SenseNovaEndpoint);
}

/** 默认上游根地址（中国站）。 */
export const DEFAULT_BASE_URL = endpointFor(DEFAULT_ENDPOINT_ID).baseUrl;

/**
 * 国际站（token.sensenova.ai）的内置基线目录 —— 与上游 `/v1/models` 一一对应，
 * **不做任何筛选**：上游列了什么，这里就有什么。
 *
 * 2026-11-19 用真实国际站 key 实测的可用性（供参考，不决定是否展示）：
 *
 * - `sensenova-6.8-flash` / `sensenova-6.8-flash-lite` —— 对话、流式、图片输入、
 *   七档 `reasoning_effort` 全部 200。
 * - `sensenova-6.7-flash-lite` —— `/v1/models` 声明 `output_modalities: ["text"]`（是多模态
 *   对话模型），但本 key 对话请求多次返回 404 `model is not found`。仍然列出：
 *   可能是该 key 的套餐/灰度差异，隐藏它会让有权限的用户也选不到。选中后上游会
 *   如实报 404，在设置页取消勾选即可隐藏。
 * - `sensenova-u1-fast` / `sensenova-u1.5-lite` —— 生图模型（`output_modalities: ["image"]`），
 *   对话接口返回 404。同样列出，理由同上。
 *
 * 窗口沿用上游报的 262144：国际站**没有**国内站 issue #4 那种「报小 4 倍」的实测
 * 证据，因此不设 `contextWindowOverridesUpstream`，以拿到 key 后刷新的上游值为准。
 */
export const INTL_BUILTIN_MODELS: readonly SenseNovaModel[] = [
  { id: 'sensenova-6.8-flash', name: 'SenseNova 6.8 Flash', contextWindow: 262144, maxTokens: 65536, supportsImages: true, reasoning: true },
  { id: 'sensenova-6.8-flash-lite', name: 'SenseNova 6.8 Flash-Lite', contextWindow: 262144, maxTokens: 65536, supportsImages: true, reasoning: true },
  { id: 'sensenova-6.7-flash-lite', name: 'SenseNova 6.7 Flash-Lite', contextWindow: 262144, maxTokens: 65536, supportsImages: true, reasoning: true },
  // 生图模型：上游列在 /v1/models 里，这里也照常列出（对话接口会 404）。
  { id: 'sensenova-u1-fast', name: 'SenseNova U1 Fast', contextWindow: 262144, maxTokens: 65536, supportsImages: false, reasoning: true },
  { id: 'sensenova-u1.5-lite', name: 'SenseNova U1.5 Lite', contextWindow: 262144, maxTokens: 65536, supportsImages: false, reasoning: true },
];

/** 该端点的内置基线目录。 */
export function builtinModelsFor(endpointId: unknown): readonly SenseNovaModel[] {
  return endpointFor(endpointId).id === 'intl' ? INTL_BUILTIN_MODELS : BUILTIN_MODELS;
}

// --------------------------------------------------------- 推理档位（issue #3）

/**
 * 商汤 `reasoning_effort` 的合法拼写，按推理强度从弱到强排列。
 *
 * 上游的 400 原文把七档列得很全（`field ReasoningEffort invalid, should be one
 * of: none, minimal, low, medium, high, xhigh, max`），但**每个模型实际接受的
 * 子集不同**：`glm-5.3` 只认 `low / high / max`，发 `xhigh` 直接 400；而
 * `glm-5.2`、`deepseek-v4-flash` 七档全收（issue #3 的逐模型实测矩阵）。
 *
 * 所以「哪几个值安全」不是全局属性 —— 一张全局映射表无论怎么调都会踩到某一头。
 * 这里改成按模型维护词表，见 {@link MODEL_REASONING_EFFORTS}。
 */
export const REASONING_EFFORTS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;
export type ReasoningEffort = (typeof REASONING_EFFORTS)[number];

/**
 * DSH（pi-ai）侧的思考档位名，同样从弱到强。
 *
 * 与 {@link REASONING_EFFORTS} 一一对应，只差一个拼写：DSH 的 `off` 商汤
 * 写作 `none`。
 */
export const THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;
export type ThinkingLevel = (typeof THINKING_LEVELS)[number];

/**
 * 每个模型**实测**接受的上游 `reasoning_effort` 词表
 * （issue #3，2026-11-14 对 `token.sensenova.cn` 逐个模型逐个档位实测，
 * 撞 429 的格子已重试排除）。
 *
 * 「未确认」的档位**不写进来**：写漏顶多把这一档就近归位到合法档，写多了会让
 * 整条链路每次都 400 —— 用户会直接无法使用该模型。
 *
 * 本表**按模型 id 查**，不依赖 {@link BUILTIN_MODELS}：`/v1/models` 动态目录里
 * 新出现的模型（例如目前还不在基线目录里的 `glm-5.3`）只要这里补一行就生效。
 *
 * 没列在这里的模型（新上架、或本文写作时还未实测的）走
 * {@link DEFAULT_REASONING_EFFORTS}；补词表是唯一需要做的维护动作。
 */
export const MODEL_REASONING_EFFORTS: Readonly<Record<string, readonly ReasoningEffort[]>> = {
  /** 只认三档；`none` / `minimal` / `medium` / `xhigh` 实测全部 400。 */
  'glm-5.3': ['low', 'high', 'max'],
  /** 七档全收。 */
  'glm-5.2': REASONING_EFFORTS,
  'deepseek-v4-flash': REASONING_EFFORTS,
  'sensenova-6.8-flash': REASONING_EFFORTS,
  'sensenova-6.8-flash-lite': REASONING_EFFORTS,
  /** `max` 多次重试仍撞 429，未确认 → 不发。 */
  'kimi-k3': ['none', 'minimal', 'low', 'medium', 'high', 'xhigh'],
  /** `xhigh` 未确认 → 不发。 */
  'deepseek-flash': ['none', 'minimal', 'low', 'medium', 'high', 'max'],
};

/**
 * 未实测模型的保守词表：只用**所有**实测模型都接受的拼写。
 *
 * 七档里只有 `low` / `high` 是全员交集（`glm-5.3` 缺
 * `none`/`minimal`/`medium`/`xhigh`，`kimi-k3` 缺 `max`，
 * `deepseek-flash` 缺 `xhigh`），因此用它永远不会撞 400。
 *
 * 代价是新模型的上限被压到 `high`。这是有意的取舍：新模型上线时先把词表补进
 * {@link MODEL_REASONING_EFFORTS}，而不是先让用户吃一轮 400。
 */
export const DEFAULT_REASONING_EFFORTS: readonly ReasoningEffort[] = ['low', 'high'];

/** 模型 id 归一：上游 id 全是小写，但请求体里的写法不由我们控制。 */
function normalizeModelId(modelId: string | undefined): string | undefined {
  if (typeof modelId !== 'string') return undefined;
  const id = modelId.trim().toLowerCase();
  return id.length > 0 ? id : undefined;
}

/** 该模型的上游词表；未实测的模型返回保守默认表。 */
export function reasoningEffortsFor(modelId: string | undefined): readonly ReasoningEffort[] {
  const id = normalizeModelId(modelId);
  return (id === undefined ? undefined : MODEL_REASONING_EFFORTS[id]) ?? DEFAULT_REASONING_EFFORTS;
}

/** 该模型是否有实测词表（决定清洗层敢不敢替调用方改档位）。 */
export function hasMeasuredReasoningEfforts(modelId: string | undefined): boolean {
  const id = normalizeModelId(modelId);
  return id !== undefined && MODEL_REASONING_EFFORTS[id] !== undefined;
}

/** 上游拼写的强度序号（`none` = 0 … `max` = 6）。 */
function effortRank(effort: ReasoningEffort): number {
  return REASONING_EFFORTS.indexOf(effort);
}

/** 词表里最强的一档。 */
function strongestEffort(vocab: readonly ReasoningEffort[]): ReasoningEffort {
  return vocab.reduce((best, effort) => (effortRank(effort) > effortRank(best) ? effort : best), vocab[0]);
}

/** 词表里最弱的一档。 */
function weakestEffort(vocab: readonly ReasoningEffort[]): ReasoningEffort {
  return vocab.reduce((worst, effort) => (effortRank(effort) < effortRank(worst) ? effort : worst), vocab[0]);
}

/**
 * 词表内「不超过 target 的最强档」；词表里没有更弱的档时退回最弱档。
 *
 * 「不超过」是有意的：`medium` 这类中间档在缺档模型上向下取（`glm-5.3` 的
 * `medium → low`），宁可省 token，也不要悄悄把用户没要求的成本抬到 `high`。
 */
function nearestAtOrBelow(vocab: readonly ReasoningEffort[], target: number): ReasoningEffort {
  let best: ReasoningEffort | undefined;
  for (const effort of vocab) {
    if (effortRank(effort) > target) continue;
    if (best === undefined || effortRank(effort) > effortRank(best)) best = effort;
  }
  return best ?? weakestEffort(vocab);
}

/**
 * 把一个 DSH 档位翻译成该模型接受的**上游拼写**（就近归位）。
 *
 * 只给 shim 清洗层用：那是「已经收到一个不该出现的档位、必须改成合法值」的场合。
 * 注册给 pi-ai 的 `thinkingLevelMap` **不用**它 —— 声明能力时要如实写 `null`，
 * 而不是替用户挑一个替代档（见 {@link thinkingLevelMapFor}）。
 *
 * 规则（issue #3）：
 *   1. 词表里有同名档 → 直接用；
 *   2. `xhigh` / `max` 属于「饱和区」：用户明确要了「极高 / 最高」，缺档时由
 *      该模型最强的档承接，**不降级**（`glm-5.3` 的 `xhigh → max`）。`kimi-k3`
 *      的 `max → xhigh` 是它本来就没有更高档，不是我们改主意；
 *   3. 其余档（含 `off`）取词表内不超过它的最强档，没有更弱档就取最弱档 ——
 *      于是无法关闭思考的模型（`glm-5.3`）把 `off` 落成 `low`。
 */
export function thinkingEffortFor(modelId: string | undefined, level: ThinkingLevel): ReasoningEffort {
  const vocab = reasoningEffortsFor(modelId);
  const same = level === 'off' ? undefined : (level as ReasoningEffort);
  if (same !== undefined && vocab.includes(same)) return same;
  if (level === 'xhigh' || level === 'max') return strongestEffort(vocab);
  // DSH 的 `off` 对应上游的 `none`（强度 0）。
  const target = level === 'off' ? effortRank('none') : effortRank(level as ReasoningEffort);
  return nearestAtOrBelow(vocab, target);
}

/**
 * 该模型注册进 pi-ai 时用的 `thinkingLevelMap`。
 *
 * **只有实测支持的档位给出拼写，其余一律 `null`**。`null` 在 pi-ai / DSH 里的
 * 含义就是「这个模型没有这一档」：`getSupportedThinkingLevels()` 会把它们从模型
 * 选择器里摘掉，于是 `glm-5.3` 的思考档下拉只剩 **Low / High / Max**（+`Default`）。
 *
 * 为什么不像早先那样「把缺档就近归位」（`xhigh → max`）：
 * 那样 UI 上仍然有 7 档，用户选 `Xhigh` 实际发的是 `max`、选 `Off` 实际发的是
 * `low` —— 看着能用，发出去的不是他选的东西，等于用 UI 撒谎。声明的能力应当
 * 与实际能力一致；**兜住非法值**的活交给 shim 清洗层（{@link coerceReasoningEffort}），
 * 那里是真的收到了一个不该出现的值才动手。
 *
 * 键一定要写全（包括 `null`）：pi-ai 对**缺失**键的处理是不对称的 —— 前五档视为
 * 「支持、用 provider 默认」，`xhigh`/`max` 视为「不支持」；显式给 `null` 才确定。
 */
export function thinkingLevelMapFor(modelId: string | undefined): Record<ThinkingLevel, ReasoningEffort | null> {
  const vocab = reasoningEffortsFor(modelId);
  const map = {} as Record<ThinkingLevel, ReasoningEffort | null>;
  for (const level of THINKING_LEVELS) {
    // DSH 的 `off` 对应上游的 `none`，两者是同一档。
    const spelling: ReasoningEffort = level === 'off' ? 'none' : (level as ReasoningEffort);
    map[level] = vocab.includes(spelling) ? spelling : null;
  }
  return map;
}

/** 清洗层的归一结果。 */
export interface ReasoningEffortCoercion {
  /** 应发给上游的合法拼写；`undefined` 表示认不出来（调用方应摘掉该字段）。 */
  value?: ReasoningEffort;
  /** 是否改写了调用方传进来的值。 */
  changed: boolean;
}

/**
 * 把请求体里的 `reasoning_effort` 规整到该模型接受的词表内（shim 清洗层用）。
 *
 * 和注册层不同，这里**只动已知模型的已知问题**：
 *   * 未实测的模型原样放行 —— 我们没有它的词表，猜一个只会把「上游如实报错」
 *     变成「上游收到了被我们悄悄改过的请求」，那正是 issue #2 批评过的做法；
 *   * 已知模型则按 {@link thinkingEffortFor} 就近归位，保证不发非法拼写。
 *
 * 认不出来的取值（拼写错误、将来新增的档位）返回 `value: undefined`，由调用方
 * 摘掉字段 —— 不发垃圾值去撞 400。
 */
export function coerceReasoningEffort(modelId: string | undefined, requested: string): ReasoningEffortCoercion {
  const lowered = requested.trim().toLowerCase();
  // `off`（DSH 拼写）与 `none`（商汤拼写）是同一档，两个都要认 —— 否则上一轮
  // 被我们改写成 `none` 的请求，下一轮会被当成「认不出来的取值」摘掉，清洗层
  // 就不再幂等。
  const level: ThinkingLevel | undefined =
    lowered === 'off' || lowered === 'none'
      ? 'off'
      : (THINKING_LEVELS as readonly string[]).includes(lowered)
        ? (lowered as ThinkingLevel)
        : undefined;
  if (level === undefined) return { changed: false };

  // DSH 的 `off` 商汤写作 `none`。
  const spelling: ReasoningEffort = level === 'off' ? 'none' : (level as ReasoningEffort);
  const vocab = reasoningEffortsFor(modelId);
  if (vocab.includes(spelling) || !hasMeasuredReasoningEfforts(modelId)) {
    return { value: spelling, changed: spelling !== requested };
  }

  const mapped = thinkingEffortFor(modelId, level);
  return { value: mapped, changed: mapped !== requested };
}

// --------------------------------------------------------- 模型的固定参数

/**
 * 某些模型的采样参数只有**唯一合法值**（2026-11-17 实测）。
 *
 * `kimi-k3` 收到 `temperature: 0`（或任何非 1 的值）直接 400：
 * `field Temperature invalid, only 1 is allowed for this model` —— 它根本
 * 不提供「调低随机性」这个能力。既然唯一能发的值就是 1，清洗层直接兜住，
 * 比让整轮对话失败要好；这不是篡改意图（没有别的值可选）。
 */
export const MODEL_FIXED_PARAMS: Readonly<Record<string, { temperature?: number }>> = {
  'kimi-k3': { temperature: 1 },
};

/** 该模型必须使用的固定采样参数；没有则返回 `undefined`。 */
export function fixedParamsFor(modelId: string | undefined): { temperature?: number } | undefined {
  const id = normalizeModelId(modelId);
  return id === undefined ? undefined : MODEL_FIXED_PARAMS[id];
}

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
 * 决定一个模型的上下文窗口：基线可覆盖上游（issue #4）。
 *
 * 上游的 `context_length` 大多数时候可信，但已经实测到它会把某个模型的窗口
 * 报小 4 倍（`sensenova-6.8-flash`）。所以优先级是：
 *
 *     标了 `contextWindowOverridesUpstream` 的基线 > 上游 `context_length` > 基线 > 262144
 *
 * 只有**实测确认上游报小了**的模型才走第一档；其余（含新上架模型）继续以上游为准。
 * 用户在设置页里给该模型自定义的值不在这里处理 —— 那是 index.ts 的 modelLimits，
 * 优先级更高，因为它表达的是「用户自己的判断」。
 */
function resolveContextWindow(raw: RawModelEntry, baseline: SenseNovaModel | undefined): number {
  const upstream =
    typeof raw.context_length === 'number' && raw.context_length > 0 ? raw.context_length : undefined;
  if (baseline?.contextWindowOverridesUpstream === true) return baseline.contextWindow;
  return upstream ?? baseline?.contextWindow ?? 262144;
}

/**
 * 把 `/v1/models` 的原始响应解析成目录。
 *
 * 宽容解析：字段缺失就回落到基线/默认值，任何一条坏数据都不应该让整个目录失败。
 *
 * `baselines` 由调用方按**当前端点**给出：两个站的模型集合不同，拿中国站的基线
 * 去解析国际站的响应，会让国际站缺失的模型也套上中国站的窗口/上限。
 */
export function parseModelCatalog(
  payload: unknown,
  baselines: readonly SenseNovaModel[] = BUILTIN_MODELS,
): SenseNovaModel[] {
  const data = (payload as { data?: unknown })?.data;
  if (!Array.isArray(data)) return [];
  const out: SenseNovaModel[] = [];
  for (const raw of data as RawModelEntry[]) {
    const id = typeof raw?.id === 'string' ? raw.id.trim() : '';
    if (!id) continue;
    const modalities = Array.isArray(raw.input_modalities) ? raw.input_modalities : [];
    const features = Array.isArray(raw.supported_features) ? raw.supported_features : [];
    const baseline = baselines.find((model) => model.id === id);
    // 上游 /v1/models 列什么就收什么，**不按输出模态筛掉生图模型**：用户明确要求
    // 「模型全放出来」。生图模型在对话接口上会如实返回 404，比在列表里凭空消失
    // 更容易理解；不想要的话在设置页取消勾选即可（可见性会持久化）。
    out.push({
      id,
      name: typeof raw.name === 'string' && raw.name.trim() ? raw.name.trim() : id,
      contextWindow: resolveContextWindow(raw, baseline),
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
 * - 401 `{"code":16,"message":"Forbidden"}` → 该 key 不属于**这个端点**。实测国际站
 *   key 打中国站 `token.sensenova.cn` 就是这条；两个站的 key 互不通用，因此用户
 *   选错端点时应当直接看到鉴权失败，而不是被当成「限流」无限重试。
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
