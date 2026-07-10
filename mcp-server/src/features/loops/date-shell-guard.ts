/**
 * `date` read-only-shape guard for the loop shell-command allowlist.
 *
 * Pure leaf module — no I/O, no runtime. Extracted from loop-schema.ts so the
 * schema file owns "which commands are allowlisted + dispatch" while this module
 * owns the narrower question "is this specific `date` invocation a read-only shape."
 *
 * The single admission entry point loop-schema.ts consumes is `checkDateMutatingFlags`.
 */

// ── date read-only ALLOWLIST (staleness-01 hardening — allowlist rethink) ──────
// GNU/BSD `date` has multiple clock-SETTING shapes: `-s`/`--set` (GNU set), `-f <fmt>
// <new_date>` (BSD parse-and-set), and a bare positional operand `[[[[[cc]yy]mm]dd]HH]MM[.ss]`
// (BSD set-with-no-flag). Two successive denylist patches each missed one shape (positional,
// then `-f`), so this guard is a fail-closed ALLOWLIST: a `date` invocation is admitted ONLY
// when every token after `date` is a known read-only shape; anything else — unknown flags AND
// any bare positional operand — is rejected. The KG-age observe only ever needs bare `date` /
// `date +%s`, so a strict read-only allowlist cannot break legitimate use.

// Read-only flags that take a following value token. Bare form consumes exactly one following
// token (so its value is never examined as a positional operand); a `=`-glued form
// (`--date=<str>`) or a directly-glued BSD `-v` adjustment (`-v+1d`) is self-contained.
//   -r <epoch>       BSD print-given-epoch
//   -d/--date <str>  GNU print-given-date
//   -v <adjust>      BSD display-adjust (never sets the clock)
const DATE_READ_VALUE_FLAGS = ["-r", "-d", "--date", "-v"] as const;

// Read-only flags that take NO value: UTC/RFC output selectors and BSD `-j` (do-not-set).
// `-I`/`-Iseconds`/`-I<spec>` ISO-output selectors are matched by prefix; the rest exactly.
const DATE_READONLY_NOVALUE_FLAGS = ["-u", "-R", "-j"] as const;

/** Per-token classification result for `checkDateMutatingFlags`'s loop. */
type DateTokenVerdict =
  | { kind: "reject"; message: string }
  | { kind: "consume-next" }
  | { kind: "skip" };

/**
 * Classifies a read-value `date` flag token (`-r`, `-d`, `--date`, `-v`). Bare flag →
 * consume-next (its value token must not be re-examined as a positional operand); a
 * `=`-glued form (`--date=x`) or directly-glued `-v` adjustment (`-v+1d`) → skip
 * (self-contained). Returns null when `token` is not a read-value flag.
 */
function classifyDateReadValueFlag(token: string): DateTokenVerdict | null {
  for (const f of DATE_READ_VALUE_FLAGS) {
    if (token === f) {
      return { kind: "consume-next" };
    }
    if (token.startsWith(`${f}=`)) {
      return { kind: "skip" };
    }
  }
  // Directly-glued BSD `-v` adjustment: -v+1d, -v-1d, -v1d (value not `=`-separated).
  if (token.startsWith("-v") && token.length > 2) {
    return { kind: "skip" };
  }
  return null;
}

/** True when `token` is a read-only no-value date flag (`-u`, `-R`, `-j`, or an `-I*` ISO selector). */
function isDateReadOnlyNoValueFlag(token: string): boolean {
  return token.startsWith("-I") || DATE_READONLY_NOVALUE_FLAGS.some((f) => token === f);
}

/** Builds the fail-closed rejection message for a non-allowlisted `date` token. */
function buildDateRejectError(cmd: string, token: string): string {
  return (
    `date shell_command '${cmd}' has non-read-only token '${token}' ` +
    `(only read-only date forms are allowed under mutates_build:false: bare 'date', '+FORMAT', ` +
    `-u/-R/-I*/-j, and -r/-d/--date/-v <value>; set-clock flags '-s'/'--set'/'-f' and bare ` +
    `positional operands set the system clock and are rejected)`
  );
}

/**
 * Classifies a single `date` argument token against the read-only ALLOWLIST. Admitted:
 * `+FORMAT`; read-value flags `-r`/`-d`/`--date`/`-v` (and glued forms); no-value flags
 * `-u`/`-R`/`-j`/`-I*`. Everything else — set-clock flags (`-s`/`--set`/`-f`), unknown
 * `-`-flags, and any bare positional operand — is rejected fail-closed. Extracted so the
 * loop in checkDateMutatingFlags stays a flat dispatch under the cognitive-complexity limit.
 */
function classifyDateToken(cmd: string, token: string): DateTokenVerdict {
  if (token.startsWith("+")) {
    return { kind: "skip" }; // +FORMAT — read-only output selector, never a clock-set operand
  }
  const readValueVerdict = classifyDateReadValueFlag(token);
  if (readValueVerdict !== null) {
    return readValueVerdict;
  }
  if (isDateReadOnlyNoValueFlag(token)) {
    return { kind: "skip" };
  }
  return { kind: "reject", message: buildDateRejectError(cmd, token) };
}

/**
 * Checks whether a `date` entry is admitted by the read-only allowlist.
 * Returns an error string when any token is not a known read-only shape, null when clean.
 *
 * Admitted: `date` (no args), `date +%s`, `date -u`, `date -Iseconds`, `date -r 1234567890`
 * (BSD read-given-epoch — the digit operand is consumed by `-r`, not classified), `date -d "..."`,
 * `date -v +1d` (BSD display-adjust). Rejected fail-closed: `-s`/`--set`/`-f` set-clock flags
 * and their glued forms; any unknown `-`-prefixed flag; any bare positional operand (the BSD
 * `[[[[[cc]yy]mm]dd]HH]MM[.ss]` clock-set form) — all-digits or not.
 */
export function checkDateMutatingFlags(cmd: string): string | null {
  const tokens = cmd.trim().split(/\s+/).slice(1); // skip the leading "date" token

  for (let i = 0; i < tokens.length; i++) {
    const verdict = classifyDateToken(cmd, tokens[i]);
    if (verdict.kind === "reject") {
      return verdict.message;
    }
    if (verdict.kind === "consume-next" && tokens[i + 1] !== undefined) {
      i++;
    }
  }
  return null;
}
