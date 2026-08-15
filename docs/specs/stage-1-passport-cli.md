# Stage 1 SDD — Plugin Passport CLI

## Objective

Deliver a local-first `dsh-trust` CLI that turns a local directory, npm package spec, or GitHub repository into reproducible evidence about whether it is a real DSH package and which reviewable risks it contains. Inspection is static by default and never executes target code.

## Product boundary

Stage 1 owns acquisition, safe extraction, manifest validation, source scanning, direct-dependency SBOM generation, Passport serialization, human/JSON/SARIF output, and a restricted GitHub Actions workflow for opt-in dynamic import validation.

It does not claim that a plugin is safe, auto-install a plugin, maintain a public registry, modify a DSH profile, or provide host-enforced permissions.

## Supported inputs

- Existing local directory.
- npm spec in the form `npm:<name>[@version]`, resolved through the public npm registry and downloaded as a tarball without running lifecycle scripts.
- GitHub spec in the form `github:<owner>/<repo>[#ref]`, downloaded as an archive without cloning or running repository code.

Archives must be extracted into a temporary directory with path traversal, absolute path, symlink escape, file-count, per-file-size, and total-size guards.

## Passport contract

`schemas/passport.schema.json` is the normative JSON Schema. A Passport contains:

- `schemaVersion` fixed to `1.0.0`.
- Subject source, requested spec, resolved identity, package name/version, and SHA-256 content digest.
- DSH declarations: `dsh.bundle.patch`, `dsh.client`, and `dsh.profile.bundles` when present.
- Package scripts and dependency groups.
- Findings with stable rule ID, severity, category, title, evidence locations, and remediation.
- A CycloneDX 1.6 direct-dependency component list.
- Compatibility evidence, initially declaration-only plus optional dynamic-import evidence.
- Verdict `pass`, `review`, or `fail`, derived deterministically from findings.

A Passport must never contain credentials, environment values, file contents beyond bounded evidence snippets, or absolute temporary paths.

## Initial rules

- Invalid or missing package manifest.
- Invalid `dsh.bundle`, missing patch, patch path escaping package root.
- Invalid `dsh.client` shape or missing `exports["./client"]`.
- Install lifecycle scripts (`preinstall`, `install`, `postinstall`, `prepare`).
- Dynamic execution (`eval`, `new Function`, `node:vm`).
- Process execution (`child_process`, shell invocation).
- Credential/environment access.
- Network clients and unbounded hosts.
- Native binaries/addons.
- Obfuscated or oversized source.
- Dependency specs that are unpinned git branches or mutable URLs.

Rules report evidence; they do not infer malicious intent. High findings produce `review`; critical structural violations produce `fail`.

## CLI

```text
dsh-trust inspect <source> [--format human|json|sarif] [--output path]
dsh-trust schema
dsh-trust rules
dsh-trust verify-import <source> [--output path]
```

`verify-import` is an explicit execution primitive used by the restricted workflow. It is not part of static inspection and must only run in a disposable, secret-free environment. It copies the package into an isolated temporary directory, installs production dependencies with lifecycle scripts disabled, then imports the entry module. Its evidence must state that execution is not a security guarantee.

Exit codes:

- `0`: inspection completed with verdict `pass`.
- `2`: inspection completed with verdict `review`.
- `3`: inspection completed with verdict `fail`.
- `1`: operational failure before a Passport could be produced.

## Restricted dynamic verification

`.github/workflows/verify-plugin.yml` is manual-only. It has `permissions: {}`, receives no repository secrets, runs in an ephemeral Linux job, first performs static inspection, installs dependencies with lifecycle scripts disabled, and imports the resolved package entry only when the operator explicitly sets `allow_execute=true`. Its report records that this is execution evidence, not a security guarantee.

## Acceptance

```bash
pnpm install --frozen-lockfile
pnpm lint
pnpm typecheck
pnpm test
pnpm build
node dist/cli.js inspect test/fixtures/safe-bundle --format json
node dist/cli.js inspect test/fixtures/risky-bundle --format json
pnpm pack
```

Required outcomes:

- Tests demonstrate every production behavior through a prior failing test.
- Safe fixture exits 0 and validates against the schema.
- Risky lifecycle-script fixture exits 2 with stable rule IDs.
- Traversal archive and malformed DSH declarations exit 3 without writing outside the temporary root.
- Repeated inspection of identical input produces identical semantic content and digest.
- GitHub Actions run test, lint, typecheck, build, and pack with no secrets.
- Stage completion is tagged `v0.1.0` and published as a GitHub Release with the package tarball, SHA-256 file, and generated schemas.
