/**
 * 商汤 key 池的 Host 侧实现：目录缓存 + 循环 HTTP 服务 + 供应商注册。
 *
 * 为什么用「本地 shim」而不是自定义协议适配器
 * ------------------------------------------
 * DSH 的 `LlmAdapter` 需要自己实现完整的 StreamChunk 协议（文本/推理/工具调用
 * 增量、usage、finish），这是最容易出错、也最容易随 DSH 升级而漂移的一层。
 * dsh-workbuddy-connect 用一个已知可靠的技巧绕开它：在 127.0.0.1 上起一个
 * **说 OpenAI 线格式的本地 HTTP 服务**，让 pi-ai 现成的 `openai-completions`
 * 适配器去跟它说话，所有协议翻译都落在我们能完全掌控的这一层。
 *
 * 本插件沿用该架构，并在 shim 内部实现 key 轮换 + 429 降级：
 *
 *   DSH ──pi-ai(openai-completions)──▶ 127.0.0.1 shim ──轮换池──▶ token.sensenova.cn
 *
 * 于是「屏蔽 429」对上层完全透明：pi-ai 只会看到一个偶尔慢一点、但从不返回
 * 429 的 OpenAI 兼容端点。
 */

import { randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { Readable } from 'node:stream';

import { BUILTIN_MODELS, DEFAULT_BASE_URL, parseModelCatalog, type SenseNovaModel } from './catalog.js';
import { KeyPool } from './keypool.js';
import { DEFAULT_ROTATION, requestWithRotation, type AttemptLog, type RotationOptions } from './rotate.js';

// --------------------------------------------------------------------- 目录

/**
 * 模型目录缓存。
 *
 * 启动时用内置基线，拿到有效 key 后异步刷新；刷新失败保留基线，
 * 因此「没有网络」和「key 还没填」都不会让插件不可用。
 */
export class ModelCatalog {
  private models: SenseNovaModel[] = [...BUILTIN_MODELS];
  private lastFetchedAt = 0;
  private lastError = '';

  current(): readonly SenseNovaModel[] {
    return this.models;
  }

  status(): { source: 'builtin' | 'live'; count: number; fetchedAt: number; error: string } {
    return {
      source: this.lastFetchedAt > 0 ? 'live' : 'builtin',
      count: this.models.length,
      fetchedAt: this.lastFetchedAt,
      error: this.lastError,
    };
  }

  /** 用一次成功的 `/v1/models` 响应替换目录；空结果视为失败（不覆盖基线）。 */
  apply(payload: unknown): number {
    const parsed = parseModelCatalog(payload);
    if (parsed.length === 0) return 0;
    this.models = parsed;
    this.lastFetchedAt = Date.now();
    this.lastError = '';
    return parsed.length;
  }

  fail(message: string): void {
    this.lastError = message;
  }
}

// ---------------------------------------------------------------------- shim

export interface ShimOptions {
  pool: KeyPool;
  catalog: ModelCatalog;
  baseUrl: string;
  rotation?: Partial<RotationOptions>;
  logger?: { info(msg: string): void; warn(msg: string): void; error(msg: string): void };
  /** 每次因 429/网络原因切换 key 时回调，供 UI 展示。 */
  onAttemptFailed?: (log: AttemptLog) => void;
}

export interface Shim {
  ready: Promise<void>;
  baseUrl(): string;
  token(): string;
  close(): Promise<void>;
}

interface OpenAIChatBody {
  model?: string;
  stream?: boolean;
  [key: string]: unknown;
}

/** 起一个只监听 127.0.0.1 的 OpenAI 兼容服务。 */
export function createShim(options: ShimOptions): Shim {
  const { pool, catalog } = options;
  const rotation: RotationOptions = { ...DEFAULT_ROTATION, ...options.rotation };
  // 每进程随机共享密钥：DSH 用 Bearer 带上它，别的本地进程猜不到。
  const sharedSecret = randomBytes(32).toString('base64url');

  const server: Server = createServer((req, res) => {
    void handle(req, res);
  });
  const ready = new Promise<void>((resolve, reject) => {
    server.once('listening', () => resolve());
    server.once('error', reject);
  });
  server.listen(0, '127.0.0.1');

  const baseUrl = (): string => {
    const address = server.address();
    if (address === null || typeof address === 'string') {
      throw new Error('sensenova-pool shim has no listening address');
    }
    return `http://127.0.0.1:${address.port}`;
  };

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      // 防 DNS rebinding：只接受回环 Host / Origin。
      if (!hostIsLoopback(req.headers.host)) {
        writeError(res, 403, 'host_not_allowed', 'Host header must name the loopback interface');
        return;
      }
      if (!originIsLoopback(req.headers.origin)) {
        writeError(res, 403, 'origin_not_allowed', 'Origin must be a loopback origin');
        return;
      }
      if (!bearerOk(req)) {
        writeError(res, 401, 'unauthorized', 'missing or invalid Authorization bearer');
        return;
      }

      const url = (req.url ?? '/').split('?')[0];
      if (req.method === 'GET' && (url === '/healthz' || url === '/healthz/')) {
        writeJson(res, 200, { ok: true, ...pool.summary() });
        return;
      }
      if (req.method === 'GET' && (url === '/v1/models' || url === '/v1/models/')) {
        writeJson(res, 200, {
          object: 'list',
          data: catalog.current().map((model) => ({
            id: model.id,
            object: 'model',
            created: 0,
            owned_by: 'sensenova-pool',
          })),
        });
        return;
      }
      if (req.method === 'POST' && (url === '/v1/chat/completions' || url === '/v1/chat/completions/')) {
        await chatCompletions(req, res);
        return;
      }
      writeError(res, 404, 'not_found', `no such route: ${req.method} ${url}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      options.logger?.error(`sensenova-pool shim: ${message}`);
      if (!res.headersSent) writeError(res, 500, 'internal', message);
      else res.end();
    }
  }

  async function chatCompletions(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const raw = (await readBody(req)).toString('utf8');
    let body: OpenAIChatBody;
    try {
      body = JSON.parse(raw) as OpenAIChatBody;
    } catch {
      writeError(res, 400, 'invalid_request_error', 'request body must be JSON');
      return;
    }

    const wantsStream = body.stream === true;
    const upstreamUrl = `${options.baseUrl.replace(/\/+$/, '')}/chat/completions`;

    // 关键：轮换发生在「拿到首个响应」之前，因此对上层完全透明。
    const controller = new AbortController();
    req.on('close', () => controller.abort());

    const result = await requestWithRotation(
      pool,
      rotation,
      (apiKey, signal) =>
        fetch(upstreamUrl, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${apiKey}`,
            accept: wantsStream ? 'text/event-stream' : 'application/json',
          },
          body: raw,
          signal,
        }),
      {
        onAttemptFailed: (log) => {
          options.logger?.warn(
            `sensenova-pool: key ${log.keyId} ${log.kind} (${log.status}) — ${log.message}`,
          );
          options.onAttemptFailed?.(log);
        },
        signal: controller.signal,
      },
    );

    if (!result.ok) {
      if (controller.signal.aborted) {
        // 客户端主动断开：不当作错误上报。
        if (!res.headersSent) res.statusCode = 499;
        res.end();
        return;
      }
      writeError(
        res,
        outwardStatus(result.error),
        result.error.kind,
        summarizeFailure(result.error.message, result.attempts),
        result.error.kind === 'rate_limit' ? retryAfterSeconds(pool) : undefined,
      );
      return;
    }

    const upstream = result.response;

    if (!wantsStream) {
      // 非流式：直接透传 JSON。
      const text = await upstream.text();
      res.writeHead(200, {
        'content-type': upstream.headers.get('content-type') ?? 'application/json',
        'x-sensenova-pool-key': result.keyId,
        'x-sensenova-pool-attempts': String(result.attempts),
      });
      res.end(text);
      return;
    }

    // 流式：SSE 透传（工具调用增量原样通过，不在 Host 侧解析）。
    if (!upstream.body) {
      writeError(res, 502, 'upstream_empty', 'upstream returned an empty stream');
      return;
    }
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
      'x-sensenova-pool-key': result.keyId,
      'x-sensenova-pool-attempts': String(result.attempts),
    });

    let sawDone = false;
    const stream = Readable.fromWeb(upstream.body as Parameters<typeof Readable.fromWeb>[0]);
    stream.on('data', (chunk: Buffer) => {
      if (chunk.includes('[DONE]')) sawDone = true;
    });
    stream.on('error', (error: Error) => {
      // 上游流中途断了：补一个 [DONE]，否则客户端会一直等下去。
      options.logger?.warn(`sensenova-pool: upstream stream failed mid-flight: ${error.message}`);
      if (!sawDone && res.writable) res.end('data: [DONE]\n\n');
    });
    stream.on('end', () => {
      if (!sawDone && res.writable) res.end('data: [DONE]\n\n');
    });
    stream.pipe(res);
  }

  return {
    ready,
    baseUrl,
    token: () => sharedSecret,
    close: async () => {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      });
    },
  };

  // ------------------------------------------------------------- 请求工具

  function bearerOk(req: IncomingMessage): boolean {
    const header = req.headers.authorization;
    if (typeof header !== 'string') return false;
    const match = /^Bearer\s+(.+)$/i.exec(header.trim());
    if (!match) return false;
    const a = Buffer.from(match[1]);
    const b = Buffer.from(sharedSecret);
    if (a.length !== b.length) return false;
    return timingSafeEqual(a, b);
  }
}

function summarizeFailure(message: string, attempts: number): string {
  if (attempts <= 1) return message;
  return `${message}（已轮换 ${attempts} 把 key 仍失败）`;
}

/**
 * 把内部错误映射成**对上层**的状态码。
 *
 * 这是本插件最核心的一条策略：**429 绝不允许穿透到 DSH**。
 *
 * 轮换池已经用尽所有 key 之后，再把 429 原样抛给上层毫无意义 —— 上层能做的只有
 * 等待，而 DSH 看到 429 会立刻把它当成「限流失败」呈现给用户，正是用户要求屏蔽
 * 的那种体验。这里改报 **503 Service Unavailable + Retry-After**：语义上是
 * 「上游暂时不可用，稍后重试」，DSH 的 retry 策略会据此退避重试，用户看不到刺眼的
 * 限流报错。真正的 429 只存在于插件内部日志与池状态里。
 *
 * 其他错误码保持原样（400/403/404 是请求本身的问题，如实上报才有诊断价值）。
 */
function outwardStatus(error: { kind: string; status: number }): number {
  if (error.kind === 'rate_limit') return 503;
  if (error.status >= 400 && error.status < 600) return error.status;
  return 503;
}

/** 池里最快多久会有一把 key 解冻（秒），用于 Retry-After。 */
function retryAfterSeconds(pool: KeyPool): number {
  const snap = pool.snapshot();
  const soonest = snap
    .filter((entry) => entry.status !== 'invalid')
    .reduce((min, entry) => Math.min(min, entry.cooldownRemaining), Number.POSITIVE_INFINITY);
  if (!Number.isFinite(soonest)) return 5;
  return Math.max(1, Math.ceil(soonest));
}

function hostIsLoopback(host: string | undefined): boolean {
  if (typeof host !== 'string') return false;
  const name = host.startsWith('[') ? host.slice(1, host.indexOf(']')) : host.split(':')[0];
  return name === '127.0.0.1' || name === 'localhost' || name === '::1' || name === '[::1]';
}

function originIsLoopback(origin: string | undefined): boolean {
  if (origin === undefined) return true; // 同进程 fetch 不带 Origin
  try {
    const { hostname } = new URL(origin);
    return hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '::1';
  } catch {
    return false;
  }
}

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk as Buffer));
  return Buffer.concat(chunks);
}

function writeJson(res: ServerResponse, status: number, payload: unknown): void {
  const text = JSON.stringify(payload);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(text);
}

/** 输出 OpenAI 形状的错误，pi-ai 才能把它翻译成合适的 failure code。 */
function writeError(
  res: ServerResponse,
  status: number,
  code: string,
  message: string,
  retryAfterSec?: number,
): void {
  if (res.headersSent) {
    res.end();
    return;
  }
  const headers: Record<string, string> = { 'content-type': 'application/json; charset=utf-8' };
  if (retryAfterSec !== undefined) headers['retry-after'] = String(retryAfterSec);
  const payload = JSON.stringify({
    error: {
      message,
      type: code === 'rate_limit' ? 'rate_limit_error' : 'invalid_request_error',
      code,
    },
  });
  res.writeHead(status, headers);
  res.end(payload);
}

export { DEFAULT_BASE_URL };
