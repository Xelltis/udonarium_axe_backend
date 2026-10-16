// tsc で JavaScript にしたものを素の Node で読み、BCDice を1回振る。テストは Vite を通すので、
// import の .js の付け忘れや、JSON の import 属性の漏れを見逃す。Vercel の上では素の Node で動く。
// tsx を通さずに node で動かす（tsx は拡張子の無い import も解決してしまう）
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
