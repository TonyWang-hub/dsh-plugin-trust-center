# DSH Plugin Trust Center

Evidence-first inspection, compatibility verification, and quarantine tooling for [DeepSeek Harness](https://github.com/deepseek-ai/DeepSeek-Harness) plugins.

> **Important:** a `pass` Passport means that the declared package structure passed this version's bounded checks. It is not a certification that third-party code is safe.

## Stage 1: Plugin Passport CLI

Stage 1 performs deterministic, static-by-default inspection of:

- a local directory, such as `./my-plugin`;
- an npm package, such as `npm:@scope/plugin@1.2.3`;
- a GitHub repository, such as `github:owner/repo#v1.2.3`.

Network sources are resolved before inspection: npm metadata records an exact published version and GitHub refs resolve to a 40-character commit SHA. Archive extraction rejects traversal, links, oversized downloads, oversized files, excessive entries, and excessive expanded size.

### Run from a GitHub Release

Download the `.tgz` and `SHA256SUMS.txt` assets from the matching [GitHub Release](https://github.com/TonyWang-hub/dsh-plugin-trust-center/releases), verify the checksum, then run:

```bash
npm exec --package ./dsh-plugin-trust-center-0.3.0.tgz -- dsh-trust inspect ./my-plugin
```

### Run from source

Node.js 24.17.x and pnpm 11.21.0 are required.

```bash
corepack enable
pnpm install --frozen-lockfile
pnpm build
node dist/cli.js inspect ./test/fixtures/safe-bundle
```

### Commands

```text
dsh-trust inspect <source> [--format human|json|sarif] [--output path]
dsh-trust schema
dsh-trust rules
dsh-trust verify-import <source> [--output path]
dsh-trust quarantine install <source> --target <profile> [--allow-execute]
dsh-trust quarantine promote <quarantine-id> --target <profile> [--dry-run]
dsh-trust profile list
dsh-trust profile snapshot <profile>
dsh-trust profile disable <profile> <bundle> [--dry-run]
dsh-trust profile restore <profile> <snapshot-id> [--dry-run]
```

`inspect` never imports target modules or runs package-manager lifecycle scripts. It emits:

- `human`: a bounded terminal summary;
- `json`: a canonical [Plugin Passport](schemas/passport.schema.json);
- `sarif`: SARIF 2.1.0 suitable for code-scanning tools.

Exit codes are `0` for `pass`, `2` for `review`, `3` for `fail`, and `1` for an operational error.

`verify-import` is deliberately separate: it **executes the target entry module** and must only be used after explicit approval in a disposable, secret-free environment. It copies the package to a temporary directory and installs production dependencies with lifecycle scripts disabled before import. The repository includes a manual-only restricted GitHub Actions workflow that pins execution to the exact source revision inspected.

### Library API

```ts
import { inspectSource, renderJson } from 'dsh-plugin-trust-center'

const passport = await inspectSource('github:owner/repo#v1.2.3')
process.stdout.write(renderJson(passport))
```

The Passport includes normalized DSH declarations, install scripts, direct dependency evidence, stable findings, a deterministic package digest, and a CycloneDX 1.6 direct-dependency SBOM. Published evidence omits temporary absolute paths and timestamps.

## Stage 2: Community Registry

The [public evidence site](https://tonywang-hub.github.io/dsh-plugin-trust-center/) is generated from immutable declarations in [`registry/sources.json`](registry/sources.json). It provides searchable no-JavaScript-compatible plugin pages, canonical JSON reports, SVG badges, Shields endpoint JSON, immutable source links, tested DSH versions, and finding evidence.

Each generated record includes deterministic maintenance coordinates (`provider`, namespace, project, and immutable revision) derived from its reviewed GitHub/npm source. Mutable popularity scores and subjective rankings are intentionally excluded so repeated builds remain reproducible.

Registry labels deliberately avoid the word “safe”:

- `verified-package`: static inspection produced a `pass` Passport;
- `candidate`: static inspection produced a `review` Passport;
- `incompatible`: static inspection produced a `fail` Passport;
- `unavailable`: acquisition or inspection could not produce a Passport.

Build and verify a byte-stable snapshot locally:

```bash
pnpm registry:build
pnpm site:check
```

Scheduled/manual GitHub Actions publish generated content to the `registry-data` branch and deploy that branch through GitHub Pages. Collection never imports target modules or runs their lifecycle scripts. Submission and rule-governance requirements are documented in [`CONTRIBUTING.md`](CONTRIBUTING.md) and [`docs/rules.md`](docs/rules.md).

## Stage 3: DSH bundle, quarantine, and profile recovery

The `v0.3.0` release tarball is also an external DSH bundle. After verifying its release checksum, add it through the official CLI and validate the composed configuration:

```bash
export DSH_PATH="$(command -v dsh)" # must resolve to an absolute official DSH executable
dsh plugin --profile work add "$(pwd)/dsh-plugin-trust-center-0.3.0.tgz"
dsh --profile work --dump-config
```

The bundle patch registers only two bounded, read-only model tools: `trust_inspect` and `trust_profile_status`. Local model-driven inspection is denied unless the plugin configuration explicitly lists an allowed local root. Profile mutation is never exposed as a model tool.

Quarantine is an evidence workflow, not a host sandbox:

```bash
dsh-trust quarantine install npm:example-plugin@1.2.3 --target work
dsh-trust quarantine promote <quarantine-id> --target work --dry-run
dsh-trust quarantine promote <quarantine-id> --target work
```

Installation first creates a static Passport and refuses `fail` verdicts or mutable/local resolved sources. It then uses a dedicated `trust-quarantine-<id>` profile in an isolated temporary `DSH_HOME`, disables npm/pnpm lifecycle scripts, runs `--dump-config`, writes an atomic digest-bound receipt below `$DSH_HOME/quarantine`, and removes the disposable install tree. `--allow-execute` is the only path that imports target code and should be used only in a disposable, credential-free environment. Promotion re-inspects the immutable source, verifies the receipt and Passport digest, snapshots the target, calls official `dsh plugin add`, validates with `--dump-config`, and records the immutable install spec in the target profile ledger. A target named in the receipt cannot be changed during promotion.

Profile operations are explicit and snapshot-backed:

```bash
dsh-trust profile list
dsh-trust profile snapshot work
dsh-trust profile disable work example-plugin --dry-run
dsh-trust profile disable work example-plugin
dsh-trust profile restore work <snapshot-id> --dry-run
dsh-trust profile restore work <snapshot-id>
```

Snapshots live below `$DSH_HOME/snapshots/<profile>`, contain only bounded profile control files plus the Trust Center ledger, and carry per-file SHA-256 digests. Disable works only when an immutable ledger record exists, invokes official `dsh plugin remove`, and restores/reinstalls on failure. Restore verifies snapshot identity and digests, reinstalls ledger-pinned bundles through official commands, and rolls back partial restoration. Trust Center never disables a bundle by editing only `dsh.profile.bundles`.

## Verdict model

- `fail`: at least one critical structural finding, including an invalid manifest, escaping/missing/invalid Cordis patch, invalid client/profile declaration, no DSH declaration, or an incomplete scan caused by limits or links;
- `review`: no critical findings and at least one high-severity observable capability, such as lifecycle scripts, process execution, environment access, network access, native artifacts, suspicious source shape, or mutable dependency specs;
- `pass`: no findings in the current rule set.

Use `dsh-trust rules` for machine-readable rule metadata. Rule findings report observable evidence, not author intent.

## Delivery stages

1. **Plugin Passport CLI** — implemented in `v0.1.0`.
2. **Community Registry** — implemented in `v0.2.0` with GitHub Actions, Pages reports, badges, and contribution rules.
3. **DSH integration** — implemented in `v0.3.0` with the external bundle, quarantine receipts/promotion, transactional snapshots, official disable/restore commands, and rollback.

Specifications live in [`docs/specs`](docs/specs). The security boundary and explicit non-goals are documented in [`docs/threat-model.md`](docs/threat-model.md).

## Security

Default inspection never executes target code. Static analysis cannot fully detect obfuscation, delayed behavior, dependency compromise, native-code behavior, or remote payloads. Report vulnerabilities privately as described in [`SECURITY.md`](SECURITY.md).

## License

Apache-2.0. See [`LICENSE`](LICENSE) and [`NOTICE`](NOTICE).
