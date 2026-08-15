/**
 * Stage 2 badge primitives: deterministic, escaped, accessible SVG badges and
 * Shields endpoint JSON for the four registry statuses. Generated output is
 * production behavior: identical inputs always produce byte-identical output.
 */

export type BadgeStatus = 'pass' | 'review' | 'fail' | 'unavailable'

export interface BadgeOptions {
  /** Left-hand label segment. Defaults to `trust`. */
  label?: string
  /** Passport content digest (raw hex); rendered as `sha256:<digest>`. */
  digest?: string
}

/** Stable status -> badge color mapping (never derived from findings). */
const STATUS_COLORS: Record<BadgeStatus, string> = {
  pass: '#2e7d32',
  review: '#ef6c00',
  fail: '#c62828',
  unavailable: '#616161',
}

export const BADGE_LABEL_COLOR = '#555555'
export const DEFAULT_BADGE_LABEL = 'trust'

const CHAR_WIDTH = 7
const PADDING = 5
const HEIGHT = 20
const TEXT_Y = 14

/** Maps an optional Passport verdict to a badge status; absent -> unavailable. */
export function badgeStatusForVerdict(
  verdict: { status: 'pass' | 'review' | 'fail' } | undefined,
): BadgeStatus {
  if (verdict === undefined) return 'unavailable'
  return verdict.status
}

function escapeXml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;')
}

/** Escapes JSON so it stays inert when inlined into HTML script context. */
function escapeJsonForHtml(json: string): string {
  return json
    .replaceAll('<', '\\u003c')
    .replaceAll('>', '\\u003e')
    .replaceAll('&', '\\u0026')
    .replaceAll('\u2028', '\\u2028')
    .replaceAll('\u2029', '\\u2029')
}

function segmentWidth(text: string): number {
  return PADDING * 2 + text.length * CHAR_WIDTH
}

/**
 * Renders an accessible shields-style SVG badge. The full Passport digest is
 * carried in the `<title>`/`<desc>` (escaped) so the badge remains compact
 * while still exposing evidence. Never emits untrusted content unescaped.
 */
export function renderBadgeSvg(status: BadgeStatus, options: BadgeOptions = {}): string {
  const label = options.label ?? DEFAULT_BADGE_LABEL
  const digest = options.digest === undefined ? undefined : `sha256:${options.digest}`
  const color = STATUS_COLORS[status]
  const labelWidth = segmentWidth(label)
  const messageWidth = segmentWidth(status)
  const width = labelWidth + messageWidth
  const labelCenter = labelWidth / 2
  const messageCenter = labelWidth + messageWidth / 2
  const digestPart = digest === undefined ? '' : ` - ${digest}`
  const digestSuffix = digest === undefined ? '' : `, digest ${digest}`

  const title = `${label}: ${status}${digestPart}`
  const desc = `Automated evidence badge: status ${status}${digestSuffix}. Reports are automated evidence, not an endorsement.`

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" role="img" aria-label="${escapeXml(`${label}: ${status}`)}" width="${width}" height="${HEIGHT}">`,
    `  <title>${escapeXml(title)}</title>`,
    `  <desc>${escapeXml(desc)}</desc>`,
    `  <rect width="${width}" height="${HEIGHT}" rx="3" fill="${BADGE_LABEL_COLOR}"/>`,
    `  <rect x="${labelWidth}" width="${messageWidth}" height="${HEIGHT}" fill="${color}"/>`,
    `  <g fill="#ffffff" font-family="Verdana,DejaVu Sans,sans-serif" font-size="11" text-anchor="middle">`,
    `    <text x="${labelCenter}" y="${TEXT_Y}">${escapeXml(label)}</text>`,
    `    <text x="${messageCenter}" y="${TEXT_Y}">${escapeXml(status)}</text>`,
    '  </g>',
    '</svg>',
    '',
  ].join('\n')
}

/**
 * Renders the Shields.io endpoint JSON for a status. `digest` is included when
 * present and HTML-escaped inside the JSON so the document is inert anywhere.
 */
export function renderShieldsEndpoint(status: BadgeStatus, options: BadgeOptions = {}): string {
  const label = options.label ?? DEFAULT_BADGE_LABEL
  const digest = options.digest === undefined ? undefined : `sha256:${options.digest}`
  const body: Record<string, string | number> = {
    schemaVersion: 1,
    label,
    message: status,
    color: STATUS_COLORS[status],
    labelColor: BADGE_LABEL_COLOR,
  }
  if (digest !== undefined) body.digest = digest
  return `${escapeJsonForHtml(JSON.stringify(body, null, 2))}\n`
}
