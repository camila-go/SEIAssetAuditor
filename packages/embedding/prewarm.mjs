/**
 * Download the embedding model into the repo-local cache.
 *
 * Run once per machine (and in CI/deploy) so the worker never needs to reach
 * huggingface.co at runtime:  npm run embed:prewarm
 */
import { EMBEDDING_MODEL, MODEL_CACHE_DIR, embed, isModelCached } from './dist/index.js'

console.log(`cache: ${MODEL_CACHE_DIR}`)
console.log(`model: ${EMBEDDING_MODEL}`)
console.log(isModelCached() ? 'already cached — verifying…' : 'downloading…')

const started = Date.now()
const vector = await embed('warm up the sentence encoder')

if (vector.length === 0) {
  console.error('FAILED: model produced an empty vector')
  process.exit(1)
}

console.log(`ready in ${((Date.now() - started) / 1000).toFixed(1)}s — ${vector.length} dimensions`)
