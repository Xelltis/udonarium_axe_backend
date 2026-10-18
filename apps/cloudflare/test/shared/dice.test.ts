import { afterEach, describe, expect, it, vi } from 'vitest';

import { WorkerLoader, loadGameSystem, unwrapDefault } from '../../src/core/dice/bcdice.js';
import { encodeDetail, rollLine } from '../../src/core/dice/roll.js';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('rollLine', () => {
  it('rolls a command and writes the line as Axe does', async () => {
    expect(await rollLine('DiceBot', '1d1')).toEqual({
      text: 'DiceBot : (1D1) → 1',
      secret: false,
      dicebot: JSON.stringify({
        system: 'DiceBot',
        faces: [{ sides: 1, value: 1, kind: 'normal' }],
        outcome: '',
      }),
    });
  });

  it('turns a leading count into a repeat, one roll to a line', async () => {
    const rolled = await rollLine('DiceBot', '2 1d1');
    expect(rolled?.text).toBe('DiceBot : #1 (1D1) → 1\n#2 (1D1) → 1');
  });

  it('breaks a long chain of steps onto lines of their own', async () => {
    const rolled = await rollLine('DiceBot', '1d1+1d1>=1');
    expect(rolled?.text).toBe('DiceBot : (1D1+1D1>=1)\n→ 1[1]+1[1]\n→ 2\n→ 成功');
  });

  it('marks a secret roll', async () => {
    expect((await rollLine('DiceBot', 's1d1'))?.secret).toBe(true);
  });

  it('rolls under the system named, and under the plain dice bot for one it does not know', async () => {
    const cthulhu = await rollLine('Cthulhu7th', 'CC<=100');
    const unknown = await rollLine('NoSuchSystem', '1d1');

    expect(cthulhu?.text).toMatch(/^Cthulhu7th : /);
    // Even with a skill of 100, a roll of 100 is a fumble. Whichever it is, it shows that the system
    // judged the roll.
    expect(JSON.parse(cthulhu?.dicebot as string).outcome).toMatch(/success|critical|fumble/);
    expect(unknown?.text).toBe('DiceBot : (1D1) → 1');
  });

  it.each(['hello', '', '0 1d6'])('leaves %j unrolled', async (text) => {
    expect(await rollLine('DiceBot', text)).toBeNull();
  });

  it('leaves a line the system does not take, or one that breaks it', async () => {
    const system = await loadGameSystem('DiceBot');
    const evaluate = vi.spyOn(system as NonNullable<typeof system>, 'eval');

    evaluate.mockReturnValueOnce(null);
    const nothing = await rollLine('DiceBot', '1d6');
    evaluate.mockImplementationOnce(() => {
      throw new Error('broken');
    });
    const broken = await rollLine('DiceBot', '1d6');

    expect([nothing, broken]).toEqual([null, null]);
  });
});

describe('encodeDetail', () => {
  it('reads the older form of the dice, and the strongest outcome', () => {
    const detail = encodeDetail('Old', {
      text: '',
      secret: false,
      rands: [
        [3, 6],
        [0, 0],
      ],
      success: true,
      critical: true,
    });
    expect(JSON.parse(detail)).toEqual({
      system: 'Old',
      faces: [{ sides: 6, value: 3, kind: 'normal' }],
      outcome: 'critical',
    });
  });

  it.each([
    [{ fumble: true, failure: true }, 'fumble'],
    [{ success: true }, 'success'],
    [{ failure: true }, 'failure'],
  ])('names %o as %s', (flags, outcome) => {
    expect(JSON.parse(encodeDetail('S', { text: '', secret: false, ...flags })).outcome).toBe(outcome);
  });

  it('writes nothing when there are no dice and no outcome', () => {
    expect(
      encodeDetail('S', {
        text: '',
        secret: false,
        detailedRands: [{ value: 'x' as unknown as number }],
      })
    ).toBe('');
  });
});

describe('the BCDice loader', () => {
  it('takes the default out of a CommonJS module either way it was bundled', () => {
    const value = { name: 'loader' };
    expect(unwrapDefault({ default: value })).toBe(value);
    expect(unwrapDefault({ default: { default: value } })).toBe(value);
  });

  it('refuses a system or a translation it has no importer for', async () => {
    const loader = new WorkerLoader();
    await expect(loader.dynamicImport('Nope')).rejects.toThrow('no game system Nope');
    await expect(loader.dynamicImportI18n('Nope', 'ja_jp')).rejects.toThrow('no translation');
  });

  it('hands over a translation however the JSON module was shaped', async () => {
    const loader = new WorkerLoader();
    const translation = await loader.dynamicImportI18n('Cthulhu', 'ja_jp');
    expect(translation).toEqual(expect.any(Object));
  });
});
