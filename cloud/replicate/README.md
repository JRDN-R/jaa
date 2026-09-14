# JAA native renderer for Replicate

This is a small deterministic Cog model. It runs the **same** `kinetic-renderer.js`
as the editor, renders at exact `frame / fps` timestamps, streams raw RGBA through
a local binary HTTP connection to native FFmpeg, then includes the original audio.
It does not use AI model weights. Only one frame is in flight. Transparent WebM
uses one continuous VP9 encoder with lossless alpha, preserving fully clear
backgrounds and semitransparent edges across the complete video. This can produce
larger files than lossy WebM.

Playwright installs the pinned Chromium build. At runtime the renderer starts
Chromium directly, with no browser automation connection. This prevents debugging
protocol instrumentation from copying each large RGBA frame. A private local
HTTP bridge provides frame backpressure and completion/error callbacks.

## Build and publish

From the repository root, run `node scripts/prepare-replicate.cjs` before building.
This copies the browser renderer into this directory and updates the version hash
loaded by the website. A different server/browser hash fails visibly instead of
silently changing the exported animation.

Install [Cog](https://github.com/replicate/cog), sign in with `cog login`, and build
from this directory. After creating a private Replicate model, publish with:

```sh
cd cloud/replicate
cog push r8.im/YOUR_ACCOUNT/jaa-renderer
```

Use the published immutable version ID in the trusted proxy, or create a Replicate
deployment from that version. Replicate's hardware controls set CPU capacity and
instance count; the Cog image requests no GPU. The renderer uses up to 16 available
CPU threads. Rendering still needs a benchmark on your chosen hardware; a warm
instance avoids startup but continues accruing instance charges while idle.

The default image installs DejaVu fonts. **It does not include proprietary Arial
Black, Impact, Arial, or Georgia.** The renderer refuses to substitute another
font when the selected family is unavailable. Upload your licensed font through
the editor so it is embedded in the job, or add your legally redistributable font
files to the image and run `fc-cache -f`. The browser uses synthetic weight 900
when a face lacks a real 900 weight, matching the existing editor behavior.

## Input and output

Cog input is `{ "project": "<uploaded JSON URL>", "audio": "<uploaded media URL>" }`.
The successful output is one `.mp4`, `.webm`, or `.mov` file URL. The JSON shape is:

```json
{
  "schemaVersion": 1,
  "rendererVersion": "SHA256_OF_KINETIC_RENDERER_JS",
  "duration": 12.35,
  "words": [{"id":"existing-word-id","text":"Hello","start":0,"end":1,"emphasis":false,"breakBefore":false}],
  "settings": {"aspect":"wide","resolution":"1080","fps":24,"exportFormat":"webm","transparent":true,"font":"Your Font"},
  "fonts": [{"family":"Your Font","data":"BASE64_FONT_BYTES","descriptors":{"weight":"900","style":"normal"}}]
}
```

Preserve word IDs because they determine animation layout. Supported resolutions
are `1080` and `2160`; aspects are `wide`, `square`, `portrait`; frame rates are
24/30/50/60. Other visual settings are the editor's colors, motion, style, group
size, and uppercase. Custom fonts permit embedded TTF/OTF/WOFF/WOFF2 bytes and
weight/style/stretch/unicodeRange descriptors. Font URLs, CSS, and scripts are not
accepted. Outbound browser requests are blocked, and FFmpeg accepts only supported
media demuxers with local file/pipe protocols. No API secrets belong in this image
or the website.

Limits: project 30 MiB, audio 100 MiB, each font 10 MiB, 32 font faces, 50,000 words,
30 minutes of video, and 30 minutes elapsed render time. The audio input can be a
video with an audio track; only its audio is used, as in the current app. Short audio
is padded with silence to the requested duration. Video includes exactly
`ceil(duration * fps)` frames and may end less than one frame after the audio.

## Verify locally

Install native `ffmpeg`, `fontconfig`, and Python dependencies, then:

```sh
python -m pip install playwright==1.55.0
python -m playwright install --with-deps chromium
node scripts/prepare-replicate.cjs
JAA_NATIVE_TESTS=1 python -m unittest discover -s cloud/tests -p test_renderer.py -v
python cloud/replicate/renderer.py project.json audio.wav ./render-output
```

`JAA_CHROMIUM_EXECUTABLE` can select an existing local Chromium executable. The
native tests verify MP4 audio/timing, transparent WebM and ProRes alpha on every
frame, a sustained animation, 4K portrait at 60 fps, embedded fonts, missing-font
rejection, browser error reporting, cancellation, version mismatch, warm worker
cleanup, and untrusted input rejection. They do not establish production speed
or cost.
The renderer deletes intermediates after each job. Cog needs the current returned
file until its upload completes; the next serialized prediction deletes that
previous result. This bounds retained output to one job on a warm worker. Keep
Cog's default **one prediction per instance** (`COG_MAX_CONCURRENCY=1`); setup
rejects other values. Increase deployment instance count to run jobs in parallel.
