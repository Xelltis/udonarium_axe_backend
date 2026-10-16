// Loads what tsc turns into JavaScript in plain Node, and rolls BCDice once. The tests go through
// Vite, so they miss a .js left off an import, or an import attribute left off a JSON import. On
// Vercel the code runs in plain Node.
// Run it with node, not through tsx (tsx also resolves imports that have no extension).
import { execFileSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const out = '.esm-check';
const load = (path: string) => import(pathToFileURL(join(process.cwd(), out, path)).href);

rmSync(out, { recursive: true, force: true });
try {
  execFileSync('npx', ['tsc', '--project', 'tsconfig.esm.json'], { stdio: 'inherit' });
  const { default: server } = await load('api/index.js');
  if (typeof server.listen !== 'function') throw new Error('api/index.js exports no server');
  const { rollLine } = await load('src/core/dice/roll.js');
  const rolled = await rollLine('Cthulhu7th', 'CC<=50');
  if (!rolled) throw new Error('BCDice did not roll');
  console.log(`api/index.js loads, and BCDice rolls: ${rolled.text}`);
} finally {
  rmSync(out, { recursive: true, force: true });
}
