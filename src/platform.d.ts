/**
 * DSH 平台模块的本地类型声明。
 *
 * 这些包由 DSH 运行时在**运行时**提供（它们随 DSH 一起打包），并不存在于本插件
 * 的 node_modules 里，因此 TS 无法解析。这里给出我们实际使用到的那部分形状，
 * 既让类型检查通过，也把「本插件依赖哪些平台 API」这件事显式记录下来。
 *
 * 声明刻意保持宽松（大量 `any`）：平台内部的完整类型随 DSH 版本演进，过度精确
 * 的复刻只会在升级时产生假阳性错误。真正的契约由运行时的集成测试保证。
 */

declare module '@deepseek-ai/schemastery' {
  export interface Schema {
    default(value: unknown): Schema;
    description(text: string): Schema;
  }
  export interface Schemastery {
    object(shape: Record<string, unknown>): Schema;
    string(): Schema;
    number(): Schema;
    boolean(): Schema;
    array(inner?: unknown): Schema;
  }
  const z: Schemastery;
  export default z;
}

declare module '@deepseek-ai/dsh-llm-pi-ai' {
  export class PiAiAdapter {
    constructor(options: {
      profiles: () => Map<string, unknown>;
      auth: unknown;
      resolveApiKey?: () => Promise<string | undefined>;
      [key: string]: unknown;
    });
  }
}

declare module '@deepseek-ai/dsh-llm' {
  export function resolveRetryPolicy(policy: unknown, label: string): unknown;
  export function resolveImageAttachmentAccess(...args: unknown[]): unknown;
}

declare module '@earendil-works/pi-ai' {
  export function createProvider(input: Record<string, unknown>): Record<string, unknown>;
}

declare module '@earendil-works/pi-ai/api/openai-completions.lazy' {
  export function openAICompletionsApi(): unknown;
}
