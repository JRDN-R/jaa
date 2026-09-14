'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { createGateway, readConfig, validateProject } = require('../cloud/gateway/server.cjs');

const KEY = 'test-only-access-key-that-is-long-enough';
const auth = { Authorization: `Bearer ${KEY}`, Origin: 'https://jrdn-r.github.io' };
const config = () => readConfig({ REPLICATE_API_TOKEN: 'test-replicate-secret', JAA_RENDER_ACCESS_KEY: KEY, REPLICATE_DEPLOYMENT: 'test/jaa', JAA_RENDER_FONT_FAMILIES: 'Inter' });
const manifest = () => ({
  schemaVersion: 1, rendererVersion: 'a'.repeat(64), duration: 2,
  words: [{ id: 'one', text: 'Hello', start: 0, end: 1, emphasis: false, breakBefore: false }],
  settings: { aspect: 'wide', resolution: '1080', fps: 30, exportFormat: 'mp4', transparent: false, font: 'Inter', style: 'kinetic', background: '#000000', foreground: '#ffffff', accent: '#87a98b', motion: 1, groupSize: 4, uppercase: false },
  fonts: [],
});
function form(project = manifest(), audioSize = 6) {
  const data = new FormData();
  data.append('project', JSON.stringify(project));
  data.append('audio', new Blob([new Uint8Array(audioSize)]), 'original.wav');
  return data;
}
const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });

async function fixture(t, overrides = {}, respond) {
  const calls = [];
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'jaa-gateway-test-'));
  let count = 0;
  const gateway = createGateway({ ...config(), ...overrides }, {
    tempRoot, logger: { warn() {} },
    fetchImpl: async (url, options = {}) => {
      calls.push({ url, options });
      if (respond) {
        const response = await respond(url, options, calls);
        if (response) return response;
      }
      if (url.endsWith('/files') && options.method === 'POST') {
        const file = options.body.get('content');
        assert.ok(file instanceof Blob);
        assert.ok((await file.arrayBuffer()).byteLength);
        assert.deepEqual(JSON.parse(await options.body.get('metadata').text()), { application: 'jaa' });
        const id = `file${++count}`;
        return json({ id, urls: { get: `https://api.replicate.com/v1/files/${id}` } });
      }
      if (url.includes('/files/') && options.method === 'DELETE') return new Response(null, { status: 204 });
      if (url.endsWith('/predictions') && options.method === 'POST') return json({ id: 'prediction1', status: 'starting' });
      if (url.endsWith('/cancel')) return json({ id: 'prediction1', status: 'canceled' });
      if (url.endsWith('/predictions/prediction1')) return json({ id: 'prediction1', status: 'processing', logs: 'hello\nJAA_PROGRESS 10/30\nJAA_PROGRESS 20/30' });
      throw new Error(`Unexpected mocked request ${url}`);
    },
  });
  await new Promise((resolve) => gateway.server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await gateway.close(); await fs.rm(tempRoot, { recursive: true, force: true }); });
  return { gateway, calls, tempRoot, base: `http://127.0.0.1:${gateway.server.address().port}` };
}

test('startup requires an access secret and exactly one pinned backend', () => {
  assert.throws(() => readConfig({}), /server secrets/);
  assert.throws(() => readConfig({ REPLICATE_API_TOKEN: 'x', JAA_RENDER_ACCESS_KEY: KEY, REPLICATE_DEPLOYMENT: 'o/m', REPLICATE_VERSION: 'b'.repeat(64) }), /exactly one/);
  assert.throws(() => readConfig({ REPLICATE_API_TOKEN: 'x', JAA_RENDER_ACCESS_KEY: KEY, REPLICATE_VERSION: 'latest' }), /pinned/);
});

test('manifest validation enforces budgets and rejects executable/source fields', () => {
  assert.equal(validateProject(manifest()).duration, 2);
  for (const change of [
    (p) => { p.duration = 1801; },
    (p) => { p.settings.resolution = '4320'; },
    (p) => { p.settings.fps = 120; },
    (p) => { p.sourceUrl = 'https://localhost/private'; },
    (p) => { p.settings.command = 'curl'; },
    (p) => { p.words[0].start = -1; },
    (p) => { p.words[0].id = 1; },
    (p) => { p.words.push({ ...p.words[0] }); },
    (p) => { p.words[0].end = p.words[0].start; },
    (p) => { p.fonts = [{ family: 'font', data: 'https://attacker.test/font', descriptors: {} }]; },
  ]) { const p = manifest(); change(p); assert.throws(() => validateProject(p)); }
});

test('authentication and CORS stop jobs before any Replicate calls', async (t) => {
  const f = await fixture(t);
  const denied = await fetch(`${f.base}/renders`, { method: 'POST', body: form() });
  assert.equal(denied.status, 401);
  assert.equal((await denied.json()).code, 'UNAUTHORIZED');
  const origin = await fetch(`${f.base}/renders`, { method: 'POST', headers: { ...auth, Origin: 'https://attacker.test' }, body: form() });
  assert.equal(origin.status, 403);
  const options = await fetch(`${f.base}/renders`, { method: 'OPTIONS', headers: { Origin: auth.Origin } });
  assert.equal(options.status, 204);
  assert.equal(options.headers.get('access-control-allow-origin'), auth.Origin);
  assert.equal(f.calls.length, 0);
});

test('font and renderer preflight reject incompatible work before uploading to Replicate', async (t) => {
  const f = await fixture(t, { rendererVersion: 'a'.repeat(64) });
  assert.equal((await fetch(`${f.base}/capabilities`)).status, 401);
  const capabilities = await fetch(`${f.base}/capabilities`, { headers: auth });
  assert.deepEqual(await capabilities.json(), { schemaVersion: 1, fontFamilies: ['Inter'], rendererVersion: 'a'.repeat(64) });
  const missing = manifest(); missing.settings.font = 'Arial Black';
  const rejectedFont = await fetch(`${f.base}/renders`, { method: 'POST', headers: auth, body: form(missing) });
  assert.equal(rejectedFont.status, 400);
  assert.equal((await rejectedFont.json()).code, 'FONT_UNAVAILABLE');
  const outdated = manifest(); outdated.rendererVersion = 'b'.repeat(64);
  const rejectedVersion = await fetch(`${f.base}/renders`, { method: 'POST', headers: auth, body: form(outdated) });
  assert.equal(rejectedVersion.status, 409);
  assert.equal((await rejectedVersion.json()).code, 'RENDERER_VERSION_MISMATCH');
  assert.equal(f.calls.length, 0);
  assert.deepEqual(await fs.readdir(f.tempRoot), []);
});

test('creates deployment prediction with uploaded files, reports progress, prevents duplicate creation, and cancels', async (t) => {
  const f = await fixture(t);
  const requestId = randomUUID();
  const response = await fetch(`${f.base}/renders`, { method: 'POST', headers: { ...auth, 'X-Request-ID': requestId }, body: form() });
  const job = await response.json();
  assert.equal(response.status, 202, JSON.stringify(job));
  assert.ok(job.token.length >= 40);
  assert.ok(!JSON.stringify(job).includes('test-replicate-secret'));
  const predictionCall = f.calls.find((c) => c.url.endsWith('/deployments/test/jaa/predictions'));
  assert.equal(predictionCall.options.headers['Cancel-After'], '30m');
  assert.deepEqual(JSON.parse(predictionCall.options.body), { input: { project: 'https://api.replicate.com/v1/files/file1', audio: 'https://api.replicate.com/v1/files/file2' } });
  assert.deepEqual(await fs.readdir(f.tempRoot), []);
  const duplicate = await fetch(`${f.base}/renders`, { method: 'POST', headers: { ...auth, 'X-Request-ID': requestId }, body: form() });
  assert.equal((await duplicate.json()).id, job.id);
  assert.equal(f.calls.filter((c) => c.url.endsWith('/predictions') && c.options.method === 'POST').length, 1);
  const recovered = await fetch(`${f.base}/requests/${requestId}`, { headers: auth });
  assert.equal((await recovered.json()).token, job.token);
  assert.equal((await fetch(`${f.base}/renders/${job.id}?token=wrong`, { headers: auth })).status, 404);
  const status = await fetch(`${f.base}/renders/${job.id}?token=${job.token}`, { headers: auth });
  const progress = await status.json();
  assert.equal(progress.status, 'processing');
  assert.equal(progress.progress, 2 / 3);
  assert.ok(!('logs' in progress));
  const canceled = await fetch(`${f.base}/renders/${job.id}/cancel?token=${job.token}`, { method: 'POST', headers: auth });
  assert.equal((await canceled.json()).status, 'canceled');
  assert.equal(f.calls.filter((c) => c.options.method === 'DELETE').length, 2);
});

test('rejects oversized audio before any upstream request and removes upload files', async (t) => {
  const f = await fixture(t, { audioBytes: 4 });
  const response = await fetch(`${f.base}/renders`, { method: 'POST', headers: auth, body: form() });
  assert.equal(response.status, 413, await response.text());
  assert.equal(f.calls.length, 0);
  assert.deepEqual(await fs.readdir(f.tempRoot), []);
});

test('failed submission deletes uploaded files and redacts upstream messages', async (t) => {
  const f = await fixture(t, {}, (url, options) => url.endsWith('/predictions') && options.method === 'POST' ? json({ detail: 'test-replicate-secret' }, 500) : null);
  const response = await fetch(`${f.base}/renders`, { method: 'POST', headers: auth, body: form() });
  assert.equal(response.status, 502);
  assert.ok(!(await response.text()).includes('test-replicate-secret'));
  assert.equal(f.calls.filter((c) => c.options.method === 'DELETE').length, 2);
  assert.equal(f.calls.filter((c) => c.url.endsWith('/predictions') && c.options.method === 'POST').length, 1);
  assert.deepEqual(await fs.readdir(f.tempRoot), []);
});

test('streams successful output through gateway, never returning the Replicate URL', async (t) => {
  let delivered = false;
  const f = await fixture(t, {}, (url, options) => {
    if (url.endsWith('/predictions/prediction1')) return json({ id: 'prediction1', status: 'succeeded', output: 'https://replicate.delivery/result.mp4' });
    if (url === 'https://replicate.delivery/result.mp4') {
      assert.equal(options.redirect, 'error');
      assert.equal(options.headers.Authorization, 'Bearer test-replicate-secret');
      return new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('video')); controller.close(); delivered = true; } }));
    }
  });
  const created = await fetch(`${f.base}/renders`, { method: 'POST', headers: auth, body: form() });
  const job = await created.json();
  assert.equal((await fetch(`${f.base}/renders/${job.id}?token=${job.token}`)).status, 401);
  assert.equal((await fetch(`${f.base}/renders/${job.id}/cancel?token=${job.token}`, { method: 'POST' })).status, 401);
  assert.equal((await fetch(`${f.base}/renders/${job.id}/file?token=wrong`)).status, 404);
  const polled = await fetch(`${f.base}/renders/${job.id}?token=${job.token}`, { headers: auth });
  const result = await polled.json();
  assert.equal(result.status, 'succeeded');
  assert.ok(result.outputUrl.startsWith(`/renders/${job.id}/file?token=`));
  const download = await fetch(f.base + result.outputUrl);
  assert.equal(download.status, 200);
  assert.equal(download.headers.get('content-type'), 'video/mp4');
  assert.equal(await download.text(), 'video');
  assert.equal(delivered, true);
});

test('nonterminal cancellation stays pending and the sweep retries until confirmed', async (t) => {
  let attempts = 0;
  const f = await fixture(t, {}, (url) => url.endsWith('/cancel') ? json({ id: 'prediction1', status: ++attempts === 1 ? 'processing' : 'canceled' }) : null);
  const created = await fetch(`${f.base}/renders`, { method: 'POST', headers: auth, body: form() });
  const job = await created.json();
  const pending = await fetch(`${f.base}/renders/${job.id}/cancel?token=${job.token}`, { method: 'POST', headers: auth });
  assert.equal((await pending.json()).status, 'processing');
  assert.equal(f.calls.filter((call) => call.options.method === 'DELETE').length, 0);
  await f.gateway.sweep();
  assert.equal(attempts, 2);
  assert.equal(f.calls.filter((call) => call.options.method === 'DELETE').length, 2);
});

test('malformed cancellation never reports a paid prediction as canceled', async (t) => {
  let attempts = 0;
  const f = await fixture(t, {}, (url) => {
    if (url.endsWith('/cancel')) return json(++attempts === 1 ? { id: 'prediction1' } : { id: 'prediction1', status: 'canceled' });
  });
  const created = await fetch(`${f.base}/renders`, { method: 'POST', headers: auth, body: form() });
  const job = await created.json();
  const unknown = await fetch(`${f.base}/renders/${job.id}/cancel?token=${job.token}`, { method: 'POST', headers: auth });
  assert.equal(unknown.status, 502);
  assert.equal((await unknown.json()).code, 'INVALID_UPSTREAM');
  assert.equal(f.calls.filter((call) => call.options.method === 'DELETE').length, 0);
  await f.gateway.sweep();
  assert.equal(attempts, 2);
});

test('pinned model creation uses the version endpoint and preserves opaque file URLs', async (t) => {
  const f = await fixture(t, { deployment: '', version: 'b'.repeat(64) }, (url, options) => {
    if (url.endsWith('/files') && options.method === 'POST') {
      const name = options.body.get('content').name;
      return json({ id: name === 'project.json' ? 'file1' : 'file2', urls: { get: `https://replicate.delivery/opaque-input/${name}?signed=value` } });
    }
  });
  const created = await fetch(`${f.base}/renders`, { method: 'POST', headers: auth, body: form() });
  assert.equal(created.status, 202);
  const call = f.calls.find((entry) => entry.url.endsWith('/predictions') && entry.options.method === 'POST');
  assert.equal(call.url, 'https://api.replicate.com/v1/predictions');
  assert.deepEqual(JSON.parse(call.options.body), {
    version: 'b'.repeat(64),
    input: { project: 'https://replicate.delivery/opaque-input/project.json?signed=value', audio: 'https://replicate.delivery/opaque-input/audio.bin?signed=value' },
  });
});

test('rejects output URLs outside replicate.delivery without following them', async (t) => {
  const f = await fixture(t, {}, (url) => url.endsWith('/predictions/prediction1') ? json({ id: 'prediction1', status: 'succeeded', output: 'https://replicate.delivery.attacker.test/stolen' }) : null);
  const created = await fetch(`${f.base}/renders`, { method: 'POST', headers: auth, body: form() });
  const job = await created.json();
  const response = await fetch(`${f.base}/renders/${job.id}/file?token=${job.token}`);
  assert.equal(response.status, 502);
  assert.equal(f.calls.some((c) => c.url.includes('attacker.test')), false);
});

test('enforces active job and hourly submission limits', async (t) => {
  const f = await fixture(t, { maxActive: 1, jobsPerHour: 1 });
  assert.equal((await fetch(`${f.base}/renders`, { method: 'POST', headers: auth, body: form() })).status, 202);
  assert.equal((await fetch(`${f.base}/renders`, { method: 'POST', headers: auth, body: form() })).status, 429);
});

test('cancel by request ID during upstream creation cancels its eventual prediction', async (t) => {
  let release, creatingResolve;
  const creating = new Promise((resolve) => { creatingResolve = resolve; });
  const f = await fixture(t, {}, async (url, options) => {
    if (url.endsWith('/predictions') && options.method === 'POST') {
      creatingResolve();
      await new Promise((resolve) => { release = resolve; });
      return json({ id: 'prediction1', status: 'starting' });
    }
  });
  const requestId = randomUUID();
  const create = fetch(`${f.base}/renders`, { method: 'POST', headers: { ...auth, 'X-Request-ID': requestId }, body: form() });
  await creating;
  const cancel = await fetch(`${f.base}/requests/${requestId}/cancel`, { method: 'POST', headers: auth });
  assert.equal(cancel.status, 202);
  const pending = await cancel.json();
  assert.equal(pending.cancelRequested, true);
  assert.equal(pending.status, 'uploading');
  release();
  assert.equal((await create).status, 409);
  assert.equal(f.calls.filter((c) => c.url.endsWith('/cancel')).length, 1);
  assert.equal(f.calls.filter((c) => c.options.method === 'DELETE').length, 2);
});

test('request-ID cancellation before upload creates a tombstone that blocks late paid work', async (t) => {
  const f = await fixture(t);
  const requestId = randomUUID();
  const cancel = await fetch(`${f.base}/requests/${requestId}/cancel`, { method: 'POST', headers: auth });
  assert.equal(cancel.status, 202);
  const stopped = await cancel.json();
  assert.equal(stopped.status, 'canceled');
  assert.equal(stopped.cancelRequested, true);
  assert.ok(stopped.id && stopped.token);
  const delayedCreate = await fetch(`${f.base}/renders`, { method: 'POST', headers: { ...auth, 'X-Request-ID': requestId }, body: form() });
  assert.equal(delayedCreate.status, 200);
  assert.deepEqual(await delayedCreate.json(), stopped);
  assert.equal(f.calls.length, 0);
  assert.deepEqual(await fs.readdir(f.tempRoot), []);
});

test('browser disconnect after submission cancels the accepted job when its ID arrives', async (t) => {
  let release, creatingResolve;
  const creating = new Promise((resolve) => { creatingResolve = resolve; });
  const f = await fixture(t, {}, async (url, options) => {
    if (url.endsWith('/predictions') && options.method === 'POST') {
      creatingResolve();
      await new Promise((resolve) => { release = resolve; });
      return json({ id: 'prediction1', status: 'starting' });
    }
  });
  const requestId = randomUUID();
  const controller = new AbortController();
  const create = fetch(`${f.base}/renders`, { method: 'POST', headers: { ...auth, 'X-Request-ID': requestId }, body: form(), signal: controller.signal }).catch((error) => error);
  await creating;
  controller.abort();
  await create;
  // A separate authenticated cancellation also covers network races in close notification.
  await fetch(`${f.base}/requests/${requestId}/cancel`, { method: 'POST', headers: auth });
  release();
  for (let i = 0; i < 50 && !f.calls.some((call) => call.url.endsWith('/cancel')); i++) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(f.calls.filter((c) => c.url.endsWith('/cancel')).length, 1);
});
