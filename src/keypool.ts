/**
 * Key 轮换池：多把商汤 key 的调度、冷却与统计。
 *
 * 移植自 st-rotator 的 `keypool.py`，保留其核心设计要点：
 *
 * 1. 每把 key 独立维护状态：healthy / cooldown / invalid，外加最近 60s 的
 *    请求时间窗，用于本地 RPM 预限流（主动避开而不是被动挨打）。
 * 2. `acquire()` 返回一把被「占用」的 key，调用方必须在 finally 里 `release()`；
 *    等待挂在 Promise 上，key 一恢复可用立刻唤醒，不做无谓轮询。
 * 3. 429 走指数退避 + 抖动冷却；401/403 直接标记失效并排除，避免在坏 key 上
 *    反复空转；5xx / 网络超时只做短冷却（不是 key 的错，也不累计退避）。
 * 4. 单线程事件循环下无需锁，但跨 await 的状态变更都集中在本类内，保持可审计。
 *
 * 与 st-rotator 的一处关键差异：那里 429 会连带冷却整个账号下的所有 key
 * （account 级联动）。商汤的 tpm/rpm 限流是**按 key** 计的，多把 key 往往属于
 * 同一账号；若整账号联动冷却，池子会瞬间全部静默，轮换就失去意义。因此这里
 * 默认只冷却**出错的那一把**，把额度均摊出去 —— 这正是轮换池的价值所在。
 */

import { createHash } from 'node:crypto';

export type KeyStatus = 'healthy' | 'cooldown' | 'invalid';

export interface KeyStats {
  requests: number;
  successes: number;
  failures: number;
  rateLimited: number;
  serverErrors: number;
  clientErrors: number;
  totalLatencyMs: number;
}

export interface KeySnapshot {
  id: string;
  key: string;
  status: KeyStatus;
  cooldownRemaining: number;
  inflight: number;
  consecutiveFailures: number;
  rpmWindow: string;
  lastError: string;
  stats: KeyStats & { successRate: number; avgLatencyMs: number };
}

export interface CooldownConfig {
  /** 429 首次冷却基数（秒）。 */
  base: number;
  /** 每次连续 429 的冷却倍数。 */
  factor: number;
  /** 冷却上限（秒）。 */
  max: number;
  /** 抖动比例，避免多把 key 同时解冻造成尖峰。 */
  jitter: number;
  /** 401/403 失效后多久自动复探（秒）；0 表示永不自动复活。 */
  invalidTtl: number;
  /** 5xx / 网络错误的短冷却（秒）。 */
  serverError: number;
}

export const DEFAULT_COOLDOWN: CooldownConfig = {
  base: 20,
  factor: 1.6,
  max: 180,
  jitter: 0.3,
  invalidTtl: 600,
  serverError: 3,
};

/** 本地 RPM 预限流窗口长度（秒），与服务端统计口径一致。 */
const RPM_WINDOW_SECONDS = 60;

/** 脱敏展示：日志里永远不要出现完整 key，但要能区分是哪一把。 */
export function maskKey(key: string): string {
  if (!key) return '***';
  const length = key.length;
  if (length <= 6) return key[0] + '*'.repeat(Math.max(0, length - 1));
  if (length <= 14) return `${key.slice(0, 2)}${'*'.repeat(length - 4)}${key.slice(-2)}`;
  return `${key.slice(0, 6)}...${key.slice(-4)}`;
}

/**
 * 给一把 key 生成稳定短标识（sha256 前 12 位）。
 *
 * 为什么需要它：控制台只拿到脱敏后的 key，而脱敏值可能撞车（两把 key 恰好首尾
 * 相同）。要精确地「测试/删除某一把」，就需要一个既能唯一定位、又不泄漏原文的标识。
 */
export function keyIdOf(key: string): string {
  return createHash('sha256').update(key, 'utf8').digest('hex').slice(0, 12);
}

interface KeyEntry {
  key: string;
  status: KeyStatus;
  cooldownUntil: number;
  consecutiveFailures: number;
  inflight: number;
  lastUsed: number;
  lastError: string;
  stats: KeyStats;
  /** 最近 60s 内的发起时间戳（epoch ms）。 */
  window: number[];
}

export class NoAvailableKeyError extends Error {
  readonly retryAfterMs: number;
  constructor(message: string, retryAfterMs = 0) {
    super(message);
    this.name = 'NoAvailableKeyError';
    this.retryAfterMs = retryAfterMs;
  }
}

export class AllKeysInvalidError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AllKeysInvalidError';
  }
}

/**
 * 多 key 轮换池。
 *
 * 事件循环单线程，因此这里用一个「版本号 + 等待者队列」代替 Python 的
 * Condition：任何状态变更都会 bump 版本号并唤醒所有等待者重新评估。
 */
export class KeyPool {
  private entries: KeyEntry[] = [];
  private cursor = 0;
  private version = 0;
  private waiters = new Set<() => void>();
  private cooldown: CooldownConfig;
  /** 每把 key 的本地 RPM 上限；null 表示不限流。 */
  private rpmLimit: number | null;
  /** 每把 key 的并发上限；防止并发风暴把配额瞬间打爆。 */
  private maxConcurrency: number;

  constructor(
    keys: readonly string[] = [],
    options: { cooldown?: Partial<CooldownConfig>; rpmLimit?: number | null; maxConcurrency?: number } = {},
  ) {
    this.cooldown = { ...DEFAULT_COOLDOWN, ...options.cooldown };
    this.rpmLimit = options.rpmLimit ?? null;
    // 默认 1：串行使用每把 key。商汤的 tpm/rpm 限流按 key 计，同一把 key 并发
    // 只会互相挤占额度并触发 429；串行 + 多把 key 轮换才是正确的扩容姿势。
    this.maxConcurrency = Math.max(1, options.maxConcurrency ?? 1);
    for (const key of keys) this.addKey(key);
  }

  // --------------------------------------------------------------- 只读访问

  get size(): number {
    return this.entries.length;
  }

  keys(): string[] {
    return this.entries.map((entry) => entry.key);
  }

  has(key: string): boolean {
    return this.entries.some((entry) => entry.key === key);
  }

  /** 按明文或 keyId 查找。 */
  find(identifier: string): KeyEntry | undefined {
    return (
      this.entries.find((entry) => entry.key === identifier) ??
      this.entries.find((entry) => keyIdOf(entry.key) === identifier)
    );
  }

  // ------------------------------------------------------------- 运行时增删

  /** 加一把 key；已存在则返回 false。 */
  addKey(key: string): boolean {
    const trimmed = (key ?? '').trim();
    if (!trimmed) return false;
    if (this.has(trimmed)) return false;
    this.entries.push({
      key: trimmed,
      status: 'healthy',
      cooldownUntil: 0,
      consecutiveFailures: 0,
      inflight: 0,
      lastUsed: 0,
      lastError: '',
      stats: {
        requests: 0,
        successes: 0,
        failures: 0,
        rateLimited: 0,
        serverErrors: 0,
        clientErrors: 0,
        totalLatencyMs: 0,
      },
      window: [],
    });
    this.notify();
    return true;
  }

  /** 移除一把 key（可用明文或 keyId）。在途请求持有自己的 entry，照常 release。 */
  removeKey(identifier: string): boolean {
    const index = this.entries.findIndex(
      (entry) => entry.key === identifier || keyIdOf(entry.key) === identifier,
    );
    if (index < 0) return false;
    this.entries.splice(index, 1);
    if (this.cursor >= this.entries.length) this.cursor = 0;
    this.notify();
    return true;
  }

  clear(): void {
    this.entries = [];
    this.cursor = 0;
    this.notify();
  }

  // --------------------------------------------------------------- 获取/归还

  /**
   * 取一把可用 key。
   *
   * @param exclude 本轮不要使用的 key 明文集合（例如刚被判 429 的）。
   * @param timeoutMs 最长等待毫秒；到点仍无可用 key 抛 NoAvailableKeyError。
   */
  async acquire(options: { exclude?: ReadonlySet<string>; timeoutMs?: number } = {}): Promise<KeyEntry> {
    const exclude = options.exclude ?? new Set<string>();
    const deadline = options.timeoutMs === undefined ? undefined : Date.now() + options.timeoutMs;

    for (;;) {
      const now = Date.now();
      this.refresh(now);

      if (this.entries.length === 0) {
        throw new NoAvailableKeyError('Key 池为空，请先在设置里添加至少一把商汤 key');
      }
      if (this.entries.every((entry) => entry.status === 'invalid')) {
        throw new AllKeysInvalidError(
          `全部 ${this.entries.length} 把 key 均已被判定失效（401/403），请更换凭据`,
        );
      }

      const candidates = this.entries.filter((entry) => this.isUsable(entry, now, exclude));
      if (candidates.length > 0) return this.reserve(this.pick(candidates), now);

      const wait = this.nextWait(now, exclude);
      if (deadline !== undefined && now >= deadline) {
        throw new NoAvailableKeyError(`等待可用 key 超时：${this.describe(now, exclude)}`, wait);
      }
      // 等待时长取「下一个 key 解冻」与「剩余预算」的较小值，避免睡过头。
      const sleepFor = deadline === undefined ? wait : Math.min(wait, Math.max(0, deadline - now));
      await this.sleepUntilChanged(sleepFor || 25);
    }
  }

  /**
   * 归还 key（只减 inflight，不改变健康状态）。
   *
   * 注意：被 removeKey 移除的 entry 不在池内，但仍需正常递减 —— 这里直接操作
   * 传入的 entry 对象，因此移除后归还同样安全。
   */
  release(entry: KeyEntry): void {
    if (entry.inflight > 0) entry.inflight -= 1;
    this.notify();
  }

  private reserve(entry: KeyEntry, now: number): KeyEntry {
    entry.inflight += 1;
    entry.lastUsed = now;
    entry.window.push(now);
    entry.stats.requests += 1;
    return entry;
  }

  // ---------------------------------------------------------------- 选择策略

  /** round_robin：按池内顺序轮转，配额均摊最均匀。 */
  private pick(candidates: KeyEntry[]): KeyEntry {
    const size = this.entries.length;
    for (let offset = 0; offset < size; offset += 1) {
      const entry = this.entries[(this.cursor + offset) % size];
      if (candidates.includes(entry)) {
        this.cursor = (this.cursor + offset + 1) % size;
        return entry;
      }
    }
    return candidates[0];
  }

  // ---------------------------------------------------------------- 结果上报

  reportSuccess(entry: KeyEntry, latencyMs?: number): void {
    entry.stats.successes += 1;
    if (latencyMs !== undefined) entry.stats.totalLatencyMs += latencyMs;
    entry.consecutiveFailures = 0;
    entry.cooldownUntil = 0;
    entry.status = 'healthy';
    entry.lastError = '';
    this.notify();
  }

  /** 记录一次 429，返回实际冷却毫秒数。 */
  reportRateLimit(entry: KeyEntry, retryAfterMs?: number): number {
    entry.stats.rateLimited += 1;
    entry.stats.failures += 1;
    entry.consecutiveFailures += 1;

    const { base, factor, max, jitter } = this.cooldown;
    const raw = Math.min(base * factor ** (entry.consecutiveFailures - 1), max);
    // 抖动：0.7~1.3 倍（jitter=0.3），避免多把 key 同时解冻。
    const jittered = raw * (1 + (Math.random() * 2 - 1) * jitter);
    let delayMs = Math.round(jittered * 1000);

    // 尊重服务端的 Retry-After，但别被拖死。
    if (retryAfterMs && retryAfterMs > delayMs) delayMs = Math.min(retryAfterMs, max * 4 * 1000);

    entry.status = 'cooldown';
    entry.cooldownUntil = Date.now() + delayMs;
    entry.lastError = `429 rate limited (#${entry.consecutiveFailures})`;
    this.notify();
    return delayMs;
  }

  /** 记录一次 5xx / 网络超时：短冷却，不累计退避次数。 */
  reportServerError(entry: KeyEntry, detail = ''): number {
    entry.stats.serverErrors += 1;
    entry.stats.failures += 1;
    const delayMs = this.cooldown.serverError * 1000;
    entry.status = 'cooldown';
    entry.cooldownUntil = Math.max(entry.cooldownUntil, Date.now() + delayMs);
    entry.lastError = detail || 'server/network error';
    this.notify();
    return delayMs;
  }

  /** 记录一次凭据失效（401/403）。 */
  reportInvalid(entry: KeyEntry, detail = ''): void {
    entry.stats.failures += 1;
    entry.status = 'invalid';
    entry.lastError = detail || 'invalid credential';
    // invalidTtl 到期后自动复探；0 表示永久失效。
    entry.cooldownUntil = this.cooldown.invalidTtl > 0 ? Date.now() + this.cooldown.invalidTtl * 1000 : 0;
    this.notify();
  }

  /** 记录一次业务错误（400/404 等）—— 不是 key 的问题，只计数。 */
  reportClientError(entry: KeyEntry, detail = ''): void {
    entry.stats.clientErrors += 1;
    entry.stats.failures += 1;
    entry.lastError = detail || 'client error';
  }

  /** 复活被判失效的 key（清冷却、清连续失败）。返回复活数量。 */
  reviveInvalid(): number {
    let revived = 0;
    for (const entry of this.entries) {
      if (entry.status !== 'invalid') continue;
      entry.status = 'healthy';
      entry.cooldownUntil = 0;
      entry.consecutiveFailures = 0;
      entry.lastError = '';
      revived += 1;
    }
    if (revived > 0) this.notify();
    return revived;
  }

  // ------------------------------------------------------------------ 状态机

  private isUsable(entry: KeyEntry, now: number, exclude: ReadonlySet<string>): boolean {
    if (exclude.has(entry.key)) return false;
    if (entry.status === 'invalid') return false;
    if (entry.inflight >= this.maxConcurrency) return false;
    return this.availableAt(entry, now) <= now;
  }

  private availableAt(entry: KeyEntry, now: number): number {
    return Math.max(entry.cooldownUntil, this.rpmBlockedUntil(entry, now));
  }

  /** 本地 RPM 窗口何时才腾出额度（0 表示当前就有额度）。 */
  private rpmBlockedUntil(entry: KeyEntry, now: number): number {
    if (!this.rpmLimit) return 0;
    this.prune(entry, now);
    if (entry.window.length < this.rpmLimit) return 0;
    // 需要最早的那批请求滑出窗口，才能回到 limit-1。
    return entry.window[entry.window.length - this.rpmLimit] + RPM_WINDOW_SECONDS * 1000;
  }

  private prune(entry: KeyEntry, now: number): void {
    const cutoff = now - RPM_WINDOW_SECONDS * 1000;
    let index = 0;
    while (index < entry.window.length && entry.window[index] < cutoff) index += 1;
    if (index > 0) entry.window.splice(0, index);
  }

  /** 把冷却到期的 key 复活。 */
  private refresh(now: number): void {
    for (const entry of this.entries) {
      if (entry.status === 'invalid') {
        // invalidTtl=0 表示永久失效，不参与复活。
        if (this.cooldown.invalidTtl <= 0) continue;
        if (entry.cooldownUntil !== 0 && entry.cooldownUntil <= now) {
          entry.status = 'healthy';
          entry.cooldownUntil = 0;
          entry.consecutiveFailures = 0;
          entry.lastError = '';
        }
        continue;
      }
      if (entry.cooldownUntil !== 0 && entry.cooldownUntil <= now) {
        entry.cooldownUntil = 0;
        entry.status = 'healthy';
        entry.consecutiveFailures = 0;
        entry.lastError = '';
      }
    }
  }

  /** 还需要等多久才可能有 key 可用（0 表示只是并发打满，等 release 通知）。 */
  private nextWait(now: number, exclude: ReadonlySet<string>): number {
    let soonest: number | undefined;
    for (const entry of this.entries) {
      if (exclude.has(entry.key) || entry.status === 'invalid') continue;
      const moment = this.availableAt(entry, now);
      if (moment <= now) return 0;
      soonest = soonest === undefined ? moment : Math.min(soonest, moment);
    }
    return soonest === undefined ? 0 : Math.max(soonest - now, 0);
  }

  private describe(now: number, exclude: ReadonlySet<string> = new Set()): string {
    return this.entries
      .map((entry) => {
        const label = `${maskKey(entry.key)}(${keyIdOf(entry.key)})`;
        if (exclude.has(entry.key)) return `${label}=本轮跳过`;
        if (entry.status === 'invalid') return `${label}=失效`;
        const remain = this.availableAt(entry, now) - now;
        if (remain > 0) return `${label}=${(remain / 1000).toFixed(1)}s后可用`;
        return `${label}=并发已满`;
      })
      .join('; ');
  }

  // -------------------------------------------------------------- 等待/唤醒

  private notify(): void {
    this.version += 1;
    for (const wake of this.waiters) wake();
  }

  /**
   * 睡到「被唤醒」或超时。
   *
   * 用版本号快照而不是轮询：任何 report / release / addKey 都会 bump 版本并唤醒，
   * 因此 key 一恢复可用就立刻继续，不会白等到超时。
   */
  private sleepUntilChanged(ms: number): Promise<void> {
    const snapshot = this.version;
    return new Promise((resolve) => {
      let done = false;
      const finish = (): void => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        this.waiters.delete(finish);
        resolve();
      };
      const timer = setTimeout(finish, Math.max(1, ms));
      // 版本已变（在我们注册前就唤醒了）则立即返回。
      if (this.version !== snapshot) {
        finish();
        return;
      }
      this.waiters.add(finish);
    });
  }

  // -------------------------------------------------------------------- 快照

  snapshot(): KeySnapshot[] {
    const now = Date.now();
    this.refresh(now);
    return this.entries.map((entry) => {
      this.prune(entry, now);
      const { stats } = entry;
      return {
        id: keyIdOf(entry.key),
        key: maskKey(entry.key),
        status: entry.status,
        cooldownRemaining: Math.round(Math.max(0, entry.cooldownUntil - now) / 100) / 10,
        inflight: entry.inflight,
        consecutiveFailures: entry.consecutiveFailures,
        rpmWindow: `${entry.window.length}/${this.rpmLimit ?? '-'}`,
        lastError: entry.lastError,
        stats: {
          ...stats,
          successRate: stats.requests > 0 ? stats.successes / stats.requests : 1,
          avgLatencyMs: stats.successes > 0 ? stats.totalLatencyMs / stats.successes : 0,
        },
      };
    });
  }

  summary(): { total: number; healthy: number; cooldown: number; invalid: number; inflight: number } {
    const now = Date.now();
    this.refresh(now);
    return {
      total: this.entries.length,
      healthy: this.entries.filter((entry) => entry.status === 'healthy').length,
      cooldown: this.entries.filter((entry) => entry.status === 'cooldown').length,
      invalid: this.entries.filter((entry) => entry.status === 'invalid').length,
      inflight: this.entries.reduce((sum, entry) => sum + entry.inflight, 0),
    };
  }

  /** 当前是否有任何 key 立即可用（不等待）。 */
  anyUsable(): boolean {
    const now = Date.now();
    this.refresh(now);
    return this.entries.some((entry) => this.isUsable(entry, now, new Set()));
  }
}
