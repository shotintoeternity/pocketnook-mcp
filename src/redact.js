/**
 * Keeping the token out of everything this server says (PN-062).
 *
 * `api.js` was already careful about this by hand — it refuses to put
 * `cause.message` in an error because a fetch failure can carry the request,
 * and the request carries the token. That care is right and it is not enough:
 * it is a rule every future line has to remember, and the lines that forget are
 * the error paths nobody exercises.
 *
 * So this is the same intention made structural. Every byte leaving the server
 * passes through `redact` in `mcp.js`'s `send`, once, at the boundary. A tool
 * added next year inherits it by existing rather than by being told.
 */

/**
 * A pocketnook token, recognised by the prefix `tokens.ts` gave it precisely so
 * that log filters could recognise it.
 *
 * This catches the case the hand-written care cannot: a token that is *not
 * ours* — committed into the repository being deployed, echoed by a build step,
 * printed by a test — arriving inside a build log on its way to the agent's
 * context. We hold one token; a build log can contain anybody's.
 *
 * Twenty characters minimum against the thirty-two `mintToken` issues: long
 * enough that prose mentioning `pnka_` survives, short enough that a truncated
 * token is still caught.
 */
export const TOKEN_PATTERN = /pnka_[0-9a-z]{20,}/gi;

/** What replaces one, phrased so a reader knows why the text has a hole in it. */
export const REDACTED = '[pocketnook token redacted]';

/**
 * Remove every token-shaped string, and the one token this process holds.
 *
 * Both passes, not just the pattern: the configured token is whatever
 * `POCKETNOOK_TOKEN` says it is, so if the format ever changes the literal
 * comparison keeps working after the pattern stops matching. A filter like this
 * failing open is a credential in somebody's transcript.
 *
 * `split`/`join` rather than a `RegExp` built from the token, because as far as
 * this function is concerned the token is untrusted input and a regular
 * expression compiled from it is a metacharacter bug waiting to happen.
 */
export function redact(text, token) {
  const withoutOurs = token && token.length >= 8 ? String(text).split(token).join(REDACTED) : String(text);
  return withoutOurs.replace(TOKEN_PATTERN, REDACTED);
}
