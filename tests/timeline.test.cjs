const test=require('node:test');
const assert=require('node:assert/strict');
const timeline=require('../timeline-model.js');
const words=[{id:'a',start:0,end:1},{id:'b',start:1.2,end:2},{id:'c',start:2.4,end:4}];
const edit=options=>timeline.edit(words,'b',{start:1.2,end:2,duration:5,...options});

test('moving a word preserves its duration and closes both surrounding gaps',()=>{
 assert.deepEqual(edit({start:1.4,end:2.2}).updates,[{id:'b',start:1.4,end:2.2},{id:'a',start:0,end:1.4},{id:'c',start:2.2,end:4}]);
 assert.deepEqual(words[0],{id:'a',start:0,end:1});
});
test('moving and trimming against neighbors leaves every word at least 1 ms',()=>{
 const left=edit({start:-100,end:-99.2});assert.equal(left.updates[0].start,.001);assert.equal(left.updates[1].end,.001);
 const right=edit({start:100,end:100.8});assert.equal(right.updates[0].end,3.999);assert.equal(right.updates[2].start,3.999);
 assert.equal(edit({edge:'left',start:9}).updates[0].start,1.999);
 assert.equal(edit({edge:'right',end:-4}).updates[0].end,1.201);
});
test('unlinked editing changes no neighbors and can preserve intentional gaps',()=>{
 assert.deepEqual(edit({start:2,end:2.8,link:false}).updates,[{id:'b',start:2,end:2.8}]);
});
test('frame-grid magnetic movement preserves sub-frame duration',()=>{
 const result=edit({start:1.293,end:2.093,magnetic:true,grid:1/24});
 assert.equal(result.updates[0].start,1.292);assert.equal(result.updates[0].end,2.092);
 assert.equal(result.snapped.kind,'grid');
});
test('both leading and trailing word edges attract within the snap radius',()=>{
 assert.equal(edit({start:1.008,end:1.808,magnetic:true,threshold:.02}).updates[0].start,1);
 assert.equal(edit({start:1.592,end:2.392,magnetic:true,threshold:.02}).updates[0].end,2.4);
});
test('clamping cannot claim a snap that was prevented by a neighbor',()=>{
 const result=edit({start:-10,end:-9.2,magnetic:true,grid:.1});assert.equal(result.snapped,null);
});
test('impossible overlapping neighbors are rejected without corrupting timings',()=>{
 const overlapping=[{id:'a',start:2,end:5},{id:'b',start:2,end:4},{id:'c',start:2,end:2.001}];
 assert.equal(timeline.edit(overlapping,'b',{start:2,end:4,duration:6}).blocked,true);
});
test('thousands of drags retain valid contiguous boundaries',()=>{
 for(let i=0;i<3000;i++){
  const edge=['left','right','move'][i%3],offset=Math.sin(i)*15;
  const result=edit({edge,start:1.2+(edge==='right'?0:offset),end:2+(edge==='left'?0:offset),magnetic:i%2===0,grid:1/24,threshold:.03});
  assert.equal(result.blocked,false);
  for(const word of result.updates){assert.ok(word.start>=0);assert.ok(word.end>word.start);assert.ok(word.end<=5);}
  assert.equal(result.updates[0].start,result.updates[1].end);assert.equal(result.updates[0].end,result.updates[2].start);
 }
});
test('zoom keeps the time under the pointer fixed',()=>{
 const next=timeline.viewport({start:10,span:8,duration:60,anchor:.8,factor:.5});
 assert.equal(next.span,4);assert.ok(Math.abs(next.start+next.span*.8-16.4)<1e-9);
});
test('pinch changes span and follows the moving midpoint',()=>{
 const next=timeline.viewport({start:10,span:8,duration:60,anchor:.7,anchorTime:14,factor:.5});
 assert.equal(next.span,4);assert.ok(Math.abs(next.start-11.2)<1e-9);
});
test('viewports clamp to the beginning, end, and zoom limits',()=>{
 assert.equal(timeline.viewport({start:0,span:8,duration:60,anchor:1,factor:8}).start,0);
 assert.deepEqual(timeline.viewport({start:59,span:1,duration:60,anchor:1,factor:4}),{start:56,span:4});
 assert.equal(timeline.viewport({start:0,span:1,duration:60,factor:.001}).span,.25);
});
