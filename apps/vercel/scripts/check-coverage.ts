#!/usr/bin/env node
import 'zx/globals';
import { readFile, access } from 'fs/promises';
import path from 'path';

const args = argv as Record<string, unknown>;
if (args.h || args.help) {
  console.log('Usage: check-coverage [--threshold|-t <number>]');
  console.log('  --threshold, -t   Coverage threshold percentage to enforce (default: 100)');
  console.log('  --help, -h        Show help');
  process.exit(0);
}

const rawThreshold = args.threshold ?? args.t ?? 100;
const parsed = Number(rawThreshold as unknown);
if (Number.isNaN(parsed) || parsed < 0 || parsed > 1000) {
  console.error('Invalid threshold specified. Must be a number');
  process.exit(2);
}
const threshold = parsed;
const coverageFile = path.resolve(process.cwd(), 'coverage', 'coverage-final.json');

interface FileCoverage {
  s?: Record<string, number>;
  f?: Record<string, number>;
  b?: Record<string, number[]>;
}

type CoverageFile = Record<string, FileCoverage>;
async function main() {
  try {
    await access(coverageFile);
  } catch {
    console.error(`coverage file not found: ${coverageFile}`);
    process.exit(2);
  }

  const raw = await readFile(coverageFile, 'utf8');
  const data: CoverageFile = JSON.parse(raw) as CoverageFile;

  let stmtTotal = 0,
    stmtCovered = 0;
  let fnTotal = 0,
    fnCovered = 0;
  let brTotal = 0,
    brCovered = 0;

  for (const file of Object.keys(data)) {
    const fileData = data[file];
    const s: Record<string, number> = fileData.s || {};
    const f: Record<string, number> = fileData.f || {};
    const b: Record<string, number[]> = fileData.b || {};

    stmtTotal += Object.keys(s).length;
    stmtCovered += Object.values(s).filter((v) => v > 0).length;

    fnTotal += Object.keys(f).length;
    fnCovered += Object.values(f).filter((v) => v > 0).length;

    for (const key of Object.keys(b)) {
      const arr: number[] = b[key];
      brTotal += arr.length;
      brCovered += arr.filter((v) => v > 0).length;
    }
  }

  const pct = (covered: number, total: number) => (total === 0 ? 100 : (covered / total) * 100);
  const stmtPct = pct(stmtCovered, stmtTotal);
  const fnPct = pct(fnCovered, fnTotal);
  const brPct = pct(brCovered, brTotal);

  console.log(`Statements: ${stmtCovered}/${stmtTotal} (${stmtPct.toFixed(2)}%)`);
  console.log(`Functions:  ${fnCovered}/${fnTotal} (${fnPct.toFixed(2)}%)`);
  console.log(`Branches:   ${brCovered}/${brTotal} (${brPct.toFixed(2)}%)`);

  let ok = true;
  if (stmtPct < threshold) {
    console.error(`Statements coverage ${stmtPct.toFixed(2)}% is below threshold ${threshold}%`);
    ok = false;
  }
  if (fnPct < threshold) {
    console.error(`Functions coverage ${fnPct.toFixed(2)}% is below threshold ${threshold}%`);
    ok = false;
  }
  if (brPct < threshold) {
    console.error(`Branches coverage ${brPct.toFixed(2)}% is below threshold ${threshold}%`);
    ok = false;
  }

  if (!ok) process.exit(1);
  console.log('Coverage thresholds met.');
  process.exit(0);
}

main().catch((err) => {
  console.error('Unexpected error in check-coverage:', err);
  process.exit(1);
});
