# Contributing

Contributions are welcome through pull requests. Every behavioral change must begin with a failing fixture-backed test, then include the minimal implementation that makes it pass.

Security rules must have a stable ID, bounded evidence, a positive fixture, a negative fixture, and wording that reports observable behavior rather than intent.

Do not add workflows that expose repository secrets to untrusted code. Dynamic package import is manual-only and must remain in an ephemeral least-privilege runner.
