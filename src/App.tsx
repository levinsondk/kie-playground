import { useCallback, useEffect, useRef, useState, type ButtonHTMLAttributes, type FormEvent, type PointerEvent as ReactPointerEvent } from 'react';
import { ArrowUpRight, Bookmark, Check, ChevronDown, ChevronLeft, ChevronRight, ChevronsUpDown, Copy, Download, Eye, EyeOff, History, Image as ImageIcon, KeyRound, LoaderCircle, Maximize, PanelRightClose, PanelRightOpen, Pin, Plus, RefreshCw, RotateCcw, Save, Search, SlidersHorizontal, Sparkles, Trash2, X } from 'lucide-react';
import { Field, ImagesHidden, optionsSchema, ordered, validate, type Schema, type Values } from './schema';
import { remember, resolve, sharedKeys, type Settings } from './shared';

type Model = { id: string; name: string; family: string; description?: string; docsUrl?: string; endpoint: string; method: string; inputSchema: Schema; requestSchema?: Schema; transport: 'market' | 'legacy'; supported: boolean; reason?: string };
type Catalog = { updatedAt: string; source: string; models: Model[]; coverage: { discovered: number; imported: number; unsupported: number; failures: unknown } };
type Job = { id: string; model: string; modelName: string; input: Values; options?: Values; state: 'waiting' | 'queuing' | 'generating' | 'success' | 'fail'; createdAt: string; updatedAt: string; urls: string[]; error?: string; creditsConsumed?: number; raw?: unknown; slot?: { job: string; index: number } };
type Connection = { connected: boolean; credits: unknown; override?: boolean; envKey?: boolean };
type Preset = { name: string; settings: Settings };
type Workspace = { selected: string; settings: Settings; presets: Preset[]; variants: Record<string, number>; pinned: string[] };
type Take = { job: Job; index: number };
type View = { scale: number; x: number; y: number };
type Point = { x: number; y: number };
// Zoom stops at an eighth of the fitted size and at sixteen times the larger of fit and 100%.
const clampScale = (scale: number, fit: number) => Math.min(Math.max(fit, 1) * 16, Math.max(fit / 8, scale));
// Scales the view and moves it so the image point under `from` lands under `to`. Points are relative to the canvas centre.
const zoomTo = (view: View, scale: number, from: Point, to: Point): View => ({ scale, x: to.x - (from.x - view.x) * scale / view.scale, y: to.y - (from.y - view.y) * scale / view.scale });
const noSettings: Settings = { input: {}, options: {} };
const pending = (job: Job) => !['success', 'fail'].includes(job.state);
// Each kept image is a take; a task without images is one take, for its status. A deleted image leaves an empty URL, so the others keep their index.
// A retry's takes join the slot of the image it retried, and the gallery shows each slot where its first take was.
const slotOf = (job: Job, index: number) => job.slot ? `${job.slot.job}:${job.slot.index}` : `${job.id}:${index}`;
function slotsOf(jobs: Job[]) {
  const slots = new Map<string, Take[]>();
  for (const job of [...jobs].reverse()) { const kept = job.urls.flatMap((url, index) => url ? [index] : []); for (const index of kept.length ? kept : [0]) slots.set(slotOf(job, index), [...slots.get(slotOf(job, index)) || [], { job, index }]); }
  return [...slots].map(([key, takes]) => ({ key, takes })).sort((a, b) => jobs.indexOf(a.takes[0].job) - jobs.indexOf(b.takes[0].job) || a.takes[0].index - b.takes[0].index);
}
type Slot = ReturnType<typeof slotsOf>[number];
const errorText = (error: unknown) => error instanceof Error ? error.message : 'Something went wrong';
async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, init);
  const data = await response.json().catch(() => ({ error: `Request failed (${response.status})` }));
  if (!response.ok) throw new Error([data.error || `Request failed (${response.status})`, ...(Array.isArray(data.details) ? data.details.map((item: { path?: string; message?: string }) => `${item.path || ''} ${item.message || ''}`.trim()) : [])].join('\n'));
  return data;
}
const jsonPost = (data: unknown): RequestInit => ({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
const creditLabel = (credits: unknown) => typeof credits === 'number' || typeof credits === 'string' ? String(credits) : credits === null || credits === undefined ? '—' : JSON.stringify(credits);
const formatDate = (date: string) => new Date(date).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
function stored<T>(key: string, fallback: T): T { try { const text = localStorage.getItem(key); return text === null ? fallback : JSON.parse(text); } catch { return fallback; } }
const store = (key: string, value: unknown) => { try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* Blocked storage only loses state across reloads. */ } };
const putWorkspace = (body: string, keepalive = false) => api('/api/workspace', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body, keepalive });
// Each browser used to keep its own workspace. That copy is merged in once, adding its presets and pins, and then removed.
async function loadWorkspace() {
  const space = await api<Workspace | null>('/api/workspace');
  const old: Workspace = { selected: stored('kie-selected', ''), settings: stored('kie-settings', noSettings), presets: stored('kie-presets', []), variants: stored('kie-variants', {}), pinned: stored('kie-pinned', []) };
  const merged = space ? { ...space, presets: [...space.presets, ...old.presets.filter(preset => !space.presets.some(item => item.name === preset.name))], pinned: [...new Set([...space.pinned, ...old.pinned])] } : old;
  if (JSON.stringify(merged) !== JSON.stringify(space)) await putWorkspace(JSON.stringify(merged));
  try { for (const key of ['kie-selected', 'kie-settings', 'kie-presets', 'kie-variants', 'kie-pinned']) localStorage.removeItem(key); } catch { /* Blocked storage holds no old copy. */ }
  return merged;
}

// Deleting takes two clicks: the first one only arms the button.
function DeleteButton({ label, armed, ...props }: { label: string; armed: boolean } & ButtonHTMLAttributes<HTMLButtonElement>) {
  return <button {...props} className={`${props.className} ${armed ? 'confirm' : ''}`} title={armed ? 'Click again to delete' : label} aria-label={armed ? undefined : label}><Trash2 size={14} />{armed && <span>Delete?</span>}</button>;
}

function ConnectionDialog({ close, connection, change }: { close: () => void; connection: Connection; change: (value: Connection) => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const [key, setKey] = useState(''); const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  useEffect(() => { ref.current?.showModal(); }, []);
  const finish = () => { setKey(''); close(); };
  return <dialog ref={ref} className="connection-dialog" onCancel={finish} onClick={event => { if (event.target === ref.current) finish(); }}><div className="dialog-top"><KeyRound size={22} /><button className="icon" aria-label="Close connection dialog" onClick={finish}><X size={18} /></button></div><h2>{connection.connected ? 'API connection' : 'Connect to Kie'}</h2><p>{connection.override ? 'Using the key entered here. It stays in this local server’s memory until the server restarts and is never saved in your browser.' : connection.envKey ? 'Using the key from the .env file in the project folder. A key entered here overrides it until the server restarts.' : 'Add your key to the .env file in the project folder, or enter it here. A key entered here stays in this local server’s memory until the server restarts and is never saved in your browser.'}</p><form onSubmit={async event => { event.preventDefault(); setBusy(true); setError(''); try { change(await api<Connection>('/api/connection', jsonPost({ key }))); finish(); } catch (err) { setError(errorText(err)); } finally { setBusy(false); } }}><label htmlFor="api-key">Kie API key</label><input id="api-key" name="api-key" type="password" autoComplete="off" autoFocus value={key} onChange={e => setKey(e.target.value)} required placeholder="Enter your API key" /><span className="hint">Connecting only checks your balance. It does not generate images.</span>{error && <div className="error" role="alert">{error}</div>}<button className="primary" disabled={busy || !key.trim()}>{busy ? <LoaderCircle size={15} className="spin" /> : <KeyRound size={15} />}{busy ? 'Verifying…' : connection.connected ? 'Replace key' : 'Connect key'}</button></form>{connection.override && <button className="text-button disconnect" disabled={busy} onClick={async () => { setBusy(true); try { change(await api<Connection>('/api/connection', { method: 'DELETE' })); finish(); } catch (err) { setError(errorText(err)); } finally { setBusy(false); } }}>{connection.envKey ? 'Switch back to the key in .env' : 'Disconnect and clear server key'}</button>}<a href="https://kie.ai/api-key" target="_blank" rel="noreferrer" className="external">Get a key at kie.ai <ArrowUpRight size={13} /></a></dialog>;
}

export default function App() {
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [catalogLoading, setCatalogLoading] = useState(true);
  const [selected, setSelected] = useState(''); const [search, setSearch] = useState(''); const [picking, setPicking] = useState(false);
  const [settings, setSettings] = useState<Settings>(noSettings); const [revision, setRevision] = useState(0);
  const [presets, setPresets] = useState<Preset[]>([]); const [presetName, setPresetName] = useState(''); const [savedPreset, setSavedPreset] = useState('');
  const [variants, setVariants] = useState<Record<string, number>>({});
  const [pinned, setPinned] = useState<string[]>([]);
  const [connection, setConnection] = useState<Connection>({ connected: false, credits: null });
  const [jobs, setJobs] = useState<Job[]>([]); const [jobId, setJobId] = useState(''); const [picks, setPicks] = useState<Record<string, string>>({});
  const [error, setError] = useState(''); const [pollError, setPollError] = useState('');
  const [refreshing, setRefreshing] = useState(false); const [submitting, setSubmitting] = useState(false);
  const [showConnection, setShowConnection] = useState(false); const [galleryOpen, setGalleryOpen] = useState(() => stored('kie-gallery-open', false));
  const [mobileTab, setMobileTab] = useState<'parameters' | 'canvas' | 'history'>('canvas');
  const [view, setView] = useState<View | null>(null); const [imageIndex, setImageIndex] = useState(0);
  const [imageError, setImageError] = useState(''); const [loaded, setLoaded] = useState({ url: '', width: 0, height: 0 }); const [stage, setStage] = useState({ width: 0, height: 0 });
  const [copied, setCopied] = useState(false); const [confirmDelete, setConfirmDelete] = useState(''); const formRef = useRef<HTMLFormElement>(null); const presetsRef = useRef<HTMLDetailsElement>(null); const galleryRef = useRef<HTMLDivElement>(null); const stripRef = useRef<HTMLDivElement>(null); const stageRef = useRef<HTMLDivElement>(null);
  const [hideImages, setHideImages] = useState(() => Boolean(stored('kie-hide-images', false)));
  const model = catalog?.models.find(item => item.id === selected);
  const originalInputSchema: Schema = model?.inputSchema || { type: 'object', properties: {} };
  const inputVariants = !originalInputSchema.properties ? originalInputSchema.oneOf || originalInputSchema.anyOf : undefined;
  const variantIndex = variants[selected] || 0;
  const inputSchema: Schema = inputVariants?.[variantIndex] || originalInputSchema;
  const requestOptions = optionsSchema(model?.requestSchema);
  const keys = { input: sharedKeys(inputSchema), options: sharedKeys(requestOptions) };
  const input = resolve(inputSchema, settings.input), options = resolve(requestOptions, settings.options);
  const job = jobs.find(item => item.id === jobId);
  const payload = { model: selected, input, ...(Object.keys(options).length ? { options } : {}) };
  const preview = JSON.stringify({ ...options, model: selected, input }, null, 2);
  const setValue = (section: 'input' | 'options', name: string, value: unknown) => setSettings(old => ({ ...old, [section]: remember(old[section], keys[section][name], value) }));
  const applySettings = (next: Settings) => { setSettings(next); setRevision(value => value + 1); setError(''); };
  const slots = slotsOf(jobs), isShown = (item: Take) => item.job.id === jobId && item.index === imageIndex;
  const position = slots.findIndex(slot => slot.takes.some(isShown)), takes = slots[position]?.takes || [], take = takes.findIndex(isShown);
  // A slot shows the take shown last, or else its newest image.
  const cover = (slot: Slot) => slot.takes.find(isShown) || slot.takes.find(item => `${item.job.id}:${item.index}` === picks[slot.key]) || [...slot.takes].reverse().find(item => item.job.urls[item.index]) || slot.takes[slot.takes.length - 1];
  const show = (item?: Take) => { setJobId(item?.job.id || ''); setImageIndex(item?.index || 0); if (item) setPicks(old => ({ ...old, [slotOf(item.job, item.index)]: `${item.job.id}:${item.index}` })); };
  // The canvas and each gallery entry have their own delete button, so the armed one is named by place and entry.
  const armed = (place: string, id: string, index: number) => confirmDelete === `${place}:${id}:${index}`;
  const deleteEntry = async (place: string, id: string, index: number) => {
    if (!armed(place, id, index)) { setConfirmDelete(`${place}:${id}:${index}`); return; }
    setConfirmDelete('');
    try {
      const data = await api<Job[]>(`/api/jobs/${encodeURIComponent(id)}?index=${index}`, { method: 'DELETE' }), after = slotsOf(data);
      // When the shown take is deleted, its slot shows another take, or else the slot that takes its place is shown.
      const next = after.find(slot => slot.key === slots[position]?.key) || after[Math.min(position, after.length - 1)];
      setJobs(data); if (id === jobId && index === imageIndex) show(next && cover(next));
    } catch (err) { setError(errorText(err)); }
  };
  const takeCount = (slot: Slot) => slot.takes.length > 1 && <span className="take-count" title={`${slot.takes.length} takes`}>{slot.takes.length}</span>;
  const thumb = (item: Job, index: number) => item.urls[index] ? hideImages ? <EyeOff size={18} /> : <img src={`/api/image?job=${encodeURIComponent(item.id)}&index=${index}`} alt="" loading="lazy" /> : pending(item) ? <LoaderCircle size={18} className="spin" /> : <ImageIcon size={18} />;
  useEffect(() => {
    let live = true;
    // Models appear once the workspace has loaded too, so its saved model and parameters show from the start.
    Promise.all([api<Catalog>('/api/catalog'), loadWorkspace()]).then(([data, space]) => { if (!live) return; setCatalog(data); adopt(space); if (!data.models.some(item => item.id === space.selected)) setSelected(data.models.find(item => item.id === 'qwen3/text-to-image')?.id || data.models.find(item => item.supported)?.id || data.models[0]?.id || ''); }).catch(err => { if (live) setError(errorText(err)); }).finally(() => { if (live) setCatalogLoading(false); });
    api<Connection>('/api/connection').then(data => { if (live) setConnection(data); }).catch(err => { if (live) setError(errorText(err)); });
    api<Job[]>('/api/jobs').then(data => { if (live) { const first = slotsOf(data)[0]; setJobs(data); show(first && cover(first)); } }).catch(err => { if (live) setError(errorText(err)); });
    return () => { live = false; };
  }, []);
  useEffect(() => { setImageError(''); setConfirmDelete(''); for (const list of [galleryRef.current, stripRef.current]) list?.querySelector('[aria-current="true"]')?.scrollIntoView({ block: 'nearest' }); }, [jobId, imageIndex]);
  useEffect(() => { const node = stageRef.current!, observer = new ResizeObserver(() => setStage({ width: node.clientWidth, height: node.clientHeight })); observer.observe(node); return () => observer.disconnect(); }, []);
  useEffect(() => { if (picking) document.querySelector('.model-item.selected')?.scrollIntoView({ block: 'center' }); }, [picking]);
  // Hide images and the expanded history belong to this browser. The rest of the workspace lives on the server, shared by every device.
  useEffect(() => { store('kie-hide-images', hideImages); store('kie-gallery-open', galleryOpen); }, [hideImages, galleryOpen]);
  // `synced` is the workspace as the server has it. It stays null until loaded, so the defaults shown before never overwrite it.
  const synced = useRef<string | null>(null), local = useRef(''), saves = useRef(0), saving = useRef(0);
  const workspace = JSON.stringify({ selected, settings, presets, variants, pinned });
  const adopt = (space: Workspace) => { setSelected(space.selected); setSettings(space.settings); setPresets(space.presets); setVariants(space.variants); setPinned(space.pinned); setRevision(value => value + 1); synced.current = JSON.stringify(space); };
  useEffect(() => {
    local.current = workspace;
    if (synced.current === null || workspace === synced.current) return;
    // A change is saved once typing pauses, or at once when the page is hidden or closed.
    const save = () => {
      clearTimeout(timer); if (synced.current === workspace) return;
      synced.current = workspace; saves.current++; saving.current++;
      putWorkspace(workspace, workspace.length < 20000).catch(err => setError(`Settings were not saved: ${errorText(err)}`)).finally(() => { saving.current--; });
    };
    const timer = setTimeout(save, 400); document.addEventListener('visibilitychange', save);
    return () => { clearTimeout(timer); document.removeEventListener('visibilitychange', save); };
  }, [workspace]);
  useEffect(() => {
    // Changes from other devices arrive every few seconds while the page is visible. They wait while this page has changes of its own,
    // and an answer is dropped if a save started after it was asked for, since it may predate that save.
    const pull = () => {
      if (document.hidden || synced.current === null || saving.current) return;
      const mark = saves.current;
      api<Workspace | null>('/api/workspace').then(space => { if (space && mark === saves.current && local.current === synced.current && JSON.stringify(space) !== synced.current) adopt(space); }).catch(() => {});
    };
    const timer = setInterval(pull, 3000); document.addEventListener('visibilitychange', pull);
    return () => { clearInterval(timer); document.removeEventListener('visibilitychange', pull); };
  }, []);
  useEffect(() => {
    const active = jobs.filter(pending); if (!active.length || !connection.connected) return;
    let live = true;
    const timer = window.setTimeout(async () => {
      const results = await Promise.allSettled(active.map(item => api<Job>(`/api/jobs/${encodeURIComponent(item.id)}`)));
      if (!live) return;
      const updates = results.flatMap(result => result.status === 'fulfilled' ? [result.value] : []);
      const errors = results.flatMap(result => result.status === 'rejected' ? [errorText(result.reason)] : []);
      setPollError(errors.join('\n'));
      setJobs(previous => previous.map(item => updates.find(update => update.id === item.id) || item));
      if (updates.some(item => !pending(item))) api<{ credits: unknown }>('/api/credits').then(data => setConnection(old => old.connected ? { ...old, credits: data.credits } : old)).catch(() => {});
    }, 5000);
    return () => { live = false; clearTimeout(timer); };
  }, [jobs, connection.connected]);
  // A key from .env has no known balance until it is first used.
  useEffect(() => { if (connection.connected && connection.credits === null) api<{ credits: unknown }>('/api/credits').then(data => setConnection(old => ({ ...old, credits: data.credits }))).catch(err => setError(errorText(err))); }, [connection.connected, connection.credits]);
  useEffect(() => {
    const shortcut = (event: KeyboardEvent) => {
      const command = event.metaKey || event.ctrlKey;
      // ⇧⌘H works everywhere, even while typing. The physical key is matched so it also works on non-Latin layouts, and a held key toggles only once.
      if (command && event.shiftKey && !event.altKey && event.code === 'KeyH') { event.preventDefault(); if (!event.repeat) setHideImages(value => !value); return; }
      if (showConnection) return;
      if (command && event.key === 'Enter') { event.preventDefault(); formRef.current?.requestSubmit(); return; }
      // Arrow keys browse the gallery unless the user is typing or choosing in a field.
      const step = ({ ArrowUp: -1, ArrowLeft: -1, ArrowDown: 1, ArrowRight: 1 } as Record<string, number>)[event.key];
      if (!step || event.altKey || event.metaKey || event.ctrlKey || event.shiftKey || (event.target as Element).closest('input, textarea, select, [contenteditable]')) return;
      const next = slots[Math.min(slots.length - 1, Math.max(0, position + step))];
      if (next) { event.preventDefault(); show(cover(next)); }
    };
    window.addEventListener('keydown', shortcut); return () => window.removeEventListener('keydown', shortcut);
  });
  const upload = useCallback(async (file: File) => {
    const result = await api<{ url: string }>('/api/upload', { method: 'POST', headers: { 'Content-Type': file.type, 'X-Filename': encodeURIComponent(file.name) }, body: file }); return result.url;
  }, []);
  const refreshCatalog = async () => { setRefreshing(true); setError(''); try { const result = await api<Catalog>('/api/catalog/refresh', { method: 'POST' }); setCatalog(result); if (!result.models.some(item => item.id === selected)) setSelected(result.models.find(item => item.supported)?.id || result.models[0]?.id || ''); } catch (err) { setError(errorText(err)); } finally { setRefreshing(false); } };
  // Starts a task and shows it.
  const launch = async (path: string, body: unknown) => {
    setSubmitting(true); setError('');
    try { const created = await api<Job>(path, jsonPost(body)); setJobs(await api<Job[]>('/api/jobs')); show({ job: created, index: 0 }); setMobileTab('canvas'); } catch (err) { setError(`${errorText(err)}\nIf submission timed out, check task history before retrying; a task may already have been created.`); } finally { setSubmitting(false); }
  };
  const generate = (event: FormEvent) => {
    event.preventDefault(); if (submitting || !model?.supported) return;
    if (!connection.connected) { setShowConnection(true); return; }
    const issues = [...validate(inputSchema, input), ...validate(requestOptions, options, 'options')];
    if (issues.length) { setError(issues.join('\n')); return; }
    launch('/api/jobs', payload);
  };
  // A retry runs the shown task again with the same parameters, as another take of the shown image.
  const retry = () => { if (!job || submitting) return; if (!connection.connected) { setShowConnection(true); return; } launch(`/api/jobs/${encodeURIComponent(job.id)}/retry`, { index: imageIndex }); };
  const groups = new Map<string, Model[]>();
  catalog?.models.filter(item => `${item.name} ${item.id} ${item.family}`.toLowerCase().includes(search.toLowerCase())).sort((a, b) => Number(pinned.includes(b.id)) - Number(pinned.includes(a.id))).forEach(item => { const family = pinned.includes(item.id) ? 'Pinned' : item.family || 'Other'; groups.set(family, [...(groups.get(family) || []), item]); });
  const resultUrl = job?.urls[imageIndex] ? `/api/image?job=${encodeURIComponent(job.id)}&index=${imageIndex}` : '';
  // The canvas is a viewport: the image keeps its natural size at the centre and is moved and scaled. No view means fit.
  const shown = Boolean(resultUrl && !hideImages && !imageError && loaded.url === resultUrl);
  const fit = shown ? Math.max(0.01, Math.min((stage.width - 48) / loaded.width, (stage.height - 48) / loaded.height)) : 1;
  const { scale, x, y } = view || { scale: fit, x: 0, y: 0 };
  useEffect(() => {
    const node = stageRef.current; if (!node || !shown) return;
    // React's wheel listeners are passive, so this one is attached directly to stop the page from scrolling.
    const zoom = (event: WheelEvent) => {
      event.preventDefault();
      const rect = node.getBoundingClientRect(), px = event.clientX - rect.left - rect.width / 2, py = event.clientY - rect.top - rect.height / 2;
      // Trackpad pinches arrive as ctrl+wheel with small deltas; some mice report lines instead of pixels.
      const delta = event.deltaY * (event.deltaMode === 1 ? 33 : 1) * (event.ctrlKey ? 5 : 1);
      // The point under the pointer stays where it is.
      setView(old => { const from = old || { scale: fit, x: 0, y: 0 }; return zoomTo(from, clampScale(from.scale * Math.exp(-delta * 0.002), fit), { x: px, y: py }, { x: px, y: py }); });
    };
    node.addEventListener('wheel', zoom, { passive: false }); return () => node.removeEventListener('wheel', zoom);
  }, [shown, fit]);
  // Fingers or the mouse on the canvas: one pans, two pinch around their midpoint. Each time a finger lands or lifts,
  // the gesture starts again from the view at that moment, so the image never jumps.
  const pointers = useRef(new Map<number, Point>()); const gesture = useRef<{ view: View; start: Map<number, Point> } | null>(null); const latest = useRef<View | null>(null);
  const [panning, setPanning] = useState(false);
  const regrip = () => { gesture.current = pointers.current.size ? { view: latest.current || { scale, x, y }, start: new Map(pointers.current) } : null; setPanning(pointers.current.size > 0); };
  const grab = (event: ReactPointerEvent<HTMLDivElement>) => { if (!shown || event.button !== 0) return; event.currentTarget.setPointerCapture(event.pointerId); pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY }); regrip(); };
  const release = (event: ReactPointerEvent<HTMLDivElement>) => { if (!pointers.current.delete(event.pointerId)) return; regrip(); if (!pointers.current.size) latest.current = null; };
  const move = (event: ReactPointerEvent<HTMLDivElement>) => {
    const current = gesture.current; if (!current || !pointers.current.has(event.pointerId)) return;
    pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    const ids = [...current.start.keys()].slice(0, 2), before = ids.map(id => current.start.get(id)!), after = ids.map(id => pointers.current.get(id)!);
    const rect = event.currentTarget.getBoundingClientRect(), mid = (points: Point[]) => ({ x: points.reduce((sum, p) => sum + p.x, 0) / points.length - rect.left - rect.width / 2, y: points.reduce((sum, p) => sum + p.y, 0) / points.length - rect.top - rect.height / 2 });
    const spread = (points: Point[]) => Math.hypot(points[0].x - points[1].x, points[0].y - points[1].y);
    latest.current = zoomTo(current.view, ids.length > 1 ? clampScale(current.view.scale * spread(after) / Math.max(1, spread(before)), fit) : current.view.scale, mid(before), mid(after)); setView(latest.current);
  };
  return <ImagesHidden.Provider value={hideImages}><div className="app-shell">
    <header className="app-header"><a className="brand" href="/" aria-label="Kie playground"><span className="brand-mark">k</span><span>Kie<span className="brand-divider">/</span><span className="brand-subtitle">Playground</span></span></a><div className="header-right"><span className="local-badge"><span /> Local workspace</span><button className="toolbar-button image-toggle" role="switch" aria-checked={hideImages} title="Hide images (⇧⌘H)" onClick={() => setHideImages(value => !value)}><span>Hide images</span><span className="switch"><span>{hideImages ? <EyeOff size={10} /> : <Eye size={10} />}</span></span></button>{connection.connected && <button className="credits" title="Refresh credit balance" onClick={async () => { try { const data = await api<{ credits: unknown }>('/api/credits'); setConnection(old => ({ ...old, credits: data.credits })); } catch (err) { setError(errorText(err)); } }}>{creditLabel(connection.credits)} <span>credits</span></button>}<button className={`connection-button ${connection.connected ? 'connected' : ''}`} onClick={() => setShowConnection(true)}><span className="connection-dot" />{connection.connected ? 'Connected' : 'Connect API key'}{connection.connected ? <ChevronDown size={13} /> : <KeyRound size={13} />}</button></div></header>
    <nav className="mobile-tabs" aria-label="Workspace panels">{([['parameters', SlidersHorizontal, 'Parameters'], ['canvas', ImageIcon, 'Canvas'], ['history', History, 'History']] as const).map(([tab, Icon, label]) => <button key={tab} className={mobileTab === tab ? 'active' : ''} onClick={() => setMobileTab(tab)}><Icon size={15} />{label}</button>)}</nav>
    <main className={`workspace ${galleryOpen ? 'gallery-open' : ''}`}>
      <aside className={`side-panel panel ${mobileTab === 'parameters' ? 'mobile-active' : ''}`} aria-label={picking || !model ? 'Model picker' : 'Generation parameters'}>{picking || !model ? <>
        <div className="panel-title"><span>Models <span className="count">{catalog?.models.length ?? '—'}</span></span><span className="panel-actions"><button className="icon" title="Refresh from official documentation" aria-label="Refresh catalog" disabled={refreshing} onClick={refreshCatalog}><RefreshCw size={14} className={refreshing ? 'spin' : ''} /></button>{model && <button className="icon" title="Back to parameters" aria-label="Back to parameters" onClick={() => setPicking(false)}><X size={15} /></button>}</span></div>
        <div className="search-wrap"><Search size={14} /><input aria-label="Search models" placeholder="Search models…" autoFocus={!!model} value={search} onChange={event => setSearch(event.target.value)} onKeyDown={event => { if (event.key === 'Escape' && model) setPicking(false); }} /><kbd>⌕</kbd></div><div className="model-list">{catalogLoading ? <div className="list-message"><LoaderCircle size={15} className="spin" /> Loading catalog…</div> : !groups.size ? <div className="list-message">{search ? 'No matching models.' : 'No catalog available.'}</div> : Array.from(groups.entries()).map(([family, models]) => <section className="model-group" key={family}><h2>{family}<span>{models.length}</span></h2>{models.map(item => <div className="model-row" key={item.id}><button className={`model-item ${item.id === selected ? 'selected' : ''}`} aria-pressed={item.id === selected} title={item.id} onClick={() => { setSelected(item.id); setPicking(false); }}><span className="model-item-main"><span>{item.name}</span>{item.id === selected && <span className="selected-dot" />}</span><code>{item.id}</code>{!item.supported && <span className="unsupported-label">Parameters only</span>}</button><button className={`icon pin-button ${pinned.includes(item.id) ? 'active' : ''}`} aria-pressed={pinned.includes(item.id)} aria-label={`Pin ${item.name}`} title={pinned.includes(item.id) ? 'Unpin model' : 'Pin model'} onClick={() => setPinned(old => old.includes(item.id) ? old.filter(id => id !== item.id) : [...old, item.id])}><Pin size={12} /></button></div>)}</section>)}</div><div className="catalog-footer"><div className="catalog-source"><span className="source-dot" />Official API schemas</div><p>{refreshing ? 'Refreshing documentation…' : catalog?.updatedAt ? `Synced ${formatDate(catalog.updatedAt)}` : 'Refresh to load models'}</p>{catalog?.coverage && <details><summary>Catalog coverage</summary><p>{catalog.coverage.imported} imported / {catalog.coverage.discovered} discovered<br />{catalog.coverage.unsupported} unsupported</p><pre>{JSON.stringify(catalog.coverage.failures, null, 2)}</pre></details>}</div>
      </> : <>
        <button className="model-switch" title="Change model" onClick={() => { setSearch(''); setPicking(true); }}><span><strong>{model.name}</strong><code>{model.id}</code></span><ChevronsUpDown size={15} /></button>
        <div className="preset-bar"><details className="presets" ref={presetsRef}><summary><Bookmark size={12} />Presets{presets.length > 0 && <span className="count">{presets.length}</span>}<ChevronDown size={12} /></summary><div className="preset-menu">{presets.map(preset => <div className="preset-item" key={preset.name}><button className="preset-load" onClick={() => { applySettings(preset.settings); presetsRef.current?.removeAttribute('open'); }}>{preset.name}</button><button className="icon" title="Save current settings to this preset" aria-label={`Save current settings to ${preset.name}`} onClick={() => { setPresets(old => old.map(item => item.name === preset.name ? { ...item, settings } : item)); setSavedPreset(preset.name); window.setTimeout(() => setSavedPreset(''), 1600); }}>{savedPreset === preset.name ? <Check size={13} /> : <Save size={13} />}</button><button className="icon" title="Delete preset" aria-label={`Delete preset ${preset.name}`} onClick={() => setPresets(old => old.filter(item => item.name !== preset.name))}><Trash2 size={13} /></button></div>)}{!presets.length && <p className="hint">Save the current settings to reuse them with any model.</p>}<form className="preset-save" onSubmit={event => { event.preventDefault(); const name = presetName.trim(); if (!name) return; setPresets(old => [...old.filter(item => item.name !== name), { name, settings }]); setPresetName(''); }}><input aria-label="Preset name" placeholder="Preset name" value={presetName} onChange={event => setPresetName(event.target.value)} /><button className="text-button" disabled={!presetName.trim()}><Plus size={12} />Save current</button></form></div></details><button className="text-button reset-button" title="Clear the current settings so each model uses its documented defaults" onClick={() => applySettings(noSettings)}><RotateCcw size={12} />Reset to defaults</button></div>
        {error && <div className="error params-mobile-error" role="alert">{error}<button type="button" className="icon" aria-label="Dismiss parameter error" onClick={() => setError('')}><X size={14} /></button></div>}
        <form ref={formRef} onSubmit={generate} className="parameters-form"><div className="params-scroll">{(model.description || model.docsUrl) && <div className="model-info">{model.description && <details className="model-description"><summary>About this model <ChevronDown size={12} /></summary><p>{model.description}</p></details>}{model.docsUrl && <a href={model.docsUrl} target="_blank" rel="noreferrer">API documentation <ArrowUpRight size={12} /></a>}</div>}{!model.supported && <div className="unsupported-notice"><strong>Parameters available · generation unavailable</strong><p>{model.reason || 'This model’s API transport is not supported by this workspace.'}</p></div>}<div className="input-fields" key={`${selected}-${revision}-${variantIndex}`}>
{inputVariants && <div className="field"><div className="field-heading"><label htmlFor="input-variant">Input source</label></div><select id="input-variant" aria-label="Input source" value={variantIndex} onChange={event => { setVariants(old => ({ ...old, [selected]: Number(event.target.value) })); setError(''); }}>
{inputVariants.map((variant, index) => <option key={index} value={index}>{(variant.title || Object.keys(variant.properties || {}).join(' / ') || `Option ${index + 1}`).replace(/_/g, ' ')}</option>)}
</select><p className="hint">Choose one documented input source. Only its fields are sent.</p></div>}
{ordered(inputSchema).map(([name, schema]) => <Field key={name} name={name} schema={schema} required={inputSchema.required?.includes(name)} value={input[name]} upload={upload} onChange={value => setValue('input', name, value)} />)}{!Object.keys(inputSchema.properties || {}).length && <p className="muted">No documented input fields.</p>}{Object.keys(requestOptions.properties || {}).length > 0 && <section className="request-options"><h2>Request options</h2><p className="hint">Top-level API fields, separate from model input.</p>{ordered(requestOptions).map(([name, schema]) => <Field key={name} name={name} schema={schema} required={requestOptions.required?.includes(name)} value={options[name]} upload={upload} onChange={value => setValue('options', name, value)} />)}</section>}</div><div className="request-preview"><details><summary>Request JSON <ChevronDown size={12} /></summary><div className="preview-endpoint"><code>{model.method} {model.endpoint}</code><button type="button" className="icon" title="Copy request JSON" aria-label="Copy request JSON" onClick={async () => { try { await navigator.clipboard.writeText(preview); setCopied(true); window.setTimeout(() => setCopied(false), 1600); } catch { setError('Clipboard unavailable. Select and copy the request JSON manually.'); } }}>{copied ? <Check size={13} /> : <Copy size={13} />}</button></div><pre tabIndex={0}>{preview}</pre><span className="hint">Kie API payload · no API key included</span></details></div></div><div className="generate-footer"><button type={connection.connected ? 'submit' : 'button'} className="primary generate-button" disabled={!model.supported || submitting} onClick={!connection.connected ? () => setShowConnection(true) : undefined}>{submitting ? <LoaderCircle size={15} className="spin" /> : <Sparkles size={15} />}{submitting ? 'Submitting…' : !model.supported ? 'Generation unavailable' : connection.connected ? 'Generate image' : 'Connect to generate'}<kbd>⌘ ↵</kbd></button><span>{submitting ? 'Submitting once. Please don’t retry.' : 'Only documented defaults. No hidden overrides.'}</span></div></form>
      </>}</aside>
      <section className={`canvas-panel panel ${mobileTab === 'canvas' ? 'mobile-active' : ''}`} aria-label="Output canvas"><div className="canvas-toolbar"><div className="canvas-heading"><span>Canvas</span>{job && <span className={`state-label ${job.state}`}>{pending(job) && <LoaderCircle size={11} className="spin" />}{job.state}</span>}</div>{job && <div className="canvas-actions">{takes.length > 1 && <span className="takes"><button className="icon" aria-label="Previous take" disabled={take < 1} onClick={() => show(takes[take - 1])}><ChevronLeft size={15} /></button><span className="take-number" title={`Take ${take + 1} of ${takes.length}`}>{take + 1}/{takes.length}</span><button className="icon" aria-label="Next take" disabled={take >= takes.length - 1} onClick={() => show(takes[take + 1])}><ChevronRight size={15} /></button></span>}<button className="toolbar-button" disabled={submitting || pending(job)} title="Run this task again with the same parameters. The result becomes another take of this image." onClick={retry}><RefreshCw size={14} /><span>Retry</span></button></div>}</div>
      {error && <div className="error global-error" role="alert"><span>{error}</span><button className="icon" aria-label="Dismiss error" onClick={() => setError('')}><X size={14} /></button></div>}
      <div ref={stageRef} className={`canvas-stage ${shown ? 'has-image' : ''} ${panning ? 'panning' : ''}`} onPointerDown={grab} onPointerMove={move} onPointerUp={release} onPointerCancel={release}>
        {resultUrl && hideImages ? <div className="canvas-empty"><div className="empty-symbol"><EyeOff size={32} strokeWidth={1} /></div><h1>Image hidden</h1></div> : resultUrl && !imageError ? <img key={resultUrl} className="output-image" src={resultUrl} alt={`Generated output ${imageIndex + 1} from ${job?.modelName}`} draggable={false} style={{ transform: `translate(-50%, -50%) translate(${x}px, ${y}px) scale(${scale})`, visibility: shown ? undefined : 'hidden' }} onLoad={e => setLoaded({ url: resultUrl, width: e.currentTarget.naturalWidth, height: e.currentTarget.naturalHeight })} onError={() => setImageError('The output image could not be loaded. The provider URL may have expired or the result may not be an image.')} /> : <div className="canvas-empty"><div className={`empty-symbol ${job && pending(job) ? 'working' : ''}`}>{job && pending(job) ? <LoaderCircle size={32} className="spin" strokeWidth={1} /> : <ImageIcon size={32} strokeWidth={1} />}</div><h1>{imageError ? 'Unable to load image' : job?.state === 'fail' ? 'Generation failed' : job && pending(job) ? job.state === 'generating' ? 'Creating your image' : job.state === 'queuing' ? 'In the queue' : 'Waiting for Kie' : job?.state === 'success' ? 'No preview available' : 'Space for your next idea'}</h1><p>{imageError || job?.error || (job && pending(job) ? 'This is the live provider status. Your result will appear here when it’s ready.' : job ? 'The provider returned no image to display. Inspect the task details below.' : 'Choose a model, shape your prompt, and generate. Your actual output will appear here.')}</p>{!job && <div className="empty-steps"><span>01 <b>Choose a model</b></span><span>02 <b>Make it yours</b></span><span>03 <b>Generate</b></span></div>}{job && pending(job) && !connection.connected && <button className="secondary" onClick={() => setShowConnection(true)}><KeyRound size={14} />Reconnect to resume polling</button>}{imageError && <button className="secondary" onClick={() => setImageError('')}><RefreshCw size={14} />Retry image</button>}</div>}
      </div>
      {pollError && <div className="error polling-error" role="alert">Status check failed: {pollError}<span>Retrying every 5 seconds while connected.</span></div>}
      {job?.error && resultUrl && <div className="error">{job.error}</div>}
      {job && <details className="task-details"><summary><span className="task-model">{job.modelName}</span><span className="task-toggle">Task details <ChevronDown size={12} /></span></summary><p className="task-meta">{formatDate(job.createdAt)}{job.creditsConsumed !== undefined && ` · ${job.creditsConsumed} credits used`}</p><pre>{JSON.stringify({ id: job.id, model: job.model, input: job.input, options: job.options, state: job.state, error: job.error, raw: job.raw }, null, 2)}</pre></details>}
      {slots.length > 0 && <div className="filmstrip" ref={stripRef}>{slots.map(slot => { const shownTake = cover(slot), { job: item, index } = shownTake; return <button key={slot.key} className={`thumb ${item.state}`} aria-current={isShown(shownTake)} title={`${item.modelName} · ${formatDate(item.createdAt)}`} onClick={() => show(shownTake)}>{thumb(item, index)}{takeCount(slot)}</button>; })}</div>}
      <div className="canvas-bottom"><div className="zoom-controls" aria-label="Canvas zoom"><button className={!view ? 'active' : ''} onClick={() => setView(null)} title="Fit image"><Maximize size={12} />Fit</button><button className={view?.scale === 1 ? 'active' : ''} onClick={() => setView({ scale: 1, x: 0, y: 0 })}>100%</button><button className={view?.scale === 2 ? 'active' : ''} onClick={() => setView({ scale: 2, x: 0, y: 0 })}>200%</button>{shown && <span className="zoom-level">{Math.round(scale * 100)}%</span>}</div><div className="canvas-actions">{resultUrl ? <a className="toolbar-button download" href={`/api/download?job=${encodeURIComponent(job!.id)}&index=${imageIndex}`} download><Download size={14} /><span>Download</span></a> : <span className="canvas-bottom-note">Image workspace</span>}{job && !pending(job) && <DeleteButton className="toolbar-button delete" label={resultUrl ? 'Delete image' : 'Delete task'} armed={armed('canvas', job.id, imageIndex)} onClick={() => deleteEntry('canvas', job.id, imageIndex)} onBlur={() => setConfirmDelete('')} />}</div></div>
      </section>
      <aside className={`gallery panel ${mobileTab === 'history' ? 'mobile-active' : ''}`} aria-label="History"><div className="panel-title"><span className="gallery-title"><History size={14} />History{jobs.length > 0 && <span className="count">{jobs.length}</span>}</span><button className="icon gallery-toggle" title={galleryOpen ? 'Collapse history' : 'Expand history'} aria-label={galleryOpen ? 'Collapse history' : 'Expand history'} aria-expanded={galleryOpen} onClick={() => setGalleryOpen(value => !value)}>{galleryOpen ? <PanelRightClose size={15} /> : <PanelRightOpen size={15} />}</button></div><div className="gallery-list" ref={galleryRef}>{!jobs.length && <p className="muted">Your generations will appear here.</p>}{slots.map(slot => { const shownTake = cover(slot), { job: item, index } = shownTake; return <div key={slot.key} className="gallery-entry" onMouseLeave={() => setConfirmDelete('')}><button className={`gallery-item ${item.state}`} aria-current={isShown(shownTake)} title={`${item.modelName} · ${formatDate(item.createdAt)}`} onClick={() => { show(shownTake); setMobileTab('canvas'); }}><span className="thumb">{thumb(item, index)}{takeCount(slot)}</span><span className="gallery-details"><strong>{item.modelName}</strong><span>{typeof item.input.prompt === 'string' ? item.input.prompt : item.model}</span><small>{formatDate(item.createdAt)}{item.urls.length > 1 && ` · ${index + 1}/${item.urls.length}`}{item.state !== 'success' && <span className={`state-label ${item.state}`}>{item.state}</span>}</small></span></button>{!pending(item) && <DeleteButton className="gallery-delete" tabIndex={-1} label={item.urls[index] ? 'Delete image' : 'Delete task'} armed={armed('gallery', item.id, index)} onClick={() => deleteEntry('gallery', item.id, index)} onBlur={() => setConfirmDelete('')} />}</div>; })}</div></aside>
    </main>{showConnection && <ConnectionDialog connection={connection} close={() => setShowConnection(false)} change={setConnection} />}
  </div></ImagesHidden.Provider>;
}
