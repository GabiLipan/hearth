import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Users, User, Layers, type LucideIcon } from 'lucide-react'
import { BOOK_HINT, BOOK_LABEL, type BookId } from '../lib/books'
import { useBook } from '../lib/cache'
import { CHROME_FROST, PILL_BOUNCE_MS, pillBounce, motionOk, cx } from './ui'
import { Segmented } from './ui'

/**
 * Three options and a month stepper still do not fit "Our household" across a
 * phone, however the widths are shared out, so there is a short form under
 * `md`. It is not an abbreviation so much as the same idea in fewer words.
 *
 * The icons are PEOPLE — two, one, the stack — and deliberately not a house.
 * `household` wore `Home` for as long as the lens lived inside the page, where
 * the surrounding words said what it was. In the phone's top-left corner, in an
 * app whose first tab is also a house, it stopped reading as a lens at all and
 * started reading as "go home"; the control became invisible to the person
 * looking for it. A book is a question about whose money this is, so it asks it
 * with people, and `Home` is left to mean exactly one thing in the app.
 */
const BOOKS: { id: BookId; icon: LucideIcon; short: string }[] = [
  // The long labels are BOOK_LABEL. They fit because `Segmented` sizes each
  // option to its own content now: "Our household" being wider than "Mine" is
  // simply what it is, rather than forcing all three to be that wide.
  { id: 'household', icon: Users, short: 'Ours' },
  { id: 'mine', icon: User, short: 'Mine' },
  { id: 'all', icon: Layers, short: 'All' },
]

/**
 * Which set of books this page is showing.
 *
 * A lens, not a filter. "Our household" and "Mine" are not two subsets of one
 * total — they are two different accounts of what happened, and the numbers in
 * them are not meant to add up to each other. `Everything` is kept because
 * balances across the lot are a real question, and because it is what every
 * screen used to show; taking it away would make figures people recognise
 * disappear with no way back to them.
 */
export function BookSwitcher({
  book,
  onChange,
  className,
}: {
  book: BookId
  onChange: (next: BookId) => void
  className?: string
}) {
  return (
    <Segmented
      value={book}
      onChange={onChange}
      className={className}
      options={BOOKS.map(({ id, icon: Icon, short }) => ({
        value: id,
        label: (
          <span className="flex items-center justify-center gap-1.5" title={BOOK_HINT[id]}>
            <Icon size={14} className="shrink-0" />
            <span className="md:hidden">{short}</span>
            <span className="hidden md:inline">{BOOK_LABEL[id]}</span>
          </span>
        ),
      }))}
    />
  )
}

/**
 * The same lens, in the phone's header.
 *
 * It is one setting for the whole app — `useBook` is a single value with
 * subscribers, not a copy per screen — so drawing it inside each page was a
 * claim the app never meant, and an expensive one: a full-width 44px row on six
 * pages, and on Home, Bills and Goals it WAS the toolbar. In the header it is
 * both cheaper and more findable, because it is the one control that is now
 * always in the same place.
 *
 * Tinted rather than plain, so "you are looking at your own money" reads
 * without opening anything — which is the whole job of a lens indicator.
 *
 * Phone only. A wide screen keeps the segmented control in the page: it has the
 * room, all three options are visible at once there, and hiding two of them
 * behind a menu would be a downgrade bought with space nobody needed.
 */
export function BookLens({ onOpenChange }: { onOpenChange?: (open: boolean) => void }) {
  const [book, setBook] = useBook()
  const [open, setOpen] = useState(false)
  // The header needs to know, because what it shows in the middle sits exactly
  // where this expands to. Reported rather than lifted: the open state is this
  // control's own business, and everything else here reads better for it being
  // local.
  useEffect(() => onOpenChange?.(open), [open, onOpenChange])
  const boxRef = useRef<HTMLDivElement>(null)
  const shutRef = useRef<HTMLButtonElement>(null)
  const openRef = useRef<HTMLDivElement>(null)
  const current = BOOKS.find((b) => b.id === book) ?? BOOKS[0]
  const Icon = current.icon

  /**
   * The width, measured then animated — the same order `BottomTabs` uses, and
   * for the same reason: the resting value is written to the element first, so
   * however the animation ends (or never ends, in a backgrounded tab, where no
   * finish event is delivered) the pill is already the size it should be. The
   * animation carries no `fill` and is decoration over a layout that is
   * correct.
   *
   * Both halves are `absolute` and `w-max`, so each measures its own natural
   * width whatever the box around them is currently doing — which is what makes
   * "how wide will this be once it opens" answerable before it opens. `book` is
   * a dependency because the closed pill is as wide as the word in it, and
   * "Ours" and "Mine" are not the same width.
   */
  useLayoutEffect(() => {
    const box = boxRef.current
    const target = open ? openRef.current : shutRef.current
    if (!box || !target) return
    const to = target.getBoundingClientRect().width
    const from = box.getBoundingClientRect().width
    box.getAnimations().forEach((a) => a.cancel())
    box.style.width = `${to}px`
    // `from` is 0 on the very first pass — the box has no in-flow content, so
    // there is nothing to travel from and nothing worth animating.
    if (!from || Math.abs(from - to) < 0.5 || !motionOk()) return
    box.animate([{ width: `${from}px` }, { width: `${to}px` }], {
      duration: PILL_BOUNCE_MS,
      easing: pillBounce(),
    })
  }, [open, book])

  // Closing on an outside press is `pointerdown` rather than `click` so the
  // pill is already shrinking as the finger lands somewhere else, and the
  // capture phase so a press inside a scroller still reaches it.
  useEffect(() => {
    if (!open) return
    const away = (e: PointerEvent) => {
      if (!boxRef.current?.contains(e.target as Node)) setOpen(false)
    }
    const esc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('pointerdown', away, true)
    document.addEventListener('keydown', esc)
    return () => {
      document.removeEventListener('pointerdown', away, true)
      document.removeEventListener('keydown', esc)
    }
  }, [open])

  /** A radio group's arrow key chooses rather than merely pointing. */
  function onKey(e: React.KeyboardEvent) {
    const step = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0
    if (!step) return
    e.preventDefault()
    const i = BOOKS.findIndex((b) => b.id === book)
    const next = BOOKS[(i + step + BOOKS.length) % BOOKS.length]
    setBook(next.id)
    openRef.current?.querySelector<HTMLElement>(`[data-book="${next.id}"]`)?.focus()
  }

  return (
    <div
      ref={boxRef}
      className={cx(
        // `h-11` is `CONTROL_H`'s touch height, so the lens, the settings button
        // and the add button are one size across the whole top and bottom edge.
        'pointer-events-auto relative h-11 shrink-0 overflow-hidden rounded-full',
        // Exactly what the settings disc wears, and nothing else. A tint alone
        // is what this used to be, and it was legible only because it sat on a
        // solid bar; floating over the rows, `bg-accent/12` is 12% of whatever
        // transaction happens to be underneath. The frost is what makes a
        // floating control a control.
        CHROME_FROST,
        // Closed, this is a control like any other — the accent belongs to the
        // OPTION you have chosen, and there is no option on show until it
        // opens. Two blue things in the corner of a mostly-empty header read as
        // two states of something rather than as one control and one label.
        'text-ink-2',
      )}
    >
      {/* Closed: which book you are in, said in a word rather than in colour. */}
      <button
        ref={shutRef}
        type="button"
        onClick={() => setOpen(true)}
        aria-expanded={open}
        aria-label={`Showing ${BOOK_LABEL[book]}. Change`}
        inert={open}
        className={cx(
          'absolute left-0 top-0 flex h-full w-max items-center gap-1.5 px-3.5',
          'text-sm font-semibold transition-opacity duration-150',
          open && 'opacity-0',
        )}
      >
        <Icon size={17} className="shrink-0" />
        {current.short}
      </button>

      {/* Open: three options on one line. A radio group, not a menu — there is
          nothing here to command, only a value to pick. */}
      <div
        ref={openRef}
        role="radiogroup"
        aria-label="Which book to show"
        inert={!open}
        onKeyDown={onKey}
        className={cx(
          'absolute left-0 top-0 flex h-full w-max items-center gap-0.5 p-1',
          'transition-opacity duration-150',
          open ? 'opacity-100' : 'opacity-0',
        )}
      >
        {BOOKS.map(({ id, icon: Each, short }) => {
          const on = id === book
          return (
            <button
              key={id}
              type="button"
              role="radio"
              data-book={id}
              aria-checked={on}
              title={BOOK_HINT[id]}
              tabIndex={on ? 0 : -1}
              onClick={() => {
                setBook(id)
                setOpen(false)
              }}
              className={cx(
                'flex h-9 items-center gap-1.5 rounded-full px-2.5 text-sm font-semibold transition-colors',
                on ? 'bg-accent/15 text-accent' : 'text-ink-2',
              )}
            >
              <Each size={15} className="shrink-0" />
              {short}
            </button>
          )
        })}
      </div>
    </div>
  )
}
