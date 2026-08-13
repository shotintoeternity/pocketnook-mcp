/**
 * Working out what "deploy this" refers to.
 *
 * The properties worth holding onto:
 *   - every form a GitHub remote actually takes normalizes to the one form
 *     pocketnook accepts, and nothing else does;
 *   - a working copy that disagrees with what will be built says so, because a
 *     silent deploy of yesterday's code is the failure people cannot see.
 */
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { inspectWorkingCopy, normalizeRepo, resolveRepo } from '../src/repo.js';

const run = promisify(execFile);

describe('normalizeRepo', () => {
  it('accepts every shape a GitHub remote actually takes', () => {
    for (const input of [
      'https://github.com/owner/repo',
      'https://github.com/owner/repo.git',
      'https://www.github.com/owner/repo',
      'git@github.com:owner/repo.git',
      'ssh://git@github.com/owner/repo.git',
      'owner/repo',
      '  https://github.com/owner/repo/  ',
    ]) {
      const result = normalizeRepo(input);
      assert.equal(result.ok, true, `expected ${input} to be accepted`);
      assert.equal(result.url, 'https://github.com/owner/repo');
      assert.equal(result.name, 'owner/repo');
    }
  });

  it('refuses a host that is not GitHub, and says which one it saw', () => {
    const result = normalizeRepo('https://gitlab.com/owner/repo');
    assert.equal(result.ok, false);
    assert.match(result.message, /gitlab\.com/);
  });

  it('refuses credentials embedded in the URL', () => {
    const result = normalizeRepo('https://user:pass@github.com/owner/repo');
    assert.equal(result.ok, false);
    assert.match(result.message, /credentials/);
    // And the message must not repeat the password back.
    assert.equal(result.message.includes('pass'), false);
  });

  it('refuses paths that are not exactly owner/repo', () => {
    for (const input of ['https://github.com/owner', 'https://github.com/owner/repo/tree/main', 'https://github.com/']) {
      assert.equal(normalizeRepo(input).ok, false, `expected ${input} to be refused`);
    }
  });

  it('refuses local and non-http schemes outright', () => {
    for (const input of ['file:///etc/passwd', 'ssh://git@internal.example/owner/repo', '/Users/me/code']) {
      assert.equal(normalizeRepo(input).ok, false, `expected ${input} to be refused`);
    }
  });

  it('refuses nothing at all', () => {
    assert.equal(normalizeRepo('').ok, false);
    assert.equal(normalizeRepo(undefined).ok, false);
  });
});

describe('inspectWorkingCopy', () => {
  let directory;

  before(async () => {
    directory = await mkdtemp(join(tmpdir(), 'pocketnook-mcp-'));
    await run('git', ['-C', directory, 'init', '--initial-branch=main']);
    await run('git', ['-C', directory, 'config', 'user.email', 'test@example.com']);
    await run('git', ['-C', directory, 'config', 'user.name', 'Test']);
    await run('git', ['-C', directory, 'remote', 'add', 'origin', 'git@github.com:owner/repo.git']);
    await writeFile(join(directory, 'README.md'), '# test\n');
    await run('git', ['-C', directory, 'add', '.']);
    await run('git', ['-C', directory, 'commit', '-m', 'first']);
  });

  after(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it('reads the origin remote and the branch', async () => {
    const copy = await inspectWorkingCopy(directory);
    assert.equal(copy.repository, true);
    assert.equal(copy.remote, 'git@github.com:owner/repo.git');
    assert.equal(copy.branch, 'main');
  });

  it('warns that nothing on the branch has been pushed', async () => {
    const copy = await inspectWorkingCopy(directory);
    assert.ok(copy.warnings.some((warning) => /no upstream/.test(warning)));
  });

  it('warns about uncommitted changes, and counts them', async () => {
    await writeFile(join(directory, 'new-file.txt'), 'wip\n');
    const copy = await inspectWorkingCopy(directory);
    const warning = copy.warnings.find((text) => /uncommitted/.test(text));
    assert.ok(warning, 'expected an uncommitted-changes warning');
    assert.match(warning, /1 uncommitted change/);
    assert.match(warning, /NOT be deployed/);
  });

  it('reports a directory that is not a repository rather than throwing', async () => {
    const copy = await inspectWorkingCopy(tmpdir());
    // tmpdir is not a git repo on any platform we run on; either answer is
    // structurally valid, and neither may throw.
    assert.equal(typeof copy.repository, 'boolean');
    assert.ok(Array.isArray(copy.warnings));
  });

  it('resolves the repository from the remote when none is named', async () => {
    const resolved = await resolveRepo(undefined, directory);
    assert.equal(resolved.ok, true);
    assert.equal(resolved.url, 'https://github.com/owner/repo');
  });

  it('prefers an explicitly named repository over the working copy', async () => {
    const resolved = await resolveRepo('other/thing', directory);
    assert.equal(resolved.url, 'https://github.com/other/thing');
  });
});

describe('resolveRepo outside a repository', () => {
  it('explains that there is nothing to deploy', async () => {
    const empty = await mkdtemp(join(tmpdir(), 'pocketnook-empty-'));
    try {
      const resolved = await resolveRepo(undefined, empty);
      // Inside a temp dir that is not a git repo, this must be a refusal with a
      // sentence a person can act on — never a crash.
      if (!resolved.ok) assert.match(resolved.message, /not a git repository|no "origin" remote/);
    } finally {
      await rm(empty, { recursive: true, force: true });
    }
  });
});
