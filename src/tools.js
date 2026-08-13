/**
 * What an agent can do to a nook.
 *
 * The working set of somebody who has just finished writing an app and wants it
 * somewhere private: deploy it, find it again, see why it failed, take it down.
 *
 * ## What is deliberately absent, and why the list grew (PN-062)
 *
 * **Deleting.** Irreversible, and it destroys the grants and secrets attached
 * to a nook, so it stays a decision a person makes on a page that can say so.
 * An agent that misreads "get rid of that" has `stop` to reach for, which is
 * the recoverable version of the same intent.
 *
 * **Anything to do with tokens.** The gateway will not accept a token on
 * `/api/tokens` at all, so a compromised agent cannot mint itself a longer life
 * or revoke the credential being used to shut it down.
 *
 * **Sharing and secrets — removed 2026-08-01, and not by choice here.**
 * `share_nook` and `set_nook_secret` shipped with this server on 2026-07-27.
 * **Decision 9** (`TASKS.md` section 7) then made both routes session-only: a
 * token deploys, a session administers. They did not become ill-advised, they
 * became impossible — `sessionOnly` answers any bearer token with 401 — and a
 * tool that can never succeed is worse than no tool, because an agent reads the
 * refusal as transient and retries it. The MCP `instructions` say where those
 * two actions now live, so the model sends its person to the browser instead of
 * inventing a workaround such as committing the secret into the project.
 *
 * Every handler returns a string. The audience is a language model relaying to
 * a person, so the text says what happened, what the URL is, and what is still
 * true but surprising — never a status code.
 */
import { resolveRepo, inspectWorkingCopy, normalizeRepo } from './repo.js';
import { untrusted } from './text.js';
import { nameFromDir, refuseDirectory } from './upload.js';

const NOOK_ID = /^nook-[0-9a-hjkmnp-tv-z]{20}$/;

/**
 * An uploaded nook is identified by `upload://<name>` rather than a repo URL
 * (`UPLOAD_URL_PREFIX` in `services/gateway/src/sites.ts`), and `repoName`
 * falls back to that identity. Stripping it is what makes `deploy_directory`'s
 * nooks resolvable by the name they were deployed under.
 */
const UPLOAD_PREFIX = 'upload://';

/** What a person calls a nook: the deploy name, or `owner/repo` for a clone. */
export function displayName(site) {
  const raw = site?.repoName ?? site?.id ?? '';
  return raw.startsWith(UPLOAD_PREFIX) ? raw.slice(UPLOAD_PREFIX.length) : raw;
}

/**
 * Find the nook a caller means.
 *
 * They will say "the studio-board one" far more often than they will paste an
 * id, so a repository name resolves too — exactly, or by the repo half of
 * `owner/repo` when that is unambiguous. An ambiguous name is an error rather
 * than a guess: picking one of two nooks and deploying over it is not a
 * recoverable mistake.
 */
export async function resolveNook(client, reference) {
  const ref = String(reference ?? '').trim();
  if (!ref) throw new Error('Which nook? Give its id, or the repository name like owner/repo.');
  if (NOOK_ID.test(ref)) return { id: ref };

  const { sites = [] } = await client.listSites();
  if (sites.length === 0) throw new Error('You have no nooks yet. Deploy one first.');

  const wanted = ref.toLowerCase().replace(/\.git$/, '');
  const normalized = normalizeRepo(ref);
  const full = normalized.ok ? normalized.name.toLowerCase() : wanted;

  // `displayName` rather than `repoName`, so a nook deployed by
  // `deploy_directory` resolves by the name it was deployed under instead of
  // by the `upload://…` identity the gateway stores it against.
  const exact = sites.filter((site) => displayName(site).toLowerCase() === full);
  const partial = exact.length
    ? exact
    : sites.filter((site) => displayName(site).toLowerCase().split('/').pop() === wanted);

  if (partial.length === 1) return partial[0];
  if (partial.length > 1) {
    const names = partial.map((site) => `${displayName(site)} (${site.id})`).join(', ');
    throw new Error(`"${ref}" matches more than one nook: ${names}. Use the id.`);
  }
  const known = sites.map((site) => displayName(site)).join(', ') || 'none';
  throw new Error(`No nook matches "${ref}". Your nooks: ${known}.`);
}

/** The tail of a build log, for a message that has to stay readable. */
function logTail(log, lines = 30) {
  if (!log) return '(no build output was recorded)';
  const all = log.split('\n');
  return all.length <= lines ? log : `… (earlier output trimmed)\n${all.slice(-lines).join('\n')}`;
}

/**
 * A failed build, reported so the model can fix it and not be steered by it.
 *
 * The message and the log are both tenant output — `PN-032` made the message
 * quote the failing command's own words — so both go inside the markers.
 * Anything pocketnook says in its own voice, such as the working-copy
 * warnings, stays outside them.
 */
function buildFailure(name, { stage, message }, logText, warnings = []) {
  const where = stage ? ` at the ${stage} step` : '';
  return [
    untrusted(
      `The build of ${name} failed${where}.`,
      `${message ?? 'no message given'}\n\n${logText}`,
    ),
    ...(warnings.length ? ['', 'Also worth checking:', ...warnings.map((w) => `- ${w}`)] : []),
  ].join('\n');
}

function describeSize(site) {
  if (site.kind === 'service') return site.runtime ? `${site.runtime} service` : 'service';
  const files = site.fileCount ?? 0;
  return `static, ${files} ${files === 1 ? 'file' : 'files'}`;
}

export const TOOLS = [
  {
    name: 'deploy',
    description:
      'Deploy a GitHub repository to a private pocketnook URL and return that URL. ' +
      'With no arguments it deploys the repository the current directory belongs to. ' +
      'pocketnook clones the tip of the default branch from GitHub, so uncommitted or ' +
      'unpushed work is not included — the result says so when that is the case. ' +
      'Redeploying the same repository reuses its existing nook and URL.',
    inputSchema: {
      type: 'object',
      properties: {
        repo: {
          type: 'string',
          description:
            'The repository to deploy, as "owner/repo" or a GitHub URL. Omit to use the current directory’s origin remote.',
        },
        directory: {
          type: 'string',
          description: 'Working copy to read the remote from. Defaults to the current directory.',
        },
      },
    },
    async handler(client, args) {
      const directory = args.directory || process.cwd();
      const resolved = await resolveRepo(args.repo, directory);
      if (!resolved.ok) throw new Error(resolved.message);

      // Only warn about the working copy when it is actually the thing being
      // deployed; naming an unrelated repository explicitly makes local state
      // beside the point.
      const copy = args.repo ? null : resolved.workingCopy ?? (await inspectWorkingCopy(directory));
      const warnings = copy?.warnings ?? [];

      const result = await client.deploy(resolved.url);

      if (result.status === 'failed') return buildFailure(resolved.name, result, logTail(result.log), warnings);

      const url = client.nookUrl(result.id);
      return [
        `${resolved.name} is deployed: ${url}`,
        `It is private — only you can open it until you share it. (${describeSize(result)})`,
        ...(warnings.length ? ['', 'Note:', ...warnings.map((w) => `- ${w}`)] : []),
      ].join('\n');
    },
  },

  {
    /**
     * The other door, and a separate tool on purpose.
     *
     * `deploy` builds what GitHub has; this builds what is on the disk. Folding
     * them into one tool would mean inferring which the person meant, and that
     * inference is `TASKS.md`'s named bug class — guess wrong towards the repo
     * and an agent's afternoon of work is silently not deployed, guess wrong
     * towards the directory and half-finished local edits go live. Neither
     * failure announces itself, which is what makes the guess unaffordable.
     *
     * So the choice is stated in two descriptions, and `deploy`'s
     * not-a-repository refusal names this tool as the way out.
     */
    name: 'deploy_directory',
    description:
      'Deploy a directory exactly as it is on this machine to a private pocketnook URL, with no ' +
      'git repository required — this uploads the files from disk, including uncommitted work. ' +
      'Use this when there is no repository, or when the local files are what should be deployed; ' +
      'use `deploy` to build what is pushed to GitHub instead. Everything in the directory is sent ' +
      'apart from node_modules, .git and build caches, so any credentials sitting in it go too. ' +
      'Deploying the same nook name again replaces what is there.',
    inputSchema: {
      type: 'object',
      properties: {
        directory: {
          type: 'string',
          description: 'The project directory to upload. Defaults to the current directory.',
        },
        name: {
          type: 'string',
          description:
            'The nook to deploy to. Deploying the same name again updates that nook. Defaults to the directory name.',
        },
      },
    },
    async handler(client, args) {
      const directory = args.directory ? String(args.directory) : process.cwd();

      const refusal = refuseDirectory(directory, process.env.HOME);
      if (refusal) throw new Error(refusal);

      const name = args.name ? String(args.name).trim() : nameFromDir(directory);
      const result = await client.deployDirectory(directory, name);

      if (result.status === 'failed') return buildFailure(name, result, logTail(result.log));

      const url = client.nookUrl(result.id);
      return [
        `${name} is deployed from ${directory}: ${url}`,
        `It is private — only you can open it until you share it. (${describeSize(result)})`,
        'This deployed the files on disk, not a git branch — redeploy after changing them.',
      ].join('\n');
    },
  },

  {
    name: 'list_nooks',
    description:
      'List the nooks this account has deployed: name, URL, status, and whether each is private or link-visible. ' +
      'Reads only — it changes nothing.',
    inputSchema: { type: 'object', properties: {} },
    async handler(client) {
      const { sites = [] } = await client.listSites();
      if (sites.length === 0) return 'No nooks yet. `deploy` or `deploy_directory` makes the first one.';

      return sites
        .map((site) => {
          const bits = [
            `${displayName(site)} — ${site.status}`,
            site.status === 'ready' ? client.nookUrl(site.id) : null,
            site.status === 'ready' ? `${describeSize(site)}, ${site.visibility}` : null,
            site.status === 'failed' ? `failed at ${site.stage ?? 'build'}: ${site.message ?? ''}`.trim() : null,
            `id ${site.id}`,
          ].filter(Boolean);
          return bits.join('\n  ');
        })
        .join('\n\n');
    },
  },

  {
    name: 'nook_logs',
    description:
      'Show the build output for a nook — the first thing to read when a deploy failed or produced the wrong thing. ' +
      'Reads only — it changes nothing.',
    inputSchema: {
      type: 'object',
      properties: {
        nook: { type: 'string', description: 'A nook id, or the repository name like owner/repo.' },
        lines: { type: 'number', description: 'How many trailing lines to show. Default 30.' },
      },
      required: ['nook'],
    },
    async handler(client, args) {
      const site = await resolveNook(client, args.nook);
      // Resolving by name already returned the whole record; resolving a raw id
      // deliberately skips the lookup, so that is the only case needing one.
      const full =
        site.buildLog === undefined
          ? (await client.listSites()).sites?.find((candidate) => candidate.id === site.id)
          : site;
      if (!full) throw new Error(`No nook with id ${site.id}.`);

      /**
       * The header is ours; everything after it is the build's.
       *
       * The failing `message` is tenant output too (`PN-032` made it quote the
       * failing command), so it goes inside the markers with the log rather
       * than into a heading that reads as pocketnook speaking.
       */
      const tail = logTail(full.buildLog, Number(args.lines) > 0 ? Number(args.lines) : 30);
      return full.status === 'failed'
        ? buildFailure(displayName(full), full, tail)
        : untrusted(`${displayName(full)} — ${full.status}`, tail);
    },
  },

  {
    name: 'stop_nook',
    description:
      'Stop serving a nook. The URL, its grants, and its secrets are kept, so deploying again brings it back.',
    inputSchema: {
      type: 'object',
      properties: {
        nook: { type: 'string', description: 'A nook id, or the repository name like owner/repo.' },
      },
      required: ['nook'],
    },
    async handler(client, args) {
      const site = await resolveNook(client, args.nook);
      await client.stop(site.id);
      return `${displayName(site) || site.id} is stopped and no longer answering. Deploy it again to bring it back at the same URL.`;
    },
  },
];

export const TOOLS_BY_NAME = new Map(TOOLS.map((tool) => [tool.name, tool]));
