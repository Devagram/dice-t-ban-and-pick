import type { Character, Ruleset } from '@banpick/types'

import { MODE_BLURBS } from '../copy.js'

/**
 * The full ruleset, rendered before anyone sits down.
 *
 * §12.3: *"Joiner sees the fully rendered ruleset (mode name, parameter values, global bans,
 * tie rule) **before** taking a seat. Seating is the consent."*
 *
 * Which makes this a consent surface, not a summary card. Every parameter is shown with its
 * value spelled out rather than implied by the mode name — *"a host quietly switching from 4
 * picks to 3 is exactly the kind of change the joiner must see"* — and the global ban list is
 * shown in full rather than as a count, because "3 characters banned" is not something a person
 * can agree to.
 */
export function RulesetCard({
  modeLabel,
  ruleset,
  globalBannedCharacters,
  rosterSize,
}: {
  modeLabel: string
  ruleset: Ruleset
  globalBannedCharacters: Character[]
  rosterSize: number
}) {
  const draftCount = ruleset.parameters['draftCount']

  return (
    <section className="ruleset" aria-label="Match rules">
      <h2 className="ruleset__mode">{modeLabel}</h2>
      <p className="ruleset__blurb">{MODE_BLURBS[ruleset.modeId] ?? ''}</p>

      <dl className="ruleset__rows">
        <Row term="Characters drafted" detail="Each player, in secret.">
          {String(draftCount ?? '—')}
        </Row>

        <Row term="Rounds" detail="A 1½–1½ result is a draw; nobody takes the match.">
          Three, best score wins
        </Row>

        <Row term="Tied round" detail="Both characters are spent either way.">
          Half a point each
        </Row>

        <Row term="Mirrors" detail="But you may not draft the same character twice yourself.">
          {ruleset.constraints.crossSeatMirrors === 'ALLOWED'
            ? 'You may both draft the same character'
            : 'Forbidden'}
        </Row>

        <Row
          term="Banned by the host"
          detail={
            globalBannedCharacters.length > 0
              ? 'Out for this match, for both of you.'
              : `All ${rosterSize} characters are available.`
          }
        >
          {globalBannedCharacters.length === 0 ? (
            'Nothing'
          ) : (
            <ul className="ruleset__bans">
              {globalBannedCharacters.map((c) => (
                <li key={c.id}>{c.name}</li>
              ))}
            </ul>
          )}
        </Row>
      </dl>

      <p className="ruleset__fine">
        Ruleset {ruleset.modeContentHash} · roster {ruleset.rosterVersion}
      </p>
    </section>
  )
}

function Row({
  term,
  detail,
  children,
}: {
  term: string
  detail?: string
  children: React.ReactNode
}) {
  return (
    <div className="ruleset__row">
      <dt className="ruleset__term">{term}</dt>
      <dd className="ruleset__value">
        {children}
        {detail ? <span className="ruleset__detail">{detail}</span> : null}
      </dd>
    </div>
  )
}
