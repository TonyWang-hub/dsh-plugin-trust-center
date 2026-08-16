# Security Policy

Please report vulnerabilities privately through [GitHub private vulnerability reporting](https://github.com/TonyWang-hub/dsh-plugin-trust-center/security/advisories/new). Do not include live credentials or execute an untrusted plugin merely to prove a report.

Include the affected Trust Center version, immutable plugin source revision when relevant, reproduction steps, and impact. Registry metadata corrections and rule false positives that are not security-sensitive may use a public issue with the Passport digest and rule ID.

Trust Center findings are automated evidence, not a safety certification. A clean report cannot prove that a plugin is benign. Static inspection cannot fully detect obfuscation, delayed behavior, native-code behavior, dependency compromise, or remote payloads. Quarantine profiles, disabled lifecycle scripts, receipts, snapshots, process-group timeout cleanup, and rollback reduce operational risk but are not a host security boundary; installed bundle code still runs with DSH host privileges.

The scheduled registry workflow performs static acquisition and parsing only. Target code execution is limited to a separate manual workflow with no repository permissions or secrets and requires an explicit execution input. The manual Constrained Dogfood workflow never enables that execution path: it has read-only repository permission, disables lifecycle scripts, requires `executed: false`, and stops at a promotion dry-run for the pinned community source.

npm publishing is manual and environment-gated. It accepts only a stable version tag, downloads the existing GitHub Release assets, verifies their published SHA-256 checksums and package identity, refuses version overwrite, and publishes the exact tarball with OIDC provenance. Bootstrap npm credentials are available only to the publish step and must be revoked after the initial package claim.
