'use strict';
// Minimal JSON Schema validator (subset: type, required, properties, items,
// enum, minimum/maximum, minLength/maxLength, minItems/maxItems,
// additionalProperties:false). Enough to enforce fixed output structures
// without pulling in a heavy dependency.

function typeOf(v) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  if (Number.isInteger(v)) return 'integer';
  return typeof v;
}

function matchesType(v, t) {
  const actual = typeOf(v);
  if (Array.isArray(t)) return t.some((x) => matchesType(v, x));
  if (t === 'number') return actual === 'number' || actual === 'integer';
  return actual === t;
}

function validate(schema, value, path = '$', errors = []) {
  if (!schema || typeof schema !== 'object') return errors;
  if (schema.type && !matchesType(value, schema.type)) {
    errors.push(`${path}: expected ${schema.type}, got ${typeOf(value)}`);
    return errors;
  }
  if (schema.enum && !schema.enum.some((e) => JSON.stringify(e) === JSON.stringify(value))) {
    errors.push(`${path}: value ${JSON.stringify(value)} not in enum`);
  }
  if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) errors.push(`${path}: ${value} < minimum ${schema.minimum}`);
    if (schema.maximum !== undefined && value > schema.maximum) errors.push(`${path}: ${value} > maximum ${schema.maximum}`);
  }
  if (typeof value === 'string') {
    if (schema.minLength !== undefined && value.length < schema.minLength) errors.push(`${path}: shorter than ${schema.minLength}`);
    if (schema.maxLength !== undefined && value.length > schema.maxLength) errors.push(`${path}: longer than ${schema.maxLength}`);
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) errors.push(`${path}: fewer than ${schema.minItems} items`);
    if (schema.maxItems !== undefined && value.length > schema.maxItems) errors.push(`${path}: more than ${schema.maxItems} items`);
    if (schema.items) value.forEach((v, i) => validate(schema.items, v, `${path}[${i}]`, errors));
  }
  if (value && typeOf(value) === 'object') {
    for (const req of schema.required || []) {
      if (!(req in value)) errors.push(`${path}: missing required property "${req}"`);
    }
    const props = schema.properties || {};
    for (const [k, v] of Object.entries(value)) {
      if (props[k]) validate(props[k], v, `${path}.${k}`, errors);
      else if (schema.additionalProperties === false) errors.push(`${path}: unexpected property "${k}"`);
    }
  }
  return errors;
}

module.exports = { validate, typeOf };
