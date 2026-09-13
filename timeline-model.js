/* Shared timeline math. Integer milliseconds keep neighboring words contiguous. */
(function(root,factory){
  const api=factory();
  if(typeof module==='object'&&module.exports)module.exports=api;
  else root.KineticTimeline=api;
})(typeof globalThis==='object'?globalThis:this,function(){
  'use strict';
  const clamp=(n,a,b)=>Math.max(a,Math.min(b,n));
  const ms=n=>Math.round(n*1000),seconds=n=>n/1000;
  function viewport({start,span,duration,anchor=.5,factor=1,anchorTime}){
    const nextSpan=clamp(span*factor,.25,Math.max(30,duration));
    const time=Number.isFinite(anchorTime)?anchorTime:start+span*anchor;
    return {span:nextSpan,start:clamp(time-nextSpan*anchor,0,Math.max(0,duration-nextSpan))};
  }
  function snap(time,{grid=.05,targets=[],threshold=0}={}){
    let value=grid>0?Math.round(time/grid)*grid:time,kind='grid';
    let distance=threshold;
    for(const target of targets){
      const delta=Math.abs(target-time);
      if(delta<=distance){value=target;distance=delta;kind='word';}
    }
    return {time:seconds(ms(value)),kind};
  }
  function edit(words,id,{start,end,edge='move',duration,link=true,magnetic=false,grid=.05,threshold=0}={}){
    const index=words.findIndex(word=>word.id===id),word=words[index];
    if(!word)return {updates:[],snapped:null,blocked:true};
    const before=words[index-1],after=words[index+1];
    const ceiling=Math.max(1,Math.floor(duration*1000));
    const low=link&&before?Math.max(0,ms(before.start)+1):0;
    const high=link&&after?Math.min(ceiling,ms(after.end)-1):ceiling;
    let a=ms(Number.isFinite(start)?start:word.start),b=ms(Number.isFinite(end)?end:word.end),snapped=null;
    const targets=[before?.end,after?.start].filter(Number.isFinite);
    if(magnetic){
      const boundary=edge==='right'?seconds(b):seconds(a);
      snapped=snap(boundary,{grid,targets,threshold});
      if(edge==='right')b=ms(snapped.time);
      else {const delta=ms(snapped.time)-a;a+=delta;if(edge==='move')b+=delta;}
      // A moved word can also attach its trailing edge to a nearby word.
      if(edge==='move'&&after&&Math.abs((end??word.end)-after.start)<=threshold){
        b=ms(after.start);a=b-ms((end??word.end)-(start??word.start));snapped={time:seconds(b),kind:'word'};
      }
    }
    if(high-low<1)return {updates:[],snapped:null,blocked:true};
    if(edge==='move'){
      const length=b-a;
      if(length<1||length>high-low)return {updates:[],snapped:null,blocked:true};
      a=clamp(a,low,high-length);b=a+length;
    }else if(edge==='left'){
      b=clamp(b,low+1,high);a=clamp(a,low,b-1);
    }else{
      a=clamp(a,low,high-1);b=clamp(b,a+1,high);
    }
    if(snapped&&ms(snapped.time)!==(edge==='right'?b:snapped.kind==='word'&&ms(snapped.time)===b?b:a))snapped=null;
    const updates=[{id,start:seconds(a),end:seconds(b)}];
    if(link&&before)updates.push({id:before.id,start:before.start,end:seconds(a)});
    if(link&&after)updates.push({id:after.id,start:seconds(b),end:after.end});
    return {updates,snapped,blocked:false};
  }
  return Object.freeze({viewport,snap,edit});
});
