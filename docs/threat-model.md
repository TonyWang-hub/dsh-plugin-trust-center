# Threat Model

## Assets

Trust Center protects the operator's workstation, credentials, DSH profiles, generated evidence integrity, and CI publishing credentials.

## Untrusted inputs

Plugin archives, package manifests, source files, GitHub/npm metadata, Cordis patch files, symlinks, filenames, and community registry submissions are untrusted.

## Stage 1 boundary

Default inspection downloads and parses bytes but never imports target modules, runs package managers, or executes lifecycle scripts. Extraction is bounded by archive size, file count, per-file size, total expanded size, traversal checks, and link rejection. Evidence snippets are bounded and output must not contain temporary absolute paths or environment values.

The manual dynamic workflow is a disposable evidence source, not a sandbox guarantee. It receives no repository secrets, has no write permission, is time-bounded, and requires an explicit boolean input before importing target code.

## Stage 3 boundary

Quarantine accepts only a Passport that does not fail and whose resolved npm version or GitHub commit is immutable. It installs into a dedicated profile under an isolated temporary `DSH_HOME`, disables npm/pnpm lifecycle scripts by default, and binds a canonical receipt to the Passport digest, immutable source, install spec, quarantine id, and intended target. Explicit `--allow-execute` still runs untrusted code with the permissions of its disposable environment.

Promotion does not trust the earlier result alone: it verifies the receipt digest and field consistency, re-inspects the immutable source, compares the new Passport digest, snapshots the target profile, invokes official DSH add/configuration commands, and records the exact install spec. Profile disable and restore use official DSH plugin commands rather than editing only the bundle list. Trust Center-owned receipts, ledgers, and snapshots use contained paths, atomic writes where applicable, and SHA-256 manifests; failed mutations restore verified profile bytes and remove or reinstall packages as required.

The DSH bundle exposes only read-only tools. Public source inspection must be immutable; local source inspection is limited to operator-configured roots. Status output contains profile, dependency, and snapshot names but omits absolute paths and credentials. Tool output, profile counts, dependency counts, and snapshot counts are bounded.

## Non-goals

A clean report is not proof of benign behavior. Static rules cannot fully detect obfuscation, delayed behavior, dependency compromise, native-code behavior, or remote payloads. Trust Center does not replace host-enforced plugin permissions or process isolation.

## Failure posture

Malformed structure and extraction boundary violations fail closed. Observable risky capabilities produce review findings instead of claims about intent. Network or acquisition failure must not be rendered as a passing Passport.
