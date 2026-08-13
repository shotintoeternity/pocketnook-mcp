/**
 * What "deploy this" actually refers to.
 *
 * The agent is sitting in a working copy; pocketnook builds a *pushed* GitHub
 * repository, shallow, at the tip of its default branch. Those are not the same
 * thing, and the gap is where every confusing first deploy lives: the code that
 * ships is the code on GitHub, not the code on the disk the agent just edited.
 *
 * So this module does two jobs. It works out which repository the working copy
 * points at, and it works out every way the disk currently disagrees with what
 * pocketnook will build — so the answer can say so instead of quietly deploying
 * something the person did not mean.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

/**
 * Run a git command, or return null.
 *
 * Every caller here treats "git could not answer" as "there is nothing to warn
 * about", never as a failure: not being in a repository, having no upstream, and
 * having no `origin/HEAD` are all ordinary states.
 *
 * Arguments go as an array, so nothing here is ever handed to a shell.
 */
async function git(directory, args) {
  try {
    const { stdout } = await run('git', ['-C', directory, ...args], {
      timeout: 10_000,
      maxBuffer: 1024 * 1024,
    });
    return stdout.trim();
  } catch {
    return null;
  }
}

/**
 * Normalize any way a person names a GitHub repository into the one form
 * pocketnook accepts.
 *
 * Handles what actually appears in a `remote get-url`: the SCP-style
 * `git@github.com:owner/repo.git`, `ssh://`, `https://` with or without `.git`,
 * and the bare `owner/repo` someone types by hand.
 *
 * Deliberately strict about the host and about embedded credentials, matching
 * `parseRepoUrl` in the builder — better to say "pocketnook only builds GitHub
 * repositories" here, in a sentence the agent can relay, than to send a URL
 * that fails at clone time three steps later.
 */
export function normalizeRepo(input) {
  const raw = String(input ?? '').trim();
  if (!raw) return { ok: false, message: 'No repository was given.' };

  // `git@github.com:owner/repo.git` is not a URL; rewrite it into one first.
  const scp = /^([^@/]+)@([^:/]+):(.+)$/.exec(raw);
  const candidate = scp ? `ssh://${scp[1]}@${scp[2]}/${scp[3]}` : raw;

  let host;
  let path;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(candidate)) {
    let url;
    try {
      url = new URL(candidate);
    } catch {
      return { ok: false, message: `"${raw}" is not a repository URL pocketnook understands.` };
    }
    /**
     * A password is always a credential; a bare username is one only over
     * http(s). `ssh://git@github.com/…` carries no secret — `git` is just the
     * ssh account every GitHub remote uses, and refusing it would reject the
     * single most common remote there is.
     */
    const httpLike = url.protocol === 'http:' || url.protocol === 'https:';
    if (url.password || (url.username && httpLike)) {
      return {
        ok: false,
        message: 'That URL has credentials embedded in it. Use the plain https://github.com/owner/repo form.',
      };
    }
    host = url.hostname.replace(/^www\./i, '');
    path = url.pathname;
  } else if (/^[^/\s]+\/[^/\s]+$/.test(candidate)) {
    // The `owner/repo` shorthand people say out loud.
    host = 'github.com';
    path = `/${candidate}`;
  } else {
    return { ok: false, message: `"${raw}" is not a repository URL pocketnook understands.` };
  }

  if (host.toLowerCase() !== 'github.com') {
    return { ok: false, message: `pocketnook builds github.com repositories; that one is on ${host}.` };
  }

  const segments = path.replace(/^\/+|\/+$/g, '').replace(/\.git$/i, '').split('/');
  const [owner, repo] = segments;
  if (segments.length !== 2 || !owner || !repo) {
    return { ok: false, message: 'Use a repository like owner/repo or https://github.com/owner/repo.' };
  }
  const SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
  if (!SEGMENT.test(owner) || !SEGMENT.test(repo)) {
    return { ok: false, message: 'That repository name contains characters pocketnook does not accept.' };
  }

  return { ok: true, url: `https://github.com/${owner}/${repo}`, name: `${owner}/${repo}` };
}

/**
 * Everything about a working copy that changes what a deploy will produce.
 *
 * `warnings` is the whole point: each entry is a specific, checkable way that
 * what is on the disk differs from what pocketnook is about to build.
 */
export async function inspectWorkingCopy(directory) {
  const root = await git(directory, ['rev-parse', '--show-toplevel']);
  if (!root) return { repository: false, warnings: [] };

  const [remote, branch, dirty, upstream, originHead] = await Promise.all([
    git(directory, ['remote', 'get-url', 'origin']),
    git(directory, ['rev-parse', '--abbrev-ref', 'HEAD']),
    git(directory, ['status', '--porcelain']),
    git(directory, ['rev-list', '--count', '@{upstream}..HEAD']),
    git(directory, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD']),
  ]);

  const warnings = [];

  // Uncommitted work is the most common surprise: the agent has just edited
  // these files, and none of them are going anywhere.
  if (dirty) {
    const count = dirty.split('\n').filter(Boolean).length;
    warnings.push(
      `${count} uncommitted ${count === 1 ? 'change' : 'changes'} in the working copy will NOT be deployed — pocketnook builds what is pushed to GitHub.`,
    );
  }

  const ahead = Number(upstream);
  if (Number.isInteger(ahead) && ahead > 0) {
    warnings.push(
      `${ahead} local ${ahead === 1 ? 'commit is' : 'commits are'} not pushed yet. Push first, or the deploy builds the previous state.`,
    );
  } else if (upstream === null && branch) {
    warnings.push(`The branch "${branch}" has no upstream, so nothing on it has been pushed.`);
  }

  // pocketnook clones `--single-branch` at the default branch, so being on a
  // feature branch means the deploy is of something else entirely.
  const defaultBranch = originHead ? originHead.replace(/^origin\//, '') : null;
  if (defaultBranch && branch && branch !== 'HEAD' && branch !== defaultBranch) {
    warnings.push(
      `You are on "${branch}" but pocketnook builds the default branch, "${defaultBranch}". Merge first if you meant to deploy this work.`,
    );
  }

  return {
    repository: true,
    root,
    branch: branch ?? null,
    defaultBranch,
    remote: remote ?? null,
    warnings,
  };
}

/**
 * The repository to deploy: what the caller named, or failing that, whatever
 * the working copy points at.
 */
export async function resolveRepo(explicit, directory) {
  if (explicit) return normalizeRepo(explicit);

  const copy = await inspectWorkingCopy(directory);
  if (!copy.repository) {
    return {
      ok: false,
      message: `${directory} is not a git repository, so there is no repository to deploy. Pass \`repo\` explicitly, like "owner/repo".`,
    };
  }
  if (!copy.remote) {
    return {
      ok: false,
      message:
        'This repository has no "origin" remote, so it does not exist on GitHub yet. Push it to GitHub first, then deploy.',
    };
  }
  const resolved = normalizeRepo(copy.remote);
  return resolved.ok ? { ...resolved, workingCopy: copy } : resolved;
}
