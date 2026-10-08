// 桩件：schemastery 的最小可用替身（链式 API 全部返回自身）。
const chain = () => {
  const api = {
    default: () => api,
    description: () => api,
  };
  return api;
};

const z = {
  object: (shape) => ({ __schema: shape, ...chain() }),
  string: chain,
  number: chain,
  boolean: chain,
  array: chain,
};

export default z;
