import { parse as parseYaml } from 'yaml'
import Ajv, { type ErrorObject } from 'ajv'
import type {
  AssignSpec,
  BanSpec,
  ChooseSpec,
  ModeDefinition,
  ModuleSpec,
  NumberOrParam,
  ReportResultSpec,
  RollSpec,
  RoundLoopSpec,
  RoundModuleSpec,
  RoundOverride,
  SelectSpec,
} from '@banpick/types'

import { issue, type LoadIssue } from './errors.js'
import schema from '../schema/mode.schema.json' with { type: 'json' }

export const SCHEMA_VERSION = 1

const ajv = new Ajv({ allErrors: true, strict: false })
const validateSchema = ajv.compile(schema)

/**
 * YAML text -> `ModeDefinition`.
 *
 * The JSON Schema is the single source of truth for shape, and this function is a *translation*
 * on top of an already-valid document rather than a second set of rules. Anything it can reject
 * would be a schema gap, which is the only way the two can stay in agreement.
 */
export function parseMode(
  source: string,
  path: string,
): { definition: ModeDefinition; issues: LoadIssue[] } | { definition: null; issues: LoadIssue[] } {
  let raw: unknown
  try {
    raw = parseYaml(source)
  } catch (e) {
    return {
      definition: null,
      issues: [issue('YAML_PARSE', path, e instanceof Error ? e.message : String(e))],
    }
  }

  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return {
      definition: null,
      issues: [issue('YAML_PARSE', path, 'a mode file must be a mapping')],
    }
  }

  const doc = raw as Record<string, unknown>

  // Checked before the schema so a future-versioned file gets a useful answer rather than a
  // pile of shape errors describing rules it was never written against.
  if (doc['schemaVersion'] !== SCHEMA_VERSION) {
    return {
      definition: null,
      issues: [
        issue(
          'SCHEMA_VERSION',
          path,
          `declares schemaVersion ${String(doc['schemaVersion'])}; this loader implements ${SCHEMA_VERSION}`,
        ),
      ],
    }
  }

  if (!validateSchema(doc)) {
    return {
      definition: null,
      issues: (validateSchema.errors ?? []).map((e) => schemaIssue(e, path)),
    }
  }

  return { definition: translate(doc as SchemaShape), issues: [] }
}

function schemaIssue(e: ErrorObject, path: string): LoadIssue {
  const where = e.instancePath === '' ? path : `${path}${e.instancePath}`
  const detail =
    e.params && 'allowedValues' in e.params ? ` (${String(e.params['allowedValues'])})` : ''
  return issue('SCHEMA_INVALID', where, `${e.message ?? 'is invalid'}${detail}`)
}

// --- Translation -------------------------------------------------------------------------------

/** The post-schema shape. Loose on purpose: the schema has already vouched for it. */
type SchemaShape = Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any

function translate(doc: SchemaShape): ModeDefinition {
  return {
    modeId: doc['mode'],
    label: doc['label'],
    parameters: doc['parameters'] ?? {},
    modules: (doc['modules'] as SchemaShape[]).map(translateModule),
    onTie: doc['onTie'],
    match: doc['match'],
    overtime: doc['overtime'],
  }
}

function translateModule(m: SchemaShape): ModuleSpec {
  switch (m['use']) {
    case 'SIMULTANEOUS_COMMIT':
      return {
        type: 'SIMULTANEOUS_COMMIT',
        id: m['id'],
        commits: {
          picks: m['commits']?.picks
            ? { count: count(m['commits'].picks.count), pool: m['commits'].picks.pool }
            : null,
          metaBan: m['commits']?.metaBan ?? null,
        },
        // A commit kind the mode does not declare has nothing to reveal, so NONE is the
        // absence of a gate rather than a third timing to reason about.
        reveal: {
          picks: m['reveal']?.picks ?? 'NONE',
          metaBan: m['reveal']?.metaBan ?? 'NONE',
        },
      }

    case 'CONDITIONAL_RECOMMIT':
      return {
        type: 'CONDITIONAL_RECOMMIT',
        id: m['id'],
        trigger: m['trigger'],
        pool: m['pool'],
        hidden: m['hidden'] ?? false,
      }

    case 'REVEAL':
      return { type: 'REVEAL', id: m['id'], slices: m['slices'] }

    case 'ROUND_LOOP':
      return translateRoundLoop(m)

    default:
      return translateRoundModule(m)
  }
}

function translateRoundLoop(m: SchemaShape): RoundLoopSpec {
  const overrides: RoundLoopSpec['overrides'] = {}
  for (const [key, value] of Object.entries(m['overrides'] ?? {})) {
    const index = Number(key) as 0 | 1 | 2
    overrides[index] = translateOverride(value as SchemaShape)
  }

  return {
    type: 'ROUND_LOOP',
    id: m['id'],
    count: m['count'],
    template: (m['template'] as SchemaShape[]).map(translateRoundModule),
    overrides,
  }
}

function translateOverride(o: SchemaShape): RoundOverride {
  const out: RoundOverride = {}
  if (o['remove']) out.remove = o['remove']
  if (o['insert'])
    out.insert = (o['insert'] as SchemaShape[]).map(translateRoundModule) as AssignSpec[]
  if (o['selectOrder']) out.selectOrder = o['selectOrder']
  if (o['rollAssigns']) out.rollAssigns = o['rollAssigns']
  if (o['select']) out.select = o['select']
  return out
}

function translateRoundModule(m: SchemaShape): RoundModuleSpec {
  switch (m['use']) {
    case 'ROLL':
      return {
        type: 'ROLL',
        id: m['id'],
        dice: dice(m['dice']),
        actors: m['actors'],
        resolve: m['resolve'],
        onTie: m['onTie'],
        assigns: m['assigns'] ?? null,
      } satisfies RollSpec

    case 'CHOOSE':
      return {
        type: 'CHOOSE',
        id: m['id'],
        actor: m['actor'],
        options: m['options'],
        loserGets: m['loserGets'] ?? null,
      } satisfies ChooseSpec

    case 'ASSIGN':
      return {
        type: 'ASSIGN',
        id: m['id'],
        privilegeHolder: m['privilegeHolder'],
        turnOrderHolder: m['turnOrderHolder'],
      } satisfies AssignSpec

    case 'BAN':
      return {
        type: 'BAN',
        id: m['id'],
        tier: m['tier'],
        actor: m['actor'],
        pool: m['pool'],
      } satisfies BanSpec

    case 'SELECT':
      return {
        type: 'SELECT',
        id: m['id'],
        mode: m['mode'] ?? 'SEQUENTIAL',
        actor: m['actor'],
        pool: m['pool'],
      } satisfies SelectSpec

    case 'REPORT_RESULT':
      return {
        type: 'REPORT_RESULT',
        id: m['id'],
        allowTie: m['allowTie'],
      } satisfies ReportResultSpec

    default:
      // Unreachable: the schema's `use` enum is closed. Kept so a schema change that adds a
      // module type fails here rather than producing a module the engine cannot run.
      throw new TypeError(`parseMode: no translation for module type '${String(m['use'])}'`)
  }
}

/** `${draftCount}` in YAML is a string; a literal count is a number. */
function count(value: unknown): NumberOrParam {
  if (typeof value === 'number') return value
  const match = /^\$\{(\w+)\}$/.exec(String(value))
  if (!match) throw new TypeError(`parseMode: '${String(value)}' is not a count or a \${param}`)
  return { param: match[1]! }
}

function dice(notation: string): { count: number; sides: number } {
  const [count, sides] = notation.split('d')
  return { count: Number(count), sides: Number(sides) }
}
