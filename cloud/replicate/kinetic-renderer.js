/* Kinetic typography renderer. No clock or randomness is used while drawing:
   preview and encoded frames are exactly the same composition at a given time. */
(() => {
  'use strict';
  const clamp = (n, a = 0, b = 1) => Math.max(a, Math.min(b, n));
  const mix = (a, b, t) => a + (b - a) * t;
  const ease = t => 1 - Math.pow(1 - clamp(t), 4);
  const smooth = t => { t = clamp(t); return t * t * (3 - 2 * t); };
  const hash = text => { let n = 2166136261; for (const c of text) n = Math.imul(n ^ c.codePointAt(0), 16777619); return n >>> 0; };
  const defaults = {background:'#000000',foreground:'#ffffff',accent:'#87a98b',font:'Arial Black',style:'kinetic',motion:1,groupSize:5,uppercase:false};

  function create(canvas) {
    const ctx = canvas.getContext('2d', {alpha:true});
    if (!ctx) throw new Error('This browser cannot draw the video preview.');
    let settings = {...defaults}, words = [], groups = [], layoutWidth = 0, layoutHeight = 0;
    const metrics = new Map();

    function font(size) {
      const family = String(settings.font || defaults.font).replace(/["\\\n\r]/g, '');
      return `900 ${size}px "${family}", "Arial Black", Arial, sans-serif`;
    }
    function measurement(text) {
      if (metrics.has(text)) return metrics.get(text);
      ctx.font = font(100);
      const m = ctx.measureText(text);
      const result = {w: Math.max(12, m.width), a:m.actualBoundingBoxAscent || 76, d:m.actualBoundingBoxDescent || 4};
      result.h = result.a + result.d;
      metrics.set(text, result);
      return result;
    }
    function item(word, size, x = 0, y = 0, r = 0) {
      const m = measurement(word.display);
      return {id:word.id,word,text:word.display,size,x,y,r,w:m.w * size / 100,h:m.h * size / 100};
    }
    function scaleItem(it, factor) { it.size *= factor; it.w *= factor; it.h *= factor; return it; }
    function bound(items) {
      let x1=Infinity,y1=Infinity,x2=-Infinity,y2=-Infinity;
      for (const it of items) {
        const c=Math.abs(Math.cos(it.r)),s=Math.abs(Math.sin(it.r));
        const hw=(it.w*c+it.h*s)/2,hh=(it.h*c+it.w*s)/2;
        x1=Math.min(x1,it.x-hw);x2=Math.max(x2,it.x+hw);y1=Math.min(y1,it.y-hh);y2=Math.max(y2,it.y+hh);
      }
      return {x1,y1,x2,y2,w:x2-x1,h:y2-y1};
    }
    function fit(items, spaceW, spaceH) {
      if (!items.length) return items;
      const b=bound(items),factor=Math.min(spaceW / Math.max(1,b.w),spaceH / Math.max(1,b.h));
      const cx=(b.x1+b.x2)/2,cy=(b.y1+b.y2)/2;
      for (const it of items) {it.x=(it.x-cx)*factor;it.y=(it.y-cy)*factor;scaleItem(it,factor);}
      return items;
    }
    // Small words retain their own transforms, including when a newly spoken word
    // pushes them into a different position. Nothing is flattened into a caption.
    function shelf(list, availableWidth, startY, baseSize, align='left') {
      const result=[],rows=[];let row=[],width=0;
      for (const word of list) {
        const it=item(word,baseSize*(word.emphasis?1.16:1));
        if (it.w>availableWidth) scaleItem(it,availableWidth/it.w);
        const gap=baseSize*.19;
        if (row.length && width+gap+it.w>availableWidth) {rows.push(row);row=[];width=0;}
        row.push(it);width+=it.w+(row.length>1?gap:0);
      }
      if (row.length) rows.push(row);
      let y=startY;
      for (const rowItems of rows) {
        const gap=baseSize*.19,rw=rowItems.reduce((s,it)=>s+it.w,0)+gap*(rowItems.length-1),rh=Math.max(...rowItems.map(it=>it.h));
        let x=align==='right'?availableWidth-rw:align==='center'?(availableWidth-rw)/2:0;
        for(const it of rowItems){it.x=x+it.w/2;it.y=y+rh/2+(rh-it.h)*.12;x+=it.w+gap;result.push(it);}
        y+=rh+baseSize*.12;
      }
      return {items:result,bottom:y};
    }
    function stage(group, n) {
      const visible=group.words.slice(0,n+1),current=visible[n],older=visible.slice(0,-2),previous=visible[n-1];
      const W=canvas.width,H=canvas.height,aspect=W/H;
      const maxW=W*.83,maxH=H*.76;
      let result=[];
      if (settings.style==='spotlight') {
        result=[item(current,300)];
        fit(result,maxW,maxH*.68);
      } else if (settings.style==='stack') {
        // A quieter, fixed-order stack, still with independent word entrances.
        let y=0;
        const all=visible.map((w,i)=>item(w,w.emphasis?180:i===n?145:105));
        for (const it of all) {if(it.w>950)scaleItem(it,950/it.w);it.x=(group.seed%2?-1:1)*(950-it.w)*.08;it.y=y+it.h/2;y+=it.h+12;}
        result=fit(all,maxW,maxH);
      } else {
        const hero=item(current,current.emphasis?315:275);
        // A single unusually long word is condensed only by proportional scaling.
        if (hero.w>1080) scaleItem(hero,1080/hero.w);
        if (!previous) {result=[hero];fit(result,maxW*.94,maxH*.68);}
        else {
          const prev=item(previous,previous.emphasis?175:130);
          const mode=group.seed%3;
          let bw=Math.max(420,hero.w),y=0;
          if(mode===1 && visible.length>=3){
            // A vertical side word, a compact heading, and a dominant new word.
            const head=shelf(older,bw,0,68,'right');result.push(...head.items);y=head.bottom+(older.length?15:0);
            scaleItem(prev,Math.min(1,(hero.h*1.25)/Math.max(1,prev.w)));
            prev.r=-Math.PI/2;prev.x=prev.h/2;prev.y=y+hero.h/2;
            hero.x=prev.h+20+hero.w/2;hero.y=y+hero.h/2;
            result.push(prev,hero);
          } else if(mode===2 && visible.length>=3){
            const head=shelf(older,bw,0,67,'left');result.push(...head.items);y=head.bottom+(older.length?14:0);
            hero.x=hero.w/2;hero.y=y+hero.h/2;
            if(prev.w>bw*.82)scaleItem(prev,bw*.82/prev.w);
            prev.x=bw-prev.w/2;prev.y=y+hero.h+16+prev.h/2;
            result.push(prev,hero);
          } else {
            if(prev.w>bw)scaleItem(prev,bw/prev.w);
            const head=shelf(older,bw,0,62,group.seed%2?'left':'right');result.push(...head.items);y=head.bottom+(older.length?12:0);
            prev.x=(group.seed%2?prev.w/2:bw-prev.w/2);prev.y=y+prev.h/2;y+=prev.h+15;
            hero.x=hero.w/2;hero.y=y+hero.h/2;
            result.push(prev,hero);
          }
          fit(result,maxW,maxH);
        }
      }
      // The common slight tilt rotates the scene; the fit includes its bounds.
      const angle=settings.style==='kinetic' ? ((group.seed%5)-2)*.008*clamp(Number(settings.motion)||0,0,2) : 0;
      if(angle){
        for(const it of result){const x=it.x,y=it.y;it.x=x*Math.cos(angle)-y*Math.sin(angle);it.y=x*Math.sin(angle)+y*Math.cos(angle);it.r+=angle;}
        const b=bound(result),factor=Math.min(1,maxW/b.w,maxH/b.h);
        if(factor<1)for(const it of result){it.x*=factor;it.y*=factor;scaleItem(it,factor);}
      }
      return new Map(result.map(it=>[it.id,it]));
    }
    function build() {
      layoutWidth=canvas.width;layoutHeight=canvas.height;metrics.clear();groups=[];
      const limit=clamp(Math.round(Number(settings.groupSize)||5),2,9);
      let current=null;
      for(let i=0;i<words.length;i++) {
        const w=words[i],last=current?.words[current.words.length-1];
        const split=!current || w.breakBefore || current.words.length>=limit ||
          (last && (w.start-last.end>.58 || (current.words.length>=2 && /[.!?;:]\s*$/.test(last.text))));
        if(split){current={words:[],start:w.start,end:w.end,seed:hash(w.id+':'+w.text+':'+groups.length),stages:[]};groups.push(current);}
        current.words.push(w);current.end=Math.max(current.end,w.end);
      }
      for (const g of groups) for(let n=0;n<g.words.length;n++)g.stages.push(stage(g,n));
    }
    function setProject(input, options={}) {
      settings={...defaults,...options};
      const used=new Set();
      words=(Array.isArray(input)?input:[]).map((w,i)=>{
        let id=String(w.id??i);while(used.has(id))id+='_'+i;used.add(id);
        const text=String(w.text??'').trim();
        return {...w,id,text,display:settings.uppercase?text.toLocaleUpperCase():text,start:Number(w.start),end:Number(w.end)};
      }).filter(w=>w.text&&Number.isFinite(w.start)&&Number.isFinite(w.end)&&w.end>w.start)
        .sort((a,b)=>a.start-b.start);
      build();
    }
    function drawItem(it, alpha=1) {
      if(alpha<=0) return;
      const m=measurement(it.text);
      ctx.save();ctx.translate(it.x,it.y);ctx.rotate(it.r);ctx.globalAlpha=clamp(alpha);
      ctx.font=font(it.size);ctx.textAlign='center';ctx.textBaseline='alphabetic';
      ctx.fillStyle=it.word.emphasis?settings.accent:settings.foreground;
      ctx.fillText(it.text,0,(m.a-m.d)*it.size/200);ctx.restore();
    }
    function drawGroup(g,localIndex,t,alpha=1,exit=0) {
      const motion=clamp(Number(settings.motion)||0,0,2),W=canvas.width,H=canvas.height;
      const word=g.words[localIndex],target=g.stages[localIndex],before=localIndex?g.stages[localIndex-1]:null;
      const next=g.words[localIndex+1];
      const usable=Math.min(word.end-word.start,next?next.start-word.start:Infinity);
      const duration=motion?Math.max(.018,Math.min(.25,usable*.72)):.0001;
      const raw=clamp((t-word.start)/duration),p=ease(raw);
      const entrance=localIndex===0 ? 1-p : 0;
      ctx.save();
      const direction=g.seed%2?1:-1;
      ctx.translate(W/2 + entrance*direction*W*.2*motion-exit*direction*W*.55*motion,H/2+entrance*H*.04*motion);
      const zoom=1-entrance*.24*motion+exit*.22*motion;
      ctx.scale(Math.max(.2,zoom),Math.max(.2,zoom));
      // Motion trails are inexpensive, deterministic exposure samples. The final
      // state remains perfectly sharp, including frame-by-frame seeking.
      const rendered=[];
      for(const [id,to] of target) {
        const from=before?.get(id);
        let it;
        if(from){it={...to,x:mix(from.x,to.x,p),y:mix(from.y,to.y,p),size:mix(from.size,to.size,p),r:mix(from.r,to.r,p)};}
        else{
          const lane=(hash(id)%3)-1;
          it={...to,x:to.x+(1-p)*W*.13*lane*motion,y:to.y+(1-p)*H*.11*motion,
            size:to.size*(1+(1-p)*.32*motion),r:to.r+(1-p)*direction*.13*motion};
        }
        rendered.push({it,from,to,isNew:!from});
      }
      if(settings.style==='kinetic'&&motion>0&&raw<.8&&raw>0){
        for(const {it,from,to} of rendered){
          const dx=(from?from.x-to.x:direction*W*.05)*(1-p)*.16;
          const dy=(from?from.y-to.y:H*.09)*(1-p)*.16;
          for(let j=2;j>=1;j--)drawItem({...it,x:it.x+dx*j,y:it.y+dy*j},alpha*(1-raw)*.09/j);
        }
      }
      // Older words first, new word last: incoming emphasis is never obscured.
      rendered.sort((a,b)=>Number(a.isNew)-Number(b.isNew));
      for(const {it,isNew} of rendered)drawItem(it,alpha*(isNew?.35+.65*smooth(raw*2):1));
      ctx.restore();
    }
    function emptyPoster() {
      const W=canvas.width,H=canvas.height;
      ctx.save();ctx.translate(W/2,H/2);
      const fake=[{id:'poster-1',text:'MAKE IT',display:'MAKE IT'},{id:'poster-2',text:'MOVE.',display:'MOVE.',emphasis:true}];
      const a=item(fake[0],125),b=item(fake[1],275);a.x=-50;a.y=-125;b.x=0;b.y=70;
      const items=fit([a,b],W*.73,H*.52);
      for(const it of items)drawItem(it);
      ctx.restore();
    }
    function render(time) {
      if(canvas.width!==layoutWidth||canvas.height!==layoutHeight)build();
      const t=Number.isFinite(Number(time))?Number(time):0;
      ctx.setTransform(1,0,0,1,0,0);ctx.globalAlpha=1;
      ctx.clearRect(0,0,canvas.width,canvas.height);
      if (!settings.transparent) { ctx.fillStyle=settings.background;ctx.fillRect(0,0,canvas.width,canvas.height); }
      if(!groups.length){emptyPoster();return;}
      // Binary search makes playback cost independent of total lyric length.
      let lo=0,hi=groups.length-1,index=-1;
      while(lo<=hi){const mid=(lo+hi)>>1;if(groups[mid].start<=t){index=mid;lo=mid+1;}else hi=mid-1;}
      if(index<0)return;
      const g=groups[index];let wi=0;
      while(wi+1<g.words.length&&g.words[wi+1].start<=t)wi++;
      const w=g.words[wi],silence=t-w.end;
      if(silence>.36)return;
      const alpha=1-smooth((silence-.18)/.18);
      if(index>0&&wi===0){
        const prev=groups[index-1],elapsed=t-g.start;
        const cross=Math.min(.14,(w.end-w.start)*.4);
        if(cross>0&&elapsed<cross&&g.start-prev.end<.36){
          const ep=ease(elapsed/cross);
          drawGroup(prev,prev.words.length-1,prev.end,(1-ep)*.65,ep);
        }
      }
      drawGroup(g,wi,t,alpha);
    }
    setProject([],{});
    return {setProject,render};
  }
  window.KineticRenderer=Object.freeze({create});
})();
