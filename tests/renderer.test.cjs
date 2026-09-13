const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

// The renderer must clear old pixels, then omit only the background fill for alpha.
// Recording context operations also checks changing projects cannot leak transparency.
test('transparent frames clear their alpha channel and opaque frames paint the background', () => {
  const calls = [];
  const context = new Proxy({measureText: text => ({width: text.length * 70, actualBoundingBoxAscent: 76, actualBoundingBoxDescent: 4})}, {
    get(target, key) { return key in target ? target[key] : (...args) => calls.push([key, ...args]); },
    set(target, key, value) { target[key] = value; return true; }
  });
  const canvas = {width: 1920, height: 1080, getContext: (type, options) => {assert.equal(options.alpha, true); return context;}};
  const sandbox = {window: {}};
  vm.runInNewContext(fs.readFileSync('kinetic-renderer.js', 'utf8'), sandbox);
  const renderer = sandbox.window.KineticRenderer.create(canvas);
  const words = [{id: 'a', text: 'Hello', start: 0, end: 1}];
  renderer.setProject(words, {transparent: true});
  calls.length = 0;
  renderer.render(.5);
  assert.equal(calls.filter(call => call[0] === 'clearRect').length, 1);
  assert.equal(calls.filter(call => call[0] === 'fillRect').length, 0);
  assert.ok(calls.some(call => call[0] === 'fillText'));
  renderer.setProject(words, {transparent: false});
  calls.length = 0;
  renderer.render(.5);
  assert.ok(calls.some(call => call[0] === 'fillRect' && call[3] === 1920 && call[4] === 1080));
});
