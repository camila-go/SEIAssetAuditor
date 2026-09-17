import { existsSync } from 'node:fs'
import path from 'node:path'
import { env, pipeline, type FeatureExtractionPipeline } from '@huggingface/transformers'

/**
 * Sentence embeddings, computed locally.
 *
 * No API key and no per-query cost: the model runs in-process via ONNX. That
 * matters here because the tool has no OpenAI credentials, and because a DAM
 * audit re-embeds its whole corpus whenever content changes — a hosted API
 * would bill for every one of those.
 *
 * ── Why all-MiniLM-L6-v2 ─────────────────────────────────────────────────
 * Measured against the real testimonial corpus, against bge-small-en-v1.5,
 * which is the usual "better" recommendation:
 *
 *   model            irrelevant control   genuine matches
 *   MiniLM-L6-v2     0.09                 0.36 – 0.58
 *   bge-small-1.5    0.39                 0.57 – 0.66
 *
 * BGE scores an unrelated query about parking regulations at 0.39 — higher
 * than several of MiniLM's correct answers. It compresses everything into a
 * narrow high band, so no fixed threshold can separate a real match from
 * noise. MiniLM's spread is what makes RELEVANCE_THRESHOLD meaningful.
 */

export const EMBEDDING_MODEL = 'Xenova/all-MiniLM-L6-v2'

/** MiniLM-L6-v2 produces 384-dimensional vectors. */
export const EMBEDDING_DIMENSIONS = 384

/**
 * Minimum cosine similarity to count as a semantic match.
 *
 * Set from the measurement above: irrelevant content tops out around 0.09 and
 * genuine paraphrases start around 0.36. 0.30 sits in the empty band between
 * them, so it admits real matches without letting noise through.
 */
export const RELEVANCE_THRESHOLD = 0.3

/**
 * Where the model weights live on disk.
 *
 * Pinned to a directory inside the repo, resolved from this file rather than
 * the cwd — the worker runs with its workspace as cwd, so a relative cache
 * would land somewhere different for every process.
 *
 * Vendoring the weights is deliberate. Fetching them at runtime makes the first
 * search depend on reaching huggingface.co, which fails in exactly the
 * environments this will be deployed into: a locked-down worker host, an
 * air-gapped build, or anything behind an egress proxy. It failed here too.
 * `npm run embed:prewarm` downloads the model once, and after that the worker
 * needs no network at all.
 */
export const MODEL_CACHE_DIR = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  '../../../.model-cache',
)

env.cacheDir = MODEL_CACHE_DIR
env.allowLocalModels = true

/** True once the weights are on disk, so callers can report a useful reason. */
export function isModelCached(): boolean {
  return existsSync(path.join(MODEL_CACHE_DIR, EMBEDDING_MODEL))
}

/**
 * The model is a few tens of MB and takes several seconds to initialise, so it
 * is loaded once per process and shared. The promise (not the pipeline) is
 * cached so concurrent callers await one load rather than starting several.
 */
let pipelinePromise: Promise<FeatureExtractionPipeline> | null = null

export function loadModel(): Promise<FeatureExtractionPipeline> {
  pipelinePromise ??= pipeline('feature-extraction', EMBEDDING_MODEL).catch((error: unknown) => {
    // Reset so a later call can retry rather than being stuck on a rejected
    // promise for the life of the process.
    pipelinePromise = null
    throw error
  })
  return pipelinePromise
}

/** True once the model is resident, so callers can avoid a cold start on a request path. */
export function isModelLoaded(): boolean {
  return pipelinePromise !== null
}

/**
 * Embed one string. Vectors are mean-pooled and L2-normalised, which is what
 * makes `cosineSimilarity` a plain dot product.
 */
export async function embed(text: string): Promise<number[]> {
  const trimmed = text.trim()
  if (!trimmed) return []

  const extractor = await loadModel()
  const output = await extractor(trimmed, { pooling: 'mean', normalize: true })
  return Array.from(output.data as Float32Array)
}

/**
 * Embed several strings in one pass. Materially faster than looping `embed`,
 * which is what the corpus backfill uses.
 */
export async function embedBatch(texts: string[]): Promise<number[][]> {
  const usable = texts.map((text) => text.trim())
  if (usable.length === 0) return []

  const extractor = await loadModel()
  const output = await extractor(usable, { pooling: 'mean', normalize: true })

  const data = output.data as Float32Array
  const width = data.length / usable.length

  return usable.map((_text, index) =>
    Array.from(data.slice(index * width, (index + 1) * width)),
  )
}

/**
 * Cosine similarity of two normalised vectors, i.e. a dot product.
 *
 * Returns 0 rather than throwing for mismatched or empty input: a row embedded
 * by an older model must simply not match, not break the search.
 */
export function cosineSimilarity(a: readonly number[], b: readonly number[]): number {
  if (a.length === 0 || a.length !== b.length) return 0

  let total = 0
  for (let i = 0; i < a.length; i++) total += (a[i] ?? 0) * (b[i] ?? 0)
  return total
}

/**
 * Turn a filename or DAM path into something a language model can read.
 *
 * "capella_logo_horizontal_RGB_448x95.svg" carries real words, but only once
 * the separators are spaces and the camelCase is split. Dimensions and the
 * extension are dropped — "448x95" and "svg" are noise to a sentence model.
 *
 * This is a genuine limitation rather than a trick: filenames are all the
 * semantic surface an asset has until AEM supplies titles and tags in Phase 2.
 * A run-on like "browsinglaptopdog" stays one token and will not embed well.
 */
export function humanizePath(path: string): string {
  return path
    .replace(/\.[a-z0-9]{2,5}$/i, '') // trailing extension
    .replace(/[_\-./\\]+/g, ' ') // separators
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2') // camelCase
    .replace(/\b\d+\s*x\s*\d+\b/gi, ' ') // 448x95 pixel dimensions
    .replace(/\b\d{3,}\b/g, ' ') // long bare numbers
    .replace(/\s+/g, ' ')
    .trim()
}
