/* The editor renders a canvas, but its soundtrack is genuine HTML media so
 * operating-system playback controls can control the same transport. */
(() => {
'use strict';
const clamp=(n,a,b)=>Math.max(a,Math.min(b,n));
function wavBlob(buffer){
 const sourceChannels=buffer.numberOfChannels,channels=Math.min(2,sourceChannels),frames=buffer.length,bytes=frames*channels*2;
 if(bytes>0xffffffff-36)throw Error('The recording is too long for a WAV audio preview.');
 const header=new Uint8Array(44),view=new DataView(header.buffer);
 const label=(at,text)=>{for(let i=0;i<text.length;i++)header[at+i]=text.charCodeAt(i);};
 label(0,'RIFF');view.setUint32(4,bytes+36,true);label(8,'WAVE');label(12,'fmt ');
 view.setUint32(16,16,true);view.setUint16(20,1,true);view.setUint16(22,channels,true);
 view.setUint32(24,buffer.sampleRate,true);view.setUint32(28,buffer.sampleRate*channels*2,true);
 view.setUint16(32,channels*2,true);view.setUint16(34,16,true);label(36,'data');view.setUint32(40,bytes,true);
 const parts=[header],samples=Array.from({length:sourceChannels},(_,c)=>buffer.getChannelData(c));
 // Imported surround audio keeps every channel audible in the stereo preview.
 // Mono and stereo are unchanged; the original buffer is retained for export.
 const weights=Array.from({length:channels},(_,out)=>Array.from({length:sourceChannels},(_,c)=>{
  if(sourceChannels<=2)return c===out?1:0;
  if(c<2)return c===out?1:0;
  if(sourceChannels===4)return c-2===out?Math.SQRT1_2:0;
  if(c===2)return Math.SQRT1_2;
  if(c===3)return .5;
  return c%2===out?Math.SQRT1_2:0;
 }));
 const gains=weights.map(row=>Math.max(1,row.reduce((a,b)=>a+b,0)));
 // Small chunks avoid allocating another contiguous copy of a long recording.
 // The original full-precision AudioBuffer remains available to the exporter.
 for(let start=0;start<frames;start+=32768){const count=Math.min(32768,frames-start),chunk=new Uint8Array(count*channels*2),data=new DataView(chunk.buffer);
  for(let i=0;i<count;i++)for(let c=0;c<channels;c++){let sample=0;for(let source=0;source<sourceChannels;source++)sample+=samples[source][start+i]*weights[c][source];const v=clamp(sample/gains[c],-1,1);data.setInt16((i*channels+c)*2,Math.round(v*(v<0?32768:32767)),true);}parts.push(chunk);
 }
 return new Blob(parts,{type:'audio/wav'});
}
function create(bridge){
 const {state}=bridge,$=id=>document.getElementById(id),canvas=$('preview'),stage=canvas.parentElement;
 const media=document.createElement('audio');media.id='previewAudio';media.preload='auto';media.setAttribute('playsinline','');media.setAttribute('aria-hidden','true');media.hidden=true;document.body.append(media);
 const resultMedia=$('resultVideo');
 let loadedAudio=null,mediaURL=null,token=0,starting=false,offset=0,began=0,rate=1,stopAt=Infinity,capTimer=0,lastSession=0,pendingSeek=null,activeMedia=media,metadataKey='';
 const format=bridge.format||(t=>Number(t).toFixed(1)+'s');
 const notify=()=>{bridge.refresh?.();bridge.draw?.();};
 const getRate=()=>clamp(Number(bridge.getRate?.()??$('speed')?.value)||1,.1,4);
 function position(){
  if(!state.playing&&!starting)return clamp(state.position||0,0,state.duration||0);
  return clamp(loadedAudio?(Number.isFinite(media.currentTime)?media.currentTime:state.position):offset+(performance.now()-began)/1000*rate,0,state.duration||0);
 }
 const resultActive=()=>activeMedia===resultMedia&&!!resultMedia?.getAttribute('src');
 function session(force=false){
  if(!navigator.mediaSession)return;
  const now=performance.now();if(!force&&now-lastSession<250)return;lastSession=now;
  const isResult=resultActive(),element=isResult?resultMedia:(loadedAudio?media:null),duration=isResult?resultMedia.duration:state.duration;
  try{navigator.mediaSession.playbackState=element?((isResult?!element.paused:state.playing)?'playing':'paused'):'none';
   const title=isResult?($('download')?.download||'Exported lyric video'):(state.audioName||'Lyric preview'),key=element?(isResult?'result:':'preview:')+title:'none';
   if(key!==metadataKey&&typeof MediaMetadata==='function'){navigator.mediaSession.metadata=element?new MediaMetadata({title,artist:'Just Animate Whatever'}):null;metadataKey=key;}
   if(element&&Number.isFinite(duration)&&duration>0)navigator.mediaSession.setPositionState?.({duration,playbackRate:isResult?element.playbackRate:rate,position:isResult?clamp(element.currentTime,0,duration):position()});
   else navigator.mediaSession.setPositionState?.({});
  }catch{/* Unsupported media-session actions must not prevent playback. */}
 }
 function setAudio(buffer,name=state.audioName){
  if(buffer===loadedAudio)return;
  token++;starting=false;state.playing=false;clearTimeout(capTimer);media.pause();media.removeAttribute('src');media.load();
  if(mediaURL)URL.revokeObjectURL(mediaURL);mediaURL=null;loadedAudio=null;pendingSeek=null;
  if(buffer){mediaURL=URL.createObjectURL(wavBlob(buffer));loadedAudio=buffer;media.src=mediaURL;media.load();pendingSeek=state.position||0;}
  session(true);
 }
 function setMediaTime(t){pendingSeek=t;try{media.currentTime=t;pendingSeek=null;}catch{/* Retry after Safari has loaded the WAV metadata. */}}
 function pause(){
  const p=position();token++;starting=false;state.position=p;state.playing=false;clearTimeout(capTimer);media.pause();session(true);notify();
 }
 function finish(){
  const end=Math.min(stopAt,state.duration);token++;starting=false;state.playing=false;clearTimeout(capTimer);media.pause();state.position=end;
  if(loadedAudio)setMediaTime(end);session(true);notify();
 }
 function armCap(){
  clearTimeout(capTimer);if(!state.playing)return;
  const remaining=(Math.min(stopAt,state.duration)-position())/rate;
  if(remaining<=.001){finish();return;}
  capTimer=setTimeout(()=>{if(state.playing)armCap();},Math.max(10,Math.min(250,remaining*1000)));
 }
 async function play(until=Infinity){
  if(state.busy||!state.duration)return;
  if(state.playing){pause();return;}if(starting)return;
  activeMedia=media;resultMedia?.pause();
  if(state.audio!==loadedAudio)setAudio(state.audio,state.audioName);
  if(state.position>=state.duration)state.position=0;
  rate=getRate();stopAt=Math.min(Number.isFinite(until)?until:Infinity,state.duration);offset=state.position;began=performance.now();
  starting=true;const request=++token;
  try{
   if(loadedAudio){setMediaTime(offset);media.playbackRate=rate;
    // Keep play() in the original button/media-session gesture for iOS.
    await media.play();
   }
   if(request!==token)return;
   if(state.busy){pause();return;}
   starting=false;state.playing=true;began=performance.now();armCap();session(true);notify();
  }catch(error){if(request===token){starting=false;state.playing=false;media.pause();bridge.status?.(error.name==='NotAllowedError'?'Press Play on the page to enable audio playback.':error.message,true);session(true);notify();}}
 }
 function seek(value){
  if(state.busy)return;
  const next=clamp(Number(value)||0,0,state.duration||0);state.position=next;offset=next;began=performance.now();stopAt=state.duration;
  if(loadedAudio)setMediaTime(next);
  bridge.onSeek?.(next);
  if(next>=state.duration&&(state.playing||starting)){pause();return;}
  armCap();session(true);notify();
 }
 function skip(amount){if(state.busy||!state.duration)return;seek(position()+amount);flash(amount);}
 media.addEventListener('loadedmetadata',()=>{if(pendingSeek!==null)setMediaTime(pendingSeek);});
 media.addEventListener('play',()=>{
  if(media.paused)return;
  if(state.busy||!loadedAudio){media.pause();return;}
  // Native controls can resume the element directly on browsers without action handlers.
  if(!starting&&!state.playing){activeMedia=media;resultMedia?.pause();stopAt=state.duration;state.playing=true;rate=media.playbackRate;armCap();session(true);notify();}
 });
 media.addEventListener('pause',()=>{if(media.paused&&state.playing&&!media.ended)pause();});
 media.addEventListener('ended',()=>{if(media.ended&&loadedAudio)finish();});
 media.addEventListener('timeupdate',()=>{if(state.playing&&position()>=Math.min(stopAt,state.duration))finish();else draw();});
 media.addEventListener('seeked',()=>{if(loadedAudio){state.position=media.currentTime;armCap();bridge.draw?.();session(true);}});
 media.addEventListener('ratechange',()=>{rate=media.playbackRate;armCap();session(true);});
 media.addEventListener('error',()=>{if(!loadedAudio||!media.error)return;pause();bridge.status?.('This browser could not play the decoded audio preview. Try reopening the audio in a full browser.',true);});
 document.addEventListener('visibilitychange',()=>{if(document.hidden&&state.playing&&stopAt<state.duration)pause();});
 // Exported video is another native media element. Keep one audible transport
 // and leave headphone/lock-screen actions attached to the one the user chose.
 resultMedia?.addEventListener('play',()=>{
  if(resultMedia.paused)return;if(state.busy){resultMedia.pause();return;}
  activeMedia=resultMedia;pause();session(true);
 });
 for(const event of ['pause','ended','loadedmetadata','seeked','ratechange','timeupdate'])resultMedia?.addEventListener(event,()=>{if(resultActive())session(event!=='timeupdate');});
 for(const event of ['emptied','error'])resultMedia?.addEventListener(event,()=>{if(activeMedia===resultMedia){activeMedia=media;session(true);}});
 function seekResult(value){if(state.busy)return;const duration=resultMedia.duration;if(Number.isFinite(duration)){resultMedia.currentTime=clamp(Number(value)||0,0,duration);session(true);}}
 const actions={
  play:()=>{if(state.busy)return;if(resultActive()){void resultMedia.play().catch(error=>bridge.status?.(error.message,true));}else if(!state.playing)void play();},
  pause:()=>{if(resultActive()){resultMedia.pause();session(true);}else pause();},
  stop:()=>{if(resultActive()){resultMedia.pause();seekResult(0);}else{pause();seek(0);}},
  seekbackward:d=>{const amount=d.seekOffset||5;if(resultActive())seekResult(resultMedia.currentTime-amount);else skip(-amount);},
  seekforward:d=>{const amount=d.seekOffset||5;if(resultActive())seekResult(resultMedia.currentTime+amount);else skip(amount);},
  seekto:d=>{if(resultActive())seekResult(d.seekTime);else seek(d.seekTime);}
 };
 if(navigator.mediaSession)for(const [action,handler] of Object.entries(actions))try{navigator.mediaSession.setActionHandler(action,handler);}catch{}

 const button=(id,text,label,fn)=>{const b=document.createElement('button');b.type='button';b.id=id;b.className='quiet small';b.textContent=text;b.title=label;b.setAttribute('aria-label',label);b.addEventListener('click',fn);b.addEventListener('keydown',e=>{if(e.key===' ')e.stopPropagation();});return b;};
 const back=button('skipBack','↶ 5s','Back 5 seconds',()=>skip(-5)),forward=button('skipForward','5s ↷','Forward 5 seconds',()=>skip(5));
 $('restart').after(back,forward);
 const shell=document.createElement('div');shell.className='jaw-preview-shell';stage.insertBefore(shell,canvas);
 const handle=document.createElement('div');handle.className='jaw-float-bar';
 const grip=button('floatingMove','⠿ Preview','Move floating preview. Drag, or use arrow keys.',()=>{});grip.className='jaw-float-grip';
 const returnButton=button('floatingReturn','↗','Return to full preview',()=>stage.scrollIntoView({behavior:matchMedia('(prefers-reduced-motion: reduce)').matches?'auto':'smooth',block:'center'}));
 const closeButton=button('floatingClose','×','Hide floating preview until you return to it',()=>{dismissed=true;setFloating(false);});
 handle.append(grip,returnButton,closeButton);
 const surface=document.createElement('div');surface.className='jaw-preview-surface';surface.append(canvas);
 const glow=document.createElement('div');glow.className='jaw-skip-flash';glow.setAttribute('aria-hidden','true');surface.append(glow);
 const announcement=document.createElement('span');announcement.className='jaw-screen-reader';announcement.setAttribute('role','status');announcement.setAttribute('aria-live','polite');surface.append(announcement);
 const controls=document.createElement('div');controls.className='jaw-float-controls';
 const miniBack=button('floatingBack','↶ 5s','Back 5 seconds',()=>skip(-5));
 const miniPlay=button('floatingPlay','▶','Play preview',()=>void play());
 const miniForward=button('floatingForward','5s ↷','Forward 5 seconds',()=>skip(5));
 const miniClock=document.createElement('span');miniClock.className='jaw-float-clock';controls.append(miniBack,miniPlay,miniForward,miniClock);
 const resize=button('floatingResize','◢','Resize floating preview. Drag, or use arrow keys.',()=>{});resize.className='jaw-float-resize';
 shell.append(handle,surface,controls,resize);
 const placeholder=document.createElement('span');placeholder.className='jaw-float-placeholder';placeholder.textContent='Preview is floating while you edit';placeholder.hidden=true;stage.append(placeholder);
 const option=document.createElement('label');option.className='jaw-floating-option';
 const enabled=document.createElement('input');enabled.type='checkbox';enabled.id='floatingPreview';enabled.checked=true;option.append(enabled,document.createTextNode('Float preview while editing'));
 $('follow').closest('label').after(option);enabled.addEventListener('change',()=>{dismissed=false;checkFloating();});
 const tip=document.createElement('p');tip.className='note jaw-preview-tip';tip.id='previewGestureHelp';tip.textContent='Double-tap either side of the preview to skip 5 seconds.';$('scrubber').after(tip);
 canvas.tabIndex=0;canvas.setAttribute('aria-describedby',tip.id);
 canvas.addEventListener('keydown',e=>{if(e.key==='ArrowLeft'||e.key==='ArrowRight'){e.preventDefault();e.stopPropagation();skip(e.key==='ArrowLeft'?-5:5);}else if(e.key===' '){e.preventDefault();e.stopPropagation();void play();}});
 let tap=null,pointer=null,flashTimer=0;
 function flash(amount){
  glow.textContent=(amount<0?'−':'+')+Math.abs(amount)+'s';glow.dataset.side=amount<0?'left':'right';
  glow.classList.remove('is-visible');void glow.offsetWidth;glow.classList.add('is-visible');
  clearTimeout(flashTimer);flashTimer=setTimeout(()=>glow.classList.remove('is-visible'),750);
  announcement.textContent=(amount<0?'Back ':'Forward ')+Math.abs(amount)+' seconds';
 }
 surface.addEventListener('pointerdown',e=>{if(!e.isPrimary||e.button!==0){tap=null;pointer=null;return;}pointer={id:e.pointerId,x:e.clientX,y:e.clientY};});
 surface.addEventListener('pointercancel',()=>{tap=null;pointer=null;});
 surface.addEventListener('pointerup',e=>{
  if(!pointer||pointer.id!==e.pointerId||Math.hypot(e.clientX-pointer.x,e.clientY-pointer.y)>16){tap=null;pointer=null;return;}pointer=null;
  const rect=surface.getBoundingClientRect(),side=e.clientX<rect.left+rect.width/2?-1:1,now=performance.now();
  if(tap&&now-tap.time<350&&tap.side===side&&Math.hypot(e.clientX-tap.x,e.clientY-tap.y)<55){tap=null;e.preventDefault();skip(side*5);}
  else tap={time:now,side,x:e.clientX,y:e.clientY};
 });
 let floating=false,dismissed=false,queued=false,box={x:0,y:0,width:320},placed=false,gesture=null;
 const viewport=()=>({width:window.visualViewport?.width||window.innerWidth,height:window.visualViewport?.height||window.innerHeight,left:window.visualViewport?.offsetLeft||0,top:window.visualViewport?.offsetTop||0});
 function bounds(){
  const v=viewport(),aspect=canvas.width/canvas.height||16/9,chrome=78,maxWidth=Math.min(v.width-24,(v.height-24-chrome)*aspect,640),minWidth=Math.min(180,maxWidth);
  box.width=clamp(box.width,Math.max(80,minWidth),Math.max(80,maxWidth));
  const height=box.width/aspect+chrome;
  box.x=clamp(box.x,v.left+12,Math.max(v.left+12,v.left+v.width-box.width-12));box.y=clamp(box.y,v.top+12,Math.max(v.top+12,v.top+v.height-height-12));
  shell.style.left=box.x+'px';shell.style.top=box.y+'px';shell.style.width=box.width+'px';
 }
 function setFloating(value){
  if(value===floating)return;
  if(value){
   stage.style.height=stage.getBoundingClientRect().height+'px';placeholder.hidden=false;document.body.append(shell);shell.classList.add('is-floating');floating=true;
   if(!placed){const v=viewport();box.width=Math.min(320,v.width*.62);box.x=v.left+v.width-box.width-16;box.y=v.top+v.height-box.width/(canvas.width/canvas.height)-94;placed=true;}bounds();
  }else{
   floating=false;shell.classList.remove('is-floating');shell.style.removeProperty('left');shell.style.removeProperty('top');shell.style.removeProperty('width');stage.insertBefore(shell,placeholder);stage.style.removeProperty('height');placeholder.hidden=true;
  }
 }
 function checkFloating(){
  queued=false;const past=stage.getBoundingClientRect().bottom<=8;
  if(!past)dismissed=false;
  setFloating(past&&enabled.checked&&!dismissed&&state.duration>0);
 }
 function scheduleFloating(){if(!queued){queued=true;requestAnimationFrame(checkFloating);}}
 window.addEventListener('scroll',scheduleFloating,{passive:true});
 const resized=()=>{if(floating){stage.style.height=Math.min(510,(stage.clientWidth-32)*canvas.height/canvas.width)+32+'px';bounds();}scheduleFloating();};
 window.addEventListener('resize',resized,{passive:true});window.visualViewport?.addEventListener('resize',resized,{passive:true});window.visualViewport?.addEventListener('scroll',resized,{passive:true});
 for(const [element,kind] of [[grip,'move'],[resize,'resize']]){
  element.addEventListener('pointerdown',e=>{if(!floating||e.button!==0)return;e.preventDefault();gesture={kind,id:e.pointerId,x:e.clientX,y:e.clientY,box:{...box}};element.setPointerCapture(e.pointerId);});
  element.addEventListener('pointermove',e=>{if(!gesture||gesture.id!==e.pointerId)return;const dx=e.clientX-gesture.x,dy=e.clientY-gesture.y;
   if(kind==='move'){box.x=gesture.box.x+dx;box.y=gesture.box.y+dy;}else box.width=gesture.box.width+(Math.abs(dx)>Math.abs(dy)?dx:dy*canvas.width/canvas.height);bounds();
  });
  const end=()=>{gesture=null;};element.addEventListener('pointerup',end);element.addEventListener('pointercancel',end);element.addEventListener('lostpointercapture',end);
  element.addEventListener('keydown',e=>{if(!floating||!['ArrowLeft','ArrowRight','ArrowUp','ArrowDown'].includes(e.key))return;e.preventDefault();const d=e.shiftKey?40:10;
   if(kind==='resize')box.width+=(e.key==='ArrowLeft'||e.key==='ArrowUp'?-d:d);else if(e.key==='ArrowLeft'||e.key==='ArrowRight')box.x+=e.key==='ArrowLeft'?-d:d;else box.y+=e.key==='ArrowUp'?-d:d;bounds();
  });
 }
 function draw(){miniClock.textContent=format(position()).replace(/\.\d+$/,'');session();}
 function sync(){
  if(state.audio!==loadedAudio)setAudio(state.audio,state.audioName);
  for(const control of [back,forward,miniBack,miniPlay,miniForward])control.disabled=state.busy||!state.duration;
  miniPlay.textContent=state.playing?'❚❚':'▶';miniPlay.setAttribute('aria-label',state.playing?'Pause preview':'Play preview');miniPlay.title=state.playing?'Pause preview':'Play preview';
  shell.style.setProperty('--jaw-inline-width',canvas.style.maxWidth||'100%');if(floating){stage.style.height=Math.min(510,(stage.clientWidth-32)*canvas.height/canvas.width)+32+'px';bounds();}draw();session(true);scheduleFloating();
 }
 return {position,play,pause,seek,finish,setAudio,sync,draw,get stopAt(){return stopAt;},media};
}
window.JAWPlayback={create,wavBlob};
})();
