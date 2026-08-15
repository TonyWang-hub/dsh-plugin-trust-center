# Changelog

All notable changes are documented in this file.

## [Unreleased]

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

[Unreleased]: https://github.com/TonyWang-hub/dsh-plugin-trust-center/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/TonyWang-hub/dsh-plugin-trust-center/releases/tag/v0.2.0
[0.1.0]: https://github.com/TonyWang-hub/dsh-plugin-trust-center/releases/tag/v0.1.0
