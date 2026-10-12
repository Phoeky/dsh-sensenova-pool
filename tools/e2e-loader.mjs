import { register } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
register(pathToFileURL(join(here, 'e2e-hooks.mjs')).href);
