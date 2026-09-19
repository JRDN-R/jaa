# Just Animate Whatever

A browser lyric animation editor, published at https://jrdn-r.github.io/jaa/.

- Skip five seconds with the playback buttons, preview arrow keys, or a double tap on either half of the preview. Playback uses a real audio element and Media Session so supported system media controls can pause, resume, and seek after playback starts on the page.
- Follow current word also updates the selected-word editor and timeline selection during playback. It holds the selection while you use the editor controls or pause, and keeps the last selected word during gaps. Turn it off to select words manually while listening.
- The preview floats when scrolled out of view. Move it by the title bar, resize at its lower-right corner, or use arrow keys on either handle. It returns to the page when the original preview comes back into view.
- Pan the timeline with a drag on empty space, scroll/trackpad, or horizontal slider. Zoom with a two-finger pinch, Ctrl/Command + scroll at the cursor, the zoom menu, or the plus/minus buttons. Manual browsing turns off timeline following until re-enabled.
- Magnetic snapping supports video-frame, 10 ms, 50 ms, and 100 ms grids and nearby word edges. Hold Alt while dragging to bypass snapping. Exact time inputs remain exact. Adjust surrounding text joins the adjacent words to the edited word while protecting their outer boundaries. Both switches can be disabled. A drag and all neighbor changes form one undo step; canceled drags restore the original words.
- Export MP4 H.264, WebM VP9, or MOV ProRes 4444. WebM and MOV support a transparent background. All formats include the source audio. Desktop exports support 1080p/2160p landscape, portrait, or square at 24/30/50/60 fps. Mobile devices, including iPads in desktop mode, are limited to 1080p at 24/30 fps; saved projects are normalized to those limits.

## Export behavior

MP4 renders timestamped frames with the existing bundled Mediabunny/WebCodecs encoder. WebM and MOV download the pinned single-thread `@ffmpeg/core@0.12.10` from jsDelivr, process alpha-capable PNG frames in bounded batches, and join the encoded segments with the soundtrack. No cross-origin isolation headers are required, so GitHub Pages can serve the app unchanged. The checkerboard belongs only to the preview and never becomes part of exported frames.

MOV ProRes files can be large and should be opened in a compatible video editor. Transparent WebM display depends on the player. Software exports can take longer than the recording duration. To avoid exhausting browser memory, encoded software exports are capped at 128 MiB on mobile and 512 MiB on desktop; if a file exceeds that cap, the app reports how to reduce it. Downloading the extra encoder requires an internet connection. Actual AirPods/lock-screen behavior also depends on the device and browser; physical Apple hardware testing is needed in addition to browser automation.

## Development and deployment

This is a static site. Serve the repository root over localhost or HTTPS; there is no build step. Keep `index.html`, the adjacent JavaScript/CSS modules, and `assets/` together when deploying or downloading the app. Imported projects and the existing embedded libraries remain compatible.

Run `npm test` for deterministic timing, renderer, export-policy, and settings checks. Install development dependencies with `npm install`, then run `npm run test:browser` for the integrated desktop/mobile smoke test. `CHROME_PATH` can point to an existing Chrome executable. Additional browser tests in `tests/` exercise detailed gestures, playback races, and real exported files. Browser test screenshots and video samples are written only under ignored `work/`.
