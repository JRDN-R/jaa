const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require('node:path').join(__dirname, '..', 'video-export.js'), 'utf8');
function exporter(navigator={userAgent:'Desktop',platform:'MacIntel',maxTouchPoints:0}) {
  const configurations=[];
  const context={ navigator, DOMException, setTimeout,clearTimeout, Blob, Worker:class{}, WebAssembly, fetch:async()=>{},
    Mediabunny:{}, VideoFrame:class{}, VideoEncoder:{isConfigSupported:async config=>{configurations.push(config);return {supported:true}}},
    AudioEncoder:{isConfigSupported:async()=>({supported:true})} };
  vm.runInNewContext(source,context);
  return {...context.LyricVideoExport,configurations};
}
test('4K uses H.264 levels that support actual frame size and rate',async()=>{
  const x=exporter();
  for(const [fps,level,bitrate] of [[24,'33',40000000],[30,'33',40000000],[50,'34',Math.round(40000000*50/30)],[60,'34',80000000]]) {
    const result=await x.capabilities({width:3840,height:2160,fps});
    assert.equal(result.supported,true);assert.equal(result.videoConfig.codec,'avc1.6400'+level);assert.equal(result.bitrate,bitrate);
  }
  assert.equal((await x.capabilities({width:1920,height:1080,fps:30})).videoConfig.codec,'avc1.640028');
  assert.equal((await x.capabilities({width:1920,height:1080,fps:60})).videoConfig.codec,'avc1.64002a');
});
test('iPhone, Android and desktop-mode iPad enforce 1080p and <=30fps in executor',async()=>{
  for(const device of [{userAgent:'iPhone',platform:'iPhone'}, {userAgent:'Android',platform:'Linux'}, {userAgent:'Macintosh',platform:'MacIntel',maxTouchPoints:5}]) {
    const x=exporter(device);assert.equal(x.isMobileDevice(),true);
    for(const format of ['mp4','mov','webm']) {
      assert.equal((await x.capabilities({format,width:3840,height:2160})).supported,false);
      assert.equal((await x.capabilities({format,fps:60})).supported,false);
      assert.equal((await x.capabilities({format,width:1080,height:1920,fps:30})).supported,true);
      await assert.rejects(x.exportVideo({format,canvas:{width:3840,height:2160},audioBuffer:{length:10},renderFrame:()=>{}}),/Mobile exports/);
    }
  }
});
test('alpha requests cannot silently pass through MP4',async()=>{
  const x=exporter();
  assert.equal((await x.capabilities({transparent:true})).supported,false);
  await assert.rejects(x.exportMP4({transparent:true,canvas:{width:1920,height:1080},audioBuffer:{length:10},renderFrame:()=>{}}),/cannot preserve transparency/);
  assert.equal((await x.capabilities({format:'webm',transparent:true})).supported,true);
  assert.equal((await x.capabilities({format:'mov',transparent:true})).supported,true);
});
test('invalid formats and sizes produce actionable failures',async()=>{
  const x=exporter();
  assert.equal((await x.capabilities({format:'gif'})).supported,false);
  assert.equal((await x.capabilities({width:4096,height:4096})).supported,false);
  assert.equal((await x.capabilities({fps:29.97})).supported,false);
});
