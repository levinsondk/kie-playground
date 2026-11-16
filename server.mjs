import express from 'express';
import fs from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import dns from 'node:dns/promises';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { parseEnv } from 'node:util';
import { ApiError, buildPayload, kieRequest, unpackResult, isPublicAddress } from './lib/kie.mjs';

const root = path.dirname(fileURLToPath(import.meta.url));
const runtime = path.join(root, 'data/runtime');
const catalogPath = path.join(root, 'data/catalog.json');
const jobsPath = path.join(runtime, 'jobs.json');
// This machine's addresses on the local network.
const networkAddresses = () => Object.values(os.networkInterfaces()).flat().filter(a => a.family === 'IPv4' && !a.internal).map(a => a.address);
export async function createApp({ fetchImpl = fetch, envFile = path.join(root, '.env'), storageDir = runtime, catalogFile = catalogPath, lan = false } = {}) {
  const app = express();
  app.disable('x-powered-by');
  // A key entered in the UI. It overrides the one in .env and is kept only in memory.
  let apiKey = '', credits = null, refreshing = false;
  let jobs = [];
  const historyPath = storageDir === runtime ? jobsPath : path.join(storageDir, 'jobs.json');
  await fs.mkdir(storageDir, { recursive: true, mode: 0o700 });
  // .env is created empty for the user to fill in, and read whenever the key is needed, so an edit applies without a restart.
  await fs.writeFile(envFile, '# Kie API key for this playground. A key entered in the UI overrides it until the server restarts.\nKIE_API_KEY=\n', { mode: 0o600, flag: 'wx' }).catch(e => { if (e.code !== 'EEXIST') throw e; });
  const envKey = () => { try { return parseEnv(readFileSync(envFile, 'utf8')).KIE_API_KEY?.trim() || ''; } catch { return ''; } };
  // On the local network, other devices get in through a link carrying this token, which is then kept in a cookie.
  // It is saved, so devices stay signed in across restarts.
  let accessToken = '';
  if (lan) {
    const tokenPath = path.join(storageDir, 'access-token');
    accessToken = await fs.readFile(tokenPath, 'utf8').then(text => text.trim(), () => '');
    if (!accessToken) { accessToken = crypto.randomBytes(18).toString('base64url'); await fs.writeFile(tokenPath, accessToken, { mode: 0o600 }); }
  }
  app.locals.accessToken = accessToken;
  const tokenMatches = value => { const given = Buffer.from(typeof value === 'string' ? value : ''), wanted = Buffer.from(accessToken); return wanted.length > 0 && given.length === wanted.length && crypto.timingSafeEqual(given, wanted); };
  try { jobs = JSON.parse(await fs.readFile(historyPath, 'utf8')); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  // The chosen model, parameters, presets and pins, shared by every device that opens the playground.
  const workspacePath = path.join(storageDir, 'workspace.json');
  let workspace = null;
  try { workspace = JSON.parse(await fs.readFile(workspacePath, 'utf8')); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  // Files are written one at a time through a temporary file, so a crash never leaves half of one.
  let saveChain = Promise.resolve();
  const save = (file, data) => {
    const text = JSON.stringify(data, null, 2);
    saveChain = saveChain.catch(() => {}).then(async () => { await fs.writeFile(`${file}.tmp`, text, { mode: 0o600 }); await fs.rename(`${file}.tmp`, file); });
    return saveChain;
  };
  const saveJobs = () => save(historyPath, jobs);
  async function catalog() { return JSON.parse(await fs.readFile(catalogFile, 'utf8')); }
  const publicJob = job => { const { providerTaskId, ...rest } = job; return rest; };
  const getJob = id => { const job = jobs.find(j => j.id === id); if (!job) throw new ApiError('Task not found',404); return job; };
  const needKey = () => { const key = apiKey || envKey(); if (!key) throw new ApiError('Connect your Kie API key first',401); return key; };
  const connection = () => { const file = Boolean(envKey()); return { connected: Boolean(apiKey) || file, credits, override: Boolean(apiKey), envKey: file }; };
  const request = (url, options = {}) => kieRequest(url, needKey(), { fetchImpl, ...options });
  app.use((req, res, next) => {
    if (!['127.0.0.1','localhost','[::1]'].includes(req.hostname) && !(accessToken && networkAddresses().includes(req.hostname))) return res.status(403).json({error:'Local access only'});
    if (!['127.0.0.1','::1','::ffff:127.0.0.1'].includes(req.socket.remoteAddress)) {
      // The link's own response sets the cookie, so signing in does not depend on a redirect.
      const cookie = req.get('Cookie')?.match(/(?:^|;\s*)kie_access=([^;]*)/)?.[1], time = new Date().toISOString();
      if (tokenMatches(req.query.token)) { res.cookie('kie_access', accessToken, { httpOnly: true, sameSite: 'lax', maxAge: 365 * 864e5 }); console.log(`${time} signed in ${req.socket.remoteAddress}`); }
      else if (!tokenMatches(cookie)) {
        console.log(`${time} refused ${req.method} ${req.path} from ${req.socket.remoteAddress}: ${req.query.token ? 'wrong token' : cookie ? 'wrong cookie' : 'no token or cookie'}`);
        return res.status(401).type('text').send('Open the link the Kie Playground server printed for this network.');
      }
    }
    if (req.path.startsWith('/api/')) {
      res.set('Cache-Control','no-store');
      const origin = req.get('Origin');
      if ((origin && origin !== `http://${req.get('Host')}`) || req.get('Sec-Fetch-Site') === 'cross-site') return res.status(403).json({error:'Cross-origin access denied'});
    }
    next();
  });
  app.use('/api', express.json({limit:'2mb'}));
  app.get('/api/health', (req,res) => res.json({ok:true}));
  app.get('/api/catalog', async (req,res) => res.json(await catalog()));
  app.post('/api/catalog/refresh', async (req,res,next) => {
    if (refreshing) throw new ApiError('Catalog refresh already running',409);
    refreshing = true;
    try {
      await new Promise((resolve,reject) => {
        const child = spawn(process.execPath,['scripts/sync-catalog.mjs'],{cwd:root,stdio:['ignore','pipe','pipe'],env:{...process.env,KIE_API_KEY:''}});
        let stderr=''; child.stderr.on('data',d=>{stderr=(stderr+d).slice(-1500);}); child.stdout.resume();
        const timer=setTimeout(()=>{child.kill('SIGTERM');reject(new Error('Catalog refresh timed out; the previous catalog is intact'));},240000);
        child.on('error',e=>{clearTimeout(timer);reject(e);});
        child.on('exit',code=>{clearTimeout(timer);code===0?resolve():reject(new Error(`Catalog refresh failed; previous catalog retained. ${stderr}`));});
      });
      res.json(await catalog());
    } catch(e) { next(new ApiError(e.message,502)); } finally { refreshing=false; }
  });
  app.get('/api/connection', (req,res)=>res.json(connection()));
  app.post('/api/connection', async (req,res)=>{
    const key = typeof req.body.key === 'string' ? req.body.key.trim() : '';
    if (!key || key.length > 4096 || /[\r\n]/.test(key)) throw new ApiError('Enter a valid API key');
    const result = await kieRequest('/api/v1/chat/credit',key,{fetchImpl});
    apiKey=key; credits=result.data;
    res.json(connection());
  });
  app.delete('/api/connection',(req,res)=>{apiKey='';credits=null;res.json(connection());});
  app.get('/api/credits',async(req,res)=>{credits=(await request('/api/v1/chat/credit')).data;res.json({credits});});
  app.get('/api/workspace',(req,res)=>res.json(workspace));
  app.put('/api/workspace',async(req,res)=>{
    if(!req.body||typeof req.body!=='object'||Array.isArray(req.body))throw new ApiError('The workspace must be an object');
    workspace=req.body;await save(workspacePath,workspace);res.json({ok:true});
  });
  app.get('/api/jobs',(req,res)=>res.json(jobs.map(publicJob)));
  const findModel=async id=>{const model=(await catalog()).models.find(m=>m.id===id);if(!model)throw new ApiError('Unknown model; refresh the catalog',422);return model;};
  let submitting=false;
  async function submit(model,input,options,slot){
    needKey();
    if (submitting) throw new ApiError('A request is already being submitted',409);
    const payload=buildPayload(model,input,options);
    submitting=true;
    try {
      // Intentionally no automatic POST retry: a timeout can still mean a billable task was created.
      const result=await request(model.endpoint,{method:'POST',body:payload});
      const taskId=result.data?.taskId;
      if(typeof taskId!=='string' || !taskId)throw new ApiError('Kie returned no task ID. Check your Kie task history before retrying.',502);
      const now=new Date().toISOString();
      const job={id:crypto.randomUUID(),providerTaskId:taskId,model:model.id,modelName:model.name,input:payload.input,options:options||{},...(slot&&{slot}),state:'waiting',createdAt:now,updatedAt:now,urls:[]};
      jobs.unshift(job); await saveJobs();return publicJob(job);
    }finally{submitting=false;}
  }
  app.post('/api/jobs',async(req,res)=>{needKey();res.status(201).json(await submit(await findModel(req.body.model),req.body.input,req.body.options));});
  // A retry runs a task again with the same parameters. Its images are more takes of the retried image, which keeps its slot.
  app.post('/api/jobs/:id/retry',async(req,res)=>{
    const job=getJob(req.params.id),index=Number(req.body?.index||0);
    if(!Number.isInteger(index)||index<0||index>=Math.max(1,job.urls.length))throw new ApiError('Image not found',404);
    needKey();res.status(201).json(await submit(await findModel(job.model),job.input,job.options,job.slot||{job:job.id,index}));
  });
  const polling=new Map();
  app.get('/api/jobs/:id',async(req,res)=>{
    const job=getJob(req.params.id);
    if(['success','fail'].includes(job.state))return res.json(publicJob(job));
    needKey();
    if(!polling.has(job.id)) {
      polling.set(job.id,(async()=>{
        const result=await request(`/api/v1/jobs/recordInfo?taskId=${encodeURIComponent(job.providerTaskId)}`);
        const data=result.data;
        if(!data || !['waiting','queuing','generating','success','fail'].includes(data.state))throw new ApiError('Kie returned an unrecognized task state',502);
        job.state=data.state;job.updatedAt=new Date().toISOString();
        if(data.state==='fail')job.error=data.failMsg||`Generation failed (${data.failCode||'unknown'})`;
        if(data.state==='success') {
          const result=unpackResult(data);job.urls=result.urls;job.raw=result.raw;
          if(!job.urls.length)job.error='Task completed without a preview image. Inspect the raw result.';
        }
        if(typeof data.creditsConsumed==='number')job.creditsConsumed=data.creditsConsumed;
        await saveJobs();
      })().finally(()=>polling.delete(job.id)));
    }
    await polling.get(job.id);res.json(publicJob(job));
  });
  app.post('/api/upload',express.raw({type:['image/*','application/octet-stream'],limit:'25mb'}),async(req,res)=>{
    const key=needKey();
    if(!Buffer.isBuffer(req.body)||!req.body.length)throw new ApiError('Choose an image file');
    let name;try{name=decodeURIComponent(req.get('X-Filename')||'reference.png');}catch{throw new ApiError('Invalid filename');}
    const mime=req.get('Content-Type')?.split(';')[0]||'image/png';
    if(!['image/png','image/jpeg','image/webp','image/gif','image/avif'].includes(mime))throw new ApiError('Use PNG, JPEG, WebP, GIF, or AVIF');
    const form=new FormData();
    const filename=`${crypto.randomUUID()}-${path.basename(name).replace(/[^a-zA-Z0-9._-]/g,'_')}`;
    form.append('file',new Blob([req.body],{type:mime}),filename);form.append('uploadPath','images/kie-playground');form.append('fileName',filename);
    // Uploads are free and create no task, so transient network failures are retried.
    let response;
    for(let attempt=1;!response;attempt++){
      try{response=await fetchImpl('https://kieai.redpandaai.co/api/file-stream-upload',{method:'POST',headers:{Authorization:`Bearer ${key}`},body:form,signal:AbortSignal.timeout(120000),redirect:'error'});}
      catch(e){
        if(e.name==='TimeoutError')throw new ApiError('Upload to Kie timed out after 2 minutes',504);
        if(attempt===3)throw new ApiError(`Upload could not reach Kie${/^[A-Z_]+$/.test(e.cause?.code||'')?` (${e.cause.code})`:''}. Try again.`,502);
        await new Promise(resolve=>setTimeout(resolve,attempt*500));
      }
    }
    let data;try{data=await response.json();}catch{throw new ApiError('Upload returned an invalid response',502);}
    if(!response.ok||Number(data.code)!==200||data.success===false)throw new ApiError(data.msg||'Upload failed',502);
    const url=data.data?.downloadUrl;
    if(typeof url!=='string'||!url.startsWith('https://'))throw new ApiError('Upload returned no HTTPS URL',502);
    res.json({url});
  });
  const imageLoads=new Map();
  const cacheFile=(job,index)=>path.join(storageDir,`${job.id}-${index}.image`);
  async function image(req,res,attachment) {
    const job=getJob(String(req.query.job||''));const index=Number(req.query.index||0);
    if(!Number.isInteger(index)||index<0||!job.urls[index])throw new ApiError('Image not found',404);
    const cachePath=cacheFile(job,index),metaPath=cachePath+'.json';
    const cacheKey=cachePath;
    if(!imageLoads.has(cacheKey))imageLoads.set(cacheKey,(async()=>{
      try{const meta=JSON.parse(await fs.readFile(metaPath,'utf8'));await fs.access(cachePath);return meta;}catch{}
      let url=job.urls[index],response;
      for(let i=0;i<4;i++){
        const parsed=new URL(url);
        if(parsed.protocol!=='https:'||parsed.username||parsed.password)throw new ApiError('Invalid image URL',502);
        const addresses=await dns.lookup(parsed.hostname,{all:true});
        if(!addresses.length || addresses.some(({address})=>!isPublicAddress(address)))throw new ApiError('Private image address blocked',403);
        response=await fetchImpl(url,{redirect:'manual',signal:AbortSignal.timeout(60000)});
        if([301,302,303,307,308].includes(response.status)){url=new URL(response.headers.get('location'),url).href;continue;}break;
      }
      if(!response?.ok)throw new ApiError('Unable to download generated image; the provider URL may have expired',502);
      const mime=response.headers.get('content-type')?.split(';')[0]||'';
      if(!['image/png','image/jpeg','image/webp','image/gif','image/avif'].includes(mime))throw new ApiError('Result is not a supported image',422);
      let length=0;const parts=[];
      for await(const chunk of response.body){length+=chunk.length;if(length>80*1024*1024)throw new ApiError('Image exceeds the 80 MB download limit',413);parts.push(chunk);}
      await fs.writeFile(cachePath,Buffer.concat(parts),{mode:0o600});
      const meta={mime};await fs.writeFile(metaPath,JSON.stringify(meta),{mode:0o600});return meta;
    })().finally(()=>imageLoads.delete(cacheKey)));
    const meta=await imageLoads.get(cacheKey);
    res.type(meta.mime);res.set('X-Content-Type-Options','nosniff');
    if(attachment){const ext={'image/jpeg':'jpg','image/png':'png','image/webp':'webp','image/gif':'gif','image/avif':'avif'}[meta.mime];res.set('Content-Disposition',`attachment; filename="kie-${job.id}-${index+1}.${ext}"`);}
    // The resolved file is generated from a server-owned job ID, never a user path.
    res.sendFile(cachePath, { dotfiles: 'allow' });
  }
  app.get('/api/image',(req,res,next)=>image(req,res,false).catch(next));
  app.get('/api/download',(req,res,next)=>image(req,res,true).catch(next));
  // Deletion is local only; nothing is removed at Kie.
  app.delete('/api/jobs/:id',async(req,res)=>{
    const job=getJob(req.params.id),index=Number(req.query.index||0),kept=job.urls.filter(Boolean).length;
    if(!['success','fail'].includes(job.state))throw new ApiError('Wait for the task to finish before deleting it',409);
    if(kept&&!job.urls[index])throw new ApiError('Image not found',404);
    // A deleted image leaves an empty slot, so the other images keep their index and cached file. The task goes with its last image.
    const files=(kept>1?[index]:[...job.urls.keys()]).map(i=>cacheFile(job,i));
    if(kept>1)job.urls[index]='';else jobs=jobs.filter(item=>item!==job);
    await saveJobs();
    // A download still in progress would write its file back after the removal, so it finishes first.
    await Promise.allSettled(files.map(file=>imageLoads.get(file)));
    await Promise.all(files.flatMap(file=>[file,file+'.json']).map(file=>fs.rm(file,{force:true})));
    res.json(jobs.map(publicJob));
  });
  app.use('/api',(req,res)=>res.status(404).json({error:'Unknown API route'}));
  app.use((err,req,res,next)=>{
    if(!req.path.startsWith('/api/'))return next(err);
    // Never include request headers, API keys, or raw networking errors in logs/responses.
    res.status(err.status||500).json({error:err instanceof ApiError?err.message:err.type==='entity.too.large'?'File or request too large':'Local server error',...(err.details?{details:err.details}:{})});
  });
  return app;
}
if(process.argv[1] && path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  // HOST=0.0.0.0 (npm run start:lan) also serves other devices on the local network, through a link with an access token.
  const host=process.env.HOST||'127.0.0.1',lan=!['127.0.0.1','localhost','::1'].includes(host);
  const app=await createApp({lan});
  if(process.env.NODE_ENV==='production'){
    app.use(express.static(path.join(root,'dist')));app.get('/{*splat}',(req,res)=>res.sendFile(path.join(root,'dist/index.html')));
  }else{
    const {createServer}=await import('vite');
    const vite=await createServer({root,server:{middlewareMode:true},appType:'spa'});
    // Vite's dev server returns any project file through ?raw and similar URLs, so .env files and the task history are refused first.
    // A URL path can name a file under the project or, after /@fs/ or /@id/, an absolute one.
    const hidden=file=>{file=path.resolve(file).toLowerCase();const data=runtime.toLowerCase();return (path.dirname(file)===root.toLowerCase()&&path.basename(file).startsWith('.env'))||file===data||file.startsWith(data+path.sep);};
    app.use((req,res,next)=>{
      let url;try{url=decodeURIComponent(req.path).replace(/^\/@(fs|id)(?=\/)/,'');}catch{return res.status(400).end();}
      if(hidden(path.join(root,url))||hidden(url))return res.status(403).end();
      next();
    });
    app.use(vite.middlewares);
  }
  const port=Number(process.env.PORT||5173);
  const server=app.listen(port,host,()=>{
    console.log(`Kie Playground · http://127.0.0.1:${port}`);
    for(const address of lan?networkAddresses():[])console.log(`On your network · http://${address}:${port}/?token=${app.locals.accessToken}`);
  });
  server.on('error',e=>{console.error(e.code==='EADDRINUSE'?`Port ${port} is already in use`:e.message);process.exit(1);});
}
