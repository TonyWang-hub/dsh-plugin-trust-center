import type { Finding, Passport } from './model.js'
import { canonicalJson } from './passport.js'

const MAX_HUMAN_FINDINGS = 100

export function renderJson(passport: Passport): string {
  return `${canonicalJson(passport)}\n`
}

export function renderHuman(passport: Passport): string {
  const lines = [
    'DSH Plugin Passport',
    `Verdict: ${passport.verdict.status.toUpperCase()}`,
    `Subject: ${passport.subject.resolved}`,
    `Digest: ${passport.subject.digest}`,
    `Findings: ${String(passport.findings.length)}`,
  ]
  for (const finding of passport.findings.slice(0, MAX_HUMAN_FINDINGS)) {
    const location = finding.evidence[0]
    const where = location === undefined
      ? ''
      : ` (${location.file}${location.line === undefined ? '' : `:${String(location.line)}`})`
    lines.push(`- [${finding.severity.toUpperCase()}] ${finding.ruleId}: ${finding.title}${where}`)
  }
  if (passport.findings.length > MAX_HUMAN_FINDINGS) {
    lines.push(`- ${String(passport.findings.length - MAX_HUMAN_FINDINGS)} additional findings omitted`)
  }
  return `${lines.join('\n')}\n`
}

export function renderSarif(passport: Passport): string {
  const rules = uniqueRules(passport.findings).map(finding => ({
    id: finding.ruleId,
    shortDescription: { text: finding.title },
    fullDescription: { text: finding.message },
    help: { text: finding.remediation },
  }))
  const results = passport.findings.map(finding => {
    const evidence = finding.evidence[0]
    return {
      ruleId: finding.ruleId,
      level: finding.severity === 'critical' ? 'error' : 'warning',
      message: { text: finding.message },
      ...(evidence === undefined ? {} : {
        locations: [{
          physicalLocation: {
            artifactLocation: { uri: evidence.file },
            ...(evidence.line === undefined ? {} : {
              region: {
                startLine: evidence.line,
                ...(evidence.column === undefined ? {} : { startColumn: evidence.column }),
                ...(evidence.snippet === undefined ? {} : { snippet: { text: evidence.snippet } }),
              },
            }),
          },
        }],
      }),
    }
  })
  return `${canonicalJson({
    $schema: 'https://json.schemastore.org/sarif-2.1.0.json',
    version: '2.1.0',
    runs: [{
      tool: { driver: { name: 'DSH Plugin Trust Center', version: '0.1.0', rules } },
      results,
    }],
  })}\n`
}

function uniqueRules(findings: Finding[]): Finding[] {
  const byId = new Map<string, Finding>()
  for (const finding of findings) if (!byId.has(finding.ruleId)) byId.set(finding.ruleId, finding)
  return [...byId.values()].sort((a, b) => a.ruleId.localeCompare(b.ruleId))
}
