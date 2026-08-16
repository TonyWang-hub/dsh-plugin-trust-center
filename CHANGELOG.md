# Changelog

All notable changes are documented in this file.

## [Unreleased]

## [0.3.2] - 2026-08-16

### Added

- Reproducible `pnpm dogfood` orchestration for pinned official DSH bundle acceptance, immutable community-plugin static inspection, script-disabled quarantine installation, promotion dry-run, and focused safety regressions.
- Manual-only, read-only, secret-free Constrained Dogfood workflow with bounded evidence artifacts and no community-plugin dynamic execution.
- Public npm distribution using the exact checksummed GitHub Release tarball, a protected manual environment, bounded bootstrap credentials, and GitHub Actions provenance.

## [0.3.1] - 2026-08-16

### Fixed

- Timed-out DSH commands now terminate their full POSIX process group so package-manager descendants cannot continue mutating a profile after rollback.
- Ledger appends use a bounded cross-process lock, preventing concurrent writers from losing entries or reusing versions.
- Mutation, restore, and promotion failures preserve the original error while reporting incomplete rollback work.
- Profile restore protects its target snapshot when the 100-entry ring is full; failed quarantine installs remove newly created empty receipt directories.
- Corrupt profile manifests no longer fail the complete read-only profile-status response, and promotion rollback checks official remove failures.

### Verification

- Dogfooding covered the pinned community Sentinel revision with static inspection, script-disabled isolated installation, and promotion dry-run without dynamic code execution.
- Packed-bundle acceptance remains pinned to official `@deepseek-ai/dsh@0.1.0-rc.6`.

## [0.3.0] - 2026-08-16

### Added

- Installable external DSH bundle with valid Cordis patch metadata and bounded `trust_inspect` / `trust_profile_status` read-only tools.
- Quarantine installation and target-bound promotion with immutable-source re-inspection, lifecycle scripts disabled by default, atomic digest-bound receipts, and explicit dynamic-execution gating.
- Contained profile paths, atomic Trust Center writes, immutable-spec ledgers, SHA-256 snapshot manifests, retention, verified restore, and injected official command execution.
- Transactional official profile disable, re-enable, restore, dry-run plans, configuration validation, and failed-command rollback.
- Pinned `@deepseek-ai/dsh@0.1.0-rc.6` packed-bundle acceptance in local, CI, and tagged-release gates.

### Security

- Promotion rejects internally inconsistent receipts even when their digest is recomputed, pins the intended profile, and records the promoted immutable spec.
- DSH executable overrides must be absolute, target profile environments cannot override the selected `DSH_HOME`, and model tools never expose mutation operations.
- Profile/snapshot symlink escapes, mutable ledger specs, and zero-retention rollback deletion are rejected before mutation.

## [0.2.0] - 2026-08-16

### Added

- Immutable community registry source and report schemas with independent bounded collection and deterministic provider maintenance coordinates.
- Deterministic report, SVG badge, Shields endpoint, index, and accessible detail-page generation.
- Search and progressive filters for declarations, verdicts, severity, source kind, categories, and tested DSH versions.
- Scheduled static-only registry refresh and GitHub Pages deployment through a generated-data branch.
- CODEOWNERS, contribution policy, private reporting guidance, and stable rule governance.
- Checksummed registry snapshot assets in tagged GitHub Releases.

### Changed

- Network downloads now stop as soon as compressed archive limits are exceeded.
- npm SRI verification supports SHA-512, SHA-384, SHA-256, and SHA-1 and rejects unsupported supplied integrity metadata.
- SARIF reports derive their tool version from the package release metadata.

## [0.1.0] - 2026-08-15

### Added

- Static-by-default Plugin Passport inspection for local, npm, and GitHub sources.
- Deterministic manifest, source-capability, lifecycle, dependency, and Cordis patch findings.
- CycloneDX 1.6 direct-dependency SBOM and published Passport JSON Schema.
- Human, canonical JSON, and SARIF 2.1.0 renderers with verdict exit codes.
- Manual-only, secret-free dynamic import verification workflow.
- Least-privilege CI and checksummed GitHub Release automation.

[Unreleased]: https://github.com/TonyWang-hub/dsh-plugin-trust-center/compare/v0.3.2...HEAD
[0.3.2]: https://github.com/TonyWang-hub/dsh-plugin-trust-center/releases/tag/v0.3.2
[0.3.1]: https://github.com/TonyWang-hub/dsh-plugin-trust-center/releases/tag/v0.3.1
[0.3.0]: https://github.com/TonyWang-hub/dsh-plugin-trust-center/releases/tag/v0.3.0
[0.2.0]: https://github.com/TonyWang-hub/dsh-plugin-trust-center/releases/tag/v0.2.0
[0.1.0]: https://github.com/TonyWang-hub/dsh-plugin-trust-center/releases/tag/v0.1.0
