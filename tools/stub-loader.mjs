/**
 * 通过 `node --import ./tools/stub-loader.mjs <script>` 启用平台桩件。
 *
 * 这里只负责把解析钩子注册进 loader 线程；真正的映射在 stub-hooks.mjs。
 * 注意 `register()` 的第一个参数必须是**绝对 URL**：传相对路径时 Node 会把它
 * 当成相对于 parentURL 的普通路径再拼接一次，从而得到 `file:///…/file:///…`。
 */
import { register } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
register(pathToFileURL(join(here, 'stub-hooks.mjs')).href);
