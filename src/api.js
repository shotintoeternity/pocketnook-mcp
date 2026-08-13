/**
 * The pocketnook API, as seen from a laptop.
 *
 * One credential, one base URL, and no ambient state — the agent token arrives
 * from the environment and goes out in an `Authorization` header, which is the
 * only reason the gateway grew bearer auth at all (`services/gateway/src/tokens.ts`).
 *
 * Two things this is careful about:
 *
 * - **The token never appears in an error.** Failures here are relayed verbatim
 *   into a transcript that gets pasted into issues and chat windows, so a
 *   message that echoed the request headers would be a slow leak.
 * - **A 401 is explained, not reported.** "Unauthorized" from an agent is
 *   almost always an expired or unset token, and the person needs the sentence
 *   that fixes it rather than the status code.
 *
 * ## What a token may call, and why the list shrank (PN-062)
 *
 * **Decision 9**, `TASKS.md` section 7, taken 2026-08-01: *a token deploys, a
 * session administers.* `sessionOnly` in `services/gateway/src/worker.ts` moved
 * delete, secrets and access grants behind the browser cookie.
 *
 * `access`, `setSecret` and `listSecrets` used to be here, and were removed
 * rather than left to fail: they now answer any bearer token with 401, forever.
 * That is worth stating plainly because this server shipped on 2026-07-27 with
 * two tools built on them, and for four days between the decision landing and
 * this change, `share_nook` and `set_nook_secret` were broken in a way nothing
 * would have reported — an instance of `TASKS.md`'s standing lesson 6, a value
 * carried at every layer except the one that matters.
 */
import { uploadRequest } from './upload.js';

const DEFAULT_BASE_URL = 'https://pocketnook.dev';

/** Long enough for a cold wake or a slow build; short enough to not hang forever. */
const DEPLOY_TIMEOUT_MS = 15 * 60 * 1000;
const DEFAULT_TIMEOUT_MS = 30 * 1000;

export class ApiError extends Error {}

export function createClient({ baseUrl, token } = {}) {
  const origin = (baseUrl || process.env.POCKETNOOK_URL || DEFAULT_BASE_URL).replace(/\/+$/, '');
  const credential = token || process.env.POCKETNOOK_TOKEN || '';

  /**
   * One request, and the only place the credential is attached.
   *
   * Split out from `request` so the upload path (`deployDirectory`) shares
   * every failure sentence rather than growing a second set that drifts. Note
   * what is never built: no URL carries the token as a query parameter,
   * because a URL is the thing most likely to end up quoted in a message.
   */
  async function send(path, init, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
    if (!credential) {
      throw new ApiError(
        'No pocketnook token is configured. Sign in at ' +
          `${origin}/home, open "Agent access", create a token, and set POCKETNOOK_TOKEN to it.`,
      );
    }

    let response;
    try {
      response = await fetch(`${origin}${path}`, {
        ...init,
        headers: { Authorization: `Bearer ${credential}`, ...(init.headers ?? {}) },
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (cause) {
      if (cause?.name === 'TimeoutError') {
        throw new ApiError(
          `pocketnook did not answer within ${Math.round(timeoutMs / 1000)}s. ` +
            'Builds run synchronously, so a very slow build can outlast this; check ' +
            `${origin}/home to see whether it finished.`,
        );
      }
      // Deliberately not `cause.message`: a fetch failure can carry the full
      // request, and the request carries the token.
      throw new ApiError(`Could not reach ${origin}. Check the network and POCKETNOOK_URL.`);
    }

    if (response.status === 401) {
      throw new ApiError(
        'pocketnook rejected the token. It may have expired or been revoked — ' +
          `create a new one at ${origin}/home under "Agent access".`,
      );
    }

    const text = await response.text();
    let payload = null;
    try {
      payload = text ? JSON.parse(text) : null;
    } catch {
      payload = null;
    }

    if (!response.ok) {
      const detail = payload?.error || payload?.message;
      throw new ApiError(
        detail ? `pocketnook refused that: ${detail}` : `pocketnook answered ${response.status}.`,
      );
    }
    return payload ?? {};
  }

  /** A JSON request, which is every call here except the archive upload. */
  function request(method, path, body, options) {
    return send(
      path,
      {
        method,
        ...(body === undefined
          ? {}
          : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
      },
      options,
    );
  }

  /**
   * Deploy a directory by uploading it (`PN-061`).
   *
   * The archive streams from `tar` into the request body, so nothing is
   * written to disk. `tar`'s own exit is awaited *after* the response: a
   * gateway that refuses the upload — over the size ceiling, out of budget —
   * closes the body early, and treating the resulting non-zero exit as the
   * failure would report a broken pipe instead of the reason.
   */
  async function deployDirectory(dir, name, pack) {
    const { init, done } = uploadRequest(dir, name, pack);

    /**
     * Watched, not awaited, and deliberately claimed before `send` runs.
     *
     * A `tar` that never starts — it is not installed — destroys the stdout
     * stream, which surfaces at `fetch` as a body error and would otherwise be
     * reported as "could not reach pocketnook". The pack failure is the truer
     * explanation of the two, so it wins when both happen.
     */
    let packFailure = null;
    done.catch((cause) => {
      packFailure = cause;
    });

    try {
      const payload = await send('/api/sites', init, { timeoutMs: DEPLOY_TIMEOUT_MS });
      // Only now: a refused upload closes the body early, and reporting the
      // resulting broken pipe would hide the refusal that caused it.
      await done.catch(() => {});
      return payload;
    } catch (cause) {
      if (packFailure) throw new ApiError(packFailure.message);
      throw cause;
    }
  }

  return {
    origin,
    hasToken: Boolean(credential),
    /** The full URL of a nook, which is what a person actually wants back. */
    nookUrl: (id) => `${origin}/s/${id}/`,

    me: () => request('GET', '/me'),
    listSites: () => request('GET', '/api/sites'),
    deploy: (repoUrl) => request('POST', '/api/sites', { repoUrl }, { timeoutMs: DEPLOY_TIMEOUT_MS }),
    deployDirectory,
    stop: (id) => request('POST', `/api/sites/${id}/stop`),
  };
}
