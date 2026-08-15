import { useEffect, useState } from 'react'

import { Home } from './screens/Home.js'
import { Admin } from './screens/Admin.js'
import { History } from './screens/History.js'
import { Lobbies } from './screens/Lobbies.js'
import { Leaderboard } from './screens/Leaderboard.js'
import { Lobby } from './screens/Lobby.js'
import { Match } from './screens/Match.js'
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
  | { screen: 'lobby'; roomCode: string }
  | { screen: 'match'; roomCode: string; seatToken: string; websocketUrl: string }
  | { screen: 'leaderboard' }
  | { screen: 'lobbies' }
  | { screen: 'history' }
  | { screen: 'admin' }

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

  if (/^\/leaderboard\/?$/.test(path)) return { screen: 'leaderboard' }
  // D31 — the open-room list, so a game can be found without a link.
  if (/^\/lobbies\/?$/.test(path)) return { screen: 'lobbies' }
  // D34 — history is public; the dashboard behind it is not (the *server* enforces that, not
  // this route — a client-side check would only hide the buttons).
  if (/^\/history\/?$/.test(path)) return { screen: 'history' }
  if (/^\/admin\/?$/.test(path)) return { screen: 'admin' }

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
          onBack={() => {
            history.pushState(null, '', '/')
            setRoute({ screen: 'home' })
          }}
        />
      )

    case 'home':
      return (
        <Home
          onCreated={(roomCode) => {
            history.pushState(null, '', `/j/${roomCode}`)
            setRoute({ screen: 'lobby', roomCode })
          }}
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
