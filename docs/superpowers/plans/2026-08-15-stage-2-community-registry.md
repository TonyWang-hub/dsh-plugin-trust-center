# Stage 2 Community Registry Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use test-driven development task-by-task. Generated output is production behavior and must be fixture-tested before generator implementation.

**Goal:** Publish a deterministic, evidence-first DSH plugin registry and static website through GitHub Actions and Pages.

**Architecture:** Registry sources are reviewed JSON records; the Stage 1 core acquires and inspects each source independently, writing one canonical report per slug. A zero-server static generator turns reports into index JSON, accessible HTML detail pages, and SVG/Shields badges. Failed sources remain explicit records and cannot block successful ones.

**Tech Stack:** Existing Node.js/TypeScript package, Stage 1 APIs, semantic HTML/CSS, GitHub Actions, GitHub Pages.

---

### Task 1: Registry source schema

**Files:** Create `registry/sources.json`, `schemas/registry-source.schema.json`, `src/registry/model.ts`, `src/registry/load.ts`, `test/registry-load.test.ts`.

- [ ] Write failing tests for valid records, duplicate slugs, malformed source specs, mutable GitHub refs, and deterministic ordering.
- [ ] Implement `loadRegistrySources(path)` returning normalized records with no generated fields.
- [ ] Validate the seed file through the published JSON Schema.

A source record is:

```ts
interface RegistrySource {
  slug: string
  source: string
  name: string
  description?: string
  category?: string
}
```

### Task 2: Independent registry collection

**Files:** Create `src/registry/collect.ts`, `test/registry-collect.test.ts`.

- [ ] Write failing tests proving one acquisition failure does not block other sources, immutable resolution is recorded, and reports are canonical.
- [ ] Implement a concurrency-bounded collector using `inspectSource` directly, never a CLI subprocess.
- [ ] Emit explicit `verified-package`, `candidate`, or `incompatible` status without a `safe` label.

### Task 3: Badge generation

**Files:** Create `src/registry/badges.ts`, `test/badges.test.ts`.

- [ ] Write failing snapshot tests for pass/review/fail/unavailable SVG and Shields endpoint JSON.
- [ ] Implement escaped, accessible SVG with Passport digest and stable color/status mapping.
- [ ] Verify badges contain no untrusted raw markup.

### Task 4: Static site generation

**Files:** Create `src/site/generate.ts`, `src/site/templates.ts`, `site/style.css`, `site/filter.js`, `test/site.test.ts`.

- [ ] Write failing tests for index, detail pages, search/filter data, escaping, report links, evidence disclaimer, headings/landmarks, and deterministic output.
- [ ] Implement serverless HTML generation with core content available without JavaScript.
- [ ] Add progressive filtering by name, category, declaration type, verdict, severity, source, and tested DSH version.

### Task 5: Generated-output verifier

**Files:** Create `src/site/check.ts`, `test/site-check.test.ts`; add package scripts `registry:build` and `site:check`.

- [ ] Write failing tests for broken links, schema-invalid reports, absolute paths, token-shaped output, and non-deterministic rebuilds.
- [ ] Implement checks and prove two clean builds are byte-identical outside isolated build metadata.

### Task 6: Community policy

**Files:** Create `docs/rules.md`, `CODEOWNERS`, `.github/PULL_REQUEST_TEMPLATE.md`; update `CONTRIBUTING.md` and `SECURITY.md`.

- [ ] Add fixture-backed tests requiring every rule to have stable metadata plus positive and negative evidence.
- [ ] Document source submissions, correction/appeal, private disclosure, rule versioning, and non-endorsement.
- [ ] Protect schema, rule, and workflow paths through CODEOWNERS.

### Task 7: Registry, Pages, and Stage 2 release workflows

**Files:** Create `.github/workflows/registry.yml`, `.github/workflows/pages.yml`; update `test/workflow.test.ts`, `.github/workflows/release.yml`.

- [ ] Write workflow-policy tests first: untrusted PRs are read-only; scheduled collection has explicit write scope only at commit; Pages deploys a prebuilt artifact; no third-party plugin execution occurs.
- [ ] Implement scheduled/manual collection and Pages deployment.
- [ ] Add registry snapshot to release assets.

### Task 8: Stage 2 acceptance and release

- [ ] Run `pnpm lint && pnpm typecheck && pnpm test && pnpm build && pnpm registry:build && pnpm site:check` twice and compare outputs.
- [ ] Update version to `0.2.0` and changelog.
- [ ] Commit and push Stage 2, tag `v0.2.0`, verify CI/Pages, and create the GitHub Release with package, schemas, registry snapshot, and checksums.

## Self-review

- Static Pages owns no privileged backend or secret.
- Reports are reproducible evidence, not safety endorsements.
- Per-source failure containment prevents one bad repository from blocking publication.
- Rules, workflows, and schemas are governed as code with fixture evidence.
