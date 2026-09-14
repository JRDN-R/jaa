'use strict';
// Only bundled code runs here. User text/settings arrive through JSON, never
// HTML or script. One binary request at a time provides encoding backpressure.
window.renderJob = async () => {
  const response = await fetch('project.json');
  if (!response.ok) throw Error('Cannot read the validated render project.');
  const project = await response.json();
  for (const font of project.fonts) {
    const data = Uint8Array.from(atob(font.data), character => character.charCodeAt(0));
    const face = new FontFace(font.family, data, font.descriptors);
    document.fonts.add(await face.load());
  }
  await document.fonts.ready;
  const canvas = document.getElementById('video');
  canvas.width = project.width;
  canvas.height = project.height;
  const renderer = KineticRenderer.create(canvas);
  renderer.setProject(project.words, project.settings);
  const context = canvas.getContext('2d');
  for (let frame = 0; frame < project.totalFrames; frame++) {
    renderer.render(frame / project.settings.fps);
    const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
    const result = await fetch('frame/' + frame, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: pixels,
    });
    if (!result.ok) throw Error(await result.text());
  }
  return project.totalFrames;
};

window.renderJob().then(frames => fetch('complete', {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ frames }),
})).catch(error => fetch('error', {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ message: String(error.message || error).slice(0, 1000) }),
}));
