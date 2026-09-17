export { scrapePage } from './scraper.js'
export { scrapeBatch } from './batch.js'
export { getContext, closeBrowser, registerShutdownHooks } from './browser.js'
export { fetchSitemapUrls, parseSitemapXml } from './sitemap.js'
export { AemClient, buildQuery } from './aemClient.js'
export type { AemClientOptions, AemAssetMetadata } from './aemClient.js'
export {
  computePhash,
  computePhashVariants,
  bestDistance,
  hammingDistance,
  isDuplicate,
  groupDuplicates,
  DUPLICATE_THRESHOLD,
} from './phash.js'
export type { PhashVariants } from './phash.js'

export {
  normalizeAssetPath,
  extractPathsFromAttribute,
  dedupePaths,
  damBrand,
  DAM_ROOT,
} from './extractors/assetExtractor.js'

export {
  fingerprint,
  parseCandidate,
  parseCandidates,
  extractStudentName,
  extractProgram,
  extractDegreeLevel,
  isPlausibleQuote,
  TESTIMONIAL_SELECTORS,
} from './extractors/testimonialExtractor.js'
export type { TestimonialCandidate } from './extractors/testimonialExtractor.js'
