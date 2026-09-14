const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync('cloud-export.js', 'utf8');
function load(fetch = () => { throw Error('Unexpected network call'); }, mobile = false) {
  const context = { URL, Blob, FormData, DOMException, AbortController, crypto: require('node:crypto').webcrypto, fetch, clearTimeout,
    setTimeout: (fn, ms) => setTimeout(fn, ms === 1500 ? 0 : ms),
    LyricVideoExport: { isMobileDevice: () => mobile } };
  vm.runInNewContext(source, context);
  return context.JAWCloudExport;
}
const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
const job = status => ({ id: 'job-123', token: 'private-token', status });
const options = () => ({ endpoint: 'https://renderer.example/api/', accessKey: 'gateway-secret',
  project: { duration: 61, settings: { format: 'mp4' } }, audioFile: new Blob(['audio'], { type: 'audio/wav' }) });

test('automatic routing preserves duration boundaries and switches high-resolution or software formats', () => {
  const api = load(), normal = { duration: 60, width: 1920, height: 1080, fps: 30, format: 'mp4', configured: true };
  assert.equal(api.route(normal).target, 'local');
  for (const change of [{ duration: 60.01 }, { width: 3840 }, { width: 2160, height: 2160 }, { width: 1080, height: 3840 }, { format: 'mov' }, { format: 'webm', transparent: true }]) {
    assert.equal(api.route({ ...normal, ...change }).target, 'cloud');
  }
  assert.equal(api.route({ ...normal, fps: 60 }).target, 'local');
  for (const thresholdSeconds of [30, 60, 120]) {
    assert.equal(api.route({ ...normal, thresholdSeconds, duration: thresholdSeconds }).target, 'local');
    assert.equal(api.route({ ...normal, thresholdSeconds, duration: thresholdSeconds + 0.01 }).target, 'cloud');
  }
});
test('mobile routes long and high-frame-rate exports without changing chosen quality', () => {
  const api = load(), settings = { mobile: true, configured: true, duration: 30, fps: 30, width: 1920, height: 1080, format: 'mp4', thresholdSeconds: 120 };
  assert.equal(api.route(settings).target, 'local');
  assert.equal(api.route({ ...settings, duration: 31 }).target, 'cloud');
  assert.equal(api.route({ ...settings, fps: 60 }).target, 'cloud');
  assert.equal(settings.fps, 30);
  assert.equal(settings.thresholdSeconds, 120);
});
test('manual choice overrides auto; missing configuration is explicit before any upload', () => {
  const api = load();
  assert.equal(api.route({ mode: 'local', width: 3840, configured: true }).target, 'local');
  assert.equal(api.route({ mode: 'cloud', duration: 1, configured: true }).target, 'cloud');
  const auto = api.route({ duration: 120, configured: false });
  assert.equal(auto.target, 'local');
  assert.equal(auto.recommendedTarget, 'cloud');
  assert.match(auto.reason, /not configured/);
  const forced = api.route({ mode: 'cloud', configured: false });
  assert.equal(forced.target, 'cloud');
  assert.equal(forced.code, 'CLOUD_NOT_CONFIGURED');
  assert.match(forced.error, /Configure/);
  assert.equal(api.normalizeSettings({ mode: 'anything', thresholdSeconds: 45 }).mode, 'auto');
  assert.equal(api.normalizeSettings({ thresholdSeconds: '30' }).thresholdSeconds, 30);
  assert.equal(api.normalizeSettings({ thresholdSeconds: 999 }).thresholdSeconds, 60);
});
test('gateway endpoint permits HTTPS or localhost, rejects embedded credentials and query routing', () => {
  const api = load();
  assert.equal(api.normalizeEndpoint(' https://example.com/api/ '), 'https://example.com/api');
  for (const endpoint of ['http://localhost:8080/api', 'http://127.0.0.1:8080', 'http://[::1]:8080']) assert.equal(api.normalizeEndpoint(endpoint), endpoint);
  for (const endpoint of ['http://example.com', 'javascript:alert(1)', 'https://user:password@example.com', 'https://example.com?token=x', 'https://example.com#fragment', 'https://example.com?', 'https://example.com#']) assert.throws(() => api.normalizeEndpoint(endpoint));
});
test('cloud lifecycle submits once and downloads authenticated video through the gateway', async () => {
  const requests = [], progress = [];
  const api = load(async (url, init) => {
    requests.push({ url, init });
    if (requests.length === 1) return json(job('queued'));
    if (requests.length === 2) return json({ ...job('succeeded'), outputUrl: 'https://untrusted.example/video' });
    return new Response(new Uint8Array([1, 2, 3]), { headers: { 'content-type': 'video/mp4', 'content-length': '3' } });
  });
  const blob = await api.exportVideo({ ...options(), onProgress: (fraction, message) => progress.push([fraction, message]) });
  assert.equal(blob.size, 3);
  assert.equal(blob.type, 'video/mp4');
  assert.equal(requests[0].url, 'https://renderer.example/api/renders');
  assert.equal(requests[0].init.method, 'POST');
  assert.match(requests[0].init.headers['X-Request-ID'], /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/);
  assert.equal(JSON.parse(requests[0].init.body.get('project')).duration, 61);
  assert.equal(requests[0].init.body.get('audio').size, 5);
  assert.match(requests[1].url, /\/renders\/job-123\?token=private-token$/);
  assert.match(requests[2].url, /\/renders\/job-123\/file\?token=private-token$/);
  for (const { url, init } of requests) {
    assert.ok(url.startsWith('https://renderer.example/api/'));
    assert.equal(init.headers.Authorization, 'Bearer gateway-secret');
    assert.equal(init.credentials, 'omit');
    assert.equal(init.redirect, 'error');
  }
  assert.equal(progress.at(-1)[0], 1);
});
test('an immediate completed job goes directly to its gateway download', async () => {
  let requests = 0;
  const api = load(async () => ++requests === 1 ? json(job('succeeded')) : new Response('video'));
  const blob = await api.exportVideo(options());
  assert.equal(await blob.text(), 'video');
  assert.equal(requests, 2);
});
test('canceling a slow upload records request cancellation immediately, stops uploading, and waits for terminal confirmation', async () => {
  const requests = [], controller = new AbortController();
  let acknowledgeCancellation;
  const api = load((url, init) => {
    requests.push({ url, init });
    if (requests.length === 1) return new Promise((resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true });
    });
    if (requests.length === 2) return new Promise(resolve => { acknowledgeCancellation = resolve; });
    return Promise.resolve(json(job('canceled')));
  });
  const pending = api.exportVideo({ ...options(), signal: controller.signal });
  controller.abort();
  assert.equal(requests.length, 2, 'Request-ID cancellation starts without waiting for the large upload');
  assert.equal(requests[0].init.signal.aborted, false, 'Wait for the server to record cancellation before disconnecting the upload');
  const requestId = requests[0].init.headers['X-Request-ID'];
  assert.equal(requests[1].url, `https://renderer.example/api/requests/${requestId}/cancel`);
  acknowledgeCancellation(json({ ...job('uploading'), requestId, cancelRequested: true }, 202));
  await assert.rejects(pending, { name: 'AbortError' });
  assert.equal(requests[0].init.signal.aborted, true, 'The original upload is stopped after cancellation acknowledgment');
  assert.equal(requests.length, 3);
  assert.equal(requests[2].url, `https://renderer.example/api/requests/${requestId}`);
  assert.equal(requests[1].init.signal.aborted, false);
  assert.equal(requests.filter(({ url }) => url.endsWith('/renders')).length, 1);
});
test('a cancellation tombstone also stops an upload whose POST has not reached the gateway yet', async () => {
  const requests = [], controller = new AbortController();
  const api = load((url, init) => {
    requests.push({ url, init });
    if (requests.length === 1) return new Promise((resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true });
    });
    return Promise.resolve(json({ ...job('canceled'), requestId: requests[0].init.headers['X-Request-ID'], cancelRequested: true }));
  });
  const pending = api.exportVideo({ ...options(), signal: controller.signal });
  controller.abort();
  await assert.rejects(pending, { name: 'AbortError' });
  assert.equal(requests.length, 2);
  assert.equal(requests[0].init.signal.aborted, true);
});
test('lost cancellation acknowledgment still stops a slow upload and recovers its existing job', async () => {
  const requests = [], controller = new AbortController();
  const api = load((url, init) => {
    requests.push({ url, init });
    if (requests.length === 1) return new Promise((resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true });
    });
    if (requests.length === 2) return Promise.reject(new TypeError('Cancellation response lost'));
    if (requests.length === 3) return Promise.resolve(json(job('processing')));
    return Promise.resolve(json(job('canceled')));
  });
  const pending = api.exportVideo({ ...options(), signal: controller.signal });
  controller.abort();
  await assert.rejects(pending, { name: 'AbortError' });
  assert.equal(requests[0].init.signal.aborted, true);
  assert.match(requests[2].url, /\/requests\/[a-f0-9-]+$/);
  assert.match(requests[3].url, /\/renders\/job-123\/cancel\?/);
  assert.equal(requests.filter(({ url }) => url.endsWith('/renders')).length, 1);
});
test('aborting during polling cancels the paid job using a fresh signal', async () => {
  const requests = [], controller = new AbortController();
  const api = load(async (url, init) => {
    requests.push({ url, init });
    if (requests.length === 1) return json(job('processing'));
    if (requests.length === 2) { controller.abort(); throw new DOMException('Canceled', 'AbortError'); }
    return json(job('canceled'));
  });
  await assert.rejects(api.exportVideo({ ...options(), signal: controller.signal }), { name: 'AbortError' });
  assert.equal(requests.length, 3);
  assert.match(requests[2].url, /\/cancel\?/);
  assert.equal(requests[2].init.signal.aborted, false);
});
test('a cancellation failure is reported instead of falsely claiming remote work stopped', async () => {
  let requests = 0;
  const controller = new AbortController();
  const api = load(async () => {
    if (++requests === 1) { controller.abort(); return json(job('queued')); }
    return json({ error: 'Unavailable' }, 503);
  });
  await assert.rejects(api.exportVideo({ ...options(), signal: controller.signal }), error => {
    assert.equal(error.name, 'CloudCancellationError');
    assert.equal(error.jobId, 'job-123');
    assert.match(error.message, /could not be confirmed/);
    return true;
  });
});
test('submission errors are never automatically retried', async () => {
  let requests = 0;
  const api = load(async () => { requests++; return json({ error: 'Access denied' }, 401); });
  await assert.rejects(api.exportVideo(options()), /Access denied/);
  assert.equal(requests, 1);
});
test('lost submission acknowledgment recovers the request ID without creating another render', async () => {
  const requests = [];
  const api = load(async (url, init) => {
    requests.push({ url, init });
    if (requests.length === 1) throw new TypeError('Network disconnected');
    if (requests.length === 2) return json(job('succeeded'));
    return new Response('video');
  });
  assert.equal((await api.exportVideo(options())).size, 5);
  assert.equal(requests[1].url, `https://renderer.example/api/requests/${requests[0].init.headers['X-Request-ID']}`);
  assert.equal(requests.filter(({ init }) => init.method === 'POST').length, 1);
});
test('aborted submission with a lost response recovers and cancels the existing render', async () => {
  const controller = new AbortController(), requests = [];
  const api = load(async (url, init) => {
    requests.push({ url, init });
    if (requests.length === 1) { controller.abort(); throw new TypeError('Lost response'); }
    if (requests.length === 2) return json({ error: 'Request cancellation temporarily unavailable' }, 503);
    if (requests.length === 3) return json(job('processing'));
    return json(job('canceled'));
  });
  await assert.rejects(api.exportVideo({ ...options(), signal: controller.signal }), { name: 'AbortError' });
  assert.match(requests[1].url, /\/requests\//);
  assert.match(requests[3].url, /\/cancel\?/);
  assert.equal(requests.filter(({ url }) => url.endsWith('/renders')).length, 1);
});
test('unrecoverable submission reports uncertainty, including after a local abort', async () => {
  const controller = new AbortController();
  const api = load(async () => { controller.abort(); throw new TypeError('Offline'); });
  await assert.rejects(api.exportVideo({ ...options(), signal: controller.signal }), error => {
    assert.equal(error.name, 'CloudSubmissionError');
    assert.ok(error.requestId);
    return true;
  });
});
test('a lost response and missing recovery record do not falsely confirm cancellation', async () => {
  const controller = new AbortController();
  let requests = 0;
  const api = load(async () => {
    if (++requests === 1) { controller.abort(); throw new TypeError('Connection reset'); }
    return json({ error: 'Render request not found.' }, 404);
  });
  await assert.rejects(api.exportVideo({ ...options(), signal: controller.signal }), error => {
    assert.equal(error.name, 'CloudSubmissionError');
    assert.match(error.message, /could not be confirmed/);
    return true;
  });
  assert.equal(requests, 3, 'Only submission, request-ID cancellation, and recovery should be attempted');
});
test('HTTP 202 cancellation stays pending until remote terminal confirmation', async () => {
  const controller = new AbortController(), requests = [];
  const api = load(async (url, init) => {
    requests.push({ url, init });
    if (requests.length === 1) { controller.abort(); return json(job('processing')); }
    if (requests.length === 2) return json({ ...job('processing'), requestId: requests[0].init.headers['X-Request-ID'], cancelRequested: true }, 202);
    return json(job('canceled'));
  });
  await assert.rejects(api.exportVideo({ ...options(), signal: controller.signal }), { name: 'AbortError' });
  assert.equal(requests.length, 3);
  assert.match(requests[2].url, /\/requests\/[a-f0-9-]+$/);
  assert.equal(requests[2].init.signal.aborted, false);
});
test('capabilities authenticates and validates server-installed font families', async () => {
  const api = load(async (url, init) => {
    assert.equal(url, 'https://renderer.example/api/capabilities');
    assert.equal(init.headers.Authorization, 'Bearer gateway-secret');
    return json({ fontFamilies: ['Arial Black'] });
  });
  assert.deepEqual(await api.capabilities(options()), { fontFamilies: ['Arial Black'] });
  await assert.rejects(load(async () => json({ fontFamilies: [7] })).capabilities(options()), /invalid font capabilities/);
});
test('a poll failure cancels the existing job instead of submitting another', async () => {
  const requests = [];
  const api = load(async (url, init) => {
    requests.push({ url, init });
    if (requests.length === 1) return json(job('processing'));
    if (requests.length === 2) return json({ error: 'Service interrupted' }, 503);
    return json(job('canceled'));
  });
  await assert.rejects(api.exportVideo(options()), /Service interrupted/);
  assert.equal(requests.length, 3);
  assert.match(requests[2].url, /\/cancel\?/);
  assert.equal(requests.filter(({ url }) => url.endsWith('/renders')).length, 1);
});
test('failed terminal jobs report provider failure without redundant cancel or download', async () => {
  let requests = 0;
  const api = load(async () => { requests++; return json({ ...job('failed'), error: 'Render exceeded memory' }); });
  await assert.rejects(api.exportVideo(options()), /Render exceeded memory/);
  assert.equal(requests, 1);
});
test('oversized mobile video download stops before buffering the body', async () => {
  let requests = 0, canceled = false;
  const api = load(async () => ++requests === 1 ? json(job('succeeded')) : new Response(new ReadableStream({
    cancel() { canceled = true; }
  }), { headers: { 'content-length': String(257 * 1024 * 1024), 'content-type': 'video/quicktime' } }), true);
  await assert.rejects(api.exportVideo(options()), error => {
    assert.match(error.message, /256 MB download limit/);
    assert.match(error.downloadUrl, /\/renders\/job-123\/file\?token=private-token$/);
    assert.equal(error.jobId, 'job-123');
    return true;
  });
  assert.equal(canceled, true);
  assert.equal(requests, 2);
});
test('streaming size limit also stops videos without a content-length header', async () => {
  let requests = 0, canceled = false;
  const chunk = new Uint8Array([1]);
  Object.defineProperty(chunk, 'byteLength', { value: 257 * 1024 * 1024 });
  const api = load(async () => ++requests === 1 ? json(job('succeeded')) : new Response(new ReadableStream({
    start(controller) { controller.enqueue(chunk); },
    cancel() { canceled = true; }
  }), { headers: { 'content-type': 'video/quicktime' } }), true);
  await assert.rejects(api.exportVideo(options()), /256 MB download limit/);
  assert.equal(canceled, true);
  assert.equal(requests, 2);
});
test('empty or non-video gateway responses are not offered as completed exports', async () => {
  for (const response of [new Response('', { headers: { 'content-type': 'video/mp4' } }), json({ message: 'not a video' })]) {
    let requests = 0;
    const api = load(async () => ++requests === 1 ? json(job('succeeded')) : response);
    await assert.rejects(api.exportVideo(options()), /empty video|did not return a video/);
  }
});
test('invalid inputs and pre-aborted jobs fail before any network or billable work', async () => {
  const api = load();
  const controller = new AbortController(); controller.abort();
  await assert.rejects(api.exportVideo({ ...options(), signal: controller.signal }), { name: 'AbortError' });
  await assert.rejects(api.exportVideo({ ...options(), accessKey: '' }), /access key/);
  await assert.rejects(api.exportVideo({ ...options(), audioFile: new Blob([]) }), /Choose an audio/);
  const tooBig = new Blob(['large']); Object.defineProperty(tooBig, 'size', { value: 101 * 1024 * 1024 });
  await assert.rejects(api.exportVideo({ ...options(), audioFile: tooBig }), /100 MB/);
});
