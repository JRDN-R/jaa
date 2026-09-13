const assert=require('node:assert/strict');
const test=require('node:test');
const vm=require('node:vm');
const fs=require('node:fs');
const path=require('node:path');
const context={window:{},Blob};
vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../playback-enhancements.js'),'utf8'),context);
const {wavBlob}=context.window.JAWPlayback;
const buffer=(channels,rate=48000)=>({numberOfChannels:channels.length,length:channels[0].length,sampleRate:rate,getChannelData:c=>channels[c]});
test('preview WAV has a valid PCM header, correct signed peaks, and original samples remain untouched',async()=>{
 const samples=new Float32Array([-1,-.5,0,.5,1]);
 const blob=wavBlob(buffer([samples],44100)),bytes=await blob.arrayBuffer(),view=new DataView(bytes);
 assert.equal(blob.type,'audio/wav');assert.equal(Buffer.from(bytes).subarray(0,4).toString(),'RIFF');
 assert.equal(view.getUint32(4,true),bytes.byteLength-8);assert.equal(view.getUint16(20,true),1);assert.equal(view.getUint16(22,true),1);assert.equal(view.getUint32(24,true),44100);
 assert.equal(view.getUint16(34,true),16);assert.equal(view.getUint32(40,true),10);
 assert.deepEqual(Array.from({length:5},(_,i)=>view.getInt16(44+i*2,true)),[-32768,-16384,0,16384,32767]);
 assert.deepEqual(Array.from(samples),[-1,-.5,0,.5,1]);
});
test('stereo samples remain interleaved across PCM chunk boundaries',async()=>{
 const left=new Float32Array(32770),right=new Float32Array(32770);left[32767]=1;right[32768]=-.5;left[32769]=.5;
 const bytes=await wavBlob(buffer([left,right])).arrayBuffer(),view=new DataView(bytes);
 assert.equal(view.getUint16(22,true),2);assert.equal(view.getUint32(40,true),32770*4);
 assert.equal(view.getInt16(44+32767*4,true),32767);assert.equal(view.getInt16(44+32768*4+2,true),-16384);assert.equal(view.getInt16(44+32769*4,true),16384);
});
test('surround center and rear channels are audible in a bounded stereo downmix',async()=>{
 for(let active=0;active<6;active++){
  const channels=Array.from({length:6},(_,i)=>new Float32Array([i===active?1:0]));
  const view=new DataView(await wavBlob(buffer(channels)).arrayBuffer());
  assert.equal(view.getUint16(22,true),2);const l=view.getInt16(44,true),r=view.getInt16(46,true);assert.ok(l>0||r>0,'channel '+active+' survives');
  if(active===2)assert.equal(l,r,'center is present equally in both ears');
 }
 const all=Array.from({length:6},()=>new Float32Array([1]));const view=new DataView(await wavBlob(buffer(all)).arrayBuffer());assert.equal(view.getInt16(44,true),32767);assert.equal(view.getInt16(46,true),32767);
});
test('an oversized recording fails before allocating PCM data',()=>{
 assert.throws(()=>wavBlob({numberOfChannels:2,length:0x40000000}),/too long/);
});
