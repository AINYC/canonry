export function advancedMeasurementDraftStorageKey(projectName: string): string {
  return `canonry:advanced-measurement:compatibility-draft:v1:${projectName}`
}

export function legacyPortfolioDraftStorageKey(projectName: string): string {
  return `canonry:portfolio-draft:${projectName}`
}

export function hasAdvancedMeasurementCompatibilityDraft(projectName: string): boolean {
  if (typeof window === 'undefined') return false
  try {
    return window.localStorage.getItem(advancedMeasurementDraftStorageKey(projectName)) !== null
      || window.localStorage.getItem(legacyPortfolioDraftStorageKey(projectName)) !== null
  } catch {
    return false
  }
}
