// 桩件：dsh-llm 的 retry policy 解析。
export function resolveRetryPolicy() {
  return {
    mode: 'normal',
    maxRetries: 5,
    retryableCodes: [],
    initialDelayMs: 500,
    maxDelayMs: 8000,
    jitterRatio: 0.2,
  };
}

export function resolveImageAttachmentAccess() {
  return undefined;
}
