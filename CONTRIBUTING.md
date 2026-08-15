# Contributing

Contributions are welcome through pull requests. Every behavioral change must begin with a failing fixture-backed test, then include the minimal implementation that makes it pass.

## Registry submissions

Add one factual record to `registry/sources.json`. A slug must be unique and stable. npm sources must use an exact published version; GitHub sources must use a full 40-character commit SHA. Descriptions must not claim that a package is safe, trusted, official, popular, or endorsed.

Generated reports, badges, and `public/` content are build products; do not edit them manually. A source that cannot be inspected remains an explicit unavailable record rather than being silently omitted.

## Inspection rules

Security rules must have a stable ID, bounded evidence, a positive fixture, a negative fixture, and wording that reports observable behavior rather than intent. See `docs/rules.md` for severity, change, correction, and appeal policy.

## Security boundaries

Do not add workflows that expose repository secrets to untrusted code. Dynamic package import is manual-only and must remain in an ephemeral least-privilege runner. Scheduled registry collection is static-only and must never import target modules or run their package-manager scripts.

## Required checks

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm build
pnpm registry:build
pnpm site:check
```
