export interface RuleMetadata {
  id: string
  severity: 'critical' | 'high'
  category: 'manifest' | 'lifecycle' | 'code' | 'dependency'
  title: string
}

export const RULE_CATALOG: readonly RuleMetadata[] = ([
  { id: 'DSH-MANIFEST-001', severity: 'critical', category: 'manifest', title: 'Missing or invalid package manifest' },
  { id: 'DSH-MANIFEST-002', severity: 'critical', category: 'manifest', title: 'Invalid dsh.bundle declaration' },
  { id: 'DSH-MANIFEST-003', severity: 'critical', category: 'manifest', title: 'Bundle patch escapes the package root' },
  { id: 'DSH-MANIFEST-004', severity: 'critical', category: 'manifest', title: 'Declared bundle patch is missing' },
  { id: 'DSH-MANIFEST-005', severity: 'critical', category: 'manifest', title: 'Invalid dsh.client declaration' },
  { id: 'DSH-MANIFEST-006', severity: 'critical', category: 'manifest', title: 'Missing dsh client export' },
  { id: 'DSH-MANIFEST-007', severity: 'critical', category: 'manifest', title: 'No DSH package declaration' },
  { id: 'DSH-MANIFEST-008', severity: 'critical', category: 'manifest', title: 'Invalid Cordis patch structure' },
  { id: 'DSH-MANIFEST-009', severity: 'critical', category: 'manifest', title: 'Invalid dsh.profile declaration' },
  { id: 'DSH-MANIFEST-010', severity: 'critical', category: 'manifest', title: 'Invalid top-level dsh declaration' },
  { id: 'DSH-SCAN-001', severity: 'critical', category: 'code', title: 'Static inspection was incomplete' },
  { id: 'DSH-SCRIPT-001', severity: 'high', category: 'lifecycle', title: 'Install lifecycle script' },
  { id: 'DSH-CODE-001', severity: 'high', category: 'code', title: 'Dynamic code execution' },
  { id: 'DSH-CODE-002', severity: 'high', category: 'code', title: 'Process execution' },
  { id: 'DSH-CODE-003', severity: 'high', category: 'code', title: 'Environment or credential access' },
  { id: 'DSH-CODE-004', severity: 'high', category: 'code', title: 'Network access' },
  { id: 'DSH-CODE-005', severity: 'high', category: 'code', title: 'Native binary or addon' },
  { id: 'DSH-CODE-006', severity: 'high', category: 'code', title: 'Oversized source file' },
  { id: 'DSH-CODE-007', severity: 'high', category: 'code', title: 'Obfuscated or minified source' },
  { id: 'DSH-DEP-001', severity: 'high', category: 'dependency', title: 'Mutable dependency spec' },
] satisfies RuleMetadata[]).sort((a, b) => a.id.localeCompare(b.id))
