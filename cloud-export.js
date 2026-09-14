/* Cloud jobs go through a private gateway; provider credentials never enter this page. */
(() => {
  'use strict';
  const MiB = 1024 * 1024;
  const limits = Object.freeze({ audioBytes: 100 * MiB, projectBytes: 30 * MiB, desktopOutputBytes: 1024 * MiB, mobileOutputBytes: 256 * MiB });
  const normalizeSettings = ({ mode = 'auto', thresholdSeconds = 60 } = {}) => ({
    mode: ['auto', 'local', 'cloud'].includes(mode) ? mode : 'auto',
    thresholdSeconds: [30, 60, 120].includes(Number(thresholdSeconds)) ? Number(thresholdSeconds) : 60
  });
  function route(options = {}) {
    const { mode, thresholdSeconds } = normalizeSettings(options);
    const result = { mode, thresholdSeconds, available: !!options.configured };
    if (mode === 'local') return { ...result, target: 'local', reason: 'Export on this device.' };
    let reason = mode === 'cloud' ? 'Cloud export selected.' : '';
    if (!reason && Math.max(Number(options.width) || 0, Number(options.height) || 0) > 1920) reason = 'High-resolution video uses cloud export.';
    if (!reason && ['mov', 'webm'].includes(String(options.format).toLowerCase())) reason = 'This video format uses cloud export.';
    const seconds = options.mobile ? Math.min(thresholdSeconds, 30) : thresholdSeconds;
    if (!reason && Number(options.duration) > seconds) reason = `Videos longer than ${seconds} seconds use cloud export.`;
    if (!reason && options.mobile && Number(options.fps) > 30) reason = 'High frame rates on mobile use cloud export.';
    if (!reason) return { ...result, target: 'local', reason: 'This video exports on your device.' };
    if (options.configured) return { ...result, target: 'cloud', reason };
    if (mode === 'cloud') return { ...result, target: 'cloud', reason, code: 'CLOUD_NOT_CONFIGURED', error: 'Configure your cloud export server and access key first.' };
    return { ...result, target: 'local', recommendedTarget: 'cloud', reason: 'Cloud export is not configured. This video will export on your device.', code: 'CLOUD_NOT_CONFIGURED' };
  }
  function normalizeEndpoint(value) {
    let url;
    const input = String(value || '').trim();
    try { url = new URL(input); } catch { throw Error('Enter a valid cloud export server URL.'); }
    const localhost = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && localhost)) throw Error('The cloud export server must use HTTPS, or HTTP on localhost.');
    if (url.username || url.password || input.includes('?') || input.includes('#')) throw Error('The cloud export server URL cannot contain a username, password, query, or fragment.');
    return url.href.replace(/\/+$/, '');
  }
  function aborted() { return new DOMException('Export canceled.', 'AbortError'); }
  function check(signal) { if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : aborted(); }
  function pause(ms, signal) {
    return new Promise((resolve, reject) => {
      if (signal.aborted) return reject(signal.reason || aborted());
      const done = () => { signal.removeEventListener('abort', cancel); resolve(); };
      const timer = setTimeout(done, ms);
      const cancel = () => { clearTimeout(timer); signal.removeEventListener('abort', cancel); reject(signal.reason || aborted()); };
      signal.addEventListener('abort', cancel, { once: true });
    });
  }
  async function requestJSON(url, init, signal, timeout = 120000) {
    const controller = new AbortController();
    const cancel = () => controller.abort(signal.reason || aborted());
    const timer = setTimeout(() => controller.abort(Error('The cloud export server did not respond in time.')), timeout);
    signal?.addEventListener('abort', cancel, { once: true });
    try {
      check(signal);
      const response = await fetch(url, { ...init, signal: controller.signal, cache: 'no-store', credentials: 'omit', redirect: 'error' });
      let data;
      try { data = await response.json(); } catch { check(controller.signal); throw Error(`The cloud export server returned an invalid response (${response.status}).`); }
      if (!response.ok) { const error = Error(typeof data?.error === 'string' ? data.error : `Cloud export request failed (${response.status}).`); error.httpStatus = response.status; throw error; }
      return data;
    } catch (error) {
      check(controller.signal);
      throw error;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', cancel);
    }
  }
  async function capabilities({ endpoint, accessKey, signal } = {}) {
    if (typeof accessKey !== 'string' || !accessKey.trim()) throw Error('Enter your cloud export access key.');
    const data = await requestJSON(`${normalizeEndpoint(endpoint)}/capabilities`, { headers: { Authorization: `Bearer ${accessKey.trim()}` } }, signal);
    if (!Array.isArray(data?.fontFamilies) || !data.fontFamilies.every(family => typeof family === 'string')) throw Error('The cloud export server returned invalid font capabilities.');
    return data;
  }
  async function cancelRemote(jobURL, headers, onAcknowledged = () => {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(Error('Cloud cancellation was not confirmed in time.')), 15000);
    try {
      let status = await requestJSON(jobURL('cancel'), { method: 'POST', headers }, controller.signal, 15000);
      onAcknowledged(status);
      while (!['canceled', 'cancelled', 'failed', 'succeeded'].includes(status.status)) {
        await pause(1500, controller.signal);
        status = await requestJSON(jobURL(''), { headers }, controller.signal, 15000);
      }
      return status;
    } finally { clearTimeout(timer); }
  }
  async function download(url, headers, signal, onProgress, mobile) {
    const maximum = mobile ? limits.mobileOutputBytes : limits.desktopOutputBytes;
    const response = await fetch(url, { headers, signal, cache: 'no-store', credentials: 'omit', redirect: 'error' });
    if (!response.ok) throw Error(`The finished video could not be downloaded (${response.status}).`);
    const total = Number(response.headers.get('content-length')) || 0;
    const type = response.headers.get('content-type') || 'application/octet-stream';
    if (/text\/html|application\/json/i.test(type)) throw Error('The cloud export server did not return a video file.');
    const tooLarge = () => Error(`The finished video exceeds this device's ${maximum / MiB} MB download limit. Choose a smaller export or download it from your server.`);
    if (total > maximum) { await response.body?.cancel(); throw tooLarge(); }
    if (!response.body?.getReader) throw Error('This browser cannot stream the cloud video download. Try a current browser.');
    const reader = response.body.getReader(), chunks = [];
    let received = 0;
    try {
      while (true) {
        check(signal);
        const { value, done } = await reader.read();
        if (done) break;
        received += value.byteLength;
        if (received > maximum) throw tooLarge();
        chunks.push(value);
        onProgress(total ? Math.min(0.99, 0.92 + 0.07 * received / total) : 0.95, `Downloading video… ${(received / MiB).toFixed(1)} MB`);
      }
      check(signal);
      if (!received) throw Error('The cloud export server returned an empty video.');
      return new Blob(chunks, { type });
    } catch (error) {
      try { await reader.cancel(); } catch { /* Preserve the download error. */ }
      throw error;
    } finally { reader.releaseLock(); }
  }
  async function exportVideo({ endpoint, accessKey, project, audioFile, signal, onProgress = () => {} } = {}) {
    check(signal);
    const base = normalizeEndpoint(endpoint);
    if (typeof accessKey !== 'string' || !accessKey.trim()) throw Error('Enter your cloud export access key.');
    if (!(audioFile instanceof Blob) || !audioFile.size) throw Error('Choose an audio or video file before cloud export.');
    if (audioFile.size > limits.audioBytes) throw Error('Cloud export accepts source files up to 100 MB.');
    if (!project || typeof project !== 'object' || Array.isArray(project)) throw Error('Cloud export requires a project.');
    const projectJSON = JSON.stringify(project);
    if (new Blob([projectJSON]).size > limits.projectBytes) throw Error('This project exceeds the 30 MB cloud export limit.');
    const headers = { Authorization: `Bearer ${accessKey.trim()}` };
    const requestId = crypto.randomUUID();
    const body = new FormData();
    body.append('project', projectJSON);
    body.append('audio', audioFile, audioFile.name || 'audio.wav');
    const work = new AbortController(), submission = new AbortController();
    let job, terminal = false, succeeded = false, submitting = false, requestCancellation;
    const requestURL = action => `${base}/requests/${encodeURIComponent(requestId)}${action ? '/' + action : ''}`;
    const cancel = () => {
      work.abort(aborted()); onProgress(0, 'Canceling cloud export…');
      if (submitting && !requestCancellation) {
        // Record cancellation first, including when it reaches the gateway before
        // the multipart POST. If acknowledgment is lost, stop uploading and recover
        // this request ID; never submit another job.
        requestCancellation = cancelRemote(requestURL, headers, status => {
          if (status.requestId !== requestId || status.cancelRequested !== true) throw Error('The server did not acknowledge cancellation of this upload.');
          if (typeof status.id === 'string' && status.id && typeof status.token === 'string' && status.token) job = { id: status.id, token: status.token };
          submission.abort(aborted());
        }).then(status => ({ status }), error => { submission.abort(aborted()); return { error }; });
      }
    };
    signal?.addEventListener('abort', cancel, { once: true });
    const deadline = setTimeout(() => work.abort(Error('Cloud export timed out after 60 minutes.')), 60 * 60 * 1000);
    const jobURL = action => `${base}/renders/${encodeURIComponent(job.id)}${action ? '/' + action : ''}?token=${encodeURIComponent(job.token)}`;
    try {
      check(signal);
      onProgress(0, 'Uploading project for cloud export…');
      // Never retry this POST: it may already have started billable work.
      let created;
      try {
        submitting = true;
        created = await requestJSON(`${base}/renders`, { method: 'POST', headers: { ...headers, 'X-Request-ID': requestId }, body }, submission.signal, 300000);
      } catch (submissionError) {
        if (requestCancellation && !(await requestCancellation).error) { terminal = true; throw work.signal.reason; }
        if (submissionError.httpStatus && submissionError.httpStatus < 500 && submissionError.httpStatus !== 409) throw submissionError;
        onProgress(0, 'Checking the submitted cloud job…');
        try { created = await requestJSON(`${base}/requests/${encodeURIComponent(requestId)}`, { headers }, undefined, 15000); }
        catch (recoveryError) {
          // A missing request after an ambiguous POST can also mean that the
          // gateway restarted. It does not prove a paid prediction never began.
          const error = Error('Cloud submission could not be confirmed. Check your cloud export server before trying again. No second render was submitted.', { cause: recoveryError });
          error.name = 'CloudSubmissionError'; error.requestId = requestId;
          throw error;
        }
      } finally {
        submitting = false;
      }
      if (typeof created?.id !== 'string' || !created.id || typeof created.token !== 'string' || !created.token) throw Error('The cloud export server did not return a job ID and token.');
      job = { id: created.id, token: created.token };
      check(work.signal);
      let status = created;
      while (true) {
        check(work.signal);
        if (status.status === 'succeeded') { terminal = true; succeeded = true; break; }
        if (['failed', 'canceled', 'cancelled'].includes(status.status)) {
          terminal = true;
          if (status.status !== 'failed') throw aborted();
          throw Error(typeof status.error === 'string' ? status.error : 'The cloud video render failed.');
        }
        const fraction = Number(status.progress);
        onProgress(Number.isFinite(fraction) ? 0.08 + 0.82 * Math.max(0, Math.min(1, fraction)) : 0.08,
          ['starting', 'queued'].includes(status.status) ? 'Waiting for the cloud renderer…' : 'Rendering video on the server…');
        await pause(1500, work.signal);
        status = await requestJSON(jobURL(''), { headers }, work.signal);
      }
      onProgress(0.92, 'Downloading finished video…');
      const mobile = !!globalThis.LyricVideoExport?.isMobileDevice?.();
      const blob = await download(jobURL('file'), headers, work.signal, onProgress, mobile);
      onProgress(1, 'Cloud video ready.');
      return blob;
    } catch (error) {
      let failure = work.signal.aborted && error.name !== 'CloudSubmissionError' ? work.signal.reason : error;
      if (requestCancellation && !(await requestCancellation).error) terminal = true;
      if (succeeded) { failure.downloadUrl = jobURL('file'); failure.jobId = job.id; }
      if (job && !terminal) {
        try {
          // Independent signal: stopping the browser must also stop paid server work.
          await cancelRemote(jobURL, headers);
        } catch (cancelError) {
          failure = Error('Cloud cancellation could not be confirmed. Check your cloud export server for a job still running.', { cause: cancelError });
          failure.name = 'CloudCancellationError';
          failure.jobId = job.id;
        }
      }
      throw failure;
    } finally {
      clearTimeout(deadline);
      signal?.removeEventListener('abort', cancel);
    }
  }
  globalThis.JAWCloudExport = Object.freeze({ route, normalizeSettings, normalizeEndpoint, capabilities, exportVideo, limits });
})();
