/**
 * Service barrel for the worker.
 *
 * The worker needs the transcription, VTT, chapter and AEM-write logic, but
 * importing `@capella/api` directly would run `index.ts` and start an HTTP
 * server inside the worker process. Everything re-exported here is
 * Express-free; the worker imports `@capella/api/services`, which resolves to
 * this file and never touches `app.ts`.
 */

export * as aemUploadService from './aemUploadService.js'
export * as notificationService from './notificationService.js'

export {
  transcribeAudioFile,
  mergeChunkedTranscripts,
  normalizeResponse,
  WHISPER_MAX_BYTES,
} from './transcriptionService.js'
export type { WhisperResponse } from './transcriptionService.js'

export {
  generateVtt,
  groupWordsIntoBlocks,
  toTimestampedParagraphs,
  formatVttTimestamp,
  formatChapterTimestamp,
} from './vttService.js'
export type { WhisperWord, CaptionBlock } from './vttService.js'

export { detectChapters, sanitizeChapters, parseTimestamp } from './chapterService.js'
