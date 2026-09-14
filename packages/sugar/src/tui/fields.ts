import * as Predicate from 'effect/Predicate'
import { ACTION_SCHEMA, type ParameterSpec } from '../action-schema'
import type { SugarAction, SugarParameter, SugarParameters } from '../contracts'

/**
 * TUI form rows projected from the shared action schema. `chain` and
 * `wallet` never appear as rows: the TUI fills them from its own state.
 * Fields in the `cl` group show for CL pools, fields in the `advanced` group
 * hide behind a "More options" row.
 */

export type FieldKind = 'text' | 'number' | 'boolean' | 'choice' | 'token'

export type FieldSpec = {
  name: string
  label: string
  kind: FieldKind
  required?: boolean
  choices?: readonly string[]
  placeholder?: string
  initial?: string | boolean
  help?: string
  group?: ParameterSpec['group']
  picker?: ParameterSpec['picker']
}

/** Choice value meaning "unset" for optional choice fields. */
export const ANY = 'any'
/** Synthetic row toggling the `advanced` group; never sent to the action. */
export const MORE_OPTIONS = '__more'
/** Synthetic flag set by the pool picker when the chosen pool is concentrated. */
export const POOL_IS_CL = '__cl'

const moreOptions: FieldSpec = { name: MORE_OPTIONS, label: 'More options', kind: 'boolean', initial: false, help: 'Show slippage, deadline, and range fields' }

/** The `advanced` group is the only one the toggle exists for; the rest follow the form's own values. */
const TOGGLED_GROUPS = new Set<ParameterSpec['group']>(['advanced'])

function fieldKind(spec: ParameterSpec): FieldKind {
  if (spec.kind === 'boolean') return 'boolean'
  if (spec.kind === 'token') return 'token'
  if (spec.choices) return 'choice'
  if (spec.kind === 'number' || spec.kind === 'integer') return 'number'
  return 'text'
}

function toField(spec: ParameterSpec): FieldSpec {
  const kind = fieldKind(spec)
  const choices = kind === 'choice' && spec.choices
    ? (spec.required ? spec.choices : [ANY, ...spec.choices])
    : undefined
  return {
    name: spec.name,
    label: spec.label,
    kind,
    required: spec.required,
    choices,
    placeholder: spec.placeholder,
    initial: kind === 'boolean' ? spec.default === true || spec.tuiDefault === true : undefined,
    help: spec.description,
    group: spec.group,
    picker: spec.picker,
  }
}

/** Every row an action can show, synthetic rows included. */
export function actionFields(action: SugarAction): FieldSpec[] {
  const fields = ACTION_SCHEMA[action].parameters.map(toField)
  return fields.some((field) => TOGGLED_GROUPS.has(field.group)) ? [...fields, moreOptions] : fields
}

export function actionTitle(action: SugarAction): string {
  return ACTION_SCHEMA[action].title
}

export function actionDescription(action: SugarAction): string {
  return ACTION_SCHEMA[action].description
}

export type FormValues = Record<string, string | boolean>

function initialValue(field: FieldSpec): string | boolean {
  if (field.kind === 'boolean') return field.initial === true
  if (Predicate.isString(field.initial)) return field.initial
  return field.kind === 'choice' && field.choices ? field.choices[0] : ''
}

export function initialValues(fields: FieldSpec[]): FormValues {
  return Object.fromEntries(fields.map((field) => [field.name, initialValue(field)]))
}

/** Rows to render right now, following the group rules documented on `ParameterSpec.group`. */
export function visibleFields(fields: FieldSpec[], values: FormValues): FieldSpec[] {
  const more = values[MORE_OPTIONS] === true
  const newPool = String(values.pool ?? '').trim() === ''
  const newCl = newPool && values.pool_type === 'cl'
  const cl = more || newCl || values[POOL_IS_CL] === true
  const shown = { 'new-pool': newPool, cl, 'new-cl-pool': newCl, advanced: more } satisfies Record<NonNullable<FieldSpec['group']>, boolean>
  return fields.filter((field) => field.group === undefined || shown[field.group])
}

/** Coerce the visible rows into Sugar parameters, dropping empty optionals and synthetic rows. */
export function buildParameters(fields: FieldSpec[], values: FormValues, chain: number): SugarParameters {
  const parameters: SugarParameters = { chain }
  for (const field of fields) {
    if (field.name === MORE_OPTIONS) continue
    const raw = values[field.name]
    let value: SugarParameter | undefined
    if (field.kind === 'boolean') value = raw === true ? true : field.initial === true ? false : undefined
    else if (field.kind === 'choice') value = raw === ANY || raw === '' ? undefined : String(raw)
    else if (Predicate.isString(raw) && raw.trim() !== '') {
      if (field.kind === 'number') {
        const parsed = Number(raw.trim())
        if (!Number.isFinite(parsed)) throw new Error(`${field.label} must be a number`)
        value = parsed
      } else value = raw.trim()
    }
    if (value === undefined) {
      if (field.required) throw new Error(`${field.label} is required`)
      continue
    }
    parameters[field.name] = value
  }
  return parameters
}
