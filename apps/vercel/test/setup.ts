import { afterAll } from 'vitest';

import { closeAll } from './cleanup.js';

// Runs before every test file. The files of a worker share their modules (the tests run without
// isolation), so what one file opened is closed when it is done, and the next file starts afresh.
// Only the small cleanup module is imported here: a module a setup file imports cannot be mocked.
afterAll(closeAll);
