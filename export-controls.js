/* Shared export settings: the UI and saved projects use the same device limits. */
(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const formats = {
    mp4: { label: 'MP4', extension: '.mp4', mime: 'video/mp4' },
    webm: { label: 'WebM', extension: '.webm', mime: 'video/webm' },
    mov: { label: 'MOV', extension: '.mov', mime: 'video/quicktime' }
  };
  function normalize(settings) {
    const mobile = LyricVideoExport.isMobileDevice();
    settings.exportFormat = Object.hasOwn(formats, settings.exportFormat) ? settings.exportFormat : 'mp4';
    settings.resolution = !mobile && String(settings.resolution) === '2160' ? '2160' : '1080';
    settings.fps = [24, 30, 50, 60].includes(Number(settings.fps)) ? Number(settings.fps) : 24;
    if (mobile && settings.fps > 30) settings.fps = 30;
    settings.transparent = settings.exportFormat !== 'mp4' && !!settings.transparent;
    return settings;
  }
  function dimensions(aspect, resolution = '1080') {
    const side = String(resolution) === '2160' ? 2160 : 1080;
    return aspect === 'portrait' ? [side, side * 16 / 9] : aspect === 'square' ? [side, side] : [side * 16 / 9, side];
  }
  function refresh(state) {
    const settings = normalize(state.settings), mobile = LyricVideoExport.isMobileDevice();
    const [width, height] = dimensions(settings.aspect, settings.resolution);
    $('resolution').value = settings.resolution;
    $('fps').value = String(settings.fps);
    $('exportFormat').value = settings.exportFormat;
    $('transparent').checked = settings.transparent;
    for (const option of $('resolution').options) option.disabled = mobile && option.value === '2160';
    for (const option of $('fps').options) option.disabled = mobile && Number(option.value) > 30;
    $('mobileExportNote').hidden = !mobile;
    $('transparent').disabled = state.busy || settings.exportFormat === 'mp4';
    $('background').disabled = state.busy || settings.transparent;
    $('preview').classList.toggle('is-transparent', settings.transparent);
    $('transparencyHelp').textContent = settings.exportFormat === 'mp4'
      ? 'Choose WebM or MOV for a video with no background.'
      : 'The checkerboard is a preview guide. It is not included in your video.';
    $('exportSummary').textContent = `${width} × ${height} · ${settings.fps} fps · ${formats[settings.exportFormat].label}${settings.transparent ? ' · Transparent' : ''} · Includes your audio`;
    $('formatBadge').textContent = `${width} × ${height} / ${settings.fps} FPS`;
    $('exportSupport').textContent = settings.exportFormat === 'mp4'
      ? 'Video frames are rendered individually for consistent timing.'
      : settings.exportFormat === 'mov'
        ? 'ProRes 4444 creates large files. Export can take several minutes. Download the MOV to preview it in a compatible video editor.'
        : 'VP9 exports render every frame and can take several minutes. Transparent playback depends on the player you use.';
  }
  globalThis.JAWExportSettings = Object.freeze({ normalize, dimensions, refresh, formats });
})();
