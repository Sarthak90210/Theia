import type { AppState, Collections, SourceId } from '../shared/api.ts'
import * as I from './icons.tsx'
import { count } from './format.ts'

const SMART_ICON: Record<string, (p: { size?: number }) => React.ReactElement> = {
  library: I.Grid,
  favourites: I.Heart,
  videos: I.Video,
  live: I.Live,
  screenshots: I.Screenshot,
  selfies: I.Person,
  panoramas: I.Panorama,
  bursts: I.Stack,
  edited: I.Sliders,
  recent: I.Clock,
}

export interface SidebarProps {
  state: AppState
  source: SourceId | null
  collections: Collections | null
  collection: string
  onSource: (id: SourceId) => void
  onCollection: (id: string) => void
  onOpenVault: () => void
  /** Show a vault's location, size, and remove or delete it. */
  onVaultOptions: (id: SourceId) => void
  onSettings: () => void
  onShortcuts: () => void
}

/**
 * Phones, then vaults, then whatever the selected one contains. Phones appear
 * here by themselves when plugged in and go when unplugged.
 */
export function Sidebar({ state, source, collections, collection, onSource, onCollection, onOpenVault, onVaultOptions, onSettings, onShortcuts }: SidebarProps) {
  const noPhoneButSeen =
    state.devices.length === 0 && state.diagnosis && state.diagnosis.layers.some((l) => l.id === 'usb' && l.status === 'ok')

  return (
    <nav className="sidebar" aria-label="Sources">
      <div className="side-section">
        <div className="side-heading">Devices</div>
        {state.devices.map((d) => (
          <button
            key={d.id}
            className={`side-item ${source === d.id ? 'active' : ''}`}
            aria-pressed={source === d.id}
            onClick={() => onSource(d.id)}
            title={d.error ?? undefined}
          >
            <I.Phone />
            <span className="side-label">{d.name}</span>
            {d.state === 'opening' && <span className="side-spinner" aria-label="Reading" />}
            {d.state === 'problem' && <I.Warning size={14} className="side-warn" />}
          </button>
        ))}
        {noPhoneButSeen && (
          <button className={`side-item ${source === 'diagnosis' ? 'active' : ''}`} onClick={() => onSource('diagnosis')}>
            <I.Phone />
            <span className="side-label">iPhone</span>
            <I.Warning size={14} className="side-warn" />
          </button>
        )}
        {state.devices.length === 0 && !noPhoneButSeen && <div className="side-empty">Plug in an iPhone</div>}
      </div>

      <div className="side-section">
        <div className="side-heading">Vaults</div>
        {state.vaults.map((v) => (
          <div key={v.id} className="side-row">
            <button
              className={`side-item ${source === v.id ? 'active' : ''}`}
              aria-pressed={source === v.id}
              onClick={() => onSource(v.id)}
              onContextMenu={(e) => {
                e.preventDefault()
                onVaultOptions(v.id)
              }}
              title={v.root}
            >
              <I.Vault />
              <span className="side-label">{v.name}</span>
              <span className="side-count">{count(v.count)}</span>
            </button>
            <button className="side-more" aria-label={`${v.name}: location and options`} title="Location and options" onClick={() => onVaultOptions(v.id)}>
              <span aria-hidden="true">⋯</span>
            </button>
          </div>
        ))}
        <button className="side-item subtle" onClick={onOpenVault}>
          <I.Plus />
          <span className="side-label">Open or create vault…</span>
        </button>
      </div>

      {collections && (
        <>
          <div className="side-section">
            <div className="side-heading">Collections</div>
            {collections.smart.filter(c => c.kind !== 'utility').map((c) => {
              const Icon = SMART_ICON[c.id] ?? I.Grid
              return (
                <button
                  key={c.id}
                  className={`side-item ${collection === c.id ? 'active' : ''}`}
                  aria-current={collection === c.id ? 'page' : undefined}
                  onClick={() => onCollection(c.id)}
                >
                  <Icon />
                  <span className="side-label">{c.name}</span>
                  <span className="side-count">{count(c.count)}</span>
                </button>
              )
            })}
          </div>
          <div className="side-section">
            <div className="side-heading">Utilities</div>
            {collections.smart.filter(c => c.kind === 'utility').map(c => <button key={c.id}
              className={`side-item ${collection === c.id ? 'active' : ''}`} aria-current={collection === c.id ? 'page' : undefined} onClick={() => onCollection(c.id)}>
              {c.id === 'hidden' ? <I.Hidden /> : <I.Trash />}
              <span className="side-label">{c.name}</span><span className="side-count">{count(c.count)}</span>
            </button>)}
          </div>
          {collections.albums.length > 0 && (
            <div className="side-section">
              <div className="side-heading">Albums</div>
              {collections.albums.map((c) => (
                <button
                  key={c.id}
                  className={`side-item ${collection === c.id ? 'active' : ''}`}
                  aria-current={collection === c.id ? 'page' : undefined}
                  onClick={() => onCollection(c.id)}
                >
                  <I.Album />
                  <span className="side-label">{c.name}</span>
                  <span className="side-count">{count(c.count)}</span>
                </button>
              ))}
            </div>
          )}
        </>
      )}
      <div className="side-section">
        <div className="side-heading">App</div>
        <button className="side-item" onClick={onSettings} title="Settings (Ctrl+,)"><I.Sliders /><span className="side-label">Settings</span></button>
        <button className="side-item" onClick={onShortcuts} title="Keyboard shortcuts (? or F1)"><I.Info /><span className="side-label">Keyboard shortcuts</span></button>
      </div>
    </nav>
  )
}
