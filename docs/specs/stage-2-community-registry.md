# Stage 2 SDD — Community Registry and Evidence Site

## Objective

Build a GitHub-native community registry that publishes reproducible Plugin Passports, searchable static pages, and compatibility/security evidence without operating a privileged server.

## Product boundary

Stage 2 owns registry source declarations, scheduled/manual GitHub Actions collection, Passport generation, static site generation, badge artifacts, contribution validation, and transparent rule governance.

It does not become an official DSH registry, guarantee safety, accept arbitrary server-side code execution, hold user credentials, or automatically install plugins.

## Registry source contract

`registry/sources.json` contains explicit plugin candidates with stable slug, source spec, optional display metadata, and evidence policy. Generated content is never edited manually.

Each generated record contains:

- Source and immutable resolved revision.
- Latest Passport and digest.
- Historical report references retained by release or commit.
- Evidence status and tested DSH versions.
- Maintenance metadata derived from GitHub/npm without subjective ranking.

The registry distinguishes `verified-package`, `candidate`, and `incompatible`; it does not label packages `safe`.

## Build pipeline

1. Validate source declarations and reject duplicate slugs or mutable records without a resolved revision.
2. Acquire and inspect each source with Stage 1 core APIs.
3. Write canonical JSON reports under `public/reports/<slug>.json`.
4. Write static SVG and Shields endpoint badges under `public/badges/`.
5. Generate `public/index.json`, HTML index, category/filter views, and per-plugin evidence pages.
6. Verify that generated output contains no absolute paths, tokens, environment values, or non-deterministic ordering.

A failed plugin scan becomes an explicit failed record and does not prevent unrelated records from publishing.

## GitHub automation

- `ci.yml`: tests every pull request with least-privilege read access.
- `registry.yml`: scheduled and manual registry refresh, with `contents: write` only for the generated-data branch or commit step and no third-party code execution.
- `pages.yml`: deploys the already-generated static artifact through GitHub Pages.
- `release.yml`: creates the Stage 2 package and registry snapshot release assets.

Untrusted pull requests never receive write tokens or trigger dynamic verification.

## Community governance

- `CONTRIBUTING.md` documents source submissions and evidence requirements.
- `SECURITY.md` defines private vulnerability reporting and report correction.
- `docs/rules.md` documents stable rule IDs, severity semantics, false-positive handling, and review changes.
- `CODEOWNERS` protects schemas, workflows, and rules.
- Changes to a rule require fixture evidence and tests.

## Static site

The site is accessible without JavaScript for core content and provides progressive client-side filtering. It exposes:

- Plugin search by name and description.
- Filters for DSH declaration type, verdict, finding severity, source, and tested version.
- Evidence detail, digest, immutable source link, and report download.
- Clear disclaimers that reports are automated evidence, not endorsements.

## Acceptance

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm build
pnpm registry:build
pnpm site:check
```

Required outcomes:

- Registry schema rejects duplicates and malformed source specs.
- One failed source does not block successful records.
- Identical inputs produce byte-identical generated reports/site artifacts except an explicitly isolated build metadata file.
- Badge status matches Passport verdict and digest.
- Site links, report schema validation, HTML accessibility smoke checks, and secret/path scans pass.
- Pages workflow deploys the generated artifact from the public repository.
- Stage completion is tagged `v0.2.0` and published as a GitHub Release containing CLI tarball, registry snapshot, SHA-256 file, and schemas.
