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
npm exec --package ./dsh-plugin-trust-center-0.1.0.tgz -- dsh-trust inspect ./my-plugin
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

## Verdict model

- `fail`: at least one critical structural finding, including an invalid manifest, escaping/missing/invalid Cordis patch, invalid client/profile declaration, no DSH declaration, or an incomplete scan caused by limits or links;
- `review`: no critical findings and at least one high-severity observable capability, such as lifecycle scripts, process execution, environment access, network access, native artifacts, suspicious source shape, or mutable dependency specs;
- `pass`: no findings in the current rule set.

Use `dsh-trust rules` for machine-readable rule metadata. Rule findings report observable evidence, not author intent.

## Delivery stages

1. **Plugin Passport CLI** — implemented in `v0.1.0`.
2. **Community Registry** — GitHub Actions + Pages reports, badges, and contribution rules.
3. **DSH integration** — external bundle, quarantine profiles, snapshots, disable, and rollback.

Specifications live in [`docs/specs`](docs/specs). The security boundary and explicit non-goals are documented in [`docs/threat-model.md`](docs/threat-model.md).

## Security

Default inspection never executes target code. Static analysis cannot fully detect obfuscation, delayed behavior, dependency compromise, native-code behavior, or remote payloads. Report vulnerabilities privately as described in [`SECURITY.md`](SECURITY.md).

## License

Apache-2.0. See [`LICENSE`](LICENSE) and [`NOTICE`](NOTICE).
