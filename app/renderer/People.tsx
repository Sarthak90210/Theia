import { useEffect, useId, useRef, useState } from 'react'
import { mediaUrl, type AppState, type PersonInfo, type SourceId } from '../shared/api.ts'
import { count, plural } from './format.ts'
import * as I from './icons.tsx'

/**
 * People in a vault. Groups waiting for a name come first, as "Who's this?"
 * cards to name right there; named people follow as faces to open. Naming a
 * group with a name someone already has adds those photos to that person.
 */
export function PeoplePage({ source, state, onOpen, onNotice, onError, sidebarOpen, onSidebar }: {
  source: SourceId
  state: AppState
  onOpen: (id: number) => void
  onNotice: (message: string) => void
  onError: (message: string) => void
  sidebarOpen: boolean
  onSidebar: () => void
}) {
  const [people, setPeople] = useState<PersonInfo[] | null>(null)
  const [hidden, setHidden] = useState<PersonInfo[] | null>(null)
  const [showHidden, setShowHidden] = useState(false)
  const [reload, setReload] = useState(0)
  const [maybe, setMaybe] = useState<{ person: PersonInfo; other: PersonInfo; score: number }[]>([])
  const revision = state.search.peopleRevision

  useEffect(() => {
    let live = true
    window.photos.people(source).then((p) => live && setPeople(p)).catch((e: Error) => live && onError(e.message))
    window.photos.peopleSuggestions(source).then((s) => live && setMaybe(s)).catch(() => {})
    if (showHidden) window.photos.people(source, true).then((p) => live && setHidden(p.filter((x) => x.hidden))).catch(() => {})
    return () => { live = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source, revision, reload, showHidden])

  const named = people?.filter((p) => p.name !== null) ?? []
  const unnamed = people?.filter((p) => p.name === null) ?? []
  const names = named.map((p) => p.name!)
  const indexing = state.search.indexing
  const vaultName = state.vaults.find((v) => v.id === source)?.name

  const name = async (p: PersonInfo, value: string) => {
    try {
      const r = await window.photos.namePerson(source, p.id, value)
      const into = people?.find((x) => x.id === r.person)
      onNotice(r.merged ? `Added to ${into?.name ?? value.trim()}.` : `Named ${value.trim()}.`)
      setReload((n) => n + 1)
    } catch (e) {
      onError((e as Error).message)
    }
  }
  const answer = async (a: PersonInfo, b: PersonInfo, same: boolean) => {
    try {
      await window.photos.answerSuggestion(source, a.id, b.id, same)
      if (same) onNotice(a.name || b.name ? `Added to ${a.name ?? b.name}.` : 'Put together as one person.')
      setReload((n) => n + 1)
    } catch (e) {
      onError((e as Error).message)
    }
  }
  const hide = async (p: PersonInfo, hide: boolean) => {
    try {
      await window.photos.hidePerson(source, p.id, hide)
      if (hide) onNotice('Hidden from People. Their faces stay with them, so they won’t be asked about again.')
      setReload((n) => n + 1)
    } catch (e) {
      onError((e as Error).message)
    }
  }

  return (
    <>
      <header className="toolbar people-toolbar">
        <button className="ghost icon sidebar-toggle" aria-label={sidebarOpen ? 'Hide sidebar' : 'Show sidebar'} aria-pressed={sidebarOpen} title="Toggle sidebar (Ctrl+B)" onClick={onSidebar}><I.Sidebar /></button>
        <div className="toolbar-title">
          <h1>People</h1>
          <div className="muted small">
            {vaultName}{named.length ? ` · ${plural(named.length, 'person', 'people')}` : ''}{unnamed.length ? ` · ${count(unnamed.length)} to name` : ''}
            {indexing && indexing.vault === vaultName && ` · still looking at photos, ${count(indexing.done)} of ${count(indexing.total)}`}
          </div>
        </div>
      </header>
      <div className="people-page">
        {people === null ? (
          <div className="people-grid">{Array.from({ length: 8 }, (_, i) => <div key={i} className="person-tile skeleton" />)}</div>
        ) : people.length === 0 ? (
          <div className="empty">
            <div className="empty-symbol"><I.Person size={30} /></div>
            <h2>{indexing ? 'Looking for people' : 'No people yet'}</h2>
            <p className="muted">{indexing
              ? 'Theia is looking at this vault’s photos. People appear here as soon as someone has been seen in three photos.'
              : 'People appear here once someone has been seen in three or more photos.'}</p>
          </div>
        ) : null}

        {maybe.length > 0 && (
          <section className="people-section">
            <h2>Same person?</h2>
            <p className="muted small">These look alike. Put them together if they are one person, or say they are different and Theia won’t ask again.</p>
            <div className="same-grid">
              {maybe.map(({ person, other }) => (
                <div key={`${person.id}-${other.id}`} className="same-card">
                  <div className="same-faces">
                    {[person, other].map((p) => (
                      <button key={p.id} className="who-face" onClick={() => onOpen(p.id)} title="See their photos">
                        <Face source={source} face={p.cover} size={84} />
                        <span className="small">{p.name ?? plural(p.photos, 'photo')}</span>
                      </button>
                    ))}
                  </div>
                  <div className="same-buttons">
                    <button className="primary small" onClick={() => void answer(person, other, true)}>Same person</button>
                    <button className="ghost small" onClick={() => void answer(person, other, false)}>Different</button>
                  </div>
                </div>
              ))}
            </div>
          </section>
        )}

        {unnamed.length > 0 && (
          <section className="people-section">
            <h2>Who’s this?</h2>
            <p className="muted small">Name the people Theia found. Use a name you have used before to add more photos to that person.</p>
            <div className="who-grid">
              {unnamed.map((p) => (
                <WhoCard key={p.id} source={source} person={p} names={names} onName={(v) => void name(p, v)} onOpen={() => onOpen(p.id)} onHide={() => void hide(p, true)} />
              ))}
            </div>
          </section>
        )}

        {named.length > 0 && (
          <section className="people-section">
            <h2>People</h2>
            <div className="people-grid">
              {named.map((p) => (
                <button key={p.id} className="person-tile" onClick={() => onOpen(p.id)} title={`${p.name}: ${plural(p.photos, 'photo')}`}>
                  <Face source={source} face={p.cover} />
                  <span className="person-name">{p.name}</span>
                  <span className="muted small">{plural(p.photos, 'photo')}</span>
                </button>
              ))}
            </div>
          </section>
        )}

        {people !== null && (
          <section className="people-section">
            <button className="ghost small" onClick={() => setShowHidden((s) => !s)} aria-expanded={showHidden}>
              {showHidden ? 'Hide the hidden people' : 'Show hidden people, statues and drawings'}
            </button>
            {showHidden && hidden && (hidden.length === 0
              ? <p className="muted small">Nobody is hidden.</p>
              : <div className="people-grid">
                {hidden.map((p) => (
                  <div key={p.id} className="person-tile hidden-person">
                    <Face source={source} face={p.cover} />
                    <span className="person-name">{p.name ?? (p.kind === 'object' ? 'Statue or drawing' : 'Unnamed')}</span>
                    {p.kind === 'object' && <span className="muted small">Hidden by Theia</span>}
                    <button className="ghost small" onClick={() => void hide(p, false)}>{p.kind === 'object' ? 'It’s a real person' : 'Show in People'}</button>
                  </div>
                ))}
              </div>)}
          </section>
        )}
      </div>
    </>
  )
}

/** A face, round. */
export function Face({ source, face, size }: { source: SourceId; face: number | null; size?: number }) {
  const [failed, setFailed] = useState(false)
  useEffect(() => setFailed(false), [face])
  const style = size ? { width: size, height: size } : undefined
  if (face === null || failed) return <span className="face-circle empty-face" style={style}><I.Person size={size ? size / 2.5 : 28} /></span>
  return <img className="face-circle" style={style} src={mediaUrl(source, String(face), 'face')} alt="" draggable={false} onError={() => setFailed(true)} />
}

/** An unnamed group: their face, how many photos, and a box to name them. */
function WhoCard({ source, person, names, onName, onOpen, onHide }: {
  source: SourceId
  person: PersonInfo
  names: string[]
  onName: (name: string) => void
  onOpen: () => void
  onHide: () => void
}) {
  const [value, setValue] = useState('')
  const list = useId()
  const merging = names.find((n) => n.toLowerCase() === value.trim().toLowerCase())
  return (
    <div className="who-card">
      <button className="who-face" onClick={onOpen} title="See their photos">
        <Face source={source} face={person.cover} size={112} />
      </button>
      <span className="muted small">{plural(person.photos, 'photo')}</span>
      <form className="who-form" onSubmit={(e) => { e.preventDefault(); if (value.trim()) onName(value) }}>
        <input
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder="Add a name"
          aria-label="Name this person"
          list={list}
          maxLength={80}
          spellCheck={false}
          autoComplete="off"
        />
        <datalist id={list}>{names.map((n) => <option key={n} value={n} />)}</datalist>
        <button type="submit" className="primary small" disabled={!value.trim()}>{merging ? 'Add' : 'Save'}</button>
      </form>
      {merging && <span className="muted small">Adds these photos to {merging}</span>}
      <button className="ghost small who-hide" onClick={onHide} title="Leave them out of People: someone in the background, a stranger">Not someone I know</button>
    </div>
  )
}

/**
 * The person's name in the toolbar of their photos, with a way to change it.
 * Saving a name someone else has merges them, and the window follows.
 */
export function PersonTitle({ source, person, names, onRenamed, onError }: {
  source: SourceId
  person: PersonInfo
  names: string[]
  onRenamed: (person: number, merged: boolean, name: string) => void
  onError: (message: string) => void
}) {
  const [editing, setEditing] = useState(person.name === null)
  const [value, setValue] = useState(person.name ?? '')
  const input = useRef<HTMLInputElement>(null)
  const list = useId()
  useEffect(() => { setValue(person.name ?? ''); setEditing(person.name === null) }, [person.id, person.name])
  useEffect(() => { if (editing && person.name !== null) input.current?.select() }, [editing, person.name])

  if (!editing) {
    return (
      <h1 className="person-title">
        <Face source={source} face={person.cover} size={34} />
        <span>{person.name}</span>
        <button className="ghost small" onClick={() => setEditing(true)}>Rename</button>
      </h1>
    )
  }
  const save = async () => {
    const v = value.trim()
    if (!v || v === person.name) return setEditing(person.name === null)
    try {
      const r = await window.photos.namePerson(source, person.id, v)
      onRenamed(r.person, r.merged, v)
    } catch (e) {
      onError((e as Error).message)
    }
  }
  return (
    <form className="person-title editing" onSubmit={(e) => { e.preventDefault(); void save() }}>
      <Face source={source} face={person.cover} size={34} />
      <input
        ref={input}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Escape' && person.name !== null) { e.preventDefault(); e.stopPropagation(); setEditing(false) } }}
        placeholder="Who is this?"
        aria-label="Name this person"
        list={list}
        maxLength={80}
        spellCheck={false}
        autoComplete="off"
        autoFocus={person.name !== null}
      />
      <datalist id={list}>{names.filter((n) => n !== person.name).map((n) => <option key={n} value={n} />)}</datalist>
      <button type="submit" className="primary small" disabled={!value.trim()}>Save</button>
      {person.name !== null && <button type="button" className="ghost small" onClick={() => setEditing(false)}>Cancel</button>}
    </form>
  )
}
