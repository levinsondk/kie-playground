import Ajv from 'ajv';
import addFormats from 'ajv-formats';

export class ApiError extends Error {
  constructor(message, status = 400, details) { super(message); this.status = status; this.details = details; }
}
const ajv = new Ajv({ strict: false, allErrors: true, validateFormats: false, allowUnionTypes: true });
addFormats(ajv);
export function validatePayload(schema, value) {
  const check = ajv.compile(schema || { type: 'object' });
  if (!check(value)) throw new ApiError('Check the highlighted request parameters', 422,
    check.errors.map(e => ({ path: e.instancePath || '/', message: e.message, ...e.params })));
}
export function schemaPropertyNames(schema, names = new Set()) {
  for (const name of Object.keys(schema?.properties || {})) names.add(name);
  for (const key of ['oneOf','anyOf','allOf']) for (const child of schema?.[key] || []) schemaPropertyNames(child, names);
  return names;
}
export function buildPayload(model, input = {}, options = {}) {
  if (!model.supported || model.transport !== 'market' || model.endpoint !== '/api/v1/jobs/createTask') {
    throw new ApiError(model.reason || 'This legacy endpoint is not connected to the Market task API', 422);
  }
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new ApiError('Input must be an object', 422);
  if (!options || typeof options !== 'object' || Array.isArray(options)) throw new ApiError('Request options must be an object', 422);
  const allowedInputNames = schemaPropertyNames(model.inputSchema);
  for (const k of Object.keys(input)) {
    if (!allowedInputNames.has(k)) throw new ApiError(`Unknown input parameter: ${k}`, 422);
  }
  const safeOptions = {};
  for (const [k,v] of Object.entries(options)) {
    if (['model','input','__proto__','prototype','constructor'].includes(k) || !Object.hasOwn(model.requestSchema.properties || {}, k)) {
      throw new ApiError(`Unknown request option: ${k}`, 422);
    }
    safeOptions[k] = v;
  }
  validatePayload(model.inputSchema, input);
  const payload = { ...safeOptions, model: model.id, input };
  validatePayload(model.requestSchema, payload);
  return payload;
}
export async function kieRequest(path, key, { method = 'GET', body, fetchImpl = fetch, timeout = 60000 } = {}) {
  if (!key) throw new ApiError('Connect your Kie API key first', 401);
  let response;
  try {
    response = await fetchImpl(`https://api.kie.ai${path}`, {
      method, headers: { Authorization: `Bearer ${key}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(timeout), redirect: 'error'
    });
  } catch (e) {
    throw new ApiError(e.name === 'TimeoutError' ? 'Kie request timed out. Check task history before submitting again.' : 'Unable to reach Kie. Check your connection.', 502);
  }
  let data;
  try { data = await response.json(); } catch { throw new ApiError(`Kie returned a non-JSON response (HTTP ${response.status})`, 502); }
  if (!response.ok || (data.code !== undefined && Number(data.code) !== 200) || data.success === false) {
    const code = Number(data.code) || response.status;
    throw new ApiError(String(data.msg || data.message || `Kie returned HTTP ${response.status}`).slice(0,2000),
      [400,401,402,403,404,422,429].includes(code) ? code : 502);
  }
  return data;
}
export function isPublicAddress(address) {
  if (address.includes(':')) return /^[23][0-9a-f]{3}:/i.test(address) && !/^2001:db8:/i.test(address);
  const octets = address.split('.').map(Number);
  if (octets.length !== 4 || octets.some(n => !Number.isInteger(n) || n < 0 || n > 255)) return false;
  const [a,b] = octets;
  return !(a === 0 || a === 10 || a === 127 || a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)));
}
export function unpackResult(data) {
  let result = data.response;
  if (data.resultJson) {
    try { result = typeof data.resultJson === 'string' ? JSON.parse(data.resultJson) : data.resultJson; }
    catch { throw new ApiError('Kie marked the task complete but returned invalid result JSON', 502); }
  }
  const candidates = result?.resultUrls || [];
  const urls = Array.isArray(candidates) ? candidates.filter(u => {
    try { return typeof u === 'string' && new URL(u).protocol === 'https:'; } catch { return false; }
  }) : [];
  return { urls, raw: result || {} };
}
