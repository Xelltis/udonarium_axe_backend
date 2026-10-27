import { spawn } from 'node:child_process';
import { rmSync } from 'node:fs';
import process from 'node:process';
import { clearTimeout, setTimeout } from 'node:timers';

// Starts `wrangler dev` for `npm run latency`, on a port and with state of its own, so the bench neither
// meets a dev server already running nor leaves rooms in the usual local state.

const PORT = 8799;
const STATE = '.wrangler/latency-state';
const SECRET = 'latency-bench-session-secret-0123456789';
const ORIGIN = 'http://latency.bench';

export default async function setup({ provide }) {
  rmSync(STATE, { recursive: true, force: true });
  const child = spawn(
    'npx',
    [
      'wrangler',
      'dev',
      '--port',
      String(PORT),
      '--persist-to',
      STATE,
      '--var',
      `SESSION_SECRET:${SECRET}`,
      '--var',
      `ACCESS_CONTROL_ALLOW_ORIGIN:${ORIGIN}`,
      '--show-interactive-dev-session=false',
    ],
    { stdio: ['ignore', 'pipe', 'pipe'], detached: true }
  );
  let output = '';
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`wrangler dev did not start:\n${output}`)), 120_000);
    const read = (chunk) => {
      output += chunk;
      if (/Ready on/.test(output)) {
        clearTimeout(timer);
        resolve();
      }
    };
    child.stdout.on('data', read);
    child.stderr.on('data', read);
    child.once('exit', (code) => reject(new Error(`wrangler dev exited with ${code}:\n${output}`)));
  });
  provide('latency', { baseUrl: `http://localhost:${PORT}`, secret: SECRET, origin: ORIGIN });
  return async () => {
    // npx starts wrangler, and wrangler starts workerd, so the whole group is stopped.
    const exited = new Promise((resolve) => child.once('exit', resolve));
    process.kill(-child.pid, 'SIGINT');
    const timer = setTimeout(() => process.kill(-child.pid, 'SIGKILL'), 10_000);
    await exited;
    clearTimeout(timer);
  };
}
