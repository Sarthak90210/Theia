import { useState } from 'react'
import type { DeviceInfo, Diagnosis } from '../shared/api.ts'
import * as I from './icons.tsx'

/**
 * Shown in place of the gallery when a phone is plugged in but can't be read.
 * Names the one layer that is broken and what to do about it, instead of
 * "no device".
 */
export function DiagnosisView({ device, diagnosis }: { device: DeviceInfo | null; diagnosis: Diagnosis | null }) {
  const [busy, setBusy] = useState(false)
  const failed = diagnosis?.layers.find((l) => l.status === 'fail') ?? null

  const retry = async () => {
    setBusy(true)
    try {
      await window.photos.retryDevice(device?.id ?? 'device:')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="diagnosis">
      <div className="diag-card">
        <div className="diag-head">
          <I.Warning size={22} className="side-warn" />
          <div>
            <h2>{failed ? headline(failed.id) : device ? `Can't read ${device.name}` : 'No phone found'}</h2>
            <p className="muted">{failed?.detail ?? device?.error ?? 'Plug in an iPhone with a cable that carries data.'}</p>
          </div>
        </div>

        {failed?.fix && (
          <ol className="fix">
            {failed.fix.map((f, i) => (
              <li key={i}>{f}</li>
            ))}
          </ol>
        )}
        {!failed && device?.error && (
          <ol className="fix">
            <li>Unlock the phone and keep it on the home screen.</li>
            <li>Unplug the cable and plug it back in.</li>
          </ol>
        )}

        {diagnosis && (
          <ul className="layers">
            {diagnosis.layers.map((l) => (
              <li key={l.id} className={l.status}>
                <span className={`dot ${l.status === 'ok' ? 'ok' : l.status === 'fail' ? 'fail' : 'skipped'}`} />
                <span className="layer-name">{l.name}</span>
                <span className="layer-detail muted small">{l.detail}</span>
              </li>
            ))}
          </ul>
        )}

        <button className="primary" onClick={() => void retry()} disabled={busy}>
          {busy ? 'Checking…' : 'Check again'}
        </button>
      </div>
    </div>
  )
}

function headline(id: string): string {
  switch (id) {
    case 'service':
      return "Apple's device service isn't running"
    case 'usb':
      return "Windows doesn't see a phone"
    case 'usbmux':
      return "Windows sees the phone, Apple's driver doesn't"
    case 'trust':
      return "This computer isn't trusted yet"
    default:
      return "Can't reach the phone"
  }
}
