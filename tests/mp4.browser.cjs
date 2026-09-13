const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),http=require('node:http'),{execFileSync}=require('node:child_process'),puppeteer=require('puppeteer');
const root=path.resolve(__dirname,'..');
const server=http.createServer((req,res)=>{const pathname=new URL(req.url,'http://localhost').pathname,file=path.join(root,pathname==='/'?'index.html':pathname);fs.readFile(file,(err,data)=>{if(err){res.writeHead(404).end();return;}res.setHeader('Content-Type',file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':'text/html');res.end(data);});});
(async()=>{
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const browser=await puppeteer.launch({headless:true,executablePath:process.env.CHROME_PATH||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'});
 try{
  const page=await browser.newPage();await page.goto('http://127.0.0.1:'+server.address().port);fs.mkdirSync(path.join(root,'work/mp4-verification'),{recursive:true});
  for(const config of [{width:1920,height:1080,fps:24},{width:3840,height:2160,fps:60},{width:2160,height:3840,fps:50}]){
   const data=await page.evaluate(async config=>{
    const canvas=document.createElement('canvas');canvas.width=config.width;canvas.height=config.height;
    const audioBuffer=new AudioBuffer({length:12000,sampleRate:48000,numberOfChannels:1});
    for(let i=0;i<audioBuffer.length;i++)audioBuffer.getChannelData(0)[i]=Math.sin(i*2*Math.PI*440/48000)*.1;
    const renderer=KineticRenderer.create(canvas);renderer.setProject([{id:'a',text:'Export',start:0,end:.25}],{style:'spotlight',motion:0});
    const blob=await LyricVideoExport.exportVideo({canvas,audioBuffer,format:'mp4',fps:config.fps,renderFrame:t=>renderer.render(t)});
    return Array.from(new Uint8Array(await blob.arrayBuffer()));
   },config);
   const file=path.join(root,`work/mp4-verification/${config.width}x${config.height}-${config.fps}.mp4`);fs.writeFileSync(file,Buffer.from(data));
   const probe=JSON.parse(execFileSync('ffprobe',['-v','error','-show_streams','-of','json',file]));
   const video=probe.streams.find(s=>s.codec_type==='video'),audio=probe.streams.find(s=>s.codec_type==='audio');
   assert.equal(video.width,config.width);assert.equal(video.height,config.height);assert.equal(video.codec_name,'h264');assert.equal(video.r_frame_rate,`${config.fps}/1`);assert.equal(audio.codec_name,'aac');assert.equal(Number(video.nb_frames),Math.ceil(.25*config.fps));
   console.log(`PASS MP4 ${video.width}x${video.height} ${config.fps} fps: ${video.nb_frames} frames, AAC audio`);
  }
 }finally{await browser.close();server.close();}
})().catch(error=>{console.error(error);server.close();process.exitCode=1;});
