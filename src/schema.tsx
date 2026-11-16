import { createContext, useContext, useId, useState } from 'react';
import { ChevronDown, EyeOff, Image as ImageIcon, Plus, Trash2, Upload, Info } from 'lucide-react';

export type Schema = { type?: string | string[]; title?: string; description?: string; properties?: Record<string, Schema>; required?: string[]; enum?: unknown[]; default?: unknown; items?: Schema; minItems?: number; maxItems?: number; minimum?: number; maximum?: number; exclusiveMinimum?: number; exclusiveMaximum?: number; multipleOf?: number; minLength?: number; maxLength?: number; pattern?: string; format?: string; oneOf?: Schema[]; anyOf?: Schema[]; allOf?: Schema[]; additionalProperties?: boolean | Schema; [key: string]: unknown };
export type Values = Record<string, unknown>;
export const ImagesHidden = createContext(false);
export const readable = (name: string) => name.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/[_-]/g, ' ').replace(/^./, x => x.toUpperCase());
const has = (s: Schema, key: string) => Object.prototype.hasOwnProperty.call(s, key);
export function defaults(s: Schema): unknown {
  if (has(s, 'default')) return structuredClone(s.default);
  if (s.type === 'object' || s.properties) {
    const result: Values = {};
    for (const [key, child] of Object.entries(s.properties || {})) {
      if (has(child, 'default')) result[key] = defaults(child);
      else if (s.required?.includes(key) && (child.type === 'object' || child.properties)) result[key] = defaults(child);
    }
    return result;
  }
  return undefined;
}
function initial(s: Schema): unknown {
  const value = defaults(s); if (value !== undefined) return value;
  if (s.type === 'array') return [];
  if (s.type === 'boolean' || s.enum) return null;
  return '';
}
export function optionsSchema(s?: Schema): Schema {
  return { ...s, type: 'object', properties: Object.fromEntries(Object.entries(s?.properties || {}).filter(([key]) => !['model', 'input'].includes(key))), required: s?.required?.filter(key => !['model', 'input'].includes(key)) };
}
export function ordered(s: Schema) {
  return Object.entries(s.properties || {}).sort(([a], [b]) => Number(/prompt/i.test(b) && !/negative/i.test(b)) - Number(/prompt/i.test(a) && !/negative/i.test(a)));
}
const isReference = (name: string, s: Schema) => /^(image|images|image_urls?|image_inputs?|input_images?|input_urls?|input_image_urls?|image_input|files?_url|references?|reference_images?|reference_urls?|reference_image_urls?|first_frame_url|last_frame_url|mask_url)$/i.test(name.replace(/ \[\d+\]$/, '').replace(/([a-z])([A-Z])/g, '$1_$2')) || (s.format === 'uri' && /image|reference/i.test(s.description || ''));

export function JsonEditor({ value, onChange, required, id, disabled }: { value: unknown; onChange: (value: unknown) => void; required?: boolean; id: string; disabled?: boolean }) {
  const [draft, setDraft] = useState(value === undefined ? '' : JSON.stringify(value, null, 2));
  const [error, setError] = useState('');
  return <><textarea id={id} className="json-input" disabled={disabled} value={draft} required={required} rows={5} placeholder="Enter valid JSON" onChange={event => {
    const text = event.target.value; setDraft(text);
    try { const parsed = JSON.parse(text); onChange(parsed); setError(''); event.target.setCustomValidity(''); }
    catch { setError('Enter valid JSON'); event.target.setCustomValidity('Enter valid JSON'); }
  }} />{error && <span className="field-error">{error}</span>}</>;
}

type Props = { name: string; schema: Schema; value: unknown; required?: boolean; onChange: (value: unknown) => void; upload: (file: File) => Promise<string>; depth?: number; reference?: boolean; disabled?: boolean };
export function Field({ name, schema: s, value, required, onChange, upload, depth = 0, reference, disabled = false }: Props) {
  const id = useId();
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState('');
  const hidden = useContext(ImagesHidden); const [broken, setBroken] = useState('');
  const included = required || value !== undefined;
  const off = disabled || !included;
  const type = s.type || (s.properties ? 'object' : 'string');
  const ref = reference || isReference(name, s);
  const union = s.oneOf || s.anyOf || s.allOf || Array.isArray(type);
  const label = s.title || readable(name);
  const preview = ref && type === 'string' && typeof value === 'string' && /^https?:\/\/\S+$/.test(value) ? value : '';
  const uploadControl = ref && type === 'string' && <div className="reference-row">{preview && <span className="thumb">{hidden ? <EyeOff size={18} /> : broken === preview ? <ImageIcon size={18} /> : <img src={preview} alt="" onError={() => setBroken(preview)} />}</span>}<label className={`upload-button ${off || uploading ? 'disabled' : ''}`}><Upload size={13} />{uploading ? 'Uploading…' : 'Upload image'}<input type="file" accept="image/png,image/jpeg,image/webp,image/gif,image/avif" disabled={off || uploading} onChange={async e => {
    const file = e.target.files?.[0]; if (!file) return; setUploading(true); setError('');
    try { onChange(await upload(file)); } catch (err) { setError(err instanceof Error ? err.message : 'Upload failed'); } finally { setUploading(false); e.target.value = ''; }
  }} /></label></div>;
  let control;
  if (union) control = <JsonEditor id={id} value={value} onChange={onChange} disabled={off} required={!!included} />;
  else if (s.enum) control = <select id={id} value={value === undefined ? '' : String(s.enum.findIndex(x => JSON.stringify(x) === JSON.stringify(value)))} disabled={off} required={!!included} onChange={e => onChange(s.enum![Number(e.target.value)])}><option value="" disabled>Choose a value</option>{s.enum.map((item, index) => <option key={index} value={index}>{typeof item === 'string' ? item : JSON.stringify(item)}</option>)}</select>;
  else if (type === 'boolean') control = <select id={id} value={typeof value === 'boolean' ? String(value) : ''} disabled={off} required={!!included} onChange={e => onChange(e.target.value === 'true')}><option value="" disabled>Choose true or false</option><option value="true">True</option><option value="false">False</option></select>;
  else if (type === 'number' || type === 'integer') control = <input id={id} type="number" value={typeof value === 'number' || typeof value === 'string' ? value : ''} min={s.minimum ?? (s.exclusiveMinimum !== undefined ? s.exclusiveMinimum + (type === 'integer' ? 1 : Number.EPSILON) : undefined)} max={s.maximum} step={s.multipleOf || (type === 'integer' ? 1 : 'any')} disabled={off} required={!!included} onChange={e => onChange(e.target.value === '' ? '' : Number(e.target.value))} />;
  else if (type === 'array') {
    const items = Array.isArray(value) ? value : [];
    control = <div className="array-editor" id={id}>{items.map((item, index) => <div className="array-item" key={index}><Field name={`${name} [${index}]`} schema={s.items || {}} value={item} required reference={ref} disabled={off} depth={depth + 1} upload={upload} onChange={next => onChange(items.map((x, i) => i === index ? next : x))} /><button type="button" className="icon remove" disabled={off || (s.minItems !== undefined && items.length <= s.minItems)} aria-label={`Remove ${name} item ${index + 1}`} onClick={() => onChange(items.filter((_, i) => i !== index))}><Trash2 size={14} /></button></div>)}<button type="button" className="text-button" disabled={off || (s.maxItems !== undefined && items.length >= s.maxItems)} onClick={() => onChange([...items, initial(s.items || {})])}><Plus size={13} /> Add {ref ? 'reference' : 'item'}</button>{(s.minItems !== undefined || s.maxItems !== undefined) && <span className="hint">{s.minItems !== undefined ? `Min ${s.minItems}` : ''}{s.minItems !== undefined && s.maxItems !== undefined ? ' · ' : ''}{s.maxItems !== undefined ? `Max ${s.maxItems}` : ''} items</span>}</div>;
  } else if (type === 'object' && s.properties) {
    const object = value && typeof value === 'object' && !Array.isArray(value) ? value as Values : {};
    control = <div className="nested-fields" id={id}>{ordered(s).map(([key, child]) => <Field key={key} name={key} schema={child} value={object[key]} required={s.required?.includes(key)} disabled={off} depth={depth + 1} upload={upload} onChange={next => { const updated = { ...object }; if (next === undefined) delete updated[key]; else updated[key] = next; onChange(updated); }} />)}{s.additionalProperties && <details className="additional"><summary>Additional properties (JSON)</summary><JsonEditor id={`${id}-extra`} value={Object.fromEntries(Object.entries(object).filter(([key]) => !s.properties?.[key]))} disabled={off} onChange={next => { if (next && typeof next === 'object' && !Array.isArray(next)) onChange({ ...Object.fromEntries(Object.entries(object).filter(([key]) => s.properties?.[key])), ...next }); }} /></details>}</div>;
  } else if (type === 'object' || type === 'null') control = <JsonEditor id={id} value={value} onChange={onChange} disabled={off} required={!!included} />;
  else if (/prompt|description|text/i.test(name) || (s.maxLength || 0) > 250) control = <textarea id={id} rows={/negative/i.test(name) ? 3 : 5} value={typeof value === 'string' ? value : ''} disabled={off} required={!!included && (s.minLength || 0) > 0} minLength={s.minLength} maxLength={s.maxLength} placeholder={/prompt/i.test(name) ? 'Describe what you want to create…' : undefined} onChange={e => onChange(e.target.value)} />;
  else control = <input id={id} type={s.format === 'uri' ? 'url' : 'text'} value={typeof value === 'string' ? value : ''} disabled={off} required={!!included && (s.minLength || 0) > 0} minLength={s.minLength} maxLength={s.maxLength} pattern={s.pattern} placeholder={ref ? 'https://…' : undefined} onChange={e => onChange(e.target.value)} />;
  return <div className={`field ${off ? 'omitted' : ''} ${depth ? 'nested' : ''}`}><div className="field-heading"><label htmlFor={id}>{label}{required && <span className="required" title="Required"> *</span>}</label>{!required && <label className="include"><input type="checkbox" disabled={disabled} checked={!!included} onChange={e => onChange(e.target.checked ? initial(s) : undefined)} />Include</label>}</div><div className="field-api"><code>{name}</code>{has(s, 'default') && <span title={JSON.stringify(s.default)}>default: {JSON.stringify(s.default)}</span>}</div>{s.description && <details className="field-description"><summary><Info size={11} /> Description <ChevronDown size={11} /></summary><p>{s.description}</p></details>}{control}{uploadControl}{error && <span className="field-error">{error}</span>}</div>;
}

export function validate(s: Schema, value: unknown, path = 'input'): string[] {
  const errors: string[] = [];
  if (s.oneOf || s.anyOf || s.allOf || Array.isArray(s.type)) return errors;
  if (s.enum && !s.enum.some(x => JSON.stringify(x) === JSON.stringify(value))) errors.push(`${path}: choose an allowed value`);
  if (s.type === 'object' || s.properties) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return [`${path}: expected an object`];
    const object = value as Values;
    for (const key of s.required || []) if (object[key] === undefined) errors.push(`${path}.${key}: required`);
    for (const [key, child] of Object.entries(s.properties || {})) if (object[key] !== undefined) errors.push(...validate(child, object[key], `${path}.${key}`));
  }
  if (s.type === 'array') {
    if (!Array.isArray(value)) return [`${path}: expected an array`];
    if (s.minItems !== undefined && value.length < s.minItems) errors.push(`${path}: at least ${s.minItems} items required`);
    if (s.maxItems !== undefined && value.length > s.maxItems) errors.push(`${path}: at most ${s.maxItems} items allowed`);
    value.forEach((item, i) => errors.push(...validate(s.items || {}, item, `${path}[${i}]`)));
  }
  if ((s.type === 'number' || s.type === 'integer') && (typeof value !== 'number' || !Number.isFinite(value) || (s.type === 'integer' && !Number.isInteger(value)))) errors.push(`${path}: expected ${s.type}`);
  if (typeof value === 'number') {
    if (s.minimum !== undefined && value < s.minimum) errors.push(`${path}: minimum ${s.minimum}`);
    if (s.maximum !== undefined && value > s.maximum) errors.push(`${path}: maximum ${s.maximum}`);
    if (s.exclusiveMinimum !== undefined && value <= s.exclusiveMinimum) errors.push(`${path}: must be greater than ${s.exclusiveMinimum}`);
    if (s.exclusiveMaximum !== undefined && value >= s.exclusiveMaximum) errors.push(`${path}: must be less than ${s.exclusiveMaximum}`);
  }
  if (s.type === 'boolean' && typeof value !== 'boolean') errors.push(`${path}: select true or false`);
  if (s.type === 'string' && typeof value !== 'string') errors.push(`${path}: expected a string`);
  if (typeof value === 'string') {
    if (s.minLength !== undefined && value.length < s.minLength) errors.push(`${path}: minimum length ${s.minLength}`);
    if (s.maxLength !== undefined && value.length > s.maxLength) errors.push(`${path}: maximum length ${s.maxLength}`);
    if (s.pattern) { try { if (!new RegExp(s.pattern).test(value)) errors.push(`${path}: does not match the documented pattern`); } catch { /* Server validates unsupported regular expressions. */ } }
  }
  return errors;
}
