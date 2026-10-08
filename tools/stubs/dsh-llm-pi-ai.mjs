// 桩件：PiAiAdapter。记录实例，供断言检查 profiles() 是否可调用。
export class PiAiAdapter {
  constructor(options) {
    this.options = options;
    this.profiles = options.profiles;
    globalThis.__capture?.adapters.push(this);
  }
}
