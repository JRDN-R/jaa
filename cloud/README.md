# Optional cloud video export

JAA can send a project to a Replicate worker that renders the same animation and
encodes it with native FFmpeg. This is a deterministic renderer packaged with Cog;
there are no AI weights to train. It moves both drawing and encoding off the device.
The project includes words with stable IDs, timing, visual settings, audio, and
embedded custom fonts. The browser does not produce or upload a PNG for every frame.

## Connect the pieces

1. Run `npm install` and `npm run prepare:cloud` in the repository root.
2. Follow [renderer setup](replicate/README.md) to publish the Cog model to your
   Replicate account. Choose CPU hardware initially and benchmark representative
   projects. The current encoder uses CPU FFmpeg; a GPU instance alone does not
   enable GPU encoding.
3. Follow [gateway setup](gateway/README.md) to deploy the Node API on an HTTPS
   container host. Store the Replicate token only in that server's secret settings.
   Point it at the renderer's pinned version or deployment. Configure the installed
   font families and matching renderer version for preflight checks.
4. In JAA, expand **Cloud export connection**, enter the gateway URL and a separate
   gateway access key, and save. The Replicate token must never go in this form.
   The endpoint and routing preference stay on this browser; the access key is
   kept only for the current browser tab session. Saved projects contain neither.
5. Upload your chosen font in JAA, or install that exact font family in the worker
   image and declare it in the gateway. The default Linux image does not include
   Arial Black, Arial, Impact, or Georgia. Automatic routing falls back to device
   export for a missing font when device settings permit it; manual cloud export
   and unsupported mobile settings stop before starting a paid prediction.

The gateway is intended for the owner's private use with one shared access key.
A public product needs individual account authorization and quotas. Run one
gateway process/replica: its bounded job and request records are in memory. A
restart loses job tracking and retry links. Replicate's prediction deadline still
limits running work; use the Replicate dashboard to inspect any interrupted jobs.

## Routing

| Selection | Behavior after a connection is configured |
| --- | --- |
| Automatic, 4K | Cloud |
| Automatic, WebM or MOV | Cloud |
| Automatic, duration above selected 30/60/120-second cutoff | Cloud |
| Automatic on mobile | Cutoff is at most 30 seconds; above 30 fps also uses cloud |
| Automatic, other exports | Device |
| This device | Existing browser encoder, with mobile limits |
| Replicate server | Cloud, with a clear error if unavailable |

Uploading and starting a job happen only when Export is pressed. A failed cloud
prediction does not automatically start a second paid job or a device render.
Cancellation requests are retried by the gateway until terminal status or timeout;
the client reports if it cannot confirm cancellation. When rendering succeeds but
the browser cannot buffer/download the file, the existing result link can stream
it directly without another render. Download links contain a per-job access token;
do not share them unless you intend to share that video. Results are temporary, so
download them promptly.

## Cost and speed

A deployment can keep an instance ready with `min_instances: 1`, or scale to zero
with `min_instances: 0`. Warm instances avoid container startup, but you pay for
idle time as well as processing. At the [published Replicate rates](https://replicate.com/pricing)
checked September 13, 2026, four-core CPU hardware is $0.000100/second ($0.36/hour),
about **$259.20 for 30 days continuously warm**, before gateway hosting. A 60-second
active render is $0.006 at that rate; startup and idle time add to the bill. T4 is
$0.81/hour, about $583.20 for 30 days warm, and does not accelerate this CPU-only
encoder automatically. Use deployment settings to control instance counts;
the website does not change them.

Native encoding removes the current WebM/MOV PNG batching and WASM overhead, but
2x/3x speedups and nearly instant exports require measurement on the selected
hardware. A fast desktop's WebCodecs MP4 may outperform a small cloud CPU once
uploads, queueing, startup, and downloads are included. Start with one cold CPU
worker and compare 30-second and 60-second projects at 1080p and 4K before paying
for a continuously warm deployment.

## Existing Replicate models

| Model | What can be reused | Gap for a complete JAA export |
| --- | --- | --- |
| [fofr/frames-to-video](https://replicate.com/fofr/frames-to-video) | FFmpeg frame-to-MP4 encoding | Requires all frames already rendered; no audio or alpha output controls |
| [nicolascoutureau/video-utils](https://replicate.com/nicolascoutureau/video-utils) | Conversion, frame extraction, frames-to-video utilities | Does not run JAA's canvas renderer |
| [lucataco/video-audio-merge](https://replicate.com/lucataco/video-audio-merge) | Adds audio to existing video | Does not draw or accelerate the animation |
| [ayushunleashed/screenshot-kit](https://replicate.com/ayushunleashed/screenshot-kit) | Website screenshots and scrolling recordings | Recording is capped at 30 seconds; no exact frame callback for JAA |
| [sprited/birefnet-video](https://replicate.com/sprited/birefnet-video) | AI background removal | JAA already knows its alpha channel; inference can change text edges |

Creating a deployment of one of these versions gives it an endpoint and scaling
controls; it does not add missing rendering capabilities. The custom adapter here
keeps drawing, encoding, and audio in one prediction. See [Replicate deployments](https://replicate.com/docs/topics/deployments/create-a-deployment).
