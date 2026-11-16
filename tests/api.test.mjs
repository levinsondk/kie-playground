import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createApp } from '../server.mjs';
import { buildPayload, kieRequest, unpackResult, isPublicAddress } from '../lib/kie.mjs';
test('download addresses exclude private, loopback and mapped IPv6',()=>{
 for(const ip of ['127.0.0.1','10.1.1.1','169.254.169.254','192.168.1.1','172.16.0.1','100.64.0.1','224.0.0.1','::1','::ffff:127.0.0.1','fd00::1','fe80::1','2001:db8::1'])assert.equal(isPublicAddress(ip),false,ip);
 for(const ip of ['1.1.1.1','8.8.8.8','2606:4700:4700::1111'])assert.equal(isPublicAddress(ip),true,ip);
});

// Explicit unit/integration fixtures. These are NOT Kie generation results.
const inputSchema={type:'object',required:['prompt'],properties:{prompt:{type:'string',minLength:1},count:{type:'integer',minimum:1,maximum:4},enabled:{type:'boolean'},style:{type:'string',enum:['plain','ink']},images:{type:'array',items:{type:'string'},maxItems:2}}};
const model={id:'test/model',name:'Test fixture',family:'Test',supported:true,transport:'market',endpoint:'/api/v1/jobs/createTask',inputSchema,requestSchema:{type:'object',required:['model','input'],properties:{model:{type:'string',enum:['test/model']},input:inputSchema,callBackUrl:{type:'string'}}}};
const json=(data,status=200)=>new Response(JSON.stringify(data),{status,headers:{'content-type':'application/json'}});
test('payload preserves false and does not invent absent parameters',()=>assert.deepEqual(buildPayload(model,{prompt:'A ceramic cup',enabled:false}),{model:'test/model',input:{prompt:'A ceramic cup',enabled:false}}));
test('invalid required, enum, number range and types rejected',()=>{
 for(const input of [{},{prompt:''},{prompt:'x',style:'bad'},{prompt:'x',count:9},{prompt:'x',enabled:'false'},{prompt:'x',images:['a','b','c']}])assert.throws(()=>buildPayload(model,input),/parameters/);
});
test('unknown input and attempted model override rejected',()=>{
 assert.throws(()=>buildPayload(model,{prompt:'x',invented:true}),/Unknown input/);
 assert.throws(()=>buildPayload(model,{prompt:'x'},{model:'other'}),/Unknown request/);
});
test('documented request options preserved',()=>assert.equal(buildPayload(model,{prompt:'x'},{callBackUrl:'https://example.com/callback'}).callBackUrl,'https://example.com/callback'));
test('root oneOf input allows documented alternatives while preserving exclusivity',()=>{
 const schema={oneOf:[{type:'object',required:['task_id'],properties:{task_id:{type:'string',minLength:1}}},{type:'object',required:['image_url'],properties:{image_url:{type:'string'}}}]};
 const m={...model,inputSchema:schema,requestSchema:{...model.requestSchema,properties:{...model.requestSchema.properties,input:schema}}};
 assert.equal(buildPayload(m,{task_id:'existing-task'}).input.task_id,'existing-task');
 assert.equal(buildPayload(m,{image_url:'https://example.com/reference.png'}).input.image_url,'https://example.com/reference.png');
 assert.throws(()=>buildPayload(m,{}));assert.throws(()=>buildPayload(m,{task_id:'x',image_url:'https://example.com/a.png'}));
 assert.throws(()=>buildPayload(m,{other:'x'}),/Unknown input/);
});
test('unsupported legacy model fails closed',()=>assert.throws(()=>buildPayload({...model,supported:false,reason:'Legacy not connected'},{prompt:'x'}),/Legacy not connected/));
test('HTTP 200 with Kie error code is an error',async()=>{
 await assert.rejects(kieRequest('/test','fixture-key',{fetchImpl:async()=>json({code:402,msg:'Insufficient credits'})}),e=>e.status===402&&e.message==='Insufficient credits');
});
test('invalid JSON and transport failures are explicit',async()=>{
 await assert.rejects(kieRequest('/test','fixture-key',{fetchImpl:async()=>new Response('bad')}),/non-JSON/);
 await assert.rejects(kieRequest('/test','fixture-key',{fetchImpl:async()=>{throw new Error('private details');}}),/Unable to reach/);
});
test('results accept HTTPS image URLs and handle structured outputs',()=>{
 assert.deepEqual(unpackResult({resultJson:JSON.stringify({resultUrls:['https://example.com/a.png','file:///private','http://127.0.0.1']})}).urls,['https://example.com/a.png']);
 assert.deepEqual(unpackResult({response:{resultObject:{layers:[]}}}).urls,[]);
 assert.throws(()=>unpackResult({resultJson:'bad'}),/invalid result/);
});

test('local API integration: authorization, jobs, errors, refresh safety, persistence',async t=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'kie-tests-'));
 const catalogFile=path.join(dir,'catalog.json');await fs.writeFile(catalogFile,JSON.stringify({models:[model]}));
 let stage='generating',balanceFailure=false,uploadFailures=0,resultUrls=['https://example.com/fixture.png'];const calls=[];
 const upstream=async(url,options={})=>{
  calls.push({url,options});
  if(url.endsWith('/credit'))return json(balanceFailure?{code:401,msg:'Invalid API key'}:{code:200,data:12});
  if(url.endsWith('/file-stream-upload')&&uploadFailures-->0)throw new TypeError('fetch failed');
  if(url.endsWith('/file-stream-upload'))return json({code:200,success:true,data:{downloadUrl:'https://example.com/uploaded-fixture.png'}});
  if(url.startsWith('https://example.com/fixture'))return new Response(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j9ZkAAAAASUVORK5CYII=','base64'),{headers:{'content-type':'image/png'}});
  if(url.endsWith('/createTask'))return json({code:200,data:{taskId:'fixture-upstream-task'}});
  if(url.includes('/recordInfo'))return json({code:200,data:{state:stage,resultJson:stage==='success'?JSON.stringify({resultUrls}):null,creditsConsumed:stage==='success'?1:undefined}});
  throw new Error('Unexpected test endpoint');
 };
 const app=await createApp({fetchImpl:upstream,storageDir:dir,catalogFile,envFile:path.join(dir,'.env')});
 const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
 const base=`http://127.0.0.1:${server.address().port}`;
 const req=(p,body,method=body?'POST':'GET',headers={})=>fetch(base+p,{method,headers:{...(body?{'content-type':'application/json'}:{}),...headers},...(body?{body:JSON.stringify(body)}:{})});
 try{
  await t.test('UI-facing catalog and connection endpoints',async()=>{
   assert.equal((await (await req('/api/catalog')).json()).models[0].id,model.id);
   assert.deepEqual(await (await req('/api/connection')).json(),{connected:false,credits:null,override:false,envKey:false});
  });
  await t.test('no key means no generation or external request',async()=>{
   assert.equal((await req('/api/jobs',{model:model.id,input:{prompt:'cup'}})).status,401);assert.equal(calls.length,0);
  });
  await t.test('cross-origin and DNS-rebinding hosts blocked',async()=>{
   assert.equal((await req('/api/connection',undefined,'GET',{Origin:'https://evil.example'})).status,403);
   const { request: httpRequest } = await import('node:http');
   const status = await new Promise((resolve,reject)=>{
     const r=httpRequest(`${base}/api/health`,{headers:{Host:'evil.example'}},res=>{res.resume();resolve(res.statusCode);});r.on('error',reject);r.end();
   });
   assert.equal(status,403);
  });
  await t.test('connect uses read-only balance and never returns key',async()=>{
   const response=await (await req('/api/connection',{key:'fixture-only-key'})).json();
   assert.deepEqual(response,{connected:true,credits:12,override:true,envKey:false});assert.equal(calls.length,1);
  });
  await t.test('invalid replacement key does not discard working connection',async()=>{
   balanceFailure=true;assert.equal((await req('/api/connection',{key:'invalid-fixture'})).status,401);balanceFailure=false;
   assert.equal((await (await req('/api/connection')).json()).connected,true);
  });
  let id;
  await t.test('valid job sends exact payload, no made-up parameters',async()=>{
   const response=await req('/api/jobs',{model:model.id,input:{prompt:'A ceramic cup',enabled:false}});
   assert.equal(response.status,201);const job=await response.json();id=job.id;
   assert.equal(job.state,'waiting');assert.equal(job.providerTaskId,undefined);
   const call=calls.find(c=>c.url.endsWith('/createTask'));
   assert.deepEqual(JSON.parse(call.options.body),{model:model.id,input:{prompt:'A ceramic cup',enabled:false}});
  });
  await t.test('polling transitions and saves results',async()=>{
   assert.equal((await (await req(`/api/jobs/${id}`)).json()).state,'generating');
   stage='success';const result=await (await req(`/api/jobs/${id}`)).json();assert.equal(result.urls.length,1);assert.equal(result.creditsConsumed,1);
   const n=calls.length;await req(`/api/jobs/${id}`);assert.equal(calls.length,n,'terminal jobs do not poll again');
   const text=await fs.readFile(path.join(dir,'jobs.json'),'utf8');assert(!text.includes('fixture-only-key'));assert(text.includes('fixture-upstream-task'));
  });
  await t.test('reference upload uses documented multipart endpoint, retries a network failure and returns the URL',async()=>{
   uploadFailures=1;const response=await fetch(base+'/api/upload',{method:'POST',headers:{'Content-Type':'image/png','X-Filename':'fixture.png'},body:Buffer.from([137,80,78,71])});
   assert.equal(response.status,200);assert.deepEqual(await response.json(),{url:'https://example.com/uploaded-fixture.png'});
   const sent=calls.filter(c=>c.url.endsWith('/file-stream-upload'));assert.equal(sent.length,2);assert(sent[1].options.body instanceof FormData);assert.equal(sent[1].options.headers.Authorization,'Bearer fixture-only-key');
  });
  await t.test('generated image proxy caches and serves an attachment without forwarding the API key',async()=>{
   const response=await req(`/api/download?job=${id}&index=0`);assert.equal(response.status,200);assert.equal(response.headers.get('content-type'),'image/png');assert.match(response.headers.get('content-disposition'),/attachment/);assert((await response.arrayBuffer()).byteLength>0);
   const imageCalls=calls.filter(c=>c.url==='https://example.com/fixture.png');assert.equal(imageCalls.length,1);assert.equal(imageCalls[0].options.headers,undefined);
   await req(`/api/image?job=${id}&index=0`);assert.equal(calls.filter(c=>c.url==='https://example.com/fixture.png').length,1);
  });
  await t.test('deleting an image keeps the others at their index; the last image takes the task with it',async()=>{
   resultUrls=['https://example.com/fixture.png','https://example.com/fixture-2.png','https://example.com/fixture-3.png'];
   const job=await (await req('/api/jobs',{model:model.id,input:{prompt:'Three cups'}})).json();
   const remove=index=>req(`/api/jobs/${job.id}?index=${index}`,undefined,'DELETE');
   const cached=index=>fs.access(path.join(dir,`${job.id}-${index}.image`)).then(()=>true,()=>false);
   assert.equal((await remove(0)).status,409,'a running task cannot be deleted');
   assert.equal((await (await req(`/api/jobs/${job.id}`)).json()).urls.length,3);
   for(const index of [0,1,2])assert.equal((await req(`/api/image?job=${job.id}&index=${index}`)).status,200);
   let list=await (await remove(1)).json();
   assert.deepEqual(list.find(item=>item.id===job.id).urls,[resultUrls[0],'',resultUrls[2]]);
   assert.deepEqual([await cached(0),await cached(1),await cached(2)],[true,false,true]);
   assert.equal((await req(`/api/image?job=${job.id}&index=1`)).status,404);assert.equal((await remove(1)).status,404);
   const n=calls.length;assert.equal((await req(`/api/image?job=${job.id}&index=2`)).status,200);assert.equal(calls.length,n,'the others are still served from the cache');
   await remove(0);list=await (await remove(2)).json();
   assert(!list.some(item=>item.id===job.id));assert.equal(await cached(2),false);
   assert(!(await fs.readFile(path.join(dir,'jobs.json'),'utf8')).includes(job.id));assert.equal((await remove(0)).status,404);
   // A failed task has no image and is deleted whole.
   stage='fail';const failed=await (await req('/api/jobs',{model:model.id,input:{prompt:'cup'}})).json();await req(`/api/jobs/${failed.id}`);
   assert(!(await (await req(`/api/jobs/${failed.id}`,undefined,'DELETE')).json()).some(item=>item.id===failed.id));
   stage='success';resultUrls=resultUrls.slice(0,1);
  });
  await t.test('a retry runs the task again with the same parameters, as another take of the same image',async()=>{
   const retry=(job,index)=>req(`/api/jobs/${job}/retry`,{index});
   const take=await (await retry(id,0)).json();
   assert.deepEqual(take.slot,{job:id,index:0});
   assert.deepEqual(JSON.parse(calls.at(-1).options.body),{model:model.id,input:{prompt:'A ceramic cup',enabled:false}});
   assert.deepEqual((await (await retry(take.id,0)).json()).slot,{job:id,index:0},'a retry of a take stays in the slot of the first image');
   assert.equal((await retry(id,1)).status,404);assert.equal((await retry('missing',0)).status,404);
   for(const job of (await (await req('/api/jobs')).json()).filter(item=>item.slot)){await req(`/api/jobs/${job.id}`);await req(`/api/jobs/${job.id}`,undefined,'DELETE');}
  });
  await t.test('the workspace is shared by every device and kept across restarts',async()=>{
   assert.equal(await (await req('/api/workspace')).json(),null);
   const space={selected:model.id,settings:{input:{prompt:'Shared'},options:{}},presets:[],variants:{},pinned:[model.id]};
   assert.equal((await req('/api/workspace',space,'PUT')).status,200);
   assert.deepEqual(await (await req('/api/workspace')).json(),space);
   assert.equal((await req('/api/workspace',[space],'PUT')).status,400);
   assert.equal((await fs.stat(path.join(dir,'workspace.json'))).mode&0o777,0o600);
   const restarted=(await createApp({storageDir:dir,catalogFile,envFile:path.join(dir,'.env')})).listen(0,'127.0.0.1');await new Promise(r=>restarted.once('listening',r));
   try{assert.deepEqual(await (await fetch(`http://127.0.0.1:${restarted.address().port}/api/workspace`)).json(),space);}finally{restarted.closeAllConnections();await new Promise(r=>restarted.close(r));}
  });
  await t.test('forget clears server key without deleting history',async()=>{
   await req('/api/connection',undefined,'DELETE');assert.equal((await req('/api/credits')).status,401);
   assert.equal((await (await req('/api/jobs')).json()).length,1);
  });
  await t.test('the key is read from .env when needed, and a key entered in the UI overrides it',async()=>{
   const envFile=path.join(dir,'.env'),bearer=()=>calls.at(-1).options.headers.Authorization;
   assert.match(await fs.readFile(envFile,'utf8'),/^KIE_API_KEY=$/m,'a missing .env is created empty');assert.equal((await fs.stat(envFile)).mode&0o777,0o600);
   await fs.writeFile(envFile,'KIE_API_KEY="fixture-env-key"\n');
   assert.deepEqual(await (await req('/api/connection')).json(),{connected:true,credits:null,override:false,envKey:true});
   await req('/api/credits');assert.equal(bearer(),'Bearer fixture-env-key');
   await req('/api/connection',{key:'fixture-ui-key'});await req('/api/credits');assert.equal(bearer(),'Bearer fixture-ui-key');
   const reverted=await (await req('/api/connection',undefined,'DELETE')).json();assert.equal(reverted.connected&&!reverted.override,true);
   await req('/api/credits');assert.equal(bearer(),'Bearer fixture-env-key');
   await fs.writeFile(envFile,'KIE_API_KEY=\n');assert.equal((await req('/api/credits')).status,401);
  });
 }finally{server.closeAllConnections();await new Promise(r=>server.close(r));await fs.rm(dir,{recursive:true,force:true});}
});

test('on the local network, other devices need the access link and this machine does not',async t=>{
 const address=Object.values(os.networkInterfaces()).flat().find(a=>a.family==='IPv4'&&!a.internal)?.address;
 if(!address)return t.skip('no local network address');
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'kie-tests-')),options={storageDir:dir,envFile:path.join(dir,'.env'),lan:true};
 const app=await createApp(options),token=app.locals.accessToken;
 const server=app.listen(0,'0.0.0.0');await new Promise(r=>server.once('listening',r));
 const port=server.address().port,remote=`http://${address}:${port}`;
 try{
  assert.equal((await fs.stat(path.join(dir,'access-token'))).mode&0o777,0o600);
  assert.equal((await fetch(`${remote}/api/health`)).status,401);assert.equal((await fetch(`${remote}/?token=wrong`)).status,401);
  const link=await fetch(`${remote}/api/health?token=${token}`);assert.equal(link.status,200,'the link works by itself, without a redirect');
  const setCookie=link.headers.get('set-cookie'),cookie=setCookie.split(';')[0];assert.match(setCookie,/HttpOnly/);assert.match(setCookie,/SameSite=Lax/);
  assert.equal((await fetch(`${remote}/api/health`,{headers:{Cookie:cookie}})).status,200);
  const { request: httpRequest } = await import('node:http');
  const rebound=await new Promise((resolve,reject)=>{const r=httpRequest(`${remote}/api/health`,{headers:{Host:'evil.example',Cookie:cookie}},res=>{res.resume();resolve(res.statusCode);});r.on('error',reject);r.end();});
  assert.equal(rebound,403,'DNS rebinding is still refused');
  assert.equal((await fetch(`http://127.0.0.1:${port}/api/health`)).status,200,'this machine needs no link');
  assert.equal((await createApp(options)).locals.accessToken,token,'devices stay signed in across restarts');
 }finally{server.closeAllConnections();await new Promise(r=>server.close(r));await fs.rm(dir,{recursive:true,force:true});}
});
