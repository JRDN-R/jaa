const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const http=require('node:http');
const puppeteer=require('puppeteer');
const root=path.resolve(__dirname,'..'),requests=[];
const mime={'.html':'text/html','.js':'text/javascript','.css':'text/css'};
const server=http.createServer((req,res)=>{
 const url=new URL(req.url,'http://localhost');requests.push(req.url);
 if(url.pathname==='/prime'){
  res.setHeader('Content-Type','text/html');res.end('<script src="/app.js"></script>Cached previous release');return;
 }
 // Model an earlier app.js already in the browser cache for the same site.
 if(url.pathname==='/app.js'&&!url.search){
  res.setHeader('Content-Type','text/javascript');res.setHeader('Cache-Control','public, max-age=3600, immutable');
  res.end('window.oldAppLoaded=true;');return;
 }
 const filename=path.resolve(root,'.'+(url.pathname==='/'?'/index.html':url.pathname));
 if(!filename.startsWith(root+path.sep)){res.writeHead(403).end();return;}
 fs.readFile(filename,(error,data)=>{if(error){res.writeHead(404).end();return;}res.setHeader('Content-Type',mime[path.extname(filename)]||'application/octet-stream');res.end(data);});
});
function sampleWav(){
 const rate=48000,frames=rate,bytes=Buffer.alloc(44+frames*2);
 bytes.write('RIFF',0);bytes.writeUInt32LE(bytes.length-8,4);bytes.write('WAVEfmt ',8);
 bytes.writeUInt32LE(16,16);bytes.writeUInt16LE(1,20);bytes.writeUInt16LE(1,22);
 bytes.writeUInt32LE(rate,24);bytes.writeUInt32LE(rate*2,28);bytes.writeUInt16LE(2,32);bytes.writeUInt16LE(16,34);
 bytes.write('data',36);bytes.writeUInt32LE(frames*2,40);
 for(let i=0;i<frames;i++)bytes.writeInt16LE(Math.round(Math.sin(2*Math.PI*220*i/rate)*2000),44+i*2);
 return bytes;
}
(async()=>{
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const installedChrome='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
 const browser=await puppeteer.launch({headless:true,executablePath:process.env.CHROME_PATH||(fs.existsSync(installedChrome)?installedChrome:undefined),args:['--no-sandbox']});
 try{
  const base='http://127.0.0.1:'+server.address().port,page=await browser.newPage(),errors=[];
  await page.setViewport({width:1440,height:1000});
  const fromCache=[];page.on('response',response=>{if(response.url()===base+'/app.js')fromCache.push(response.fromCache());});
  await page.goto(base+'/prime',{waitUntil:'load'});
  assert.equal(await page.evaluate(()=>window.oldAppLoaded),true);
  await page.goto(base+'/prime?again',{waitUntil:'load'});
  assert.equal(fromCache.at(-1),true,'The outdated unversioned script must actually be in Chrome’s cache.');

  page.on('pageerror',error=>errors.push(error.message));
  await page.goto(base,{waitUntil:'load'});
  assert.equal(await page.evaluate(()=>window.oldAppLoaded),undefined);
  assert(requests.some(url=>/^\/app\.js\?v=[a-f0-9]{12}$/.test(url)),'The updated page must request a new app URL.');
  assert.equal(await page.$eval('#upload',el=>el.disabled),false);
  const directory=path.join(root,'work/cache-refresh');fs.mkdirSync(directory,{recursive:true});
  const fixture=path.join(directory,'upload.wav');fs.writeFileSync(fixture,sampleWav());
  const [chooser]=await Promise.all([page.waitForFileChooser(),page.click('#upload')]);
  await chooser.accept([fixture]);
  await page.waitForFunction(()=>document.querySelector('#status').textContent.startsWith('Audio ready.'));
  await page.waitForFunction(()=>document.querySelector('#previewAudio').readyState>=2);
  assert.equal(await page.$eval('#audioName',el=>el.textContent),'upload.wav · 0:01.000');
  assert.equal(await page.$eval('#upload',el=>el.disabled),false);
  assert.equal(await page.$eval('#progressBox',el=>el.hidden),true);
  await page.click('#play');
  await page.waitForFunction(()=>document.querySelector('#previewAudio').currentTime>.05);
  assert.deepEqual(errors,[]);
  console.log('PASS stale cached app is bypassed; audio upload completes and plays in Chrome without errors');
 }finally{await browser.close();server.close();}
})().catch(error=>{console.error(error);server.close();process.exitCode=1;});
