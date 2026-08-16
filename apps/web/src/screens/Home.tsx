/**
 * The front door: five things you might have come to do, and nothing else.
 *
 * It used to be the host's form — mode cards, parameters, forty-five portraits for the optional
 * ban list, then a join field underneath. That meant everyone met a setup screen for a game they
 * might not be starting, and the things most visitors actually wanted (take a seat, see the
 * table) were four small links above it. The form is at `/host` now and this page chooses.
 *
 * Ordered by what somebody arriving at the bare URL is most likely to want: joining a game beats
 * hosting one, because a room only ever has one host and everyone else is a joiner. The two
 * record pages come last — they are worth reading and nobody is blocked on them.
 *
 * Plain links rather than click handlers. Every one of these is a real URL that already worked
 * (`App.tsx` reads them on load), so they survive a bookmark, a middle click, and a share.
 */
const MENU = [
  {
    href: '/lobbies',
    name: 'Join a game',
    blurb: 'Take an open seat, or use a room code somebody sent you',
    primary: true,
  },
  {
    href: '/host',
    name: 'Host a game',
    blurb: 'Choose the mode and the rules, then send the link',
  },
  {
    /*
     * D37 — the door to the tournament layer, and the only part of it that has to be findable.
     * Everything else about a tournament is reached from a link the organizer hands you.
     */
    href: '/organizer',
    name: 'Host a tournament',
    blurb: 'A bracket of any size, any mode, single or double elimination',
  },
  { href: '/leaderboard', name: 'Leaderboard', blurb: 'Who is ahead, and by how much' },
  { href: '/history', name: 'History', blurb: 'Every match played, round by round' },
]

export function Home() {
  return (
    <main className="screen">
      {/* The front door should look like the thing it opens. */}
      <header className="hero">
        <h1 className="title">Ban &amp; Pick</h1>
        <p className="hero__sub">Dice Throne · draft, ban, and settle it</p>
      </header>

      <nav className="menu" aria-label="Main menu">
        {MENU.map((item) => (
          <a
            key={item.href}
            className={`menucard ${item.primary ? 'menucard--primary' : ''}`}
            href={item.href}
          >
            <span className="menucard__name">{item.name}</span>
            <span className="menucard__blurb">{item.blurb}</span>
          </a>
        ))}
      </nav>
    </main>
  )
}
