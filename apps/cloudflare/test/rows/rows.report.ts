import { describe, it } from 'vitest';

import { runFlows, statementCosts } from './flows';
import type { FlowResults, Usage } from './flows';
import { SCALES, buildRoom } from './room-model';
import type { Scale } from './room-model';

// The report `npm run rows` prints: the rows each flow reads and writes, how long it takes, and what that
// comes to over a 4-hour session against the free plan's daily limits. It is not run with npm test.

declare const __ROWS_SCALES__: string;
declare const __ROWS_REPEAT__: number;
declare const __ROWS_ALARMS_PER_HOUR__: number;

/**
 * A 4-hour session, from the one measured in production on 2026-10-26: the room is loaded once in the
 * first 15 minutes, about 9 wakes an hour after eviction, 12 people coming in over the session
 * (reconnections included), and the patrol alarm as often as the tokens make it fire.
 */
const SESSION = {
  playHours: 3.75,
  wakes: 9 * 4,
  joins: 12,
  alarms: __ROWS_ALARMS_PER_HOUR__ * 4,
};

/** The free plan's daily limits on SQLite rows. */
const FREE = { written: 100_000, read: 5_000_000 };

/** console.table prints nothing from inside workerd, so the table is made into text first. */
const table = (rows: Record<string, object>) => {
  const columns = [...new Set(Object.values(rows).flatMap((row) => Object.keys(row)))];
  const lines = [
    ['', ...columns],
    ...Object.entries(rows).map(([name, row]) => [
      name,
      ...columns.map((column) => String((row as Record<string, unknown>)[column] ?? '')),
    ]),
  ];
  const widths = columns.map((_, i) => Math.max(...lines.map((line) => line[i + 1].length)));
  const first = Math.max(...lines.map((line) => line[0].length));
  return lines
    .map((line) => [line[0].padEnd(first), ...line.slice(1).map((cell, i) => cell.padStart(widths[i]))].join('  '))
    .join('\n');
};

const median = (values: number[]) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];

/** The rows of each run are the same; the time is the median. */
const settle = (runs: FlowResults[]): FlowResults => {
  const flows = Object.keys(runs[0]) as (keyof FlowResults)[];
  return Object.fromEntries(
    flows.map((flow) => [flow, { ...runs[0][flow], ms: median(runs.map((run) => run[flow].ms)) }])
  ) as unknown as FlowResults;
};

const round = (usage: Usage) => ({ ...usage, ms: Math.round(usage.ms * 10) / 10 });

const sessionOf = (flows: FlowResults) => {
  const total = (field: 'read' | 'written') =>
    Math.round(
      flows.load[field] +
        SESSION.playHours * flows.playHour[field] +
        SESSION.wakes * flows.wake[field] +
        SESSION.joins * flows.join[field] +
        SESSION.alarms * flows.alarm[field]
    );
  const written = total('written');
  const read = total('read');
  return {
    written,
    read,
    'sessions a day (rows written)': Math.round((FREE.written / written) * 10) / 10,
    'sessions a day (rows read)': Math.round((FREE.read / read) * 10) / 10,
  };
};

describe('rows a room reads and writes', () => {
  it('costs this much for one statement of each kind', async () => {
    console.log('\nOne statement of each kind');
    console.log(table(await statementCosts('rows-statements')));
  });

  const scales = __ROWS_SCALES__.split(',') as Scale[];
  for (const scale of scales) {
    it(`goes through a session in a ${scale} room`, async () => {
      const model = buildRoom(scale);
      const repeat = scale === 'max' ? 1 : __ROWS_REPEAT__;
      const runs: FlowResults[] = [];
      for (let i = 0; i < repeat; i++) runs.push(await runFlows(`rows-${scale}-${i}`, model));
      const flows = settle(runs);
      console.log(`\n${scale} room: ${model.objects.length} objects (scale ${SCALES[scale]}), median of ${repeat}`);
      console.log(table(Object.fromEntries(Object.entries(flows).map(([flow, usage]) => [flow, round(usage)]))));
      console.log(
        `A 4-hour session: load once, ${SESSION.playHours} hours of play, ${SESSION.wakes} wakes, ` +
          `${SESSION.joins} people coming in, ${SESSION.alarms} alarms`
      );
      console.log(table({ [scale]: sessionOf(flows) }));
    });
  }
});
