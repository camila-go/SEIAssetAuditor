import { AppError } from '@capella/types'
import { config } from '../config.js'
import {
  assertWritablePath,
  livePathFor,
  sanitizeFilename,
  stagingFilenameFor,
  stagingPathFor,
} from './aemUploadService.js'

/**
 * The AEM write boundary.
 *
 * This is the only code in the tool that can write to AEM, so the thing worth
 * testing is not that the happy path works — it is that everything else is
 * refused. Intake moved into the shared SEI DAM on 2026-09-17; these tests
 * exist so that move, and any future one, cannot quietly widen what the
 * service account is pointed at.
 */

describe('assertWritablePath', () => {
  const staging = config.aemIntakeStagingPath
  const live = config.aemIntakeLiveRoot

  it('allows the two configured intake paths and nothing else in the DAM', () => {
    expect(() => assertWritablePath(`${staging}/video-abc123.mp4`)).not.toThrow()
    expect(() => assertWritablePath(`${live}/nursing/videos/video-abc123.mp4`)).not.toThrow()
  })

  it('defaults to the shared SEI DAM, not the legacy capella tree', () => {
    expect(staging).toBe('/content/dam/sei/capella/intake/pending')
    expect(live).toBe('/content/dam/sei/capella')
  })

  it('refuses the legacy intake path now that intake has moved', () => {
    expect(() => assertWritablePath('/content/dam/capella/intake/pending/video.mp4')).toThrow(
      AppError,
    )
    expect(() => assertWritablePath('/content/dam/capella/nursing/videos/video.mp4')).toThrow(
      AppError,
    )
  })

  it('refuses any other DAM folder, including the surrounding SEI tree', () => {
    for (const path of [
      '/content/dam/sei/capella/logos/mark.svg',
      '/content/dam/sei/strayer/videos/x.mp4',
      '/content/dam/sei/capella/nursing/photos/x.jpg',
      '/content/dam/vc/logo/x.svg',
    ]) {
      expect(() => assertWritablePath(path)).toThrow(AppError)
    }
  })

  it('refuses page content outright', () => {
    expect(() => assertWritablePath('/content/capella/en/about')).toThrow(AppError)
    expect(() => assertWritablePath('/etc/passwd')).toThrow(AppError)
  })

  it('refuses traversal even when the prefix looks right', () => {
    expect(() => assertWritablePath(`${staging}/../../../etc/x.mp4`)).toThrow(AppError)
    expect(() => assertWritablePath(`${live}/../strayer/videos/x.mp4`)).toThrow(AppError)
  })

  it('refuses a nested path under the live root — videos only, one level deep', () => {
    expect(() => assertWritablePath(`${live}/nursing/videos/sub/x.mp4`)).toThrow(AppError)
    expect(() => assertWritablePath(`${live}/nursing/videos/`)).toThrow(AppError)
  })

  it('refuses the staging root itself, with or without a trailing slash', () => {
    expect(() => assertWritablePath(staging)).toThrow(AppError)
    expect(() => assertWritablePath(`${staging}/`)).toThrow(AppError)
  })

  it('refuses a sibling folder whose name merely starts with the staging path', () => {
    // `startsWith` without the trailing slash would let this through.
    expect(() => assertWritablePath(`${staging}-public/x.mp4`)).toThrow(AppError)
  })
})

describe('livePathFor', () => {
  it('builds a path inside the configured live root', () => {
    expect(livePathFor('Nursing', 'x.mp4')).toBe(
      `${config.aemIntakeLiveRoot}/nursing/videos/x.mp4`,
    )
  })

  it('produces a path the allowlist accepts, for messy program names', () => {
    for (const program of ['Nursing', 'RN to BSN', 'Business & Tech', '  Psychology  ']) {
      expect(() => assertWritablePath(livePathFor(program, 'x.mp4'))).not.toThrow()
    }
  })

  it('refuses a program name that sanitizes away to nothing', () => {
    // Would otherwise yield a double slash and land outside the allowlist.
    expect(() => livePathFor('///', 'x.mp4')).toThrow(AppError)
    expect(() => livePathFor('!!!', 'x.mp4')).toThrow(AppError)
  })
})

describe('sanitizeFilename', () => {
  it('strips directory traversal out of an uploaded filename', () => {
    expect(sanitizeFilename('../../etc/passwd')).toBe('passwd')
    expect(sanitizeFilename('/tmp/evil.mp4')).toBe('evil.mp4')
  })

  it('keeps a staged filename inside the allowlist', () => {
    const staged = stagingFilenameFor('11111111-2222-3333-4444-555555555555', '../../evil.mp4')
    expect(() => assertWritablePath(stagingPathFor(staged))).not.toThrow()
  })

  it('never returns an empty name', () => {
    expect(sanitizeFilename('...')).toBe('upload')
    expect(sanitizeFilename('')).toBe('upload')
  })
})
