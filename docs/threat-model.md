# Threat Model

## Assets

Trust Center protects the operator's workstation, credentials, DSH profiles, generated evidence integrity, and CI publishing credentials.

## Untrusted inputs

Plugin archives, package manifests, source files, GitHub/npm metadata, Cordis patch files, symlinks, filenames, and community registry submissions are untrusted.

## Stage 1 boundary

Default inspection downloads and parses bytes but never imports target modules, runs package managers, or executes lifecycle scripts. Extraction is bounded by archive size, file count, per-file size, total expanded size, traversal checks, and link rejection. Evidence snippets are bounded and output must not contain temporary absolute paths or environment values.

The manual dynamic workflow is a disposable evidence source, not a sandbox guarantee. It receives no repository secrets, has no write permission, is time-bounded, and requires an explicit boolean input before importing target code.

## Non-goals

A clean report is not proof of benign behavior. Static rules cannot fully detect obfuscation, delayed behavior, dependency compromise, native-code behavior, or remote payloads. Trust Center does not replace host-enforced plugin permissions or process isolation.

## Failure posture

Malformed structure and extraction boundary violations fail closed. Observable risky capabilities produce review findings instead of claims about intent. Network or acquisition failure must not be rendered as a passing Passport.
