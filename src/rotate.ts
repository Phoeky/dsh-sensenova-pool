/**
 * 轮换上游客户端：把「一次对话请求」变成「在 key 池上的一次带重试调度」。
 *
 * 关键不变量
 * ----------
 * - **只在响应开始吐字节之前换 key**。一旦 SSE 已经把内容写给下游，重试就会
 *   造成重复输出，因此流中途断开只能如实报错（`StreamInterrupted`）。
 * - 每一次尝试都从池里 acquire 一把，并在 finally 里 release，无论成败。
 * - 429 / 5xx 换 key 重试；401/403 按 key 处置；404/400 直接上报（换 key 无用）。
 */

import { createHash } from 'node:crypto';

import {
  classifyError,
  isRetryableAcrossKeys,
  type ClassifiedError,
} from './catalog.js';
import type { KeyPool } from './keypool.js';

/** 单次尝试的结果。 */
export type AttemptResult =
  | { ok: true; response: Response; keyId: string; attempts: number }
  | { ok: false; error: ClassifiedError; keyId: string; attempts: number; poolExhausted: boolean };

export interface RotationOptions {
  /** 最多尝试几把 key（含第一次）。 */
  maxAttempts: number;
  /** 等待可用 key 的总预算（毫秒）。 */
  acquireTimeoutMs: number;
  /** 单次上游请求的建连+首字节超时（毫秒）。 */
  requestTimeoutMs: number;
  /** 是否把 5xx 也算作可跨 key 重试。 */
  retryServerErrors: boolean;
}

export const DEFAULT_ROTATION: RotationOptions = {
  maxAttempts: 6,
  acquireTimeoutMs: 120000,
  requestTimeoutMs: 60000,
  retryServerErrors: true,
};

/** 流已经开始吐字节后中断 —— 不能安全重试（会造成重复输出）。 */
export class StreamInterruptedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StreamInterruptedError';
  }
}

/** 一个可用的 key 快照，供 UI / 日志展示。 */
export interface AttemptLog {
  keyId: string;
  status: number;
  kind: string;
  message: string;
  at: number;
}

/**
 * 在 key 池上执行一次请求，遇 429 自动换 key。
 *
 * 返回值可能是一个成功的 `Response`（此时调用方负责消费 body），或一个最终错误。
 */
export async function requestWithRotation(
  pool: KeyPool,
  options: RotationOptions,
  send: (apiKey: string, signal: AbortSignal) => Promise<Response>,
  hooks: {
    /** 每次失败切换时回调，便于把「换了哪把 key」写入日志/UI。 */
    onAttemptFailed?: (log: AttemptLog) => void;
    /** 外部取消信号。 */
    signal?: AbortSignal;
  } = {},
): Promise<AttemptResult> {
  const attempted = new Set<string>();
  const deadline = Date.now() + options.acquireTimeoutMs;
  let lastError: ClassifiedError = { kind: 'client', status: 0, message: 'no attempt was made' };
  let lastKeyId = '';
  let attempts = 0;

  for (let index = 0; index < options.maxAttempts; index += 1) {
    if (hooks.signal?.aborted) {
      return { ok: false, error: { kind: 'client', status: 0, message: 'aborted' }, keyId: lastKeyId, attempts, poolExhausted: false };
    }

    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      return { ok: false, error: lastError, keyId: lastKeyId, attempts, poolExhausted: true };
    }

    // ---- 取一把本轮的 key ------------------------------------------------
    let entry;
    try {
      entry = await pool.acquire({ exclude: attempted, timeoutMs: remaining });
    } catch (error) {
      // 池空 / 全部失效 / 等超时：把最后一次真实的上游错误报上去更有信息量。
      const poolMessage = error instanceof Error ? error.message : String(error);
      return {
        ok: false,
        error: attempts > 0 ? lastError : { kind: 'client', status: 0, message: poolMessage },
        keyId: lastKeyId,
        attempts,
        poolExhausted: true,
      };
    }

    lastKeyId = entry.key.length > 0 ? keyIdFor(entry.key) : lastKeyId;
    attempted.add(entry.key);
    attempts += 1;

    // ---- 发请求 ----------------------------------------------------------
    const started = Date.now();
    try {
      const controller = new AbortController();
      const onAbort = (): void => controller.abort();
      hooks.signal?.addEventListener('abort', onAbort, { once: true });
      const timer = setTimeout(() => controller.abort(), options.requestTimeoutMs);
      let response: Response;
      try {
        response = await send(entry.key, controller.signal);
      } finally {
        clearTimeout(timer);
        hooks.signal?.removeEventListener('abort', onAbort);
      }

      if (response.ok) {
        pool.reportSuccess(entry, Date.now() - started);
        return { ok: true, response, keyId: keyIdFor(entry.key), attempts };
      }

      // ---- 失败：读错误体、分类、记账 -----------------------------------
      const body = await safeReadText(response);
      const classified = classifyError(
        response.status,
        body,
        response.headers.get('retry-after'),
      );

      switch (classified.kind) {
        case 'rate_limit': {
          const delayMs = pool.reportRateLimit(entry, classified.retryAfterMs);
          hooks.onAttemptFailed?.({
            keyId: keyIdFor(entry.key),
            status: response.status,
            kind: classified.kind,
            message: `${classified.message} → 冷却 ${Math.round(delayMs / 1000)}s，切换下一把 key`,
            at: Date.now(),
          });
          lastError = classified;
          break;
        }
        case 'invalid_credential': {
          pool.reportInvalid(entry, classified.message);
          hooks.onAttemptFailed?.({
            keyId: keyIdFor(entry.key),
            status: response.status,
            kind: classified.kind,
            message: `${classified.message} → 该 key 标记失效，切换下一把 key`,
            at: Date.now(),
          });
          lastError = classified;
          break;
        }
        case 'server': {
          if (options.retryServerErrors) pool.reportServerError(entry, classified.message);
          else pool.reportClientError(entry, classified.message);
          hooks.onAttemptFailed?.({
            keyId: keyIdFor(entry.key),
            status: response.status,
            kind: classified.kind,
            message: classified.message,
            at: Date.now(),
          });
          lastError = classified;
          break;
        }
        default: {
          // 400/403(套餐)/404：换 key 解决不了，立即上报，避免空转整池 key。
          pool.reportClientError(entry, classified.message);
          return { ok: false, error: classified, keyId: keyIdFor(entry.key), attempts, poolExhausted: false };
        }
      }

      if (!isRetryableAcrossKeys(classified.kind)) {
        return { ok: false, error: classified, keyId: keyIdFor(entry.key), attempts, poolExhausted: false };
      }
    } catch (error) {
      // 网络层错误（DNS / 连接被拒 / 超时 abort）：短冷却后换 key。
      const message = error instanceof Error ? error.message : String(error);
      const aborted = hooks.signal?.aborted === true;
      if (aborted) {
        pool.reportServerError(entry, 'client aborted');
        return { ok: false, error: { kind: 'client', status: 0, message: 'aborted' }, keyId: keyIdFor(entry.key), attempts, poolExhausted: false };
      }
      pool.reportServerError(entry, message);
      hooks.onAttemptFailed?.({
        keyId: keyIdFor(entry.key),
        status: 0,
        kind: 'network',
        message: `${message} → 切换下一把 key`,
        at: Date.now(),
      });
      lastError = { kind: 'server', status: 0, message };
    } finally {
      pool.release(entry);
    }

    // ---- 轮次边界：所有 key 都试过一轮后，重置「本轮跳过」集合 --------------
    //
    // `attempted` 的语义是「优先换别的 key」，而不是「这把 key 本次请求再也不
    // 能用」。若不重置，池里只有一把 key 时，第一次 429 之后便再无候选，只能
    // 干等 acquire 超时 —— 明明冷却几秒后就可用了。
    //
    // 真正防止「重试风暴」的是池子本身的两道闸门，而非这里的集合：
    //   1. `cooldownUntil` —— 冷却中的 key 根本不会被选中；
    //   2. `maxConcurrency` —— 同一把 key 的并发被限住。
    // 因此重置后只会「等冷却结束再试一次」，不会对同一把 key 连续空转。
    if (attempted.size >= pool.size) {
      attempted.clear();
    }
  }

  return { ok: false, error: lastError, keyId: lastKeyId, attempts, poolExhausted: true };
}

/** 延迟 import，避免 catalog 与 keypool 形成循环依赖。 */
function keyIdFor(key: string): string {
  let id = keyIdCache.get(key);
  if (id === undefined) {
    id = createHash('sha256').update(key, 'utf8').digest('hex').slice(0, 12);
    if (keyIdCache.size > 256) keyIdCache.clear();
    keyIdCache.set(key, id);
  }
  return id;
}

const keyIdCache = new Map<string, string>();

async function safeReadText(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return '';
  }
}
