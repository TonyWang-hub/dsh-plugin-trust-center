# Stage 3 DSH Bundle and Quarantine Integration Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use test-driven development task-by-task. Profile mutation tests use temporary homes and injected runners before any real DSH integration is attempted.

**Goal:** Ship an installable DSH bundle and reversible quarantine/profile-management CLI without modifying official DSH or the existing Desktop application.

**Architecture:** A profile module validates all paths under `$DSH_HOME`, records immutable install specs in a Trust Center ledger, snapshots profile control files, and wraps official `dsh plugin` commands in rollback transactions. Quarantine inspection and config-dump evidence precede promotion. The DSH bundle registers only bounded read-only tools; mutation stays an explicit human CLI operation.

**Tech Stack:** Existing Node.js/TypeScript package, pinned `@deepseek-ai/dsh`, Cordis bundle patch, `@deepseek-ai/dsh-tools`, GitHub Actions.

---

### Task 1: Profile paths, ledger, and atomic files

**Files:** Create `src/profile/paths.ts`, `src/profile/ledger.ts`, `src/profile/atomic.ts`, related tests.

- [ ] Write failing tests for invalid profile names, traversal, DSH_HOME override, 0600 ledger mode, interrupted temporary writes, and atomic rename.
- [ ] Implement validated paths and versioned ledger entries containing package name, immutable spec, Passport digest, install time, and target profile.

### Task 2: Snapshot and restore primitives

**Files:** Create `src/profile/snapshot.ts`, `test/profile-snapshot.test.ts`.

- [ ] Write failing tests for package/lock/workspace/patch/ledger capture, SHA-256 manifests, ring retention, digest mismatch, and exact restoration.
- [ ] Implement snapshots without copying `node_modules` or credentials.
- [ ] Refuse cross-profile or tampered snapshots.

### Task 3: Official command transaction wrapper

**Files:** Create `src/profile/runner.ts`, `src/profile/transaction.ts`, `test/profile-transaction.test.ts`, fake dsh fixture.

- [ ] Write failing tests for exact `dsh plugin --profile` argument construction, PATH injection, clean stdout/stderr capture, timeout, failure rollback, and dry-run.
- [ ] Implement an injected process runner and transaction wrapper.
- [ ] Validate configuration with `dsh --profile <name> --dump-config`; use default-only dump only when user layers must be intentionally excluded.

### Task 4: Disable and restore

**Files:** Create `src/profile/disable.ts`, extend CLI and tests.

- [ ] Write failing tests proving disable calls official `remove`, affects only the named package, preserves its immutable spec in the ledger/snapshot, and reactivation restores the exact spec.
- [ ] Implement rollback on any nonzero official command or failed config dump.
- [ ] Never edit only `dsh.profile.bundles`, because official reconciliation would reactivate an installed bundle dependency.

### Task 5: Quarantine install and promotion

**Files:** Create `src/quarantine.ts`, `test/quarantine.test.ts`, extend CLI.

- [ ] Write failing tests for fail verdict refusal, immutable source resolution, isolated temporary DSH_HOME, lifecycle scripts disabled by default, receipt digest, explicit execution gate, target snapshot, and failed-promotion rollback.
- [ ] Implement inspect → isolate → official add → config dump → receipt.
- [ ] Implement promotion only from a valid receipt whose source revision and Passport digest still match.

### Task 6: External DSH bundle

**Files:** Create `src/plugin.ts`, `cordis.patch.yml`, plugin tests; update `package.json` exports/files/dsh manifest.

- [ ] Write failing tests for valid `dsh.bundle.patch`, packed artifact contents, and plugin lifecycle registration/disposal.
- [ ] Implement read-only `trust_inspect` and `trust_profile_status` tools with bounded output.
- [ ] Keep install, disable, restore, and promotion out of model-callable tools.
- [ ] Do not add a custom React client/settings UI in this stage.

### Task 7: Real DSH bundle acceptance

**Files:** Create `test/dsh-bundle.acceptance.test.ts`, script `test:dsh-bundle`, restricted workflow step.

- [ ] Pack the repository into a tarball.
- [ ] Install pinned official DSH in a disposable environment.
- [ ] Run `dsh plugin --profile trust-test add <tarball>` and `dsh --profile trust-test --dump-config`.
- [ ] Assert expected Trust Center row, zero stderr, no official payload modification, and clean disposal.

### Task 8: Stage 3 release

- [ ] Run full Stage 1/2/3 acceptance plus packed DSH bundle acceptance.
- [ ] Update version to `0.3.0`, schemas, README, and changelog.
- [ ] Commit and push Stage 3, tag `v0.3.0`, and verify the GitHub Release assets and Actions.

## Self-review

- Official DSH remains pinned and unmodified.
- Disable uses official package removal plus an immutable-spec ledger.
- Every mutation has a prior snapshot, dry-run, bounded command, and rollback.
- Model tools are read-only; high-risk UI and Core changes are deferred.
