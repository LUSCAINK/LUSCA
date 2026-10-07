// Strict JSON Schema subset for MCP tool inputs: the keywords the LUSCA tools use, checked exactly.
// type (object | string | integer | number | boolean), properties, required, additionalProperties: false,
// enum, pattern, minLength, maxLength, minimum, maximum, default (documentation only, applied by the tool).

export interface JsonSchema {
  type: 'object' | 'string' | 'integer' | 'number' | 'boolean' | 'array'
  description?: string
  title?: string
  properties?: Record<string, JsonSchema>
  required?: string[]
  additionalProperties?: boolean | JsonSchema
  enum?: readonly (string | number | boolean)[]
  pattern?: string
  minLength?: number
  maxLength?: number
  minimum?: number
  maximum?: number
  items?: JsonSchema
  default?: unknown
}

const typeOf = (v: unknown): string => (v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v)

/** null when `value` satisfies `schema`, else the first problem as one sentence naming the field. */
export function validate(schema: JsonSchema, value: unknown, at = 'arguments'): string | null {
  switch (schema.type) {
    case 'object': {
      if (typeOf(value) !== 'object') return `${at} must be an object`
      const obj = value as Record<string, unknown>
      for (const k of schema.required ?? []) if (!Object.hasOwn(obj, k) || obj[k] === undefined) return `${at === 'arguments' ? '' : `${at}.`}${k} is required`
      const props = schema.properties ?? {}
      for (const [k, v] of Object.entries(obj)) {
        // own properties only: 'constructor', '__proto__', 'toString' are argument names like any other
        const ps = Object.hasOwn(props, k) ? props[k] : undefined
        if (!ps) {
          if (schema.additionalProperties === false) return `unknown argument ${at === 'arguments' ? '' : `${at}.`}${k} (allowed: ${Object.keys(props).join(', ') || 'none'})`
          continue
        }
        if (v === undefined) continue
        const err = validate(ps, v, at === 'arguments' ? k : `${at}.${k}`)
        if (err) return err
      }
      return null
    }
    case 'string': {
      if (typeof value !== 'string') return `${at} must be a string`
      if (schema.minLength !== undefined && value.length < schema.minLength) return `${at} must be at least ${schema.minLength} characters`
      if (schema.maxLength !== undefined && value.length > schema.maxLength) return `${at} must be at most ${schema.maxLength} characters`
      if (schema.enum && !schema.enum.includes(value)) return `${at} must be one of ${schema.enum.join(', ')}`
      if (schema.pattern && !new RegExp(schema.pattern).test(value)) return `${at} has the wrong format`
      return null
    }
    case 'integer':
    case 'number': {
      if (typeof value !== 'number' || !Number.isFinite(value)) return `${at} must be a number`
      if (schema.type === 'integer' && !Number.isInteger(value)) return `${at} must be an integer`
      if (schema.minimum !== undefined && value < schema.minimum) return `${at} must be ≥ ${schema.minimum}`
      if (schema.maximum !== undefined && value > schema.maximum) return `${at} must be ≤ ${schema.maximum}`
      if (schema.enum && !schema.enum.includes(value)) return `${at} must be one of ${schema.enum.join(', ')}`
      return null
    }
    case 'boolean':
      return typeof value === 'boolean' ? null : `${at} must be true or false`
    case 'array': {
      if (!Array.isArray(value)) return `${at} must be an array`
      if (schema.items) {
        for (let i = 0; i < value.length; i++) {
          const err = validate(schema.items, value[i], `${at}[${i}]`)
          if (err) return err
        }
      }
      return null
    }
  }
}
