# Changelog

## [2.18.0](https://github.com/micherra/canon/compare/v2.17.0...v2.18.0) (2026-07-06)


### Features

* **hooks:** PreToolUse stale-daemon version-mismatch nudge (handoff hardening item 2) ([#465](https://github.com/micherra/canon/issues/465)) ([2910442](https://github.com/micherra/canon/commit/29104426054d9980f28762b5183eca4f62329a80))
* **loops:** ship-watch surfaces auto-update-branch when the PR falls behind main ([#464](https://github.com/micherra/canon/issues/464)) ([d321bcf](https://github.com/micherra/canon/commit/d321bcfbf212c16dda6d61592d20b2cdc105181c))
* **orchestration:** capture cliff transcripts at reconcile-time detection (watch_GGGGGG1 follow-up) ([#466](https://github.com/micherra/canon/issues/466)) ([3f06820](https://github.com/micherra/canon/commit/3f06820eff3a1a01bf7eab470aec91df3e6ceac9))


### Bug Fixes

* **agents:** give the scribe a step-1 skeleton to end the dominant context-sync write-cliff (watch_GGGGGG1) ([#461](https://github.com/micherra/canon/issues/461)) ([62c9600](https://github.com/micherra/canon/commit/62c96003582890711e9066225128088425717d50))

## [2.17.0](https://github.com/micherra/canon/compare/v2.16.0...v2.17.0) (2026-07-06)


### Features

* **autonomy:** deterministic Stop-hook tail-enforcement gate (D3) ([#451](https://github.com/micherra/canon/issues/451)) ([d716112](https://github.com/micherra/canon/commit/d716112585afa28fdabb67b567a52cf57fe28982))
* **diagnostics:** deterministic context-manifest-freshness gate (sug_MANIFESTGAP1) ([#448](https://github.com/micherra/canon/issues/448)) ([3b43965](https://github.com/micherra/canon/commit/3b439650497a2888ad7012e538a2183dc8c9e356))
* **evolution:** post-apply regression detection Inc 1+2 — applied_evolutions v12 + provenance tools (ADR-0034) ([#445](https://github.com/micherra/canon/issues/445)) ([eea940d](https://github.com/micherra/canon/commit/eea940d1cc7053299ffa49b351c25dcae7b1eeb8))
* **orchestration:** cache hit/miss token telemetry in execution metrics ([#442](https://github.com/micherra/canon/issues/442)) ([3bb84f0](https://github.com/micherra/canon/commit/3bb84f071cf04454f44f3cca2bf0b272d3a6b3a0))
* **orchestration:** cross-session chatter + active-workspaces registry (event-backbone epic Inc 0) ([#450](https://github.com/micherra/canon/issues/450)) ([8130fd2](https://github.com/micherra/canon/commit/8130fd24b87ea7ef39eba22a203f2e6af0b5383b))
* **orchestration:** durable cross-workspace decisions corpus + get_decisions_corpus (ADR-0040) ([#456](https://github.com/micherra/canon/issues/456)) ([6b26f13](https://github.com/micherra/canon/commit/6b26f13c839fc7ec810ad8a23ff71d7b6c5ac8d9))
* **orchestration:** plan-time base-advance advisory (forecast_base_advance, anticipatory-canon Inc-0) ([#455](https://github.com/micherra/canon/issues/455)) ([18512d7](https://github.com/micherra/canon/commit/18512d72f70f7a2c3d6a9f1be6891864418574d3))
* **principles:** promote 2 threshold-met learnings — sug_EVALWIRE1 reachability-probe clause + sug_BBBB1 removal-sweep-includes-prose ([#447](https://github.com/micherra/canon/issues/447)) ([ab4a4e0](https://github.com/micherra/canon/commit/ab4a4e0777eb06e9cf5f129129b12d4d2cbf0385))
* **ui:** Artifact-tool gate presentation + design-system type-scale legibility bump ([#459](https://github.com/micherra/canon/issues/459)) ([330cfbb](https://github.com/micherra/canon/commit/330cfbbad73dc71c165af264b15293768e71319f))


### Bug Fixes

* **drift-db:** isolate finalize-test fixture leak + recurrence guard + reviewer-blindspot ADR ([#446](https://github.com/micherra/canon/issues/446)) ([ef4c3c1](https://github.com/micherra/canon/commit/ef4c3c1a0af9463d1d5b017f5c9c47acaf74cd15))
* **hooks:** daemon supervisor self-recovers from a surviving port owner on handoff ([#452](https://github.com/micherra/canon/issues/452)) ([bdb1ed3](https://github.com/micherra/canon/commit/bdb1ed326d7c363de26584fc382a2af88ac2a066))
* **orchestration:** re-wire evaluator step-transition gate clobbered by PR [#175](https://github.com/micherra/canon/issues/175); retire planner+janitor shells ([#443](https://github.com/micherra/canon/issues/443)) ([fd69ae6](https://github.com/micherra/canon/commit/fd69ae61ac4972a1e986fea694286d2f8ac5b69b))
* **release:** bump context-manifest.json version in lockstep via release-please extra-files ([#460](https://github.com/micherra/canon/issues/460)) ([60f6059](https://github.com/micherra/canon/commit/60f60595ddfc2e224b489c803760f81aa2ff027c))

## [2.16.0](https://github.com/micherra/canon/compare/v2.15.0...v2.16.0) (2026-07-02)


### Features

* **evolution:** agent-definition-body provenance seam + review-violation code-author join + frontmatter guard (trace-driven-evolution Phase 2) ([#438](https://github.com/micherra/canon/issues/438)) ([8b4a073](https://github.com/micherra/canon/commit/8b4a07373e934612c6d00969b509d0b367f2d89c))
* **hooks:** shell-CI-parity verify gate — execute hook test suites locally (watch_BBBBBBBBB1) ([#434](https://github.com/micherra/canon/issues/434)) ([4c6da9d](https://github.com/micherra/canon/commit/4c6da9dae345734f211feac55eed2793cbeade4b))
* **knowledge:** search_knowledge tool + doc-vector index (KG schema v6, R2 keystone) ([#435](https://github.com/micherra/canon/issues/435)) ([dfbd4c8](https://github.com/micherra/canon/commit/dfbd4c85fe39d9169991eff037498362e169fcf1))
* **learner:** M1 success-pattern learner — positive-signal mining (AgentKB R4) ([#437](https://github.com/micherra/canon/issues/437)) ([09ed7ce](https://github.com/micherra/canon/commit/09ed7cec3cc60e7b77a31f140cc8b1a197aaef1c))
* **loops:** ship-watch auto-enable-merge consumer — arm squash auto-merge on CI-green ([#440](https://github.com/micherra/canon/issues/440)) ([5445291](https://github.com/micherra/canon/commit/5445291c6543525d66326073a1f2002b60f19748))
* **principles:** promote 12 threshold-met learnings — 3 conventions + diff-hook worktree_path fix + protocol clauses ([#441](https://github.com/micherra/canon/issues/441)) ([1d946e3](https://github.com/micherra/canon/commit/1d946e31978b39df7d8954bdeac35554828b5c18))
* **workflows:** Inc 0 — canon-probe canary + node-AST workflows/ CI lint ([#431](https://github.com/micherra/canon/issues/431)) ([76612f3](https://github.com/micherra/canon/commit/76612f3943a322c7a176a961a18f5e1fafb5e02a))


### Bug Fixes

* **diagnostics:** drift-report most_violated blind to resolved violations (sug_KKKKKK1) ([#439](https://github.com/micherra/canon/issues/439)) ([2198c49](https://github.com/micherra/canon/commit/2198c496c7529e546261678ab02ca0643fb0df96))
* **security:** resolve 11 open CodeQL code-scanning alerts + add code-scanning-autofix routine ([#436](https://github.com/micherra/canon/issues/436)) ([c46e10a](https://github.com/micherra/canon/commit/c46e10a1143bd51adb44486c659b05416b512b7f))

## [2.15.0](https://github.com/micherra/canon/compare/v2.14.0...v2.15.0) (2026-06-30)


### Features

* **conventions:** human-narrative/machine-query seam + RLM follow-ups roadmap (Phase 0) ([#430](https://github.com/micherra/canon/issues/430)) ([b61c4cf](https://github.com/micherra/canon/commit/b61c4cf34dc040a1f41efca9a91f3b134de233da))
* **evolution:** non-principle apply-channel enrichment for /canon:review-learnings — trace-driven-evolution Phase 1 ([#427](https://github.com/micherra/canon/issues/427)) ([8e34be7](https://github.com/micherra/canon/commit/8e34be78a6873afeef8ea36f7fa1270f990c5db1))
* **security:** structural trust boundary for untrusted overlay records — opaque box + charset gate + linear glob ([#428](https://github.com/micherra/canon/issues/428)) ([b5957b6](https://github.com/micherra/canon/commit/b5957b6e84d0186b93da5e253c045179a54e7c98))

## [2.14.0](https://github.com/micherra/canon/compare/v2.13.0...v2.14.0) (2026-06-27)


### Features

* **conventions:** promote safety-classifier posture + ADR sequential-ID gate (watch_ZZZZZZZ1 + convention_UUUUUUUU1) ([#419](https://github.com/micherra/canon/issues/419)) ([e0152c9](https://github.com/micherra/canon/commit/e0152c91e2f5f9eac0ed422e1d634f8c85e010ef))
* **dead-wire:** compiler-API binding resolver replaces regex+allowlist ([#415](https://github.com/micherra/canon/issues/415)) ([644bf69](https://github.com/micherra/canon/commit/644bf69a21362df001c615df386bc500f85a14ed))
* **evolution:** attribute_failure — trace-driven-evolution Phase 1 ATTRIBUTE consumer ([#418](https://github.com/micherra/canon/issues/418)) ([ab0815b](https://github.com/micherra/canon/commit/ab0815b49acc4c6929e46dd612bdf39088963337))
* **evolution:** evolve loop host — trace-driven-evolution Phase 1 deliverable 4 ([#423](https://github.com/micherra/canon/issues/423)) ([e4eb933](https://github.com/micherra/canon/commit/e4eb933e835b829388aa8e98bd9cdb58664317ce))
* **evolution:** the Mutator + guardrail injection upgrade — trace-driven-evolution Phase 1 deliverable 5 ([#421](https://github.com/micherra/canon/issues/421)) ([346be3a](https://github.com/micherra/canon/commit/346be3a45a69da22a9ad33b6fba1c2785bdeb2a7))
* **evolution:** trace-driven-evolution Phase-1 fitness gate — evaluate_candidate ([#414](https://github.com/micherra/canon/issues/414)) ([ae656ae](https://github.com/micherra/canon/commit/ae656ae50cfd68e8721cb9cdb4d835227b1e6e91))
* **loops:** harness-watch loop — self-paced learner nudge (G2 Increment 1) ([#408](https://github.com/micherra/canon/issues/408)) ([3da25f6](https://github.com/micherra/canon/commit/3da25f617667a7393d4a4908d127cad0141cda71))
* **orchestration:** concurrency-safety hardening for multi-session Canon orchestration ([#416](https://github.com/micherra/canon/issues/416)) ([056d898](https://github.com/micherra/canon/commit/056d8981ca58d5774685a7847ed3f7efdc24e798))
* **phase0:** context staleness detection + primers sync_indexes class ([#420](https://github.com/micherra/canon/issues/420)) ([1a857b1](https://github.com/micherra/canon/commit/1a857b14e0ed6bad5200753ee16c12d55f4de860))
* **principles:** promote 4 concurrency-safety conventions (watch_OOOOOOOOOO1-4) ([#417](https://github.com/micherra/canon/issues/417)) ([d6f30fb](https://github.com/micherra/canon/commit/d6f30fb23498dc1a51e0399a5d1cd26b209a56e8))
* **principles:** promote 5 batch learnings ([#395](https://github.com/micherra/canon/issues/395)/[#401](https://github.com/micherra/canon/issues/401)/[#402](https://github.com/micherra/canon/issues/402)/[#403](https://github.com/micherra/canon/issues/403)) — allowlist posture, dep-bump, ADR-collision + 2 protocol notes ([#406](https://github.com/micherra/canon/issues/406)) ([a457618](https://github.com/micherra/canon/commit/a457618efdac80742379b1291c14949c7292df92))
* **provenance:** trace-driven-evolution Phase-1 step-0 — context provenance instrumentation ([#413](https://github.com/micherra/canon/issues/413)) ([4827eec](https://github.com/micherra/canon/commit/4827eec82e718b7016284aef97f50e485a2c62ca))
* **wiki-lint:** markdown corpus integrity — frontmatter schema + link-graph + corpus cross-links (R0–R3) ([#412](https://github.com/micherra/canon/issues/412)) ([24c0cbe](https://github.com/micherra/canon/commit/24c0cbe4ecf4eb4c7878c8d232fe165dcdfaa4b8))


### Bug Fixes

* **push-guard:** stop treating shell redirect tokens as git push refspecs ([#409](https://github.com/micherra/canon/issues/409)) ([6503c47](https://github.com/micherra/canon/commit/6503c47eb47cc4338faab9f9f0b4a5e4ecfd224b))

## [2.13.0](https://github.com/micherra/canon/compare/v2.12.0...v2.13.0) (2026-06-22)


### Features

* **conventions:** add disk-is-source-of-truth-on-resume (intra-agent checkpointing) ([#383](https://github.com/micherra/canon/issues/383)) ([406b3df](https://github.com/micherra/canon/commit/406b3dfb2fc284eea0a8eb058dbc1796c1831084))
* **conventions:** promote 3 learner items — fail-closed-scan-scope, harness-tool-invocation-check, renderer write-not-echo ([#388](https://github.com/micherra/canon/issues/388)) ([b691a86](https://github.com/micherra/canon/commit/b691a867bb15bc282f4ba120686b6333b2e16787))
* enforce feature-boundary invariant — genuine decoupling + grey-box model ([#390](https://github.com/micherra/canon/issues/390)) ([ed7495a](https://github.com/micherra/canon/commit/ed7495ab9feb84925a4202e0b5984c5000456721))
* **hooks:** deterministic-verification hardening (Batch A) -- dead-wire gate, fail-closed mechanical checks, spec-traced tester ([#389](https://github.com/micherra/canon/issues/389)) ([bedc382](https://github.com/micherra/canon/commit/bedc3822c173d66590b8367fb2b5d42b1a695b7f))
* **learner:** artifact-retirement (prune) dimension — subtraction discipline (Batch C) ([#396](https://github.com/micherra/canon/issues/396)) ([f52d4b3](https://github.com/micherra/canon/commit/f52d4b333db6fd9d1b75fa7a0997bbd23af1ffa9))
* **loops:** add orchestrator_action directive — declarative loop-to-orchestrator action signal ([#393](https://github.com/micherra/canon/issues/393)) ([b277c93](https://github.com/micherra/canon/commit/b277c9389d2abc6785dac5008e805ab9f118ab83))
* **loops:** Phase C — self-paced mode + session-watch + first-tick baseline (ADR-0002) ([#381](https://github.com/micherra/canon/issues/381)) ([cbe60ca](https://github.com/micherra/canon/commit/cbe60cab9b6c11e485dfe59a3a7bfe71146f9be6))
* **mcp-http:** harden F1/F4, wire DEC-05 sidecar, flip default transport stdio to HTTP daemon ([#382](https://github.com/micherra/canon/issues/382)) ([99c9a04](https://github.com/micherra/canon/commit/99c9a045dc45421b9b83dfb6e72218f887d03b60))
* **orchestration:** orchestrator memory hardening (Batch B) — decisions ledger + checkpoint + in-session compaction rehydration ([#394](https://github.com/micherra/canon/issues/394)) ([051a49e](https://github.com/micherra/canon/commit/051a49e2aece91db7b086f00edc9471d4c2ec5bd))
* **principles:** separate Canon-internal conventions from shipped set — portable flag, relocation, dedup + misroute guards ([#387](https://github.com/micherra/canon/issues/387)) ([de2b49f](https://github.com/micherra/canon/commit/de2b49f2a2a955ca95fe9d90c07ef03429f83c55))
* **worktree:** symlink node_modules into worktrees (LSP) with containment guards + fix push-guard false-positives ([#386](https://github.com/micherra/canon/issues/386)) ([d4b7923](https://github.com/micherra/canon/commit/d4b7923b2decf94f9d849e048fb3fba5d96280c8))


### Bug Fixes

* **deps:** override esbuild to 0.28.1 to clear high-sev advisory (GHSA-gv7w-rqvm-qjhr) ([#397](https://github.com/micherra/canon/issues/397)) ([1d360a2](https://github.com/micherra/canon/commit/1d360a29e9692058c1eac2b665c2acdb365d61b2))
* **deps:** override protobufjs to 7.6.4 — clear high-sev npm-audit advisory blocking CI ([#403](https://github.com/micherra/canon/issues/403)) ([56814eb](https://github.com/micherra/canon/commit/56814eb79cc2a458c05050cecbe711c8a0c39809))
* **docs:** excise vestigial .canon/learn.sh references + corpus audit ([#392](https://github.com/micherra/canon/issues/392)) ([c94af05](https://github.com/micherra/canon/commit/c94af05226c70390c37db13b4b81e145fc35cce9))
* **drift-store:** close 20 stale orphaned-branch violation rows via audited seed ([#399](https://github.com/micherra/canon/issues/399)) ([4a7e96c](https://github.com/micherra/canon/commit/4a7e96c41b0894214fc5c2a2af43dcea3c20877f))
* **finalize:** remove destructive teardown — branch/worktree survive until post-ship ([#401](https://github.com/micherra/canon/issues/401)) ([5be384c](https://github.com/micherra/canon/commit/5be384ce8937a3faccf8238ee96504958bd08a8c))
* **hooks:** close two push-guard bypass vectors (backslash-escape + glued cmdsub) ([#402](https://github.com/micherra/canon/issues/402)) ([52e7ab3](https://github.com/micherra/canon/commit/52e7ab3428f912ee0703fb73fcc2e80ed597e929))
* **loops:** register /canon:loop-tick via plugin.json commands field so CronCreate dispatch fires ([#384](https://github.com/micherra/canon/issues/384)) ([aa6afde](https://github.com/micherra/canon/commit/aa6afde25ce669af198d03756771b5c9f3d78310))
* **loops:** resilient loop dispatch — self-contained inline tick prompt, no /canon:loop-tick slash dependency ([#395](https://github.com/micherra/canon/issues/395)) ([417b850](https://github.com/micherra/canon/commit/417b850af2f51c97365ccf9559b6d05eb4655863))
* **mcp-auth:** durable MCP client/daemon auth token determinism + pidfile lifecycle ([#398](https://github.com/micherra/canon/issues/398)) ([898eb1c](https://github.com/micherra/canon/commit/898eb1c0b8cba155e0e2c38da3c286b228f9f5e4))

## [2.12.0](https://github.com/micherra/canon/compare/v2.11.0...v2.12.0) (2026-06-11)


### Features

* **adr:** add docs/adr/ with conjunctive gate wired into architect ([#364](https://github.com/micherra/canon/issues/364)) ([ac0150b](https://github.com/micherra/canon/commit/ac0150b5b07fc72b993e2bb90581bdae16c9a57e))
* **agents:** adopt stock-skill lessons — correctness scan, FP suppression, live smoke ([#369](https://github.com/micherra/canon/issues/369)) ([3c8b4ae](https://github.com/micherra/canon/commit/3c8b4aebeb6c657da25149be893750fd704b2b3c))
* **conventions:** promote mechanism-ships-first-instance convention (sug_AAAAAAAA1) ([#374](https://github.com/micherra/canon/issues/374)) ([fe33d8e](https://github.com/micherra/canon/commit/fe33d8e61652e09c0334add4dbe86141fbf0be48))
* **conventions:** promote sug_NNNNN1 to probe-before-build-invoke-not-infer convention ([#367](https://github.com/micherra/canon/issues/367)) ([f15d817](https://github.com/micherra/canon/commit/f15d817b26451d8d7f6470c8cffd7435261805ef))
* **harness:** expose LSP, WebSearch/WebFetch, PushNotification to Canon ([#366](https://github.com/micherra/canon/issues/366)) ([9f7edc3](https://github.com/micherra/canon/commit/9f7edc37bd247465ce1582dd63485ae3ccf4a75c))
* **hooks:** fail-closed PreToolUse Bash hook blocking direct pushes to main ([#376](https://github.com/micherra/canon/issues/376)) ([213d68b](https://github.com/micherra/canon/commit/213d68b571054b34b59c7186f6e08e460b35d1a1))
* **indexes:** retrofit sibling artifact indexes to marker-block-hybrid generators ([#365](https://github.com/micherra/canon/issues/365)) ([49eb0c8](https://github.com/micherra/canon/commit/49eb0c83767c9e07272a09040445c1275c6efc2c))
* **lsp-recommender:** init-time language-tooling provisioning — LSP + KG overlay ([#375](https://github.com/micherra/canon/issues/375)) ([05b4475](https://github.com/micherra/canon/commit/05b44751bab7df7ddddf75d7cbdd72adbafd2ba7))
* **principle:** promote scanner-avoids-its-own-pattern convention ([#358](https://github.com/micherra/canon/issues/358)) ([c906bfe](https://github.com/micherra/canon/commit/c906bfee33c110a3ece458b4a023f4893a66f96f))
* **reviewer:** mine Codex PR corpus and pre-empt top-7 defect classes ([#355](https://github.com/micherra/canon/issues/355)) ([6b324dc](https://github.com/micherra/canon/commit/6b324dca3339bb4bcf403098238eb4af544259f6))
* **wiki-lint:** add glossary_consistency check — 8th wiki_lint check ([#371](https://github.com/micherra/canon/issues/371)) ([94dbdfc](https://github.com/micherra/canon/commit/94dbdfcf1ef66fa7b8f9557cf9f8d26f58fb18a0))


### Bug Fixes

* **lsp:** add repo-root tsconfig.json to resolve TypeScript LSP diagnostics ([#377](https://github.com/micherra/canon/issues/377)) ([a3d2297](https://github.com/micherra/canon/commit/a3d22973ba20cd33f4facb02699a0fe9a979f42b))
* **mcp-json:** remove dead CANON_PLUGIN_DIR env line that triggers missing-var warning ([#379](https://github.com/micherra/canon/issues/379)) ([8662172](https://github.com/micherra/canon/commit/8662172422b8d2352c7ef3bf2c9648ec4986f106))

## [2.11.0](https://github.com/micherra/canon/compare/v2.10.0...v2.11.0) (2026-06-10)


### Features

* **drift:** violation lifecycle + auto-closure on superseding CLEAN review (watch_RRRRRR1) ([#351](https://github.com/micherra/canon/issues/351)) ([1ba1848](https://github.com/micherra/canon/commit/1ba18481b51c0f86dfda4cb8b5b37e3bdeae9310))


### Bug Fixes

* **mcp-boot:** remove the var-absent class — probe-resolve boot.sh AND validate pluginDir (durable) ([#370](https://github.com/micherra/canon/issues/370)) ([f8f98e6](https://github.com/micherra/canon/commit/f8f98e6f96c60a6d7bab02236b62229e2efc8867))
* **prod-readiness:** repair /canon:doctor boot check, add npm-audit CI gate + clear 6 vulns, vitest timeout/maxWorkers policy ([#368](https://github.com/micherra/canon/issues/368)) ([027aa37](https://github.com/micherra/canon/commit/027aa377418cbbcad82d1bfb5fee3f8f1b710955))

## [2.10.0](https://github.com/micherra/canon/compare/v2.9.0...v2.10.0) (2026-06-10)


### Features

* **ci:** install-faithful guards — lint + install-sim smoke test + convention (prevent dev-file-leak boot breakage) ([#363](https://github.com/micherra/canon/issues/363)) ([5b98216](https://github.com/micherra/canon/commit/5b98216dce939baaff659fd61ce1f3ef8c66feec))
* **ddd-freshness:** KG doc nodes, doc:references edges, wiki_lint DDD scan, scribe Step 5c ([#348](https://github.com/micherra/canon/issues/348)) ([90c3dac](https://github.com/micherra/canon/commit/90c3dac4f68c020b83754dd1c0526f243947447a))
* **loops:** Phase B — ship-watch definition + read-only-shell guardrail (first real loop) ([#362](https://github.com/micherra/canon/issues/362)) ([8268b58](https://github.com/micherra/canon/commit/8268b5801ce927072f2fa8dfbfc6d65824f74a24))
* **routines:** first-class managed artifact class — full management layer ([#352](https://github.com/micherra/canon/issues/352)) ([b929fbb](https://github.com/micherra/canon/commit/b929fbba855b4123e27b337cccbade5c1f29f61f))


### Bug Fixes

* **boot:** stop shipping exact Node pin + add Node&gt;=24 preflight (asdf boot trap, [#354](https://github.com/micherra/canon/issues/354)) ([#361](https://github.com/micherra/canon/issues/361)) ([1e8df23](https://github.com/micherra/canon/commit/1e8df23abfdc37014dc94993d1f317fc41de474a))
* **mcp:** restore plugin-install boot — route CLAUDE_PLUGIN_ROOT via env, not args (closes [#354](https://github.com/micherra/canon/issues/354)) ([#356](https://github.com/micherra/canon/issues/356)) ([7da6d13](https://github.com/micherra/canon/commit/7da6d13fc3855bea80c78f6623f5d13bbcf2560a))
* **tests:** harden 3 flaky integration tests — git-op timeout, depcruise CWD, embedding latency ([#357](https://github.com/micherra/canon/issues/357)) ([143d2f2](https://github.com/micherra/canon/commit/143d2f2a572f2a766851f7ba3d08ecd10d0f252d))

## [2.9.0](https://github.com/micherra/canon/compare/v2.8.0...v2.9.0) (2026-06-08)


### Features

* **cliff:** cliff_detected learner dimension consumer (watch_BBBBB1) ([#347](https://github.com/micherra/canon/issues/347)) ([8aad924](https://github.com/micherra/canon/commit/8aad924159498bcfd75063cc0613f11b783a34e0))
* **learner:** promote batch 6 — reviewer pre-fix regression check, grep-scope convention, scope_tags wiki-lint check ([#343](https://github.com/micherra/canon/issues/343)) ([1025610](https://github.com/micherra/canon/commit/10256104e90ab6158aad609631831dfae6248670))
* **loops:** Loop-as-Artifact Framework — Phase A (schema, registry, runtime) ([#350](https://github.com/micherra/canon/issues/350)) ([5c3d2e6](https://github.com/micherra/canon/commit/5c3d2e6d88eb1467eb379baa0ce5eab99f347945))


### Bug Fixes

* **security:** lock down unauthenticated artifact sidecar (:3141) + share loopback-host guard ([#349](https://github.com/micherra/canon/issues/349)) ([c7dd950](https://github.com/micherra/canon/commit/c7dd950fc85ead5a32d6331a035e7bdb1afe76b9))

## [2.8.0](https://github.com/micherra/canon/compare/v2.7.0...v2.8.0) (2026-06-07)


### Features

* **http-epic-phase2:** Streamable-HTTP MCP daemon — per-session transport, loopback auth, scope handshake, supervisor (flag-dark) ([#342](https://github.com/micherra/canon/issues/342)) ([a2a1c67](https://github.com/micherra/canon/commit/a2a1c67adeb6c3e86b9e587b2e13c616d8598e49))
* **learner:** promote batch 5 — worktree_path, renderer conventions, stream-idle resume, counterexample obligation ([#341](https://github.com/micherra/canon/issues/341)) ([404517b](https://github.com/micherra/canon/commit/404517ba54b9b43fc044947988a2c03c41af36cb))
* **learner:** promote sug_NNNNNN1 + watch_WWWWW2 + watch_VVVVV3 (3-item batch) ([#334](https://github.com/micherra/canon/issues/334)) ([9c3aaec](https://github.com/micherra/canon/commit/9c3aaec7dd7be66d6222c37e03da80df0b053752))
* **learner:** promote watch_KKKKK1 — reviewer Stage 6 scope-parity check for precision/scope fixes ([#332](https://github.com/micherra/canon/issues/332)) ([c0efa0d](https://github.com/micherra/canon/commit/c0efa0d73d80ef014eea00d1bf2d3de5b6285f57))
* **learner:** promote watch_VVVVV2 — severity-vocabulary consistency obligations (writer pre-commit + reviewer Stage 2) ([#335](https://github.com/micherra/canon/issues/335)) ([b1ceea5](https://github.com/micherra/canon/commit/b1ceea5003249f2f0bc93c91bdbad57aaab043bb))


### Bug Fixes

* **file-card:** repair broken file-detail-card rendering in review.html ([#338](https://github.com/micherra/canon/issues/338)) ([d31614c](https://github.com/micherra/canon/commit/d31614c8b0a2c0c0c3614c907b7044c84a162fb4))
* **hooks:** fix destructive-guard false positives on comments/quoted strings ([#337](https://github.com/micherra/canon/issues/337)) ([886fd67](https://github.com/micherra/canon/commit/886fd67fc8714082dec20e5082d4ce70e2ab5f03))
* **renderer:** render GFM tables in review narrative panel ([#336](https://github.com/micherra/canon/issues/336)) ([7330b17](https://github.com/micherra/canon/commit/7330b17eedb04991f44bb60c0b9f787ad31d3980))

## [2.7.0](https://github.com/micherra/canon/compare/v2.6.0...v2.7.0) (2026-06-06)


### Features

* **diagnostics:** wiki-lint scope_layers check + retroactive invalid-layer fixes (sug_VVVVV1) ([#321](https://github.com/micherra/canon/issues/321)) ([891e1af](https://github.com/micherra/canon/commit/891e1af51ad669a4d65a47df4702388d5934d4f9))
* **janitor:** detect and remove empty workspace husk directories ([#325](https://github.com/micherra/canon/issues/325)) ([cbec8f6](https://github.com/micherra/canon/commit/cbec8f63281d8905d911584c5a0866744a4c0b09))
* **learner:** promote sug_DDDDD1 — doc-trim-fact-preservation convention + post-scribe scope guard ([#330](https://github.com/micherra/canon/issues/330)) ([ee32149](https://github.com/micherra/canon/commit/ee321493a1f971179fec22685a6b1e4a26740ba2))
* **learner:** promote sug_VVVV1 — agent→tool reachability gate (reviewer Stage 2 + wiring enrichment) ([#328](https://github.com/micherra/canon/issues/328)) ([1f53b59](https://github.com/micherra/canon/commit/1f53b5922207665497e34778a555c0487d38b78c))
* **orchestration:** wire build diff stats into FlowRunEntry at finalize (craft Piece B) ([#327](https://github.com/micherra/canon/issues/327)) ([f0c56fe](https://github.com/micherra/canon/commit/f0c56fed2bc6d3ac9957e4444c5ba7ef2b6b2020))
* **writer:** require executing verification commands against the real tree before commit (sug_EEEEE1) ([#324](https://github.com/micherra/canon/issues/324)) ([fef7988](https://github.com/micherra/canon/commit/fef7988f5bde29f945c05bf017e292d3122a1195))

## [2.6.0](https://github.com/micherra/canon/compare/v2.5.0...v2.6.0) (2026-06-05)


### Features

* **http-epic-phase2:** isolation-finish slice — per-project JobManager + http-server scope ([#316](https://github.com/micherra/canon/issues/316)) ([eec09ca](https://github.com/micherra/canon/commit/eec09ca50d37f4975415b4680973377c9d8d831a))
* **kg-sync:** lazy commit-granularity KG freshness + self-healing orphan prune ([#303](https://github.com/micherra/canon/issues/303)) ([057aacc](https://github.com/micherra/canon/commit/057aaccbc2a245040971012391b4e77aa7171912))
* **learner:** outcome-weighted JUDGE + staleness CONSOLIDATE ([#306](https://github.com/micherra/canon/issues/306)) ([e9f9aee](https://github.com/micherra/canon/commit/e9f9aeebf4ffea3ea1e6e3d680a2644e493de8f4))
* **principle:** promote line-limit-split-into-siblings convention (sug_UUUU2, 4/4) ([#314](https://github.com/micherra/canon/issues/314)) ([34a3a5d](https://github.com/micherra/canon/commit/34a3a5ddc396ca96cbb9e8a42251843c964bcf6a))
* **scribe:** constrain context-sync to build-changed sections; remove size-budget trimming ([#312](https://github.com/micherra/canon/issues/312)) ([7ac170c](https://github.com/micherra/canon/commit/7ac170c3591b659f1a987c91b113e9da7a7bc0ce))
* **writer:** route principle writes by tier — tracked-source vs installed-copy ([#318](https://github.com/micherra/canon/issues/318)) ([dcfba2c](https://github.com/micherra/canon/commit/dcfba2cb9844a6ba528894eb3e385859ea9c17ca))


### Bug Fixes

* **hooks:** subcommand-aware tokenizer for destructive-guard (Phase 0) ([#300](https://github.com/micherra/canon/issues/300)) ([4ebd6ed](https://github.com/micherra/canon/commit/4ebd6ed80e1b98f6e3bb40494ffb0fa55daa0362))
* **kg-embedding:** skip real-embeddings suite when model CDN unreachable (CI 429) ([#319](https://github.com/micherra/canon/issues/319)) ([8e45020](https://github.com/micherra/canon/commit/8e45020ea937b27eb8c3b55d32ed8e7d710fb103))
* **protocol:** DAG single-task guard + BUILD_BASE_COMMIT worktree base ([#285](https://github.com/micherra/canon/issues/285)) ([16eb4d9](https://github.com/micherra/canon/commit/16eb4d9f8524749b667eda4a2b9a184a070ffb01))
* **server-state:** replace fixed-dirname-count pluginDir seed with marker-walk ([#315](https://github.com/micherra/canon/issues/315)) ([e8ddf27](https://github.com/micherra/canon/commit/e8ddf27bcaa38f805cab13a3d99e9a5da9da1369))

## [2.5.0](https://github.com/micherra/canon/compare/v2.4.1...v2.5.0) (2026-06-04)


### Features

* **craft-v2:** redefine craft as a principle-backed 6-dimension profile (per-review + periodic audit + learner drift) ([#301](https://github.com/micherra/canon/issues/301)) ([60ed698](https://github.com/micherra/canon/commit/60ed6984dc1d1c5b273cbd33af9e60dcac43329d))
* **handoff:** graceful agent handoff phase 1 — reconcile_workspace + harvest substrate ([#281](https://github.com/micherra/canon/issues/281)) ([13d0c76](https://github.com/micherra/canon/commit/13d0c76b25c06a58775c468c12a5b96e748f6281))
* **http-epic-phase1:** finish Phase 1 — remove projectDir global (1c+1d) ([#304](https://github.com/micherra/canon/issues/304)) ([8e1d55d](https://github.com/micherra/canon/commit/8e1d55ddedf7a84b4363d27b81a4cab45eeeb3e0))
* **learner:** address BBBB1-BBBB4 — enrichment pipeline convention + docs ([#282](https://github.com/micherra/canon/issues/282)) ([d166795](https://github.com/micherra/canon/commit/d166795fe2d3e490b4e41921038e73553039c7aa))
* **review:** 6 quality-playbook-inspired improvements to reviewer, tester, and orchestrator ([#283](https://github.com/micherra/canon/issues/283)) ([15f1ef2](https://github.com/micherra/canon/commit/15f1ef2a05e1700d7af2302ffd921e1229b712d9))
* wire reconcile_workspace into resume + post-subagent path (observe+surface only) ([#309](https://github.com/micherra/canon/issues/309)) ([e31fd98](https://github.com/micherra/canon/commit/e31fd981002916dea3709da4c8da530ded39e642))


### Bug Fixes

* **review-graph:** unify force-directed engine — fixes clustered/unreadable dependency map ([#307](https://github.com/micherra/canon/issues/307)) ([ca5b68f](https://github.com/micherra/canon/commit/ca5b68f69cf6d77fb78a3c4a083a03aa1975146f))

## [2.4.1](https://github.com/micherra/canon/compare/v2.4.0...v2.4.1) (2026-06-03)


### Bug Fixes

* **artifact-validation:** harden SUMMARY path validation + authoritative artifact-location spec ([#298](https://github.com/micherra/canon/issues/298)) ([e4b1cea](https://github.com/micherra/canon/commit/e4b1ceaecc637652f13bef4cf122f4a3e3db319d))
* **mcp-boot:** ESM dep reachability + bounded deps-ready wait for clean installs ([#296](https://github.com/micherra/canon/issues/296)) ([bd452f9](https://github.com/micherra/canon/commit/bd452f9e3d65537cb78b2f55f5b5ab7aa4a2817d))

## [2.4.0](https://github.com/micherra/canon/compare/v2.3.0...v2.4.0) (2026-06-02)


### Features

* **diagnostics:** doc-freshness drift dimension + scribe docs/*.md scope (watch_ZZZ1) ([#274](https://github.com/micherra/canon/issues/274)) ([9432ce9](https://github.com/micherra/canon/commit/9432ce97f26800e862d0fc671f28a04e78dc80c2))
* **http-epic-1a:** per-connection scope registry + resolveScope ([#288](https://github.com/micherra/canon/issues/288)) ([a52a4e9](https://github.com/micherra/canon/commit/a52a4e967d5622a5b935998123def1fa29c43b1a))
* **http-epic-1b:** migrate 5 tool boundaries to per-request resolveScope(extra) ([#290](https://github.com/micherra/canon/issues/290)) ([62e4cce](https://github.com/micherra/canon/commit/62e4cce2bb7fec3f5cee58ecfd2cacf6066e5419))
* **memory:** area memory + hot-file caution for engineers ([#279](https://github.com/micherra/canon/issues/279)) ([222c0fe](https://github.com/micherra/canon/commit/222c0fefee55ae5f451e355b54866fbf95b57d1f))
* **observability:** address learner proposals YYY1-YYY4 + catch-block sweep ([#275](https://github.com/micherra/canon/issues/275)) ([a7cbe3b](https://github.com/micherra/canon/commit/a7cbe3bf4c66f048a4ea1d8b5192e1e8f82f8e6a))
* **release:** adopt release-please for automated Canon releases ([#293](https://github.com/micherra/canon/issues/293)) ([8d1f1ed](https://github.com/micherra/canon/commit/8d1f1edb33d6b7cba7d23c0b66564b4f5151ea7c))


### Bug Fixes

* extend Canon quality coverage to guardrail layer + close fail-open security regression ([#278](https://github.com/micherra/canon/issues/278)) ([25d1cc8](https://github.com/micherra/canon/commit/25d1cc860ae86adbf0df36a39caacdabe22349e8))
* **hooks:** remediate ~67 silent-swallow sites + fix 2 flaky tests ([#280](https://github.com/micherra/canon/issues/280)) ([a6a653c](https://github.com/micherra/canon/commit/a6a653c3441105bd7d77958cee8a777e584a2e18))
* **mcp-boot:** durable boot via self-resolving launcher + PLUGIN_DATA deps + PID reaper ([#287](https://github.com/micherra/canon/issues/287)) ([16585e6](https://github.com/micherra/canon/commit/16585e6478d2418df67a07ce1e14f9121e08a0a2))

## 2.3.0 (2026-05-28)

37 commits since v2.2.0. Quality hardening release: shell hygiene, holistic confidence scoring, hook reliability, and continuous learner expansion.

### Highlights

- **Shell hygiene** — `jq`-based JSON extraction replaces grep/sed across all hooks; shellcheck added as a real verify gate for shell scripts (#265, #271, #270, #268)
- **Holistic confidence scoring** — shared confidence engine (`ConfidenceAnnotation`, `ConfidenceTier`) wired to `write_review`, `get_compliance`, and `get_drift_report`; review and drift adapters compose multi-signal annotations (#259)
- **Hook reliability** — SIGPIPE elimination, quoted branch args, `canon-wave/` and `canon-task/` branch prefix support in destructive-guard; PostCompact narrative capture for Canon journals (#254, #266, #268, #261, #262)
- **Learner expansion** — RRR1–RRR4 shared hook test helpers, QQQ1 hook test coverage, WWW1 root-threading convention, WWW2 observable catch blocks (#257, #255, #269)
- **DAG dispatch enforcement** — dag-dispatch-guard advisory hook + `open_artifact` MCP tool for in-flow HTML inspection (#253)

### Features

- `wiki_lint` MCP tool — lint Canon's own meta-layer artifacts for contradictions, orphan principles, stale refs, and missing examples (#267)
- Shellcheck as real verify gate for hook shell scripts — `lint-test.sh` fail-closed, shellcheck directives added to all hooks (#265)
- Holistic confidence scoring across Canon — shared `confidence.ts` engine, per-violation annotations in `write_review`, confidence tiers in `get_drift_report` and `get_compliance` (#259)
- PostCompact narrative capture — Canon journals retain compact summary across `/compact` events (#261)
- DAG dispatch guard hook + `open_artifact` MCP tool (#253)
- 5 Canon improvements inspired by mattpocock/skills: CONTEXT.md glossary, autonomous competition mode, TDD primers, `/diagnose` command, rule-compliance dimension (#251)
- Tool-loop detection and spawn timeout watchdog in hooks (#245)
- Conditional GitHub release creation step for shipper agent (#242)
- Feed-forward pitfall enrichment with cross-session error+fix index (Epic 6) (#239)
- Learner findings RRR1–RRR4: shared hook test helpers and remaining hook tests (#257)
- Learner findings QQQ1 hook test coverage and QQQ2 verify ghost state (#255)
- Learner findings WWW1 root-threading convention + WWW2 observable catch blocks (#269)

### Fixes

- Replace grep/sed JSON extraction with `jq` + context-sync hook (#271)
- Use `jq` for JSON extraction, fix quoted branch args across hooks (#270)
- Add `canon-wave/` test case and fix stale comment in hook tests (#268)
- Allow `canon-task/` branch prefix in destructive-guard regex (#266)
- Resolve `projectDir` to git repo root in mcp-server (#264)
- PostCompact reads `compact_summary` from stdin (#262)
- Address PR #257 review comments on hook tests (#260)
- Remove 3 dead workspace directories (`research/`, `handoffs/`, `decisions/`) (#258)
- Remove invalid `isolation:"none"` from Agent spawn docs (#256)
- Eliminate SIGPIPE in session-start-context hook (#254)
- Resolve 3 open drift violations in orchestration layer (#252)
- MMM1 fix-mode SUMMARY obligation and MMM3 principle scope (#250)
- Extract shared hook helpers, fix worktree-resolution across 5 hooks (#248)
- Resolve `errors-are-values` and `fail-closed-by-default` violations in canon (#247)
- Detect and remove orphaned workspaces in janitor agent (#237)

### Documentation and Chores

- Bump all-dependencies group, 6 updates (#246)
- mcp-server CLAUDE.md 61-commit context sync (#249)
- Roadmap updates — Epic 6 shipped + 14 features from PR audits (#243)
- Learner proposals LL1/LL3/LL5 (#241) and KK1/KK5/KK6/KK9 (#240)
- Remove dead stubs, dependencies, and stale tests (#236, #238)
- Clean up obsolete roadmaps, add supervised-build-quality direction (#235)

## 2.2.0 (2026-05-21)

181 commits since v2.1.1. Major release: PM identity, dark factory foundations, interactive HTML artifacts, and continuous learning.

### Highlights

- **PM orchestrator identity** — Orchestrator reframed as Product/Project Manager. Planner absorbed into architect. Trivial builds skip architect and route directly to engineer. (#206, #210)
- **Dark factory Phase 1** — Confidence-gated auto-approval and auto-escalation protocol. Autonomy tier computation (autonomous/light-touch/supervised) based on build history and blast radius signals. (#232)
- **Interactive HTML artifacts** — Structured renderer templates for design briefs, review verdicts, codebase graphs, and file context. Force-directed graph with click-to-inspect panel and filtering. Canvas-based dependency graphs in file detail cards. (#202, #230, #226, #194, #190)
- **Continuous learning system** — Three-wave rollout: signal injection + correction capture, prediction tracking, prediction accuracy + reinforcement. (#174, #183, #188)
- **Agent optimizations** — Budget-aware checkpointing with maxTurns, tool-orientation protocols for reviewer and architect, progressive disclosure for large skill payloads. (#212, #229, #214)

### Features

- PM refine skill with stress-test protocol for requirements sharpening (#210)
- Two-layer principle model — init separation, writer fork, dogfood enforcement (#224)
- Scribe length-management pass — CLAUDE.md compressed 37% (#218)
- Reviewer team dispatch protocol with blast-radius-based fan-out (#147)
- DAG-based parallel execution via native agent teams API (#140)
- `get_context` composite MCP tool — batches principles, file context, drift, graph, and signals in one call
- `batch_log_steps` MCP tool for journal efficiency
- `capture_transcript` MCP tool for agent transcript archival
- `compute_autonomy_tier` MCP tool for risk-based gate behavior
- `get_next_escalation_strategy` MCP tool for automated failure recovery
- Pre-Analysis Gate (L1) closing the orchestrator dispatch enforcement triangle (#144)
- Verification-aware acceptance criteria pipeline (#171)
- Agent layout orientation and task-identity guard hardening (#193)
- Principle overrides for per-project customization (#172, #225)
- Mandate Claude Code native primitives at HITL touchpoints (#168)
- Build digest writer in `finalizeWorkspace` (#170)
- Agent-batch-tools rule wired to all 7 context agents (#164)
- Agent-effectiveness dimension and transcript access for learner (#165)
- Context-budget-dispatch agent rule (#159)
- Requirements interview phase for planner/architect agents
- Design conversation phase for architect with think-out-loud HAS_QUESTIONS
- Coverage maps at architect and engineer handoff points
- `write_test_report` manual verification structured field (#184)
- Wave-steward native skill for multi-wave migration (#133)
- Step-transition evaluator gate for structural quality checks (#176)
- Shipper default flipped from merge to PR creation (#149)

### Fixes

- Artifact write failures across all agents (#213)
- File-detail-card Canvas graph and blast-radius-tree snippet extraction (#208)
- Review template — narrative positioning, expandable file cards, hidden empty sections (#203, #205)
- `isAbsolute` workspace validation on remaining orchestration tools (#178)
- Session.json dead code removed — migrated to orchestration.db (#201)
- Violation timestamp deduplication and finalize side-effect ordering (#207)
- Slug truncation to prevent ENAMETOOLONG on verbose task names (#189)
- Principle scope, reviewer early output, skip-reason L4 enforcement (#195)
- Community detection and tag propagation for principle matching (#152)
- Integration gap prevention — architect DAG mandate, coverage map ownership (#175)
- Review-fix iteration loop with summary correction enforcement
- Worktree cleanup removed from shipper agent (#162)
- Mandatory tail reordered — context-sync before ship (#156)
- Round limits replaced with user-driven check-in pattern
- Pre-existing/flaky test failures tracked and fixed (#143)

### Refactors

- Legacy flow engine, wave infrastructure, prompt pipeline, and consultation dead code removed (#167, #180)
- Board consolidated into journal; `verify_completion` renamed to `finalize_workspace` (#160)
- Dead `post_message`/`get_messages` MCP tools removed (#186)
- Stale researcher agent retired and merged into planner (#145, #153)
- MCP Svelte app UIs deleted — renderer snippets kept (#221)

### Documentation

- README rewritten with Claude-centric enablement framing and HTML artifact showcase (#219)
- 30+ learner findings addressed across 8 batches (ZZ, PP, YY, EEE, BBB, GGG, III, JJ series)
- Principle overrides reference documentation (#225)
- CLAUDE.md context budget maintenance (#181)
- Soak period completed (20/20 runs) with all NF items resolved

### Dependencies

- Bumped all-dependencies group with 16 updates (#196)

## 2.1.1 (2026-04-23)

Patch release — planner maxTurns fix, cold-start latency mitigation, cross-artifact validation.

## 2.1.0 (2026-04-20)

Agent teams v2 — native agent teams API, DAG execution, reviewer team dispatch.

## 2.0.1 (2026-03-31)

Patch release — ADR-002 subprocess isolation, ToolResult contract, fail-closed gates.

## 1.4.2

Knowledge graph improvements and drift tracking enhancements.
