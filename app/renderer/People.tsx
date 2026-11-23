import { useEffect, useId, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { mediaUrl, type AppState, type MaybeFace, type PersonInfo, type SourceId } from '../shared/api.ts'
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
  const [reviewing, setReviewing] = useState<PersonInfo | null>(null)
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
  const toReview = named.filter((p) => p.maybe > 0)
  const deepOn = state.settings.deepIndexing
  const lookCloser = async () => {
    try {
      await window.photos.setSettings({ deepIndexing: true })
      onNotice('Theia will look at every photo again, more closely, once it has read them all. Progress shows at the bottom.')
    } catch (e) {
      onError((e as Error).message)
    }
  }
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

        {toReview.length > 0 && (
          <section className="people-section">
            <h2>More photos of them?</h2>
            <p className="muted small">The closer look found faces that might be these people, but not surely enough to add them without asking.</p>
            <div className="same-grid">
              {toReview.map((p) => (
                <div key={p.id} className="same-card">
                  <div className="same-faces">
                    <button className="who-face" onClick={() => onOpen(p.id)} title="See their photos">
                      <Face source={source} face={p.cover} size={84} />
                      <span className="small">{p.name}</span>
                    </button>
                  </div>
                  <span className="muted small maybe-count">{plural(p.maybe, 'photo')} might be {p.name}</span>
                  <div className="same-buttons">
                    <button className="primary small" onClick={() => setReviewing(p)}>Review</button>
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

        {people !== null && people.length > 0 && !deepOn && state.settings.indexing && (
          <section className="people-section look-closer">
            <p className="muted small">Missing photos of someone? Theia can look at every photo again, more closely, for faces that are small, turned or blurred, and ask you about the ones it isn’t sure of.</p>
            <button className="ghost small" onClick={() => void lookCloser()}>Look more closely</button>
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
      {reviewing && (
        <MaybeReview
          source={source}
          person={reviewing}
          onClose={() => setReviewing(null)}
          onDone={(added) => {
            const name = reviewing.name
            setReviewing(null)
            setReload((n) => n + 1)
            if (added) onNotice(`Added ${plural(added, 'photo')} to ${name}.`)
          }}
          onError={onError}
        />
      )}
    </>
  )
}

/**
 * Faces that might be someone, each with the photo it is in, to answer yes or
 * no. Answers are sent together; faces left unanswered are asked again later.
 */
function MaybeReview({ source, person, onClose, onDone, onError }: {
  source: SourceId
  person: PersonInfo
  onClose: () => void
  onDone: (added: number) => void
  onError: (message: string) => void
}) {
  const [faces, setFaces] = useState<MaybeFace[] | null>(null)
  const [answers, setAnswers] = useState<Map<number, boolean>>(new Map())
  const [busy, setBusy] = useState(false)
  const title = useId()
  const card = useRef<HTMLDivElement>(null)

  useEffect(() => {
    let live = true
    window.photos.personMaybes(source, person.id).then((f) => live && setFaces(f)).catch((e: Error) => live && onError(e.message))
    return () => { live = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source, person.id])
  useEffect(() => { card.current?.querySelector<HTMLButtonElement>('.maybe-tile button, .dialog-buttons button')?.focus() }, [faces])

  // Pressing the same answer again takes it back.
  const answer = (face: number, yes: boolean) =>
    setAnswers((a) => {
      const next = new Map(a)
      if (next.get(face) === yes) next.delete(face)
      else next.set(face, yes)
      return next
    })
  const restYes = () => setAnswers((a) => new Map([...(faces ?? []).map((f) => [f.face, true] as const), ...a]))
  const yes = [...answers].filter(([, v]) => v).map(([k]) => k)
  const no = [...answers].filter(([, v]) => !v).map(([k]) => k)
  const save = async () => {
    setBusy(true)
    try {
      onDone(await window.photos.answerMaybes(source, person.id, yes, no))
    } catch (e) {
      onError((e as Error).message)
      setBusy(false)
    }
  }

  return (
    <div
      className="modal-scrim"
      onMouseDown={(e) => e.target === e.currentTarget && !busy && onClose()}
      onKeyDown={(e) => { if (e.key === 'Escape' && !busy) { e.stopPropagation(); onClose() } }}
    >
      <div className="confirm-dialog maybe-dialog" ref={card} role="dialog" aria-modal="true" aria-labelledby={title}>
        <div className="maybe-head">
          <Face source={source} face={person.cover} size={44} />
          <div>
            <h2 id={title}>Is this {person.name}?</h2>
            <p className="muted small">Yes adds the photo to {person.name}. No keeps it out for good. Faces you skip are asked again later.</p>
          </div>
        </div>
        {faces === null ? (
          <p className="muted">Finding them…</p>
        ) : faces.length === 0 ? (
          <p className="muted">Nothing left to ask about.</p>
        ) : (
          <div className="maybe-grid">
            {faces.map((f) => {
              const a = answers.get(f.face)
              return (
                <div key={f.face} className={`maybe-tile ${a === true ? 'yes' : a === false ? 'no' : ''}`}>
                  <Face source={source} face={f.face} size={88} />
                  <img className="maybe-photo" src={mediaUrl(source, String(f.assetId), 'sm')} alt="" draggable={false} loading="lazy" />
                  <div className="maybe-buttons">
                    <button className={`small ${a === true ? 'primary' : 'ghost'}`} aria-pressed={a === true} onClick={() => answer(f.face, true)} aria-label={`Yes, this is ${person.name}`}>Yes</button>
                    <button className={`small ${a === false ? 'primary' : 'ghost'}`} aria-pressed={a === false} onClick={() => answer(f.face, false)} aria-label={`No, not ${person.name}`}>No</button>
                  </div>
                </div>
              )
            })}
          </div>
        )}
        <div className="dialog-buttons">
          {!!faces?.length && answers.size < faces.length && <button className="ghost" onClick={restYes} disabled={busy}>Yes to the rest</button>}
          <button className="ghost" onClick={onClose} disabled={busy}>Cancel</button>
          <button className="primary" onClick={() => void save()} disabled={busy || answers.size === 0}>
            {answers.size ? `Save ${plural(answers.size, 'answer')}` : 'Save'}
          </button>
        </div>
      </div>
    </div>
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
  const [picking, setPicking] = useState(false)
  const [value, setValue] = useState(person.name ?? '')
  const input = useRef<HTMLInputElement>(null)
  const list = useId()
  useEffect(() => { setValue(person.name ?? ''); setEditing(person.name === null) }, [person.id, person.name])
  useEffect(() => { if (editing && person.name !== null) input.current?.select() }, [editing, person.name])

  if (!editing) {
    return (
      <h1 className="person-title">
        <button className="person-cover-button" onClick={() => setPicking(true)} title="Choose the photo shown for them">
          <Face source={source} face={person.cover} size={34} />
        </button>
        <span>{person.name}</span>
        <button className="ghost small" onClick={() => setEditing(true)}>Rename</button>
        <button className="ghost small" onClick={() => setPicking(true)}>Change photo</button>
        {picking && <CoverPicker source={source} person={person} onClose={() => setPicking(false)} onError={onError} />}
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

/** Their faces, clearest first: click one to show it for them in People and beside their name. */
function CoverPicker({ source, person, onClose, onError }: { source: SourceId; person: PersonInfo; onClose: () => void; onError: (message: string) => void }) {
  const [faces, setFaces] = useState<{ face: number; assetId: number }[] | null>(null)
  const [busy, setBusy] = useState(false)
  const title = useId()
  const card = useRef<HTMLDivElement>(null)
  useEffect(() => {
    let live = true
    window.photos.personFaces(source, person.id).then((f) => live && setFaces(f)).catch((e: Error) => live && onError(e.message))
    return () => { live = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source, person.id])
  useEffect(() => { card.current?.querySelector<HTMLButtonElement>('.cover-choice.on, .cover-choice, button')?.focus() }, [faces])

  const pick = async (face: number | null) => {
    setBusy(true)
    try {
      await window.photos.setPersonCover(source, person.id, face)
      onClose()
    } catch (e) {
      onError((e as Error).message)
      setBusy(false)
    }
  }

  return createPortal(
    <div className="modal-scrim" onMouseDown={(e) => e.target === e.currentTarget && !busy && onClose()} onKeyDown={(e) => { e.stopPropagation(); if (e.key === 'Escape' && !busy) onClose() }}>
      <div className="confirm-dialog maybe-dialog" ref={card} role="dialog" aria-modal="true" aria-labelledby={title}>
        <div className="maybe-head">
          <Face source={source} face={person.cover} size={44} />
          <div>
            <h2 id={title}>Choose {person.name ? `${person.name}’s` : 'their'} photo</h2>
            <p className="muted small">Shown in People and beside their name. Pick a clear one.</p>
          </div>
        </div>
        {faces === null ? (
          <p className="muted">Finding their photos…</p>
        ) : (
          <div className="cover-grid" role="listbox" aria-label="Their faces">
            {faces.map((f) => (
              <button
                key={f.face}
                role="option"
                aria-selected={f.face === person.cover}
                className={`cover-choice ${f.face === person.cover ? 'on' : ''}`}
                disabled={busy}
                onClick={() => void pick(f.face)}
                title={f.face === person.cover ? 'Shown now' : 'Show this one'}
              >
                <Face source={source} face={f.face} size={84} />
              </button>
            ))}
          </div>
        )}
        <div className="dialog-buttons">
          <button className="ghost" onClick={() => void pick(null)} disabled={busy} title="Go back to the clearest, largest face">Let Theia choose</button>
          <button className="ghost" onClick={onClose} disabled={busy}>Cancel</button>
        </div>
      </div>
    </div>,
    document.body,
  )
}
