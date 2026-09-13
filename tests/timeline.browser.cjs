// Run with Node and Puppeteer installed. Uses a local preview, never a deployed site.
const assert=require('node:assert/strict');
const path=require('node:path');
const fs=require('node:fs/promises');
const http=require('node:http');
const puppeteer=require('puppeteer');
const root=path.resolve(__dirname,'..');
const server=http.createServer(async(req,res)=>{
 try{const name=decodeURIComponent(new URL(req.url,'http://localhost').pathname),file=path.resolve(root,'.'+(name==='/'?'/index.html':name));if(!file.startsWith(root+path.sep))throw Error();const bytes=await fs.readFile(file);res.setHeader('Content-Type',({'.html':'text/html','.js':'application/javascript','.css':'text/css'})[path.extname(file)]||'application/octet-stream');res.end(bytes);}catch{res.statusCode=404;res.end();}
});
const timing=page=>page.$$eval('#wordList .word',nodes=>nodes.map(node=>({text:node.querySelector('span').textContent,time:node.querySelector('time').textContent})));
const viewport=page=>page.evaluate(()=>({start:Number(document.querySelector('#timelinePan').value),span:Number(document.querySelector('#zoom').value)}));
async function dragWord(page,index,dx,cancel=false){
 await page.$$eval('#wordList .word',(nodes,index)=>nodes[index].click(),index);
 const box=await page.$eval('.timing-chip.selected',node=>{const box=node.getBoundingClientRect();return {x:box.x+box.width/2,y:box.y+box.height/2};});
 await page.mouse.move(box.x,box.y);await page.mouse.down();await page.mouse.move(box.x+dx,box.y,{steps:5});
 if(cancel)await page.evaluate(()=>document.querySelector('#timingLane').dispatchEvent(new PointerEvent('pointercancel',{pointerId:1,bubbles:true})));
 await page.mouse.up();
}
(async()=>{
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));let browser;
 try{
  browser=await puppeteer.launch({headless:true,executablePath:process.env.CHROME_PATH||undefined,args:['--no-sandbox']});const page=await browser.newPage();await page.setViewport({width:1280,height:1000});const errors=[];page.on('pageerror',error=>errors.push(error.message));
  await page.goto('http://127.0.0.1:'+server.address().port,{waitUntil:'networkidle0'});await page.click('#demo');await page.waitForFunction(()=>document.querySelectorAll('#wordList .word').length===14);
  assert.equal(await page.$eval('#linkSurrounding',node=>node.checked),true);assert.equal(await page.$eval('#magneticTiming',node=>node.checked),true);
  await page.$eval('#timingLane',node=>node.scrollIntoView({block:'center'}));const original=await timing(page);
  for(const [edge,dx] of [['right',20],['left',-20]]){await page.$$eval('#wordList .word',nodes=>nodes[1].click());const handle=await page.$eval('.timing-chip.selected .handle.'+edge,node=>{const r=node.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};});await page.mouse.move(handle.x,handle.y);await page.mouse.down();await page.mouse.move(handle.x+dx,handle.y,{steps:3});await page.mouse.up();const trimmed=await timing(page);assert.notEqual(trimmed[1].time,original[1].time,'resize handle changes timing');const side=edge==='right'?0:1;assert.equal(trimmed[1].time.split(' → ')[side],original[1].time.split(' → ')[side],'resize keeps opposite edge fixed');await page.click('#undo');assert.deepEqual(await timing(page),original);}
  await dragWord(page,1,40);const edited=await timing(page);const [start,end]=edited[1].time.split(' → ').map(Number);
  assert.notEqual(edited[1].time,original[1].time);assert.equal(Number(edited[0].time.split(' → ')[1]),start);assert.equal(Number(edited[2].time.split(' → ')[0]),end);
  assert.ok(Math.abs(start*24-Math.round(start*24))<.013,'drag snaps to video frames');
  await page.click('#undo');assert.deepEqual(await timing(page),original,'one undo restores the entire linked gesture');
  await page.click('#redo');assert.deepEqual(await timing(page),edited);await dragWord(page,1,30,true);assert.deepEqual(await timing(page),edited,'pointercancel restores all neighbor timings');
  await page.click('#undo');assert.deepEqual(await timing(page),original,'canceled gesture adds no undo entry');
  await page.click('#linkSurrounding');await dragWord(page,1,20);const independent=await timing(page);assert.deepEqual(independent[0],original[0]);assert.deepEqual(independent[2],original[2]);await page.click('#undo');await page.click('#linkSurrounding');
  await page.$$eval('#wordList .word',nodes=>nodes[1].click());await page.$eval('#wordStart',node=>{node.value='.75';node.dispatchEvent(new Event('change',{bubbles:true}));});const numeric=await timing(page);assert.equal(numeric[0].time,'0.350 → 0.750');assert.equal(numeric[2].time.split(' → ')[0],'1.020');await page.click('#undo');
  await page.select('#zoom','4');await page.$eval('#timelinePan',node=>{node.value='2';node.dispatchEvent(new Event('input',{bubbles:true}));});
  const before=await viewport(page);const rect=await page.$eval('#timingLane',node=>{const r=node.getBoundingClientRect();return {left:r.left+node.clientLeft,width:node.clientWidth,y:r.top+45};});
  await page.mouse.move(rect.left+rect.width*.75,rect.y);await page.keyboard.down('Control');await page.mouse.wheel({deltaY:-100});await page.keyboard.up('Control');await page.waitForFunction(span=>Number(document.querySelector('#zoom').value)<span, {}, before.span);const after=await viewport(page);
  assert.ok(Math.abs(before.start+before.span*.75-after.start-after.span*.75)<.003,'wheel zoom keeps cursor time fixed');
  await page.mouse.move(rect.left+rect.width*.5,rect.y);await page.mouse.down();await page.mouse.move(rect.left+rect.width*.5-70,rect.y,{steps:4});await page.mouse.up();assert.ok((await viewport(page)).start>after.start,'empty-lane drag pans');
  const manual=await viewport(page);await page.click('#play');await page.waitForFunction(()=>document.querySelector('#play').textContent.includes('Pause'));await new Promise(resolve=>setTimeout(resolve,120));assert.equal((await viewport(page)).start,manual.start,'playback preserves manual viewport');await page.click('#play');
  assert.equal(await page.$eval('#timelineFollow',node=>node.checked),false);assert.deepEqual(errors,[]);
  console.log('Desktop: linked/unlinked drag, frame snapping, numeric edits, single undo, cancellation, anchored zoom, pan, and manual playback view passed.');

  const mobile=await browser.newPage();await mobile.setViewport({width:390,height:844,isMobile:true,hasTouch:true,deviceScaleFactor:2});mobile.on('pageerror',error=>errors.push(error.message));await mobile.goto('http://127.0.0.1:'+server.address().port,{waitUntil:'networkidle0'});await mobile.click('#demo');await mobile.waitForFunction(()=>document.querySelectorAll('#wordList .word').length===14);await mobile.select('#zoom','4');await mobile.$eval('#timingLane',node=>node.scrollIntoView({block:'center'}));
  const m=await mobile.$eval('#timingLane',node=>{const r=node.getBoundingClientRect();return {left:r.left+node.clientLeft,width:node.clientWidth,y:r.top+45};});const touch=(fraction,id)=>({x:m.left+m.width*fraction,y:m.y,id,radiusX:4,radiusY:4,force:1});const client=await mobile.createCDPSession();const initial=await viewport(mobile);
  await client.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[touch(.35,1),touch(.65,2)]});await client.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[touch(.2,1),touch(.8,2)]});const pinched=await viewport(mobile);assert.ok(Math.abs(pinched.span-initial.span*.5)<.05,'two-finger pinch zooms');assert.ok(Math.abs(pinched.start+pinched.span*.5-initial.start-initial.span*.5)<.03,'pinch midpoint stays anchored');
  await client.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[touch(.3,1),touch(.9,2)]});await mobile.waitForFunction(start=>Number(document.querySelector('#timelinePan').value)<start,{},pinched.start);const moved=await viewport(mobile);assert.ok(moved.start<pinched.start,'moving two fingers pans');await client.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});assert.deepEqual(await timing(mobile),original,'pinching over waveform changes no word timing');
  const stable=await viewport(mobile);await client.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[touch(.35,1),touch(.65,2)]});await client.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[touch(.25,1),touch(.75,2)]});await client.send('Input.dispatchTouchEvent',{type:'touchCancel',touchPoints:[]});const canceled=await viewport(mobile);assert.ok(Math.abs(canceled.start-stable.start)<.003);assert.ok(Math.abs(canceled.span-stable.span)<.003);assert.deepEqual(errors,[]);
  console.log('Mobile: real touch pinch, moving midpoint, release, and cancellation passed.');
 }finally{if(browser)await browser.close();await new Promise(resolve=>server.close(resolve));}
})().catch(error=>{console.error(error);process.exitCode=1;});
