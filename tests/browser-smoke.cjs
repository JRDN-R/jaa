const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const http=require('node:http');
const puppeteer=require('puppeteer');
const root=path.resolve(__dirname,'..');
const mime={'.html':'text/html','.js':'text/javascript','.css':'text/css','.png':'image/png'};
const server=http.createServer((req,res)=>{
 const filename=path.resolve(root,'.'+decodeURIComponent(req.url.split('?')[0]==='/'?'/index.html':req.url.split('?')[0]));
 if(!filename.startsWith(root+path.sep)){res.writeHead(403).end();return;}
 fs.readFile(filename,(error,data)=>{if(error){res.writeHead(404).end();return;}res.setHeader('Content-Type',mime[path.extname(filename)]||'application/octet-stream');res.end(data);});
});
(async()=>{
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const installedChrome='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
 const browser=await puppeteer.launch({headless:true,executablePath:process.env.CHROME_PATH||(fs.existsSync(installedChrome)?installedChrome:undefined),args:['--no-sandbox']});
 try{
  const base='http://127.0.0.1:'+server.address().port;
  const page=await browser.newPage();await page.setViewport({width:1440,height:1000});
  const errors=[];page.on('pageerror',error=>errors.push(error.message));
  await page.evaluateOnNewDocument(()=>{
   window.testMediaActions={};
   const register=navigator.mediaSession.setActionHandler.bind(navigator.mediaSession);
   navigator.mediaSession.setActionHandler=(name,handler)=>{window.testMediaActions[name]=handler;register(name,handler);};
  });
  await page.goto(base,{waitUntil:'load'});await page.$eval('details.help',el=>{el.open=true;});await page.click('#demo');await page.$eval('details.help',el=>{el.open=false;});
  await page.waitForFunction(()=>document.querySelector('#previewAudio').readyState>=1);
  assert.equal(await page.$eval('#previewAudio',e=>e.duration),8);
  await page.click('#skipForward');await page.waitForFunction(()=>Number(document.querySelector('#scrubber').value)===5);
  await page.click('#skipBack');await page.waitForFunction(()=>Number(document.querySelector('#scrubber').value)===0);
  await page.click('#play');await page.waitForFunction(()=>document.querySelector('#previewAudio').currentTime>.1);
  await page.evaluate(()=>window.testMediaActions.pause());
  assert.equal(await page.$eval('#previewAudio',e=>e.paused),true);
  await page.evaluate(()=>window.testMediaActions.play());await page.waitForFunction(()=>!document.querySelector('#previewAudio').paused);
  await page.evaluate(()=>window.testMediaActions.seekto({seekTime:2}));
  await page.click('#play');
  await page.select('#resolution','2160');await page.select('#fps','60');
  assert.match(await page.$eval('#exportSummary',e=>e.textContent),/3840 × 2160 · 60 fps/);
  await page.select('#exportFormat','webm');await page.click('#transparent');
  assert.equal(await page.$eval('#preview',e=>e.getContext('2d').getImageData(0,0,1,1).data[3]),0);
  await page.select('#exportFormat','mp4');
  assert.equal(await page.$eval('#transparent',e=>e.checked),false);
  assert.equal(await page.$eval('#transparent',e=>e.disabled),true);
  assert.equal(await page.$eval('#preview',e=>e.getContext('2d').getImageData(0,0,1,1).data[3]),255);
  await page.select('#fps','24');await page.select('#resolution','1080');
  fs.mkdirSync(path.join(root,'work'),{recursive:true});
  await page.screenshot({path:path.join(root,'work/editor-desktop.png'),fullPage:true});
  await page.$eval('#editor',e=>e.scrollIntoView());
  await page.waitForSelector('.jaw-preview-shell.is-floating');
  await page.screenshot({path:path.join(root,'work/editor-floating.png')});
  assert.deepEqual(errors,[]);
  console.log('PASS integrated desktop playback, media actions, export controls, renderer alpha, floating preview, and page errors');

  const mobile=await browser.newPage();await mobile.emulate(puppeteer.KnownDevices['iPhone 13']);
  const mobileErrors=[];mobile.on('pageerror',error=>mobileErrors.push(error.message));
  await mobile.goto(base,{waitUntil:'load'});
  const limits=await mobile.evaluate(()=>({resolution:document.querySelector('#resolution option[value="2160"]').disabled,fps50:document.querySelector('#fps option[value="50"]').disabled,fps60:document.querySelector('#fps option[value="60"]').disabled}));
  assert.deepEqual(limits,{resolution:true,fps50:true,fps60:true});
  await mobile.evaluate(()=>{
   const data={words:[{text:'Hello',start:0,end:2}],duration:3,settings:{resolution:'2160',fps:60,exportFormat:'mov',transparent:true}};
   const transfer=new DataTransfer();transfer.items.add(new File([JSON.stringify(data)],'desktop.lyric.json',{type:'application/json'}));
   const input=document.querySelector('#projectFile');input.files=transfer.files;input.dispatchEvent(new Event('change',{bubbles:true}));
  });
  await mobile.waitForFunction(()=>document.querySelector('#status').textContent.includes('Words and settings restored'));
  assert.equal(await mobile.$eval('#resolution',e=>e.value),'1080');assert.equal(await mobile.$eval('#fps',e=>e.value),'30');
  assert.equal(await mobile.$eval('#transparent',e=>e.checked),true);
  assert.equal(await mobile.evaluate(()=>document.documentElement.scrollWidth>window.innerWidth),false);
  await mobile.screenshot({path:path.join(root,'work/editor-mobile.png'),fullPage:true});
  assert.deepEqual(mobileErrors,[]);
  console.log('PASS mobile options, desktop-project normalization, transparent settings, layout width, and page errors');
 }finally{await browser.close();server.close();}
})().catch(error=>{console.error(error);server.close();process.exitCode=1;});
