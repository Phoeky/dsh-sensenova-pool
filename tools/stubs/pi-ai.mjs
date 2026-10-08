// 桩件：pi-ai 的 createProvider。
export function createProvider(input) {
  globalThis.__capture?.providers.push(input);
  return { ...input, __provider: true };
}
