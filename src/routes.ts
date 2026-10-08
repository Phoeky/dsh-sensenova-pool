/**
 * 设置页与 Web 路由：让用户**在 DSH 设置里直接填商汤 key**。
 *
 * 两条互补的通道
 * --------------
 * 1. **Web 路由**（`/plugins/dsh-sensenova-pool/keys`）—— 设置卡片用它读/写 key。
 *    这是主要的交互路径。
 * 2. **settings 命名空间** —— 在宿主支持时注册一个设置分区，让 key 也能以
 *    纯配置的方式落盘。宿主版本差异较大，因此做**特性探测**而不是假设存在：
 *    拿不到就降级为「只用 Web 路由」，而不是让整个插件加载失败。
 *
 * 安全
 * ----
 * - 只接受回环 Host/Origin 的请求（挡 DNS rebinding）。
 * - 读接口**永远不返回明文 key**，只返回脱敏值与 id；写接口只接收。
 */

import { randomBytes, timingSafeEqual } from 'node:crypto';

import type { KeyPool, KeySnapshot } from './keypool.js';
import { keyIdOf, maskKey } from './keypool.js';

/** 写操作令牌的请求头名（与浏览器半保持一致）。 */
export const ADMIN_HEADER = 'x-sensenova-pool-admin';

export interface StatusProvider {
  pool(): KeySnapshot[];
  summary(): { total: number; healthy: number; cooldown: number; invalid: number; inflight: number };
  catalog(): { source: string; count: number; fetchedAt: number; error: string };
  rotations(): Array<{ keyId: string; kind: string; status: number; message: string; at: number }>;
  providerId: string;
  providerName: string;
  baseUrl: string;
}

interface Logger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

export interface RouteDeps {
  status: StatusProvider;
  pool: KeyPool;
  logger: Logger;
  /** key 列表发生变更后回调（持久化 + 刷新目录）。 */
  onKeysChanged(): Promise<void>;
  /** 重新从凭据库装载。 */
  reload(): Promise<void>;
  /** 主动拉取上游模型目录。 */
  fetchCatalog(): Promise<void>;
}

/** 本插件的 Web 路由前缀。 */
export const ROUTE_BASE = '/plugins/dsh-sensenova-pool';

// ------------------------------------------------------------------ 工具

function loopbackRequest(req: any): boolean {
  const host = req?.headers?.host;
  if (typeof host !== 'string') return false;
  const name = host.startsWith('[') ? host.slice(1, host.indexOf(']')) : host.split(':')[0];
  const hostOk = name === '127.0.0.1' || name === 'localhost' || name === '::1';
  if (!hostOk) return false;

  const origin = req?.headers?.origin;
  if (origin === undefined) return true; // 同源 fetch 可能不带 Origin
  try {
    const { hostname } = new URL(origin);
    return hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '::1';
  } catch {
    return false;
  }
}

function sendJson(res: any, status: number, payload: unknown): void {
  const text = JSON.stringify(payload);
  try {
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    });
  } catch {
    // 已经发过响应头：尽力结束。
  }
  res.end(text);
}

async function readJsonBody(req: any, limitBytes = 64 * 1024): Promise<any> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = Buffer.from(chunk as Buffer);
    total += buf.length;
    if (total > limitBytes) throw new Error('请求体过大');
    chunks.push(buf);
  }
  const text = Buffer.concat(chunks).toString('utf8').trim();
  if (!text) return {};
  return JSON.parse(text);
}

/**
 * 归一化用户粘贴的 key。
 *
 * 用户很可能把多把 key 用换行/逗号/空格粘进一个输入框，也可能粘进带
 * `Bearer ` 前缀或引号的内容 —— 这里统一清洗，避免「看起来填了却不生效」。
 */
export function parseKeyInput(input: unknown): string[] {
  const raw: string[] = [];
  const push = (value: unknown): void => {
    if (typeof value === 'string') raw.push(value);
    else if (Array.isArray(value)) value.forEach(push);
  };
  push(input);

  const out: string[] = [];
  for (const chunk of raw) {
    for (let piece of chunk.split(/[\s,;、，；]+/)) {
      piece = piece.trim().replace(/^["'`]|["'`]$/g, '');
      piece = piece.replace(/^Bearer\s+/i, '').trim();
      if (!piece) continue;
      // 商汤 key 形如 sk-xxxx；过短的显然是误输入。
      if (piece.length < 8) continue;
      if (!out.includes(piece)) out.push(piece);
    }
  }
  return out;
}

// ------------------------------------------------------------------ 路由

/** 在可选的 webServer 服务上挂载 key 管理路由。 */
export function registerKeyRoutes(ctx: any, deps: RouteDeps): void {
  /**
   * 每进程随机的写入令牌。
   *
   * 为什么回环校验还不够：**回环本身不是身份认证** —— 任何本地进程都能伪造
   * `Host: 127.0.0.1` 来访问这些路由。写操作会改动用户的 key 池，因此额外要求
   * 调用方出示这个只有本进程页面才知道的令牌（由 /status 下发、经请求头回传）。
   */
  const adminKey = randomBytes(24).toString('hex');

  /** 常量时间比较，避免通过响应时间推断令牌。 */
  function adminKeyMatches(presented: unknown): boolean {
    if (typeof presented !== 'string') return false;
    const a = Buffer.from(presented);
    const b = Buffer.from(adminKey);
    if (a.length !== b.length) return false;
    return timingSafeEqual(a, b);
  }

  const mount = (webCtx: any): void => {
    const register = (path: string, handler: (req: any, res: any) => void | Promise<void>, label: string): void => {
      const wrapped = (req: any, res: any): void => {
        if (!loopbackRequest(req)) {
          sendJson(res, 403, { error: 'request-not-trusted' });
          return;
        }
        void Promise.resolve(handler(req, res)).catch((error: unknown) => {
          const message = error instanceof Error ? error.message : String(error);
          deps.logger.warn(`${label}: ${message}`);
          sendJson(res, 500, { error: message });
        });
      };
      const dispose = webCtx.webServer.register({ kind: 'exact', path, handler: wrapped });
      ctx.effect?.(() => () => dispose(), `dsh-sensenova-pool: ${label}`);
    };

    /** 写操作统一先验令牌；不通过则 403。返回 false 表示已响应。 */
    const requireAdmin = (req: any, res: any): boolean => {
      if (adminKeyMatches(req?.headers?.[ADMIN_HEADER])) return true;
      sendJson(res, 403, { error: '缺少或错误的写入令牌（请从插件设置卡片操作）' });
      return false;
    };

    // ---- 状态：池健康度、目录来源、最近轮换 ----------------------------
    register(`${ROUTE_BASE}/status`, async (req, res) => {
      if (req.method !== 'GET') {
        sendJson(res, 405, { error: 'method not allowed' });
        return;
      }
      sendJson(res, 200, {
        provider: deps.status.providerId,
        displayName: deps.status.providerName,
        baseUrl: deps.status.baseUrl,
        summary: deps.status.summary(),
        catalog: deps.status.catalog(),
        rotations: deps.status.rotations(),
        // 卡片靠这一份数据渲染列表，并从响应里取写令牌（同源页面才拿得到）。
        keys: deps.status.pool(),
        adminKey,
      });
    }, 'status route');

    // ---- 列出 key（永远脱敏） ------------------------------------------
    register(`${ROUTE_BASE}/keys`, async (req, res) => {
      if (req.method === 'GET') {
        sendJson(res, 200, { keys: deps.status.pool() });
        return;
      }

      if (req.method === 'POST') {
        if (!requireAdmin(req, res)) return;
        const body = await readJsonBody(req);
        const action = typeof body?.action === 'string' ? body.action : 'add';

        if (action === 'add') {
          const parsed = parseKeyInput(body?.keys ?? body?.key);
          if (parsed.length === 0) {
            sendJson(res, 400, { error: '没有解析出有效的 key（商汤 key 形如 sk-…）' });
            return;
          }
          let added = 0;
          let duplicate = 0;
          for (const key of parsed) {
            if (deps.pool.addKey(key)) added += 1;
            else duplicate += 1;
          }
          if (added > 0) await deps.onKeysChanged();
          sendJson(res, 200, {
            added,
            duplicate,
            total: deps.pool.size,
            keys: deps.status.pool(),
          });
          return;
        }

        if (action === 'remove') {
          const identifier = body?.id ?? body?.key;
          if (typeof identifier !== 'string' || !identifier) {
            sendJson(res, 400, { error: '缺少要删除的 key 标识' });
            return;
          }
          const removed = deps.pool.removeKey(identifier);
          if (removed) await deps.onKeysChanged();
          sendJson(res, 200, { removed, total: deps.pool.size, keys: deps.status.pool() });
          return;
        }

        if (action === 'clear') {
          deps.pool.clear();
          await deps.onKeysChanged();
          sendJson(res, 200, { cleared: true, total: 0, keys: [] });
          return;
        }

        if (action === 'revive') {
          // 手动复活被误判失效的 key。
          const revived = deps.pool.reviveInvalid();
          sendJson(res, 200, { revived, keys: deps.status.pool() });
          return;
        }

        if (action === 'refresh-catalog') {
          await deps.fetchCatalog();
          sendJson(res, 200, { catalog: deps.status.catalog() });
          return;
        }

        if (action === 'reload') {
          await deps.reload();
          sendJson(res, 200, { total: deps.pool.size, keys: deps.status.pool() });
          return;
        }

        sendJson(res, 400, { error: `未知操作：${action}` });
        return;
      }

      sendJson(res, 405, { error: 'method not allowed' });
    }, 'keys route');

    // ---- 单把 key 探活：真实打一次极小请求，立刻告诉用户好不好使 --------
    register(`${ROUTE_BASE}/test`, async (req, res) => {
      if (req.method !== 'POST') {
        sendJson(res, 405, { error: 'method not allowed' });
        return;
      }
      // 探活会真实消耗额度，因此同样要求写入令牌。
      if (!requireAdmin(req, res)) return;
      const body = await readJsonBody(req);
      const identifier = typeof body?.id === 'string' ? body.id : undefined;
      const candidate = identifier ? deps.pool.find(identifier) : undefined;
      if (candidate === undefined) {
        sendJson(res, 404, { error: '找不到这把 key（可能已被删除）' });
        return;
      }

      const base = deps.status.baseUrl.replace(/\/+$/, '');
      const started = Date.now();
      try {
        const response = await fetch(`${base}/chat/completions`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${candidate.key}` },
          body: JSON.stringify({
            model: typeof body?.model === 'string' && body.model ? body.model : 'deepseek-v4-flash',
            messages: [{ role: 'user', content: 'ping' }],
            max_tokens: 1,
          }),
          signal: AbortSignal.timeout(30_000),
        });
        const text = await response.text();
        let message = '';
        try {
          message = String((JSON.parse(text) as any)?.error?.message ?? '');
        } catch {
          message = text.slice(0, 200);
        }
        sendJson(res, 200, {
          ok: response.ok,
          status: response.status,
          latencyMs: Date.now() - started,
          message: response.ok ? '这把 key 可用' : message || `HTTP ${response.status}`,
        });
      } catch (error) {
        sendJson(res, 200, {
          ok: false,
          status: 0,
          latencyMs: Date.now() - started,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }, 'test route');
  };

  // webServer 是可选服务：有就挂，没有就只在日志里说明。
  if (typeof ctx.inject === 'function') {
    ctx.inject(['webServer'], mount);
  } else if (ctx.webServer !== undefined) {
    mount(ctx);
  } else {
    deps.logger.warn('webServer 服务不可用，key 管理界面不可用（模型仍可在配置文件中配置后使用）');
  }
}

// ------------------------------------------------------------------ 设置分区

export interface SettingsSectionDeps {
  namespace: string;
  config: unknown;
  pool: KeyPool;
  onKeysChanged(): Promise<void>;
}

/**
 * 注册 settings 分区（特性探测）。
 *
 * DSH 的 settings 服务在各版本间形状不同：新版提供 `installSection`，旧版没有。
 * 这里只在能力存在时注册；不存在就静默降级 —— 关键路径（Web 路由）不依赖它。
 */
export function registerSettingsSection(ctx: any, deps: SettingsSectionDeps): void {
  const install = (settingsCtx: any): void => {
    const settings = settingsCtx?.settings;
    if (settings === undefined || settings === null) return;
    if (typeof settings.installSection !== 'function') {
      // 宿主没有该 API：不是错误，Web 路由已覆盖同样能力。
      return;
    }
    const schema = {
      keys: {
        type: 'array',
        default: [],
        description: '商汤日日新 API Key（可多把，遇 429 自动轮换）',
      },
    };
    try {
      settings.installSection(ctx, deps.namespace, schema, { keys: [] }, {
        onChange: () => {
          void deps.onKeysChanged();
        },
      });
    } catch {
      // 形状不符：忽略，不影响主路径。
    }
  };

  if (typeof ctx.inject === 'function') {
    ctx.inject(['settings'], install);
  } else if (ctx.settings !== undefined) {
    install(ctx);
  }
}

export { keyIdOf, maskKey };
