/**
 * Deploying a directory rather than a repository (PN-062, over PN-061).
 *
 * This is the half of arc A that `GTM-010` could not have: this server was
 * built on 2026-07-27 against a gateway whose only deploy took a repository
 * URL, so `deploy` resolves a git remote and posts that. `PN-061` added the
 * other door — `POST /api/sites` with a gzipped tar and an `x-pnk-name` header
 * — and the persona arc A is aimed at is precisely the one with no repository:
 * an agent wrote a tool this afternoon and there is no push to deploy.
 *
 * ## Kept in step with `packages/cli` by a test, not by an import
 *
 * `packages/cli` implements the same upload, and two copies of a wire format is
 * exactly the drift `AGENT_TASKS.yaml` warns about ("a thin client … so it
 * cannot drift from the CLI"). Importing it is the obvious fix and is the wrong
 * one here: this server's whole install story is that it has no dependencies
 * and runs from a path, and `packages/cli` is a private workspace package of
 * TypeScript that Node type-strips. Taking it on would mean this package could
 * no longer be pointed at with `node <file>`.
 *
 * So the parity is asserted instead. `test/parity.test.mjs` reads
 * `packages/cli/src/pack.ts` and fails when its exclude list, its `tar`
 * arguments, or the header name stop matching this file — which is the crude
 * cross-file contract test standing lesson 6 asks for, and it catches the thing
 * an import would have caught without costing what an import would have cost.
 */
import { spawn } from 'node:child_process';
import { Readable } from 'node:stream';
import { resolve, sep } from 'node:path';

/**
 * What never goes up. Mirrors `EXCLUDED` in `packages/cli/src/pack.ts`.
 *
 * `node_modules` is the one that matters: it is the difference between a 200 KB
 * upload and a 200 MB one, and pocketnook installs dependencies itself.
 */
export const EXCLUDED = [
  './node_modules',
  './.git',
  './.venv',
  './venv',
  './__pycache__',
  './.next/cache',
  './.pnpm-store',
];

/** The header `PN-061`'s upload route reads the nook name from. */
export const NAME_HEADER = 'x-pnk-name';

/**
 * The `tar` arguments, as an argv array.
 *
 * An array and never a string, because this is spawned directly rather than
 * through a shell — so a directory named `; rm -rf ~` is a directory name. That
 * matters more here than in the CLI: the argument comes from a language model
 * rather than from somebody's own shell.
 */
export function packArgs(dir) {
  return ['-czf', '-', '-C', dir, ...EXCLUDED.flatMap((path) => ['--exclude', path]), '.'];
}

/**
 * A nook name from a directory path. Mirrors `nameFromDir` in the CLI.
 *
 * The name is the nook's identity, so deploying twice from `~/code/my-tool`
 * updates one nook rather than making two.
 */
export function nameFromDir(dir) {
  const base = String(dir).replace(/[/\\]+$/, '').split(/[/\\]/).pop() ?? '';
  const cleaned = base.replace(/[^A-Za-z0-9._-]/g, '-').replace(/^[^A-Za-z0-9]+/, '').slice(0, 64);
  return cleaned || 'nook';
}

/**
 * Directories that are a mistake rather than a project, refused before `tar`.
 *
 * This guard is here and not in `packages/cli`, and the asymmetry is the whole
 * reason it exists: the CLI's argument is typed by a person who knows what
 * directory they are standing in, and this one is chosen by a language model
 * from a conversation. `~` is a plausible thing for a model to pass and a
 * catastrophic thing to pack — `EXCLUDED` drops `node_modules` and `.git`, and
 * says nothing about `.ssh`, `.aws`, `.config` or a browser profile, because
 * the CLI never had cause to imagine somebody aiming it at a home directory.
 *
 * The rule is one line: refuse anything that *contains* the home directory,
 * which covers `/`, `/Users`, `/home` and `~` itself while permitting every
 * project that lives inside it. Deliberately not a blocklist of sensitive
 * names — such a list is always one entry short, and the directory being wrong
 * is the thing worth catching.
 */
export function refuseDirectory(dir, home) {
  const target = resolve(dir);
  if (target === '/' || /^[A-Za-z]:[\\/]?$/.test(target)) {
    return 'That would pack the whole filesystem. Give the project directory instead.';
  }
  if (home) {
    const resolvedHome = resolve(home);
    const withSeparator = target.endsWith(sep) ? target : `${target}${sep}`;
    if (resolvedHome === target || resolvedHome.startsWith(withSeparator)) {
      return (
        `${target} contains your home directory, so deploying it would upload private files — ` +
        'SSH keys, cloud credentials, browser data — along with the project. ' +
        'Give the project directory instead.'
      );
    }
  }
  return null;
}

/**
 * Start `tar` and hand back its stdout.
 *
 * The archive is never written to disk: it streams from `tar` straight into the
 * request body, so a deploy leaves nothing behind in a directory this server
 * does not own. A missing `tar` produces a sentence naming it rather than an
 * `ENOENT` stack.
 */
export function packDirectory(dir, spawnFn = spawn) {
  const child = spawnFn('tar', packArgs(dir), { stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr?.on('data', (chunk) => {
    stderr += chunk.toString();
  });

  const done = new Promise((resolvePromise, reject) => {
    child.on('error', (cause) => {
      reject(
        cause?.code === 'ENOENT'
          ? new Error('Deploying a directory needs `tar` on the PATH, and it could not be found.')
          : cause,
      );
    });
    child.on('close', (code) => {
      if (code === 0) resolvePromise(0);
      else reject(new Error(`tar could not pack ${dir} (exit ${code}). ${stderr.trim()}`));
    });
  });

  return { body: child.stdout, done };
}

/** The request body and headers for an upload, ready for `fetch`. */
export function uploadRequest(dir, name, pack = packDirectory) {
  const { body, done } = pack(dir);
  return {
    done,
    init: {
      method: 'POST',
      headers: { 'Content-Type': 'application/gzip', [NAME_HEADER]: name },
      body: Readable.toWeb(body),
      // Node requires this for a streaming request body.
      duplex: 'half',
    },
  };
}
