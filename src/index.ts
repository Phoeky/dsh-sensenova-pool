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

  /**
   * 被用户隐藏的模型 id。
   *
   * 「下拉里展示什么」是用户自己的偏好，与 key 一样跨重启保留：勾掉的模型不进入
   * `buildModels()`，因此不会出现在模型选择器里（上游仍然可用，只是不展示）。
   */
  const disabledModels = new Set<string>();

  /**
   * 对外暴露的 API Key（别的服务用它访问本地 shim）。
   *
   * 持久化在凭据记录里，重启后保持不变 —— 否则每次启动都换一把，外部服务就得
   * 反复改配置。启动装载完成前它是空串，此时 shim 用的是进程内随机密钥。
   */
  let externalKey = '';

  /** 凭据库里是否**已有**本插件的记录（决定首次装载后要不要立刻补写）。 */
  let recordExisted = false;

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
    endpoint: () => {
      // shim 监听失败时 baseUrl() 会抛；这里降级成空串，让界面显示「不可用」而不是崩。
      try {
        return { baseUrl: `${shim.baseUrl()}/v1`, port: shim.port(), apiKey: shim.token() };
      } catch {
        return { baseUrl: '', port: 0, apiKey: shim.token() };
      }
    },
    models: () =>
      catalog.current().map((model) => ({
        id: model.id,
        name: model.name,
        contextWindow: model.contextWindow,
        maxTokens: model.maxTokens,
        enabled: !disabledModels.has(model.id),
      })),
    providerId: PROVIDER_ID,
    providerName: PROVIDER_NAME,
    baseUrl: resolved.baseUrl,
  };

  // ---------------------------------------------------------------- 凭据装载

  /**
   * 从 DSH 凭据库读取本插件的状态。
   *
   * 存储方案：一个 `<scope>/keys` 记录，payload 里放 key 数组、被隐藏的模型 id，
   * 以及对外暴露的 API Key。用记录而不是环境变量引用，是因为用户要求「可以填多把
   * key」——环境变量引用是单值的，无法表达一个池子。
   *
   * 为什么把「模型可见性」和「对外密钥」也塞进这条记录：DSH 的 settings 服务是
   * 围绕插件 Config + profile patch 的配置编辑器，不是通用 KV；为这两个字段单开
   * 一套持久化路径不值得。grant 的 payload 是**逐字保留**的，多几个字段完全安全。
   */
  const RECORD_SCOPE = 'dsh-sensenova-pool';
  const RECORD_ID = `${RECORD_SCOPE}/keys`;

  /** 凭据记录里我们自己的 payload 形状（全部字段可选，便于向前兼容）。 */
  interface PoolPayload {
    keys?: unknown;
    /** 被用户隐藏的模型 id（不进入模型选择器）。 */
    disabledModels?: unknown;
    /** 对外暴露给其他本地服务的 API Key。 */
    externalKey?: unknown;
  }

  /**
   * 写入前等待首次权威装载的上限（毫秒）。
   *
   * 只作为兜底：正常路径下 `firstAuthoritativeLoad` 会在凭据服务就绪的那一刻兑现。
   * 设上限是为了「宿主没有凭据服务」时不要永远挂住写入请求。
   */
  const SAVE_LOAD_WAIT_MS = 10_000;

  /** 严格读取：只返回**已就绪**（fiber ACTIVE）的凭据服务。 */
  function credentialsService(): any {
    return ctx.get?.('credentials');
  }

  /**
   * 宽松读取：服务**已注册但可能仍在加载**时也能拿到实例。
   *
   * 用来区分两种「读不到凭据」：服务正在加载（应继续等），还是宿主压根没有这个
   * 服务（应直接提示用户填 key）。
   */
  function credentialsRegistered(): boolean {
    try {
      return ctx.get?.('credentials', false) !== undefined;
    } catch {
      return false;
    }
  }

  /**
   * 「首次**权威**装载」完成信号。
   *
   * 权威 = 凭据服务**真正就绪**（fiber 已 ACTIVE、`.credentials.yaml` 已解析进内存
   * 快照），而不是「服务对象已构造」。这两者的区别正是 issue #1：
   *
   *   1. **已构造** —— `Service` 在构造函数里就 `provide()`，服务已能被解析到，但
   *      所属 fiber 还停在 PENDING/LOADING，`Service.init` 尚未跑完；
   *   2. **已就绪** —— `Service.init` 已结束，credentials-local 的 `loadInitial()`
   *      已把 `.credentials.yaml` 填进内存快照。
   *
   * 本插件只 `inject: ['llm']`，与 credentials 之间**没有顺序保证**。冷启动磁盘 IO
   * 慢时 `loadKeys()` 会先于 `loadInitial()` 执行，`readRecord()` 读到空快照 → key
   * 池为 0，且此后没有任何补载机制（`credentials/record-updated` 只在运行期写入时
   * 触发，覆盖不到启动装载）—— 这就是「重启电脑后 Key 池为空」。
   *
   * 修复方式不是「轮询 + 超时」，而是用 cordis 自己的就绪通知：`ctx.inject` 的回调
   * **只在服务所属 fiber 变为 ACTIVE 时才触发**（已用真实 cordis 验证）。它精确、
   * 零延迟，也不会给「宿主根本没有凭据服务」的环境白等一段超时 —— 那种情况下回调
   * 只是不触发，启动路径照常给出「请填入 key」的提示。
   *
   * 之所以要等它再允许写入：`saveKeys()` 是用 `pool.keys()` **整体覆盖**记录。若在
   * 权威装载之前写入（启动还没完，用户就点了「添加 Key」），池子里只有刚加的那把，
   * 磁盘上原有的 key 会被静默抹掉。
   */
  let notifyKeysLoaded: (() => void) | undefined;
  const firstAuthoritativeLoad = new Promise<void>((resolve) => {
    notifyKeysLoaded = resolve;
  });

  /**
   * 装载 key、模型可见性与对外密钥，并在**凭据快照确实可读**时宣告首次权威装载完成。
   *
   * 只有凭据服务可见时才宣告：否则「池子为空」只代表「还没读到」，不代表「真的没有
   * key」，提前宣告会让 `saveKeys()` 把空池覆盖写回记录。
   */
  async function loadKeysAndNotify(): Promise<number> {
    const added = await loadKeys();
    if (credentialsService() !== undefined) {
      // 记录里还没有对外密钥时生成一把。是否立刻落盘取决于记录**原本是否存在**：
      //   - 存在（老用户 / 已用过插件）→ 补写一次，把这把密钥固化下来；
      //   - 不存在（首次安装）→ 只放在内存里，等用户第一次添加 key 时随那次写入
      //     一起落盘，避免仅为一把尚未使用的密钥就在凭据库里建记录。
      if (!externalKey) {
        externalKey = newExternalKey();
        shim.setToken(externalKey);
        if (recordExisted) {
          try {
            await persistRecord();
          } catch (error) {
            logger.warn(`对外密钥落盘失败（本次会话仍可用）：${error instanceof Error ? error.message : String(error)}`);
          }
        }
      }
      notifyKeysLoaded?.();
    }
    return added;
  }

  /** 生成一把形如商汤 key 的对外密钥（只被本地 shim 校验，不发给上游）。 */
  function newExternalKey(): string {
    return `sk-dsh-${randomBytes(24).toString('hex')}`;
  }

  async function loadKeys(): Promise<number> {
    const credentials = credentialsService();
    if (credentials === undefined) {
      logger.warn('凭据服务不可用，key 池保持为空');
      return 0;
    }
    let record: { kind?: string; payload?: PoolPayload } | undefined;
    try {
      record = await credentials.readRecord(RECORD_ID);
    } catch (error) {
      logger.warn(`读取 key 记录失败：${error instanceof Error ? error.message : String(error)}`);
      return 0;
    }
    const payload = record?.payload ?? {};
    recordExisted = record !== undefined && record !== null;
    const keys = Array.isArray(payload.keys) ? payload.keys : [];
    let added = 0;
    for (const raw of keys) {
      if (typeof raw === 'string' && pool.addKey(raw)) added += 1;
    }

    // 模型可见性：记录里没有该字段时表示「全部展示」。
    disabledModels.clear();
    if (Array.isArray(payload.disabledModels)) {
      for (const id of payload.disabledModels) {
        if (typeof id === 'string' && id.length > 0) disabledModels.add(id);
      }
    }

    // 对外密钥：拿到持久化的那把后立刻换上，DSH 与外部服务从此用同一个。
    if (typeof payload.externalKey === 'string' && payload.externalKey.length >= 16) {
      externalKey = payload.externalKey;
      shim.setToken(externalKey);
    }

    if (added > 0) logger.info(`已装载 ${added} 把 key`);
    return added;
  }

  /**
   * 可被进程退出的定时器（`unref`）。
   *
   * 为什么不用裸 `setTimeout`：这里只拿它当「兜底超时」，正常路径下由 Promise 先行
   * 兑现。裸定时器会一直挂在事件循环上，让 DSH 退出时多等一段、也让测试无谓变慢。
   */
  function delay(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, ms);
      (timer as any)?.unref?.();
    });
  }

  /**
   * 把当前内存状态整体写回记录（**不等待**权威装载）。
   *
   * 只给两条路径用：启动装载完成后的补写（此时快照刚读过，权威），以及已经等过
   * `firstAuthoritativeLoad` 的 `saveKeys()`。别在启动早期直接调它。
   */
  async function persistRecord(): Promise<void> {
    const credentials = credentialsService();
    if (credentials === undefined) throw new Error('凭据服务不可用，无法保存');
    // 必须用 `grant`，不能用 `api-key`。
    //
    // credentials-local 对记录做白名单校验（`assertFields`），两种标签允许的字段
    // 是互斥的：`api-key` 只认 `kind` / `key` / `env`，`grant` 只认 `kind` /
    // `payload`。而 `api-key` 的 `key` 是**单值**字符串，根本表达不了 key 池，
    // 所以池子只能落在 `grant` 的 `payload` 里（存储对 grant payload 逐字保留，
    // 不做解释）。
    //
    // 踩过的坑：这里原先写的是 `kind: 'api-key'` + `payload`。写入路径的
    // `assertStorableApiKey` 只校验 `key` 是否为空和 `env` 值，**不查未知字段**，
    // 于是坏记录顺利落盘；下次启动时 credentials-local 在 loadInitial 阶段
    // 解析失败 → credentials 插件激活失败 → 整个 dsh 启动中止（弹「could not
    // start or stopped unexpectedly」）。一条记录写错就能锁死整个应用，所以这里
    // 的标签必须与 schema 严格对齐。
    await credentials.modifyRecord(RECORD_ID, async () => ({
      kind: 'grant',
      payload: {
        keys: pool.keys(),
        disabledModels: [...disabledModels],
        externalKey,
      },
    }));
  }

  async function saveKeys(): Promise<void> {
    // 写入前必须确保首次**权威**装载已完成：写入是整体覆盖，若此时池子还是
    // 空的（快照尚未读到），磁盘上原有的 key 会被这次写入静默抹掉。
    //
    // 只在凭据服务**确实存在**时才等：宿主压根没有该服务时，等它没有意义，直接让
    // 下面给出明确错误，而不是让用户对着转圈的按钮等满超时。
    if (credentialsRegistered()) {
      await Promise.race([firstAuthoritativeLoad, delay(SAVE_LOAD_WAIT_MS)]);
    }
    if (credentialsService() === undefined) throw new Error('凭据服务不可用，无法保存 key');
    await persistRecord();
  }

  // ------------------------------------------------------------ provider 注册

  function buildModels(): any[] {
    const baseUrl = `${shim.baseUrl()}/v1`;
    return catalog
      .current()
      // 用户在下拉里勾掉的模型不注册，因此不会出现在模型选择器里。
      .filter((model) => !disabledModels.has(model.id))
      .map((model: SenseNovaModel) => ({
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
      // 监听失败时 server 可能已部分启动；显式关闭，避免留下半开的句柄。
      await shim.close().catch(() => {});
      return;
    }

    // ---- 端口就绪，此时才能安全构建模型描述符并注册 provider ----------------
    try {
      adapter = createAdapter();
      registration = ctx.llm.registerAdapter([PROVIDER_ID], adapter);
      ctx.effect?.(() => () => {
        // 必须**返回** close() 的 Promise：cordis 的 disposer 可以是异步的，返回它
        // 才会等回环服务真正关闭。原先写成 `void shim.close()`，卸载时 Promise 无人
        // 等待，server 仍在监听的状态下进程就可能退出 —— 在 Windows 上表现为 libuv
        // 断言（async.c: !(handle->flags & UV_HANDLE_CLOSING)），退出码 0xC0000409。
        try {
          registration?.();
        } finally {
          return shim.close();
        }
      });
      logger.info(`已注册 provider "${PROVIDER_ID}"，模型分组「${PROVIDER_NAME}」`);
    } catch (error) {
      logger.error(`注册 provider 失败：${error instanceof Error ? error.message : String(error)}`);
      await shim.close();
      return;
    }

    // ---- 装载 key（issue #1：等凭据快照真正就绪） --------------------------
    //
    // 这里不再「立刻读一次就算」，而是等凭据服务就绪的通知：`ctx.inject` 的回调
    // 只在 credentials 所属 fiber 变为 ACTIVE（`loadInitial()` 已填充快照）时触发。
    // 冷启动磁盘 IO 慢时，正是这一等把「读到空快照」变成了「读到真实的 key 列表」。
    //
    // 回调可能因服务重注册而多次触发；`pool.addKey()` 幂等，重复装载安全。
    const onCredentialsReady = (): void => {
      void loadKeysAndNotify()
        .then((added) => {
          if (added > 0) {
            refreshCatalog();
            void fetchCatalogFromUpstream();
          } else {
            logger.info('key 池为空 —— 请在「设置 → 插件 → 商汤日日新（Key 轮换池）」里填入 key');
          }
        })
        .catch((error: unknown) => {
          logger.warn(`装载 key 失败：${error instanceof Error ? error.message : String(error)}`);
        });
    };

    if (typeof ctx.inject === 'function') {
      try {
        ctx.inject(['credentials'], onCredentialsReady);
      } catch (error) {
        // 注入注册失败（例如 ctx 形状不符）：退化为「服务已就绪就直接装载一次」，
        // 至少不比旧行为更差。
        logger.warn(`等待凭据服务就绪失败，改为立即尝试装载：${error instanceof Error ? error.message : String(error)}`);
        if (credentialsService() !== undefined) onCredentialsReady();
      }
    } else if (credentialsService() !== undefined) {
      // 极老的宿主没有 ctx.inject：退化为直接装载一次（此时服务已就绪）。
      onCredentialsReady();
    }

    // 宿主没有凭据服务时，上面的回调永不触发 —— 仍需给出可操作的提示（与旧行为一致）。
    // 但如果服务**已注册、只是在加载**（冷启动的竞态场景），就绝不能在这里报
    // 「池为空」：那是还没读到，不是真的没有 key。此时静默等待即可。
    await delay(0);
    if (credentialsService() === undefined && !credentialsRegistered()) {
      logger.info('key 池为空 —— 请在「设置 → 插件 → 商汤日日新（Key 轮换池）」里填入 key');
    }
  })();

  /**
   * 兜底补载：凭据记录被**本进程之外**改动时（手工编辑 `.credentials.yaml`、
   * 另一次 boot 迁移了文档布局），credentials-local 的 watcher 会 emit
   * `credentials/record-updated`。这里据此重载，使池子最终一致。
   *
   * 注意这不是启动竞态的修复手段 —— 那条路径由 `ctx.inject(['credentials'])` 负责，
   * 因为启动装载**早于**任何事件发生，等事件是等不到的。这里只覆盖运行期变更。
   */
  try {
    ctx.on?.('credentials/record-updated', (key: unknown) => {
      if (key !== RECORD_ID) return;
      void loadKeysAndNotify()
        .then((added) => {
          if (added > 0) {
            refreshCatalog();
            void fetchCatalogFromUpstream();
          }
        })
        .catch((error: unknown) => {
          logger.warn(`记录变更后重载失败：${error instanceof Error ? error.message : String(error)}`);
        });
    });
  } catch {
    // 事件总线形状不符：不影响主路径。
  }

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

  /**
   * 保存 key 列表并刷新模型目录。
   *
   * 顺序有讲究：先落盘再 refreshCatalog —— 刷新会让模型选择器立刻重读模型，
   * 若此时记录还没写成功，用户会看到「列表变了但重启又回去了」。
   */
  const handleKeysChanged = async (): Promise<void> => {
    await saveKeys();
    refreshCatalog();
    void fetchCatalogFromUpstream();
  };

  /**
   * 应用「哪些模型出现在下拉里」。
   *
   * 落盘失败不算失败：可见性已经作用于内存，下次写入会一并带上；这里只记一条
   * 日志，不让界面上的勾选因为磁盘问题而回弹。
   */
  const handleModelsChanged = async (nextDisabled: string[]): Promise<void> => {
    disabledModels.clear();
    for (const id of nextDisabled) {
      if (typeof id === 'string' && id.length > 0) disabledModels.add(id);
    }
    refreshCatalog();
    try {
      await saveKeys();
    } catch (error) {
      logger.warn(`模型可见性落盘失败（本次会话已生效）：${error instanceof Error ? error.message : String(error)}`);
    }
  };

  // 设置页：填 key（用户明确要求只在设置页填）。
  try {
    registerSettingsSection(ctx, {
      namespace: SETTINGS_NS,
      config,
      pool,
      onKeysChanged: handleKeysChanged,
    });
  } catch (error) {
    logger.warn(`设置页注册失败（不影响模型可用）：${error instanceof Error ? error.message : String(error)}`);
  }

  // Web 路由：给设置卡片读写 key / 模型可见性 / 查看对外接口。
  try {
    registerKeyRoutes(ctx, {
      status,
      pool,
      logger,
      onKeysChanged: handleKeysChanged,
      onModelsChanged: handleModelsChanged,
      reload: async () => {
        // 手动重载：走同一套「装载并宣告」逻辑，因此在启动早期点它也不会把
        // 「还没读到」误当成「真的没有 key」而清空权威装载信号。
        await loadKeysAndNotify();
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
