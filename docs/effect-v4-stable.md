# Effect 4 stable migration record

Candidate branch: `chore/effect-v4-stable`, baseline `8301b21d62ceab610731471e596b8296721134c5`.
The exact candidate commit is returned with the local delivery receipt.

## Human authorization

- Original task authority requires one serial migration node against `develop`, preservation of unrelated work and public CLI, API, persistence, transport and cleanup behavior, the specified commit identity, no comments, and local feature work without protected push or PR by this worker.

## Delegated decisions

- The accepted implementation pins Effect, platform, SQL and Vitest packages to `4.0.0`, Vitest and both coverage adapters to `5.0.3`, and retains Node `24.17.0`, npm `11.12.1`, Vite `7.3.6`, TypeScript `6.0.3` and language-service `0.86.6`.
- The accepted delegated audit delta permits Electron `42.6.1→42.10.0` and same-major patch/minor transitive fixes, with no broad refresh or major application change.
- Stable public Effect APIs replace beta imports. Detached protected HTTP-scope close preserves the existing one-second grace while stable uninterruptible finalizers finish. Deferred polling, timeout-based test masking, forced completion and test-budget changes were rejected.
- Envelope JSON Schema generation uses `Schema.toEncoded` followed by `SchemaRepresentation.toJsonSchemaDocument(..., { onExcessProperty: "error" })`. Stable `isPattern` omits this unflagged regex by default; the focused Project RED/GREEN evidence in `schema-pattern-callback-evidence-v2.log` shows the supported exact `toJsonSchema` annotation is required to preserve the name/tag constraint. The exact final five-envelope route comparison in `schema-toencoded-equivalence.log` matched baseline semantic hashes; only inlining, flattened checks and combined non-finite enum layout changed. The superseded simplified probe covered a different Error schema and is not used as the all-five proof.
- `Schema.fromJsonString(Schema.Unknown)` and its typed `PackMetadata` form are the supported JSON codecs. The raw engine adapter and public `packages/contracts/json.ts` were rejected because the former bypassed the active diagnostic policy and the latter expanded the wildcard export. Stable `SchemaError(Expected a valid JSON string)` is asserted at the private package-certification formatter boundary; rejection and failure propagation remain unchanged, with no frozen CLI error change.

## Dependency and audit record

The 19 audit-only lock changes are enumerated in `/home/gimhoff/.local/state/expskill/runs/effect4-stable-0c4f4fc366e98b61b9a6bd17579dc3d2/version-map-diff-after-audit-full.json`. Resolved changes were xmldom `0.8.14→0.8.15`; brace-expansion `1.1.18→1.1.21`, `2.1.4→2.1.7`, `5.0.9→5.0.12`; browserslist `4.28.6→4.29.3`; fast-uri `3.1.5→3.1.8`; js-yaml `4.3.1→4.3.2`; smol-toml `1.7.0→1.9.0`; undici `6.28.0→6.29.0` and `7.29.0→7.30.0`; and Electron `42.6.1→42.10.0`.

The selected browserslist range requires its compatible `baseline-browser-mapping 2.10.43→2.11.26`, `caniuse-lite 1.0.30001805→1.0.30001814`, `electron-to-chromium 1.5.389→1.5.443`, `node-releases 2.0.51→2.0.57` and `update-browserslist-db 1.2.3→1.3.3` companions. Before-fix advisories are complete in `audit-full-before-advisory-inventory.json`; the after audit is 0 high/0 moderate/1 low (`esbuild` `GHSA-g7r4-m6w7-qqqr`). Npm offered only the prohibited major/force esbuild `0.28.2` fix. Full before/after hashes and node inventory are in `audit-full-before-advisory-inventory.json` and `audit-after-advisory-inventory.json`.

## Checks and retained risks

- Correction (2026-10-01): Restored the accepted five-second timeout around the three socket-open readiness waits; other budgets and runtime behavior remain unchanged.
- RED: `reconnect-removed-diagnostics-red.log`, `red-lockstep-clean.log` and `envelope-schema-toencoded-red.log` record meaningful pre-fix failures. Green focused logs cover CLI 78, client 78, server 33 and architecture 57 tests; `envelope-schema-toencoded-green.log` covers the repaired snapshot.
- The first full run found the expected fold-version staleness after the schema source change; `gen-fold-version-final.log` regenerated only the `projects` hash, and `fold-version-final.log` passed 5/5. One concurrent full attempt hit a live binary-smoke timeout; the isolated binary suite passed 68/68, and `full-production-test-final-rerun2.log` is clean: 152 files passed, 1,142 tests passed and the repository's one intentional expected failure. Lint, typecheck, knip, package certification and publication certification logs are in the same external run directory.
- Clean npm ci, representative V8/Istanbul coverage, compiled/package artifacts, desktop build/E2E, active stable-specific language-service proof, hosted CI and exact-head delivery remain parent-owned pending checks. The retained low esbuild advisory and these unrun delivery checks are explicit risks.

## Provenance

Provider conversation: `01a0f771-0173-7e31-9fee-03a9b5be4e1b`. Workflow `0c4f4fc366e98b61b9a6bd17579dc3d2`; accepted plan `/home/gimhoff/.local/state/expskill/runs/effect4-stable-0c4f4fc366e98b61b9a6bd17579dc3d2/accepted-plan-revision-2.yaml`. Recovered graph `6e2fe5b6a3a459bab5ffb51c638bb5c8` revision 2 uses `/home/gimhoff/.local/state/expskill/recovery/effect4-audit-delta-0c4f4fc366e98b61b9a6bd17579dc3d2/accepted-rebuilt-graph-revision-2.json`, `recovery-record.json` and `rebuild-receipt.json`; delivery locators are `/home/gimhoff/.local/state/expskill/runs/effect4-stable-0c4f4fc366e98b61b9a6bd17579dc3d2/delivery-recovery-record-locators.json`; original recovery/rebuild provenance remains `/home/gimhoff/.local/state/expskill/recovery/effect4-plan-d8a94a61691de78d5fcf4ef470f09fdc/`.

Primary references: [Effect 4 release](https://github.com/Effect-TS/effect/releases/tag/effect%404.0.0), [Effect release post](https://effect.website/blog/releases/effect/40), [effect@4.0.0 npm](https://www.npmjs.com/package/effect/v/4.0.0), [@effect/vitest@4.0.0 npm](https://www.npmjs.com/package/@effect/vitest/v/4.0.0), [vitest@5.0.3 npm](https://www.npmjs.com/package/vitest/v/5.0.3) and [electron@42.10.0 npm](https://www.npmjs.com/package/electron/v/42.10.0).
