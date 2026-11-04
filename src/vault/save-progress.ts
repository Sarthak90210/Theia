/** Progress for copying a selection, including the destination read-back. */
export interface SaveProgress {
  itemsDone: number
  itemsTotal: number
  /** Logical bytes processed. A restarted file replaces its previous attempt. */
  bytesDone: number
  /** Null while a remaining source file has no declared size. */
  bytesTotal: number | null
  /** Net copy progress per second, including time spent on verification. */
  bytesPerSecond: number
  /** Copy and read-back estimate; null during warm-up or final commit work. */
  etaMs: number | null
  phase: 'copying' | 'verifying' | 'finishing'
  current: string | null
}

interface FileWork {
  name: string
  declared: number | null
  total: number | null
  copied: number
  checked: number
  retired: boolean
  attempts: number
}

export interface SaveFileProgress {
  beginAttempt(): void
  copied(bytes: number): void
  verifying(): void
  checked(bytes: number): void
  failed(): void
}

/** Tracks real copy/read-back work rather than treating the last received byte as completion. */
export class SaveProgressTracker {
  private readonly work: FileWork[][]
  private itemsDone = 0
  private current: string | null = null
  private phase: SaveProgress['phase'] = 'copying'
  private readonly rateStarted: number
  private readonly samples: { at: number; copied: number; work: number }[] = []
  private readonly timer: ReturnType<typeof setInterval> | undefined

  constructor(
    plans: { files: { name: string; size: number | null }[]; skip: boolean }[],
    private readonly now: () => number,
    private readonly onProgress?: (progress: SaveProgress) => void,
  ) {
    this.work = plans.map(plan => plan.files.map(file => ({ name: file.name, declared: file.size,
      total: plan.skip ? 0 : file.size, copied: 0, checked: 0, retired: plan.skip, attempts: 0 })))
    this.rateStarted = now()
    this.record(this.rateStarted, 0, 0)
    if (onProgress) {
      this.timer = setInterval(() => this.emit(), 1000)
      this.timer.unref()
    }
  }

  private record(at: number, copied: number, work: number) {
    const last = this.samples.at(-1)
    if (last?.at === at) this.samples[this.samples.length - 1] = { at, copied, work }
    else this.samples.push({ at, copied, work })
    const cutoff = at - 10_000
    // Keep a sample spanning the beginning of the trailing window.
    while (this.samples.length > 2 && this.samples[1]!.at <= cutoff) this.samples.shift()
  }

  emit() {
    const files = this.work.flat()
    const copied = files.reduce((n, file) => n + file.copied, 0)
    const doneWork = copied + files.reduce((n, file) => n + file.checked, 0)
    const known = files.every(file => file.total !== null)
    const bytesTotal = known ? files.reduce((n, file) => n + file.total!, 0) : null
    const totalWork = known ? files.reduce((n, file) => n + (file.retired ? file.copied + file.checked : file.total! * 2), 0) : null
    const at = this.now()
    this.record(at, copied, doneWork)
    const first = this.samples[0]!
    const seconds = (at - first.at) / 1000
    const copyRate = seconds > 0 ? Math.max(0, (copied - first.copied) / seconds) : 0
    const workRate = seconds > 0 ? Math.max(0, (doneWork - first.work) / seconds) : 0
    const remaining = totalWork === null ? null : Math.max(0, totalWork - doneWork)
    const complete = this.itemsDone === this.work.length && this.current === null
    const etaMs = complete ? 0 : this.phase !== 'finishing' && at - this.rateStarted >= 1000 &&
      seconds >= 0.5 && workRate > 0 && remaining !== null && remaining > 0
      ? Math.max(1000, Math.ceil(remaining / workRate * 1000)) : null
    this.onProgress?.({ itemsDone: this.itemsDone, itemsTotal: this.work.length, bytesDone: copied,
      bytesTotal, bytesPerSecond: copyRate, etaMs, phase: this.phase, current: this.current })
  }

  startItem(index: number, fallback: string) {
    this.current = this.work[index]?.[0]?.name ?? fallback
    this.phase = 'copying'
    this.emit()
  }

  skipItem(index: number) {
    for (const file of this.work[index] ?? []) { file.total = 0; file.retired = true }
  }

  file(item: number, index: number): SaveFileProgress {
    const file = this.work[item]![index]!
    return {
      beginAttempt: () => {
        file.attempts++
        file.copied = 0
        file.checked = 0
        file.total = file.declared
        this.current = file.name
        this.phase = 'copying'
        // A restart invalidates the previous attempt's progress, not another
        // full file of work. Discard old rate samples after that backwards step.
        if (file.attempts > 1) this.samples.length = 0
        this.emit()
      },
      copied: bytes => { file.copied += bytes; this.emit() },
      verifying: () => {
        if (file.total === null) file.total = file.copied
        this.phase = 'verifying'
        this.emit()
      },
      checked: bytes => { file.checked += bytes; this.emit() },
      failed: () => {
        // The failed file needs no more transfer work in this run. Keep what
        // was processed in the counters; the result separately reports failure.
        file.total = file.copied
        file.retired = true
        this.emit()
      },
    }
  }

  finishing() { this.phase = 'finishing'; this.emit() }
  itemDone() { this.itemsDone++; this.emit() }
  complete() { this.current = null; this.phase = 'finishing'; this.emit() }
  close() { clearInterval(this.timer) }
}
