import { describe, expect, it } from 'vitest'
import {
  badgeStatusForVerdict,
  renderBadgeSvg,
  renderShieldsEndpoint,
} from '../src/registry/badges.js'

/** 64 hex chars, the shape produced by computePackageDigest. */
const DIGEST = 'abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789'

const PASS_SVG = `<svg xmlns="http://www.w3.org/2000/svg" role="img" aria-label="trust: pass" width="83" height="20">
  <title>trust: pass - sha256:${DIGEST}</title>
  <desc>Automated evidence badge: status pass, digest sha256:${DIGEST}. Reports are automated evidence, not an endorsement.</desc>
  <rect width="83" height="20" rx="3" fill="#555555"/>
  <rect x="45" width="38" height="20" fill="#2e7d32"/>
  <g fill="#ffffff" font-family="Verdana,DejaVu Sans,sans-serif" font-size="11" text-anchor="middle">
    <text x="22.5" y="14">trust</text>
    <text x="64" y="14">pass</text>
  </g>
</svg>
`

const REVIEW_SVG = `<svg xmlns="http://www.w3.org/2000/svg" role="img" aria-label="trust: review" width="97" height="20">
  <title>trust: review - sha256:${DIGEST}</title>
  <desc>Automated evidence badge: status review, digest sha256:${DIGEST}. Reports are automated evidence, not an endorsement.</desc>
  <rect width="97" height="20" rx="3" fill="#555555"/>
  <rect x="45" width="52" height="20" fill="#ef6c00"/>
  <g fill="#ffffff" font-family="Verdana,DejaVu Sans,sans-serif" font-size="11" text-anchor="middle">
    <text x="22.5" y="14">trust</text>
    <text x="71" y="14">review</text>
  </g>
</svg>
`

const FAIL_SVG = `<svg xmlns="http://www.w3.org/2000/svg" role="img" aria-label="trust: fail" width="83" height="20">
  <title>trust: fail - sha256:${DIGEST}</title>
  <desc>Automated evidence badge: status fail, digest sha256:${DIGEST}. Reports are automated evidence, not an endorsement.</desc>
  <rect width="83" height="20" rx="3" fill="#555555"/>
  <rect x="45" width="38" height="20" fill="#c62828"/>
  <g fill="#ffffff" font-family="Verdana,DejaVu Sans,sans-serif" font-size="11" text-anchor="middle">
    <text x="22.5" y="14">trust</text>
    <text x="64" y="14">fail</text>
  </g>
</svg>
`

const UNAVAILABLE_SVG = `<svg xmlns="http://www.w3.org/2000/svg" role="img" aria-label="trust: unavailable" width="132" height="20">
  <title>trust: unavailable</title>
  <desc>Automated evidence badge: status unavailable. Reports are automated evidence, not an endorsement.</desc>
  <rect width="132" height="20" rx="3" fill="#555555"/>
  <rect x="45" width="87" height="20" fill="#616161"/>
  <g fill="#ffffff" font-family="Verdana,DejaVu Sans,sans-serif" font-size="11" text-anchor="middle">
    <text x="22.5" y="14">trust</text>
    <text x="88.5" y="14">unavailable</text>
  </g>
</svg>
`

const PASS_SHIELDS = `{
  "schemaVersion": 1,
  "label": "trust",
  "message": "pass",
  "color": "#2e7d32",
  "labelColor": "#555555",
  "digest": "sha256:${DIGEST}"
}
`

const REVIEW_SHIELDS = `{
  "schemaVersion": 1,
  "label": "trust",
  "message": "review",
  "color": "#ef6c00",
  "labelColor": "#555555",
  "digest": "sha256:${DIGEST}"
}
`

const FAIL_SHIELDS = `{
  "schemaVersion": 1,
  "label": "trust",
  "message": "fail",
  "color": "#c62828",
  "labelColor": "#555555",
  "digest": "sha256:${DIGEST}"
}
`

const UNAVAILABLE_SHIELDS = `{
  "schemaVersion": 1,
  "label": "trust",
  "message": "unavailable",
  "color": "#616161",
  "labelColor": "#555555"
}
`

describe('registry badge primitives', () => {
  it('maps a passport verdict to a stable badge status', () => {
    expect(badgeStatusForVerdict({ status: 'pass' })).toBe('pass')
    expect(badgeStatusForVerdict({ status: 'review' })).toBe('review')
    expect(badgeStatusForVerdict({ status: 'fail' })).toBe('fail')
    expect(badgeStatusForVerdict(undefined)).toBe('unavailable')
  })

  it('renders the exact pass SVG badge with the passport digest', () => {
    expect(renderBadgeSvg('pass', { digest: DIGEST })).toBe(PASS_SVG)
  })

  it('renders the exact review SVG badge with the passport digest', () => {
    expect(renderBadgeSvg('review', { digest: DIGEST })).toBe(REVIEW_SVG)
  })

  it('renders the exact fail SVG badge with the passport digest', () => {
    expect(renderBadgeSvg('fail', { digest: DIGEST })).toBe(FAIL_SVG)
  })

  it('renders the exact unavailable SVG badge without a digest', () => {
    expect(renderBadgeSvg('unavailable')).toBe(UNAVAILABLE_SVG)
  })

  it('renders the exact Shields endpoint JSON for every status', () => {
    expect(renderShieldsEndpoint('pass', { digest: DIGEST })).toBe(PASS_SHIELDS)
    expect(renderShieldsEndpoint('review', { digest: DIGEST })).toBe(REVIEW_SHIELDS)
    expect(renderShieldsEndpoint('fail', { digest: DIGEST })).toBe(FAIL_SHIELDS)
    expect(renderShieldsEndpoint('unavailable')).toBe(UNAVAILABLE_SHIELDS)
  })

  it('escapes untrusted label and digest content so no raw markup survives in the SVG', () => {
    const svg = renderBadgeSvg('pass', {
      label: '<img src=x onerror=alert(1)>',
      digest: '&"><script>alert(1)</script>',
    })
    expect(svg).not.toContain('<img')
    expect(svg).not.toContain('<script>')
    expect(svg).toContain('&lt;img src=x onerror=alert(1)&gt;')
    expect(svg).toContain('&amp;&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;')
  })

  it('keeps Shields JSON parseable and free of raw HTML markup', () => {
    const json = renderShieldsEndpoint('pass', { label: '</script><script>alert(1)</script>' })
    expect(json).not.toContain('</script>')
    expect(json).not.toContain('<script>')
    expect(json).toContain('\\u003c/script\\u003e')
    expect(JSON.parse(json).label).toBe('</script><script>alert(1)</script>')
  })

  it('is byte-identical for identical inputs', () => {
    expect(renderBadgeSvg('review', { digest: DIGEST })).toBe(renderBadgeSvg('review', { digest: DIGEST }))
    expect(renderShieldsEndpoint('fail', { digest: DIGEST })).toBe(renderShieldsEndpoint('fail', { digest: DIGEST }))
    expect(renderBadgeSvg('unavailable')).toBe(renderBadgeSvg('unavailable'))
  })
})
