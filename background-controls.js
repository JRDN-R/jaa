/* Background framing is independent of word layout and preview transport. */
(() => {
 'use strict';
 const clamp=(n,a,b)=>Math.max(a,Math.min(b,n));
 function create(bridge){
  const $=id=>document.getElementById(id),canvas=$('preview');
  const panel=document.createElement('section');panel.className='background-panel';panel.setAttribute('aria-label','Background media');
  panel.innerHTML=`<div class="row background-toolbar"><button id="uploadBackground" type="button" class="small">↑ Background image / video</button><button id="adjustBackground" type="button" class="quiet small" aria-expanded="false" aria-controls="backgroundControls" disabled>Adjust background</button><button id="removeBackground" type="button" class="quiet small" disabled>Remove</button></div>
   <input id="backgroundFile" class="hidden-file" type="file" accept="image/*,video/*,.mov,.m4v,.webm" aria-label="Upload background image or video">
   <p id="backgroundName" class="note background-name" role="status">Optional. Add your own image or silent video behind the lyrics.</p>
   <div id="backgroundControls" hidden><div class="background-zoom"><button id="backgroundZoomOut" type="button" class="quiet small" aria-label="Zoom background out">−</button><label for="backgroundZoom">Background zoom</label><input id="backgroundZoom" type="range" min="0.1" max="5" step="0.01" value="1"><output id="backgroundZoomValue" for="backgroundZoom">100%</output><button id="backgroundZoomIn" type="button" class="quiet small" aria-label="Zoom background in">+</button></div>
   <div class="row"><button id="backgroundFit" type="button" class="quiet small">Fit whole image</button><button id="backgroundFill" type="button" class="quiet small">Fill frame</button><button id="lockBackground" type="button" class="primary small">Lock background</button></div>
   <p class="note">Drag the background in the preview to position it. Pinch or scroll to zoom, or use the slider. Arrow keys move it. Lock when finished. Videos loop silently with your lyrics.</p></div>`;
  canvas.parentElement.before(panel);
  const pointers=new Map();let gesture=null;
  const editing=()=>!!bridge.getEntry()&&!bridge.getRecord()?.locked&&!bridge.isBusy();
  const transform=()=>bridge.getRecord()?.transform||{zoom:1,x:0,y:0};
  function release(){for(const id of pointers.keys())try{canvas.releasePointerCapture(id);}catch{}pointers.clear();gesture=null;}
  function refresh(){
   const record=bridge.getRecord(),entry=bridge.getEntry(),busy=bridge.isBusy(),active=editing();
   for(const id of ['uploadBackground','backgroundFile'])$(id).disabled=busy;
   $('adjustBackground').disabled=busy||!entry;$('removeBackground').disabled=busy||!record;
   $('adjustBackground').textContent=active?'Lock background':'Adjust background';
   $('adjustBackground').setAttribute('aria-expanded',String(active));$('backgroundControls').hidden=!active;
   for(const id of ['backgroundZoom','backgroundZoomIn','backgroundZoomOut','backgroundFit','backgroundFill','lockBackground'])$(id).disabled=!active;
   const zoom=transform().zoom;$('backgroundZoom').value=zoom;$('backgroundZoomValue').value=Math.round(zoom*100)+'%';
   $('backgroundZoom').setAttribute('aria-valuetext',Math.round(zoom*100)+' percent');
   $('backgroundName').textContent=record?record.name+(entry?(active?' · Adjusting background':' · Locked'):' · Upload this background again to restore it'):'Optional. Add your own image or silent video behind the lyrics.';
   canvas.classList.toggle('background-editing',active);canvas.setAttribute('aria-label',active?'Adjust background. Drag to move, pinch or scroll to zoom, arrow keys to position.':'Animated lyric video preview');
   if(!active)release();
  }
  function update(value){if(!editing())return;const t=transform();bridge.getRecord().transform={zoom:clamp(value.zoom??t.zoom,.1,5),x:clamp(value.x??t.x,-5,5),y:clamp(value.y??t.y,-5,5)};bridge.onChange();refresh();}
  function lock(){if(!editing())return;bridge.getRecord().locked=true;release();bridge.onChange();refresh();$('adjustBackground').focus();}
  $('uploadBackground').onclick=()=>$('backgroundFile').click();
  $('backgroundFile').onchange=e=>{void bridge.onUpload(e.target.files[0]);e.target.value='';};
  $('adjustBackground').onclick=()=>{if(bridge.isBusy()||!bridge.getEntry())return;if(editing()){lock();return;}bridge.pause();bridge.getRecord().locked=false;bridge.onChange();refresh();canvas.focus({preventScroll:true});};
  $('lockBackground').onclick=lock;$('removeBackground').onclick=()=>{release();bridge.onRemove();};
  $('backgroundZoom').oninput=e=>update({zoom:Number(e.target.value)});
  $('backgroundZoomOut').onclick=()=>update({zoom:transform().zoom/1.1});$('backgroundZoomIn').onclick=()=>update({zoom:transform().zoom*1.1});
  $('backgroundFill').onclick=()=>update({zoom:1,x:0,y:0});
  $('backgroundFit').onclick=()=>{const source=bridge.getEntry()?.source;if(!source)return;const w=source.videoWidth||source.naturalWidth,h=source.videoHeight||source.naturalHeight;update({zoom:Math.min(canvas.width/w,canvas.height/h)/Math.max(canvas.width/w,canvas.height/h),x:0,y:0});};
  const point=e=>{const r=canvas.getBoundingClientRect();return {x:(e.clientX-r.left)/r.width,y:(e.clientY-r.top)/r.height,px:e.clientX,py:e.clientY};};
  function startGesture(){const ps=[...pointers.values()],t=transform();gesture=ps.length>1?{...t,cx:(ps[0].x+ps[1].x)/2,cy:(ps[0].y+ps[1].y)/2,distance:Math.hypot(ps[1].px-ps[0].px,ps[1].py-ps[0].py)}:{...t,cx:ps[0]?.x,cy:ps[0]?.y};}
  canvas.addEventListener('pointerdown',e=>{if(!editing()||e.button>0)return;e.preventDefault();e.stopImmediatePropagation();bridge.pause();canvas.focus({preventScroll:true});pointers.set(e.pointerId,point(e));canvas.setPointerCapture(e.pointerId);startGesture();},true);
  canvas.addEventListener('pointermove',e=>{if(!editing()||!pointers.has(e.pointerId))return;e.preventDefault();e.stopImmediatePropagation();pointers.set(e.pointerId,point(e));const ps=[...pointers.values()],g=gesture;if(ps.length>1){const cx=(ps[0].x+ps[1].x)/2,cy=(ps[0].y+ps[1].y)/2,zoom=clamp(g.zoom*Math.hypot(ps[1].px-ps[0].px,ps[1].py-ps[0].py)/Math.max(.001,g.distance),.1,5),ratio=zoom/g.zoom;update({zoom,x:cx-.5-(g.cx-.5-g.x)*ratio,y:cy-.5-(g.cy-.5-g.y)*ratio});}else update({x:g.x+ps[0].x-g.cx,y:g.y+ps[0].y-g.cy});},true);
  const end=e=>{if(!pointers.has(e.pointerId))return;e.preventDefault();e.stopImmediatePropagation();pointers.delete(e.pointerId);try{canvas.releasePointerCapture(e.pointerId);}catch{}if(pointers.size)startGesture();else gesture=null;};
  for(const event of ['pointerup','pointercancel','lostpointercapture'])canvas.addEventListener(event,end,true);
  // Keep background gestures from triggering the preview's double-tap seeking.
  for(const event of ['click','dblclick','touchstart','touchend'])canvas.addEventListener(event,e=>{if(editing()){e.stopImmediatePropagation();if(event==='dblclick')e.preventDefault();}},true);
  canvas.addEventListener('wheel',e=>{if(!editing()||e.ctrlKey||e.metaKey)return;e.preventDefault();e.stopImmediatePropagation();const p=point(e),t=transform(),zoom=clamp(t.zoom*Math.exp(-e.deltaY*(e.deltaMode===1?.04:.002)),.1,5),ratio=zoom/t.zoom;update({zoom,x:p.x-.5-(p.x-.5-t.x)*ratio,y:p.y-.5-(p.y-.5-t.y)*ratio});},{capture:true,passive:false});
  canvas.addEventListener('keydown',e=>{if(!editing())return;const t=transform(),d=e.shiftKey?.05:.01;if(e.key==='Escape'){e.preventDefault();e.stopImmediatePropagation();lock();return;}if(!['ArrowLeft','ArrowRight','ArrowUp','ArrowDown','+','=','-'].includes(e.key))return;e.preventDefault();e.stopImmediatePropagation();if(e.key==='+'||e.key==='=')update({zoom:t.zoom*1.1});else if(e.key==='-')update({zoom:t.zoom/1.1});else update({x:t.x+(e.key==='ArrowLeft'?-d:e.key==='ArrowRight'?d:0),y:t.y+(e.key==='ArrowUp'?-d:e.key==='ArrowDown'?d:0)});},true);
  refresh();return {refresh};
 }
 globalThis.JAWBackgroundControls=Object.freeze({create});
})();
