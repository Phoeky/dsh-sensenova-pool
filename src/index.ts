/**
 * dsh-sensenova-pool —— 商汤日日新（SenseNova）多 Key 轮换池。
 *
 * 目标：在设置页里粘贴若干把商汤 key，即可让 DSH 的模型选择器直接出现日日新的
 * 全部模型，并且**在遇到 429 限流时自动切换下一把 key**，对使用者完全透明。
 *
 * 架构（与 dsh-workbuddy-connect 同源的「本地 shim」思路）
 * ------------------------------------------------------
 * DSH 的 `LlmAdapter` 要求自己实现完整的 StreamChunk 协议，那是随 DSH 版本
 * 最容易漂移、也最容易写错的一层。这里改为在 127.0.0.1 上起一个说 OpenAI
 * 线格式的本地服务，让 pi-ai 现成的 `openai-completions` 适配器去跟它说话：
 *
 *     DSH ──pi-ai(openai-completions)──▶ 127.0.0.1 shim ──key 池轮换──▶ token.sensenova.cn
 *
 * 好处是「屏蔽 429」这件事被关在一个我们完全掌控的小盒子里：上层看到的永远是
 * 一个稳定的 OpenAI 兼容端点，429 在盒子内部被消化掉。
 */

import { randomBytes } from 'node:crypto';

import { PiAiAdapter } from '@deepseek-ai/dsh-llm-pi-ai';
import { resolveRetryPolicy } from '@deepseek-ai/dsh-llm';
import { createProvider } from '@earendil-works/pi-ai';
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy';
import z from '@deepseek-ai/schemastery';

import { DEFAULT_BASE_URL, type SenseNovaModel } from './catalog.js';
import { KeyPool, keyIdOf, maskKey } from './keypool.js';
import { ModelCatalog, createShim, type Shim } from './shim.js';
import { registerKeyRoutes, registerSettingsSection, type StatusProvider } from './routes.js';

/** 本插件注册的 provider 路由名（模型选择器里显示为此分组）。 */
const PROVIDER_ID = 'sensenova-pool';
const PROVIDER_NAME = '商汤日日新（Key 轮换池）';

/**
 * 设置命名空间。
 *
 * 用户明确要求「只在 DSH 设置页里填 key」，因此 key 通过本插件自己的命名空间
 * 持久化；命名空间由 DSH 的 settings 服务托管，落在 profile 的配置层里。
 */
const SETTINGS_NS = 'sensenova-pool';

/** 单条流允许的最大空闲时间（毫秒）。 */
const STREAM_IDLE_TIMEOUT_MS = 300_000;

/**
 * 每把 key 的本地 RPM 预限流上限。
 *
 * 默认 2 来自实测：现有商汤 key 的真实上限约为 **3 RPM**（串行发 12 个请求，
 * 前 3 个成功、其余全部 429）。把本地窗口设在 2 就能**主动**避开限流，而不是
 * 打完再退避 —— 后者会让用户看到首字延迟从秒级恶化到十几秒。
 *
 * 这与参考实现 st-rotator 的 `rpm_limit: 2` 一致。若你的套餐额度更高，可在
 * 插件配置里调大；设为 0 即关闭本地预限流。
 */
const DEFAULT_RPM_LIMIT = 2;

/** 与 pi-ai 约定的本路由图片预算；与本插件无关但 profile 形状需要它。 */
const REQUEST_IMAGE_BUDGETS = {
  maxRequestImageBytes: 20_971_520,
  requestImagePixelBudget: 4_194_304,
  requestImageMaxBytes: 1_048_576,
};

/** 订阅式套餐没有可计算的单价，报 0。 */
const NO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

export const name = 'llm-sensenova-pool';
export const inject = ['llm'];

/**
 * 插件配置。
 *
 * 刻意保持极小：key 走设置页（不落进配置文件），这里只放「怎么连、怎么轮换」
 * 这类非机密参数。
 */
export const Config = z.object({
  baseUrl: z.string().default(DEFAULT_BASE_URL).description('商汤日日新 API 根地址'),
  maxAttempts: z.number().default(6).description('单个请求最多尝试几把 key'),
  acquireTimeoutMs: z.number().default(180_000).description('等待可用 key 的总预算（毫秒）'),
  requestTimeoutMs: z.number().default(60_000).description('单次上游请求超时（毫秒）'),
  rpmLimit: z
    .number()
    .default(DEFAULT_RPM_LIMIT)
    .description('每把 key 的本地 RPM 预限流上限；0 表示不限制'),
  maxConcurrency: z.number().default(1).description('每把 key 的并发上限；1 表示串行（推荐）'),
});

type PluginConfig = {
  baseUrl: string;
  maxAttempts: number;
  acquireTimeoutMs: number;
  requestTimeoutMs: number;
  rpmLimit: number;
  maxConcurrency: number;
};

/**
 * 「没有凭据生命周期」的空认证面。
 *
 * `PiAiAdapterOptions.auth` 是必填的：若不给，pi-ai 会去做它自己的环境变量
 * 探测，可能凭空造出一个凭据来。本插件的凭据完全在 key 池里，因此显式给一个
 * 什么都不做的 auth，堵死那条路。
 */
const INERT_AUTH = {
  credentials: {
    async read() {
      return undefined;
    },
    async list() {
      return [];
    },
    async modify() {
      throw new Error('dsh-sensenova-pool: the sensenova-pool route has no pi-ai credential lifecycle');
    },
    async delete() {
      return undefined;
    },
  },
  authContext: {
    async env() {
      return undefined;
    },
    async fileExists() {
      return false;
    },
  },
};

export function apply(ctx: any, config: PluginConfig): void {
  const resolved: PluginConfig = {
    baseUrl: config?.baseUrl || DEFAULT_BASE_URL,
    maxAttempts: config?.maxAttempts ?? 6,
    acquireTimeoutMs: config?.acquireTimeoutMs ?? 120_000,
    requestTimeoutMs: config?.requestTimeoutMs ?? 60_000,
    rpmLimit: config?.rpmLimit ?? 0,
    maxConcurrency: config?.maxConcurrency ?? 1,
  };

  const logger = {
    info: (message: string) => ctx.logger?.info?.(`sensenova-pool: ${message}`),
    warn: (message: string) => ctx.logger?.warn?.(`sensenova-pool: ${message}`),
    error: (message: string) => ctx.logger?.error?.(`sensenova-pool: ${message}`),
  };

  const catalog = new ModelCatalog();
  const pool = new KeyPool([], {
    rpmLimit: resolved.rpmLimit > 0 ? resolved.rpmLimit : null,
    maxConcurrency: resolved.maxConcurrency,
  });

  /** 最近的轮换事件，供状态页展示「刚才发生了什么」。 */
  const recentRotations: Array<{ keyId: string; kind: string; status: number; message: string; at: number }> = [];

  const shim: Shim = createShim({
    pool,
    catalog,
    baseUrl: resolved.baseUrl,
    rotation: {
      maxAttempts: resolved.maxAttempts,
      acquireTimeoutMs: resolved.acquireTimeoutMs,
      requestTimeoutMs: resolved.requestTimeoutMs,
      retryServerErrors: true,
    },
    logger,
    onAttemptFailed: (log) => {
      recentRotations.unshift({ keyId: log.keyId, kind: log.kind, status: log.status, message: log.message, at: log.at });
      if (recentRotations.length > 50) recentRotations.length = 50;
    },
  });

  const status: StatusProvider = {
    pool: () => pool.snapshot(),
    summary: () => pool.summary(),
    catalog: () => catalog.status(),
    rotations: () => recentRotations.slice(0, 20),
    providerId: PROVIDER_ID,
    providerName: PROVIDER_NAME,
    baseUrl: resolved.baseUrl,
  };

  // ---------------------------------------------------------------- 凭据装载

  /**
   * 从 DSH 凭据库读取本插件的 key 列表。
   *
   * 存储方案：一个 `<scope>/keys` 记录，payload 里放 key 数组。用记录而不是
   * 环境变量引用，是因为用户要求「可以填多把 key」——环境变量引用是单值的，
   * 无法表达一个池子。
   */
  const RECORD_SCOPE = 'dsh-sensenova-pool';
  const RECORD_ID = `${RECORD_SCOPE}/keys`;

  function credentialsService(): any {
    return ctx.get?.('credentials');
  }

  async function loadKeys(): Promise<number> {
    const credentials = credentialsService();
    if (credentials === undefined) {
      logger.warn('凭据服务不可用，key 池保持为空');
      return 0;
    }
    let record: { kind?: string; payload?: { keys?: unknown } } | undefined;
    try {
      record = await credentials.readRecord(RECORD_ID);
    } catch (error) {
      logger.warn(`读取 key 记录失败：${error instanceof Error ? error.message : String(error)}`);
      return 0;
    }
    const keys = Array.isArray(record?.payload?.keys) ? (record?.payload?.keys as unknown[]) : [];
    let added = 0;
    for (const raw of keys) {
      if (typeof raw === 'string' && pool.addKey(raw)) added += 1;
    }
    if (added > 0) logger.info(`已装载 ${added} 把 key`);
    return added;
  }

  async function saveKeys(): Promise<void> {
    const credentials = credentialsService();
    if (credentials === undefined) throw new Error('凭据服务不可用，无法保存 key');
    const keys = pool.keys();
    await credentials.modifyRecord(RECORD_ID, async () => ({
      kind: 'api-key',
      payload: { keys },
    }));
  }

  // ------------------------------------------------------------ provider 注册

  function buildModels(): any[] {
    const baseUrl = `${shim.baseUrl()}/v1`;
    return catalog.current().map((model: SenseNovaModel) => ({
      id: model.id,
      name: model.name,
      api: 'openai-completions',
      provider: PROVIDER_ID,
      baseUrl,
      input: model.supportsImages ? ['text', 'image'] : ['text'],
      // 商汤的思考等级。
      //
      // 取值经**实测**确定：`reasoning_effort` 只接受
      // `none | low | medium | high | xhigh`。传 `off` / `max` / `minimal`
      // 会得到 400 `field ReasoningEffort invalid`（曾经踩过这个坑）。
      // 因此这里把 DSH 的等级名映射到商汤的拼写：
      //   off → none（关闭思考），minimal → 不支持，max → xhigh（最高的合法档）。
      reasoning: model.reasoning,
      ...(model.reasoning
        ? {
            thinkingLevelMap: {
              off: 'none',
              minimal: null,
              low: 'low',
              medium: 'medium',
              high: 'high',
              xhigh: 'xhigh',
              max: 'xhigh',
            },
          }
        : {}),
      cost: NO_COST,
      contextWindow: model.contextWindow,
      maxTokens: model.maxTokens,
      compat: { maxTokensField: 'max_tokens' },
    }));
  }

  function createAdapter(): PiAiAdapter {
    const buildProfile = (): Map<string, any> => {
      const provider = {
        ...createProvider({
          id: PROVIDER_ID,
          name: PROVIDER_NAME,
          auth: {
            apiKey: {
              name: 'SenseNova key pool (loopback shim)',
              async resolve({ credential }: { credential?: { key?: string } }) {
                const apiKey = credential?.key;
                if (apiKey === undefined || apiKey.length === 0) return undefined;
                return { auth: { apiKey }, source: 'sensenova-pool' };
              },
            },
          },
          models: buildModels(),
          api: openAICompletionsApi(),
        }),
        // 目录可能被 /v1/models 刷新，每次读取都重新构建。
        getModels: () => buildModels(),
      };

      const profile = {
        provider: PROVIDER_ID,
        displayName: PROVIDER_NAME,
        streamIdleTimeoutMs: STREAM_IDLE_TIMEOUT_MS,
        retryPolicy: resolveRetryPolicy(undefined, 'dsh-sensenova-pool retryPolicy'),
        configuredMaxTokens: new Map<string, number>(),
        modelErrors: new Map<string, string>(),
        ...REQUEST_IMAGE_BUDGETS,
        piProvider: provider,
      };
      return new Map([[PROVIDER_ID, profile]]);
    };

    let profiles = buildProfile();
    const adapter = new PiAiAdapter({
      profiles: () => profiles,
      auth: INERT_AUTH,
      // 关键：交给 pi-ai 的是回环共享密钥，真实商汤 key 永远不出 shim。
      resolveApiKey: async () => shim.token(),
    });
    // 目录刷新后重建 profile，让模型列表立即生效。
    (adapter as any).__rebuild = () => {
      profiles = buildProfile();
    };
    return adapter;
  }

  // adapter 必须等回环服务真正监听之后才能构建：模型描述符里要写入 shim 的端口，
  // 而 `server.listen()` 是异步的 —— 在 `listening` 事件之前调用 `baseUrl()` 会抛
  // 「shim has no listening address」。因此注册被推迟到下面的 async 启动块里。
  let adapter: PiAiAdapter | undefined;
  let registration: { (): void; replace(routes: string[]): void } | undefined;

  /** 目录变化后让 DSH 重新读取模型列表。 */
  function refreshCatalog(): void {
    (adapter as any)?.__rebuild?.();
    try {
      ctx.emit?.('llm/adapters-updated');
    } catch {
      // 事件不可用时忽略：模型列表在下次读取时依然是最新的。
    }
  }

  // -------------------------------------------- 启动：注册 provider + 装载 key

  void (async () => {
    try {
      await shim.ready;
    } catch (error) {
      logger.error(`回环端点启动失败：${error instanceof Error ? error.message : String(error)}`);
      return;
    }

    // ---- 端口就绪，此时才能安全构建模型描述符并注册 provider ----------------
    try {
      adapter = createAdapter();
      registration = ctx.llm.registerAdapter([PROVIDER_ID], adapter);
      ctx.effect?.(() => () => {
        try {
          registration?.();
        } finally {
          void shim.close();
        }
      });
      logger.info(`已注册 provider "${PROVIDER_ID}"，模型分组「${PROVIDER_NAME}」`);
    } catch (error) {
      logger.error(`注册 provider 失败：${error instanceof Error ? error.message : String(error)}`);
      void shim.close();
      return;
    }

    const loaded = await loadKeys();
    if (loaded > 0) {
      refreshCatalog();
      void fetchCatalogFromUpstream();
    } else {
      logger.info('key 池为空 —— 请在「设置 → 插件 → 商汤日日新（Key 轮换池）」里填入 key');
    }
  })();

  /**
   * 用池里的 key 拉取真实模型目录。
   *
   * 失败不影响可用性：内置基线目录已经能跑，这里只是把新模型补进来。
   */
  async function fetchCatalogFromUpstream(): Promise<void> {
    if (pool.size === 0) return;
    const url = `${resolved.baseUrl.replace(/\/+$/, '')}/models`;
    const attempted = new Set<string>();
    for (let index = 0; index < Math.min(pool.size + 1, 4); index += 1) {
      let entry;
      try {
        entry = await pool.acquire({ exclude: attempted, timeoutMs: 15_000 });
      } catch {
        return;
      }
      attempted.add(entry.key);
      try {
        const response = await fetch(url, {
          headers: { authorization: `Bearer ${entry.key}` },
          signal: AbortSignal.timeout(20_000),
        });
        if (response.ok) {
          const payload = await response.json();
          const count = catalog.apply(payload);
          pool.reportSuccess(entry);
          if (count > 0) {
            logger.info(`模型目录已更新：${count} 个模型`);
            refreshCatalog();
          }
          return;
        }
        if (response.status === 429) {
          pool.reportRateLimit(entry);
          continue;
        }
        if (response.status === 401 || response.status === 403) {
          pool.reportInvalid(entry, `模型目录鉴权失败 (${response.status})`);
          continue;
        }
        pool.reportClientError(entry, `模型目录请求失败 (${response.status})`);
        catalog.fail(`HTTP ${response.status}`);
        return;
      } catch (error) {
        pool.reportServerError(entry, error instanceof Error ? error.message : String(error));
      } finally {
        pool.release(entry);
      }
    }
  }

  // --------------------------------------------------------------- 可选界面

  // 设置页：填 key（用户明确要求只在设置页填）。
  try {
    registerSettingsSection(ctx, {
      namespace: SETTINGS_NS,
      config,
      pool,
      onKeysChanged: async () => {
        await saveKeys();
        refreshCatalog();
        void fetchCatalogFromUpstream();
      },
    });
  } catch (error) {
    logger.warn(`设置页注册失败（不影响模型可用）：${error instanceof Error ? error.message : String(error)}`);
  }

  // Web 路由：给设置卡片读写 key / 查看池状态用。
  try {
    registerKeyRoutes(ctx, {
      status,
      pool,
      logger,
      onKeysChanged: async () => {
        await saveKeys();
        refreshCatalog();
        void fetchCatalogFromUpstream();
      },
      reload: async () => {
        await loadKeys();
        refreshCatalog();
      },
      fetchCatalog: fetchCatalogFromUpstream,
    });
  } catch (error) {
    logger.warn(`Web 路由注册失败：${error instanceof Error ? error.message : String(error)}`);
  }

  // 便于用户在发生轮换时看到一条日志（而不是静默吞掉）。
  ctx.on?.('dispose', () => {
    logger.info('插件已卸载');
  });
}

export { PROVIDER_ID, PROVIDER_NAME, SETTINGS_NS, maskKey, keyIdOf };
