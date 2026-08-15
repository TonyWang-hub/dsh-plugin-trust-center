# Stage 1 Plugin Passport CLI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use test-driven development task-by-task. Every production behavior must be preceded by a focused failing test and its observed RED result.

**Goal:** Build and release a static-by-default `dsh-trust` CLI that emits reproducible Plugin Passports for local, npm, and GitHub DSH package sources.

**Architecture:** A small TypeScript ESM package separates acquisition, bounded package walking, DSH manifest inspection, rule evaluation, SBOM generation, Passport assembly, and output adapters. Network sources are downloaded as archives and safely extracted to temporary directories; target code never executes in the default path. The CLI is a thin adapter over core APIs so Stage 2 can reuse them directly.

**Tech Stack:** Node.js 24, TypeScript, pnpm, Vitest, Commander, Ajv, tar, YAML, ESLint, GitHub Actions.

---

## File map

- `src/model.ts`: Passport, finding, source, and verdict types.
- `src/acquire.ts`: local/npm/GitHub source parsing, archive download, bounded extraction, cleanup.
- `src/walk.ts`: bounded deterministic package file inventory and source text loading.
- `src/manifest.ts`: package.json and DSH declaration validation.
- `src/rules.ts`: stable static rule definitions and source/script/dependency findings.
- `src/sbom.ts`: CycloneDX 1.6 direct-dependency document.
- `src/passport.ts`: orchestration, digest, verdict, canonical output.
- `src/render.ts`: human, JSON, and SARIF renderers.
- `src/index.ts`: reusable public API.
- `src/cli.ts`: argument parsing, output writing, and exit codes.
- `schemas/passport.schema.json`: normative Passport JSON Schema.
- `test/fixtures/*`: safe, risky, malformed, and traversal fixtures.
- `test/*.test.ts`: unit and integration tests.
- `.github/workflows/ci.yml`: least-privilege build/test/package workflow.
- `.github/workflows/verify-plugin.yml`: manual restricted dynamic-import workflow.

### Task 1: Repository and test harness

**Files:** Create `package.json`, `pnpm-workspace.yaml`, `tsconfig.json`, `eslint.config.js`, `vitest.config.ts`, `.gitignore`, `LICENSE`, `README.md`, `test/fixtures/safe-bundle/*`, `test/smoke.test.ts`.

- [ ] Create package metadata with Node `>=24.17 <25`, ESM, `dsh-trust` bin, build/lint/typecheck/test/pack scripts, Apache-2.0 license, and exact dependencies.
- [ ] Create a smoke test that imports `inspectSource` from `src/index.ts` and therefore fails because the module does not exist:

```ts
import { describe, expect, it } from 'vitest'
import { inspectSource } from '../src/index.js'

describe('inspectSource', () => {
  it('returns a pass passport for a minimal local DSH bundle', async () => {
    const passport = await inspectSource('test/fixtures/safe-bundle')
    expect(passport.verdict.status).toBe('pass')
    expect(passport.dsh.bundle?.patch).toBe('cordis.patch.yml')
  })
})
```

- [ ] Run `pnpm test` and record the expected missing-module RED result.
- [ ] Add only enough `src/index.ts` and supporting files for the fixture to pass.
- [ ] Run `pnpm test`, `pnpm typecheck`, and commit repository scaffolding plus the first green path.

### Task 2: Manifest and DSH declaration validation

**Files:** Create `src/model.ts`, `src/manifest.ts`, `test/manifest.test.ts`, fixtures `invalid-bundle` and `invalid-client`.

- [ ] Write failing tests for missing package.json, escaping `dsh.bundle.patch`, malformed `dsh.client`, and missing `exports["./client"]`.
- [ ] Run `pnpm vitest run test/manifest.test.ts` and verify each fails for the missing validator.
- [ ] Implement `inspectManifest(root: string): Promise<ManifestEvidence>` with normalized relative paths and structural findings.
- [ ] Verify focused tests and full suite pass.

The public shape is:

```ts
export interface ManifestEvidence {
  packageName?: string
  packageVersion?: string
  license?: string
  scripts: Record<string, string>
  dependencies: Record<'runtime' | 'dev' | 'optional' | 'peer', Record<string, string>>
  dsh: {
    bundle?: { patch: string; exists: boolean }
    client?: { platform: string; inject?: string[]; immediately?: boolean; exportExists: boolean }
    profile?: { bundles: string[] }
  }
  findings: Finding[]
}
```

### Task 3: Bounded deterministic walking and source rules

**Files:** Create `src/walk.ts`, `src/rules.ts`, `test/walk.test.ts`, `test/rules.test.ts`, risky fixtures.

- [ ] Write failing tests proving deterministic ordering, ignored VCS/dependency directories, per-file/total/file-count limits, and no symlink traversal.
- [ ] Implement `walkPackage(root, limits)` and verify RED→GREEN.
- [ ] Write one failing test per stable rule family: lifecycle scripts, process execution, dynamic execution, environment/credential access, network access, native binaries, mutable dependency URLs, and oversized/obfuscated source.
- [ ] Implement data-driven rules returning bounded evidence snippets and stable IDs such as `DSH-SCRIPT-001` and `DSH-CODE-003`.
- [ ] Verify all rules produce `review`, not unsupported maliciousness claims.

### Task 4: Safe acquisition

**Files:** Create `src/acquire.ts`, `test/acquire.test.ts`, archive fixtures.

- [ ] Write failing tests for local sources, npm/GitHub spec parsing, archive traversal, absolute paths, symlink escape, file count, and cleanup.
- [ ] Implement `parseSourceSpec`, npm metadata/tarball resolution, GitHub archive resolution, SHA-256 verification when registry integrity is available, and safe extraction through the same limits as walking.
- [ ] Inject `fetch` and temporary directory creation for deterministic tests; never execute package managers or scripts.
- [ ] Verify focused and full suites.

### Task 5: Passport, SBOM, schema, and deterministic digest

**Files:** Create `src/sbom.ts`, `src/passport.ts`, `schemas/passport.schema.json`, `test/passport.test.ts`, `test/schema.test.ts`.

- [ ] Write failing tests for CycloneDX 1.6 direct components, deterministic ordering, stable digest, verdict derivation, and schema validation.
- [ ] Implement canonical JSON serialization that recursively sorts object keys and excludes build timestamps from the subject digest.
- [ ] Implement `buildSbom`, `deriveVerdict`, and `inspectSource` orchestration.
- [ ] Validate every fixture Passport through Ajv and verify repeated runs are semantically identical.

### Task 6: CLI and output adapters

**Files:** Create `src/render.ts`, `src/cli.ts`, `test/render.test.ts`, `test/cli.test.ts`.

- [ ] Write failing tests for `inspect`, `schema`, `rules`, human/JSON/SARIF output, bounded errors, output-file writes, and exit codes 0/1/2/3.
- [ ] Implement renderers and a dependency-injected `runCli(argv, io)`; keep the executable wrapper minimal.
- [ ] Add a shebang to the built CLI and verify `node dist/cli.js` plus the package bin after `pnpm pack`.

### Task 7: Restricted workflows and documentation

**Files:** Create `.github/workflows/ci.yml`, `.github/workflows/verify-plugin.yml`, `SECURITY.md`, `CONTRIBUTING.md`; update `README.md`.

- [ ] Add tests that parse workflow YAML and assert explicit permissions, no secret references, manual-only execution workflow, and `allow_execute` gating.
- [ ] Implement CI and manual verifier workflows only after the tests fail.
- [ ] Document threat model, evidence semantics, installation, commands, and limitations.
- [ ] Run `pnpm lint && pnpm typecheck && pnpm test && pnpm build && pnpm pack`.

### Task 8: Stage 1 release

**Files:** Update `CHANGELOG.md`, `package.json`; generated release assets under `release/` are not committed.

- [ ] Verify clean checkout acceptance and inspect safe/risky fixtures with expected exit codes.
- [ ] Pack `dsh-plugin-trust-center-0.1.0.tgz`, generate SHA-256, copy schemas, and inspect the packed file list.
- [ ] Commit Stage 1 with actual acceptance evidence in the commit message, push `main`, tag `v0.1.0`, and create the GitHub Release with tarball/checksum/schema assets.
- [ ] Verify the public repository, tag, Release assets, and CI status through GitHub API.

## Self-review

- The plan covers every Stage 1 specification requirement.
- No production behavior is scheduled before its failing test.
- Core APIs are reusable by Stage 2 and Stage 3 without CLI subprocess coupling.
- Network acquisition never executes target code.
- Dynamic import remains manual, secret-free, and explicitly non-authoritative.
