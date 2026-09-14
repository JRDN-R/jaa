# JAA cloud export gateway

This small Node service keeps the Replicate API token off the public GitHub Pages site. It uploads the project and audio, creates one asynchronous prediction, checks progress and cancellation, and streams the finished video to the browser. Its backend must run the JAA renderer from [`../replicate`](../replicate), which accepts `project` and `audio` file inputs and returns one video file. Existing conversion models have different inputs and cannot be selected directly here.

## Deploy

1. Publish the JAA Cog renderer and choose its pinned model version or a deployment using that version. Follow the [renderer instructions](../replicate/README.md).
2. Copy `.env.example` to `.env` on the gateway host and fill in its settings. Use the host's secret manager in production. Set exactly one of `REPLICATE_DEPLOYMENT` and `REPLICATE_VERSION`.
3. Set `JAA_RENDERER_VERSION` to the contents of `cloud/replicate/renderer-version.txt`. List only fonts actually installed in the renderer under `JAA_RENDER_FONT_FAMILIES`; otherwise leave that list empty and upload the selected font in the editor. The server rejects missing fonts and a configured version mismatch before contacting Replicate.
4. Run one persistent Node 22+ process behind HTTPS. From this directory:

   ```sh
   npm ci
   node --env-file=.env server.cjs
   ```

   Or build and run the container with this directory as its build context:

   ```sh
   docker build -t jaa-render-gateway .
   docker run --init --env-file .env -p 8787:8787 jaa-render-gateway
   ```

5. In JAA, open **Cloud export connection**, enter the gateway's HTTPS URL and its separate `JAA_RENDER_ACCESS_KEY`, then save the connection. The Replicate API token belongs only on the gateway host.

Allow at least 512 MiB RAM and 1 GiB of writable temporary space. The reverse proxy must accept 130 MiB request bodies, allow two-minute uploads, and stream downloads for up to ten minutes. Its origin must match the URL entered in JAA. `GET /health` is an unauthenticated process health check; it does not verify Replicate credentials or model readiness.

## Limits and operation

This version is intended for a personal or small trusted deployment. The access key authorizes paid exports. Keep it private and rotate it on the host and in the browser when necessary. CORS restricts browser origins but does not replace authentication. For a public multi-user service, add individual authentication and per-user billing limits before sharing access.

Run exactly one process/replica with no autosleep. Jobs, request IDs, rate limits, and cancellation tombstones are held in memory. A restart loses this recovery state and existing download links; a load-balanced cluster will not work without a shared durable job store. Graceful shutdown requests cancellation, and every prediction also receives Replicate's `Cancel-After: 30m` deadline. A lost prediction-creation response can still represent accepted work; the gateway never automatically resubmits it. Check the Replicate dashboard before manually repeating an uncertain submission.

Defaults are two active jobs, 30 submissions per hour, and 1,000 remembered jobs. Completed jobs and cancellation tombstones expire from memory after two hours. Projects are limited to 30 minutes, 4K, 60 fps, 30 MiB of project JSON, 100 MiB of audio, and 32 embedded font faces of at most 10 MiB each. The total project limit still applies when several fonts are included.

Uploads stream to private temporary files and are removed after submission. Replicate input files are deleted after terminal completion, with cleanup retried during the minute sweep. Replicate expires remaining uploaded inputs after 24 hours. Prediction outputs expire after about one hour; download completed videos promptly. These retention rules come from the [official SDK file documentation](https://github.com/replicate/replicate-javascript#replicatefilescreate) and [Replicate HTTP API documentation](https://replicate.com/docs/reference/http).

## API

All routes except `/health` and token-bearing video downloads require `Authorization: Bearer <JAA_RENDER_ACCESS_KEY>`. Exact allowed origins are set in `JAA_ALLOWED_ORIGINS`. Browser preflight accepts `Authorization`, `Content-Type`, and `X-Request-ID`.

| Route | Purpose |
| --- | --- |
| `GET /capabilities` | Return installed font family declarations and the optional renderer source hash. |
| `POST /renders` | Multipart `project` JSON field and `audio` file; `X-Request-ID` provides submission recovery and deduplication. Returns a job ID and a random job token. |
| `GET /requests/:requestId` | Recover that job and refresh its provider status when available. |
| `POST /requests/:requestId/cancel` | Cancel pending creation or record a tombstone so a late upload cannot create paid work. |
| `GET /renders/:id?token=…` | Read status and frame progress. |
| `POST /renders/:id/cancel?token=…` | Request cancellation. A pending provider status is not a confirmation that work stopped. |
| `GET /renders/:id/file?token=…` | Stream the video with an attachment filename; this route accepts the random job token alone so the browser can download large files directly. |

Treat a video download URL as a secret: anyone with its job token can download the result. Disable or redact query strings in proxy access logs. The gateway never sends the Replicate token or raw provider logs/errors to the browser, and only downloads provider outputs from `replicate.delivery` or its subdomains.

The Files API uses the official SDK's multipart `content` and JSON `metadata` format, then passes the returned opaque `urls.get` values as prediction inputs. See [Replicate's SDK implementation](https://github.com/replicate/replicate-javascript/blob/main/lib/files.js). Deployment endpoints and prediction deadlines follow the [HTTP reference](https://replicate.com/docs/reference/http).

## Verify

From the repository root, after installing this service's dependencies:

```sh
node --test tests/cloud-gateway.test.cjs
```

These tests use a mocked provider and cover authentication, CORS, font/version preflight, file upload format, deployment and pinned-version submission, request recovery, cancellation races, download streaming, cleanup, and limits. They do not spend credits or prove that a deployed model's credentials and hardware are ready; complete one controlled end-to-end export after deployment.
