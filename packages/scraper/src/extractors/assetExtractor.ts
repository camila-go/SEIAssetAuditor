/**
 * Moved to `@capella/types` so the API and the static UI share one
 * implementation. Re-exported here because this is the import path the scraper
 * and its tests already use.
 */
export {
  DAM_ROOT,
  damBrand,
  dedupePaths,
  extractPathsFromAttribute,
  extractPathsFromCss,
  normalizeAssetPath,
} from '@capella/types'
