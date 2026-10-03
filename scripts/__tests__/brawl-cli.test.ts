import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { itemByName } from '../../src/brawl/__tests__/testData';

describe('brawl-cli --json', () => {
  it('picks Improved Spirit and does not suggest a reroll for the README example', () => {
    const out = execFileSync(
      process.execPath, // not npx: spawning it without a shell fails on Windows runners
      [
        '--import',
        'tsx',
        'scripts/brawl-cli.ts',
        '--hero',
        '1',
        '--round',
        '2',
        '--set',
        "Improved Spirit,Enchanter's Emblem,Swift Striker",
        '--json',
      ],
      { encoding: 'utf8', cwd: process.cwd() },
    );
    const result = JSON.parse(out);
    expect(result.picks[0]).toBe(itemByName('Improved Spirit').id);
    expect(result.reroll).toBeNull();
  });
});
