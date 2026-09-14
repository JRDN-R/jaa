'use strict';

const http = require('node:http');
const { createHash, randomBytes, randomUUID, timingSafeEqual } = require('node:crypto');
const { createWriteStream, openAsBlob } = require('node:fs');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const Busboy = require('busboy');

const MIB = 1024 * 1024;
const API_BASE = 'https://api.replicate.com/v1';
const TERMINAL = new Set(['succeeded', 'failed', 'canceled']);
const STATES = new Set(['starting', 'processing', ...TERMINAL]);
const ID = /^[a-zA-Z0-9_-]{1,128}$/;
const digest = (value) => createHash('sha256').update(String(value)).digest();
const secretEqual = (value, expected) => timingSafeEqual(digest(value), digest(expected));
const fail = (status, message, code) => Object.assign(new Error(message), { status, code });
const finite = (n, min, max) => typeof n === 'number' && Number.isFinite(n) && n >= min && n <= max;
const plain = (v) => v && typeof v === 'object' && !Array.isArray(v);
const onlyKeys = (v, names) => Object.keys(v).every((key) => names.includes(key));
const validFamily = (value) => typeof value === 'string' && value.trim().length > 0 && value.length <= 100 && !/[\x00-\x1f\x7f<>"'\\;{}:]/.test(value);

function validateProject(project) {
  if (!plain(project) || !onlyKeys(project, ['schemaVersion', 'rendererVersion', 'duration', 'words', 'settings', 'fonts']) ||
      project.schemaVersion !== 1 || !/^[a-f0-9]{64}$/.test(project.rendererVersion || '') || !finite(project.duration, 0.001, 1800)) {
    throw fail(400, 'Invalid project manifest or duration. The maximum duration is 30 minutes.', 'INVALID_PROJECT');
  }
  const s = project.settings;
  if (!plain(s) || !onlyKeys(s, ['aspect', 'resolution', 'fps', 'exportFormat', 'transparent', 'font', 'style', 'background', 'foreground', 'accent', 'motion', 'groupSize', 'uppercase']) ||
      !['wide', 'square', 'portrait'].includes(s.aspect) || !['1080', '2160'].includes(s.resolution) ||
      ![24, 30, 50, 60].includes(s.fps) || !['mp4', 'webm', 'mov'].includes(s.exportFormat) ||
      typeof s.transparent !== 'boolean' || (s.exportFormat === 'mp4' && s.transparent) ||
      !validFamily(s.font) || !['kinetic', 'stack', 'spotlight'].includes(s.style) ||
      !['background', 'foreground', 'accent'].every((key) => /^#[a-f0-9]{6}$/i.test(s[key] || '')) ||
      !finite(s.motion, 0, 2) || !Number.isInteger(s.groupSize) || !finite(s.groupSize, 2, 9) || typeof s.uppercase !== 'boolean') {
    throw fail(400, 'Unsupported render settings.', 'INVALID_SETTINGS');
  }
  if (!Array.isArray(project.words) || !project.words.length || project.words.length > 50000 || project.words.some((word) =>
    !plain(word) || !onlyKeys(word, ['id', 'text', 'start', 'end', 'emphasis', 'breakBefore']) ||
    typeof word.id !== 'string' || !word.id.length || word.id.length > 200 ||
    typeof word.text !== 'string' || !word.text.trim().length || word.text.length > 1000 ||
    !finite(word.start, 0, 1800) || !finite(word.end, word.start, 1800) || word.end <= word.start ||
    (word.emphasis !== undefined && typeof word.emphasis !== 'boolean') ||
    (word.breakBefore !== undefined && typeof word.breakBefore !== 'boolean')) ||
    new Set(project.words.map((word) => word.id)).size !== project.words.length) {
    throw fail(400, 'Invalid caption words or timings.', 'INVALID_WORDS');
  }
  if (!Array.isArray(project.fonts) || project.fonts.length > 32 || project.fonts.some((font) =>
    !plain(font) || !onlyKeys(font, ['family', 'data', 'descriptors']) ||
    !validFamily(font.family) ||
    typeof font.data !== 'string' || font.data.length > Math.ceil(10 * MIB / 3) * 4 || font.data.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(font.data) || Buffer.byteLength(font.data, 'base64') > 10 * MIB ||
    !['00010000', '4f54544f', '774f4646', '774f4632', '74746366', '74727565', '74797031'].includes(Buffer.from(font.data.slice(0, 8), 'base64').subarray(0, 4).toString('hex')) ||
    !plain(font.descriptors) || !onlyKeys(font.descriptors, ['weight', 'style', 'stretch', 'unicodeRange']) ||
    Object.values(font.descriptors).some((value) => typeof value !== 'string' || value.length > 4096 || /[\x00-\x1f<>"'\\;{}()]/.test(value)))) {
    throw fail(400, 'Invalid embedded fonts. External font URLs are not accepted.', 'INVALID_FONTS');
  }
  return project;
}

function readConfig(env = process.env) {
  const deployment = env.REPLICATE_DEPLOYMENT || '';
  const version = env.REPLICATE_VERSION || '';
  if (!env.REPLICATE_API_TOKEN || !env.JAA_RENDER_ACCESS_KEY || env.JAA_RENDER_ACCESS_KEY.length < 32) {
    throw new Error('Set REPLICATE_API_TOKEN and JAA_RENDER_ACCESS_KEY (at least 32 characters) as server secrets.');
  }
  if ((!deployment && !version) || (deployment && version) ||
      (deployment && !/^[\w-]+\/[\w-]+$/.test(deployment)) ||
      (version && !/^(?:[\w-]+\/[\w-]+:)?[a-f0-9]{64}$/.test(version))) {
    throw new Error('Set exactly one of REPLICATE_DEPLOYMENT=owner/name or REPLICATE_VERSION=<pinned 64-character version>.');
  }
  const origins = (env.JAA_ALLOWED_ORIGINS || 'https://jrdn-r.github.io').split(',').map((v) => v.trim());
  for (const origin of origins) {
    const url = new URL(origin);
    if (url.origin !== origin || !['http:', 'https:'].includes(url.protocol)) throw new Error('JAA_ALLOWED_ORIGINS must contain exact origins.');
  }
  const fontFamilies = (env.JAA_RENDER_FONT_FAMILIES || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (fontFamilies.some((family) => !validFamily(family))) throw new Error('JAA_RENDER_FONT_FAMILIES contains an invalid family name.');
  if (env.JAA_RENDERER_VERSION && !/^[a-f0-9]{64}$/.test(env.JAA_RENDERER_VERSION)) throw new Error('JAA_RENDERER_VERSION must be the 64-character hash from renderer-version.txt.');
  const integer = (name, fallback, min, max) => {
    const value = env[name] === undefined ? fallback : Number(env[name]);
    if (!Number.isInteger(value) || value < min || value > max) throw new Error(`Invalid ${name}.`);
    return value;
  };
  return {
    apiToken: env.REPLICATE_API_TOKEN, accessKey: env.JAA_RENDER_ACCESS_KEY, deployment, version, origins,
    fontFamilies,
    rendererVersion: env.JAA_RENDERER_VERSION || undefined,
    maxJobs: integer('JAA_MAX_JOBS', 1000, 1, 10000),
    maxActive: integer('JAA_MAX_ACTIVE', 2, 1, 20),
    jobsPerHour: integer('JAA_JOBS_PER_HOUR', 30, 1, 10000),
    projectBytes: 30 * MIB, audioBytes: 100 * MIB,
    uploadTimeoutMs: 120000, apiTimeoutMs: 120000,
    jobTtlMs: 2 * 60 * 60 * 1000, cancelAfterMs: 30 * 60 * 1000,
  };
}

async function receiveMultipart(req, dir, config) {
  const maxBytes = config.projectBytes + config.audioBytes + 65536;
  if (Number(req.headers['content-length'] || 0) > maxBytes) throw fail(413, 'Upload exceeds the 130 MiB limit.', 'UPLOAD_TOO_LARGE');
  let parser;
  try {
    // Busboy signals partsLimit upon reaching the configured count, so allow the
    // closing boundary for our two expected parts. Field/file limits reject extras.
    parser = Busboy({ headers: req.headers, limits: { fields: 1, files: 1, parts: 3, fieldSize: config.projectBytes, fileSize: config.audioBytes, fieldNameSize: 30 } });
  } catch {
    throw fail(400, 'Send a multipart form with project and audio fields.', 'INVALID_UPLOAD');
  }
  return new Promise((resolve, reject) => {
    let projectText, audio, received = 0, settled = false;
    const writes = [];
    const cleanup = () => { clearTimeout(timer); req.off('aborted', aborted); req.off('data', count); };
    const rejectOnce = (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      req.unpipe(parser);
      parser.destroy();
      req.resume();
      Promise.allSettled(writes).then(() => reject(error));
    };
    const aborted = () => rejectOnce(fail(400, 'Upload canceled.', 'UPLOAD_CANCELED'));
    const count = (chunk) => { received += chunk.length; if (received > maxBytes) rejectOnce(fail(413, 'Upload is too large.', 'UPLOAD_TOO_LARGE')); };
    const timer = setTimeout(() => rejectOnce(fail(408, 'Upload timed out.', 'UPLOAD_TIMEOUT')), config.uploadTimeoutMs);
    req.once('aborted', aborted);
    req.on('data', count);
    parser.on('field', (name, value, info) => {
      if (name !== 'project' || projectText !== undefined) return rejectOnce(fail(400, 'Only one project field is accepted.', 'INVALID_UPLOAD'));
      if (info.valueTruncated) return rejectOnce(fail(413, 'Project exceeds 30 MiB.', 'PROJECT_TOO_LARGE'));
      projectText = value;
    });
    parser.on('file', (name, stream) => {
      if (name !== 'audio' || audio) { stream.resume(); rejectOnce(fail(400, 'Only one audio file is accepted.', 'INVALID_UPLOAD')); return; }
      audio = path.join(dir, 'audio.bin');
      stream.once('limit', () => rejectOnce(fail(413, 'Audio exceeds 100 MiB.', 'AUDIO_TOO_LARGE')));
      // Client filenames and media types never become filesystem paths or commands.
      writes.push(pipeline(stream, createWriteStream(audio, { flags: 'wx', mode: 0o600 })).catch((error) => { rejectOnce(fail(400, 'Audio upload failed.', 'INVALID_UPLOAD')); throw error; }));
      // Attach a handler immediately so malformed/truncated streams cannot cause unhandled rejections.
      writes.at(-1).catch(() => {});
    });
    for (const event of ['fieldsLimit', 'filesLimit', 'partsLimit']) parser.on(event, () => rejectOnce(fail(400, 'Unexpected multipart fields.', 'INVALID_UPLOAD')));
    parser.once('error', () => rejectOnce(fail(400, 'Malformed multipart upload.', 'INVALID_UPLOAD')));
    parser.once('close', async () => {
      if (settled) return;
      try {
        await Promise.all(writes);
        if (!projectText || !audio || !(await fs.stat(audio)).size) throw fail(400, 'Project and nonempty audio are required.', 'INVALID_UPLOAD');
        let project;
        try { project = JSON.parse(projectText); } catch { throw fail(400, 'Project JSON is invalid.', 'INVALID_PROJECT'); }
        validateProject(project);
        const projectPath = path.join(dir, 'project.json');
        await fs.writeFile(projectPath, JSON.stringify(project), { flag: 'wx', mode: 0o600 });
        settled = true;
        cleanup();
        resolve({ project, projectPath, audioPath: audio });
      } catch (error) { rejectOnce(error); }
    });
    req.pipe(parser);
  });
}

function createGateway(config, { fetchImpl = fetch, now = Date.now, tempRoot = os.tmpdir(), logger = console } = {}) {
  const jobs = new Map();
  const requests = new Map();
  let starts = [];
  let closing = false;

  async function api(route, options = {}) {
    let response;
    try {
      response = await fetchImpl(`${API_BASE}${route}`, {
        ...options, redirect: 'error',
        signal: AbortSignal.timeout(config.apiTimeoutMs),
        headers: { Authorization: `Bearer ${config.apiToken}`, ...options.headers },
      });
      if (!response.ok) {
        await response.body?.cancel();
        throw fail(502, 'The render service could not complete this request. Retry checking the existing job.', 'REPLICATE_ERROR');
      }
      if (response.status === 204) return null;
      return await response.json();
    } catch (error) {
      if (error.status) throw error;
      throw fail(502, 'The render service is unavailable. Retry checking the existing job.', 'REPLICATE_UNAVAILABLE');
    }
  }

  async function upload(filePath, filename) {
    const form = new FormData();
    form.append('content', await openAsBlob(filePath, { type: filename.endsWith('.json') ? 'application/json' : 'application/octet-stream' }), filename);
    form.append('metadata', new Blob(['{"application":"jaa"}'], { type: 'application/json' }));
    const file = await api('/files', { method: 'POST', body: form });
    // urls.get is opaque; use the API response instead of deriving a delivery path.
    let url;
    try { url = new URL(file?.urls?.get); } catch { throw fail(502, 'The input upload response was invalid.', 'INVALID_UPSTREAM'); }
    if (!ID.test(file.id || '') || url.protocol !== 'https:' || url.username || url.password) {
      throw fail(502, 'The input upload response was invalid.', 'INVALID_UPSTREAM');
    }
    return file;
  }

  async function deleteInputs(job) {
    const files = job.files.splice(0);
    await Promise.allSettled(files.map(async (file) => {
      try { await api(`/files/${encodeURIComponent(file.id)}`, { method: 'DELETE' }); }
      catch { job.files.push(file); logger.warn('JAA input cleanup deferred until the next sweep.'); }
    }));
  }

  async function cancelJob(job) {
    job.cancelRequested = true;
    if (!job.predictionId) return;
    if (job.cancelPromise) return job.cancelPromise;
    if (TERMINAL.has(job.status)) return;
    job.cancelPromise = (async () => {
      const prediction = await api(`/predictions/${job.predictionId}/cancel`, { method: 'POST' });
      if (prediction?.id !== job.predictionId || !STATES.has(prediction?.status)) throw fail(502, 'Cancellation has not been confirmed by the render service. Keep checking this job.', 'INVALID_UPSTREAM');
      job.status = prediction.status;
      if (TERMINAL.has(job.status)) await deleteInputs(job);
    })();
    try { await job.cancelPromise; } finally { job.cancelPromise = null; }
  }

  const jobView = (job) => ({ id: job.id, token: job.token, status: job.status, requestId: job.requestId, cancelRequested: job.cancelRequested });
  const cancelDisconnected = (job) => {
    job.cancelRequested = true;
    cancelJob(job).catch(() => logger.warn('JAA cancellation unavailable; the Replicate Cancel-After deadline still applies.'));
  };

  async function createRender(req, res) {
    if (closing) throw fail(503, 'Render gateway is shutting down.', 'SHUTTING_DOWN');
    const requestId = req.headers['x-request-id'] || randomUUID();
    if (typeof requestId !== 'string' || !/^[a-zA-Z0-9_-]{16,128}$/.test(requestId)) throw fail(400, 'Invalid request ID.', 'INVALID_REQUEST_ID');
    const existing = requests.get(requestId);
    if (existing) {
      req.resume();
      if (existing.predictionId || TERMINAL.has(existing.status)) return json(res, 200, jobView(existing));
      throw fail(409, 'This render request is already being submitted. Check its request ID.', 'REQUEST_IN_PROGRESS');
    }
    starts = starts.filter((time) => time > now() - 3600000);
    if (starts.length >= config.jobsPerHour) throw fail(429, 'The hourly cloud export limit has been reached.', 'RATE_LIMIT');
    if ([...jobs.values()].filter((job) => !TERMINAL.has(job.status)).length >= config.maxActive) throw fail(429, 'The cloud renderer is busy. Try again after the current export finishes.', 'BUSY');
    if (jobs.size >= config.maxJobs) throw fail(503, 'The cloud job queue is full. Try again later.', 'QUEUE_FULL');
    const job = {
      id: randomUUID(), token: randomBytes(32).toString('base64url'), requestId,
      status: 'uploading', files: [], createdAt: now(), cancelRequested: false,
    };
    jobs.set(job.id, job);
    requests.set(requestId, job);
    starts.push(now());
    const onClose = () => { if (!res.writableEnded) cancelDisconnected(job); };
    res.once('close', onClose);
    let dir;
    try {
      dir = await fs.mkdtemp(path.join(tempRoot, 'jaa-render-'));
      const received = await receiveMultipart(req, dir, config);
      job.format = received.project.settings.exportFormat;
      const selectedFamily = received.project.settings.font;
      if (!received.project.fonts.some((font) => font.family === selectedFamily) && !(config.fontFamilies || []).includes(selectedFamily)) {
        throw fail(400, `The cloud server does not have "${selectedFamily}". Upload this font in the editor or use device export.`, 'FONT_UNAVAILABLE');
      }
      if (config.rendererVersion && received.project.rendererVersion !== config.rendererVersion) {
        throw fail(409, 'The cloud renderer and website versions differ. Update the cloud model or use device export.', 'RENDERER_VERSION_MISMATCH');
      }
      if (job.cancelRequested) throw fail(409, 'Render request canceled.', 'RENDER_CANCELED');
      job.files.push(await upload(received.projectPath, 'project.json'));
      if (job.cancelRequested) throw fail(409, 'Render request canceled.', 'RENDER_CANCELED');
      job.files.push(await upload(received.audioPath, 'audio.bin'));
      if (job.cancelRequested) throw fail(409, 'Render request canceled.', 'RENDER_CANCELED');
      const route = config.deployment ? `/deployments/${config.deployment}/predictions` : '/predictions';
      const data = { input: { project: job.files[0].urls.get, audio: job.files[1].urls.get } };
      if (config.version) data.version = config.version;
      // Never retry creation automatically: a dropped response may still represent a paid job.
      // Keep waiting after a browser disconnect so its eventual ID can be canceled.
      const prediction = await api(route, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Cancel-After': '30m' }, body: JSON.stringify(data) });
      if (!ID.test(prediction?.id || '')) throw fail(502, 'The render service returned an invalid job ID.', 'INVALID_UPSTREAM');
      job.predictionId = prediction.id;
      job.status = STATES.has(prediction.status) ? prediction.status : 'starting';
      if (job.cancelRequested) {
        await cancelJob(job);
        throw fail(409, 'Render request canceled.', 'RENDER_CANCELED');
      }
      await fs.rm(dir, { recursive: true, force: true });
      dir = undefined;
      json(res, 202, jobView(job));
    } catch (error) {
      if (!job.predictionId) job.status = job.cancelRequested ? 'canceled' : 'failed';
      if (TERMINAL.has(job.status)) await deleteInputs(job);
      throw error;
    } finally {
      if (dir) await fs.rm(dir, { recursive: true, force: true });
    }
  }

  async function predictionFor(job) {
    if (!job.predictionId) return { id: job.id, status: job.status, output: null };
    const p = await api(`/predictions/${job.predictionId}`);
    if (p?.id !== job.predictionId || !STATES.has(p?.status)) throw fail(502, 'The render service returned an invalid status.', 'INVALID_UPSTREAM');
    job.status = p.status;
    if (TERMINAL.has(job.status)) await deleteInputs(job);
    return p;
  }

  function outputUrl(p) {
    const value = Array.isArray(p.output) && p.output.length === 1 ? p.output[0] : p.output;
    let url;
    try { url = new URL(value); } catch { throw fail(410, 'The rendered file has expired or is unavailable. Export it again.', 'OUTPUT_UNAVAILABLE'); }
    if (typeof value !== 'string' || url.protocol !== 'https:' || url.username || url.password || url.port ||
        !(url.hostname === 'replicate.delivery' || url.hostname.endsWith('.replicate.delivery'))) {
      throw fail(502, 'The render service returned an unsupported file location.', 'INVALID_OUTPUT');
    }
    return url;
  }

  async function statusRender(job, res) {
    const p = await predictionFor(job);
    let progress = 0;
    for (const match of String(p.logs || '').matchAll(/JAA_PROGRESS\s+(\d+)\/(\d+)/g)) {
      if (Number(match[2]) > 0) progress = Math.max(progress, Math.min(1, Number(match[1]) / Number(match[2])));
    }
    const result = { id: job.id, status: job.status, progress: job.status === 'succeeded' ? 1 : progress };
    if (job.status === 'failed') result.error = 'Cloud rendering failed. Check the renderer deployment and try again.';
    if (job.status === 'succeeded') {
      outputUrl(p);
      result.outputUrl = `/renders/${job.id}/file?token=${encodeURIComponent(job.token)}`;
    }
    json(res, 200, result);
  }

  async function streamFile(job, req, res) {
    const p = await predictionFor(job);
    if (p.status !== 'succeeded') throw fail(409, 'The video is not ready to download.', 'NOT_READY');
    const url = outputUrl(p);
    const abort = new AbortController();
    const timeout = setTimeout(() => abort.abort(), 10 * 60 * 1000);
    const onClose = () => { if (!res.writableEnded) abort.abort(); };
    res.once('close', onClose);
    try {
      const upstream = await fetchImpl(url.href, { headers: { Authorization: `Bearer ${config.apiToken}` }, redirect: 'error', signal: abort.signal });
      if (!upstream.ok || !upstream.body) { await upstream.body?.cancel(); throw fail(502, 'The video could not be downloaded. Try the existing job again.', 'DOWNLOAD_FAILED'); }
      res.writeHead(200, {
        'Content-Type': { mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime' }[job.format],
        'Content-Disposition': `attachment; filename="jaa-export.${job.format}"`,
        ...(upstream.headers.get('content-length') && /^\d+$/.test(upstream.headers.get('content-length')) ? { 'Content-Length': upstream.headers.get('content-length') } : {}),
      });
      await pipeline(Readable.fromWeb(upstream.body), res);
    } catch (error) {
      if (error.status) throw error;
      throw fail(502, 'The video download was interrupted. Try downloading the existing job again.', 'DOWNLOAD_FAILED');
    } finally { clearTimeout(timeout); res.off('close', onClose); }
  }

  function json(res, status, value) {
    if (res.destroyed || res.writableEnded) return;
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(value));
  }

  async function handler(req, res) {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    try {
      const origin = req.headers.origin;
      if (origin && !config.origins.includes(origin)) throw fail(403, 'This website is not allowed to use the render gateway.', 'ORIGIN_DENIED');
      if (origin) { res.setHeader('Access-Control-Allow-Origin', origin); res.setHeader('Vary', 'Origin'); }
      if (req.method === 'OPTIONS') {
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, X-Request-ID');
        res.setHeader('Access-Control-Max-Age', '600');
        res.writeHead(204); res.end(); return;
      }
      const url = new URL(req.url, 'http://gateway.local');
      if (url.pathname === '/health' && req.method === 'GET') return json(res, 200, { ok: !closing });
      const access = req.headers.authorization || '';
      if (url.pathname === '/capabilities' && req.method === 'GET') {
        if (!secretEqual(access, `Bearer ${config.accessKey}`)) throw fail(401, 'Enter a valid cloud access key.', 'UNAUTHORIZED');
        return json(res, 200, { schemaVersion: 1, fontFamilies: config.fontFamilies || [], rendererVersion: config.rendererVersion });
      }
      if (url.pathname === '/renders' && req.method === 'POST') {
        if (!secretEqual(access, `Bearer ${config.accessKey}`)) throw fail(401, 'Enter a valid cloud access key.', 'UNAUTHORIZED');
        await createRender(req, res); return;
      }
      const requestMatch = url.pathname.match(/^\/requests\/([a-zA-Z0-9_-]{16,128})(\/cancel)?$/);
      if (requestMatch && ((req.method === 'GET' && !requestMatch[2]) || (req.method === 'POST' && requestMatch[2]))) {
        if (!secretEqual(access, `Bearer ${config.accessKey}`)) throw fail(401, 'Enter a valid cloud access key.', 'UNAUTHORIZED');
        let job = requests.get(requestMatch[1]);
        if (!job && requestMatch[2]) {
          if (jobs.size >= config.maxJobs) throw fail(503, 'The cloud job queue is full. Check this request again before retrying.', 'QUEUE_FULL');
          // A cancel can arrive before the original POST reaches this process.
          // Keep a bounded tombstone so that late POST cannot start paid work.
          job = { id: randomUUID(), token: randomBytes(32).toString('base64url'), requestId: requestMatch[1], status: 'canceled', cancelRequested: true, files: [], createdAt: now() };
          jobs.set(job.id, job);
          requests.set(job.requestId, job);
        }
        if (!job) throw fail(404, 'Render request not found.', 'NOT_FOUND');
        if (requestMatch[2]) await cancelJob(job);
        else if (job.predictionId) await predictionFor(job);
        return json(res, requestMatch[2] ? 202 : 200, jobView(job));
      }
      const match = url.pathname.match(/^\/renders\/([a-zA-Z0-9_-]{1,128})(?:\/(cancel|file))?$/);
      if (!match) throw fail(404, 'Route not found.', 'NOT_FOUND');
      if (!(req.method === 'GET' && match[2] === 'file') && !secretEqual(access, `Bearer ${config.accessKey}`)) throw fail(401, 'Enter a valid cloud access key.', 'UNAUTHORIZED');
      const job = jobs.get(match[1]);
      if (!job || !secretEqual(url.searchParams.get('token') || '', job.token)) throw fail(404, 'Render job not found or its access token has expired.', 'NOT_FOUND');
      if (req.method === 'GET' && !match[2]) await statusRender(job, res);
      else if (req.method === 'GET' && match[2] === 'file') await streamFile(job, req, res);
      else if (req.method === 'POST' && match[2] === 'cancel') { await cancelJob(job); json(res, 202, { id: job.id, status: job.status }); }
      else throw fail(405, 'Method not allowed.', 'METHOD_NOT_ALLOWED');
    } catch (error) {
      if (!res.headersSent) json(res, error.status || 500, { error: error.status ? error.message : 'The render gateway could not complete the request.', code: error.code || 'INTERNAL_ERROR' });
      else if (!res.writableEnded) res.destroy();
    }
  }

  let sweeping = false;
  async function sweep() {
    if (sweeping) return;
    sweeping = true;
    try {
      for (const job of jobs.values()) {
        if (!TERMINAL.has(job.status) && job.predictionId) {
          try {
            if (job.cancelRequested || now() - job.createdAt > config.cancelAfterMs) await cancelJob(job);
            else await predictionFor(job);
          } catch { /* A transient polling error must never start a second prediction. */ }
        }
        if (TERMINAL.has(job.status) && job.files.length) await deleteInputs(job);
        if (now() - job.createdAt > config.jobTtlMs && TERMINAL.has(job.status)) { jobs.delete(job.id); requests.delete(job.requestId); }
      }
    } finally { sweeping = false; }
  }
  const sweepTimer = setInterval(() => sweep().catch(() => {}), 60000);
  sweepTimer.unref();
  const server = http.createServer(handler);
  server.requestTimeout = config.uploadTimeoutMs + 10000;
  server.headersTimeout = 15000;
  server.keepAliveTimeout = 5000;
  async function close() {
    closing = true;
    clearInterval(sweepTimer);
    await Promise.allSettled([...jobs.values()].filter((job) => !TERMINAL.has(job.status)).map(cancelJob));
    await Promise.allSettled([...jobs.values()].filter((job) => TERMINAL.has(job.status)).map(deleteInputs));
    server.closeIdleConnections();
    if (server.listening) await new Promise((resolve) => server.close(resolve));
  }
  return { server, close, sweep };
}

if (require.main === module) {
  const gateway = createGateway(readConfig());
  const port = Number(process.env.PORT || 8787);
  gateway.server.listen(port, '0.0.0.0', () => console.log(`JAA render gateway listening on port ${port}`));
  for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => gateway.close().then(() => process.exit(0)));
}

module.exports = { createGateway, readConfig, validateProject };
