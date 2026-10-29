import { z } from 'zod';
import type { ChatResponseFormat } from './backends.js';
import type { ChatOperation } from './policy.js';

export type JsonSchema = { [keyword: string]: unknown };

class Unsupported extends Error {}

/**
 * The response format for a structured call: the Zod schema as strict JSON
 * Schema when it maps cleanly, otherwise plain JSON mode.
 *
 * This only steers the model. Zod stays the validator, with its `.catch()`
 * fallbacks, string lengths and the repair round trip, so nothing here may
 * make the schema looser than Zod or stricter than a value Zod accepts.
 * The name is operational and never carries user content.
 */
export function structuredResponseFormat(operation: ChatOperation, schema: z.ZodType): ChatResponseFormat {
  const json = strictJsonSchema(schema);
  return json ? { type: 'json_schema', name: `pigeonbox_${operation}`, schema: json } : { type: 'json_object' };
}

/**
 * Zod → the JSON Schema subset strict Structured Outputs accept: every
 * property required, no additional properties, a root object, and only the
 * supported keywords (enum, anyOf, minimum/maximum, minItems/maxItems).
 * Returns null for anything without a safe mapping.
 */
export function strictJsonSchema(schema: z.ZodType): JsonSchema | null {
  try {
    const json = convert(schema);
    return json.type === 'object' ? json : null;
  } catch (error) {
    if (error instanceof Unsupported) return null;
    throw error;
  }
}

/** The parts of Zod's internal definition this conversion reads. */
type Def = {
  type: string;
  checks?: Array<{ _zod: { def: CheckDef } }>;
  format?: string;
  shape?: Record<string, z.ZodType>;
  element?: z.ZodType;
  entries?: Record<string, string | number>;
  innerType?: z.ZodType;
};
type CheckDef = { check: string; format?: string; value?: number; inclusive?: boolean; minimum?: number; maximum?: number };

function convert(schema: z.ZodType): JsonSchema {
  const def = schema._zod.def as unknown as Def;
  // Refinements are checks on the schema itself and keep its shape; transforms and preprocessors are pipes.
  const checks = (def.checks ?? []).map((check) => check._zod.def);
  switch (def.type) {
    case 'object':
      return {
        type: 'object',
        properties: Object.fromEntries(Object.entries(def.shape!).map(([key, value]) => [key, convert(value)])),
        required: Object.keys(def.shape!),
        additionalProperties: false,
      };
    case 'string':
      // Strict mode has no minLength/maxLength; Zod enforces them.
      return { type: 'string' };
    case 'number': {
      const integer = /int/.test(def.format ?? '') || checks.some((check) => check.check === 'number_format' && /int/.test(check.format ?? ''));
      const json: JsonSchema = { type: integer ? 'integer' : 'number' };
      for (const check of checks) {
        if (check.check === 'greater_than') json[check.inclusive ? 'minimum' : 'exclusiveMinimum'] = check.value;
        if (check.check === 'less_than') json[check.inclusive ? 'maximum' : 'exclusiveMaximum'] = check.value;
      }
      return json;
    }
    case 'boolean':
      return { type: 'boolean' };
    case 'enum': {
      const values = Object.values(def.entries!);
      if (!values.every((value) => typeof value === 'string')) throw new Unsupported();
      return { type: 'string', enum: values };
    }
    case 'array': {
      const json: JsonSchema = { type: 'array', items: convert(def.element!) };
      for (const check of checks) {
        if (check.check === 'min_length' && check.minimum) json.minItems = check.minimum;
        if (check.check === 'max_length' && check.maximum !== undefined) json.maxItems = check.maximum;
      }
      return json;
    }
    case 'nullable':
      return { anyOf: [convert(def.innerType!), { type: 'null' }] };
    // The model always supplies these fields; any value valid for the inner type is valid for Zod too.
    case 'catch':
    case 'default':
    case 'prefault':
    case 'optional':
      return convert(def.innerType!);
    default:
      throw new Unsupported();
  }
}
