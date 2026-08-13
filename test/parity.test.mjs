/**
 * The upload here and the upload in `packages/cli` are one wire format, kept
 * that way by reading the other file (PN-062).
 *
 * `AGENT_TASKS.yaml` asks that this server be "a thin client of PN-061's API —
 * no logic of its own, so it cannot drift from the CLI". Importing the CLI
 * would be the direct reading and is the wrong trade here: this package's whole
 * install story is `node <file>` with nothing to install first, and
 * `packages/cli` is a private workspace package of TypeScript that Node
 * type-strips. Depending on it would end that.
 *
 * So the parity is asserted against the source instead — the crude cross-file
 * contract test `TASKS.md`'s standing lesson 6 asks for, aimed at exactly the
 * class it names: a value that is correct at each end and wrong between them.
 * The `PN-049` bug was `projectDir` carried everywhere except `worker.ts`, and
 * neither end's own tests could see it.
 *
 * **If this fails, the two implementations have diverged.** Fix whichever is
 * wrong; do not relax the assertion.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

import { EXCLUDED, NAME_HEADER, packArgs, nameFromDir } from '../src/upload.js';
import { stripAnsi } from '../src/text.js';

const read = (path) => readFileSync(fileURLToPath(new URL(`../../../${path}`, import.meta.url)), 'utf8');

const PACK = read('packages/cli/src/pack.ts');
const DEPLOY = read('packages/cli/src/deploy.ts');
const LOG = read('packages/cli/src/log.ts');

describe('the upload matches packages/cli', () => {
  it('excludes exactly the same paths', () => {
    const block = /export const EXCLUDED = \[([\s\S]*?)\] as const;/.exec(PACK);
    assert.ok(block, 'EXCLUDED is no longer where this test looks for it in pack.ts');
    const theirs = [...block[1].matchAll(/'([^']+)'/g)].map((match) => match[1]);

    assert.ok(theirs.length > 0, 'read no entries out of pack.ts');
    assert.deepEqual(EXCLUDED, theirs);
  });

  /**
   * The argv itself, because the order and the flags are the format: `-C` is
   * what makes paths relative to the project rather than to the cwd, and `-`
   * is what keeps the archive off the disk.
   */
  it('builds the same tar argv', () => {
    const body = /export function packArgs\(dir: string\): string\[\] \{\s*return ([\s\S]*?);\n\}/.exec(PACK);
    assert.ok(body, 'packArgs is no longer where this test looks for it in pack.ts');

    // Evaluate their expression against the same inputs, so this compares the
    // produced argv rather than two spellings of it.
    const theirs = new Function('EXCLUDED', 'dir', `return ${body[1]};`)(EXCLUDED, '/some/project');
    assert.deepEqual(packArgs('/some/project'), theirs);
  });

  it('sends the nook name in the header the gateway reads', () => {
    assert.ok(DEPLOY.includes(`'${NAME_HEADER}'`), `deploy.ts no longer sends ${NAME_HEADER}`);
  });

  it('derives the same nook name from a directory', () => {
    const body = /export function nameFromDir\(dir: string\): string \{([\s\S]*?)\n\}/.exec(PACK);
    assert.ok(body, 'nameFromDir is no longer where this test looks for it in pack.ts');
    const theirs = new Function('dir', body[1]);

    for (const dir of ['/a/my-tool', '/a/My Tool (v2)', '/a/.hidden', '/a/', '/a/' + 'x'.repeat(80), '/']) {
      assert.equal(nameFromDir(dir), theirs(dir), `nameFromDir disagrees for ${dir}`);
    }
  });
});

describe('the log sanitiser matches packages/cli', () => {
  /**
   * Two copies of a sanitiser that drift are worse than one, and this is the
   * copy that cannot import the other. Comparing behaviour rather than source
   * text, so a reformat is not a failure but a changed character class is.
   */
  it('strips the same things', () => {
    const body = /export function stripAnsi\(text: string\): string \{([\s\S]*?)\n\}/.exec(LOG);
    assert.ok(body, 'stripAnsi is no longer where this test looks for it in log.ts');
    const theirs = new Function('text', body[1]);

    const ESC = String.fromCharCode(27);
    const samples = [
      `${ESC}[31mred${ESC}[0m`,
      `${ESC}]0;title${String.fromCharCode(7)}`,
      `${ESC}]8;;https://example.com${ESC}\\link`,
      'plain\ttabbed\nlines',
      `carriage\rreturn back\b\bspace`,
      `${ESC}c${ESC}(B${ESC}[?25l`,
      `${String.fromCharCode(0)}null and ${String.fromCharCode(127)}delete`,
    ];

    for (const sample of samples) {
      assert.equal(stripAnsi(sample), theirs(sample), `stripAnsi disagrees for ${JSON.stringify(sample)}`);
    }
  });
});
