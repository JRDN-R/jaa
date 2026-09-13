/* Real browser/FFmpeg smoke test. Run with Node + Puppeteer + Chrome + ffprobe.
 * The pinned core is downloaded to work/export-verification only when missing.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { execFileSync } = require('node:child_process');
const puppeteer = require('puppeteer');
const root = path.resolve(__dirname, '..');
const work = path.join(root, 'work/export-verification');
(async () => {
  fs.mkdirSync(work, { recursive: true });
  for (const name of ['ffmpeg-core.js', 'ffmpeg-core.wasm']) {
    const file = path.join(work, name);
    if (!fs.existsSync(file)) {
      const result = await fetch('https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.10/dist/umd/' + name);
      assert.equal(result.ok, true);
      fs.writeFileSync(file, Buffer.from(await result.arrayBuffer()));
    }
  }
  const server = http.createServer((req, res) => {
    if (req.url === '/video-export.js') { res.setHeader('Content-Type', 'text/javascript; charset=utf-8'); res.end(fs.readFileSync(path.join(root, 'video-export.js'))); }
    else { res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.end('<!doctype html><script src="/video-export.js"></script>'); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const browser = await puppeteer.launch({ executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
  try {
    const page = await browser.newPage();
    page.on('console', msg => console.log('browser:', msg.text()));
    page.on('pageerror', error => console.error('browser error:', error.message));
    await page.setRequestInterception(true);
    page.on('request', request => {
      if (request.url().startsWith('https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.10/dist/umd/')) {
        const name = request.url().split('/').pop();
        request.respond({ status: 200, contentType: name.endsWith('.js') ? 'text/javascript' : 'application/wasm', headers: { 'Access-Control-Allow-Origin': '*' }, body: fs.readFileSync(path.join(work, name)) });
      } else request.continue();
    });
    await page.goto('http://127.0.0.1:' + server.address().port); console.log('Browser test page ready');
    for (const test of [{ format: 'webm', width: 1920, height: 1080, duration: 0.5 }, { format: 'mov', width: 1920, height: 1080, duration: 0.5 }, { format: 'webm', width: 3840, height: 2160, duration: 1/24 }, { format: 'mov', width: 3840, height: 2160, duration: 1/24 }]) {
      console.log('Encoding', test);
      const bytes = await page.evaluate(async settings => {
        const canvas = document.createElement('canvas'); canvas.width = settings.width; canvas.height = settings.height;
        const ctx = canvas.getContext('2d', { alpha: true });
        const audioBuffer = new AudioBuffer({ length: Math.ceil(settings.duration * 48000), sampleRate: 48000, numberOfChannels: 2 });
        for (let c=0;c<2;c++) { const pcm = audioBuffer.getChannelData(c); for(let i=0;i<pcm.length;i++) pcm[i]=Math.sin(i/48000*Math.PI*2*440)*0.1; }
        const blob = await LyricVideoExport.exportVideo({ ...settings, canvas, audioBuffer, fps: 24, transparent: true,
          renderFrame: time => { ctx.clearRect(0,0,canvas.width,canvas.height); ctx.fillStyle = '#ff3030'; ctx.fillRect(100+time*200,100,300,150); ctx.fillStyle = 'rgba(255,255,255,0.5)'; ctx.fillRect(500,100,150,150); },
          onProgress: (p, message) => { if(p===1) console.log(message); } });
        return Array.from(new Uint8Array(await blob.arrayBuffer()));
      }, test);
      const name = `alpha-${test.width}.${test.format}`, file = path.join(work, name);
      fs.writeFileSync(file, Buffer.from(bytes));
      const probe = JSON.parse(execFileSync('ffprobe', ['-v','error','-show_streams','-of','json',file]));
      const video = probe.streams.find(s=>s.codec_type==='video'), audio = probe.streams.find(s=>s.codec_type==='audio');
      assert.equal(video.width,test.width); assert.equal(video.height,test.height); assert.ok(audio);
      assert.equal(video.codec_name,test.format==='mov'?'prores':'vp9');
      if(test.format==='mov') { assert.equal(video.profile,'4444'); assert.match(video.pix_fmt,/^yuva/); }
      else assert.equal(video.tags.alpha_mode || video.tags.ALPHA_MODE,'1');
      const args = ['-v','error']; if(test.format==='webm') args.push('-c:v','libvpx-vp9');
      args.push('-i',file,'-vf','alphaextract','-f','rawvideo','-pix_fmt','gray','-');
      const alpha=execFileSync('ffmpeg',args,{maxBuffer:128*1024*1024});
      const frameSize=test.width*test.height, expectedFrames=Math.ceil(test.duration*24-1e-9);
      assert.equal(alpha.length/frameSize,expectedFrames);
      for(let frame=0;frame<expectedFrames;frame++) {
        const offset=frame*frameSize;
        assert.ok(alpha[offset+10*test.width+10]<3,'Transparent background is clear');
        assert.ok(alpha[offset+120*test.width+250]>250,'Opaque text remains opaque');
        assert.ok(Math.abs(alpha[offset+120*test.width+550]-128)<4,'Semitransparency retained');
      }
      console.log('PASS',name,expectedFrames+' frames',audio.codec_name,'real 0/128/255 alpha');
    }
    // A cancellation during frame rendering must end immediately and free the
    // global exporting guard so another export can start.
    const canceled = await page.evaluate(async () => {
      const canvas=document.createElement('canvas');canvas.width=1920;canvas.height=1080;
      const audioBuffer=new AudioBuffer({length:48000,sampleRate:48000,numberOfChannels:1});
      const signal=new AbortController();
      try { await LyricVideoExport.exportVideo({ canvas,audioBuffer,format:'webm',signal:signal.signal,renderFrame:()=>signal.abort() }); }
      catch(e) { return e.name; }
    });
    assert.equal(canceled,'AbortError'); console.log('PASS software export cancellation');
  } finally { await browser.close(); server.close(); }
})().catch(error=>{ console.error(error); process.exitCode=1; });
