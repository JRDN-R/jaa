const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const http=require('node:http');
const puppeteer=require('puppeteer');
const root=path.resolve(__dirname,'..');
const mime={'.html':'text/html','.js':'text/javascript','.css':'text/css'};
const server=http.createServer((req,res)=>{
 const route=decodeURIComponent(req.url.split('?')[0]);
 const filename=path.resolve(root,'.'+(route==='/'?'/index.html':route));
 if(!filename.startsWith(root+path.sep)){res.writeHead(403).end();return;}
 fs.readFile(filename,(error,data)=>{if(error){res.writeHead(404).end();return;}res.setHeader('Content-Type',mime[path.extname(filename)]||'application/octet-stream');res.end(data);});
});
const waitUntil=async predicate=>{
 const deadline=Date.now()+15000;
 while(!predicate()){if(Date.now()>deadline)throw Error('Timed out waiting for browser download');await new Promise(resolve=>setTimeout(resolve,50));}
};
(async()=>{
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const installedChrome='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
 const browser=await puppeteer.launch({headless:true,executablePath:process.env.CHROME_PATH||(fs.existsSync(installedChrome)?installedChrome:undefined),args:['--no-sandbox']});
 try{
  fs.mkdirSync(path.join(root,'work'),{recursive:true});
  const downloadPath=fs.mkdtempSync(path.join(root,'work/export-downloads-'));
  const client=await browser.target().createCDPSession(),downloads=[],finished=new Set();
  await client.send('Browser.setDownloadBehavior',{behavior:'allowAndName',downloadPath,eventsEnabled:true});
  client.on('Browser.downloadWillBegin',event=>downloads.push(event));
  client.on('Browser.downloadProgress',event=>{if(event.state==='completed')finished.add(event.guid);});
  for(const mobile of [false,true]){
   const page=await browser.newPage(),errors=[];
   page.on('pageerror',error=>errors.push(error.message));
   if(mobile)await page.emulate(puppeteer.KnownDevices['iPhone 13']);
   else await page.setViewport({width:1440,height:1000});
   await page.goto('http://127.0.0.1:'+server.address().port,{waitUntil:'load'});
   await page.$eval('details.help',el=>{el.open=true;});await page.click('#demo');await page.$eval('details.help',el=>{el.open=false;});
   await page.waitForFunction(()=>!document.querySelector('#export').disabled);

   // Keep the real app, renderer, Blob links, and browser download machinery.
   // Only replace encoding to isolate completion/cancellation from codec speed.
   await page.evaluate(()=>{
    window.testExport={delay:10,fail:false,calls:0};
    window.LyricVideoExport={...window.LyricVideoExport,exportVideo:async options=>{
     window.testExport.calls++;
     await new Promise(resolve=>setTimeout(resolve,window.testExport.delay));
     if(window.testExport.fail)throw Error('Test encoder failure');
     window.testExport.activeAtCompletion=navigator.userActivation.isActive;
     // Deliberately resolves after cancellation: the app must discard the result.
     return new Blob(['encoded-'+options.format],{type:{mp4:'video/mp4',webm:'video/webm',mov:'video/quicktime'}[options.format]});
    }};
   });
   for(const format of ['mp4','webm','mov']){
    const name=(mobile?'mobile':'desktop')+'-'+format;
    await page.select('#exportFormat',format);
    await page.$eval('#outputName',(el,value)=>{el.value=value;},name);
    const count=downloads.length;
    // The first download must work after transient user activation has expired.
    await page.evaluate(delay=>{window.testExport.delay=delay;},!mobile&&format==='mp4'?5500:10);
    await page.click('#export');
    await waitUntil(()=>downloads.length===count+1&&finished.has(downloads[count].guid));
    const download=downloads[count];
    assert.equal(download.suggestedFilename,name+'.'+format);
    assert.equal(fs.readFileSync(path.join(downloadPath,download.guid),'utf8'),'encoded-'+format);
    if(!mobile&&format==='mp4')assert.equal(await page.evaluate(()=>window.testExport.activeAtCompletion),false);
    await page.waitForFunction(()=>!document.querySelector('#export').disabled);
    assert.match(await page.$eval('#status',el=>el.textContent),/download has been sent to your browser/);
    assert.equal(await page.$eval('#download',el=>el.textContent),'Download again');
    assert.equal(await page.$('#share'),null);
   }

   const count=downloads.length;
   await page.evaluate(()=>{window.testExport.delay=300;window.testExport.fail=true;});
   await page.click('#export');
   await page.waitForFunction(()=>document.querySelector('#status').textContent.includes('Export failed. Test encoder failure'));
   assert.equal(downloads.length,count);
   assert.equal(await page.$eval('#result',el=>el.hidden),true);
   await page.evaluate(()=>{window.testExport.delay=500;window.testExport.fail=false;});
   const calls=await page.evaluate(()=>window.testExport.calls);
   await page.click('#export');
   await page.waitForFunction(previous=>window.testExport.calls>previous,{},calls);
   await page.click('#cancel');
   await page.waitForFunction(()=>document.querySelector('#status').textContent.includes('Export canceled'));
   assert.equal(downloads.length,count);
   assert.equal(await page.$eval('#result',el=>el.hidden),true);

   // A browser rejection must leave a usable retry link and clean temporary DOM.
   await page.evaluate(()=>{
    window.testExport.delay=10;
    window.testAnchorClick=HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click=function(){throw Error('Blocked download');};
   });
   await page.click('#export');
   await page.waitForFunction(()=>document.querySelector('#status').textContent.includes('download could not start'));
   assert.equal(downloads.length,count);
   assert.equal(await page.$eval('#result',el=>el.hidden),false);
   assert.equal(await page.$$eval('body > a[download]',elements=>elements.length),0);
   await page.evaluate(()=>{HTMLAnchorElement.prototype.click=window.testAnchorClick;});
   await page.click('#download');
   await waitUntil(()=>downloads.length===count+1&&finished.has(downloads[count].guid));

   for(const format of ['webm','mov']){
    await page.select('#exportFormat',format);
    if(!await page.$eval('#transparent',el=>el.checked))await page.click('#transparent');
    assert.equal(await page.$eval('#background',el=>el.disabled),false);
    const oldColor=await page.$eval('#background',el=>el.value);
    await page.$eval('#background',el=>{el.value='#2468ac';el.dispatchEvent(new Event('change',{bubbles:true}));});
    assert.equal(await page.$eval('#transparent',el=>el.checked),false);
    assert.deepEqual(await page.$eval('#preview',el=>Array.from(el.getContext('2d').getImageData(0,0,1,1).data)),[36,104,172,255]);
    await page.click('#undo');
    assert.equal(await page.$eval('#background',el=>el.value),oldColor);
    assert.equal(await page.$eval('#transparent',el=>el.checked),true);
    assert.equal(await page.$eval('#preview',el=>el.getContext('2d').getImageData(0,0,1,1).data[3]),0);
    for(const preset of ['lightTheme','darkTheme']){
     if(!await page.$eval('#transparent',el=>el.checked))await page.click('#transparent');
     await page.click('#'+preset);
     assert.equal(await page.$eval('#transparent',el=>el.checked),false);
     assert.equal(await page.$eval('#preview',el=>el.getContext('2d').getImageData(0,0,1,1).data[3]),255);
    }
   }
   assert.deepEqual(errors,[]);
   console.log('PASS '+(mobile?'mobile emulation':'desktop')+': automatic MP4/WebM/MOV downloads, error/cancel/retry, background colors, presets, and undo');
   await page.close();
  }
 }finally{await browser.close();server.close();}
})().catch(error=>{console.error(error);server.close();process.exitCode=1;});
