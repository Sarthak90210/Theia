import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { AppState, Collections, GalleryItem, SourceId } from '../shared/api.ts'
import { DiagnosisView } from './Diagnosis.tsx'
import { count, plural, cleanError } from './format.ts'
import { Grid } from './Grid.tsx'
import * as I from './icons.tsx'
import { InfoPanel } from './InfoPanel.tsx'
import type { View } from './layout.ts'
import { SaveMenu, StatusBar } from './Save.tsx'
import { Sidebar } from './Sidebar.tsx'
import { Editor } from './Editor.tsx'
import { VaultActions } from './VaultActions.tsx'
import { Viewer } from './Viewer.tsx'
import { VaultDialog } from './VaultDialog.tsx'
import { LockedCollection, SetUpProtection, UnlockDialog } from './Protection.tsx'
import { Preferences, type PreferencesPage } from './Preferences.tsx'

const VIEWS: { id: View; name: string }[] = [
  { id: 'years', name: 'Years' },
  { id: 'months', name: 'Months' },
  { id: 'days', name: 'Days' },
  { id: 'all', name: 'All Photos' },
]

/** Pseudo source for "a phone is plugged in but can't be opened". */
const DIAGNOSIS = 'diagnosis'

export function App() {
  const [state, setState] = useState<AppState | null>(null)
  const [source, setSource] = useState<SourceId | null>(null)
  const pendingSource = useRef<SourceId | null>(null)
  const [collections, setCollections] = useState<Collections | null>(null)
  const [collection, setCollection] = useState('library')
  const [items, setItems] = useState<GalleryItem[] | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [view, setView] = useState<View>('all')
  const [zoom, setZoom] = useState(5)
  const [sidebarOpen, setSidebarOpen] = useState(true)
  const [preferences, setPreferences] = useState<PreferencesPage | null>(null)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  /** Selection mode, switched on by the Select button. Off: a click opens. */
  const [selecting, setSelecting] = useState(false)
  const [focusKey, setFocusKey] = useState<string | null>(null)
  const anchor = useRef<number | null>(null)
  // Lists can change order after a save or a burst action. Keep the open item by identity.
  const [viewerKey, setViewerKey] = useState<string | null>(null)
  const viewerPosition = viewerKey === null ? -1 : (items?.findIndex(i => i.key === viewerKey) ?? -1)
  const viewer = viewerPosition < 0 ? null : viewerPosition
  const setViewer = (index: number | null) => setViewerKey(index === null ? null : (items?.[index]?.key ?? null))
  const [infoOpen, setInfoOpen] = useState(false)
  const [scrollTo, setScrollTo] = useState<string | null>(null)
  const [editor, setEditor] = useState<GalleryItem | null>(null)
  const [refresh, setRefresh] = useState(0)
  const [notice, setNotice] = useState<string | null>(null)
  const [vaultDialog, setVaultDialog] = useState<SourceId | null>(null)
  /** fromAction: opened because Hide, Delete or Recover needed it, so say to try again. */
  const [protect, setProtect] = useState<{ kind: 'setup' | 'unlock'; vault: SourceId; fromAction?: boolean } | null>(null)
  // Messages go away by themselves; errors stay a little longer to be read.
  useEffect(() => {
    if (!notice) return
    const t = setTimeout(() => setNotice(null), /could not|can't|failed|error/i.test(notice) ? 9000 : 4500)
    return () => clearTimeout(t)
  }, [notice])

  useEffect(() => {
    const off = window.photos.onState(setState)
    void window.photos.getState().then(setState)
    return off
  }, [])

  const device = state?.devices.find((d) => d.id === source) ?? null
  const vault = state?.vaults.find((v) => v.id === source) ?? null
  const ready = !!vault || device?.state === 'ready'
  // Reload when the source's contents change, such as after a save into it.
  const sourceRevision = vault?.revision ?? 0
  const sourceCount = vault?.count ?? device?.count ?? null
  useEffect(() => {
    if ((collection === 'hidden' || collection === 'deleted') && vault?.protection !== 'unlocked') {
      setViewerKey(null); setFocusKey(null); setSelected(new Set()); setInfoOpen(false)
    }
  }, [collection, vault?.protection])

  // Pick a source on start, and another one when the selected phone is unplugged.
  useEffect(() => {
    if (!state) return
    // A source click can land between the initial state event and React's
    // automatic-source effect. Keep that explicit choice while it commits.
    if (pendingSource.current && pendingSource.current !== source &&
      [...state.devices, ...state.vaults].some(s => s.id === pendingSource.current)) return
    if (source === DIAGNOSIS && state.devices.length === 0 && state.diagnosis) return
    if (source && (device || vault)) return
    const next = state.devices.find((d) => d.state === 'ready') ?? state.devices[0] ?? state.vaults[0] ?? null
    if (next) choose(next.id)
    else if (state.diagnosis?.layers.some((l) => l.id === 'usb' && l.status === 'ok')) choose(DIAGNOSIS)
    else choose(null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state, source, device, vault])

  const choose = (id: SourceId | null) => {
    pendingSource.current = id
    if (id === source) return
    setEditor(null)
    setSource(id)
    setCollections(null)
    setCollection('library')
    setItems(null)
    setView('all')
    stopSelecting()
    setViewer(null)
    setScrollTo(null)
  }

  useEffect(() => {
    if (!source || !ready) return
    let live = true
    window.photos
      .collections(source)
      .then((c) => live && setCollections(c))
      .catch((e: Error) => live && setLoadError(e.message))
    return () => {
      live = false
    }
  }, [source, ready, sourceCount, sourceRevision, refresh])

  useEffect(() => {
    if (!source || !ready) return
    let live = true
    setLoadError(null)
    window.photos
      .items(source, collection)
      .then((list) => {
        if (!live) return
        setItems(list)
        setViewerKey(key => key && list.some(it => it.key === key) ? key : null)
        // Drop selected items that are gone.
        setSelected((s) => {
          if (!s.size) return s
          const keys = new Set(list.map((i) => i.key))
          return new Set([...s].filter((k) => keys.has(k)))
        })
      })
      .catch((e: Error) => live && setLoadError(e.message))
    return () => {
      live = false
    }
  }, [source, ready, collection, sourceCount, sourceRevision, refresh])

  const list = items ?? []
  const keysAll = useMemo(() => list.map((i) => i.key), [list])

  function clearSelection() {
    setSelected(new Set())
    anchor.current = null
  }

  function stopSelecting() {
    setSelecting(false)
    clearSelection()
  }

  const onSelect = useCallback(
    (index: number, mode: 'only' | 'toggle' | 'range' | 'range-add') => {
      const key = list[index]?.key
      if (!key) return
      setSelected((prev) => {
        if (mode === 'only') return new Set([key])
        if (mode === 'toggle') {
          const next = new Set(prev)
          if (next.has(key)) next.delete(key)
          else next.add(key)
          return next
        }
        const from = anchor.current ?? index
        const [a, b] = from < index ? [from, index] : [index, from]
        const next = mode === 'range-add' ? new Set(prev) : new Set<string>()
        for (let i = a; i <= b; i++) next.add(list[i]!.key)
        return next
      })
      if (mode !== 'range' && mode !== 'range-add') anchor.current = index
    },
    [list],
  )

  const selectRange = (start: number, end: number) => {
    setSelected(new Set(keysAll.slice(start, end)))
    anchor.current = start
  }

  const drill = (index: number) => {
    setScrollTo(list[index]?.key ?? null)
    setView(view === 'years' ? 'months' : 'days')
  }

  const pickCollection = (id: string) => {
    if (id === collection) return
    setCollection(id)
    setItems(null)
    setView('all')
    stopSelecting()
    setViewer(null)
    setScrollTo(null)
  }

  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.altKey || (e.target instanceof HTMLElement &&
          e.target.closest('input, textarea, select, [contenteditable="true"], [role="dialog"], [role="alertdialog"], [role="menu"]'))) return
      const ctrl = e.ctrlKey || e.metaKey
      const k = e.key.toLowerCase()
      if (ctrl && k === 'b') { e.preventDefault(); setSidebarOpen(open => !open) }
      else if (ctrl && k === 'i') { e.preventDefault(); setInfoOpen(open => !open) }
      else if (ctrl && k === ',') { e.preventDefault(); setPreferences('settings') }
      else if (k === 'f1' || (!ctrl && k === '?')) { e.preventDefault(); setPreferences('shortcuts') }
      else if (ctrl && k === 'o') {
        e.preventDefault()
        if (!editor) void openVault()
      } else if (ctrl && k === 'r') {
        e.preventDefault()
        if (editor || !source) return
        if (device) void window.photos.retryDevice(source).then(() => setRefresh(n => n + 1)).catch((e: Error) => setNotice(e.message))
        else setRefresh(n => n + 1)
      }
    }
    window.addEventListener('keydown', key)
    return () => window.removeEventListener('keydown', key)
  }, [source, device?.id, editor])

  if (!state) return <div className="boot"><span className="spinner" /><span>Opening Theia</span></div>

  const current = [...(collections?.smart ?? []), ...(collections?.albums ?? [])].find((c) => c.id === collection)
  const timeViews = collection === 'library'
  const saveKeys = selected.size ? [...selected] : keysAll
  const saveLabel = selected.size ? `Save ${count(selected.size)} to…` : `Save all to…`
  const infoKey =
    viewer !== null ? (list[viewer]?.key ?? null) : selecting ? (selected.size === 1 ? [...selected][0]! : null) : focusKey
  const allSelected = list.length > 0 && selected.size === list.length
  // An action that needs a passcode first opens the right dialog instead of an error.
  const showError = (m: string) => {
    if (vault && m.includes('PROTECTION_NEEDED')) return setProtect({ kind: 'setup', vault: vault.id, fromAction: true })
    if (vault && m.includes('LOCKED:')) return setProtect({ kind: 'unlock', vault: vault.id, fromAction: true })
    setNotice(cleanError(m))
  }
  const privateCollection = collection === 'hidden' || collection === 'deleted'

  let body: React.ReactNode
  if (source === DIAGNOSIS || device?.state === 'problem') {
    body = <DiagnosisView device={device} diagnosis={state.diagnosis} />
  } else if (!source) {
    body = (
      <div className="empty welcome">
        <div className="empty-symbol"><I.Album size={36} /></div>
        <h2>Your photos, at home.</h2>
        <p className="muted">Open a vault to browse your library, or connect an iPhone to start bringing your photos together.</p>
        <button className="primary" onClick={() => void openVault()}>
          Open a vault
        </button>
      </div>
    )
  } else if (device?.state === 'opening') {
    body = (
      <div className="empty">
        <span className="spinner" />
        <h2>Reading {device.name}</h2>
        <p className="muted">Loading the phone's library. Keep the phone unlocked.</p>
      </div>
    )
  } else if (vault && privateCollection && vault.protection !== 'unlocked') {
    body = (
      <LockedCollection
        vault={vault.id}
        vaultName={vault.name}
        what={collection as 'hidden' | 'deleted'}
        protection={vault.protection}
        count={items?.length ?? null}
        onSetUp={() => setProtect({ kind: 'setup', vault: vault.id })}
      />
    )
  } else if (loadError) {
    body = (
      <div className="empty">
        <I.Warning size={32} className="side-warn" />
        <h2>Couldn't open this</h2>
        <p className="muted">{loadError}</p>
      </div>
    )
  } else if (!items) {
    body = <div className="grid-skeleton" role="status" aria-label="Loading photos">{Array.from({ length: 18 }, (_, i) => <span key={i} />)}</div>
  } else if (!items.length) {
    body = <div className="empty">
      <div className="empty-symbol">{collection === 'hidden' ? <I.Hidden size={30} /> : collection === 'deleted' ? <I.Trash size={30} /> : <I.Album size={30} />}</div>
      <h2>{collection === 'hidden' ? 'No hidden items' : collection === 'deleted' ? 'Recently Deleted is empty' : 'Nothing here yet'}</h2>
      <p className="muted">{collection === 'hidden' ? 'Photos and videos you hide will appear here.' : collection === 'deleted' ? 'Deleted photos and videos will appear here, ready to recover.' : 'Photos and videos saved to this collection will appear here.'}</p>
    </div>
  } else {
    body = (
      <Grid
        source={source}
        items={items}
        view={timeViews ? view : 'all'}
        zoom={zoom}
        selected={selected}
        scrollTo={scrollTo}
        onSelect={onSelect}
        onSelectRange={selectRange}
        onSelectAll={() => setSelected(new Set(keysAll))}
        onClear={stopSelecting}
        onOpen={(i) => setViewer(i)}
        onDrill={drill}
        selecting={selecting}
        onStartSelecting={() => setSelecting(true)}
        onFocusKey={setFocusKey}
      />
    )
  }

  async function openVault() {
    try {
      const id = await window.photos.openVault()
      if (id) choose(id)
    } catch (e) {
      showError((e as Error).message)
    }
  }

  const sourceName = device?.name ?? vault?.name ?? ''
  const showToolbar = ready && items !== null && !loadError

  return (
    <div className={`app ${infoOpen && source && ready ? 'with-info' : ''} ${sidebarOpen ? '' : 'sidebar-collapsed'}`}>
      {sidebarOpen && <Sidebar
        state={state}
        source={source}
        collections={ready ? collections : null}
        collection={collection}
        onSource={choose}
        onCollection={pickCollection}
        onOpenVault={() => void openVault()}
        onVaultOptions={setVaultDialog}
        onSettings={() => setPreferences('settings')}
        onShortcuts={() => setPreferences('shortcuts')}
      />}

      <main className="main">
        {showToolbar && viewer === null && (
          <header className="toolbar">
            <button className="ghost icon sidebar-toggle" aria-label={sidebarOpen ? 'Hide sidebar' : 'Show sidebar'} aria-pressed={sidebarOpen} title="Toggle sidebar (Ctrl+B)" onClick={() => setSidebarOpen(open => !open)}><I.Sidebar /></button>
            <div className="toolbar-title">
              <h1>{current?.name ?? 'Library'}</h1>
              <div className="muted small">
                {sourceName} · {selected.size ? `${count(selected.size)} of ${plural(list.length, 'item')} selected` : plural(list.length, 'item')}
              </div>
            </div>
            <div className="toolbar-actions">
              {device && <button className="ghost icon" aria-label="Refresh iPhone" title="Refresh iPhone" onClick={() => void window.photos.retryDevice(source!).then(() => setRefresh(n => n + 1)).catch(e => showError(e.message))}><I.Refresh /></button>}
              {vault && privateCollection && vault.protection !== 'unlocked' ? null : selecting ? (
                <>
                  <button className="ghost" onClick={() => (allSelected ? clearSelection() : setSelected(new Set(keysAll)))}>
                    {allSelected ? 'Deselect All' : 'Select All'}
                  </button>
                  <button className="ghost select-toggle on" onClick={stopSelecting} title="Stop selecting (Esc)">
                    Cancel
                  </button>
                </>
              ) : (
                <>
                  <button className="ghost select-toggle" onClick={() => setSelecting(true)} title="Select photos and videos">
                    Select
                  </button>
                  <SaveMenu state={state} source={source!} keys={saveKeys} label={saveLabel} primary onError={showError} />
                </>
              )}
              {vault && privateCollection && vault.protection === 'unlocked' && (
                <button className="ghost lock-button" onClick={() => void window.photos.lockVault(vault.id)} title="Lock Hidden and Recently Deleted">
                  <I.Lock size={16} /> Lock
                </button>
              )}
              <button className={`ghost icon ${infoOpen ? 'on' : ''}`} onClick={() => setInfoOpen((o) => !o)} aria-label="Info" aria-pressed={infoOpen} title="Info (Ctrl+I)"><I.Info /></button>
            </div>
            <div className="toolbar-controls">
            {timeViews ? (
              <div className="tabs" role="tablist" aria-label="Group photos by">
                {VIEWS.map((v) => (
                  <button
                    key={v.id}
                    role="tab"
                    aria-selected={view === v.id}
                    tabIndex={view === v.id ? 0 : -1}
                    className={view === v.id ? 'tab on' : 'tab'}
                    onKeyDown={e => {
                      const delta = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0
                      if (!delta) return
                      e.preventDefault()
                      const next = VIEWS[(VIEWS.findIndex(x => x.id === view) + delta + VIEWS.length) % VIEWS.length]!
                      setView(next.id); setScrollTo(null)
                      const tabs = e.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>('[role="tab"]')
                      tabs?.[VIEWS.findIndex(x => x.id === next.id)]?.focus()
                    }}
                    onClick={() => {
                      setScrollTo(null)
                      setView(v.id)
                    }}
                  >
                    {v.name}
                  </button>
                ))}
              </div>
            ) : <span className="collection-kind">{current?.kind === 'album' ? 'Album' : 'Collection'}</span>}
              <label className="zoom" title="Tile size">
                <I.Grid size={14} />
                <input type="range" min={-14} max={-3} value={-zoom} onChange={(e) => setZoom(-Number(e.target.value))} aria-label="Tile size" />
              </label>
            </div>
          </header>
        )}

        {showToolbar && viewer === null && selecting && <div className="selection-bar">
          <span className="selection-count">{selected.size ? `${count(selected.size)} selected` : 'Click photos and videos to select them'}</span>
          {selected.size > 0 && <>
            {vault && <VaultActions key={source! + collection} source={source!} keys={[...selected]} collection={collection}
              onEdit={() => setEditor(list.find(i => i.key === [...selected][0]) ?? null)}
              onChanged={() => { setViewer(null); setRefresh(n => n + 1); stopSelecting() }} onError={showError} />}
            <SaveMenu state={state} source={source!} keys={[...selected]} label={`Save ${count(selected.size)} to…`} primary onError={showError} />
          </>}
        </div>}
        {vault?.protectionError && <div className="collection-note bad" role="alert">Protection incomplete: {vault.protectionError}</div>}
        {showToolbar && collection === 'deleted' && <div className="collection-note">
          {vault ? 'Deleted items are encrypted and stay here until you recover them or delete them permanently.' : "Recently Deleted on your iPhone. You can view and save these here; recover or delete them on the iPhone. Theia never keeps copies of them in its cache."}
        </div>}
        {showToolbar && collection === 'hidden' && <div className="collection-note">
          {vault ? 'Hidden items are encrypted in the vault folder and left out of the library and albums. Theia asks for the passcode to show them.' : "Hidden on your iPhone. Change what's hidden on the iPhone. Some originals may not be readable over USB. Theia never keeps copies of them in its cache."}
        </div>}
        <div className="stage">
          {body}
          {viewer !== null && source && items && (
            <Viewer
              source={source}
              items={items}
              index={viewer}
              infoOpen={infoOpen}
              onIndex={(i) => {
                setViewer(i)
                setFocusKey(items[i]!.key)
              }}
              onClose={() => {
                setScrollTo(items[viewer]?.key ?? null)
                setViewer(null)
              }}
              onInfo={() => setInfoOpen((o) => !o)}
              onSidebar={() => setSidebarOpen(open => !open)}
              sidebarOpen={sidebarOpen}
              converting={state.converting}
              onError={showError}
              frameSave={(frameKey) => <SaveMenu state={state} source={source} keys={[frameKey]} framesOnly label="Save this frame to…" onError={showError} />}
              onBurstChanged={(kept) => {
                setRefresh((n) => n + 1)
                if (kept) setNotice('Frame kept as its own photo.')
              }}
              saveButton={
                <>
                  {vault && <VaultActions source={source} keys={[items[viewer]!.key]} collection={collection}
                    onEdit={() => setEditor(items[viewer]!)}
                    onChanged={() => { setViewer(null); setRefresh(n => n + 1); clearSelection() }} onError={showError} />}
                  <SaveMenu state={state} source={source} keys={[items[viewer]!.key]} label="Save to..." onError={showError} />
                </>
              }
            />
          )}
        </div>

        {editor && source && <Editor key={source + editor.key} source={source} item={editor}
          onClose={() => setEditor(null)} onSaved={(key) => {
            setEditor(null); setViewer(null); setRefresh(n => n + 1); setScrollTo(key); setFocusKey(key); setNotice('Edited copy saved. Your original is unchanged.')
          }} />}
        {protect && protect.kind === 'setup' && (
          <SetUpProtection
            vault={protect.vault}
            vaultName={state.vaults.find((v) => v.id === protect.vault)?.name ?? 'this vault'}
            onCancel={() => setProtect(null)}
            onDone={() => {
              setNotice(
                protect.fromAction
                  ? 'Hidden and Recently Deleted are now encrypted. Hide or delete again to finish.'
                  : 'Hidden and Recently Deleted are now encrypted.',
              )
              setProtect(null)
            }}
          />
        )}
        {protect && protect.kind === 'unlock' && (
          <UnlockDialog
            vault={protect.vault}
            vaultName={state.vaults.find((v) => v.id === protect.vault)?.name ?? 'this vault'}
            onCancel={() => setProtect(null)}
            onDone={() => {
              if (protect.fromAction) setNotice('Unlocked. Try that again.')
              setProtect(null)
            }}
          />
        )}
        {vaultDialog && (
          <VaultDialog
            id={vaultDialog}
            onClose={() => setVaultDialog(null)}
            onGone={(message) => {
              if (source === vaultDialog) choose(null)
              setVaultDialog(null)
              setNotice(message)
            }}
            onError={showError}
          />
        )}
        {notice && (
          <div className="toast" role="alert">
            <span>{notice}</span>
            <button className="ghost icon" onClick={() => setNotice(null)} aria-label="Dismiss">
              <I.Close size={14} />
            </button>
          </div>
        )}
        <StatusBar state={state} />
      </main>

      {infoOpen && source && ready && (
        <InfoPanel
          key={`${source}:${infoKey}:${sourceRevision}`}
          source={source}
          itemKey={infoKey}
          selectedCount={selected.size}
          mapsEnabled={state.settings.mapsEnabled}
          onClose={() => setInfoOpen(false)}
          saveButton={
            infoKey && <SaveMenu state={state} source={source} keys={[infoKey]} label="Save this to…" onError={showError} />
          }
        />
      )}
      {preferences && <Preferences settings={state.settings} page={preferences} onPage={setPreferences} onClose={() => setPreferences(null)} />}
    </div>
  )
}
