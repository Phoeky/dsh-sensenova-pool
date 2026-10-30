/**
 * 请求体清洗：把「Agent 合法、商汤网关不认」的写法规范成语义等价的安全写法。
 *
 * 为什么需要这一层
 * ----------------
 * shim 的职责是**透明转发**，但商汤的 schema 校验比 OpenAI 官方严得多，
 * 一批「OpenAI/DeepSeek 直连都接受」的写法会被它判成 400。而 pi-ai 发请求时
 * 完全按 OpenAI 规范构造，撞上这些点就会让用户看到：
 *
 *     400 {"message":"inference request is invalid",
 *          "type":"invalid_request_error","code":"invalid_parameter_error"}
 *     400 {"message":"invalid arguments", … ,"code":"3"}
 *
 * 实测（2026-10-30，deepseek-v4-flash，逐例对真实上游验证）下列写法全部 400：
 *
 *     {"role":"developer","content":"…"}      ← OpenAI 新规范，商汤只认 system
 *     {"role":"assistant","content":null}     ← 无 tool_calls 时
 *     {"role":"assistant"}                    ← 连字段都没有
 *     {"role":"system","content":null}
 *     {"role":"tool","content":null}          ← 工具结果为空
 *     {"role":"tool"}
 *     "arguments": {"a":1}                    ← 必须是 JSON **字符串**
 *     "content": 123                          ← 必须是字符串或数组
 *     "temperature": "0.7"                    ← 必须是数字
 *     "logprobs" / "top_logprobs" / "metadata"
 *     "reasoning_effort": "off" / "max" / "minimal"
 *
 * 规范成等价安全写法后实测全部 200。
 *
 * 刻意**不代改**的三类（改了是把错误往后推，甚至篡改用户意图）：
 *   * `user.content` 为 null/""：确实是空用户轮，上游报 `user content required`；
 *   * 数值越界（temperature=3、frequency_penalty=5）：上游报错信息已足够明确；
 *   * 未知 role（除 developer 外）：猜错会掩盖真正的调用错误。
 */

/** 商汤不认识的角色名 → 映射成等价角色。`developer` 是 OpenAI 新规范里替代 system 的角色。 */
const ROLE_ALIASES: Readonly<Record<string, string>> = { developer: 'system' };

/** 允许 `content` 缺失/null 的角色（带 tool_calls 的 assistant 例外，见下）。 */
const NULLABLE_CONTENT_ROLES = new Set(['assistant', 'system', 'tool']);

/** 商汤拒收的顶层字段。 */
const UNSUPPORTED_FIELDS = ['logprobs', 'top_logprobs', 'metadata'] as const;

/** 必须是数字的采样参数（pi-ai 偶尔会传字符串）。 */
const NUMERIC_PARAMS = ['temperature', 'top_p', 'frequency_penalty', 'presence_penalty'] as const;

/**
 * `reasoning_effort` 的合法取值。
 *
 * 实测（2026-10-30，deepseek-v4-flash）上游报错原文写得很明确：
 *   `field ReasoningEffort invalid, should be one of:
 *    none, minimal, low, medium, high, xhigh, max`
 *
 * 注意 **`minimal` 与 `max` 都是合法的** —— 不能像有些资料说的那样把它们
 * 当成非法值映射掉，那会悄悄改掉用户要求的推理等级（`max` 尤其明显）。
 * 唯一需要翻译的是 DSH 侧的 `off`，商汤拼作 `none`。
 */
const REASONING_EFFORT_ALIASES: Readonly<Record<string, string>> = { off: 'none' };
const REASONING_EFFORT_ALLOWED = new Set([
  'none',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
]);

export interface SanitizeResult<T> {
  body: T;
  /** 实际做过的改动，供日志/UI 展示（空数组表示原样放行）。 */
  changes: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 把 content 规范成商汤能接受的形态；没改动返回 `undefined`。 */
function normalizeContent(message: Record<string, unknown>): Record<string, unknown> | undefined {
  const role = message.role;
  const hasContent = 'content' in message;
  const content = message.content;

  if (!hasContent || content === null || content === undefined) {
    // assistant 带 tool_calls 时商汤接受 content:null，保持原样（动它反而有风险）
    if (role === 'assistant' && Array.isArray(message.tool_calls) && message.tool_calls.length > 0) {
      return undefined;
    }
    if (typeof role === 'string' && NULLABLE_CONTENT_ROLES.has(role)) {
      return { ...message, content: '' };
    }
    return undefined;
  }

  if (typeof content === 'string' || Array.isArray(content)) return undefined;
  if (typeof content === 'number' || typeof content === 'boolean') {
    return { ...message, content: String(content) };
  }
  return undefined;
}

/** 角色名映射；没改动返回 `undefined`。 */
function normalizeRole(message: Record<string, unknown>): Record<string, unknown> | undefined {
  const role = message.role;
  if (typeof role !== 'string') return undefined;
  const mapped = ROLE_ALIASES[role.trim().toLowerCase()];
  if (mapped === undefined || mapped === role) return undefined;
  return { ...message, role: mapped };
}

/**
 * `tool_calls[*].function.arguments` 必须是 JSON 字符串：
 * 传了对象/数字就序列化过去（OpenAI 规范本身也要求字符串）。
 */
function normalizeToolCalls(message: Record<string, unknown>): Record<string, unknown> | undefined {
  const calls = message.tool_calls;
  if (!Array.isArray(calls) || calls.length === 0) return undefined;

  let changed = false;
  const next = calls.map((call) => {
    if (!isRecord(call)) return call;
    const func = call.function;
    if (!isRecord(func)) return call;
    const args = func.arguments;
    if (typeof args === 'string') return call;
    changed = true;
    return {
      ...call,
      function: { ...func, arguments: JSON.stringify(args ?? {}) },
    };
  });

  return changed ? { ...message, tool_calls: next } : undefined;
}

/** 清洗 messages 数组，返回改动说明。 */
function sanitizeMessages(
  messages: unknown,
  changes: string[],
): unknown {
  if (!Array.isArray(messages)) return messages;

  return messages.map((message, index) => {
    if (!isRecord(message)) return message;

    let current = message;
    const steps: Array<[string, (m: Record<string, unknown>) => Record<string, unknown> | undefined]> = [
      ['role', normalizeRole],
      ['content', normalizeContent],
      ['arguments', normalizeToolCalls],
    ];

    for (const [label, step] of steps) {
      const result = step(current);
      if (result !== undefined) {
        current = result;
        changes.push(`messages[${index}].${label}`);
      }
    }
    return current;
  });
}

/** 归一 `reasoning_effort`；无法识别时直接摘掉该字段（比猜一个值更安全）。 */
function sanitizeReasoningEffort(body: Record<string, unknown>, changes: string[]): void {
  if (!('reasoning_effort' in body)) return;
  const raw = body.reasoning_effort;

  if (typeof raw !== 'string') {
    delete body.reasoning_effort;
    changes.push('reasoning_effort');
    return;
  }

  const lowered = raw.trim().toLowerCase();
  if (REASONING_EFFORT_ALLOWED.has(lowered)) {
    if (lowered !== raw) {
      body.reasoning_effort = lowered;
      changes.push('reasoning_effort');
    }
    return;
  }

  const mapped = REASONING_EFFORT_ALIASES[lowered];
  if (mapped !== undefined) {
    body.reasoning_effort = mapped;
    changes.push('reasoning_effort');
    return;
  }

  // 未知取值：删掉比瞎映射更安全（关掉这一轮思考，而不是发出非法值撞 400）。
  delete body.reasoning_effort;
  changes.push('reasoning_effort');
}

/**
 * 清洗一份 OpenAI chat 请求体。
 *
 * 只做**语义等价**的改写，不改变请求意图；返回改动清单便于排查。
 * 非对象输入原样返回（交给上游如实报错）。
 */
export function sanitizeChatRequest<T>(input: T): SanitizeResult<T> {
  const changes: string[] = [];

  if (!isRecord(input)) return { body: input, changes };

  const body: Record<string, unknown> = { ...input };

  for (const field of UNSUPPORTED_FIELDS) {
    if (field in body) {
      delete body[field];
      changes.push(field);
    }
  }

  for (const field of NUMERIC_PARAMS) {
    const value = body[field];
    if (typeof value === 'string') {
      const parsed = Number(value);
      if (Number.isFinite(parsed)) {
        body[field] = parsed;
        changes.push(field);
      }
    }
  }

  sanitizeReasoningEffort(body, changes);

  if ('messages' in body) {
    const next = sanitizeMessages(body.messages, changes);
    if (next !== body.messages) body.messages = next;
  }

  return { body: changes.length > 0 ? (body as T) : input, changes };
}