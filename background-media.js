/* Uploaded backgrounds stay local. A video shares the audio clock in preview
   and is explicitly sought before each encoded frame. */
(() => {
  'use strict';
  const LOAD_TIMEOUT = 30000, SEEK_TIMEOUT = 15000;
  const imageExtensions = { png:'png', jpg:'jpeg', jpeg:'jpeg', jfif:'jpeg', webp:'webp', gif:'gif', avif:'avif', bmp:'bmp', svg:'svg+xml', ico:'x-icon', apng:'apng', tif:'tiff', tiff:'tiff' };
  const videoExtensions = { mp4:'mp4', m4v:'mp4', webm:'webm', mov:'quicktime', ogv:'ogg', mpg:'mpeg', mpeg:'mpeg', '3gp':'3gpp', '3g2':'3gpp2', mkv:'x-matroska', avi:'x-msvideo' };
  const abortError = () => new DOMException('Background media loading canceled.', 'AbortError');
  const check = signal => { if (signal?.aborted) throw abortError(); };
  function mediaType(file) {
    let mime = String(file?.type || '').trim().toLowerCase().split(';')[0];
    if (!mime) {
      const extension = String(file?.name || '').toLowerCase().split('.').pop();
      if (imageExtensions[extension]) mime = 'image/' + imageExtensions[extension];
      else if (videoExtensions[extension]) mime = 'video/' + videoExtensions[extension];
    }
    const type = mime.startsWith('image/') ? 'image' : mime.startsWith('video/') ? 'video' : null;
    if (!type) throw new Error('Choose an image or video file for the background.');
    return { mime, type };
  }
  function waitForMedia(source, { events, ready, start = () => {}, signal, timeout, message, registerCancel }) {
    return new Promise((resolve, reject) => {
      let timer, finished = false;
      const clean = () => {
        clearTimeout(timer);
        for (const event of events) source.removeEventListener(event, test);
        source.removeEventListener('error', failed);
        signal?.removeEventListener('abort', aborted);
        registerCancel?.(null);
      };
      const finish = error => {
        if (finished) return;
        finished = true; clean();
        if (error) reject(error); else resolve();
      };
      const test = () => { if (ready()) finish(); };
      const failed = () => finish(new Error(message));
      const aborted = () => finish(abortError());
      for (const event of events) source.addEventListener(event, test);
      source.addEventListener('error', failed);
      signal?.addEventListener('abort', aborted, { once:true });
      registerCancel?.(aborted);
      timer = setTimeout(() => finish(new Error(message + ' The media took too long to respond.')), timeout);
      if (signal?.aborted) { aborted(); return; }
      try { start(); test(); } catch (error) { finish(error); }
    });
  }
  async function prepare(file, signal) {
    check(signal);
    if (!(file instanceof Blob) || !file.size) throw new Error('Choose a nonempty image or video file.');
    const { mime, type } = mediaType(file);
    const name = String(file.name || (type === 'image' ? 'Background image' : 'Background video'));
    // Empty MIME types occur on some platforms. Preserve a useful MIME type in
    // the saved project as well as in the object URL used by the browser.
    const normalizedFile = file.type === mime && file.name ? file : new File([file], name, { type:mime, lastModified:file.lastModified || Date.now() });
    const url = URL.createObjectURL(normalizedFile);
    const source = type === 'image' ? new Image() : document.createElement('video');
    let disposed = false, cancelLoad = null, cancelSeek = null, frameRequest = null;
    let preview = null, playPending = false, playBlocked = false, exactSeek = false;
    const emit = () => { if (!disposed && typeof entry.onFrame === 'function') entry.onFrame(); };
    const stopFrameLoop = () => {
      if (frameRequest !== null && source.cancelVideoFrameCallback) source.cancelVideoFrameCallback(frameRequest);
      frameRequest = null;
    };
    const startFrameLoop = () => {
      if (disposed || type !== 'video' || !source.requestVideoFrameCallback || frameRequest !== null || !preview?.playing || exactSeek) return;
      frameRequest = source.requestVideoFrameCallback(() => {
        frameRequest = null; emit(); startFrameLoop();
      });
    };
    const localTime = time => {
      const safe = Number.isFinite(Number(time)) ? Math.max(0, Number(time)) : 0;
      return source.duration > 0 && Number.isFinite(source.duration) ? safe % source.duration : 0;
    };
    const syncPreview = () => {
      if (disposed || type !== 'video' || !preview || exactSeek) return;
      const { target, playing, rate } = preview;
      if (source.playbackRate !== rate) { try { source.playbackRate = rate; } catch { /* Browser-specific rate limits. */ } }
      if (!playing) { source.pause(); stopFrameLoop(); }
      // While a seek is pending, remember the newest target without starting a
      // new decode on every animation frame. seeked applies the final target.
      if (!source.seeking && Math.abs(source.currentTime - target) > (playing ? .18 : .001)) {
        try { source.currentTime = target; } catch { /* A subsequent sync can retry after decoding. */ }
      }
      if (playing && source.paused && !playPending && !playBlocked) {
        playPending = true;
        Promise.resolve(source.play()).catch(() => { playBlocked = true; }).finally(() => {
          playPending = false;
          if (disposed || !preview?.playing || exactSeek) source.pause();
        });
      }
      startFrameLoop();
    };
    const onSeeked = () => { syncPreview(); emit(); };
    const onTimeUpdate = () => emit();
    const entry = {
      source, file:normalizedFile, name, type, onFrame:null,
      dispose() {
        if (disposed) return;
        disposed = true; preview = null;
        cancelLoad?.(); cancelSeek?.(); stopFrameLoop();
        source.removeEventListener('seeked', onSeeked);
        source.removeEventListener('timeupdate', onTimeUpdate);
        if (type === 'video') {
          source.pause(); source.removeAttribute('src'); source.load();
        } else source.removeAttribute('src');
        URL.revokeObjectURL(url);
        entry.onFrame = null;
      },
      sync(time, playing, rate = 1) {
        if (disposed || type !== 'video' || exactSeek) return;
        const shouldPlay = !!playing;
        if (!shouldPlay || !preview?.playing) playBlocked = false;
        const speed = Number(rate);
        preview = { target:localTime(time), playing:shouldPlay, rate:Number.isFinite(speed) && speed > 0 ? Math.max(.0625, Math.min(16, speed)) : 1 };
        syncPreview();
      },
      async seek(time, seekSignal) {
        check(seekSignal);
        if (disposed) throw new Error('This background has been removed.');
        if (type !== 'video') return;
        if (exactSeek) throw new Error('A background frame is already being prepared.');
        exactSeek = true; preview = null; source.pause(); stopFrameLoop();
        const target = localTime(time);
        try {
          await waitForMedia(source, {
            events:['seeked', 'loadeddata', 'canplay'],
            ready:() => !source.seeking && source.readyState >= 2 && Math.abs(source.currentTime - target) < .0001,
            start:() => {
              if (source.seeking || Math.abs(source.currentTime - target) >= .0001) source.currentTime = target;
            },
            signal:seekSignal, timeout:SEEK_TIMEOUT,
            message:'The background video could not decode this frame. Try a different video.',
            registerCancel:cancel => { cancelSeek = cancel; }
          });
          check(seekSignal);
        } finally { exactSeek = false; }
      }
    };
    try {
      if (type === 'video') {
        source.preload = 'auto'; source.muted = true; source.defaultMuted = true;
        source.playsInline = true; source.loop = true;
        source.setAttribute('playsinline', ''); source.setAttribute('muted', '');
        await waitForMedia(source, {
          events:['loadedmetadata', 'loadeddata', 'canplay'],
          ready:() => source.readyState >= 2 && source.videoWidth > 0 && source.videoHeight > 0 && Number.isFinite(source.duration) && source.duration > 0,
          start:() => { source.src = url; source.load(); },
          signal, timeout:LOAD_TIMEOUT,
          message:'This video could not be opened. Try an MP4 or WebM supported by your browser.',
          registerCancel:cancel => { cancelLoad = cancel; }
        });
        source.addEventListener('seeked', onSeeked);
        source.addEventListener('timeupdate', onTimeUpdate);
      } else {
        await waitForMedia(source, {
          events:['load'], ready:() => source.complete && source.naturalWidth > 0 && source.naturalHeight > 0,
          start:() => { source.src = url; }, signal, timeout:LOAD_TIMEOUT,
          message:'This image could not be opened. Try a PNG, JPEG, WebP, or another image supported by your browser.',
          registerCancel:cancel => { cancelLoad = cancel; }
        });
      }
      check(signal);
      return entry;
    } catch (error) { entry.dispose(); throw error; }
  }
  async function prepareProject(record, signal) {
    check(signal);
    // Lightweight browser drafts retain framing but ask the user to reselect
    // the original media. Downloaded project files embed the complete file.
    if (!record || record.dataURL == null || record.dataURL === '') return null;
    if (typeof record.dataURL !== 'string') throw new Error('The saved background media is invalid.');
    const comma = record.dataURL.indexOf(',');
    const header = record.dataURL.slice(0, comma);
    const match = /^data:((image|video)\/[a-z0-9.+-]+)(?:;charset=[a-z0-9_-]+)?;base64$/i.exec(header);
    if (comma < 0 || !match || (record.type && record.type !== match[2].toLowerCase())) {
      throw new Error('The saved background must contain an embedded image or video.');
    }
    let binary;
    try { binary = atob(record.dataURL.slice(comma + 1)); }
    catch { throw new Error('The saved background media is damaged.'); }
    if (!binary.length) throw new Error('The saved background media is empty.');
    const chunks = [];
    for (let offset = 0; offset < binary.length; offset += 65536) {
      check(signal);
      const part = binary.slice(offset, offset + 65536), bytes = new Uint8Array(part.length);
      for (let i = 0; i < part.length; i++) bytes[i] = part.charCodeAt(i);
      chunks.push(bytes);
    }
    binary = null;
    const file = new File(chunks, String(record.name || 'Background media'), { type:match[1].toLowerCase() });
    return prepare(file, signal);
  }
  globalThis.JAWBackgroundMedia = Object.freeze({ prepare, prepareProject });
})();
