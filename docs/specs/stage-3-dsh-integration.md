# Stage 3 SDD — DSH Bundle and Quarantine Profile Integration

## Objective

Deliver an installable DSH bundle plus explicit CLI operations for quarantined installation, profile snapshots, fail-safe disable, and rollback without modifying the official DSH payload or the existing Desktop repository.

## Product boundary

Stage 3 owns local profile inspection and mutation in `$DSH_HOME`, atomic snapshots, a quarantine workflow, rollback, and read-only DSH model tools that expose Trust Center evidence.

It does not patch `@deepseek-ai/dsh`, enforce a true plugin sandbox, expose a remote Web service, silently approve lifecycle scripts, or claim that quarantine is a security boundary.

## Profile safety model

- Every mutating operation accepts an explicit profile name.
- Profile names are validated and paths must remain under `$DSH_HOME/profiles`.
- Before mutation, relevant `package.json`, `pnpm-lock.yaml`, `pnpm-workspace.yaml`, `cordis.patch.yml`, and the Trust Center immutable-spec ledger are copied to a timestamped snapshot directory with a manifest and SHA-256 digests.
- Trust Center never disables a bundle by editing only `dsh.profile.bundles`: official reconciliation would reactivate any installed dependency that still declares `dsh.bundle`. Disable therefore delegates to `dsh plugin --profile <name> remove <package>` and retains the exact immutable install spec in the ledger for restoration.
- Trust Center-owned JSON and ledger writes use temporary files, fsync where supported, and atomic rename; official pnpm/profile mutations are wrapped by before/after snapshots.
- A failed command restores the exact snapshot and reinstalls the immutable spec when required.
- Restore refuses a snapshot whose digest, ledger, or target profile does not match.
- Mutating commands support `--dry-run` and print the exact command/files before execution.

## CLI additions

```text
dsh-trust profile list
dsh-trust profile snapshot <profile>
dsh-trust profile disable <profile> <bundle> [--dry-run]
dsh-trust profile restore <profile> <snapshot-id> [--dry-run]
dsh-trust quarantine install <source> --target <profile> [--allow-execute]
dsh-trust quarantine promote <quarantine-id> --target <profile> [--dry-run]
```

Quarantine installation:

1. Generate a Stage 1 Passport and stop on `fail`.
2. Resolve an immutable source revision.
3. Create a dedicated `trust-quarantine-<id>` profile under an isolated temporary `DSH_HOME`.
4. Install with lifecycle scripts disabled by default.
5. Run package/patch validation and `dsh --profile <name> --dump-config`.
6. Only when `--allow-execute` is explicit, run opt-in dynamic verification in an environment documented as disposable and untrusted.
7. Produce an atomic digest-bound local receipt that records the intended target profile, then remove the disposable quarantine home.
8. Promotion refuses target redirection, snapshots the target, invokes the official `dsh plugin --profile <target> add <immutable-spec>` path, validates configuration, and records the immutable spec in the target ledger; any failure removes partial installation and restores the snapshot.

## DSH bundle

The root package declares `dsh.bundle.patch` and ships `cordis.patch.yml` plus a built plugin entry. The bundle registers only read-only model tools initially:

- `trust_inspect`: inspect a local package directory or immutable public source and return bounded evidence.
- `trust_profile_status`: list installed profile bundle names and available snapshots without exposing credentials or absolute sensitive paths.

Profile mutation remains a human CLI action. A Web settings UI, automatic approval, and DSH Core permission changes are deliberately deferred because they would enlarge the trusted surface and are not required for a safe first integration.

## Real and fixture verification

- Unit tests use temporary fake `DSH_HOME` trees and injected command runners.
- Integration tests invoke a fake `dsh` executable to prove command construction and rollback.
- A restricted GitHub Actions job installs pinned official `@deepseek-ai/dsh@0.1.0-rc.6` and verifies the packed Trust Center bundle with `dsh plugin --profile trust-test add <tarball>` followed by `dsh --profile trust-test --dump-config`.
- No test changes or patches the official payload.

## Acceptance

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm build
pnpm pack
pnpm test:dsh-bundle
```

Required outcomes:

- Path traversal, invalid profile names, digest mismatch, interrupted writes, and command failure are covered by tests.
- Disable removes only the named package through the official plugin command, records its immutable spec, and is exactly reversible through that ledger plus the snapshot.
- Promotion cannot occur from a failed or mutable quarantine receipt.
- The packed artifact declares a valid `dsh.bundle`, includes built entries and patch, and composes under pinned official DSH.
- Model tools are read-only, bounded, and register/unregister with the plugin lifecycle.
- Stage completion is tagged `v0.3.0` and published as a GitHub Release containing the installable tarball, registry snapshot, schemas, and SHA-256 file.
