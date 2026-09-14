/* Real app/UI integration; only video encoding is mocked. No provider calls. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const puppeteer = require('puppeteer');
const root = path.resolve(__dirname, '..');
const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };
const fontPath = [process.env.TEST_FONT_FILE, '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf', '/usr/share/fonts/opentype/urw-base35/URWGothic-Book.otf', '/System/Library/Fonts/Supplemental/Arial.ttf'].find(file => file && fs.existsSync(file));
assert.ok(fontPath, 'Set TEST_FONT_FILE to a local TTF/OTF/WOFF font for the font upload check.');
const server = http.createServer((request, response) => {
  const route = decodeURIComponent(request.url.split('?')[0]);
  const file = path.resolve(root, '.' + (route === '/' ? '/index.html' : route));
  if (!file.startsWith(root + path.sep)) return response.writeHead(403).end();
  fs.readFile(file, (error, data) => {
    if (error) return response.writeHead(404).end();
    response.setHeader('Content-Type', mime[path.extname(file)] || 'application/octet-stream');
    response.end(data);
  });
});
const text = (page, selector) => page.$eval(selector, element => element.textContent);
const optionDisabled = (page, selector, value) => page.$eval(selector, (element, value) => [...element.options].find(option => option.value === value).disabled, value);
async function fill(page, selector, value) { await page.$eval(selector, (element, value) => { element.value = value; element.dispatchEvent(new Event('input', { bubbles: true })); }, value); }
async function exportAndWait(page) {
  const count = await page.evaluate(() => window.testCloud.calls.length);
  await page.click('#export');
  await page.waitForFunction(count => window.testCloud.calls.length > count && !document.querySelector('#export').disabled, {}, count);
  assert.match(await text(page, '#status'), /Export complete/);
  return page.evaluate(() => window.testCloud.calls.at(-1));
}
async function exportAndRejectBeforeRender(page, message) {
  const count = await page.evaluate(() => window.testCloud.calls.length);
  await page.click('#export');
  await page.waitForFunction(message => document.querySelector('#status').textContent.includes(message) && !document.querySelector('#export').disabled, {}, message);
  assert.equal(await page.evaluate(() => window.testCloud.calls.length), count, 'A preflight failure must not start either renderer');
}
(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const installedChrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  const browser = await puppeteer.launch({ headless: true, executablePath: process.env.CHROME_PATH || process.env.PUPPETEER_EXECUTABLE_PATH || (fs.existsSync(installedChrome) ? installedChrome : undefined), args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  try {
    for (const mobile of [false, true]) {
      const context = await browser.createBrowserContext(), page = await context.newPage(), errors = [], external = [];
      page.on('pageerror', error => errors.push(error.message));
      await page.setRequestInterception(true);
      page.on('request', request => {
        if (request.url().startsWith(base) || /^(data|blob):/.test(request.url())) return request.continue();
        external.push(request.url());
        return request.abort();
      });
      if (mobile) await page.emulate(puppeteer.KnownDevices['iPhone 13']);
      else await page.setViewport({ width: 1440, height: 1100 });
      await page.goto(base, { waitUntil: 'load' });
      await page.evaluate(() => {
        window.testCloud = { calls: [], downloads: [], blobs: new Map(), fontFamilies: ['Arial Black', 'Arial', 'Georgia', 'Verdana', 'Impact', 'Courier New'], capabilitiesCalls: 0 };
        const createURL = URL.createObjectURL.bind(URL);
        URL.createObjectURL = blob => { const url = createURL(blob); window.testCloud.blobs.set(url, blob); return url; };
        HTMLAnchorElement.prototype.click = function () { window.testCloud.downloads.push({ name: this.download, blob: window.testCloud.blobs.get(this.href) }); };
        window.LyricVideoExport = { ...window.LyricVideoExport, exportVideo: async options => {
          window.testCloud.calls.push({ target: 'local', width: options.canvas.width, height: options.canvas.height, fps: options.fps, format: options.format });
          return new Blob(['mock-local-video'], { type: 'video/' + options.format });
        } };
        window.JAWCloudExport = { ...window.JAWCloudExport, capabilities: async () => { window.testCloud.capabilitiesCalls++; return { fontFamilies: window.testCloud.fontFamilies, rendererVersion: window.testCloud.rendererVersion }; }, exportVideo: async options => {
          window.testCloud.calls.push({ target: 'cloud', endpoint: options.endpoint, accessKey: options.accessKey, project: options.project, audio: { size: options.audioFile.size, type: options.audioFile.type } });
          if (window.testCloud.failDownload) throw Object.assign(Error('Download connection interrupted.'), { downloadUrl: 'http://localhost:9999/api/renders/finished/file?token=test-output-token', jobId: 'finished' });
          options.onProgress(1, 'Mock cloud export completed.');
          return new Blob(['mock-cloud-video'], { type: options.project.settings.exportFormat === 'mov' ? 'video/quicktime' : 'video/' + options.project.settings.exportFormat });
        } };
      });
      assert.match(await text(page, '#cloudRoute'), /^This device/);
      assert.equal(await page.$eval('#exportLocation', element => element.value), 'auto');
      assert.equal(await page.evaluate(() => JAWCloudConnection.canRender()), false);
      await page.$eval('details.help', element => { element.open = true; });
      await page.click('#demo');
      await page.$eval('details.help', element => { element.open = false; });
      await page.waitForFunction(() => !document.querySelector('#export').disabled);
      assert.equal((await exportAndWait(page)).target, 'local');
      await page.select('#exportFormat', 'webm');
      assert.match(await text(page, '#cloudRoute'), /not configured/);
      assert.equal((await exportAndWait(page)).target, 'local');
      if (mobile) {
        assert.equal(await optionDisabled(page, '#resolution', '2160'), true);
        assert.equal(await optionDisabled(page, '#fps', '60'), true);
      }
      await page.$eval('#cloudEndpoint', element => { element.closest('details').open = true; });
      await fill(page, '#cloudEndpoint', 'http://localhost:9999/api/');
      await fill(page, '#cloudAccessKey', 'cloud-session-test-secret');
      assert.equal(await page.evaluate(() => JAWCloudConnection.canRender()), false, 'Typing does not change a saved connection');
      if (mobile) assert.equal(await optionDisabled(page, '#resolution', '2160'), true);
      await page.click('#saveCloudConnection');
      assert.match(await text(page, '#cloudConnectionStatus'), /Connection saved/);
      assert.equal(await page.evaluate(() => JAWCloudConnection.canRender()), true);
      await page.select('#exportFormat', 'mp4');
      assert.match(await text(page, '#cloudRoute'), /^This device/);
      assert.equal((await exportAndWait(page)).target, 'local', 'Eight-second MP4 stays on device in Auto');
      for (const format of ['webm', 'mov']) {
        await page.select('#exportFormat', format);
        assert.match(await text(page, '#cloudRoute'), /^Replicate server/);
      }
      await page.select('#exportFormat', 'mp4');
      assert.equal(await optionDisabled(page, '#resolution', '2160'), false);
      assert.equal(await optionDisabled(page, '#fps', '60'), false);
      await page.select('#resolution', '2160');
      await page.select('#fps', '60');
      assert.match(await text(page, '#cloudRoute'), /^Replicate server/);
      // Unsaved connection edits must not lower settings in the current project.
      await fill(page, '#cloudEndpoint', '');
      await fill(page, '#cloudAccessKey', '');
      await page.select('#fps', '50');
      assert.equal(await page.$eval('#resolution', element => element.value), '2160');
      assert.equal(await page.$eval('#fps', element => element.value), '50');
      assert.equal(await page.evaluate(() => JAWCloudConnection.canRender()), true);
      const highResolution = await exportAndWait(page);
      assert.equal(highResolution.target, 'cloud');
      assert.equal(highResolution.project.settings.resolution, '2160');
      assert.equal(highResolution.project.settings.fps, 50);
      assert.equal(highResolution.accessKey, 'cloud-session-test-secret');
      assert.ok(highResolution.audio.size > 0);
      await page.select('#exportLocation', 'local');
      assert.equal(await page.evaluate(() => JAWCloudConnection.canRender()), false);
      assert.match(await text(page, '#cloudRoute'), /^This device/);
      if (mobile) {
        assert.equal(await optionDisabled(page, '#resolution', '2160'), true);
        assert.equal(await page.$eval('#resolution', element => element.value), '1080');
        assert.equal(await page.$eval('#fps', element => element.value), '30');
      }
      await page.select('#exportLocation', 'auto');
      await page.select('#resolution', '1080');
      await page.select('#fps', '24');
      await page.select('#exportFormat', 'webm');
      await page.evaluate(() => { window.testCloud.fontFamilies = []; });
      assert.equal((await exportAndWait(page)).target, 'local');
      assert.match(await text(page, '#status'), /Rendered on this device because the server does not have Arial Black/);
      await page.select('#exportLocation', 'cloud');
      await exportAndRejectBeforeRender(page, 'The server does not have Arial Black');
      await page.select('#exportLocation', 'auto');
      await page.select('#resolution', '2160');
      await page.select('#fps', '60');
      if (mobile) await exportAndRejectBeforeRender(page, 'The server does not have Arial Black');
      else assert.equal((await exportAndWait(page)).target, 'local', 'Desktop can fall back locally at the chosen resolution');
      assert.equal(await page.$eval('#resolution', element => element.value), '2160', 'A missing server font must not reduce chosen quality');
      await page.select('#resolution', '1080');
      await page.select('#fps', '24');
      await page.evaluate(() => { window.testCloud.fontFamilies = ['Arial Black']; window.testCloud.rendererVersion = 'outdated'; });
      await exportAndRejectBeforeRender(page, 'The cloud renderer needs an update');
      await page.evaluate(() => { window.testCloud.rendererVersion = undefined; window.testCloud.failDownload = true; });
      const beforeDownloadFailure = await page.evaluate(() => window.testCloud.calls.length);
      await page.click('#export');
      await page.waitForFunction(() => document.querySelector('#status').textContent.startsWith('Your cloud video is ready') && !document.querySelector('#export').disabled);
      assert.equal(await page.evaluate(() => window.testCloud.calls.length), beforeDownloadFailure + 1);
      assert.equal(await page.$eval('#result', element => element.hidden), false);
      assert.equal(await text(page, '#download'), 'Download completed video');
      assert.equal(await page.$eval('#download', element => element.href), 'http://localhost:9999/api/renders/finished/file?token=test-output-token');
      assert.equal(await page.$eval('#download', element => element.rel), 'noreferrer');
      await page.$eval('#download', element => element.click());
      assert.equal(await page.evaluate(() => window.testCloud.calls.length), beforeDownloadFailure + 1, 'Download retry must not create another paid render');
      await page.evaluate(() => { window.testCloud.failDownload = false; });
      assert.equal((await exportAndWait(page)).target, 'cloud');
      assert.equal(await text(page, '#download'), 'Download again');
      assert.equal(await page.$eval('#download', element => element.target), '');
      await page.evaluate(() => { window.testCloud.fontFamilies = []; });
      const fontInput = await page.$('#fontFile');
      await fontInput.uploadFile(fontPath);
      await page.waitForFunction(() => document.querySelector('#status').textContent === 'Custom font loaded.');
      await page.select('#exportFormat', 'webm');
      const fontExport = await exportAndWait(page);
      assert.equal(fontExport.target, 'cloud');
      assert.equal(fontExport.project.fonts.length, 1);
      assert.equal(fontExport.project.fonts[0].family, fontExport.project.settings.font);
      assert.equal(fontExport.project.fonts[0].data, fs.readFileSync(fontPath).toString('base64'));
      assert.equal(fontExport.project.rendererVersion.length, 64);
      assert.equal(JSON.stringify(fontExport.project).includes('cloud-session-test-secret'), false);
      await page.click('#saveProject');
      await page.waitForFunction(() => window.testCloud.downloads.some(download => download.name.endsWith('.lyric.json')) && !document.querySelector('#saveProject').disabled);
      const saved = await page.evaluate(async () => {
        const project = await window.testCloud.downloads.find(download => download.name.endsWith('.lyric.json')).blob.text();
        return { project, local: JSON.stringify({ ...localStorage }), sessionKey: sessionStorage.getItem('jaw-cloud-access-v1') };
      });
      assert.equal(saved.project.includes('cloud-session-test-secret'), false);
      assert.equal(saved.local.includes('cloud-session-test-secret'), false);
      assert.equal(saved.sessionKey, 'cloud-session-test-secret');
      assert.equal(JSON.parse(saved.project).customFont.kind, 'file');
      assert.deepEqual(errors, []);
      assert.equal(external.some(url => /replicate|localhost:9999/.test(url)), false, 'No real cloud API requests');
      console.log(`PASS ${mobile ? 'mobile' : 'desktop'}: automatic routing, 4K/50fps, font/version preflight, embedded fonts, completed-download retry, and credential isolation`);
      await context.close();
    }
  } finally { await browser.close(); server.close(); }
})().catch(error => { console.error(error); server.close(); process.exitCode = 1; });
