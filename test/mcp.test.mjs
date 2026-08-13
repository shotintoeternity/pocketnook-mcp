/**
 * The protocol surface, and what the tools say back.
 *
 * The properties worth holding onto:
 *   - a notification is answered with silence, and a request always with its
 *     own id, because getting either wrong hangs the client;
 *   - a failed tool call comes back as a *result* the model can read and act
 *     on, not as a protocol error only the plumbing sees;
 *   - the token never appears in anything this server emits;
 *   - a nook reference resolves to exactly one nook or to an error — never to a
 *     guess, because the wrong guess redeploys over someone's work.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { handleMessage, SERVER_INFO } from '../src/mcp.js';
import { TOOLS, resolveNook } from '../src/tools.js';
import { createClient, ApiError } from '../src/api.js';

const TOKEN = 'pnka_00000000000000000000000000000000'; // secret-scan-allow: all zeros, not a value randomBase32 can produce

/** A pocketnook that answers from a fixture instead of over the network. */
function fakeClient(overrides = {}) {
  return {
    origin: 'https://pocketnook.dev',
    hasToken: true,
    nookUrl: (id) => `https://pocketnook.dev/s/${id}/`,
    listSites: async () => ({ sites: [] }),
    deploy: async () => ({ id: 'nook-abcdefghjkmnpqrstvwx', status: 'ready', kind: 'static', fileCount: 3 }),
    deployDirectory: async () => ({ id: 'nook-abcdefghjkmnpqrstvwx', status: 'ready', kind: 'static', fileCount: 3 }),
    stop: async () => ({ ok: true }),
    me: async () => ({ authenticated: true }),
    ...overrides,
  };
}

const call = (name, args = {}, client = fakeClient()) =>
  handleMessage(
    { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } },
    { tools: TOOLS, client },
  );

const textOf = (response) => response.result.content[0].text;

describe('the protocol', () => {
  it('answers initialize with tool capability and its own name', async () => {
    const response = await handleMessage(
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } },
      { tools: TOOLS, client: fakeClient() },
    );
    assert.equal(response.id, 1);
    assert.equal(response.result.protocolVersion, '2025-06-18');
    assert.deepEqual(response.result.serverInfo, SERVER_INFO);
    assert.ok(response.result.capabilities.tools);
  });

  it('agrees with whatever protocol version the client names', async () => {
    const response = await handleMessage(
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05' } },
      { tools: TOOLS, client: fakeClient() },
    );
    assert.equal(response.result.protocolVersion, '2024-11-05');
  });

  it('names a version when the client does not', async () => {
    const response = await handleMessage(
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} },
      { tools: TOOLS, client: fakeClient() },
    );
    assert.match(response.result.protocolVersion, /^\d{4}-\d{2}-\d{2}$/);
  });

  it('lists every tool with a schema', async () => {
    const response = await handleMessage(
      { jsonrpc: '2.0', id: 2, method: 'tools/list' },
      { tools: TOOLS, client: fakeClient() },
    );
    const names = response.result.tools.map((tool) => tool.name);
    assert.deepEqual(names, ['deploy', 'deploy_directory', 'list_nooks', 'nook_logs', 'stop_nook']);
    for (const tool of response.result.tools) {
      assert.equal(typeof tool.description, 'string');
      assert.equal(tool.inputSchema.type, 'object');
    }
  });

  it('offers no way to delete a nook or to touch tokens', async () => {
    const response = await handleMessage(
      { jsonrpc: '2.0', id: 2, method: 'tools/list' },
      { tools: TOOLS, client: fakeClient() },
    );
    const names = response.result.tools.map((tool) => tool.name).join(' ');
    assert.equal(/delete/.test(names), false);
    assert.equal(/token/.test(names), false);
  });

  it('says nothing at all to a notification', async () => {
    const response = await handleMessage(
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      { tools: TOOLS, client: fakeClient() },
    );
    assert.equal(response, null);
  });

  it('refuses a method it does not have, but only when someone is listening', async () => {
    const asked = await handleMessage(
      { jsonrpc: '2.0', id: 3, method: 'resources/list' },
      { tools: TOOLS, client: fakeClient() },
    );
    assert.equal(asked.error.code, -32601);

    const told = await handleMessage(
      { jsonrpc: '2.0', method: 'resources/list' },
      { tools: TOOLS, client: fakeClient() },
    );
    assert.equal(told, null);
  });

  it('answers ping, which is how a client checks the server is alive', async () => {
    const response = await handleMessage({ jsonrpc: '2.0', id: 4, method: 'ping' }, { tools: TOOLS, client: fakeClient() });
    assert.deepEqual(response.result, {});
  });

  it('refuses a message that is not JSON-RPC 2.0', async () => {
    const response = await handleMessage({ id: 5, method: 'tools/list' }, { tools: TOOLS, client: fakeClient() });
    assert.equal(response.error.code, -32600);
  });

  it('reports an unknown tool by name', async () => {
    const response = await call('deploy_everything');
    assert.equal(response.error.code, -32601);
    assert.match(response.error.message, /deploy_everything/);
  });

  it('returns a failed tool call as a readable result, not a protocol error', async () => {
    const client = fakeClient({ listSites: async () => ({ sites: [{ id: 'nook-abcdefghjkmnpqrstvwx', repoName: 'owner/repo' }] }) });
    const response = await call('nook_logs', { nook: 'nope/nope' }, client);
    assert.equal(response.error, undefined);
    assert.equal(response.result.isError, true);
    assert.match(textOf(response), /no nook matches/i);
  });
});

describe('deploy', () => {
  it('returns the URL and says the nook is private', async () => {
    const response = await call('deploy', { repo: 'owner/repo' });
    const text = textOf(response);
    assert.match(text, /https:\/\/pocketnook\.dev\/s\/nook-abcdefghjkmnpqrstvwx\//);
    assert.match(text, /private/);
  });

  it('sends the canonical repository URL to pocketnook', async () => {
    let sent;
    await call('deploy', { repo: 'git@github.com:owner/repo.git' }, fakeClient({
      deploy: async (url) => {
        sent = url;
        return { id: 'nook-abcdefghjkmnpqrstvwx', status: 'ready', kind: 'static', fileCount: 1 };
      },
    }));
    assert.equal(sent, 'https://github.com/owner/repo');
  });

  it('refuses a repository pocketnook cannot build, before calling it', async () => {
    let called = false;
    const response = await call('deploy', { repo: 'https://gitlab.com/owner/repo' }, fakeClient({
      deploy: async () => {
        called = true;
        return {};
      },
    }));
    assert.equal(response.result.isError, true);
    assert.equal(called, false);
  });

  it('reports a failed build with the stage and the log tail', async () => {
    const response = await call('deploy', { repo: 'owner/repo' }, fakeClient({
      deploy: async () => ({
        id: 'nook-abcdefghjkmnpqrstvwx',
        status: 'failed',
        stage: 'install',
        message: 'npm ci exited 1',
        log: 'line one\nline two\nnpm ERR! missing lockfile',
      }),
    }));
    const text = textOf(response);
    assert.match(text, /failed at the install step/);
    assert.match(text, /npm ERR! missing lockfile/);
  });

  it('does not warn about the working copy when another repository was named', async () => {
    // The current directory is this repository, which usually has local edits;
    // naming a different repo makes them beside the point.
    const response = await call('deploy', { repo: 'owner/repo' });
    assert.equal(/uncommitted/.test(textOf(response)), false);
  });
});

describe('resolving which nook is meant', () => {
  const sites = [
    { id: 'nook-abcdefghjkmnpqrstvwx', repoName: 'owner/studio-board', status: 'ready' },
    { id: 'nook-bbcdefghjkmnpqrstvwx', repoName: 'other/studio-board', status: 'ready' },
    { id: 'nook-cbcdefghjkmnpqrstvwx', repoName: 'owner/zztmmo', status: 'ready' },
  ];
  const client = fakeClient({ listSites: async () => ({ sites }) });

  it('takes an id as itself, without a lookup', async () => {
    const resolved = await resolveNook(
      fakeClient({
        listSites: async () => {
          throw new Error('should not have looked anything up');
        },
      }),
      'nook-abcdefghjkmnpqrstvwx',
    );
    assert.equal(resolved.id, 'nook-abcdefghjkmnpqrstvwx');
  });

  it('takes a full owner/repo name', async () => {
    const resolved = await resolveNook(client, 'other/studio-board');
    assert.equal(resolved.id, 'nook-bbcdefghjkmnpqrstvwx');
  });

  it('takes the short name when only one nook has it', async () => {
    const resolved = await resolveNook(client, 'zztmmo');
    assert.equal(resolved.id, 'nook-cbcdefghjkmnpqrstvwx');
  });

  it('refuses to guess when a short name is ambiguous', async () => {
    await assert.rejects(() => resolveNook(client, 'studio-board'), /matches more than one nook/);
  });

  it('lists what does exist when nothing matches', async () => {
    await assert.rejects(() => resolveNook(client, 'nothing-like-this'), /owner\/studio-board/);
  });
});

describe('the API client', () => {
  it('explains a missing token instead of failing obscurely', async () => {
    const client = createClient({ baseUrl: 'https://pocketnook.dev', token: '' });
    await assert.rejects(() => client.listSites(), (error) => {
      assert.ok(error instanceof ApiError);
      assert.match(error.message, /Agent access/);
      return true;
    });
  });

  it('explains a rejected token as something to go and fix', async () => {
    const original = globalThis.fetch;
    globalThis.fetch = async () => new Response('{}', { status: 401 });
    try {
      const client = createClient({ token: TOKEN });
      await assert.rejects(() => client.listSites(), /expired or been revoked/);
    } finally {
      globalThis.fetch = original;
    }
  });

  it('never puts the token in an error message', async () => {
    const original = globalThis.fetch;
    globalThis.fetch = async () => {
      throw new TypeError(`fetch failed for Bearer ${TOKEN}`);
    };
    try {
      const client = createClient({ token: TOKEN });
      await client.listSites();
      assert.fail('expected a failure');
    } catch (error) {
      assert.equal(error.message.includes(TOKEN), false);
      assert.match(error.message, /Could not reach/);
    } finally {
      globalThis.fetch = original;
    }
  });

  it('sends the token as a bearer credential and nothing else', async () => {
    const original = globalThis.fetch;
    let seen;
    globalThis.fetch = async (url, init) => {
      seen = { url, init };
      return new Response(JSON.stringify({ sites: [] }), { status: 200 });
    };
    try {
      const client = createClient({ baseUrl: 'https://pocketnook.dev/', token: TOKEN });
      await client.listSites();
      assert.equal(seen.url, 'https://pocketnook.dev/api/sites');
      assert.equal(seen.init.headers.Authorization, `Bearer ${TOKEN}`);
      assert.equal(seen.init.headers.Cookie, undefined);
    } finally {
      globalThis.fetch = original;
    }
  });

  it('relays a refusal from pocketnook in the words pocketnook used', async () => {
    const original = globalThis.fetch;
    globalThis.fetch = async () => new Response(JSON.stringify({ error: 'public_domain' }), { status: 400 });
    try {
      const client = createClient({ token: TOKEN });
      await assert.rejects(() => client.stop('nook-abcdefghjkmnpqrstvwx'), /public_domain/);
    } finally {
      globalThis.fetch = original;
    }
  });
});

describe('build logs', () => {
  const site = {
    id: 'nook-abcdefghjkmnpqrstvwx',
    repoName: 'owner/repo',
    status: 'failed',
    stage: 'install',
    message: 'npm ci exited 1',
    buildLog: 'one\ntwo\nthree\nnpm ERR! no lockfile',
  };

  it('shows the stage, the message, and the tail of the log', async () => {
    const client = fakeClient({ listSites: async () => ({ sites: [site] }) });
    const text = textOf(await call('nook_logs', { nook: 'owner/repo' }, client));
    assert.match(text, /failed at the install step/);
    assert.match(text, /npm ERR! no lockfile/);
  });

  it('reads the list once when given a name, and once when given an id', async () => {
    let reads = 0;
    const client = fakeClient({
      listSites: async () => {
        reads += 1;
        return { sites: [site] };
      },
    });
    await call('nook_logs', { nook: 'owner/repo' }, client);
    assert.equal(reads, 1);
    await call('nook_logs', { nook: site.id }, client);
    assert.equal(reads, 2);
  });

  it('says so plainly when a build recorded no output', async () => {
    const client = fakeClient({ listSites: async () => ({ sites: [{ ...site, buildLog: null }] }) });
    assert.match(textOf(await call('nook_logs', { nook: 'owner/repo' }, client)), /no build output/);
  });
});
