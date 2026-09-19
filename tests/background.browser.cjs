// Run with Node, Puppeteer, and Chrome. The encoder alone is stubbed: uploaded
// images/video, decoded frames, the renderer, gestures, and project files are real.
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const os=require('node:os');
const path=require('node:path');
const http=require('node:http');
const puppeteer=require('puppeteer');
const root=path.resolve(__dirname,'..');
const mime={'.html':'text/html','.js':'application/javascript','.css':'text/css'};
const server=http.createServer(async(req,res)=>{
 try{const route=decodeURIComponent(new URL(req.url,'http://localhost').pathname),file=path.resolve(root,'.'+(route==='/'?'/index.html':route));if(!file.startsWith(root+path.sep))throw Error();const data=await fs.readFile(file);res.setHeader('Content-Type',mime[path.extname(file)]||'application/octet-stream');res.end(data);}catch{res.writeHead(404).end();}
});
// Two seconds of VP8: red in the first second, blue in the second.
const videoBase64='GkXfo59ChoEBQveBAULygQRC84EIQoKEd2VibUKHgQJChYECGFOAZwEAAAAAAALrEU2bdLpNu4tTq4QVSalmU6yBoU27i1OrhBZUrmtTrIHYTbuMU6uEElTDZ1OsggEeTbuMU6uEHFO7a1OsggLD7AEAAAAAAABZAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAVSalmsirXsYMPQkBNgI1MYXZmNjAuMTYuMTAwV0GNTGF2ZjYwLjE2LjEwMESJiECfQAAAAAAAFlSua8GuAQAAAAAAADjXgQFzxYjStBYoK5NNJ5yBACK1nIN1bmSIgQCGhVZfVlA4g4EBI+ODhA7msoDgibCBQLqBQJqBAhJUw2f8c3OgY8CAZ8iaRaOHRU5DT0RFUkSHjUxhdmY2MC4xNi4xMDBzc9ZjwItjxYjStBYoK5NNJ2fIoUWjh0VOQ09ERVJEh5RMYXZjNjAuMzEuMTAyIGxpYnZweGfIoUWjiERVUkFUSU9ORIeTMDA6MDA6MDIuMDAwMDAwMDAwAB9DtnVBHueBAKPEgQAAgNADAJ0BKkAAQAAARwiFhYiFhIgCAgJ1qgP4A/oCBxpGRgFwx0hLxAD+/W7z/+OZNzDE/45t//FhPA4oyP/xUQCjloEA+gDRAQABEBAAGAAYWC/0AAiOgACjloEB9ADRAQABEBAAGAAYWC/0AAiOgACjloEC7gDRAQABEBAAGAAYWC/0AAiOgACjw4ED6ICQAwCdASpAAEAAAEcIhYWIhYSIAgICdaoD+AIG6EFcMdITAFVYAP7/TRL//FhX8WFfxYV/8WFf/PzO7cX85gCjloEE4gDRAQABEBAAGAAYWC/0AAiOgACjloEF3ADRAQABEBAAGAAYWC/0AAiOgACjloEG1gDRAQABEBAAGAAYWC/0AAiOgAAcU7tro7uPs4EAt4r3gQHxggGf8IEDu5CzggPot4r3gQHxggGf8IGR';
const words=page=>page.$$eval('#wordList .word',nodes=>nodes.map(node=>node.textContent));
const pixel=page=>page.$eval('#preview',canvas=>Array.from(canvas.getContext('2d').getImageData(8,8,1,1).data));
const zoom=page=>page.$eval('#backgroundZoom',node=>Number(node.value));
async function editing(page,value){if(await page.$eval('#preview',node=>node.classList.contains('background-editing'))!==value)await page.click('#adjustBackground');}
async function save(page){
 const count=await page.evaluate(()=>window.testDownloads.length);
 await page.click('#saveProject');
 await page.waitForFunction(count=>window.testDownloads.length>count&&window.testDownloads[count].text!==null,{},count);
 await page.waitForFunction(()=>!document.querySelector('#saveProject').disabled);
 return page.evaluate(count=>JSON.parse(window.testDownloads[count].text),count);
}
async function drag(page,dx,dy){
 await page.$eval('#preview',node=>node.scrollIntoView({block:'center'}));
 const rect=await page.$eval('#preview',node=>{const r=node.getBoundingClientRect();return{x:r.x+r.width*.5,y:r.y+r.height*.5};});
 await page.mouse.move(rect.x,rect.y);await page.mouse.down();await page.mouse.move(rect.x+dx,rect.y+dy,{steps:6});await page.mouse.up();
}
async function seek(page,time){await page.$eval('#scrubber',(node,value)=>{node.value=value;node.dispatchEvent(new Event('input',{bubbles:true}));},time);}
const red=color=>color[0]>200&&color[1]<40&&color[2]<40;
const blue=color=>color[0]<40&&color[1]<40&&color[2]>200;

(async()=>{
 let browser,temp;
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 try{
  temp=await fs.mkdtemp(path.join(os.tmpdir(),'jaa-background-'));
  await fs.writeFile(path.join(temp,'red-blue.webm'),Buffer.from(videoBase64,'base64'));
  await fs.writeFile(path.join(temp,'unsupported.txt'),'This is not media.');
  browser=await puppeteer.launch({headless:true,executablePath:process.env.CHROME_PATH||undefined,args:['--no-sandbox','--autoplay-policy=no-user-gesture-required']});
  const page=await browser.newPage(),errors=[];
  page.on('pageerror',error=>errors.push(error.message));await page.setViewport({width:1440,height:1250});
  await page.goto('http://127.0.0.1:'+server.address().port,{waitUntil:'networkidle0'});
  await page.evaluate(()=>{
   window.testDownloads=[];
   HTMLAnchorElement.prototype.click=function(){const item={name:this.download,text:null};window.testDownloads.push(item);fetch(this.href).then(response=>response.text()).then(text=>{item.text=text;});};
   const prepare=window.JAWBackgroundMedia.prepare;
   window.JAWBackgroundMedia={...window.JAWBackgroundMedia,prepare:async(...args)=>{const entry=await prepare(...args);window.testBackgroundEntry=entry;return entry;}};
  });
  await page.$eval('details.help',node=>{node.open=true;});await page.click('#demo');await page.$eval('details.help',node=>{node.open=false;});
  await page.waitForFunction(()=>!document.querySelector('#saveProject').disabled);
  const originalWords=await words(page);
  await page.$eval('#includeAudio',node=>{node.checked=true;});
  const imageData=await page.evaluate(()=>{const canvas=document.createElement('canvas');canvas.width=320;canvas.height=240;const g=canvas.getContext('2d');for(const [color,x,y]of [['#ff8800',0,0],['#0088ff',160,0],['#00dd88',0,120],['#dd00aa',160,120]]){g.fillStyle=color;g.fillRect(x,y,160,120);}return canvas.toDataURL().split(',')[1];});
  const imagePath=path.join(temp,'four-colors.png');await fs.writeFile(imagePath,Buffer.from(imageData,'base64'));
  await(await page.$('#backgroundFile')).uploadFile(imagePath);
  await page.waitForFunction(()=>document.querySelector('#backgroundName').textContent.includes('four-colors.png')&&!document.querySelector('#adjustBackground').disabled);
  assert.deepEqual(await pixel(page),[255,136,0,255],'image renders behind text');
  await editing(page,true);assert.equal(await page.$eval('#backgroundControls',node=>node.hidden),false);
  const startZoom=await zoom(page);await page.click('#backgroundZoomIn');assert.ok(await zoom(page)>startZoom);
  await page.click('#backgroundZoomOut');assert.ok(Math.abs(await zoom(page)-startZoom)<.02);
  await page.click('#backgroundFit');assert.ok(await zoom(page)<1,'Fit shows the full image');
  await page.click('#backgroundFill');assert.equal(await zoom(page),1,'Fill restores centered cover');
  await drag(page,70,-35);const moved=await save(page);
  assert.ok(moved.backgroundMedia.transform.x>0&&moved.backgroundMedia.transform.y<0,'drag changes only the background position');
  assert.deepEqual(await words(page),originalWords,'background drag leaves lyrics and timings unchanged');
  await editing(page,false);assert.equal(await page.$eval('#backgroundControls',node=>node.hidden),true);
  const locked=await save(page);assert.equal(locked.backgroundMedia.locked,true);
  await drag(page,-50,30);const afterLockedDrag=await save(page);
  assert.deepEqual(afterLockedDrag.backgroundMedia.transform,locked.backgroundMedia.transform,'locked drag cannot move the image');
  assert.match(locked.backgroundMedia.dataURL,/^data:image\/png;base64,/,'project embeds its own background');
  await seek(page,2.5);await fs.mkdir(path.join(root,'work'),{recursive:true});
  await page.evaluate(()=>window.scrollTo(0,0));await page.screenshot({path:path.join(root,'work/background-desktop.png'),fullPage:true});
  const projectPath=path.join(temp,'background.lyric.json');await fs.writeFile(projectPath,JSON.stringify(locked));
  await page.click('#removeBackground');
  await(await page.$('#projectFile')).uploadFile(projectPath);
  await page.waitForFunction(()=>document.querySelector('#backgroundName').textContent.includes('four-colors.png')&&!document.querySelector('#saveProject').disabled);
  const reopened=await save(page);assert.deepEqual(reopened.backgroundMedia,locked.backgroundMedia,'project restores the media, transform, and lock');assert.deepEqual(reopened.words,locked.words);
  await(await page.$('#backgroundFile')).uploadFile(path.join(temp,'unsupported.txt'));
  await page.waitForFunction(()=>!document.querySelector('#saveProject').disabled);
  assert.deepEqual((await save(page)).backgroundMedia,locked.backgroundMedia,'unsupported upload retains the current background');

  await(await page.$('#backgroundFile')).uploadFile(path.join(temp,'red-blue.webm'));
  await page.waitForFunction(()=>document.querySelector('#backgroundName').textContent.includes('red-blue.webm')&&!document.querySelector('#adjustBackground').disabled);
  await seek(page,.25);await page.waitForFunction(()=>{const c=document.querySelector('#preview').getContext('2d').getImageData(8,8,1,1).data;return c[0]>200&&c[2]<40;});assert.ok(red(await pixel(page)));
  await seek(page,1.25);await page.waitForFunction(()=>{const c=document.querySelector('#preview').getContext('2d').getImageData(8,8,1,1).data;return c[2]>200&&c[0]<40;});assert.ok(blue(await pixel(page)),'scrubbing selects the matching video frame');
  await seek(page,2.25);await page.waitForFunction(()=>{const c=document.querySelector('#preview').getContext('2d').getImageData(8,8,1,1).data;return c[0]>200&&c[2]<40;});assert.ok(red(await pixel(page)),'short background videos loop across the song');
  // Exercise the real frame callback at nonsequential times and through a loop.
  await page.evaluate(()=>{window.testExportFrames=[];window.testExportDiagnostics=[];window.LyricVideoExport={...window.LyricVideoExport,exportVideo:async options=>{for(const time of [.25,1.25,2.25,.25]){await options.renderFrame(time);window.testExportFrames.push(Array.from(options.canvas.getContext('2d').getImageData(8,8,1,1).data));const video=window.testBackgroundEntry.source;window.testExportDiagnostics.push({time,currentTime:video.currentTime,seeking:video.seeking,paused:video.paused,readyState:video.readyState});}return new Blob(['encoded'],{type:'video/mp4'});}};});
  await page.click('#export');await page.waitForFunction(()=>window.testExportFrames.length===4&&!document.querySelector('#export').disabled);
  const frames=await page.evaluate(()=>window.testExportFrames);assert.ok(red(frames[0])&&blue(frames[1])&&red(frames[2])&&red(frames[3]),'export awaits the correct background frame: '+JSON.stringify({frames,diagnostics:await page.evaluate(()=>window.testExportDiagnostics)}));
  assert.deepEqual(await words(page),originalWords,'all background operations preserve text');

  const mobile=await browser.newPage();mobile.on('pageerror',error=>errors.push(error.message));await mobile.setViewport({width:390,height:844,isMobile:true,hasTouch:true,deviceScaleFactor:2});
  await mobile.goto('http://127.0.0.1:'+server.address().port,{waitUntil:'networkidle0'});
  await mobile.evaluate(()=>{window.testDownloads=[];HTMLAnchorElement.prototype.click=function(){const item={name:this.download,text:null};window.testDownloads.push(item);fetch(this.href).then(response=>response.text()).then(text=>{item.text=text;});};});
  await(await mobile.$('#projectFile')).uploadFile(projectPath);await mobile.waitForFunction(()=>document.querySelector('#backgroundName').textContent.includes('four-colors.png')&&!document.querySelector('#saveProject').disabled);
  await seek(mobile,2.5);await editing(mobile,true);await mobile.$eval('#preview',node=>node.scrollIntoView({block:'center'}));
  const rect=await mobile.$eval('#preview',node=>{const r=node.getBoundingClientRect();return{x:r.x+r.width*.5,y:r.y+r.height*.5};});
  const touch=(dx,id)=>({x:rect.x+dx,y:rect.y,id,radiusX:4,radiusY:4,force:1}),client=await mobile.createCDPSession(),beforePinch=await zoom(mobile);
  await client.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[touch(-35,1),touch(35,2)]});
  await client.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[touch(-65,1),touch(65,2)]});
  await client.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
  assert.ok(await zoom(mobile)>beforePinch*1.5,'two-finger pinch zooms the background on mobile');
  await mobile.click('#backgroundFill');await editing(mobile,false);
  await mobile.evaluate(()=>window.scrollTo(0,0));await mobile.screenshot({path:path.join(root,'work/background-mobile.png'),fullPage:true});
  assert.equal(await mobile.evaluate(()=>document.documentElement.scrollWidth>window.innerWidth),false,'background controls fit the mobile screen');
  assert.deepEqual(errors,[]);
  console.log('PASS background: image upload, Fit/Fill, zoom, drag, lock, project roundtrip, invalid upload, video seek/loop, and exported frame synchronization.');
 }finally{if(browser)await browser.close();await new Promise(resolve=>server.close(resolve));if(temp)await fs.rm(temp,{recursive:true,force:true});}
})().catch(error=>{console.error(error);process.exitCode=1;});
