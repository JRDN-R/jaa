// Run with Node and Puppeteer installed; CHROME_PATH can select a local Chrome.
const assert=require('node:assert/strict');
const puppeteer=require('puppeteer');
const path=require('node:path');
const base=path.resolve(__dirname,'..');
(async()=>{
 const browser=await puppeteer.launch({executablePath:process.env.CHROME_PATH||undefined,headless:true,args:['--no-sandbox','--autoplay-policy=no-user-gesture-required']});
 try{
  const page=await browser.newPage();await page.setViewport({width:1100,height:850});
  const errors=[];page.on('pageerror',error=>errors.push(error.message));
  await page.setContent('<style>body{margin:0}.preview-stage{padding:16px;width:700px}canvas{width:100%}#spacer{height:1800px}label{display:inline-flex}</style><div class="preview-stage"><canvas id="preview" width="1920" height="1080"></canvas></div><button id="play">Play</button><button id="restart">Restart</button><input id="scrubber"><select id="speed"><option value="1">1</option><option value="0.5">0.5</option></select><label><input type="checkbox" id="follow">Follow</label><video id="resultVideo" hidden></video><a id="download" download="Test export.webm"></a><div id="spacer"></div>');
  await page.addStyleTag({path:path.join(base,'playback-enhancements.css')});
  await page.addScriptTag({path:path.join(base,'playback-enhancements.js')});
  await page.evaluate(()=>{
   window.messages=[];window.mediaActions={};const register=navigator.mediaSession.setActionHandler.bind(navigator.mediaSession);navigator.mediaSession.setActionHandler=(name,handler)=>{mediaActions[name]=handler;register(name,handler);};window.state={audio:new AudioBuffer({numberOfChannels:2,length:48000*8,sampleRate:48000}),duration:8,position:0,playing:false,busy:false,audioName:'Playback test'};
   for(let c=0;c<2;c++){const d=state.audio.getChannelData(c);for(let i=0;i<d.length;i++)d[i]=Math.sin(i/48000*Math.PI*440)*.02;}
   window.player=JAWPlayback.create({state,refresh:()=>player.sync(),draw:()=>player.draw(),status:(message,error)=>messages.push({message,error}),getRate:()=>Number(document.querySelector('#speed').value)});player.sync();
  });
  await page.waitForFunction(()=>player.media.readyState>=1);
  await page.evaluate(()=>player.play());await page.waitForFunction(()=>player.position()>.1);
  let result=await page.evaluate(()=>({playing:state.playing,paused:player.media.paused,position:player.position()}));assert.equal(result.playing,true);assert.equal(result.paused,false);assert.ok(result.position>.1);
  await page.evaluate(()=>player.pause());const paused=await page.evaluate(()=>player.position());await new Promise(r=>setTimeout(r,100));assert.ok(Math.abs(await page.evaluate(()=>player.position())-paused)<.001);
  await page.click('#skipForward');result=await page.evaluate(()=>player.position());assert.ok(Math.abs(result-paused-5)<.01);
  await page.click('#skipForward');assert.equal(await page.evaluate(()=>player.position()),8);
  await page.click('#skipBack');assert.equal(await page.evaluate(()=>player.position()),3);
  await page.evaluate(()=>{player.seek(.2);return player.play(.55);});await page.waitForFunction(()=>!state.playing);assert.ok(Math.abs(await page.evaluate(()=>player.position())-.55)<.002);
  await page.evaluate(()=>{state.busy=true;return player.play();});assert.equal(await page.evaluate(()=>state.playing),false);await page.evaluate(()=>{state.busy=false;});
  await page.evaluate(async()=>{player.seek(0);const a=player.play();player.pause();const b=player.play();await Promise.all([a,b]);});
  await new Promise(r=>setTimeout(r,120));assert.equal(await page.evaluate(()=>state.playing&&!player.media.paused),true);
  await page.evaluate(()=>player.media.pause());await page.waitForFunction(()=>!state.playing);
  await page.evaluate(()=>{player.seek(2);return player.play();});
  await page.evaluate(async()=>{const result=document.querySelector('#resultVideo');result.src=player.media.src;await result.play();});
  await page.waitForFunction(()=>!state.playing&&player.media.paused&&!document.querySelector('#resultVideo').paused);
  assert.equal(await page.evaluate(()=>navigator.mediaSession.metadata.title),'Test export.webm');
  await page.evaluate(()=>mediaActions.pause());assert.equal(await page.$eval('#resultVideo',e=>e.paused),true);
  await page.evaluate(()=>mediaActions.seekto({seekTime:3}));assert.equal(await page.$eval('#resultVideo',e=>e.currentTime),3);
  await page.evaluate(()=>mediaActions.play());await page.waitForFunction(()=>!document.querySelector('#resultVideo').paused);assert.equal(await page.evaluate(()=>player.media.paused),true);
  await page.evaluate(()=>player.play());await page.waitForFunction(()=>state.playing);assert.equal(await page.$eval('#resultVideo',e=>e.paused),true);
  assert.equal(await page.evaluate(()=>navigator.mediaSession.metadata.title),'Playback test');
  await page.evaluate(()=>mediaActions.pause());assert.equal(await page.evaluate(()=>state.playing),false);
  await page.evaluate(async()=>{state.busy=true;await document.querySelector('#resultVideo').play().catch(()=>{});});await page.waitForFunction(()=>document.querySelector('#resultVideo').paused);await page.evaluate(()=>{state.busy=false;});
  await page.evaluate(()=>{document.querySelector('#speed').value='0.5';player.seek(1);return player.play();});assert.equal(await page.evaluate(()=>player.media.playbackRate),.5);await page.evaluate(()=>player.pause());
  await page.evaluate(()=>{window.originalPlay=player.media.play;player.media.play=()=>new Promise(resolve=>window.resolvePlay=resolve);window.pending=player.play();player.pause();resolvePlay();});await page.evaluate(()=>pending);assert.equal(await page.evaluate(()=>state.playing),false);await page.evaluate(()=>{player.media.play=originalPlay;});
  await page.evaluate(()=>{state.audio=null;player.sync();player.seek(1);return player.play();});await new Promise(r=>setTimeout(r,100));assert.ok(await page.evaluate(()=>state.playing&&player.position()>1));await page.evaluate(()=>player.pause());
  const wav=await page.evaluate(async()=>{const b=new AudioBuffer({numberOfChannels:6,length:20,sampleRate:48000});b.getChannelData(2).fill(.5);const a=await JAWPlayback.wavBlob(b).arrayBuffer(),v=new DataView(a);return {channels:v.getUint16(22,true),dataBytes:v.getUint32(40,true),left:v.getInt16(44,true),right:v.getInt16(46,true)};});assert.equal(wav.channels,2);assert.equal(wav.dataBytes,80);assert.ok(wav.left>0&&wav.right>0);
  await page.evaluate(()=>window.scrollTo(0,700));await page.waitForSelector('.jaw-preview-shell.is-floating');
  const start=await page.$eval('.jaw-preview-shell',el=>{const r=el.getBoundingClientRect();return{x:r.x,y:r.y,width:r.width,height:r.height};});
  await page.focus('#floatingMove');await page.keyboard.press('ArrowLeft');const moved=await page.$eval('.jaw-preview-shell',el=>el.getBoundingClientRect().x);assert.ok(moved<start.x);
  await page.focus('#floatingResize');await page.keyboard.press('ArrowRight');assert.ok(await page.$eval('.jaw-preview-shell',el=>el.getBoundingClientRect().width)>start.width);
  await page.setViewport({width:390,height:700});await new Promise(r=>setTimeout(r,80));const mobile=await page.$eval('.jaw-preview-shell',el=>{const r=el.getBoundingClientRect();return{x:r.x,y:r.y,right:r.right,bottom:r.bottom};});assert.ok(mobile.x>=0&&mobile.y>=0&&mobile.right<=391&&mobile.bottom<=701);
  await page.evaluate(()=>window.scrollTo(0,0));await page.waitForFunction(()=>!document.querySelector('.jaw-preview-shell').classList.contains('is-floating'));
  assert.deepEqual(errors,[]);assert.deepEqual(await page.evaluate(()=>messages),[]);
  console.log('PASS: native audio clock, pause/end, clamped skips, audition cap, busy guard, rapid restart and pending play cancellation, native pause, exported-result mutual exclusion and native media routing, rate, no-audio fallback, surround WAV downmix, floating controls/resize/viewport restoration.');
 }finally{await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
