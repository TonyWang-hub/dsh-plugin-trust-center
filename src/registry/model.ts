export const REGISTRY_SCHEMA_VERSION = '1.0.0' as const

/**
 * A reviewed registry source declaration. Declarations are explicit and
 * immutable: only local paths, exact npm versions, and 40-character GitHub
 * commit refs are accepted, so a collection run always resolves the same
 * revision for every record.
 */
export interface RegistrySource {
  /** Stable kebab-case identifier used for reports, badges, and ordering. */
  slug: string
  /**
   * Source spec: a local path, `npm:<name>@<exact-version>`, or
   * `github:<owner>/<repo>#<40-char-sha>` — passed verbatim to Stage 1
   * `inspectSource`, so every declaration resolves deterministically.
   */
  source: string
  /** Display name of the plugin. */
  name: string
  description?: string
  category?: string
  /** DSH versions the plugin evidence has been validated against. */
  testedDshVersions?: string[]
}

export interface RegistryDocument {
  schemaVersion: '1.0.0'
  sources: RegistrySource[]
}
