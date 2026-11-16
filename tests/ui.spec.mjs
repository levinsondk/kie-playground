import { test as base, expect } from '@playwright/test';
import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../server.mjs';
const catalog=JSON.parse(fs.readFileSync(new URL('../data/catalog.json',import.meta.url),'utf8'));
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j9ZkAAAAASUVORK5CYII=','base64');
const field=(page,name)=>page.locator('.field').filter({has:page.locator('.field-api > code',{hasText:new RegExp(`^${name}$`)})});
// The model picker opens from the parameters panel and closes once a model is chosen.
async function pick(page,id){await page.locator('.model-switch').click();await page.locator(`button.model-item[title="${id}"]`).click();await expect(page.locator('.model-switch code')).toHaveText(id);}
// Every test gets its own server: an empty temporary folder for history and workspace, and no API key.
// Nothing a test does can reach the user's data or start a paid task.
const test=base.extend({baseURL:async({},use)=>{
 const dir=await fs.promises.mkdtemp(path.join(os.tmpdir(),'kie-ui-'));
 const app=await createApp({storageDir:dir,envFile:path.join(dir,'.env')});app.use(express.static(process.env.KIE_UI_DIST));
 const server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));
 await use(`http://127.0.0.1:${server.address().port}`);
 server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await fs.promises.rm(dir,{recursive:true,force:true});
}});

test('all official models render their own parameter names with no JS errors',async({page})=>{
 const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.goto('/');await page.locator('.model-switch').click();await expect(page.locator('.model-item')).toHaveCount(catalog.models.length);
 await page.getByRole('textbox',{name:'Search models'}).press('Escape');
 for(const model of catalog.models){
  await pick(page,model.id);
  const variants=model.inputSchema.properties?[model.inputSchema]:(model.inputSchema.oneOf||model.inputSchema.anyOf||[model.inputSchema]);
  for(let index=0;index<variants.length;index++){
   if(variants.length>1)await page.getByRole('combobox',{name:'Input source',exact:true}).selectOption(String(index));
   const names=await page.locator('.input-fields > .field > .field-api > code').allTextContents();
   expect(names.sort(),model.id+' variant '+index).toEqual(Object.keys(variants[index].properties||{}).sort());
  }
 }
 expect(errors).toEqual([]);
});

test('search, shared settings across models and key dialog',async({page})=>{
 await page.goto('/');await page.locator('.model-switch').click();await page.getByRole('textbox',{name:'Search models'}).fill('Qwen3');
 await expect(page.locator('.model-item')).toHaveCount(4);
 await page.locator('button[title="qwen3/text-to-image"]').click();
 await field(page,'prompt').locator('textarea').fill('A ceramic teapot on a wooden table');
 // Resolution controls must never masquerade as image-upload fields.
 await expect(field(page,'image_size').locator('input[type=file]')).toHaveCount(0);
 await field(page,'image_size').locator('select').selectOption({label:'9:16'});
 // Nano Banana Pro calls the same setting aspect_ratio, so the prompt and the ratio both carry over.
 await pick(page,'nano-banana-pro');
 await expect(field(page,'prompt').locator('textarea')).toHaveValue('A ceramic teapot on a wooden table');
 await expect(page.locator('.request-preview pre')).toContainText('"aspect_ratio": "9:16"');
 await page.getByRole('button',{name:'Connect API key',exact:true}).click();
 await expect(page.getByRole('dialog')).toBeVisible();await expect(page.getByRole('dialog')).toContainText('.env file');
 await page.getByRole('button',{name:'Close connection dialog'}).click();
 expect(await page.evaluate(()=>JSON.stringify(localStorage))).not.toContain('apiKey');
});

test('explicit UI-only fixture: submit, preview, history and download',async({page})=>{
 // No real key, generation, or billable endpoint is used by this test.
 const fixture={id:'ui-fixture',model:'qwen3/text-to-image',modelName:'TEST FIXTURE (not a real generation)',input:{prompt:'A ceramic teapot'},state:'success',createdAt:'2026-01-01T00:00:00Z',updatedAt:'2026-01-01T00:00:00Z',urls:['https://example.com/fixture.png'],creditsConsumed:0};
 let created=false,sent;
 await page.route('**/api/connection',r=>r.fulfill({json:{connected:true,credits:100}}));
 await page.route('**/api/jobs',async r=>{
  if(r.request().method()==='POST'){sent=r.request().postDataJSON();created=true;await r.fulfill({status:201,json:fixture});}
  else await r.fulfill({json:created?[fixture]:[]});
 });
 await page.route('**/api/image?*',r=>r.fulfill({contentType:'image/png',body:png}));
 await page.goto('/');await pick(page,'qwen3/text-to-image');
 await field(page,'prompt').locator('textarea').fill('A ceramic teapot');
 await page.locator('.generate-button').click();
 await expect(page.locator('.output-image')).toBeVisible();
 await expect(page.locator('.output-image')).toHaveJSProperty('naturalWidth',1);
 expect(sent.model).toBe('qwen3/text-to-image');expect(sent.input.prompt).toBe('A ceramic teapot');
 await expect(page.getByRole('link',{name:'Download',exact:true})).toHaveAttribute('href','/api/download?job=ui-fixture&index=0');
 await expect(page.locator('.gallery-item')).toHaveCount(1);await expect(page.locator('.gallery-item')).toHaveAttribute('aria-current','true');
 const toggle=page.getByRole('switch',{name:'Hide images'});await toggle.click();await expect(toggle).toHaveAttribute('aria-checked','true');await expect(page.locator('img')).toHaveCount(0);
 // Hidden images show a crossed eye, unlike tasks that have no image.
 await expect(page.locator('.gallery-item .lucide-eye-off')).toBeVisible();await expect(page.locator('.empty-symbol .lucide-eye-off')).toBeVisible();
 await page.reload();await expect(page.getByRole('heading',{name:'Image hidden'})).toBeVisible();await expect(page.locator('img')).toHaveCount(0);
 // ⇧⌘H toggles Hide images, even while typing.
 await field(page,'prompt').locator('textarea').press('ControlOrMeta+Shift+h');await expect(page.locator('.output-image')).toBeVisible();
 await page.keyboard.press('ControlOrMeta+Shift+h');await expect(page.locator('img')).toHaveCount(0);
 // Plain ⌘H stays with the system, which uses it to hide the app.
 await page.keyboard.press('ControlOrMeta+h');await expect(page.getByRole('heading',{name:'Image hidden'})).toBeVisible();
});

test('history sidebar: arrow keys switch images and the sidebar expands',async({page})=>{
 // Fixture tasks only; nothing is generated.
 const job=(id,urls,createdAt)=>({id,model:'qwen3/text-to-image',modelName:`TEST FIXTURE ${id}`,input:{prompt:`Fixture prompt ${id}`},state:'success',createdAt,updatedAt:createdAt,urls});
 await page.route('**/api/jobs',r=>r.fulfill({json:[job('b',['https://example.com/1.png','https://example.com/2.png'],'2026-01-02T00:00:00Z'),job('a',['https://example.com/3.png'],'2026-01-01T00:00:00Z')]}));
 await page.route('**/api/image?*',r=>r.fulfill({contentType:'image/png',body:png}));
 await page.goto('/');
 const items=page.locator('.gallery-item');await expect(items).toHaveCount(3);await expect(items.nth(0)).toHaveAttribute('aria-current','true');
 // The thumbnail strip is for phones only.
 await expect(page.locator('.filmstrip')).toBeHidden();
 await page.keyboard.press('ArrowDown');await expect(items.nth(1)).toHaveAttribute('aria-current','true');
 await expect(page.locator('.output-image')).toHaveAttribute('src','/api/image?job=b&index=1');
 await page.keyboard.press('ArrowRight');await expect(items.nth(2)).toHaveAttribute('aria-current','true');await expect(page.locator('.task-model')).toHaveText('TEST FIXTURE a');
 await page.keyboard.press('ArrowUp');await page.keyboard.press('ArrowLeft');await expect(items.nth(0)).toHaveAttribute('aria-current','true');
 // Arrow keys inside a text field move the caret, not the selection.
 await field(page,'prompt').locator('textarea').press('ArrowDown');await expect(items.nth(0)).toHaveAttribute('aria-current','true');
 await expect(items.nth(0).locator('.gallery-details')).toBeHidden();
 await page.getByRole('button',{name:'Expand history'}).click();
 await expect(items.nth(0).locator('.gallery-details')).toContainText('Fixture prompt b');await expect(items.nth(1)).toContainText('2/2');
 await page.reload();await expect(page.getByRole('button',{name:'Collapse history'})).toBeVisible();
});

test('delete takes a second click, from the canvas or from a gallery item on hover',async({page})=>{
 // Fixture tasks only; the delete requests are answered here and never reach the local server.
 const job=(id,urls,state='success')=>({id,model:'qwen3/text-to-image',modelName:`TEST FIXTURE ${id}`,input:{prompt:`Fixture prompt ${id}`},state,createdAt:'2026-01-01T00:00:00Z',updatedAt:'2026-01-01T00:00:00Z',urls});
 let jobs=[job('b',['https://example.com/1.png','https://example.com/2.png']),job('a',['https://example.com/3.png']),job('c',[],'fail')];const deleted=[];
 await page.route('**/api/jobs',r=>r.fulfill({json:jobs}));
 await page.route('**/api/jobs/*',r=>{
  const url=new URL(r.request().url()),id=url.pathname.split('/').pop(),index=Number(url.searchParams.get('index'));
  deleted.push(`${r.request().method()} ${id}/${index}`);
  jobs=jobs.flatMap(item=>item.id!==id?[item]:item.urls.filter(Boolean).length>1?[{...item,urls:item.urls.map((u,i)=>i===index?'':u)}]:[]);
  return r.fulfill({json:jobs});
 });
 await page.route('**/api/image?*',r=>r.fulfill({contentType:'image/png',body:png}));
 await page.goto('/');
 const items=page.locator('.gallery-item'),entries=page.locator('.gallery-entry'),image=page.locator('.output-image'),bar=page.locator('.canvas-bottom');
 await expect(items).toHaveCount(4);
 // Moving to another image cancels a pending confirmation.
 await bar.getByRole('button',{name:'Delete image'}).click();await expect(bar.getByRole('button',{name:'Delete?'})).toBeVisible();
 await page.keyboard.press('ArrowDown');await expect(bar.getByRole('button',{name:'Delete?'})).toHaveCount(0);
 await page.keyboard.press('ArrowUp');await bar.getByRole('button',{name:'Delete image'}).click();await bar.getByRole('button',{name:'Delete?'}).click();
 expect(deleted).toEqual(['DELETE b/0']);await expect(items).toHaveCount(3);
 // The entry that takes the deleted one's place is shown.
 await expect(image).toHaveAttribute('src','/api/image?job=b&index=1');await expect(items.nth(0)).toHaveAttribute('aria-current','true');
 // A gallery item shows its own delete button on hover. Leaving the item cancels a pending confirmation.
 const other=entries.nth(1);await expect(other.locator('.gallery-delete')).toBeHidden();
 await other.hover();await other.getByRole('button',{name:'Delete image'}).click();await expect(other.getByRole('button',{name:'Delete?'})).toBeVisible();
 await page.mouse.move(0,0);await other.hover();await other.getByRole('button',{name:'Delete image'}).click();await other.getByRole('button',{name:'Delete?'}).click();
 // Deleting another entry keeps the selection.
 expect(deleted).toEqual(['DELETE b/0','DELETE a/0']);await expect(items).toHaveCount(2);
 await expect(image).toHaveAttribute('src','/api/image?job=b&index=1');await expect(items.nth(0)).toHaveAttribute('aria-current','true');
 // A failed task has no image, so the whole task is deleted; the previous entry is shown after the last one goes.
 await page.keyboard.press('ArrowDown');await bar.getByRole('button',{name:'Delete task'}).click();await bar.getByRole('button',{name:'Delete?'}).click();
 await expect(items).toHaveCount(1);await expect(image).toHaveAttribute('src','/api/image?job=b&index=1');
 expect(deleted).toEqual(['DELETE b/0','DELETE a/0','DELETE c/0']);
});

test('canvas zooms with the wheel around the pointer and pans by dragging',async({page})=>{
 // Fixture task and image only; nothing is generated.
 await page.route('**/api/jobs',r=>r.fulfill({json:[{id:'z',model:'qwen3/text-to-image',modelName:'TEST FIXTURE',input:{prompt:'Fixture'},state:'success',createdAt:'2026-01-01T00:00:00Z',updatedAt:'2026-01-01T00:00:00Z',urls:['https://example.com/z.png']}]}));
 await page.route('**/api/image?*',r=>r.fulfill({contentType:'image/svg+xml',body:'<svg xmlns="http://www.w3.org/2000/svg" width="400" height="200"><rect width="400" height="200" fill="#888"/></svg>'}));
 await page.goto('/');
 const stage=page.locator('.canvas-stage'),image=page.locator('.output-image'),level=page.locator('.zoom-level'),fit=page.getByRole('button',{name:'Fit',exact:true});
 await expect(image).toHaveJSProperty('naturalWidth',400);await expect(stage).toHaveCSS('cursor','grab');await expect(fit).toHaveClass('active');
 await page.getByRole('button',{name:'100%'}).click();await expect(level).toHaveText('100%');
 // At 100% the image spans the centre ±200×±100, so this point sits three quarters across and down it.
 const area=await stage.boundingBox(),point={x:area.x+area.width/2+100,y:area.y+area.height/2+50};
 await page.mouse.move(point.x,point.y);await page.mouse.wheel(0,-200);
 await expect.poll(async()=>parseInt(await level.textContent())).toBeGreaterThan(100);
 const zoomed=await image.boundingBox();
 expect((point.x-zoomed.x)/zoomed.width).toBeCloseTo(0.75,2);expect((point.y-zoomed.y)/zoomed.height).toBeCloseTo(0.75,2);
 await page.mouse.down();await expect(stage).toHaveCSS('cursor','grabbing');
 await page.mouse.move(point.x+60,point.y+40);await page.mouse.up();await expect(stage).toHaveCSS('cursor','grab');
 const panned=await image.boundingBox();expect(panned.x-zoomed.x).toBeCloseTo(60,0);expect(panned.y-zoomed.y).toBeCloseTo(40,0);
 await fit.click();await expect(fit).toHaveClass('active');
});

test.describe('on a touch screen',()=>{
 test.use({hasTouch:true,viewport:{width:390,height:844}});
 test('two fingers pinch around their midpoint and pan; lifting one never jumps the image',async({page})=>{
  // Fixture task and image only; nothing is generated.
  await page.route('**/api/jobs',r=>r.fulfill({json:[{id:'z',model:'qwen3/text-to-image',modelName:'TEST FIXTURE',input:{prompt:'Fixture'},state:'success',createdAt:'2026-01-01T00:00:00Z',updatedAt:'2026-01-01T00:00:00Z',urls:['https://example.com/z.png']}]}));
  await page.route('**/api/image?*',r=>r.fulfill({contentType:'image/svg+xml',body:'<svg xmlns="http://www.w3.org/2000/svg" width="400" height="200"><rect width="400" height="200" fill="#888"/></svg>'}));
  await page.goto('/');
  const image=page.locator('.output-image');await expect(image).toHaveJSProperty('naturalWidth',400);
  // Real touch input through the browser, so pointer capture and touch-action behave as on a phone.
  const client=await page.context().newCDPSession(page),touch=(type,...touchPoints)=>client.send('Input.dispatchTouchEvent',{type,touchPoints});
  const centre=async()=>{const b=await image.boundingBox();return{x:b.x+b.width/2,y:b.y+b.height/2,width:b.width};};
  const near=async(expected)=>{for(const key of ['x','y','width'])await expect.poll(async()=>(await centre())[key]).toBeCloseTo(expected[key],0);};
  const start=await centre(),mid={x:Math.round(start.x)+40,y:Math.round(start.y)+30};
  await page.evaluate(()=>{window.fingers=[];addEventListener('pointerdown',event=>fingers.push(event.pointerId),true);});
  await touch('touchStart',{x:mid.x-50,y:mid.y,id:0},{x:mid.x+50,y:mid.y,id:1});
  // Twice the spread doubles the image, and the point under the midpoint stays there.
  await touch('touchMove',{x:mid.x-100,y:mid.y,id:0},{x:mid.x+100,y:mid.y,id:1});
  const pinched={x:2*start.x-mid.x,y:2*start.y-mid.y,width:start.width*2};await near(pinched);
  await touch('touchMove',{x:mid.x-70,y:mid.y+20,id:0},{x:mid.x+130,y:mid.y+20,id:1});
  const panned={...pinched,x:pinched.x+30,y:pinched.y+20};await near(panned);
  // The first finger lifts: the other one carries on panning from where the image is.
  // CDP can only lift every finger at once, so this finger's lift is sent as the pointerup a phone sends.
  await page.evaluate(()=>document.querySelector('.canvas-stage').dispatchEvent(new PointerEvent('pointerup',{pointerId:fingers[0],pointerType:'touch',bubbles:true})));await near(panned);
  await touch('touchMove',{x:mid.x+105,y:mid.y+35,id:1});await near({...panned,x:panned.x-25,y:panned.y+15});
  await touch('touchEnd');
 });
});

test('settings, selected model and pins survive a reload; reset restores defaults',async({page})=>{
 const id='qwen3/pro-text-to-image',name=catalog.models.find(m=>m.id===id).name,prompt=field(page,'prompt').locator('textarea');
 await page.goto('/');await pick(page,id);await prompt.fill('A ceramic teapot');
 await page.locator('.model-switch').click();await page.getByRole('button',{name:`Pin ${name}`}).click();await page.getByRole('button',{name:'Back to parameters'}).click();
 await page.reload();await expect(page.locator('.model-switch code')).toHaveText(id);await expect(prompt).toHaveValue('A ceramic teapot');
 await page.locator('.model-switch').click();
 await expect(page.locator('.model-group').first().locator('h2')).toContainText('Pinned');await expect(page.locator('.model-group').first().locator('.model-item')).toHaveAttribute('title',id);
 await page.getByRole('button',{name:'Back to parameters'}).click();
 await page.getByRole('button',{name:'Reset to defaults'}).click();await expect(prompt).toHaveValue('');
});

test('presets save the current settings and load them on any model',async({page})=>{
 const prompt=field(page,'prompt').locator('textarea');
 await page.goto('/');await prompt.fill('A ceramic teapot');
 await page.locator('.presets summary').click();await page.getByRole('textbox',{name:'Preset name'}).fill('Teapot');await page.getByRole('button',{name:'Save current',exact:true}).click();
 await page.getByRole('button',{name:'Reset to defaults'}).click();await expect(prompt).toHaveValue('');
 await pick(page,'nano-banana-pro');
 await page.locator('.presets summary').click();await page.getByRole('button',{name:'Teapot',exact:true}).click();await expect(prompt).toHaveValue('A ceramic teapot');
 // Saving into an existing preset replaces its settings.
 await prompt.fill('A glass teapot');await page.locator('.presets summary').click();
 await page.getByRole('button',{name:'Save current settings to Teapot'}).click();await expect(page.locator('.preset-item .lucide-check')).toBeVisible();
 await page.getByRole('button',{name:'Reset to defaults'}).click();await expect(prompt).toHaveValue('');
 await page.getByRole('button',{name:'Teapot',exact:true}).click();await expect(prompt).toHaveValue('A glass teapot');
 await page.reload();await page.locator('.presets summary').click();
 await page.getByRole('button',{name:'Delete preset Teapot'}).click();await expect(page.getByRole('button',{name:'Teapot',exact:true})).toHaveCount(0);
});

test('the workspace is kept by the server: a browser’s old copy is merged in once, and changes from another device arrive',async({page,baseURL})=>{
 const saved=async()=>(await fetch(`${baseURL}/api/workspace`)).json(),put=data=>fetch(`${baseURL}/api/workspace`,{method:'PUT',headers:{'content-type':'application/json'},body:JSON.stringify(data)});
 await put({selected:'nano-banana-pro',settings:{input:{prompt:'From the server'},options:{}},presets:[{name:'Server preset',settings:{input:{},options:{}}}],variants:{},pinned:[]});
 // A copy left in this browser from before the server kept the workspace.
 await page.addInitScript(()=>{if(!sessionStorage.getItem('seeded')){sessionStorage.setItem('seeded','1');localStorage.setItem('kie-presets',JSON.stringify([{name:'Browser preset',settings:{input:{prompt:'Old'},options:{}}}]));}});
 const prompt=field(page,'prompt').locator('textarea');
 await page.goto('/');await expect(page.locator('.model-switch code')).toHaveText('nano-banana-pro');await expect(prompt).toHaveValue('From the server');
 expect((await saved()).presets.map(preset=>preset.name)).toEqual(['Server preset','Browser preset']);
 expect(await page.evaluate(()=>localStorage.getItem('kie-presets'))).toBeNull();
 // A change here reaches the server, and one made on another device shows up here.
 await prompt.fill('Typed here');await expect.poll(async()=>(await saved()).settings.input.prompt).toBe('Typed here');
 await put({...await saved(),settings:{input:{prompt:'Typed on the phone'},options:{}}});
 await expect(prompt).toHaveValue('Typed on the phone',{timeout:8000});
 await page.reload();await expect(prompt).toHaveValue('Typed on the phone');
 await page.locator('.presets summary').click();await expect(page.getByRole('button',{name:'Browser preset',exact:true})).toBeVisible();
});

test('retry adds a take to the same image; takes switch on the canvas and the gallery counts them',async({page})=>{
 // Fixture tasks only; the retry is answered here, so nothing is generated.
 const job=(id,createdAt,extra)=>({id,model:'qwen3/text-to-image',modelName:'TEST FIXTURE',input:{prompt:'Fixture'},state:'success',createdAt,updatedAt:createdAt,urls:[`https://example.com/${id}.png`],...extra});
 let jobs=[job('a2','2026-01-03T00:00:00Z',{slot:{job:'a',index:0}}),job('b','2026-01-02T00:00:00Z'),job('a','2026-01-01T00:00:00Z')],retried;
 await page.route('**/api/connection',r=>r.fulfill({json:{connected:true,credits:10}}));
 await page.route('**/api/jobs',r=>r.fulfill({json:jobs}));
 await page.route('**/api/image?*',r=>r.fulfill({contentType:'image/png',body:png}));
 await page.route('**/api/jobs/*/retry',r=>{retried={url:r.request().url(),body:r.request().postDataJSON()};const created=job('a3','2026-01-04T00:00:00Z',{slot:{job:'a',index:0},state:'waiting',urls:[]});jobs=[created,...jobs];return r.fulfill({status:201,json:created});});
 await page.goto('/');
 const items=page.locator('.gallery-item'),number=page.locator('.take-number'),image=page.locator('.output-image');
 // The retried image keeps its place below the newer task and shows its newest take.
 await expect(items).toHaveCount(2);await expect(items.nth(0).locator('.take-count')).toHaveCount(0);await expect(items.nth(1).locator('.take-count')).toHaveText('2');
 await items.nth(1).click();await expect(number).toHaveText('2/2');await expect(image).toHaveAttribute('src','/api/image?job=a2&index=0');
 await page.getByRole('button',{name:'Previous take'}).click();await expect(number).toHaveText('1/2');await expect(image).toHaveAttribute('src','/api/image?job=a&index=0');
 // The slot keeps the take picked last.
 await items.nth(0).click();await expect(number).toHaveCount(0);await items.nth(1).click();await expect(number).toHaveText('1/2');
 await page.getByRole('button',{name:'Retry',exact:true}).click();
 await expect(number).toHaveText('3/3');await expect(items.nth(1).locator('.take-count')).toHaveText('3');await expect(page.locator('.canvas-toolbar .state-label')).toHaveText('waiting');
 expect(retried).toEqual({url:expect.stringContaining('/api/jobs/a/retry'),body:{index:0}});
});

test('attached reference shows a thumbnail that hides with images',async({page})=>{
 await page.route('**/api/upload',r=>r.fulfill({json:{url:'https://example.com/reference.png'}}));
 await page.route('https://example.com/reference.png',r=>r.fulfill({contentType:'image/png',body:png}));
 await page.goto('/');await pick(page,'topaz/image-upscale');
 const reference=field(page,'image_url');
 await reference.locator('input[type=file]').setInputFiles({name:'reference.png',mimeType:'image/png',buffer:png});
 await expect(reference.locator('.thumb img')).toHaveJSProperty('naturalWidth',1);
 await page.getByRole('switch',{name:'Hide images'}).click();await expect(page.locator('img')).toHaveCount(0);await expect(reference.locator('.thumb .lucide-eye-off')).toBeVisible();
});

test('mobile panels fit and every panel remains reachable',async({page})=>{
 await page.setViewportSize({width:390,height:844});await page.goto('/');
 await expect(page.locator('.mobile-tabs')).toBeVisible();
 for(const name of ['Parameters','Canvas','History']){
  await page.locator('.mobile-tabs').getByRole('button',{name,exact:true}).click();
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
 }
});

test('on a phone, a thumbnail strip under the canvas switches images; date and credits sit in task details',async({page})=>{
 // Fixture tasks only; nothing is generated.
 const job=(id,urls,createdAt)=>({id,model:'qwen3/text-to-image',modelName:`TEST FIXTURE ${id}`,input:{prompt:`Fixture prompt ${id}`},state:'success',createdAt,updatedAt:createdAt,urls,creditsConsumed:7,raw:{lines:Array.from({length:80},(_,i)=>`fixture line ${i}`)}});
 await page.setViewportSize({width:390,height:844});
 await page.route('**/api/jobs',r=>r.fulfill({json:[job('b',['https://example.com/1.png','https://example.com/2.png'],'2026-01-02T00:00:00Z'),job('a',['https://example.com/3.png'],'2026-01-01T00:00:00Z')]}));
 await page.route('**/api/image?*',r=>r.fulfill({contentType:'image/png',body:png}));
 await page.goto('/');
 const strip=page.locator('.filmstrip .thumb');await expect(strip).toHaveCount(3);await expect(strip.nth(0)).toHaveAttribute('aria-current','true');
 await expect(page.locator('.task-model')).toHaveText('TEST FIXTURE b');
 await strip.nth(2).click();await expect(strip.nth(2)).toHaveAttribute('aria-current','true');await expect(page.locator('.task-model')).toHaveText('TEST FIXTURE a');
 await expect(page.locator('.output-image')).toHaveAttribute('src','/api/image?job=a&index=0');
 await expect(page.locator('.task-meta')).toBeHidden();await page.locator('.task-details summary').click();await expect(page.locator('.task-meta')).toContainText('7 credits used');
 // Open details fill the canvas and scroll as a whole: no small box inside, and the title, image strip and thumbnails stay on screen.
 const details=page.locator('.task-details');
 expect(await details.locator('pre').evaluate(pre=>pre.scrollHeight<=pre.clientHeight+1)).toBe(true);
 await details.evaluate(node=>{node.scrollTop=node.scrollHeight;});
 for(const part of [details.locator('summary'),page.locator('.filmstrip'),page.locator('.canvas-stage')])await expect(part).toBeInViewport();
 expect(await details.evaluate(node=>node.clientHeight)).toBeGreaterThan(300);
 expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
});
