# Inspection Rules and Governance

Trust Center rules report observable package structure and capabilities. They do not infer malicious intent, certify safety, or endorse a maintainer.

## Severity

- **critical**: the declared DSH package cannot be structurally verified, extraction/inspection was incomplete, or a required boundary failed. Any critical finding produces `fail`.
- **high**: the package exposes a capability requiring human review, such as install scripts, process/network/environment access, native artifacts, suspicious source shape, or mutable dependency specs. High findings produce `review` when no critical finding exists.

## Stable rule families

- `DSH-MANIFEST-*`: package and DSH declaration validity.
- `DSH-SCAN-*`: incomplete static evidence.
- `DSH-SCRIPT-*`: package-manager lifecycle scripts.
- `DSH-CODE-*`: observable source or native-code capabilities.
- `DSH-DEP-*`: mutable or non-registry dependency declarations.

Run `dsh-trust rules` for the machine-readable catalog shipped by the current release.

## Changing a rule

A rule change requires:

1. a stable rule ID (new semantics require a new ID rather than silently reusing an unrelated one);
2. a positive fixture that triggers the rule;
3. a negative fixture that demonstrates the intended boundary;
4. assertions for severity, bounded evidence, deterministic ordering, and remediation;
5. documentation of likely false positives and migration impact.

Rule removal or severity reduction must explain why the previous evidence is no longer actionable. Generated registry history remains available through commits and Releases.

## Corrections and appeals

Open an issue or pull request with the immutable source revision, Passport digest, disputed rule ID, and a minimal reproduction. Maintainers may correct metadata immediately, but rule behavior changes still require fixtures and review. Security-sensitive reports should use private vulnerability reporting instead of a public issue.
