import { defaults, type Schema, type Values } from './schema';

// Current settings are keyed by shared names, so a value chosen on one model carries over to every model that accepts it.
export type Settings = { input: Values; options: Values };
// Marks a field the user excluded, so it stays excluded even where a model documents a default.
const omitted = '\u0000omitted';
const references = ['image_urls', 'image_url', 'input_urls', 'image_input', 'image', 'input_image', 'files_url', 'file_url', 'reference_image_urls'];
const synonyms: Record<string, string> = { nsfw_checker: 'safety_checker', enable_safety_checker: 'safety_checker', expand_prompt: 'enhance_prompt', prompt_extend: 'enhance_prompt', prompt_upsampling: 'enhance_prompt', n: 'num_images' };

// Named sizes such as portrait_16_9 describe the same shape as plain ratios such as 9:16.
function ratio(value: string) {
  if (/^square(_hd)?$/.test(value)) return '1:1';
  const named = value.match(/^(portrait|landscape)_(\d+)_(\d+)$/);
  if (named) return named[1] === 'portrait' ? `${named[3]}:${named[2]}` : `${named[2]}:${named[3]}`;
  return /^\d+:\d+$/.test(value) ? value : undefined;
}
const comparable = (value: unknown) => typeof value === 'string' ? ratio(value) || value.toLowerCase().replace(/^jpg$/, 'jpeg') : String(value);

function sharedKey(name: string, s: Schema) {
  if (references.includes(name)) return 'references';
  if (synonyms[name]) return synonyms[name];
  const options = s.enum?.filter(option => option !== 'auto') || [];
  if (options.length && options.every(option => typeof option === 'string' && ratio(option))) return 'aspect_ratio';
  if (options.length && options.every(option => typeof option === 'string' && /^\d+(\.\d+)?K$/.test(option))) return 'resolution';
  return name;
}

// A field named after its shared key claims it first; any other field competing for a taken key keeps its own name.
export function sharedKeys(schema: Schema) {
  const keys: Record<string, string> = {}, taken = new Set<string>();
  const fields = Object.entries(schema.properties || {}).sort(([a, x], [b, y]) => Number(sharedKey(b, y) === b) - Number(sharedKey(a, x) === a));
  for (const [name, s] of fields) { const key = sharedKey(name, s); keys[name] = taken.has(key) ? name : key; taken.add(keys[name]); }
  return keys;
}

const fits = (s: Schema, value: unknown) => s.enum ? s.enum.includes(value) : s.type === 'array' ? Array.isArray(value) : s.type === 'object' ? !!value && typeof value === 'object' && !Array.isArray(value) : s.type === 'integer' ? Number.isInteger(value) : s.type === 'number' ? typeof value === 'number' : typeof s.type === 'string' ? typeof value === s.type : true;

// Adapts a value chosen on another model to this field. Undefined means it cannot apply here.
// Range and length limits are left to validation, so a too-long prompt is reported instead of silently replaced.
function adapt(s: Schema, input: unknown): unknown {
  let value = input;
  if (s.type === 'array' && (typeof value === 'string' || value === null)) value = value ? [value] : [];
  if (s.type === 'string' && Array.isArray(value)) value = value[0] ?? '';
  if (value === null || value === '' || (Array.isArray(value) && !value.length)) return value;
  if (Array.isArray(value) && s.maxItems !== undefined) value = value.slice(0, s.maxItems);
  if (s.enum && !s.enum.includes(value)) { const matches = s.enum.filter(option => comparable(option) === comparable(value)); value = matches.includes(s.default) ? s.default : matches[0]; }
  if ((s.type === 'number' || s.type === 'integer') && typeof value === 'string' && /^-?\d+(\.\d+)?$/.test(value)) value = Number(value);
  if (s.type === 'string' && typeof value === 'number') value = String(value);
  return value !== undefined && fits(s, value) ? value : undefined;
}

// The model's values: the current setting where it applies, otherwise the documented default.
export function resolve(schema: Schema, values: Values): Values {
  const keys = sharedKeys(schema), fallback = (defaults(schema) || {}) as Values, result: Values = {};
  for (const [name, s] of Object.entries(schema.properties || {})) {
    const value = values[keys[name]];
    if (value === omitted && !schema.required?.includes(name)) continue;
    const adapted = value === undefined || value === omitted ? undefined : adapt(s, value);
    if (adapted !== undefined) result[name] = adapted; else if (fallback[name] !== undefined) result[name] = fallback[name];
  }
  return result;
}

export const remember = (values: Values, key: string, value: unknown): Values => ({ ...values, [key]: value === undefined ? omitted : value });
