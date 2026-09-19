const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

function recordingRenderer(width=1920,height=1080) {
  const calls=[];
  const context=new Proxy({measureText:text=>({width:text.length*70,actualBoundingBoxAscent:76,actualBoundingBoxDescent:4})},{
    get(target,key){return key in target?target[key]:(...args)=>calls.push({method:key,args,style:{...target}});},
    set(target,key,value){target[key]=value;return true;}
  });
  const canvas={width,height,getContext:()=>context},sandbox={window:{}};
  vm.runInNewContext(fs.readFileSync('kinetic-renderer.js','utf8'),sandbox);
  const renderer=sandbox.window.KineticRenderer.create(canvas);
  renderer.setProject([{id:'a',text:'Hello',start:0,end:1}],{motion:0});
  calls.length=0;
  return {renderer,canvas,calls};
}

// The renderer must clear old pixels, then omit only the background fill for alpha.
// Recording context operations also checks changing projects cannot leak transparency.
test('transparent frames clear their alpha channel and opaque frames paint the background', () => {
  const calls = [];
  const context = new Proxy({measureText: text => ({width: text.length * 70, actualBoundingBoxAscent: 76, actualBoundingBoxDescent: 4})}, {
    get(target, key) { return key in target ? target[key] : (...args) => calls.push([key, ...args]); },
    set(target, key, value) { target[key] = value; return true; }
  });
  const canvas = {width: 1920, height: 1080, getContext: (type, options) => {assert.equal(options.alpha, true); return context;}};
  const sandbox = {window: {}};
  vm.runInNewContext(fs.readFileSync('kinetic-renderer.js', 'utf8'), sandbox);
  const renderer = sandbox.window.KineticRenderer.create(canvas);
  const words = [{id: 'a', text: 'Hello', start: 0, end: 1}];
  renderer.setProject(words, {transparent: true});
  calls.length = 0;
  renderer.render(.5);
  assert.equal(calls.filter(call => call[0] === 'clearRect').length, 1);
  assert.equal(calls.filter(call => call[0] === 'fillRect').length, 0);
  assert.ok(calls.some(call => call[0] === 'fillText'));
  renderer.setProject(words, {transparent: false});
  calls.length = 0;
  renderer.render(.5);
  assert.ok(calls.some(call => call[0] === 'fillRect' && call[3] === 1920 && call[4] === 1080));
});

test('background media uses centered cover and an independent transform at any frame resolution',()=>{
  const {renderer,canvas,calls}=recordingRenderer();
  const source={naturalWidth:1000,naturalHeight:1000,complete:true};
  renderer.setBackground(source);
  renderer.render(.5);
  assert.deepEqual(calls.find(call=>call.method==='drawImage').args,[source,0,-420,1920,1920]);
  renderer.setBackground(source,{zoom:.5,x:.25,y:-.25});
  calls.length=0;
  renderer.render(.5);
  assert.deepEqual(calls.find(call=>call.method==='drawImage').args,[source,960,-210,960,960]);
  canvas.width=960;canvas.height=540;
  calls.length=0;
  renderer.render(.5);
  assert.deepEqual(calls.find(call=>call.method==='drawImage').args,[source,480,-105,480,480]);
});

test('transparent projects retain media behind text and clearing media restores transparent frames',()=>{
  const {renderer,calls}=recordingRenderer();
  const source={naturalWidth:1920,naturalHeight:1080};
  renderer.setBackground(source,{zoom:1.5,x:0,y:0});
  renderer.setProject([{id:'a',text:'Hello',start:0,end:1}],{transparent:true,motion:0});
  calls.length=0;
  renderer.render(.5);
  assert.equal(calls.some(call=>call.method==='fillRect'),false);
  assert.ok(calls.findIndex(call=>call.method==='clearRect')<calls.findIndex(call=>call.method==='drawImage'));
  assert.ok(calls.findIndex(call=>call.method==='drawImage')<calls.findIndex(call=>call.method==='fillText'));
  assert.equal(calls.find(call=>call.method==='drawImage').args[3],2880);
  renderer.setBackground(null);
  calls.length=0;
  renderer.render(.5);
  assert.equal(calls.some(call=>call.method==='drawImage'),false);
  assert.equal(calls.some(call=>call.method==='fillRect'),false);
});

test('video waits for drawable frames and uses intrinsic dimensions instead of element dimensions',()=>{
  const {renderer,calls}=recordingRenderer();
  const source={videoWidth:1600,videoHeight:900,width:320,height:240,readyState:1};
  renderer.setBackground(source);
  renderer.render(.5);
  assert.equal(calls.some(call=>call.method==='drawImage'),false);
  source.readyState=2;
  calls.length=0;
  renderer.render(.5);
  assert.deepEqual(calls.find(call=>call.method==='drawImage').args,[source,0,0,1920,1080]);
});

test('every style draws rounded shadowed glyph outlines before crisp foreground and accent text',()=>{
  for(const style of ['kinetic','stack','spotlight'])for(const emphasis of [false,true]){
    const {renderer,canvas,calls}=recordingRenderer();
    renderer.setProject([{id:'a',text:'Hello',start:0,end:1,emphasis}],{style,motion:0,foreground:'#ffffff',accent:'#87a98b'});
    calls.length=0;
    renderer.render(.5);
    const outline=calls.find(call=>call.method==='strokeText'),fill=calls.find(call=>call.method==='fillText');
    assert.ok(outline);
    assert.ok(calls.indexOf(outline)<calls.indexOf(fill));
    assert.equal(outline.style.lineJoin,'round');
    assert.ok(outline.style.lineWidth>0);
    assert.ok(outline.style.shadowBlur>0);
    assert.match(outline.style.strokeStyle,/^rgba\(0,0,0,/);
    assert.match(outline.style.shadowColor,/^rgba\(0,0,0,/);
    assert.equal(fill.style.shadowBlur,0);
    assert.equal(fill.style.shadowColor,'transparent');
    assert.equal(fill.style.fillStyle,emphasis?'#87a98b':'#ffffff');
    assert.deepEqual(outline.args,fill.args);
    canvas.width/=2;canvas.height/=2;
    calls.length=0;
    renderer.render(.5);
    const smaller=calls.find(call=>call.method==='strokeText');
    assert.ok(Math.abs(smaller.style.shadowBlur*2-outline.style.shadowBlur)<.00001);
    assert.ok(Math.abs(smaller.style.lineWidth*2-outline.style.lineWidth)<.00001);
  }
});
