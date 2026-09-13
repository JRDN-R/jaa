const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
function load(mobile,document={}){const sandbox={document,LyricVideoExport:{isMobileDevice:()=>mobile}};vm.runInNewContext(fs.readFileSync('export-controls.js','utf8'),sandbox);return sandbox.JAWExportSettings;}
test('mobile project import cannot restore 4K or high frame rates',()=>{const settings=load(true).normalize({fps:60,resolution:'2160',exportFormat:'mov',transparent:true});assert.equal(settings.fps,30);assert.equal(settings.resolution,'1080');assert.equal(settings.transparent,true);});
test('desktop preserves supported quality and transparent formats',()=>{const settings=load(false).normalize({fps:50,resolution:'2160',exportFormat:'webm',transparent:true});assert.equal(settings.fps,50);assert.equal(settings.resolution,'2160');assert.equal(settings.transparent,true);});
test('MP4 always uses an opaque background and invalid settings fall back',()=>{const settings=load(false).normalize({fps:999,resolution:'foo',exportFormat:'invalid',transparent:true});assert.equal(settings.fps,24);assert.equal(settings.resolution,'1080');assert.equal(settings.exportFormat,'mp4');assert.equal(settings.transparent,false);});
test('all aspect ratios scale to the intended 1080p and 4K dimensions',()=>{const api=load(false);assert.deepEqual(Array.from(api.dimensions('portrait','2160')),[2160,3840]);assert.deepEqual(Array.from(api.dimensions('wide','2160')),[3840,2160]);assert.deepEqual(Array.from(api.dimensions('square','2160')),[2160,2160]);assert.deepEqual(Array.from(api.dimensions('wide')),[1920,1080]);});
test('background color remains available in transparent mode and locks only while busy',()=>{
 const elements=new Map();
 const document={getElementById(id){if(!elements.has(id))elements.set(id,{options:[],classList:{toggle(){}}});return elements.get(id);}};
 const api=load(false,document);
 for(const exportFormat of ['webm','mov']){
  const state={busy:false,settings:{exportFormat,transparent:true,aspect:'wide',resolution:'1080',fps:24}};
  api.refresh(state);
  assert.equal(document.getElementById('background').disabled,false);
  assert.equal(document.getElementById('transparent').checked,true);
  assert.match(document.getElementById('transparencyHelp').textContent,/Choosing a background color turns transparency off/);
  state.busy=true;api.refresh(state);
  assert.equal(document.getElementById('background').disabled,true);
  state.busy=false;state.settings.transparent=false;api.refresh(state);
  assert.equal(document.getElementById('background').disabled,false);
  assert.equal(document.getElementById('transparent').checked,false);
  assert.equal(document.getElementById('transparencyHelp').textContent,'Enable transparency to export without a background.');
 }
});
