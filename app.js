(() => {
'use strict';
const $=id=>document.getElementById(id), clamp=(n,a,b)=>Math.max(a,Math.min(b,n)), round=n=>Math.round(n*1000)/1000;
const supportedFps=[24,30,50,60], normalizeFps=value=>supportedFps.includes(Number(value))?Number(value):24;
const videoDimensions=JAWExportSettings.dimensions;
const settingsKeys=['exportFormat','resolution','transparent','fps','aspect','style','font','background','foreground','accent','motion','groupSize','uppercase'];
const state={words:[],settings:{exportFormat:'mp4',resolution:'1080',transparent:false,fps:24,aspect:'wide',style:'kinetic',font:'Arial Black',background:'#000000',foreground:'#ffffff',accent:'#87a98b',motion:1,groupSize:5,uppercase:false},audio:null,file:null,audioName:'',duration:0,selected:null,position:0,playing:false,busy:false,job:null,page:0,history:[],future:[],windowStart:0};
const timelineView={span:Number($('zoom').value)||8,follow:true,magnetic:true,link:true,grid:'frames',snapped:null,pointers:new Map()};
try{const saved=JSON.parse(localStorage.getItem('jaw-timeline-preferences-v1')||'null');if(saved){for(const key of ['magnetic','link'])if(typeof saved[key]==='boolean')timelineView[key]=saved[key];if(['frames','.01','.05','.1'].includes(saved.grid))timelineView.grid=saved.grid;}}catch{}
let serial=0,activeId=null,videoResult=null,drag=null,wavePeaks=[],lastTick=0,playback;
const renderer=KineticRenderer.create($('preview'));
const abortError=()=>new DOMException('Canceled','AbortError');
const check=signal=>{if(signal?.aborted)throw abortError();};
const format=s=>{const ms=Math.max(0,Math.round((s||0)*1000));return Math.floor(ms/60000)+':'+String(Math.floor(ms/1000)%60).padStart(2,'0')+'.'+String(ms%1000).padStart(3,'0');};
const filename=ext=>($('outputName').value.trim().replace(/\.(mp4|webm|mov|json)$/i,'').replace(/[<>:"/\\|?*\x00-\x1f]/g,'_')||'My lyric video')+ext;
function status(message,error=false){$('status').textContent=message;$('status').classList.toggle('error',error);}
function progress(fraction,message){$('progress').value=clamp(fraction*100,0,100);$('progressLabel').textContent=message;}
function makeWord(w){return {id:'w'+(++serial),text:String(w.text||'').trim(),start:round(Number(w.start)),end:round(Number(w.end)),emphasis:!!w.emphasis,breakBefore:!!w.breakBefore,estimated:!!w.estimated,reviewed:!!w.reviewed,timingSource:['google','audio-estimate','interpolated','manual','imported','forced-alignment'].includes(w.timingSource)?w.timingSource:(w.estimated?'interpolated':'manual'),timingReason:String(w.timingReason||'').slice(0,300),untimed:!!w.untimed,...(Number.isFinite(w.cueStart)&&Number.isFinite(w.cueEnd)&&w.cueStart>=0&&w.cueEnd>w.cueStart?{cueStart:w.cueStart,cueEnd:w.cueEnd}:{})};}
const needsReview=w=>!!w.estimated&&!w.reviewed;
function markManual(w){w.estimated=false;w.reviewed=true;w.timingSource='manual';w.timingReason='Timing adjusted by you.';w.untimed=false;delete w.cueStart;delete w.cueEnd;}
function selected(){return state.words.find(w=>w.id===state.selected);}
function sorted(){state.words.sort((a,b)=>a.start-b.start||a.end-b.end);}
function snapshot(){return JSON.stringify({words:state.words,settings:state.settings,selected:state.selected,duration:state.duration});}
function remember(){state.history.push(snapshot());if(state.history.length>80)state.history.shift();state.future=[];}
function invalidateVideo(){if(!videoResult)return;$('resultVideo').pause();$('resultVideo').removeAttribute('src');$('resultVideo').load();URL.revokeObjectURL(videoResult.url);videoResult=null;$('result').hidden=true;$('download').removeAttribute('href');}
function changed({save=true,sort=true}={}){if(sort)sorted();invalidateVideo();rebuild();renderWords();renderInspector();renderLane();refresh();if(save)scheduleAutosave();}
function restoreSnapshot(value){const data=JSON.parse(value);state.words=data.words;state.settings=data.settings;state.selected=data.selected;if(!state.audio&&Number.isFinite(data.duration)){state.duration=data.duration;state.position=Math.min(state.position,state.duration);}syncSettings();changed();}
function undo(){if(state.busy||!state.history.length)return;state.future.push(snapshot());restoreSnapshot(state.history.pop());}
function redo(){if(state.busy||!state.future.length)return;state.history.push(snapshot());restoreSnapshot(state.future.pop());}
function syncSettings(){JAWExportSettings.normalize(state.settings);for(const key of settingsKeys)if(['uppercase','transparent'].includes(key))$(key).checked=state.settings[key];else $(key).value=state.settings[key];}
function rebuild(){JAWExportSettings.normalize(state.settings);const [w,h]=videoDimensions(state.settings.aspect);if($('preview').width!==w||$('preview').height!==h){$('preview').width=w;$('preview').height=h;}$('preview').style.aspectRatio=w+'/'+h;$('preview').style.maxWidth=(510*w/h)+'px';renderer.setProject(state.words,state.settings);renderer.render(position());}
function refresh(){for(const [id,bg,fg] of [['darkTheme','#000000','#ffffff'],['lightTheme','#f4f4f1','#111111']]){const active=state.settings.background.toLowerCase()===bg&&state.settings.foreground.toLowerCase()===fg;$(id).classList.toggle('theme-active',active);$(id).setAttribute('aria-pressed',String(active));}const hasAudio=!!state.audio,busy=state.busy,hasWords=!!state.words.length,word=!!selected();
 for(const id of ['upload','importTranscript','transcriptFile','demo','loadProject','pasteLyrics','insertWord','audioFile','projectFile','includeAudio','keyOverride','outputName','search','reviewOnly','zoom','speed',...settingsKeys,'lightTheme','darkTheme'])$(id).disabled=busy;
 for(const id of ['play','restart','prevFrame','nextFrame','scrubber'])$(id).disabled=busy||!state.duration;
 $('transcribe').disabled=busy||!hasAudio;$('export').disabled=busy||!hasAudio||!hasWords;$('saveProject').disabled=busy||!hasWords;$('saveTimings').disabled=busy||!hasWords;$('shiftAll').disabled=busy||!hasWords;$('saveSrt').disabled=busy||!hasWords;
 for(const id of ['wordText','wordStart','wordEnd','emphasis','breakBefore','setStart','setEnd','earlier','later','split','deleteWord'])$(id).disabled=busy||!word;
 $('merge').disabled=busy||!word||state.words.indexOf(selected())===state.words.length-1;$('audition').disabled=busy||!word||!hasAudio;
 $('undo').disabled=busy||!state.history.length;$('redo').disabled=busy||!state.future.length;
 const estimated=state.words.filter(needsReview).length;$('timingSummary').hidden=!hasWords;$('timingSummary').textContent=estimated?estimated+' estimated timing'+(estimated===1?'':'s')+' to review. Amber words have estimated timings.':'No estimated timings awaiting review.';$('nextEstimate').disabled=busy||!estimated;$('markReviewed').disabled=busy||!word||!needsReview(selected());
 $('play').textContent=state.playing?'❚❚ Pause':'▶ Play';$('wordCount').textContent=hasWords?'· '+state.words.length+' words':'';
 $('scrubber').max=state.duration||1;$('progressBox').hidden=!busy||!!microphoneSession;$('cancel').disabled=!busy||!state.job;refreshMicrophoneControls();refreshCustomFontControls();refreshTimelineControls();
 JAWExportSettings.refresh(state);playback?.sync();
}
function position(){return playback?playback.position():state.position;}
function pause(){playback?.pause();}
function play(until=Infinity){return playback?.play(until);}
function seek(t){playback?.seek(t);}
function drawNow(){const p=position();renderer.render(p);$('scrubber').value=p;$('clock').textContent=format(p)+' / '+format(state.duration);drawPlayhead(p);playback?.draw();highlight(p);}
function ensureWindow(t,force=false){if(!timelineView.follow&&!force)return;const span=timelineView.span,max=Math.max(0,state.duration-span);if(t<state.windowStart||t>state.windowStart+span){state.windowStart=clamp(t-span*.2,0,max);renderLane();}}
function followSelectedWord(word){
 // Keep edits attached to their word, and leave manual selections alone while paused.
 if(!word||word.id===state.selected||!state.playing||state.busy||drag||!$('follow').checked||document.activeElement?.closest('.inspector'))return;
 state.selected=word.id;renderInspector();
 // Following changes selection only: no seeking, history entry, or forced timeline pan.
 for(const el of document.querySelectorAll('#wordList .word, #chips .timing-chip'))el.classList.toggle('selected',el.dataset.id===word.id);
 refresh();
}
function highlight(p){let word=null;for(const w of state.words){if(w.start>p)break;if(p<w.end)word=w;}const id=word?.id||null;
 // Check even within the same word so following resumes as soon as editing ends.
 followSelectedWord(word);if(activeId===id)return;activeId=id;
 for(const el of $('wordList').querySelectorAll('.word'))el.classList.toggle('active',el.dataset.id===id);
 if(word&&$('follow').checked&&!$('search').value&&!$('reviewOnly').checked&&!state.busy){const page=Math.floor(state.words.indexOf(word)/60);if(page!==state.page){state.page=page;renderWords();}}
}
function tick(now){if(state.playing&&now-lastTick>15){lastTick=now;const p=position();if(p>=Math.min(playback.stopAt,state.duration)){playback.finish();}else{ensureWindow(p);drawNow();}}requestAnimationFrame(tick);}
function renderInspector(){const w=selected();$('wordText').value=w?.text||'';$('wordStart').value=w?w.start.toFixed(3):'';$('wordEnd').value=w?w.end.toFixed(3):'';$('emphasis').checked=!!w?.emphasis;$('breakBefore').checked=!!w?.breakBefore;$('timingOrigin').hidden=!w;$('timingOrigin').textContent=w?(w.estimated?(w.timingSource==='audio-estimate'?'Estimated from vocal activity':'Estimated between timing anchors')+(w.reviewed?' · Reviewed':' · Check by listening'):(w.timingSource==='google'?'Google timestamp':w.timingSource==='imported'?'Imported timestamp':'Manually set timing')):'';if(w?.timingSource==='forced-alignment')$('timingOrigin').textContent='Matched to audio'+(w.estimated?(w.reviewed?' · Reviewed':' · Check by listening'):' · Automatic word alignment');if(w?.untimed)$('timingOrigin').textContent='Provisional timing · Add audio to fit the voice';$('timingOrigin').title=w?.timingReason||'';}
function selectWord(id,doSeek=false){if(state.busy)return;state.selected=id;renderInspector();renderWords();const w=selected();if(w){if(doSeek)seek(w.start);ensureWindow(w.start,true);}renderLane();refresh();}
function filteredWords(){const query=$('search').value.trim().toLowerCase();return state.words.filter(w=>(!query||w.text.toLowerCase().includes(query))&&(!$('reviewOnly').checked||needsReview(w)));}
function renderWords(){const all=filteredWords(),pages=Math.max(1,Math.ceil(all.length/60));state.page=clamp(state.page,0,pages-1);$('wordList').replaceChildren();
 for(const w of all.slice(state.page*60,(state.page+1)*60)){const b=document.createElement('button');b.className='word'+(w.id===state.selected?' selected':'')+(w.id===activeId?' active':'')+(w.emphasis?' emphasis':'')+(w.breakBefore?' break':'')+(needsReview(w)?' estimated':'');b.dataset.id=w.id;b.disabled=state.busy;b.setAttribute('aria-label',w.text+', '+w.start.toFixed(3)+' to '+w.end.toFixed(3)+' seconds'+(needsReview(w)?', estimated timing':''));const text=document.createElement('span');text.textContent=w.text;const time=document.createElement('time');time.textContent=w.start.toFixed(3)+' → '+w.end.toFixed(3);b.append(text,time);if(needsReview(w)){const badge=document.createElement('span');badge.className='estimate-label';badge.textContent='ESTIMATED';b.append(badge);}b.onclick=()=>selectWord(w.id,true);$('wordList').append(b);}
 if(!all.length){const p=document.createElement('p');p.className='note';p.textContent=state.words.length?'No matching words.':'Your transcribed words will appear here. Every word and timestamp can be edited.';$('wordList').append(p);}
 $('pageLabel').textContent=all.length?`${state.page+1} / ${pages} · ${all.length} words`:'0 words';$('pagePrev').disabled=state.busy||!state.page;$('pageNext').disabled=state.busy||state.page>=pages-1;
}
function buildPeaks(){wavePeaks=[];if(!state.audio)return;const data=state.audio.getChannelData(0),step=Math.max(1,Math.floor(data.length/12000));for(let i=0;i<data.length;i+=step){let peak=0;for(let j=i;j<Math.min(i+step,data.length);j++)peak=Math.max(peak,Math.abs(data[j]));wavePeaks.push(peak);}}
function drawPlayhead(p){const span=timelineView.span;$('playhead').hidden=p<state.windowStart||p>state.windowStart+span;$('playhead').style.left=((p-state.windowStart)/span*100)+'%';}
function timelineGrid(){return timelineView.grid==='frames'?1/state.settings.fps:Number(timelineView.grid);}
function renderLane(){const lane=$('timingLane'),canvas=$('waveform'),width=lane.clientWidth,ratio=window.devicePixelRatio||1,span=timelineView.span;if(!width)return;state.windowStart=clamp(state.windowStart,0,Math.max(0,state.duration-span));
 canvas.width=Math.round(width*ratio);canvas.height=Math.round(145*ratio);const g=canvas.getContext('2d');g.scale(ratio,ratio);g.clearRect(0,0,width,145);g.font='11px system-ui';g.fillStyle='#a4a4a4';g.strokeStyle='#343434';
 const step=span<=1?.1:span<=4?.5:span<=8?1:span<=16?2:span<=40?5:span<=100?10:Math.pow(10,Math.floor(Math.log10(span/8)));for(let t=Math.ceil(state.windowStart/step)*step;t<=state.windowStart+span;t+=step){const x=(t-state.windowStart)/span*width;g.fillText(t.toFixed(step<1?1:0)+'s',x+3,15);g.beginPath();g.moveTo(x,22);g.lineTo(x,145);g.stroke();}
 const grid=timelineGrid();if(timelineView.magnetic&&grid/span*width>=5){g.strokeStyle='#87a98b22';g.beginPath();for(let t=Math.ceil(state.windowStart/grid)*grid;t<=state.windowStart+span;t+=grid){const x=(t-state.windowStart)/span*width;g.moveTo(x,87);g.lineTo(x,143);}g.stroke();}
 g.strokeStyle='#7c8c7e';g.beginPath();for(let x=0;x<width;x+=2){const t=state.windowStart+x/width*span;if(t>state.duration)break;const i=Math.floor(t/Math.max(.001,state.duration)*wavePeaks.length),v=wavePeaks[i]||0;const y=clamp(v,0,1)*30;g.moveTo(x,57-y);g.lineTo(x,57+y);}g.stroke();
 $('chips').replaceChildren();for(const w of state.words){if(w.end<=state.windowStart||w.start>=state.windowStart+span)continue;const left=Math.max(0,(w.start-state.windowStart)/span*100),right=Math.min(100,(w.end-state.windowStart)/span*100);const b=document.createElement('div');b.className='timing-chip'+(w.id===state.selected?' selected':'')+(needsReview(w)?' estimated':'');b.dataset.id=w.id;b.style.left=left+'%';b.style.width=Math.max(.2,right-left)+'%';b.title=w.text+' · '+w.start.toFixed(3)+'–'+w.end.toFixed(3);b.textContent=w.text;
 b.tabIndex=0;b.setAttribute('role','button');b.setAttribute('aria-label',w.text+', '+w.start.toFixed(3)+' to '+w.end.toFixed(3)+' seconds. Use left and right arrows to move.');for(const side of ['left','right']){if(side==='left'&&w.start<state.windowStart||side==='right'&&w.end>state.windowStart+span)continue;const h=document.createElement('span');h.className='handle '+side;h.dataset.edge=side;b.append(h);}$('chips').append(b);}
 if(timelineView.snapped){const guide=document.createElement('div');guide.className='snap-guide';guide.style.left=((timelineView.snapped.time-state.windowStart)/span*100)+'%';$('chips').append(guide);}
 $('windowLabel').textContent=format(state.windowStart)+' – '+format(Math.min(state.duration||span,state.windowStart+span));drawPlayhead(position());refreshTimelineControls();
}
function validTiming(start,end){return Number.isFinite(start)&&Number.isFinite(end)&&start>=0&&end>start&&(!state.duration||end<=state.duration+.001);}
function applyTimingPlan(plan){for(const update of plan.updates){const word=state.words.find(w=>w.id===update.id);if(word&&(word.start!==update.start||word.end!==update.end)){Object.assign(word,update);markManual(word);}}}
function editSelected(patch){const w=selected();if(!w||state.busy)return;const next={...w,...patch};next.start=round(next.start);next.end=round(next.end);if(!next.text.trim()){status('Enter a word, or use Delete to remove it.',true);renderInspector();return;}if(!validTiming(next.start,next.end)){status('End must be after start, and both must be within the audio.',true);renderInspector();return;}const timing='start' in patch||'end' in patch,plan=timing?KineticTimeline.edit(state.words,w.id,{start:next.start,end:next.end,edge:'start' in patch?'end' in patch?'move':'left':'right',duration:state.duration,link:timelineView.link}):null;if(plan?.blocked){status('There is no room between the surrounding words. Turn off Adjust surrounding text to move this word independently.',true);renderInspector();return;}remember();if(timing)applyTimingPlan(plan);for(const [key,value] of Object.entries(patch))if(!['start','end'].includes(key))w[key]=value;changed();status('Word updated.');}
function moveSelected(delta){const w=selected();if(!w)return;const length=w.end-w.start,start=clamp(round(w.start+delta),0,Math.max(0,state.duration-length));editSelected({start,end:round(start+length)});}
function mutateWords(fn,message){if(state.busy)return;remember();fn();changed();status(message);}
function addWord(){if(!state.duration){status('Add audio before creating word timings.',true);return;}const start=clamp(position(),0,Math.max(0,state.duration-.1));mutateWords(()=>{const w=makeWord({text:'word',start,end:Math.min(state.duration,start+.3)});state.words.push(w);state.selected=w.id;},'Word added at the playhead. Type its text and adjust the timing.');$('wordText').focus();$('wordText').select();}
function splitWord(){const w=selected();if(!w)return;const text=w.text.trim().split(/\s+/);if(text.length<2){status('Add a space where this entry should split, then press Split.',true);$('wordText').focus();return;}const length=w.end-w.start;if(length/text.length<.001){status('This entry is too short to split. Extend its timing first.',true);return;}mutateWords(()=>{const i=state.words.indexOf(w);const replacements=text.map((t,j)=>makeWord({...w,text:t,start:w.start+length*j/text.length,end:w.start+length*(j+1)/text.length,breakBefore:j===0&&w.breakBefore,estimated:true,reviewed:false,timingSource:'interpolated',timingReason:'Entry split evenly; check the new boundaries.'}));state.words.splice(i,1,...replacements);state.selected=replacements[0].id;},'Entry split evenly within its original time. Check the new word boundaries.');}
function mergeWord(){const w=selected(),i=state.words.indexOf(w),next=state.words[i+1];if(!w||!next)return;mutateWords(()=>{w.text+=' '+next.text;w.end=Math.max(w.end,next.end);if(needsReview(next)||needsReview(w)){w.estimated=true;w.reviewed=false;w.timingSource='interpolated';w.timingReason='Merged entry includes an estimated timing.';}state.words.splice(i+1,1);},'Entries merged.');}
async function decodeAudio(file,signal,onProgress=()=>{}){const Offline=window.OfflineAudioContext||window.webkitOfflineAudioContext;if(!Offline)throw Error('This browser cannot decode audio. Open the HTML in a full browser.');let buffer;check(signal);
 try{const raw=await file.arrayBuffer();check(signal);buffer=await new Offline(2,1,48000).decodeAudioData(raw);}catch(e){check(signal);}
 if(!buffer){onProgress(.1,'Loading extra format support, about 31 MB…');buffer=await decodeExtra(file,signal,onProgress);}
 check(signal);if(!buffer.length)throw Error('This file has no readable audio.');
 if(buffer.numberOfChannels>2||buffer.sampleRate!==48000){const offline=new Offline(2,Math.ceil(buffer.duration*48000),48000),s=offline.createBufferSource();s.buffer=buffer;s.connect(offline.destination);s.start(0);buffer=await offline.startRendering();s.disconnect();s.buffer=null;}
 check(signal);return buffer;
}
async function decodeExtra(file,signal,onProgress){const urls=[];let worker;const controller=new AbortController();const cancel=()=>{controller.abort();};signal?.addEventListener('abort',cancel,{once:true});const timer=setTimeout(cancel,120000);
 try{const base='https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.10/dist/umd/';const blobs=await Promise.all(['ffmpeg-core.js','ffmpeg-core.wasm'].map(async name=>{const r=await fetch(base+name,{signal:controller.signal});if(!r.ok)throw Error('Decoder download failed.');return new Blob([await r.arrayBuffer()],{type:name.endsWith('.js')?'text/javascript':'application/wasm'});}));check(signal);clearTimeout(timer);for(const blob of blobs)urls.push(URL.createObjectURL(blob));const url=URL.createObjectURL(new Blob([$('decoder-source').textContent],{type:'text/javascript'}));urls.push(url);worker=new Worker(url);let serial=0;
 const request=(type,data)=>new Promise((resolve,reject)=>{check(signal);const id=++serial;const abort=()=>finish(abortError());const timeout=setTimeout(()=>finish(Error('The decoder stopped responding. Try a shorter file.')),600000);const finish=(error,value)=>{clearTimeout(timeout);signal?.removeEventListener('abort',abort);worker.onmessage=null;worker.onerror=null;error?reject(error):resolve(value);};signal?.addEventListener('abort',abort,{once:true});worker.onmessage=e=>{if(e.data.id===id)finish(e.data.error?Error(e.data.error):null,e.data);};worker.onerror=e=>finish(Error(e.message||'The decoder could not read this file.'));try{worker.postMessage({id,type,...data});}catch(e){finish(e);}});
 await request('init',{coreURL:urls[0],wasmURL:urls[1]});check(signal);onProgress(.35,'Extracting audio…');const {pcm}=await request('decode',{file});check(signal);const samples=new Float32Array(pcm.buffer,pcm.byteOffset,pcm.byteLength/4),buffer=new AudioBuffer({numberOfChannels:2,length:samples.length/2,sampleRate:44100});for(let c=0;c<2;c++){const channel=buffer.getChannelData(c);for(let i=0;i<channel.length;i++)channel[i]=samples[i*2+c];}return buffer;
 }finally{clearTimeout(timer);signal?.removeEventListener('abort',cancel);controller.abort();worker?.terminate();urls.forEach(url=>URL.revokeObjectURL(url));}
}
function beginJob(){pause();const job=new AbortController();state.job=job;state.busy=true;refresh();renderWords();return job;}
function endJob(job){if(state.job!==job)return;state.job=null;state.busy=false;refresh();renderWords();}
function installAudio(buffer,file,name,keepWords=false){state.audio=buffer;state.file=file;state.duration=buffer.duration;state.audioName=name;state.position=0;state.windowStart=0;state.history=[];state.future=[];
 if(!keepWords){state.words=[];state.selected=null;state.history=[];state.future=[];state.page=0;}
 $('audioName').textContent=name+' · '+format(buffer.duration);buildPeaks();changed();drawNow();
}
async function monoSamples(buffer,signal){check(signal);const rate=LyricTranscription.RATE,Offline=window.OfflineAudioContext||window.webkitOfflineAudioContext;const offline=new Offline(1,Math.ceil(buffer.duration*rate),rate),source=offline.createBufferSource();source.buffer=buffer;source.connect(offline.destination);source.start(0);const mono=await offline.startRendering();source.disconnect();source.buffer=null;check(signal);return mono.getChannelData(0);}
function provisionalWords(words){return words.map((w,i)=>({...w,start:i*.4,end:(i+1)*.4,estimated:true,reviewed:false,untimed:true,timingSource:'interpolated',timingReason:'Provisional timing. Add audio to fit these words to the voice.'}));}
function fitWithoutAudio(words){
 const known=words.filter(w=>!w.untimed&&Number.isFinite(w.start)&&Number.isFinite(w.end)&&w.end>w.start);
 if(!known.length)return provisionalWords(words);
 const duration=Math.max(state.duration,...known.map(w=>w.end));
 const inputs=words.map(w=>w.untimed||!Number.isFinite(w.start)||!Number.isFinite(w.end)?{...w,start:null,end:null,untimed:true}:w);
 return LyricTiming.repair(inputs,new Float32Array(Math.max(1,Math.ceil(duration*100))),100).map(w=>w.untimed?{...w,timingReason:'Provisional timing between matched words. Add audio to fit the voice.'}:w);
}
function prepareWordsForAudio(words,samples,rate,signal){
 check(signal);const duration=samples.length/rate;
 if(words.some(w=>!w.untimed&&Number.isFinite(w.end)&&w.end>duration+.001))throw Error('The transcript ends after this audio. Use the matching recording or shorten the imported timings.');
 let result=words.map(w=>({...w}));
 if(result.some(w=>w.untimed||!Number.isFinite(w.start)||!Number.isFinite(w.end))){result=LyricTiming.repair(result.map(w=>w.untimed?{...w,start:null,end:null}:w),samples,rate,{signal}).map(w=>({...w,untimed:false}));}
 const cues=new Map();for(let i=0;i<result.length;i++){const w=result[i];if(!needsReview(w)||w.timingSource!=='interpolated'||!Number.isFinite(w.cueStart)||!Number.isFinite(w.cueEnd))continue;const key=w.cueStart+':'+w.cueEnd;const group=cues.get(key)||[];group.push(i);cues.set(key,group);}
 for(const group of cues.values()){check(signal);const first=result[group[0]],from=Math.floor(first.cueStart*rate),to=Math.min(samples.length,Math.ceil(first.cueEnd*rate));const fitted=LyricTiming.repair(group.map(i=>({...result[i],start:null,end:null})),samples.subarray(from,to),rate,{signal});group.forEach((index,j)=>{result[index]={...fitted[j],start:fitted[j].start+from/rate,end:fitted[j].end+from/rate,untimed:false};});}
 return result;
}
async function loadAudio(file){if(!file||state.busy)return;const keep=!!state.words.length&&!state.audio;const job=beginJob();progress(0,'Opening '+file.name+'…');try{const buffer=await decodeAudio(file,job.signal,progress);check(job.signal);let words=state.words;
 if(keep){const needsFit=words.some(w=>w.untimed||(needsReview(w)&&Number.isFinite(w.cueStart)&&w.timingSource==='interpolated'));if(needsFit){progress(.7,'Fitting imported words to vocal activity…');const samples=await monoSamples(buffer,job.signal);words=prepareWordsForAudio(words,samples,LyricTranscription.RATE,job.signal).map(makeWord);}else if(words.some(w=>w.end>buffer.duration+.001))throw Error('This recording is shorter than the saved word timings. Choose the matching audio.');}
 check(job.signal);if(keep){state.words=words;state.selected=words[0]?.id||null;}installAudio(buffer,file,file.name,keep);status(keep?'Audio added. Imported words are ready; check any amber estimated timings.':'Audio ready. Transcribe it or import your own transcript.');
 }catch(e){status(e.name==='AbortError'?'Loading canceled.':e.message,e.name!=='AbortError');}finally{endJob(job);}}
async function transcribe(){if(!state.audio||state.busy)return;const key=$('keyOverride').value.trim()||window.JEWCredential.key,job=beginJob();remember();const original=state.words;let received=false;progress(0,'Preparing audio file…');
 try{const samples=await monoSamples(state.audio,job.signal);
 const words=await LyricTranscription.transcribe(samples,key,job.signal,(items,fraction,info={})=>{if(items.length){state.words=items.map(makeWord);state.selected=null;received=true;changed();}progress(fraction,`Transcribing audio file${info.section>1?' · Section '+info.section:''}…`);});check(job.signal);state.words=words.map(makeWord);state.selected=state.words[0]?.id||null;state.page=0;$('reviewOnly').checked=false;$('search').value='';changed();status(words.length?`${words.length} words transcribed. ${words.filter(needsReview).length} timings estimated locally. Review the amber words by listening.`:'Gemini found no words in this audio. You can paste lyrics and time them manually.');
 }catch(e){if(!received)state.words=original;changed();status((e.name==='AbortError'?'Transcription canceled.':e.message)+(received?' Completed sections are kept in the editor.':''),e.name!=='AbortError');}finally{endJob(job);}
}
async function exportVideo(){
 if(state.busy||!state.audio||!state.words.length)return;
 syncSettings();const {fps,exportFormat,transparent,resolution}=state.settings;
 const spec=JAWExportSettings.formats[exportFormat],job=beginJob();invalidateVideo();progress(0,'Preparing '+spec.label+'…');
 try{
  await ensureSelectedFont(job.signal);check(job.signal);
  const canvas=document.createElement('canvas');[canvas.width,canvas.height]=videoDimensions(state.settings.aspect,resolution);
  const videoRenderer=KineticRenderer.create(canvas);videoRenderer.setProject(state.words,state.settings);
  const blob=await LyricVideoExport.exportVideo({canvas,audioBuffer:state.audio,duration:state.duration,fps,format:exportFormat,transparent,renderFrame:t=>videoRenderer.render(t),signal:job.signal,onProgress:progress});
  check(job.signal);const name=filename(spec.extension),url=URL.createObjectURL(blob);
  videoResult={blob,url};
  const canPreview=exportFormat!=='mov'&&!!$('resultVideo').canPlayType(spec.mime);
  $('resultVideo').hidden=!canPreview;$('resultVideo').classList.toggle('is-transparent',transparent);if(canPreview)$('resultVideo').src=url;
  $('download').href=url;$('download').download=name;$('download').textContent='Download again';
  $('resultInfo').textContent=`${canvas.width} × ${canvas.height} · ${fps} fps · ${spec.label}${transparent?' · Transparent':''} · ${(blob.size/1048576).toFixed(1)} MB · ${format(state.duration)}`+(canPreview?'':' · Open the downloaded video in a compatible video editor.');
  $('result').hidden=false;
  // Use a separate download URL so editing the project cannot revoke a file
  // that the browser has just started downloading. Keep the result link as a retry.
  try{saveBlob(blob,name);status('Export complete. The download has been sent to your browser.');}
  catch(error){status('Your video is ready, but the download could not start. Use Download again.',true);}
 }catch(e){status(e.name==='AbortError'?'Export canceled. Your edits are still here.':'Export failed. '+e.message,e.name!=='AbortError');}
 finally{endJob(job);drawNow();}
}
function saveBlob(blob,name){const url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download=name;document.body.append(a);try{a.click();}finally{a.remove();setTimeout(()=>URL.revokeObjectURL(url),60000);}}
function projectData(){return {app:'Just Animate Whatever',version:3,words:state.words.map(({id,...w})=>w),settings:state.settings,customFont:selectedFontData(),audioName:state.audioName,duration:state.duration,outputName:$('outputName').value};}
const readDataURL=blob=>new Promise((resolve,reject)=>{const r=new FileReader();r.onload=()=>resolve(r.result);r.onerror=()=>reject(Error('Could not include the audio.'));r.readAsDataURL(blob);});
async function saveProject(){if(state.busy)return;const job=beginJob();progress(0,'Saving project…');try{const data=projectData();if($('includeAudio').checked&&state.file)data.audioData=await readDataURL(state.file);check(job.signal);saveBlob(new Blob([JSON.stringify(data)],{type:'application/json'}),filename('.lyric.json'));status(data.audioData?'Project saved with audio and all edits.':'Project saved. Reselect the same audio when you reopen it.');}catch(e){status(e.name==='AbortError'?'Save canceled.':e.message,e.name!=='AbortError');}finally{endJob(job);}}
function validateProject(data){const words=Array.isArray(data)?data:data?.words;if(!Array.isArray(words)||words.length>30000)throw Error('Choose a lyric project or a JSON file containing a words array.');const list=words.map(w=>{if(!w||typeof w.text!=='string'||!w.text.trim()||w.text.length>500||!Number.isFinite(w.start)||!Number.isFinite(w.end)||w.start<0||w.end<=w.start)throw Error('A word in this file has invalid text or timing.');const word=makeWord(w);if(word.end<=word.start)throw Error('Each word must last at least 0.001 seconds.');return word;});return list;}
async function openProject(file){if(!file||state.busy)return;const job=beginJob();progress(0,'Opening file…');try{const raw=await LyricImport.readText(file);check(job.signal);
 // Both file buttons accept subtitles. Keep the same job through decoding and
 // import so cancellation works and a second upload cannot race this one.
 if(/\.(?:srt|vtt|txt)$/i.test(file.name)||!/^\s*[[{]/.test(raw)){await installTranscript(raw,file,job);return;}
 const data=JSON.parse(raw);const words=validateProject(data);let audio=null,audioFile=null;
 if(data.audioData){if(typeof data.audioData!=='string'||!/^data:(audio\/|video\/|application\/octet-stream)[^,]*;base64,/i.test(data.audioData))throw Error('The project contains an unsupported audio attachment.');const blob=await (await fetch(data.audioData)).blob();audioFile=new File([blob],String(data.audioName||'Project audio'),{type:blob.type});audio=await decodeAudio(audioFile,job.signal,progress);check(job.signal);}
 const duration=audio?.duration||Math.max(Number(data.duration)||0,...words.map(w=>w.end));if(duration>86400||words.some(w=>w.end>duration+.001))throw Error('Word timings exceed the audio length.');check(job.signal);const projectFont=await prepareProjectFont(data,job.signal);check(job.signal);if(projectFont)registerCustomFont(projectFont);state.history=[];state.future=[];state.words=words;state.audio=audio;state.file=audioFile;state.audioName=String(data.audioName||'Project audio');state.duration=duration;state.position=0;state.windowStart=0;state.selected=words[0]?.id||null;state.page=0;
 Object.assign(state.settings,{exportFormat:data.settings?.exportFormat,resolution:data.settings?.resolution,transparent:data.settings?.transparent});state.settings.fps=normalizeFps(data.settings?.fps);state.settings.font=projectFont?.record.id||(builtinFonts.has(data.settings?.font)?data.settings.font:'Arial Black');
 if(data.settings)for(const key of settingsKeys){const value=data.settings[key];if(key==='fps')continue;if(['uppercase','transparent'].includes(key)){state.settings[key]=!!value;continue;}if(key==='motion'&&Number.isFinite(value)){state.settings[key]=clamp(value,0,1.5);continue;}if(key==='groupSize'&&Number.isFinite(value)){state.settings[key]=clamp(Math.round(value),3,8);continue;}if(['background','foreground','accent'].includes(key)&&/^#[a-f0-9]{6}$/i.test(value)){state.settings[key]=value;continue;}if($(key).tagName==='SELECT'&&[...$(key).options].some(o=>o.value===value))state.settings[key]=value;}
 $('outputName').value=String(data.outputName||'My lyric video').slice(0,100);$('audioName').textContent=audio?state.audioName+' · '+format(duration):'Project loaded · Add the original audio to hear or export it.';syncSettings();buildPeaks();changed();drawNow();status(audio?'Project opened with audio.':'Words and settings restored. Add the original audio to continue.');
 }catch(e){status(e.name==='AbortError'?'Open canceled.':e.message,e.name!=='AbortError');}finally{endJob(job);}}
let autosaveTimer;
function scheduleAutosave(){clearTimeout(autosaveTimer);autosaveTimer=setTimeout(()=>{try{localStorage.setItem('jaw-lyrics-draft-v1',JSON.stringify(projectData()));}catch{}},500);}
function demo(){if(state.busy)return;pause();const rate=48000,length=8*rate,b=new AudioBuffer({numberOfChannels:2,length,sampleRate:rate});for(let c=0;c<2;c++){const data=b.getChannelData(c);for(let i=0;i<length;i++){const t=i/rate,beat=t%.5;data[i]=Math.sin(2*Math.PI*220*t)*.04*Math.exp(-beat*18);}}const words='animating text like this can be challenging but it does not have to be'.split(' ');const timings=[.35,.7,1.15,1.5,2,2.35,2.7,3.4,4.1,4.45,4.8,5.4,5.8,6.2];const wav=stereoWav(b);installAudio(b,new File([wav],'Animation demo.wav',{type:'audio/wav'}),'Animation demo · Soft click track, no vocals');state.words=words.map((text,i)=>makeWord({text,start:timings[i],end:timings[i]+(i===6?.55:.32),emphasis:['but','not'].includes(text),breakBefore:i===7||i===10}));state.selected=state.words[0].id;changed();status('Demo loaded. Press Play to see the motion. This is a click track, without vocals.');}
function stereoWav(buffer){const channels=buffer.numberOfChannels,len=buffer.length,bytes=new Uint8Array(44+len*channels*2),d=new DataView(bytes.buffer),label=(offset,s)=>{for(let i=0;i<s.length;i++)bytes[offset+i]=s.charCodeAt(i);};label(0,'RIFF');d.setUint32(4,bytes.length-8,true);label(8,'WAVE');label(12,'fmt ');d.setUint32(16,16,true);d.setUint16(20,1,true);d.setUint16(22,channels,true);d.setUint32(24,buffer.sampleRate,true);d.setUint32(28,buffer.sampleRate*channels*2,true);d.setUint16(32,channels*2,true);d.setUint16(34,16,true);label(36,'data');d.setUint32(40,bytes.length-44,true);for(let c=0;c<channels;c++){const data=buffer.getChannelData(c);for(let i=0;i<len;i++)d.setInt16(44+(i*channels+c)*2,Math.round(clamp(data[i],-1,1)*32767),true);}return bytes;}
// Timeline browsing does not change project history or steal the view back during playback.
function saveTimelinePreferences(){try{localStorage.setItem('jaw-timeline-preferences-v1',JSON.stringify({magnetic:timelineView.magnetic,link:timelineView.link,grid:timelineView.grid}));}catch{}}
function refreshTimelineControls(){
 if(!$('timelinePan'))return;const unavailable=state.busy||!state.duration,max=Math.max(0,state.duration-timelineView.span);
 for(const id of ['timelinePan','timelineLeft','timelineRight','timelineZoomIn','timelineZoomOut','timelineFit','timelineFollow'])$(id).disabled=unavailable;
 $('timelineLeft').disabled=unavailable||state.windowStart<=0;$('timelineRight').disabled=unavailable||state.windowStart>=max;
 $('timelineZoomIn').disabled=unavailable||timelineView.span<=.25;$('timelineZoomOut').disabled=unavailable||timelineView.span>=Math.max(30,state.duration);
 $('timelinePan').max=max||1;$('timelinePan').value=state.windowStart;$('timelinePan').disabled=unavailable||!max;$('timelinePan').setAttribute('aria-valuetext',format(state.windowStart));
 $('timelineFollow').checked=timelineView.follow;for(const id of ['magneticTiming','linkSurrounding','timingGrid'])$(id).disabled=state.busy;
 $('timingGrid').disabled=state.busy||!timelineView.magnetic;
 const zoom=$('zoom');let option=[...zoom.options].find(item=>Number(item.value)===timelineView.span);
 if(!option){option=zoom.querySelector('[data-custom]');if(!option){option=document.createElement('option');option.dataset.custom='true';zoom.append(option);}option.value=String(timelineView.span);option.textContent=Number(timelineView.span.toFixed(2))+' sec';}zoom.value=String(timelineView.span);
}
function setTimelineView(start,span=timelineView.span,manual=true){timelineView.span=clamp(span,.25,Math.max(30,state.duration));state.windowStart=clamp(start,0,Math.max(0,state.duration-timelineView.span));if(manual)timelineView.follow=false;renderLane();}
function zoomTimeline(factor,anchor=.5,anchorTime){const next=KineticTimeline.viewport({start:state.windowStart,span:timelineView.span,duration:state.duration,factor,anchor,anchorTime});setTimelineView(next.start,next.span);}
function timelineGeometry(){const lane=$('timingLane'),rect=lane.getBoundingClientRect();return {left:rect.left+lane.clientLeft,width:lane.clientWidth};}
function setupTimelineControls(){
 const controls=document.createElement('div');controls.className='timeline-navigation';controls.innerHTML='<button id="timelineLeft" class="quiet small" type="button" aria-label="Pan timeline left" title="Pan left">←</button><button id="timelineRight" class="quiet small" type="button" aria-label="Pan timeline right" title="Pan right">→</button><input id="timelinePan" class="timeline-pan" type="range" min="0" max="1" step="0.001" value="0" aria-label="Timeline horizontal position"><button id="timelineZoomOut" class="quiet small" type="button" aria-label="Zoom timeline out" title="Zoom out">−</button><button id="timelineZoomIn" class="quiet small" type="button" aria-label="Zoom timeline in" title="Zoom in">+</button><button id="timelineFit" class="quiet small" type="button">Fit</button><label class="check"><input id="timelineFollow" type="checkbox" checked> Follow playhead</label>';
 $('timingLane').before(controls);$('timingLane').tabIndex=0;$('timingLane').setAttribute('aria-label','Word timeline. Drag empty space or scroll to pan. Control or Command plus scroll to zoom.');
 const note=$('timingLane').nextElementSibling;note.classList.add('timeline-help');note.textContent='Click the waveform to seek. Drag empty space or scroll to pan; pinch or Ctrl/⌘ + scroll to zoom. Drag a word or its edges to adjust timing. Enter exact times below.';
 const preferences=document.createElement('div');preferences.className='row timeline-preferences';preferences.innerHTML='<label class="check"><input id="magneticTiming" type="checkbox"> Magnetic snapping</label><label class="timeline-grid-label">Grid <select id="timingGrid"><option value="frames">Video frames</option><option value=".01">10 ms</option><option value=".05">50 ms</option><option value=".1">100 ms</option></select></label><label class="check"><input id="linkSurrounding" type="checkbox"> Adjust surrounding text</label>';
 $('wordText').closest('.inspector').append(preferences);const help=document.createElement('p');help.className='note';help.textContent='Magnetic dragging snaps to the grid and nearby word edges. Adjust surrounding text joins the previous and next words to your edited word, keeping their outer boundaries in place.';preferences.after(help);
 $('magneticTiming').checked=timelineView.magnetic;$('linkSurrounding').checked=timelineView.link;$('timingGrid').value=timelineView.grid;
 for(const [id,key] of [['magneticTiming','magnetic'],['linkSurrounding','link']])$(id).onchange=e=>{timelineView[key]=e.target.checked;saveTimelinePreferences();renderLane();};
 $('timingGrid').onchange=e=>{timelineView.grid=e.target.value;saveTimelinePreferences();renderLane();};
 $('timelineLeft').onclick=()=>setTimelineView(state.windowStart-timelineView.span*.5);$('timelineRight').onclick=()=>setTimelineView(state.windowStart+timelineView.span*.5);
 $('timelinePan').oninput=e=>setTimelineView(Number(e.target.value));$('timelineZoomIn').onclick=()=>zoomTimeline(.5);$('timelineZoomOut').onclick=()=>zoomTimeline(2);$('timelineFit').onclick=()=>setTimelineView(0,Math.max(.25,state.duration));
 $('timelineFollow').onchange=e=>{timelineView.follow=e.target.checked;if(timelineView.follow)ensureWindow(position(),true);};
}
setupTimelineControls();
function restoreDraggedWords(){if(drag?.kind==='word')for(const original of drag.originals){const word=state.words.find(w=>w.id===original.id);if(word)Object.assign(word,original);}}
function finishTimelineGesture(cancel=false){
 if(!drag)return;const old=drag;
 if(old.kind==='word'){
  if(cancel)restoreDraggedWords();
  const modified=old.originals.some(original=>{const word=state.words.find(w=>w.id===original.id);return word&&(word.start!==original.start||word.end!==original.end);});
  drag=null;timelineView.snapped=null;
  if(modified&&!cancel){state.history.push(old.snapshot);if(state.history.length>80)state.history.shift();state.future=[];changed();}
  else{renderer.setProject(state.words,state.settings);renderer.render(state.position);renderInspector();renderWords();renderLane();refresh();}
 }else{drag=null;if(cancel)setTimelineView(old.start,old.span);}
 $('timingLane').classList.remove('is-panning','is-editing');
}
function beginTimelinePinch(){
 const points=[...timelineView.pointers.values()];if(points.length<2)return;
 finishTimelineGesture(drag?.kind==='word');const geometry=timelineGeometry(),center=(points[0].x+points[1].x)/2;
 drag={kind:'pinch',start:state.windowStart,span:timelineView.span,distance:Math.max(1,Math.hypot(points[1].x-points[0].x,points[1].y-points[0].y)),anchorTime:state.windowStart+(center-geometry.left)/geometry.width*timelineView.span};
}
$('timingLane').onpointerdown=e=>{
 if(state.busy||!state.duration||e.button>0)return;
 const lane=$('timingLane'),geometry=timelineGeometry();if(!geometry.width)return;
 timelineView.pointers.set(e.pointerId,{x:e.clientX,y:e.clientY});lane.setPointerCapture(e.pointerId);e.preventDefault();
 if(timelineView.pointers.size>1){beginTimelinePinch();return;}
 const chip=e.target.closest('.timing-chip');
 if(!chip){drag={kind:'pan',pointerId:e.pointerId,x:e.clientX,start:state.windowStart,span:timelineView.span,width:geometry.width,moved:false};return;}
 pause();const word=state.words.find(w=>w.id===chip.dataset.id);if(!word)return;state.selected=word.id;renderInspector();renderWords();refresh();
 const index=state.words.indexOf(word),baseline=state.words.map(w=>({...w}));
 drag={kind:'word',pointerId:e.pointerId,id:word.id,start:word.start,end:word.end,x:e.clientX,edge:e.target.dataset.edge||'move',span:timelineView.span,width:geometry.width,moved:false,baseline,originals:baseline.slice(Math.max(0,index-1),index+2),snapshot:snapshot()};
};
$('timingLane').onpointermove=e=>{
 if(!timelineView.pointers.has(e.pointerId))return;timelineView.pointers.set(e.pointerId,{x:e.clientX,y:e.clientY});if(!drag)return;
 if(drag.kind==='pinch'){
  const points=[...timelineView.pointers.values()];if(points.length<2)return;const geometry=timelineGeometry(),distance=Math.max(1,Math.hypot(points[1].x-points[0].x,points[1].y-points[0].y)),center=(points[0].x+points[1].x)/2;
  const next=KineticTimeline.viewport({start:drag.start,span:drag.span,duration:state.duration,factor:drag.distance/distance,anchor:(center-geometry.left)/geometry.width,anchorTime:drag.anchorTime});setTimelineView(next.start,next.span);return;
 }
 if(e.pointerId!==drag.pointerId||!drag.moved&&Math.abs(e.clientX-drag.x)<3)return;drag.moved=true;
 const delta=(e.clientX-drag.x)/drag.width*drag.span;
 if(drag.kind==='pan'){$('timingLane').classList.add('is-panning');setTimelineView(drag.start-delta);return;}
 $('timingLane').classList.add('is-editing');restoreDraggedWords();
 const plan=KineticTimeline.edit(drag.baseline,drag.id,{start:drag.start+(drag.edge==='right'?0:delta),end:drag.end+(drag.edge==='left'?0:delta),edge:drag.edge,duration:state.duration,link:timelineView.link,magnetic:timelineView.magnetic&&!e.altKey,grid:timelineGrid(),threshold:Math.min(.12,8/drag.width*drag.span)});
 applyTimingPlan(plan);timelineView.snapped=plan.snapped;renderer.setProject(state.words,state.settings);renderer.render(state.position);renderInspector();renderLane();
};
function endTimelinePointer(e){
 if(!timelineView.pointers.has(e.pointerId))return;const cancel=e.type!=='pointerup',old=drag;timelineView.pointers.delete(e.pointerId);
 if(old?.kind==='pinch'){
  finishTimelineGesture(cancel);if(timelineView.pointers.size){const [id,point]=[...timelineView.pointers][0];drag={kind:'pan',pointerId:id,x:point.x,start:state.windowStart,span:timelineView.span,width:timelineGeometry().width,moved:true};}
 }else if(old?.pointerId===e.pointerId){finishTimelineGesture(cancel);if(!cancel&&old.kind==='pan'&&!old.moved){const geometry=timelineGeometry();seek(state.windowStart+(e.clientX-geometry.left)/geometry.width*timelineView.span);}}
 if($('timingLane').hasPointerCapture(e.pointerId))$('timingLane').releasePointerCapture(e.pointerId);
}
for(const event of ['pointerup','pointercancel','lostpointercapture'])$('timingLane').addEventListener(event,endTimelinePointer);
$('timingLane').addEventListener('wheel',e=>{if(state.busy||!state.duration)return;e.preventDefault();if(drag)return;const geometry=timelineGeometry(),units=e.deltaMode===1?16:e.deltaMode===2?geometry.width:1;if(e.ctrlKey||e.metaKey)zoomTimeline(Math.exp(clamp(e.deltaY*units*.003,-1,1)),clamp((e.clientX-geometry.left)/geometry.width,0,1));else setTimelineView(state.windowStart+(e.deltaX||e.deltaY)*units/geometry.width*timelineView.span);},{passive:false});
$('timingLane').addEventListener('keydown',e=>{
 if(state.busy||!state.duration)return;const chip=e.target.closest('.timing-chip');
 if(chip&&['ArrowLeft','ArrowRight','Enter'].includes(e.key)){e.preventDefault();state.selected=chip.dataset.id;if(e.key==='Enter')selectWord(chip.dataset.id,true);else{moveSelected((e.key==='ArrowLeft'?-1:1)*(e.shiftKey?.1:timelineView.magnetic?timelineGrid():.01));const node=[...$('chips').querySelectorAll('.timing-chip')].find(item=>item.dataset.id===chip.dataset.id);node?.focus({preventScroll:true});}return;}
 if(['ArrowLeft','ArrowRight','+','=','-','Home','End'].includes(e.key)){e.preventDefault();if(e.key==='ArrowLeft'||e.key==='ArrowRight')setTimelineView(state.windowStart+(e.key==='ArrowLeft'?-1:1)*timelineView.span*.2);else if(e.key==='Home')setTimelineView(0);else if(e.key==='End')setTimelineView(state.duration-timelineView.span);else zoomTimeline(e.key==='-'?2:.5);}
});
$('upload').onclick=()=>$('audioFile').click();$('audioFile').onchange=e=>{void loadAudio(e.target.files[0]);e.target.value='';};$('transcribe').onclick=transcribe;$('demo').onclick=demo;$('play').onclick=()=>play();$('restart').onclick=()=>seek(0);$('prevFrame').onclick=()=>{pause();const fps=state.settings.fps;seek(Math.max(0,(Math.round(state.position*fps)-1)/fps));};$('nextFrame').onclick=()=>{pause();const fps=state.settings.fps;seek((Math.round(state.position*fps)+1)/fps);};$('scrubber').oninput=e=>seek(e.target.value);$('speed').onchange=()=>{if(state.playing){pause();void play();}};
$('export').onclick=exportVideo;$('cancel').onclick=()=>{state.job?.abort();$('cancel').disabled=true;progress($('progress').value/100,'Canceling…');};
$('wordText').onchange=e=>editSelected({text:e.target.value.trim()});$('wordStart').onchange=e=>editSelected({start:Number(e.target.value)});$('wordEnd').onchange=e=>editSelected({end:Number(e.target.value)});$('emphasis').onchange=e=>editSelected({emphasis:e.target.checked});$('breakBefore').onchange=e=>editSelected({breakBefore:e.target.checked});$('setStart').onclick=()=>editSelected({start:round(position())});$('setEnd').onclick=()=>editSelected({end:round(position())});$('earlier').onclick=()=>moveSelected(-.01);$('later').onclick=()=>moveSelected(.01);$('audition').onclick=()=>{const w=selected();if(!w)return;pause();seek(Math.max(0,w.start-.15));void play(Math.min(state.duration,w.end+.2));};$('split').onclick=splitWord;$('merge').onclick=mergeWord;$('deleteWord').onclick=()=>mutateWords(()=>{state.words=state.words.filter(w=>w.id!==state.selected);state.selected=null;},'Word deleted. Undo restores it.');$('insertWord').onclick=addWord;
$('reviewOnly').onchange=()=>{state.page=0;renderWords();};$('markReviewed').onclick=()=>{const w=selected();if(!w)return;mutateWords(()=>w.reviewed=true,'Timing marked as reviewed.');};$('nextEstimate').onclick=()=>{const pending=state.words.filter(needsReview);if(!pending.length)return;const current=state.words.indexOf(selected()),word=pending.find(w=>state.words.indexOf(w)>current)||pending[0];$('reviewOnly').checked=true;$('search').value='';state.page=Math.floor(pending.indexOf(word)/60);selectWord(word.id,true);};
$('undo').onclick=undo;$('redo').onclick=redo;$('search').oninput=()=>{state.page=0;renderWords();};$('pagePrev').onclick=()=>{state.page--;renderWords();};$('pageNext').onclick=()=>{state.page++;renderWords();};$('zoom').onchange=()=>zoomTimeline(Number($('zoom').value)/timelineView.span);
for(const key of settingsKeys)$(key).onchange=()=>{remember();state.settings[key]=['uppercase','transparent'].includes(key)?$(key).checked:key==='fps'?normalizeFps($(key).value):['motion','groupSize'].includes(key)?Number($(key).value):$(key).value;if(key==='background')state.settings.transparent=false;changed();};
function theme(background,foreground){remember();Object.assign(state.settings,{background,foreground,transparent:false});syncSettings();changed();}$('lightTheme').onclick=()=>theme('#f4f4f1','#111111');$('darkTheme').onclick=()=>theme('#000000','#ffffff');
$('saveProject').onclick=saveProject;$('loadProject').onclick=()=>$('projectFile').click();$('projectFile').onchange=e=>{void openProject(e.target.files[0]);e.target.value='';};$('saveTimings').onclick=()=>saveBlob(new Blob([JSON.stringify({words:state.words.map(({id,...w})=>w),duration:state.duration,audioName:state.audioName},null,2)],{type:'application/json'}),filename('.timestamps.json'));
async function applyLyrics(){if(state.busy)return;const raw=$('lyricsInput').value.trim();if(!raw)return;const text=raw.split(/\s+/);if(text.length>30000||text.some(t=>t.length>500)){$('lyricsError').textContent='Use no more than 30,000 words, with each word under 500 characters.';return;}
 const mode=$('lyricsTiming').value,old=state.words.slice();if(mode==='slots'&&text.length!==old.length){$('lyricsError').textContent='Keeping timing slots requires the same number of words. Choose another timing option to add or remove words.';return;}
 const job=beginJob();progress(0,'Applying corrected lyrics…');try{let words;if(mode==='slots')words=text.map((t,i)=>({...old[i],text:t}));else if(mode==='match')words=LyricTranscription.reconcileWords(raw,old);else words=text.map(text=>({text,start:null,end:null,estimated:true,timingReason:'Fit pasted lyrics to voice.'}));
 if(mode!=='slots'){if(state.audio){const samples=await monoSamples(state.audio,job.signal);words=prepareWordsForAudio(words,samples,LyricTranscription.RATE,job.signal);}else if(words.some(w=>!Number.isFinite(w.start)||!Number.isFinite(w.end)||w.untimed)){words=fitWithoutAudio(words);}}
 check(job.signal);remember();state.words=words.map(makeWord);state.selected=state.words[0]?.id||null;state.page=0;$('reviewOnly').checked=false;$('search').value='';if(!state.audio)state.duration=Math.max(0,...state.words.map(w=>w.end));state.position=0;state.windowStart=0;changed();drawNow();$('lyricsDialog').close();status(state.audio?'Lyrics replaced. Existing matched times were kept where possible; review estimated timings.':'Lyrics added. Add audio to fit provisional timings to the voice.');
 }catch(e){$('lyricsError').textContent=e.name==='AbortError'?'Applying lyrics canceled.':e.message;}finally{endJob(job);}}
async function installTranscript(raw,file,job){if(file.size>10*1048576)throw Error('Use a transcript smaller than 10 MB.');const data=LyricImport.parse(raw,file.name);let words=data.words;
 if(data.format==='txt'&&state.words.length)words=LyricTranscription.reconcileWords(data.text,state.words);
 if(state.audio){const samples=await monoSamples(state.audio,job.signal);words=prepareWordsForAudio(words,samples,LyricTranscription.RATE,job.signal);}else if(!data.timed)words=fitWithoutAudio(words);
 check(job.signal);remember();state.words=words.map(makeWord);state.selected=state.words[0]?.id||null;state.page=0;$('reviewOnly').checked=false;$('search').value='';state.position=0;state.windowStart=0;$('transcriptFileStatus').textContent='Last upload: '+file.name+' · '+state.words.length+' words';if(!state.audio){state.duration=Math.max(0,...state.words.map(w=>w.end));$('audioName').textContent='Transcript loaded · Add audio whenever you are ready.';}changed();drawNow();status(data.format.toUpperCase()+' imported · '+state.words.length+' words. '+(state.audio?'Replaced the previous lyrics. Check estimated timings.':data.timed?'Imported timestamps are ready. Add the matching audio to export.':'Add audio to fit these words to the voice.'));
}
async function importTranscript(file){if(!file||state.busy)return;const job=beginJob();progress(0,'Importing transcript…');try{if(file.size>10*1048576)throw Error('Use a transcript smaller than 10 MB.');const raw=await LyricImport.readText(file);check(job.signal);await installTranscript(raw,file,job);
 }catch(e){status(e.name==='AbortError'?'Import canceled.':e.message,e.name!=='AbortError');}finally{endJob(job);}}
$('importTranscript').onclick=()=>$('transcriptFile').click();$('transcriptFile').onchange=e=>{void importTranscript(e.target.files[0]);e.target.value='';};
for(const event of ['dragenter','dragover','dragleave','drop'])$('transcriptDrop').addEventListener(event,e=>{e.preventDefault();e.stopPropagation();if(state.busy)return;if(event==='dragenter'||event==='dragover')$('transcriptDrop').classList.add('dragging');else $('transcriptDrop').classList.remove('dragging');if(event==='drop')void importTranscript(e.dataTransfer.files[0]);});
$('pasteLyrics').onclick=()=>{$('lyricsInput').value=state.words.map(w=>w.text).join(' ');$('lyricsError').textContent='';$('lyricsDialog').showModal();};$('closeLyrics').onclick=()=>$('lyricsDialog').close();$('applyLyrics').onclick=applyLyrics;
$('saveSrt').onclick=()=>{const stamp=s=>{const ms=Math.max(0,Math.round(s*1000));return String(Math.floor(ms/3600000)).padStart(2,'0')+':'+String(Math.floor(ms/60000)%60).padStart(2,'0')+':'+String(Math.floor(ms/1000)%60).padStart(2,'0')+','+String(ms%1000).padStart(3,'0');};const text=state.words.map((w,i)=>(i+1)+'\n'+stamp(w.start)+' --> '+stamp(w.end)+'\n'+w.text+'\n').join('\n');saveBlob(new Blob([text],{type:'application/x-subrip;charset=utf-8'}),filename('.srt'));};
$('shiftAll').onclick=()=>$('shiftDialog').showModal();$('closeShift').onclick=()=>$('shiftDialog').close();$('applyShift').onclick=()=>{const delta=Number($('shiftAmount').value);if(!Number.isFinite(delta))return;if(state.words.some(w=>w.start+delta<0||w.end+delta>state.duration+.001)){status('This shift would move words outside the audio. Use a smaller value.',true);return;}mutateWords(()=>state.words.forEach(w=>{w.start=round(w.start+delta);w.end=round(w.end+delta);}),`All words shifted ${delta.toFixed(3)} seconds.`);$('shiftDialog').close();};
for(const event of ['dragenter','dragover','dragleave','drop'])$('drop').addEventListener(event,e=>{e.preventDefault();if(state.busy)return;if(event==='dragenter'||event==='dragover')$('drop').classList.add('dragging');else $('drop').classList.remove('dragging');if(event==='drop')void loadAudio(e.dataTransfer.files[0]);});window.addEventListener('dragover',e=>e.preventDefault());window.addEventListener('drop',e=>e.preventDefault());
window.addEventListener('keydown',e=>{if(/INPUT|TEXTAREA|SELECT/.test(e.target.tagName)||document.querySelector('dialog[open]'))return;if((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==='z'){e.preventDefault();e.shiftKey?redo():undo();}else if(e.code==='Space'){e.preventDefault();void play();}});
window.addEventListener('pagehide',()=>{pause();state.job?.abort();});window.addEventListener('beforeunload',e=>{if(state.busy){e.preventDefault();e.returnValue='';}});new ResizeObserver(()=>renderLane()).observe($('timingLane'));
// Recover text/settings only; source audio and API keys are not kept in local storage.
try{const draft=JSON.parse(localStorage.getItem('jaw-lyrics-draft-v1')||'null');if(draft?.words?.length){const b=document.createElement('button');b.textContent='Restore last edits';b.className='quiet small';b.onclick=()=>{void openProject(new File([JSON.stringify(draft)],'Draft.json',{type:'application/json'}));b.remove();};$('status').after(b);}}catch{}
// Microphone capture uses the same job lock and audio loader as a file upload.
let microphoneSession=null;
function microphoneUnavailable(){
 if(!window.isSecureContext)return 'Microphone recording needs HTTPS or localhost.';
 if(!navigator.mediaDevices?.getUserMedia||typeof MediaRecorder==='undefined')return 'Microphone recording is unavailable in this browser. You can still add an audio file.';
 return '';
}
function microphoneMessage(message,error=false){
 $('microphoneStatus').textContent=message;
 $('microphoneStatus').classList.toggle('error',error);
}
function refreshMicrophoneControls(){
 const session=microphoneSession,unavailable=microphoneUnavailable();
 $('recordMic').hidden=!!session;
 $('recordMic').disabled=state.busy||!!unavailable;
 $('stopMic').hidden=!session||session.phase==='requesting';
 $('stopMic').disabled=!session||session.phase!=='recording';
 $('stopMic').textContent=session?.phase==='stopping'?'Finishing…':'Stop and use';
 $('discardMic').hidden=!session;
 $('microphoneStatus').classList.toggle('recording',session?.phase==='recording');
 if(unavailable&&!session)microphoneMessage(unavailable);
}
function stopMicrophoneTracks(session){
 for(const track of session.stream?.getTracks()||[]){
  track.removeEventListener('ended',session.onTrackEnded);
  try{track.stop();}catch{}
 }
}
function releaseMicrophone(session){
 if(session.closed)return;
 session.closed=true;
 clearInterval(session.timer);clearTimeout(session.stopTimer);
 session.job?.signal.removeEventListener('abort',session.onAbort);
 if(session.recorder){
  session.recorder.ondataavailable=null;session.recorder.onstop=null;session.recorder.onerror=null;
  try{if(session.recorder.state!=='inactive')session.recorder.stop();}catch{}
 }
 stopMicrophoneTracks(session);
 if(microphoneSession===session){microphoneSession=null;endJob(session.job);}
}
function cancelMicrophone(message='Recording discarded. Your previous audio is unchanged.',error=false){
 const session=microphoneSession;if(!session)return;
 releaseMicrophone(session);microphoneMessage(message,error);
}
function microphoneError(error){
 if(['NotAllowedError','PermissionDeniedError','SecurityError'].includes(error?.name))return 'Microphone access was not allowed. Enable it in your browser’s site settings, then try again.';
 if(['NotFoundError','DevicesNotFoundError'].includes(error?.name))return 'No microphone was found. Connect one and try again.';
 if(['NotReadableError','TrackStartError'].includes(error?.name))return 'The microphone could not start. Check whether another app is using it, then try again.';
 return 'Microphone recording failed. Please try again or add an audio file.';
}
function createMicrophoneRecorder(stream){
 // Safari records AAC/MP4; Chromium and Firefox commonly use Opus/WebM.
 for(const mimeType of ['audio/webm;codecs=opus','audio/mp4','audio/webm','audio/ogg;codecs=opus']){
  try{if(MediaRecorder.isTypeSupported?.(mimeType))return new MediaRecorder(stream,{mimeType});}catch{}
 }
 return new MediaRecorder(stream);
}
async function finishMicrophone(session){
 if(session.closed||microphoneSession!==session)return;
 if(!session.useRecording){cancelMicrophone('Recording was interrupted. Your previous audio is unchanged.',true);return;}
 const mimeType=session.recorder.mimeType||session.chunks.find(chunk=>chunk.type)?.type||'audio/webm';
 const blob=new Blob(session.chunks,{type:mimeType});
 if(!blob.size){cancelMicrophone('No audio was captured. Please try recording again.',true);return;}
 const extension=/mp4/i.test(mimeType)?'m4a':/ogg/i.test(mimeType)?'ogg':'webm';
 const stamp=new Date().toISOString().replace(/[:.]/g,'-');
 const file=new File([blob],`Microphone ${stamp}.${extension}`,{type:mimeType});
 releaseMicrophone(session);
 // loadAudio takes the job lock synchronously and only installs decoded audio on success.
 microphoneMessage('Opening your recording…');
 await loadAudio(file);
 microphoneMessage(state.file===file?'Recording ready. Choose Transcribe + timestamps to turn it into words.':'Recording was not loaded. Your previous audio is unchanged.',state.file!==file);
}
async function startMicrophone(){
 if(state.busy||microphoneSession)return;
 const unavailable=microphoneUnavailable();if(unavailable){microphoneMessage(unavailable,true);return;}
 const session={phase:'requesting',stream:null,recorder:null,chunks:[],job:null,closed:false,useRecording:false,timer:null,stopTimer:null};
 microphoneSession=session;
 session.job=beginJob();
 session.onAbort=()=>{if(microphoneSession===session)cancelMicrophone();};
 session.job.signal.addEventListener('abort',session.onAbort,{once:true});
 microphoneMessage('Allow microphone access to start recording.');
 refreshMicrophoneControls();
 try{
  const stream=await navigator.mediaDevices.getUserMedia({audio:true,video:false});
  session.stream=stream;
  if(session.closed||microphoneSession!==session){stopMicrophoneTracks(session);return;}
  session.onTrackEnded=()=>{if(microphoneSession===session&&session.phase==='recording')cancelMicrophone('The microphone disconnected. Your previous audio is unchanged.',true);};
  for(const track of stream.getAudioTracks())track.addEventListener('ended',session.onTrackEnded);
  const recorder=createMicrophoneRecorder(stream);session.recorder=recorder;
  recorder.ondataavailable=event=>{if(!session.closed&&event.data?.size)session.chunks.push(event.data);};
  recorder.onerror=()=>{if(microphoneSession===session)cancelMicrophone('Recording failed. Your previous audio is unchanged.',true);};
  recorder.onstop=()=>{void finishMicrophone(session);};
  recorder.start(1000);
  session.phase='recording';session.started=performance.now();
  const showElapsed=()=>{const seconds=Math.floor((performance.now()-session.started)/1000);microphoneMessage('Recording · '+Math.floor(seconds/60)+':'+String(seconds%60).padStart(2,'0'));};
  showElapsed();session.timer=setInterval(showElapsed,1000);
  refreshMicrophoneControls();
 }catch(error){if(!session.closed&&microphoneSession===session)cancelMicrophone(microphoneError(error),true);}
}
function stopMicrophone(){
 const session=microphoneSession;if(!session||session.phase!=='recording')return;
 session.useRecording=true;session.phase='stopping';clearInterval(session.timer);
 microphoneMessage('Finishing your recording…');refreshMicrophoneControls();
 try{
  session.recorder.stop();stopMicrophoneTracks(session);
  session.stopTimer=setTimeout(()=>{if(microphoneSession===session)cancelMicrophone('The recording could not finish. Please try again.',true);},10000);
 }catch(error){cancelMicrophone(microphoneError(error),true);}
}
$('recordMic').onclick=()=>{void startMicrophone();};
$('stopMic').onclick=stopMicrophone;
$('discardMic').onclick=()=>cancelMicrophone();
window.addEventListener('pagehide',()=>cancelMicrophone());

// Custom fonts are loaded before entering the canvas renderer. Imported markup
// and stylesheets are never inserted into the page; only font-face data is used.
const customFonts=new Map(),MAX_FONT_BYTES=10*1048576,MAX_FONT_CSS_BYTES=1048576;
const builtinFonts=new Set(['Arial Black','Impact','Arial','Georgia']);
function fontStatus(message,error=false){$('fontStatus').hidden=!message;$('fontStatus').textContent=message;$('fontStatus').classList.toggle('error',error);}
function refreshCustomFontControls(){for(const id of ['uploadFont','fontFile','fontSource','fontFamily','loadFont'])$(id).disabled=state.busy;}
function selectedFontData(){const entry=customFonts.get(state.settings.font);return entry?{...entry.record}:undefined;}
function fontFamilyName(value,required=false){const family=String(value||'').trim();if((required&&!family)||family.length>100||/[\x00-\x1f\x7f<>"'\\;{}]/.test(family))throw Error('Enter a font family name, such as Space Grotesk.');return family;}
function secureFontURL(value,base){let url;try{url=new URL(value,base);}catch{throw Error('Enter a valid HTTPS font or stylesheet URL.');}if(url.protocol!=='https:'||url.username||url.password)throw Error('Font links must use HTTPS without a username or password.');return url.href;}
function newFontId(){return 'JAWFont_'+Array.from(crypto.getRandomValues(new Uint8Array(10)),b=>b.toString(16).padStart(2,'0')).join('');}
function parseFontSource(input){
 const text=String(input||'').trim();if(!text||text.length>16000)throw Error('Paste a font URL, a stylesheet link, or an @import embed.');
 const styleEmbed=text.match(/^<style\b[^>]*>([\s\S]*?)<\/style>\s*$/i);if(styleEmbed)return parseFontSource(styleEmbed[1]);
 if(text.startsWith('<')){const tags=text.match(/<link\b[^>]*>/gi)||[],doc=new DOMParser().parseFromString(tags.join('\n'),'text/html'),links=[...doc.querySelectorAll('link')].filter(link=>link.relList.contains('stylesheet'));if(links.length!==1)throw Error('Paste one stylesheet link from your font provider.');return {url:secureFontURL(links[0].getAttribute('href')),css:true};}
 if(/^@import\b/i.test(text)){const match=text.match(/^@import\s+(?:url\(\s*(?:"([^"]+)"|'([^']+)'|([^\s)]+))\s*\)|"([^"]+)"|'([^']+)')\s*;?\s*$/i);if(!match)throw Error('Paste a complete @import URL or a stylesheet link.');return {url:secureFontURL(match.slice(1).find(Boolean)),css:true};}
 const url=secureFontURL(text);return {url,css:!/\.(woff2?|ttf|otf)$/i.test(new URL(url).pathname)};
}
function waitForFont(promise,signal){
 return new Promise((resolve,reject)=>{check(signal);let done=false;const finish=(error,value)=>{if(done)return;done=true;clearTimeout(timer);signal?.removeEventListener('abort',cancel);error?reject(error):resolve(value);};const cancel=()=>finish(abortError());const timer=setTimeout(()=>finish(Error('Font loading timed out. Check the link or upload a font file.')),20000);signal?.addEventListener('abort',cancel,{once:true});Promise.resolve(promise).then(value=>finish(null,value),error=>finish(error));});
}
async function fetchFontBytes(url,limit,signal){
 const controller=new AbortController(),cancel=()=>controller.abort(),timer=setTimeout(cancel,20000);signal?.addEventListener('abort',cancel,{once:true});
 try{check(signal);const response=await fetch(url,{signal:controller.signal,credentials:'omit',referrerPolicy:'no-referrer'});if(!response.ok)throw Error('Font download failed ('+response.status+').');secureFontURL(response.url||url);if(Number(response.headers.get('content-length'))>limit)throw Error('This font download is too large. Use a font smaller than 10 MB.');let bytes;
  if(response.body?.getReader){const reader=response.body.getReader(),chunks=[];let size=0;for(;;){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>limit){await reader.cancel();throw Error('This font download is too large.');}chunks.push(value);}bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}}
  else{bytes=new Uint8Array(await response.arrayBuffer());if(bytes.length>limit)throw Error('This font download is too large.');}
  check(signal);if(!bytes.length)throw Error('The font provider returned an empty file.');return {bytes,url:response.url||url,type:response.headers.get('content-type')||''};
 }catch(error){check(signal);if(error.name==='AbortError')throw Error('Font download timed out. Try again or upload the font file.');if(error instanceof TypeError)throw Error('Could not fetch that font. The provider must allow cross-origin font downloads. You can also upload the font file.');throw error;}
 finally{clearTimeout(timer);signal?.removeEventListener('abort',cancel);}
}
function fontMagic(bytes){if(bytes.length<4)return false;const magic=String.fromCharCode(...bytes.subarray(0,4));return ['wOFF','wOF2','OTTO','true','typ1'].includes(magic)||(bytes[0]===0&&bytes[1]===1&&bytes[2]===0&&bytes[3]===0);}
function bytesToFontData(bytes){let binary='';for(let i=0;i<bytes.length;i+=32768)binary+=String.fromCharCode(...bytes.subarray(i,i+32768));return btoa(binary);}
function fontDataToBytes(data){if(typeof data!=='string'||data.length>Math.ceil(MAX_FONT_BYTES/3)*4||!data.length||data.length%4!==0||!/^[A-Za-z0-9+/]+={0,2}$/.test(data))throw Error('The project contains invalid embedded font data.');let binary;try{binary=atob(data);}catch{throw Error('The project contains invalid embedded font data.');}const bytes=Uint8Array.from(binary,c=>c.charCodeAt(0));if(bytes.length>MAX_FONT_BYTES||!fontMagic(bytes))throw Error('The embedded attachment is not a supported font.');return bytes;}
async function makeLoadedFont(id,bytes,descriptors,signal){if(!fontMagic(bytes))throw Error('The link did not return a WOFF2, WOFF, TTF or OTF font.');let face;try{face=new FontFace(id,bytes,descriptors);await waitForFont(face.load(),signal);}catch(error){check(signal);throw Error('This font could not be loaded. Try another font file.');}check(signal);return face;}
function validateFontRecord(raw){
 if(!raw||typeof raw!=='object'||!/^JAWFont_[a-f0-9]{20}$/.test(raw.id)||!['file','url','css'].includes(raw.kind))throw Error('The project contains an invalid custom font.');
 const record={id:raw.id,kind:raw.kind,name:String(raw.name||'Custom font').trim().slice(0,150),family:fontFamilyName(raw.family,raw.kind==='css')};
 if(raw.kind==='file'){fontDataToBytes(raw.data);record.data=raw.data;}else record.source=secureFontURL(raw.source);
 return record;
}
function parseFontRules(css,family,base){
 if(typeof CSSStyleSheet!=='function'||!CSSStyleSheet.prototype.replaceSync)throw Error('This browser cannot read font embeds. Upload a font file instead.');
 const sheet=new CSSStyleSheet();try{sheet.replaceSync(css);}catch{throw Error('The font provider did not return a readable stylesheet.');}
 const rules=[...sheet.cssRules].filter(rule=>rule.type===CSSRule.FONT_FACE_RULE&&rule.style.getPropertyValue('font-family').trim().replace(/^(["'])(.*)\1$/,'$2').toLowerCase()===family.toLowerCase());
 if(!rules.length)throw Error('That stylesheet has no font named '+family+'. Check the family name.');if(rules.length>32)throw Error('This embed contains too many font variants. Choose one weight or upload a font file.');
 return rules.map(rule=>{const style=rule.style,urls=[];const pattern=/url\(\s*(?:"([^"]+)"|'([^']+)'|([^\s)]+))\s*\)/gi;let match;while((match=pattern.exec(style.getPropertyValue('src')))){try{urls.push(secureFontURL(match[1]||match[2]||match[3],base));}catch{}}
  if(!urls.length)throw Error('The stylesheet does not contain a downloadable HTTPS font.');const descriptors={};for(const [cssName,descriptor] of [['font-style','style'],['font-weight','weight'],['font-stretch','stretch'],['unicode-range','unicodeRange']]){const value=style.getPropertyValue(cssName).trim();if(value)descriptors[descriptor]=value;}return {urls:urls.slice(0,4),descriptors};});
}
async function loadCustomFontRecord(record,signal){
 if(typeof FontFace!=='function'||!document.fonts)throw Error('Custom fonts need a current Chrome, Edge or Safari browser.');check(signal);let faces=[];
 if(record.kind==='file')faces=[await makeLoadedFont(record.id,fontDataToBytes(record.data),{},signal)];
 else{const downloaded=await fetchFontBytes(record.source,record.kind==='css'?MAX_FONT_CSS_BYTES:MAX_FONT_BYTES,signal);
  if(record.kind==='url'||fontMagic(downloaded.bytes)){faces=[await makeLoadedFont(record.id,downloaded.bytes,{},signal)];record={...record,kind:'url'};}
  else{const rules=parseFontRules(new TextDecoder().decode(downloaded.bytes),record.family,downloaded.url);let total=0;const downloads=new Map();
   for(const rule of rules){let loaded=null,lastError;for(const url of rule.urls){try{let bytes=downloads.get(url);if(!bytes){bytes=(await fetchFontBytes(url,MAX_FONT_BYTES,signal)).bytes;total+=bytes.length;if(total>20*1048576)throw Error('This font family is too large. Choose fewer variants or upload one font file.');downloads.set(url,bytes);}loaded=await makeLoadedFont(record.id,bytes,rule.descriptors,signal);break;}catch(error){check(signal);lastError=error;}}if(!loaded)throw lastError;faces.push(loaded);}
  }
 }
 check(signal);return {record,faces};
}
function registerCustomFont(entry){
 const previous=customFonts.get(entry.record.id);if(previous)for(const face of previous.faces)document.fonts.delete(face);for(const face of entry.faces)document.fonts.add(face);customFonts.set(entry.record.id,entry);
 let option=[...$('font').options].find(item=>item.value===entry.record.id);if(!option){option=document.createElement('option');option.value=entry.record.id;$('font').append(option);}option.textContent=entry.record.name+' · Custom';
}
async function prepareProjectFont(data,signal){
 if(!data.customFont)return null;const record=validateFontRecord(data.customFont);if(data.settings?.font!==record.id)throw Error('The project font does not match its saved settings.');return loadCustomFontRecord(record,signal);
}
async function ensureSelectedFont(signal){
 check(signal);if(!document.fonts)return;await waitForFont(document.fonts.ready,signal);const family=String(state.settings.font||'Arial Black').replace(/["\\\n\r]/g,'');await waitForFont(document.fonts.load('900 100px "'+family+'"'),signal);check(signal);
}
async function useCustomFont(file){
 if(state.busy)return;const job=beginJob();progress(0,'Loading font…');fontStatus('Loading font…');
 try{let record;if(file){if(!/\.(woff2?|ttf|otf)$/i.test(file.name)||!file.size||file.size>MAX_FONT_BYTES)throw Error('Choose a WOFF2, WOFF, TTF or OTF file smaller than 10 MB.');const bytes=new Uint8Array(await file.arrayBuffer());check(job.signal);if(!fontMagic(bytes))throw Error('This file is not a supported font.');record={id:newFontId(),kind:'file',name:file.name.replace(/\.(woff2?|ttf|otf)$/i,''),family:'',data:bytesToFontData(bytes)};}
  else{const source=parseFontSource($('fontSource').value),family=fontFamilyName($('fontFamily').value,source.css);record={id:newFontId(),kind:source.css?'css':'url',name:family||decodeURIComponent(new URL(source.url).pathname.split('/').pop()||'Custom font').replace(/\.(woff2?|ttf|otf)$/i,''),family,source:source.url};}
  const entry=await loadCustomFontRecord(record,job.signal);check(job.signal);remember();registerCustomFont(entry);state.settings.font=entry.record.id;syncSettings();changed();drawNow();fontStatus(entry.record.name+' is ready.');status('Custom font loaded.');
 }catch(error){fontStatus(error.name==='AbortError'?'Font loading canceled.':error.message,error.name!=='AbortError');status(error.name==='AbortError'?'Font loading canceled.':error.message,error.name!=='AbortError');}
 finally{endJob(job);}
}
$('uploadFont').onclick=()=>$('fontFile').click();$('fontFile').onchange=event=>{const file=event.target.files[0];event.target.value='';if(file)void useCustomFont(file);};$('loadFont').onclick=()=>{void useCustomFont();};

playback=JAWPlayback.create({state,format,refresh,draw:drawNow,onSeek:t=>ensureWindow(t,true),status,getRate:()=>Number($('speed').value)});
syncSettings();rebuild();renderWords();renderLane();refresh();requestAnimationFrame(tick);
})();
