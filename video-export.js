/* Lyric video exporter. Requires the embedded unmodified Mediabunny and
 * @mediabunny/aac-encoder 1.56.1 distributions (MPL-2.0).
 * Source: https://github.com/Vanilagy/mediabunny/tree/v1.56.1
 * MOV/WebM additionally download the unmodified @ffmpeg/core 0.12.10 build
 * (GPL-2.0-or-later): https://github.com/ffmpegwasm/ffmpeg.wasm
 * Rendered frames use explicit timestamps, never a real-time screen recorder.
 */
(() => {
  'use strict';
  const FPS = 24, FRAME_RATES = [24, 30, 50, 60], AUDIO_RATE = 48000;
  const FORMATS = Object.freeze({ mp4: { label: 'MP4', mimeType: 'video/mp4', extension: '.mp4' },
    webm: { label: 'WebM VP9', mimeType: 'video/webm', extension: '.webm' },
    mov: { label: 'MOV ProRes 4444', mimeType: 'video/quicktime', extension: '.mov' } });
  const CORE_BASE = 'https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.10/dist/umd/';
  const DIMENSIONS = [[1920,1080],[1080,1080],[1080,1920],[3840,2160],[2160,2160],[2160,3840]];
  const isMobileDevice = () => !!(globalThis.navigator?.userAgentData?.mobile ||
    /Android|iPhone|iPad|iPod/i.test(globalThis.navigator?.userAgent || '') ||
    (/Mac/i.test(globalThis.navigator?.platform || '') && globalThis.navigator?.maxTouchPoints > 1));
  function validateSettings({ width, height, fps, format = 'mp4', transparent = false }) {
    if (!FORMATS[format]) return 'Choose MP4, WebM VP9, or MOV ProRes 4444.';
    if (!DIMENSIONS.some(([w,h]) => w === width && h === height)) return 'Choose a 1080p or 4K export size.';
    if (!FRAME_RATES.includes(fps)) return 'Choose 24, 30, 50, or 60 frames per second.';
    if (isMobileDevice() && (Math.max(width, height) > 1920 || fps > 30)) return 'Mobile exports support 1080p at 24 or 30 fps. Use a computer for 4K, 50 fps, or 60 fps.';
    if (format === 'mp4' && transparent) return 'MP4 cannot preserve transparency. Choose WebM VP9 or MOV ProRes 4444.';
    return null;
  }
  // H.264 levels constrain both picture size and macroblocks per second.
  function avcLevel(width, height, fps) {
    const blocks = Math.ceil(width / 16) * Math.ceil(height / 16);
    return blocks <= 8192 && blocks * fps <= 245760 ? '28'
      : blocks <= 8704 && blocks * fps <= 522240 ? '2a'
      : blocks <= 36864 && blocks * fps <= 983040 ? '33' : '34';
  }
  let aacRegistered = false, exporting = false;
  const abortError = () => new DOMException('Video export canceled.', 'AbortError');
  const check = signal => { if (signal?.aborted) throw abortError(); };
  const yieldUI = () => new Promise(resolve => setTimeout(resolve, 0));

  async function capabilities({ width = 1920, height = 1080, fps = FPS, channels = 2, format = 'mp4', transparent = false } = {}) {
    const unavailable = reason => ({ supported: false, reason });
    const invalid = validateSettings({ width, height, fps, format, transparent });
    if (invalid) return unavailable(invalid);
    if (format !== 'mp4') {
      if (!globalThis.WebAssembly || !globalThis.Worker || !globalThis.Blob || !globalThis.fetch) return unavailable('This browser cannot load the video encoder. Use a current full browser.');
      return { supported: true, width, height, fps, format, transparent, requiresDownload: true,
        reason: `${FORMATS[format].label}${transparent ? ' with transparency' : ''} uses an additional 31 MB encoder download. Encoding can take longer than playback; keep this page open.` };
    }
    if (!globalThis.Mediabunny) return unavailable('The MP4 encoder is missing. Reload the app and try again.');
    if (!globalThis.VideoEncoder || !globalThis.VideoFrame) {
      return unavailable('This browser cannot export frame-by-frame MP4 video. Open the app in a current Chrome, Edge, or Safari browser. If this is an HTTP page, use HTTPS or localhost.');
    }
    const bitrate = Math.round(10000000 * width * height / (1920 * 1080) * Math.max(1, fps / 30));
    const level = avcLevel(width, height, fps);
    let videoConfig;
    for (const codec of ['avc1.6400' + level, 'avc1.4200' + level]) {
      const config = { codec, width, height, framerate: fps, bitrate,
        hardwareAcceleration: 'no-preference', latencyMode: 'realtime', avc: { format: 'avc' } };
      try { if ((await VideoEncoder.isConfigSupported(config)).supported) { videoConfig = config; break; } }
      catch { /* Try another AVC profile. */ }
    }
    if (!videoConfig) return unavailable(`This device cannot encode ${width} × ${height} at ${fps} fps. Try a lower frame rate or another browser with H.264 encoding support.`);
    let nativeAac = false;
    if (globalThis.AudioEncoder) {
      try { nativeAac = !!(await AudioEncoder.isConfigSupported({ codec: 'mp4a.40.2',
        sampleRate: AUDIO_RATE, numberOfChannels: Math.min(channels, 2), bitrate: channels === 1 ? 128000 : 192000 })).supported; }
      catch { /* The bundled AAC encoder supplies this codec. */ }
    }
    const fallbackAvailable = !!(globalThis.MediabunnyAacEncoder && globalThis.WebAssembly && globalThis.Worker);
    if (!nativeAac && !fallbackAvailable) return unavailable('AAC audio encoding is unavailable in this browser. Reload the app in a current Chrome, Edge, or Safari browser.');
    return { supported: true, width, height, fps, bitrate, videoConfig,
      nativeAac: nativeAac && !aacRegistered, useWasmAac: aacRegistered || !nativeAac,
      reason: `Ready for ${width} × ${height} MP4 export at ${fps} fps.` };
  }

  async function exportMP4(options = {}) {
    const { canvas, audioBuffer, renderFrame, signal, onProgress = () => {}, fps = FPS } = options;
    const duration = options.duration ?? audioBuffer?.duration;
    if (exporting) throw new Error('A video export is already running.');
    if (!audioBuffer?.length || typeof renderFrame !== 'function') throw new TypeError('Load an audio file and provide a frame renderer before exporting.');
    const invalid = validateSettings({ width: canvas?.width, height: canvas?.height, fps, format: 'mp4', transparent: options.transparent });
    if (invalid) throw new Error(invalid);
    if (!(duration > 0) || !Number.isFinite(duration)) throw new Error('The video duration must be a positive number of seconds.');
    check(signal);
    exporting = true;
    let output, video, audio, cancelPromise, abortReject, wake, finished = false;
    const aborted = new Promise((_, reject) => { abortReject = reject; });
    aborted.catch(() => {});
    const cancel = () => cancelPromise ||= output ? output.cancel().catch(() => {}) : Promise.resolve();
    const onAbort = () => { abortReject(abortError()); void cancel(); };
    signal?.addEventListener('abort', onAbort, { once: true });
    const wait = async work => {
      let timer;
      const stalled = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('The video encoder stopped responding. Try exporting again, or use a shorter audio file.')), 60000); });
      try { return await Promise.race([work, aborted, stalled]); }
      finally { clearTimeout(timer); }
    };
    try {
      const capability = await wait(capabilities({ width: canvas.width, height: canvas.height, fps, channels: audioBuffer.numberOfChannels }));
      check(signal);
      if (!capability.supported) throw new Error(capability.reason);
      if (capability.useWasmAac && !aacRegistered) { MediabunnyAacEncoder.registerAacEncoder(); aacRegistered = true; }
      if (navigator.wakeLock?.request) {
        navigator.wakeLock.request('screen').then(lock => {
          if (finished || signal?.aborted) lock.release().catch(() => {}); else wake = lock;
        }).catch(() => {});
      }
      const { Output, Mp4OutputFormat, BufferTarget, CanvasSource, AudioSampleSource, AudioSample, Quality } = Mediabunny;
      const target = new BufferTarget();
      output = new Output({ format: new Mp4OutputFormat({ fastStart: 'in-memory' }), target });
      video = new CanvasSource(canvas, { codec: 'avc', fullCodecString: capability.videoConfig.codec,
        quality: new Quality({ bitrate: capability.bitrate }), latencyMode: 'realtime',
        hardwareAcceleration: 'no-preference', keyFrameInterval: 2, contentHint: 'text' });
      // AAC has 1024 samples of encoder priming in this pinned WASM encoder.
      // A negative first timestamp writes an MP4 edit list that removes priming.
      audio = new AudioSampleSource({ codec: 'aac',
        quality: new Quality({ bitrate: audioBuffer.numberOfChannels === 1 ? 128000 : 192000 }),
        transform: { numberOfChannels: Math.min(audioBuffer.numberOfChannels, 2), sampleRate: AUDIO_RATE },
        onEncodedPacket(packet) {
          if (capability.useWasmAac) packet.timestamp -= 1024 / AUDIO_RATE;
          packet.duration = Math.max(0, Math.min(packet.duration, duration - packet.timestamp));
        } });
      output.addVideoTrack(video, { frameRate: fps });
      output.addAudioTrack(audio);
      onProgress(0, `Preparing ${canvas.width} × ${canvas.height} MP4…`);
      await wait(output.start());
      const sampleRate = audioBuffer.sampleRate, channels = audioBuffer.numberOfChannels;
      const planes = Array.from({ length: channels }, (_, channel) => audioBuffer.getChannelData(channel));
      const totalAudioSamples = Math.max(1, Math.round(duration * sampleRate));
      // Every output frame, including the final frame, lasts exactly 1 / fps s.
      // The video may finish less than one frame after the audio ends.
      const totalFrames = Math.max(1, Math.ceil(duration * fps - 1e-9));
      const chunkLength = Math.max(1024, Math.round(sampleRate / 2));
      let audioIndex = 0, frameIndex = 0, lastYield = performance.now();
      while (audioIndex < totalAudioSamples || frameIndex < totalFrames) {
        check(signal);
        if (audioIndex < totalAudioSamples) {
          const end = Math.min(totalAudioSamples, audioIndex + chunkLength);
          const length = end - audioIndex, data = new Float32Array(length * channels);
          // Samples beyond the uploaded audio are silence, if a longer duration was requested.
          for (let channel = 0; channel < channels; channel++) {
            if (audioIndex < audioBuffer.length) data.set(planes[channel].subarray(audioIndex, Math.min(end, audioBuffer.length)), channel * length);
          }
          const sample = new AudioSample({ format: 'f32-planar', data, sampleRate,
            numberOfChannels: channels, timestamp: audioIndex / sampleRate });
          try { await wait(audio.add(sample)); } finally { sample.close(); }
          audioIndex = end;
        }
        const throughTime = audioIndex / sampleRate;
        while (frameIndex < totalFrames && (frameIndex / fps < throughTime + 1e-9 || audioIndex >= totalAudioSamples)) {
          check(signal);
          const time = frameIndex / fps;
          await wait(Promise.resolve(renderFrame(time)));
          check(signal);
          await wait(video.add(time, 1 / fps));
          frameIndex++;
          onProgress(0.02 + 0.94 * frameIndex / totalFrames, 'Rendering frame ' + frameIndex + ' of ' + totalFrames + '…');
          if (performance.now() - lastYield > 30) { await yieldUI(); lastYield = performance.now(); }
        }
      }
      video.close(); audio.close();
      onProgress(0.97, 'Finishing MP4…');
      await wait(output.finalize());
      check(signal);
      if (!target.buffer || target.buffer.byteLength < 256) throw new Error('The video encoder returned an empty file.');
      const blob = new Blob([target.buffer], { type: 'video/mp4' });
      onProgress(1, 'MP4 ready.');
      return blob;
    } catch (error) {
      await Promise.race([cancel(), new Promise(resolve => setTimeout(resolve, 1000))]);
      if (signal?.aborted) throw abortError();
      throw error;
    } finally {
      finished = true;
      signal?.removeEventListener('abort', onAbort);
      if (wake) await wake.release().catch(() => {});
      exporting = false;
    }
  }
  // Runs off the main thread. The pinned single-thread core works on GitHub
  // Pages without SharedArrayBuffer, COOP, or COEP headers. PNG inputs keep the
  // original alpha; native WebCodecs encoders are never assumed to retain it.
  function softwareWorker() {
    let core, coreOptions, settings, logs = [], segments = [], encodedBytes = 0;
    const loadCore = async () => {
      core = await createFFmpegCore({ ...coreOptions });
      core.setLogger(({ message }) => { logs.push(message); if (logs.length > 300) logs.shift(); });
      for (const path of ['/frames', '/inputs']) core.FS.mkdir(path);
    };
    const remove = path => { try { core.FS.unlink(path); } catch {} };
    const execute = args => {
      logs = [];
      core.reset();
      core.setTimeout(600000);
      let code;
      try { code = core.exec('-hide_banner', '-loglevel', 'warning', ...args); }
      catch (error) { throw new Error((error?.message || 'Video encoding failed.') + ' ' + logs.slice(-6).join(' ')); }
      if (code !== 0) throw new Error('Video encoding failed. ' + logs.slice(-6).join(' '));
    };
    const mount = (path, blobs) => core.FS.mount(core.FS.filesystems.WORKERFS, { blobs }, path);
    self.onmessage = async event => {
      const { id, type, ...data } = event.data;
      try {
        if (type === 'init') {
          importScripts(data.coreURL);
          coreOptions = { mainScriptUrlOrBlob: data.coreURL + '#' + btoa(JSON.stringify({ wasmURL: data.wasmURL })) };
          await loadCore();
          settings = data.settings;
          core.exec('-hide_banner', '-encoders');
          const required = settings.format === 'mov' ? ['prores_ks', 'pcm_s16le'] : ['libvpx-vp9', 'libvorbis'];
          if (!required.every(name => logs.some(line => line.includes(name)))) throw new Error('The downloaded encoder is missing a required video or audio codec.');
          self.postMessage({ id });
        } else if (type === 'batch') {
          const { fps, format, transparent, maxBytes } = settings;
          const filename = '/segment.' + format;
          const frameNames = data.frames.map((blob, i) => ({ name: String(i).padStart(6, '0') + '.png', data: blob }));
          try {
            core.setProgress(({ progress }) => self.postMessage({ id, progress: Math.max(0, Math.min(1, progress || 0)) }));
            mount('/frames', frameNames);
            // The pinned libvpx build corrupts inter-frame VP9 alpha references
            // (ffmpeg.wasm #786). Independent keyframes preserve genuine alpha
            // and avoid that path; opaque WebM keeps inter-frame compression.
            const videoArgs = format === 'mov'
              ? ['-c:v', 'prores_ks', '-profile:v', '4', '-pix_fmt', 'yuva444p10le', '-alpha_bits', '16', '-qscale:v', '4', '-video_track_timescale', String(fps * 1000)]
              : ['-c:v', 'libvpx-vp9', '-pix_fmt', transparent ? 'yuva420p' : 'yuv420p', '-crf', '18', '-b:v', '0', '-deadline', 'good', '-cpu-used', '4', '-lag-in-frames', '0', '-auto-alt-ref', '0', '-g', transparent ? '1' : String(fps)];
            execute(['-framerate', String(fps), '-i', '/frames/%06d.png', '-an', '-frames:v', String(data.frames.length), ...videoArgs, '-threads', '1', filename]);
            const size = core.FS.stat(filename).size;
            if (encodedBytes + size > maxBytes) throw new Error('This export exceeds this device’s video memory budget. Choose 1080p, a lower frame rate, WebM, or a shorter recording.');
            const bytes = core.FS.readFile(filename);
            // Blob-backed WORKERFS reads segments on demand when muxing. Delete
            // the writable copy after every batch; never keep every raw frame.
            segments.push({ name: 'segment-' + segments.length + '.' + format, data: new Blob([bytes]), duration: data.frames.length / fps });
            encodedBytes += size;
            self.postMessage({ id, encodedBytes });
          } finally {
            core.FS.unmount('/frames');
            remove(filename);
          }
        } else if (type === 'finish') {
          const { format, fps, duration, maxBytes } = settings;
          const filename = '/finished.' + format;
          // Release video-encoder state before the final mux. Only the segment
          // blobs are needed for this pass; no frames need to be encoded again.
          await loadCore();
          try {
            core.setProgress(({ progress }) => self.postMessage({ id, progress: Math.max(0, Math.min(1, progress || 0)) }));
            mount('/inputs', [...segments, { name: 'audio.wav', data: data.audio }]);
            core.FS.writeFile('/segments.txt', segments.map(segment => "file '/inputs/" + segment.name + "'\nduration " + segment.duration.toFixed(12) + '\n').join(''));
            const audioArgs = format === 'mov'
              ? ['-c:a', 'pcm_s16le', '-video_track_timescale', String(fps * 1000)]
              : ['-c:a', 'libvorbis', '-q:a', '6'];
            execute(['-f', 'concat', '-safe', '0', '-i', '/segments.txt', '-i', '/inputs/audio.wav', '-map', '0:v:0', '-map', '1:a:0', '-c:v', 'copy', ...audioArgs, '-af', 'apad', '-t', String(duration), '-threads', '1', filename]);
            if (core.FS.stat(filename).size > maxBytes) throw new Error('The finished video is too large for this device. Choose WebM, 1080p, or a shorter recording.');
            const bytes = core.FS.readFile(filename);
            if (bytes.length < 256) throw new Error('The video encoder returned an empty file.');
            self.postMessage({ id, blob: new Blob([bytes], { type: format === 'mov' ? 'video/quicktime' : 'video/webm' }) });
          } finally {
            core.FS.unmount('/inputs');
            remove(filename); remove('/segments.txt'); segments = [];
          }
        }
      } catch (error) {
        const message = error?.message || 'Video encoding failed. Try a smaller or shorter export.';
        self.postMessage({ id, error: /memory access|out of memory|allocation failed|unreachable/i.test(message)
          ? 'The video encoder could not complete this export on this device. Choose 1080p, a lower frame rate, or a shorter recording and try again.' : message });
      }
    };
  }

  async function pcmWave(audioBuffer, duration, signal) {
    const channels = Math.min(audioBuffer.numberOfChannels, 2), rate = audioBuffer.sampleRate;
    const length = Math.max(1, Math.round(duration * rate)), byteLength = length * channels * 2;
    if (byteLength > 512 * 1024 * 1024) throw new Error('This recording is too long for an in-browser video export.');
    const header = new ArrayBuffer(44), view = new DataView(header);
    const string = (offset, value) => { for (let i = 0; i < value.length; i++) view.setUint8(offset + i, value.charCodeAt(i)); };
    string(0, 'RIFF'); view.setUint32(4, 36 + byteLength, true); string(8, 'WAVE'); string(12, 'fmt ');
    view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, channels, true);
    view.setUint32(24, rate, true); view.setUint32(28, rate * channels * 2, true);
    view.setUint16(32, channels * 2, true); view.setUint16(34, 16, true); string(36, 'data'); view.setUint32(40, byteLength, true);
    const parts = [header], planes = Array.from({ length: channels }, (_, c) => audioBuffer.getChannelData(c));
    for (let start = 0; start < length; start += rate) {
      check(signal);
      const count = Math.min(rate, length - start), chunk = new ArrayBuffer(count * channels * 2), values = new DataView(chunk);
      for (let i = 0; i < count; i++) for (let c = 0; c < channels; c++) {
        const value = Math.max(-1, Math.min(1, planes[c][start + i] || 0));
        values.setInt16((i * channels + c) * 2, Math.round(value * (value < 0 ? 32768 : 32767)), true);
      }
      parts.push(chunk);
      await yieldUI();
    }
    return new Blob(parts, { type: 'audio/wav' });
  }

  async function exportSoftware(options) {
    const { canvas, audioBuffer, renderFrame, signal, onProgress = () => {}, fps = FPS, format, transparent = false } = options;
    const duration = options.duration ?? audioBuffer?.duration;
    if (exporting) throw new Error('A video export is already running.');
    if (!audioBuffer?.length || typeof renderFrame !== 'function') throw new TypeError('Load an audio file and provide a frame renderer before exporting.');
    const invalid = validateSettings({ width: canvas?.width, height: canvas?.height, fps, format, transparent });
    if (invalid) throw new Error(invalid);
    if (!(duration > 0) || !Number.isFinite(duration)) throw new Error('The video duration must be a positive number of seconds.');
    if (transparent && canvas.getContext('2d')?.getContextAttributes?.().alpha === false) throw new Error('Transparent export needs a canvas with transparency enabled.');
    check(signal);
    exporting = true;
    const urls = [], controller = new AbortController(), pending = new Map();
    let worker, serial = 0, wake, finished = false, timer;
    const cancel = () => { controller.abort(); worker?.terminate(); for (const { reject } of pending.values()) reject(abortError()); pending.clear(); };
    signal?.addEventListener('abort', cancel, { once: true });
    const wait = async (work, timeout = 600000) => {
      let timeoutID, abort;
      try {
        return await Promise.race([work, new Promise((_, reject) => {
          abort = () => reject(abortError());
          controller.signal.addEventListener('abort', abort, { once: true });
          timeoutID = setTimeout(() => reject(new Error('The video encoder stopped responding. Try a smaller or shorter export.')), timeout);
        })]);
      } finally { clearTimeout(timeoutID); controller.signal.removeEventListener('abort', abort); }
    };
    const request = (type, data, progress) => wait(new Promise((resolve, reject) => {
      check(signal);
      const id = ++serial;
      pending.set(id, { resolve, reject, progress });
      worker.postMessage({ id, type, ...data });
    }));
    try {
      const capability = await capabilities({ width: canvas.width, height: canvas.height, fps, format, transparent });
      if (!capability.supported) throw new Error(capability.reason);
      if (navigator.wakeLock?.request) navigator.wakeLock.request('screen').then(lock => {
        if (finished || signal?.aborted) lock.release().catch(() => {}); else wake = lock;
      }).catch(() => {});
      onProgress(0, 'Loading additional video encoder, about 31 MB…');
      timer = setTimeout(() => controller.abort(), 120000);
      const blobs = await Promise.all(['ffmpeg-core.js', 'ffmpeg-core.wasm'].map(async name => {
        const response = await fetch(CORE_BASE + name, { signal: controller.signal });
        if (!response.ok) throw new Error('The additional encoder could not download. Check your connection and try again.');
        return new Blob([await response.arrayBuffer()], { type: name.endsWith('.js') ? 'text/javascript' : 'application/wasm' });
      }));
      clearTimeout(timer); check(signal);
      for (const blob of blobs) urls.push(URL.createObjectURL(blob));
      const workerURL = URL.createObjectURL(new Blob(['(' + softwareWorker.toString() + ')()'], { type: 'text/javascript' }));
      urls.push(workerURL); worker = new Worker(workerURL);
      worker.onmessage = event => {
        const { id, progress, error, ...value } = event.data, task = pending.get(id);
        if (!task) return;
        if (progress !== undefined) { task.progress?.(progress); return; }
        pending.delete(id); error ? task.reject(new Error(error)) : task.resolve(value);
      };
      worker.onerror = event => {
        for (const { reject } of pending.values()) reject(new Error(event.message || 'The video encoder ran out of memory. Try a smaller or shorter export.'));
        pending.clear();
      };
      const mobile = isMobileDevice(), maxBytes = (mobile ? 128 : 512) * 1024 * 1024;
      await request('init', { coreURL: urls[0], wasmURL: urls[1], settings: { format, fps, duration, transparent, maxBytes } });
      onProgress(0.02, 'Preparing audio…');
      const audio = await wait(pcmWave(audioBuffer, duration, signal));
      const totalFrames = Math.max(1, Math.ceil(duration * fps - 1e-9));
      // At most one second and at most 32 MiB (mobile) / 64 MiB of
      // estimated raw image data per batch; highly compressible PNGs are held
      // as Blobs. The encoder can free frame inputs between every batch.
      const batchFrames = Math.max(1, Math.min(fps, Math.floor((mobile ? 32 : 64) * 1024 * 1024 / (canvas.width * canvas.height * 4))));
      for (let start = 0; start < totalFrames; start += batchFrames) {
        check(signal);
        const end = Math.min(totalFrames, start + batchFrames), frames = [];
        for (let index = start; index < end; index++) {
          await wait(Promise.resolve(renderFrame(index / fps))); check(signal);
          const frame = canvas.convertToBlob ? await wait(canvas.convertToBlob({ type: 'image/png' }))
            : await wait(new Promise((resolve, reject) => canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error('A video frame could not be rendered.')), 'image/png')));
          frames.push(frame);
          onProgress(0.04 + 0.90 * (start + (index - start + 1) * 0.2) / totalFrames, `Rendering frame ${index + 1} of ${totalFrames}…`);
          await yieldUI();
        }
        const encodeProgress = value => onProgress(0.04 + 0.90 * (start + (end - start) * (0.2 + 0.8 * value)) / totalFrames, `Encoding frames ${start + 1}–${end} of ${totalFrames}…`);
        encodeProgress(0);
        await request('batch', { frames }, encodeProgress);
        onProgress(0.04 + 0.90 * end / totalFrames, `Encoded ${end} of ${totalFrames} frames…`);
      }
      onProgress(0.95, 'Joining video and audio…');
      const result = await request('finish', { audio }, value => onProgress(0.95 + 0.04 * value, 'Joining video and audio…'));
      check(signal);
      onProgress(1, FORMATS[format].label + ' ready.');
      return result.blob;
    } catch (error) {
      if (signal?.aborted) throw abortError();
      if (controller.signal.aborted) throw new Error('The additional encoder download timed out. Check your connection and try again.');
      throw error;
    } finally {
      finished = true; clearTimeout(timer);
      signal?.removeEventListener('abort', cancel); cancel();
      urls.forEach(url => URL.revokeObjectURL(url));
      if (wake) await wake.release().catch(() => {});
      exporting = false;
    }
  }

  function exportVideo(options = {}) {
    const format = options.format || 'mp4';
    return format === 'mp4' ? exportMP4(options) : exportSoftware({ ...options, format });
  }
  globalThis.LyricVideoExport = Object.freeze({ exportMP4, exportVideo, capabilities, isMobileDevice, formats: FORMATS });
})();
