/**
 * What to do about a failed read, decided by what failed.
 *
 * Retrying everything the same way wastes attempts on files that will never
 * succeed and hammers a flaky link at the worst moment. Dropbox's camera upload
 * rewrite split errors the same way and saw total retries and user-visible
 * errors both go down.
 *
 * - transient: worth trying again after a pause. Timeouts, I/O errors, short
 *   reads, anything not recognised.
 * - permanent: trying again cannot help. The file is gone or refused.
 * - fatal: the run itself cannot continue, so quarantining file after file
 *   would only bury the real cause. A full destination disk is the case.
 */

export type FailureClass = 'transient' | 'permanent' | 'fatal'

export interface Classified {
  cls: FailureClass
  detail: string
}

// AFC status names are in src/protocol/afc.ts. Node codes cover the local side.
const PERMANENT = /object not found|permission denied|object is directory|operation not supported|invalid argument|\bENOENT\b|\bEACCES\b|\bEPERM\b|\bEISDIR\b/i
const FATAL = /no space left|\bENOSPC\b|\bEROFS\b/i

export function classify(e: unknown): Classified {
  const err = e as (Error & { code?: string }) | undefined
  const detail = err?.message ?? String(e)
  const probe = `${err?.code ?? ''} ${detail}`
  if (FATAL.test(probe)) return { cls: 'fatal', detail }
  if (PERMANENT.test(probe)) return { cls: 'permanent', detail }
  return { cls: 'transient', detail }
}

/** 250 ms, 500 ms, 1 s ... capped, so a long run of retries never stalls for minutes. */
export function backoffMs(attempt: number, baseMs: number, capMs = 8000): number {
  if (baseMs <= 0) return 0
  return Math.min(capMs, baseMs * 2 ** Math.max(0, attempt - 1))
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve()
  return new Promise((resolve) => {
    const t = setTimeout(done, ms)
    function done() {
      clearTimeout(t)
      signal?.removeEventListener('abort', done)
      resolve()
    }
    // Cancellation should not wait out a backoff. The caller checks the signal next.
    signal?.addEventListener('abort', done, { once: true })
  })
}
