/**
 * vitest-setup-drift-guard — global setupFiles entry that arms the
 * drift.db fixture-leak recurrence guard for every test file in the suite.
 *
 * See `drift-db-leak-guard.ts` for the guard's design and rationale.
 */

import { installDriftDbLeakGuard } from "./drift-db-leak-guard.ts";

installDriftDbLeakGuard();
