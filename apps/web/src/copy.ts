/**
 * UI copy that carries a design decision.
 *
 * Text kept here rather than inline because these strings are not decoration — each one is the
 * user-facing half of a decision in the spec, and a rewrite of the rule should be a rewrite of
 * the string.
 */

/**
 * **Rewritten for O6**, which is the whole reason this file exists.
 *
 * §9.2's original framing was *"did they bring this, and is my ban worth the trade"* — a
 * question about reading a draft. At the ~75-character target roster you cannot read a draft:
 * the chance a named character sits among an opponent's four picks is about **5.3%**, so the
 * ban whiffs nineteen times in twenty against a stranger.
 *
 * The mode survives because friends do not draft uniformly. They draft favourites, and you
 * know theirs. So the honest question is about the *person*, not the draft — and the copy has
 * to say the true thing, or players will form a strategy the mode cannot support.
 */
export const META_BAN_PROMPT = 'What do they always play?'

export const META_BAN_HELP =
  'Ban one character from your opponent only. You are guessing at their habits, not reading ' +
  'their draft — you will not see what they brought until after this. If you both drafted the ' +
  'same character and only you ban it, you keep yours.'

export const MODE_BLURBS: Record<string, string> = {
  base: 'Both players draft in secret, then three rounds of ban and pick.',
  // Rewritten 2026-07-31, when the ban moved in front of the draft and took the repick with it.
  // The old copy still promised "anyone hit picks again", which no longer happens.
  'bring-ban1':
    'Each of you names one character to deny the other. Both bans are revealed, then you draft ' +
    'in secret knowing what is gone.',
  // D36. Says "one game" first, because that is the thing a host is choosing between and the only
  // part that cannot be changed once the room is open.
  'bo1-bring3-ban1':
    'One game. Bring three each, then you both ban one of the other’s at the same time and play ' +
    'one of the two you have left.',
}

/** D23/D24 — the turn-order holder *decides*, and may put themselves second. */
export const TURN_ORDER_PROMPT = 'You decide who plays first'

export const TURN_ORDER_HELP =
  'Both picks are on the table. You can put yourself second — knowing the matchup is sometimes ' +
  'worth more than moving first.'

/** D2 under D10 — see open item O5 on why this stopped being a preference. */
export const PRIVILEGE_PROMPT = 'You won the roll. Take one:'

export const PRIVILEGE_HELP =
  'Whichever you take, your opponent gets the other — and both swap next round.'

export const PRIVILEGE_OPTION_HELP: Record<string, string> = {
  DRAFT_PRIVILEGE: 'Ban one of their characters this round, and pick last.',
  TURN_ORDER: 'Decide who plays first this round, after both picks are revealed.',
}

/** §12 — the seal is the entire content of a hidden commit. */
export const SEALED_NOTE = 'Sealed. This cannot be changed or taken back.'

export const WAITING_NOTE = 'Waiting for your opponent.'

/** D17 — worth one line of copy rather than a silent assumption. */
export const RESUME_LINK_WARNING =
  'Anyone with this link holds your seat, including anything you have sealed. Keep it to ' +
  'yourself.'

/** D21 — "a 1.5–1.5 draw is a legal terminal state", so it is designed rather than bolted on. */
export const DRAW_HEADLINE = 'Drawn match'

export const DRAW_NOTE = 'Three rounds, one and a half each. Nobody takes it.'

/** §17 — the non-goal, stated where a player will look for it. */
export const REPORT_HELP =
  'Play the round, then record who won. This app does not score the game — it only decides who ' +
  'bans, who picks, and who goes first.'

/**
 * D38 — the same moment, in a tournament, where the other seat has already answered.
 *
 * Says what disagreeing *does*, because the honest answer is "it stops the bracket and fetches a
 * human", and somebody about to press it should know that rather than discover it.
 */
export const CONFIRM_HELP =
  'Agree and the round is recorded. Pick something else and the match is flagged for the ' +
  'organiser — so if you both just misremembered, sort it out between you first.'

/**
 * D39 — why the undo button went away.
 *
 * A control that silently stops appearing is worse than one that explains itself, and "the
 * bracket has moved on" is a reason a player will accept.
 */
export const FROZEN_NOTE =
  'This result is locked in — the tournament has already moved on from it. Ask the organiser if ' +
  'it needs changing.'
