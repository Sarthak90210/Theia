import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { personCollection, personOf, searchCollection, searchQueryOf, type AppState, type Collections, type GalleryItem, type PersonInfo, type SourceId } from '../shared/api.ts'
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
import { SearchBox } from './SearchBox.tsx'
import { parseQuery } from '../../src/search/query.ts'
import { PeoplePage, PersonTitle } from './People.tsx'
import { Welcome } from './Setup.tsx'
import { applyTheme } from './theme.ts'
import { Glass, GlassMode, useGlassMode } from './glass/Glass.tsx'
import { WelcomeHero } from './WelcomeHero.tsx'

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
  /** What is typed in the search box. The search itself is the collection `search:<text>`. */
  const [searchText, setSearchText] = useState('')
  const searchInput = useRef<HTMLInputElement>(null)
  /** Where Escape or clearing the box goes back to. */
  const beforeSearch = useRef('library')
  const searchQuery = searchQueryOf(collection)
  /** What the search read as dates or kinds ("December 2025", "Videos"), and whether anything is left to match. */
  const understood = useMemo(() => (searchQuery === null ? null : parseQuery(searchQuery)), [searchQuery])
  const [items, setItems] = useState<GalleryItem[] | null>(null)
  /** The person whose photos are shown, for collection `person:<id>`. */
  const personId = personOf(collection)
  const [person, setPerson] = useState<PersonInfo | null>(null)
  const [peopleNames, setPeopleNames] = useState<string[]>([])
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

  const glassMode = useGlassMode(state?.settings.liquidGlass ?? true)
  useEffect(() => { document.documentElement.dataset.glass = glassMode }, [glassMode])
  /** Height of the glass toolbar floating over the photos, so the grid starts below it and scrolls under it. */
  const chrome = useRef<HTMLDivElement | null>(null)
  const [chromeH, setChromeH] = useState(0)
  const chromeRef = useCallback((el: HTMLDivElement | null) => {
    chrome.current = el
    if (!el) return setChromeH(0)
    const ro = new ResizeObserver(() => setChromeH(Math.ceil(el.getBoundingClientRect().height)))
    ro.observe(el)
    setChromeH(Math.ceil(el.getBoundingClientRect().height))
  }, [])

  // The chosen theme, as soon as the settings are known and whenever they change.
  const themeKey = state ? JSON.stringify([state.settings.theme, state.settings.customTheme, state.settings.liquidGlass]) : null
  useEffect(() => {
    if (state) applyTheme(state.settings)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [themeKey])

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
    setSearchText('')
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
  }, [source, ready, sourceCount, sourceRevision, refresh, state?.search.peopleRevision])

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
  }, [source, ready, collection, sourceCount, sourceRevision, refresh, personId === null ? 0 : state?.search.peopleRevision])

  useEffect(() => {
    if (!source || personId === null) { setPerson(null); return }
    let live = true
    window.photos.person(source, personId).then((p) => {
      if (!live) return
      // Merged into someone else, or gone: back to People.
      if (!p) { setCollection('people'); setItems(null); return }
      setPerson(p)
    }).catch(() => {})
    window.photos.people(source).then((list) => live && setPeopleNames(list.flatMap((x) => (x.name ? [x.name] : [])))).catch(() => {})
    return () => { live = false }
  }, [source, personId, state?.search.peopleRevision])

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

  /**
   * Show results for the typed text, or go back where the search started.
   * The current grid stays up until results arrive, so the toolbar, and the
   * search box with the caret in it, never disappear while typing.
   */
  const applySearch = (text: string) => {
    const t = text.trim()
    if (!t) {
      if (searchQuery === null) return
      setCollection(beforeSearch.current)
      setItems(null)
    } else {
      const next = searchCollection(t)
      if (next === collection) return
      if (searchQuery === null) beforeSearch.current = collection
      setCollection(next)
    }
    setView('all')
    stopSelecting()
    setViewer(null)
    setScrollTo(null)
  }

  // Search a moment after typing stops.
  useEffect(() => {
    const t = setTimeout(() => applySearch(searchText), 350)
    return () => clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchText])

  const drill = (index: number) => {
    setScrollTo(list[index]?.key ?? null)
    setView(view === 'years' ? 'months' : 'days')
  }

  const pickCollection = (id: string) => {
    setSearchText('')
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
      else if (ctrl && k === 'f') { e.preventDefault(); searchInput.current?.focus(); searchInput.current?.select() }
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
      <WelcomeHero
        liquid={glassMode === 'liquid'}
        dark={document.documentElement.dataset.theme !== 'light'}
        onOpenVault={() => void openVault()}
        onSettings={() => setPreferences('settings')}
        onShortcuts={() => setPreferences('shortcuts')}
        onPhone={() => setNotice('Plug your iPhone into this computer with a cable and unlock it. It appears in the sidebar by itself.')}
      />
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
  } else if (vault && collection === 'people') {
    body = (
      <PeoplePage
        source={vault.id}
        state={state}
        onOpen={(id) => pickCollection(personCollection(id))}
        onNotice={setNotice}
        onError={showError}
        sidebarOpen={sidebarOpen}
        onSidebar={() => setSidebarOpen((open) => !open)}
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
  } else if (!items.length && searchQuery !== null) {
    const indexing = state.search.indexing && vault && state.search.indexing.vault === vault.name ? state.search.indexing : null
    body = <div className="empty">
      <div className="empty-symbol"><I.Search size={30} /></div>
      <h2>No matches for “{searchQuery}”</h2>
      <p className="muted">{indexing
        ? `Theia is still reading this vault's photos for search (${count(indexing.done)} of ${count(indexing.total)}). Try again in a little while.`
        : 'Try describing what is in the photo, like “dinner with friends” or “snowy mountains”, words written in it, like “aadhaar”, a place or album name, or a time, like “goa last december”.'}</p>
    </div>
  } else if (!items.length) {
    body = <div className="empty">
      <div className="empty-symbol">{collection === 'hidden' ? <I.Hidden size={30} /> : collection === 'deleted' ? <I.Trash size={30} /> : <I.Album size={30} />}</div>
      <h2>{collection === 'hidden' ? 'No hidden items' : collection === 'deleted' ? 'Recently Deleted is empty' : 'Nothing here yet'}</h2>
      <p className="muted">{collection === 'hidden' ? 'Photos and videos you hide will appear here.' : collection === 'deleted' ? 'Deleted photos and videos will appear here, ready to recover.' : 'Photos and videos saved to this collection will appear here.'}</p>
    </div>
  } else {
    body = (
      <Grid
        // A new search starts at its best match, at the top.
        key={searchQuery !== null || personId !== null ? collection : 'grid'}
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
        insetTop={chromeH}
        insetBottom={88}
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
  const showToolbar = ready && items !== null && !loadError && collection !== 'people'

  return (
    <GlassMode.Provider value={glassMode}>
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

      <main className="main" style={{ '--chrome-h': `${showToolbar && viewer === null ? chromeH : 0}px` } as React.CSSProperties}>
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

        {showToolbar && viewer === null && (
          <div className="chrome-top" ref={chromeRef}>
          <header className="toolbar">
            <div className="toolbar-row">
            <Glass className="glass-group glass-round"><button className="ghost icon sidebar-toggle" aria-label={sidebarOpen ? 'Hide sidebar' : 'Show sidebar'} aria-pressed={sidebarOpen} title="Toggle sidebar (Ctrl+B)" onClick={() => setSidebarOpen(open => !open)}><I.Sidebar /></button></Glass>
            <div className="toolbar-title">
              {person && vault ? (
                <PersonTitle
                  source={vault.id}
                  person={person}
                  names={peopleNames}
                  onError={showError}
                  onRenamed={(id, merged, name) => {
                    setNotice(merged ? `Added to ${name}.` : `Named ${name}.`)
                    if (merged) pickCollection(personCollection(id))
                  }}
                />
              ) : <h1>{searchQuery !== null ? `“${searchQuery}”` : personId !== null ? 'Person' : (current?.name ?? 'Library')}</h1>}
              <div className="muted small">
                {sourceName}{understood?.labels.length ? ` · ${understood.labels.join(' · ')}` : ''} · {selected.size ? `${count(selected.size)} of ${plural(list.length, 'item')} selected` : plural(list.length, searchQuery !== null ? 'result' : 'item')}
                {searchQuery !== null && state.search.indexing && state.search.indexing.vault === vault?.name &&
                  ` · still reading photos for search, ${count(state.search.indexing.done)} of ${count(state.search.indexing.total)}`}
              </div>
            </div>
            <Glass className="glass-group toolbar-actions">
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
            </Glass>
            </div>
            <div className="toolbar-row toolbar-controls">
            {timeViews ? (
              <Glass className="glass-group glass-segmented">
              <div className="tabs" role="tablist" aria-label="Group photos by" style={{ '--tab': VIEWS.findIndex((x) => x.id === view), '--tabs': VIEWS.length } as React.CSSProperties}>
                <span className="tab-thumb" aria-hidden="true" />
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
              </Glass>
            ) : <span className="collection-kind">{understood ? (understood.text ? 'Best matches first' : 'Newest first') : personId !== null ? (
                <>
                  <button className="ghost small" onClick={() => pickCollection('people')}><I.Left size={14} /> People</button>
                  {person && <button className="ghost small" title="Leave them out of People" onClick={() => void window.photos.hidePerson(source!, person.id, !person.hidden)
                    .then(() => { setNotice(person.hidden ? 'Shown in People again.' : 'Hidden from People.'); if (!person.hidden) pickCollection('people') })
                    .catch((e: Error) => showError(e.message))}>{person.hidden ? 'Show in People' : 'Hide from People'}</button>}
                </>
              ) : current?.kind === 'album' ? 'Album' : 'Collection'}</span>}
              {vault && <Glass className="glass-group glass-search"><SearchBox
                ref={searchInput}
                value={searchText}
                onChange={setSearchText}
                onSubmit={() => applySearch(searchText)}
                onClear={() => { setSearchText(''); applySearch('') }}
              /></Glass>}
              <Glass className="glass-group glass-zoom">
              <label className="zoom" title="Tile size">
                <I.Grid size={14} />
                <input type="range" min={-14} max={-3} value={-zoom} onChange={(e) => setZoom(-Number(e.target.value))} aria-label="Tile size" />
              </label>
              </Glass>
            </div>
          </header>
          {vault?.protectionError && <div className="collection-note bad" role="alert">Protection incomplete: {vault.protectionError}</div>}
          {collection === 'deleted' && <div className="collection-note">
            {vault ? 'Deleted items are encrypted and stay here until you recover them or delete them permanently.' : "Recently Deleted on your iPhone. You can view and save these here; recover or delete them on the iPhone. Theia never keeps copies of them in its cache."}
          </div>}
          {collection === 'hidden' && <div className="collection-note">
            {vault ? 'Hidden items are encrypted in the vault folder and left out of the library and albums. Theia asks for the passcode to show them.' : "Hidden on your iPhone. Change what's hidden on the iPhone. Some originals may not be readable over USB. Theia never keeps copies of them in its cache."}
          </div>}
          </div>
        )}

        {showToolbar && viewer === null && selecting && <div className="floating-bottom"><Glass className="glass-group selection-bar" radius={26}>
          <span className="selection-count">{selected.size ? `${count(selected.size)} selected` : 'Click photos and videos to select them'}</span>
          {selected.size > 0 && <>
            {vault && person && <button className="ghost" title="Take these photos out of this person. Theia won't put them back." onClick={() => {
              const keys = [...selected]
              void window.photos.removeFromPerson(vault.id, person.id, keys)
                .then((n) => { setNotice(`${plural(n, 'photo')} taken out of ${person.name ?? 'this person'}.`); stopSelecting(); setRefresh((r) => r + 1) })
                .catch((e: Error) => showError(e.message))
            }}>Not {person.name ?? 'this person'}</button>}
            {vault && <VaultActions key={source! + collection} source={source!} keys={[...selected]} collection={collection}
              onEdit={() => setEditor(list.find(i => i.key === [...selected][0]) ?? null)}
              onChanged={() => { setViewer(null); setRefresh(n => n + 1); stopSelecting() }} onError={showError} />}
            <SaveMenu state={state} source={source!} keys={[...selected]} label={`Save ${count(selected.size)} to…`} primary onError={showError} />
          </>}
        </Glass></div>}

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
      {!state.settings.setupDone && !preferences && <Welcome settings={state.settings} onError={showError} />}
      {preferences && <Preferences settings={state.settings} page={preferences} onPage={setPreferences} onClose={() => setPreferences(null)} />}
    </div>
    </GlassMode.Provider>
  )
}
