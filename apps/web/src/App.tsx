import { useEffect, useState } from 'react'

import { Home } from './screens/Home.js'
import { Host } from './screens/Host.js'
import { Admin } from './screens/Admin.js'
import { History } from './screens/History.js'
import { Lobbies } from './screens/Lobbies.js'
import { Leaderboard } from './screens/Leaderboard.js'
import { Lobby } from './screens/Lobby.js'
import { Match } from './screens/Match.js'
import { Tournament } from './screens/Tournament.js'
import { NewTournament } from './screens/NewTournament.js'
import { Organizer } from './screens/Organizer.js'
import { recallSeat, rememberSeat } from './transport.js'

/**
 * Routing, such as it is.
 *
 * Three URLs, no router dependency:
 *
 *   - `/`          — create or join
 *   - `/j/:code`   — the lobby a join link points at (D20: the code and nothing else)
 *   - `/r/:code#…` — a resume link, the token in the fragment so it never reaches a server log
 *
 * The fragment placement is deliberate. The seat token is a bearer credential (D17); putting it
 * in the query string would put it in the Worker's request logs and in any proxy between here
 * and there. A fragment is never sent.
 */

type Route =
  | { screen: 'home' }
  | { screen: 'host' }
  | { screen: 'lobby'; roomCode: string }
  | { screen: 'match'; roomCode: string; seatToken: string; websocketUrl: string }
  | { screen: 'leaderboard'; board: 'players' | 'heroes' | 'stats' }
  | { screen: 'lobbies' }
  | { screen: 'history' }
  | { screen: 'admin' }
  | { screen: 'tournament'; code: string }
  | { screen: 'organizer'; code: string }
  | { screen: 'new-tournament' }

function readRoute(): Route {
  const path = location.pathname
  const resume = /^\/r\/([A-Z0-9]{6})\/?$/i.exec(path)
  if (resume) {
    const roomCode = resume[1]!.toUpperCase()
    const token = location.hash.replace(/^#/, '')
    if (token) {
      const websocketUrl = wsUrlFor(roomCode)
      // Persist immediately, then strip the token from the address bar: a resume link that
      // stays in the URL is one screenshot away from being someone else's seat.
      rememberSeat(roomCode, { seatToken: token, websocketUrl })
      history.replaceState(null, '', `/j/${roomCode}`)
      return { screen: 'match', roomCode, seatToken: token, websocketUrl }
    }
  }

  const join = /^\/j\/([A-Z0-9]{6})\/?$/i.exec(path)
  if (join) {
    const roomCode = join[1]!.toUpperCase()
    // D17 — "a refresh reconnects with no user action at all".
    const stored = recallSeat(roomCode)
    return stored
      ? {
          screen: 'match',
          roomCode,
          seatToken: stored.seatToken,
          websocketUrl: stored.websocketUrl,
        }
      : { screen: 'lobby', roomCode }
  }

  // The host's form, which was the front page until the front page became a menu.
  if (/^\/host\/?$/.test(path)) return { screen: 'host' }
  if (/^\/leaderboard\/?$/.test(path)) return { screen: 'leaderboard', board: 'players' }
  /*
   * D45 — the hero board is the leaderboard's other half rather than a screen of its own: the
   * question is the same one at a different grain, and two pages would be two places to look for
   * it. Its own URL, though, because a board worth arguing about is worth linking to.
   */
  if (/^\/heroes\/?$/.test(path)) return { screen: 'leaderboard', board: 'heroes' }
  // D50 — the third board. Same screen again: three answers to "how are we doing", not three pages.
  if (/^\/stats\/?$/.test(path)) return { screen: 'leaderboard', board: 'stats' }
  // D31 — the open-room list, so a game can be found without a link.
  if (/^\/lobbies\/?$/.test(path)) return { screen: 'lobbies' }
  // D34 — history is public; the dashboard behind it is not (the *server* enforces that, not
  // this route — a client-side check would only hide the buttons).
  // D37 Phase 8 — `/tournaments` is the same screen. The tournament index is history, and a
  // second page listing one panel of it would be a second thing to keep in step.
  if (/^\/(history|tournaments)\/?$/.test(path)) return { screen: 'history' }
  if (/^\/admin\/?$/.test(path)) return { screen: 'admin' }
  // D37 Phase 9 — creating one. Linked from the front door, unlike `/admin` and the console:
  // starting a tournament is an ordinary thing to want, and a feature nobody can reach is a
  // feature that was not delivered.
  if (/^\/organizer\/?$/.test(path)) return { screen: 'new-tournament' }
  /*
   * D37 — the tournament page. Public, so no token is required to reach it; an entrant's link
   * carries theirs in the **fragment**, which never leaves the browser and is handed on to the
   * match page when they go to play.
   */
  const tournament = /^\/t\/(T-[A-Z0-9]{6})\/?$/i.exec(path)
  if (tournament) return { screen: 'tournament', code: tournament[1]!.toUpperCase() }
  /*
   * Phase 7 — the organiser console. Unlinked from anywhere, like `/admin`: hiding it is not the
   * security measure (the organiser token is), it just keeps a screen full of destructive controls
   * out of the way of the people who are only here to play.
   */
  const running = /^\/t\/(T-[A-Z0-9]{6})\/run\/?$/i.exec(path)
  if (running) return { screen: 'organizer', code: running[1]!.toUpperCase() }

  return { screen: 'home' }
}

function wsUrlFor(roomCode: string): string {
  const scheme = location.protocol === 'https:' ? 'wss' : 'ws'
  return `${scheme}://${location.host}/api/match/${roomCode}/ws`
}

export function App() {
  const [route, setRoute] = useState<Route>(readRoute)

  useEffect(() => {
    const onPop = (): void => setRoute(readRoute())
    addEventListener('popstate', onPop)
    return () => removeEventListener('popstate', onPop)
  }, [])

  const home = () => {
    history.pushState(null, '', '/')
    setRoute({ screen: 'home' })
  }

  switch (route.screen) {
    case 'history':
      return <History onBack={home} />

    case 'admin':
      return <Admin onBack={home} />

    case 'tournament':
      return <Tournament code={route.code} onBack={home} />

    case 'organizer':
      return <Organizer code={route.code} onBack={home} />
    case 'new-tournament':
      return <NewTournament onBack={home} />

    case 'lobbies':
      return (
        <Lobbies
          onBack={() => {
            history.pushState(null, '', '/')
            setRoute({ screen: 'home' })
          }}
        />
      )

    case 'leaderboard':
      return (
        <Leaderboard
          board={route.board}
          onBack={() => {
            history.pushState(null, '', '/')
            setRoute({ screen: 'home' })
          }}
        />
      )

    case 'home':
      return <Home />

    case 'host':
      return (
        <Host
          onCreated={(roomCode) => {
            history.pushState(null, '', `/j/${roomCode}`)
            setRoute({ screen: 'lobby', roomCode })
          }}
          onBack={home}
        />
      )

    case 'lobby':
      return (
        <Lobby
          roomCode={route.roomCode}
          onSeated={(seatToken, websocketUrl) =>
            setRoute({ screen: 'match', roomCode: route.roomCode, seatToken, websocketUrl })
          }
        />
      )

    case 'match':
      return (
        <Match
          roomCode={route.roomCode}
          seatToken={route.seatToken}
          websocketUrl={route.websocketUrl}
        />
      )
  }
}
