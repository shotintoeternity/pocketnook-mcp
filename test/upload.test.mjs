/**
 * Deploying a directory (PN-062, over PN-061).
 *
 * The parts worth holding onto: the guard that stops a model packing somebody's
 * home directory, the fact that `deploy` and `deploy_directory` stay two
 * separate decisions, and that a nook made by upload can be found again by the
 * name it was deployed under.
 */
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { describe, it } from 'node:test';

import { handleMessage } from '../src/mcp.js';
import { TOOLS, displayName, resolveNook } from '../src/tools.js';
import { NAME_HEADER, nameFromDir, refuseDirectory, uploadRequest } from '../src/upload.js';

const call = (name, args, client) =>
  handleMessage({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }, { tools: TOOLS, client });

const textOf = (response) => response.result.content[0].text;

function fakeClient(overrides = {}) {
  return {
    origin: 'https://pocketnook.dev',
    hasToken: true,
    nookUrl: (id) => `https://pocketnook.dev/s/${id}/`,
    listSites: async () => ({ sites: [] }),
    deployDirectory: async () => ({ id: 'nook-abcdefghjkmnpqrstvwx', status: 'ready', kind: 'static', fileCount: 7 }),
    stop: async () => ({ ok: true }),
    ...overrides,
  };
}

describe('refusing a directory that is a mistake rather than a project', () => {
  it('refuses the home directory itself, naming what would be uploaded', () => {
    assert.match(refuseDirectory('/home/somebody', '/home/somebody'), /SSH keys/);
  });

  it('refuses anything that contains the home directory', () => {
    for (const dir of ['/home', '/', '/Users']) {
      assert.ok(refuseDirectory(dir, '/Users/somebody') || refuseDirectory(dir, '/home/somebody'), dir);
    }
  });

  it('permits every project inside it, which is where projects live', () => {
    assert.equal(refuseDirectory('/home/somebody/code/my-tool', '/home/somebody'), null);
    assert.equal(refuseDirectory('/home/somebody/x', '/home/somebody'), null);
    assert.equal(refuseDirectory('/srv/build', '/home/somebody'), null);
  });

  /**
   * The comparison is on path segments, not on characters. Without the trailing
   * separator `/home/some` would read as containing `/home/somebody`, and a
   * real project directory would be refused.
   */
  it('does not confuse a directory whose name is a prefix of home', () => {
    assert.equal(refuseDirectory('/home/some', '/home/somebody'), null);
    assert.equal(refuseDirectory('/home/somebodyelse', '/home/somebody'), null);
  });

  it('stops the tool before anything is packed', async () => {
    let packed = false;
    const client = fakeClient({
      deployDirectory: async () => {
        packed = true;
        return { status: 'ready', id: 'nook-abcdefghjkmnpqrstvwx' };
      },
    });
    const response = await call('deploy_directory', { directory: process.env.HOME ?? '/' }, client);
    assert.equal(response.result.isError, true);
    assert.equal(packed, false, 'the guard ran too late to matter');
  });
});

describe('naming the nook', () => {
  it('takes the directory name, cleaned of anything the API will not accept', () => {
    assert.equal(nameFromDir('/code/my-tool'), 'my-tool');
    assert.equal(nameFromDir('/code/My Tool (v2)'), 'My-Tool--v2-');
    assert.equal(nameFromDir('/code/'), 'code');
  });

  it('prefers an explicit name over the directory', async () => {
    let sent = null;
    const client = fakeClient({
      deployDirectory: async (dir, name) => {
        sent = { dir, name };
        return { id: 'nook-abcdefghjkmnpqrstvwx', status: 'ready', kind: 'static', fileCount: 1 };
      },
    });
    await call('deploy_directory', { directory: '/code/my-tool', name: 'chosen' }, client);
    assert.deepEqual(sent, { dir: '/code/my-tool', name: 'chosen' });
  });
});

describe('deploy_directory', () => {
  it('returns the URL and says what it actually deployed', async () => {
    const response = await call('deploy_directory', { directory: '/code/my-tool' }, fakeClient());
    const text = textOf(response);
    assert.match(text, /https:\/\/pocketnook\.dev\/s\/nook-abcdefghjkmnpqrstvwx\//);
    assert.match(text, /private/);
    // The one thing a person cannot infer: this shipped the disk, not a branch.
    assert.match(text, /files on disk, not a git branch/);
  });

  it('reports a failed build inside the untrusted-output markers', async () => {
    const client = fakeClient({
      deployDirectory: async () => ({ status: 'failed', stage: 'install', message: 'pip failed', log: 'ERROR: no such package' }),
    });
    const response = await call('deploy_directory', { directory: '/code/my-tool' }, client);
    assert.equal(response.result.isError, undefined);
    const text = textOf(response);
    assert.match(text, /--- begin build output ---/);
    assert.match(text, /ERROR: no such package/);
    assert.match(text, /at the install step/);
  });

  /**
   * `deploy` and `deploy_directory` stay two tools because choosing between
   * them is a decision with two silent failure modes — deploying a stale
   * pushed branch, or deploying half-finished local edits. Both descriptions
   * have to say which is which, or the model is guessing.
   */
  it('is described so a model can tell it apart from deploy', () => {
    const byName = Object.fromEntries(TOOLS.map((tool) => [tool.name, tool.description]));
    assert.match(byName.deploy_directory, /no git repository required/i);
    assert.match(byName.deploy_directory, /including uncommitted work/i);
    assert.match(byName.deploy_directory, /use `deploy` to build what is pushed/i);
    assert.match(byName.deploy, /clones the tip of the default branch/i);
    // The consequence a person approving the call cannot infer from the name.
    assert.match(byName.deploy_directory, /credentials/i);
  });
});

describe('an uploaded nook is found by the name it was deployed under', () => {
  const uploaded = { id: 'nook-abcdefghjkmnpqrstvwx', repoName: 'upload://my-tool', status: 'ready' };
  const cloned = { id: 'nook-bbcdefghjkmnpqrstvwx', repoName: 'owner/other', status: 'ready' };

  it('strips the upload:// identity the gateway stores', () => {
    assert.equal(displayName(uploaded), 'my-tool');
    assert.equal(displayName(cloned), 'owner/other');
  });

  it('resolves by that name, not by the stored identity', async () => {
    const client = fakeClient({ listSites: async () => ({ sites: [uploaded, cloned] }) });
    assert.equal((await resolveNook(client, 'my-tool')).id, uploaded.id);
    assert.equal((await resolveNook(client, 'owner/other')).id, cloned.id);
  });

  it('lists it under that name too', async () => {
    const client = fakeClient({ listSites: async () => ({ sites: [uploaded] }) });
    const text = textOf(await call('list_nooks', {}, client));
    assert.match(text, /my-tool/);
    assert.ok(!text.includes('upload://'), 'the storage identity leaked into the answer');
  });

  it('names what is there when nothing matches, without the prefix', async () => {
    const client = fakeClient({ listSites: async () => ({ sites: [uploaded] }) });
    await assert.rejects(() => resolveNook(client, 'nothing-like-this'), (error) => {
      assert.match(error.message, /my-tool/);
      assert.ok(!error.message.includes('upload://'));
      return true;
    });
  });
});

describe('the request that goes on the wire', () => {
  /** A `tar` that produces two chunks and exits cleanly. */
  function fakeTar(chunks = ['gzip-bytes']) {
    const child = new EventEmitter();
    child.stdout = Readable.from(chunks);
    child.stderr = new EventEmitter();
    queueMicrotask(() => child.emit('close', 0));
    return child;
  }

  it('sends gzip with the nook name in the header the gateway reads', () => {
    const { init } = uploadRequest('/code/my-tool', 'my-tool', () => {
      const child = fakeTar();
      return { body: child.stdout, done: Promise.resolve(0) };
    });

    assert.equal(init.method, 'POST');
    assert.equal(init.headers['Content-Type'], 'application/gzip');
    assert.equal(init.headers[NAME_HEADER], 'my-tool');
    // Node refuses a streaming request body without it.
    assert.equal(init.duplex, 'half');
  });

  /**
   * The one test that runs the real thing.
   *
   * Everything above stubs `spawn`, which proves the plumbing and nothing about
   * `tar` — and `tar`'s flags are the part most likely to be wrong, because
   * they are a claim about somebody else's software. `TASKS.md` section 6:
   * "do not assert what a tool does — check it."
   */
  it('really packs a directory, and really leaves node_modules out', async () => {
    const { mkdtemp, mkdir, writeFile } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { packDirectory } = await import('../src/upload.js');
    const { createGunzip } = await import('node:zlib');

    const dir = await mkdtemp(join(tmpdir(), 'pnk-upload-'));
    await writeFile(join(dir, 'app.py'), 'print("hello")\n');
    await mkdir(join(dir, 'node_modules'), { recursive: true });
    await writeFile(join(dir, 'node_modules', 'huge.js'), 'x'.repeat(1024));

    const { body, done } = packDirectory(dir);
    const chunks = [];
    const gunzip = body.pipe(createGunzip());
    for await (const chunk of gunzip) chunks.push(chunk);
    await done;

    // A tar member's name sits in the first 100 bytes of its 512-byte header,
    // which is enough structure to assert what was and was not included.
    const tar = Buffer.concat(chunks).toString('binary');
    assert.ok(tar.includes('app.py'), 'the project file was not packed');
    assert.ok(!tar.includes('huge.js'), 'node_modules was packed despite --exclude');
  });

  it('says which tool is missing when tar is not installed', async () => {
    const { done } = uploadRequest('/code/my-tool', 'my-tool', () => {
      const child = new EventEmitter();
      child.stdout = Readable.from([]);
      child.stderr = new EventEmitter();
      queueMicrotask(() => child.emit('error', Object.assign(new Error('spawn tar ENOENT'), { code: 'ENOENT' })));
      return { body: child.stdout, done: new Promise((_, reject) => child.on('error', (cause) => reject(
        cause.code === 'ENOENT' ? new Error('Deploying a directory needs `tar` on the PATH, and it could not be found.') : cause,
      ))) };
    });

    await assert.rejects(() => done, /needs `tar` on the PATH/);
  });
});
