"""Deterministic Canvas -> binary RGBA -> native FFmpeg export.

No model weights, arbitrary scripts, remote font URLs, PNG frames, or per-frame
base64 transport are involved. Chromium and FFmpeg run only for an active job.
"""
from __future__ import annotations

import argparse
import base64
import binascii
import hashlib
import json
import math
import os
import re
import secrets
import shutil
import signal
import subprocess
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path


HERE = Path(__file__).resolve().parent
MAX_PROJECT_BYTES = 30 * 1024 * 1024
MAX_AUDIO_BYTES = 100 * 1024 * 1024
MAX_FONT_BYTES = 10 * 1024 * 1024
MAX_DURATION = 1800
MAX_RENDER_SECONDS = 1800
MEDIA_FORMATS = "wav,mp3,mov,ogg,flac,matroska,webm,aac,aiff"
SETTINGS_KEYS = {
    "aspect", "resolution", "fps", "exportFormat", "transparent", "font",
    "style", "motion", "groupSize", "uppercase", "background", "foreground", "accent",
}
DEFAULTS = {
    "aspect": "wide", "resolution": "1080", "fps": 24, "exportFormat": "mp4",
    "transparent": False, "font": "Arial Black", "style": "kinetic", "motion": 1,
    "groupSize": 5, "uppercase": False, "background": "#000000",
    "foreground": "#ffffff", "accent": "#87a98b",
}


class RenderCanceled(RuntimeError):
    pass


def renderer_version() -> str:
    return hashlib.sha256((HERE / "kinetic-renderer.js").read_bytes()).hexdigest()


def finite_number(value, label: str, low: float, high: float) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ValueError(f"{label} must be a number.")
    if not math.isfinite(value) or not low <= value <= high:
        raise ValueError(f"{label} must be between {low} and {high}.")
    return value


def family_name(value) -> str:
    if not isinstance(value, str) or not value.strip() or len(value) > 100:
        raise ValueError("Font family must contain 1–100 characters.")
    if re.search(r"[\x00-\x1f\x7f<>\"'\\;{}:]", value):
        raise ValueError("Font family contains unsupported characters.")
    return value


def validate_project(data: dict, expected_version: str | None = None) -> dict:
    if not isinstance(data, dict) or data.get("schemaVersion") != 1:
        raise ValueError("This server requires a schemaVersion 1 JAA project.")
    if set(data) - {"schemaVersion", "rendererVersion", "words", "settings", "duration", "fonts"}:
        raise ValueError("The project contains unsupported fields. Reload the app.")
    if data.get("rendererVersion") != (expected_version or renderer_version()):
        raise ValueError("The cloud renderer and website versions differ. Update the cloud model or use browser export.")
    duration = finite_number(data.get("duration"), "Duration", 0.001, MAX_DURATION)
    raw_settings = data.get("settings", {})
    if not isinstance(raw_settings, dict) or set(raw_settings) - SETTINGS_KEYS:
        raise ValueError("The project has unsupported settings.")
    settings = {**DEFAULTS, **raw_settings}
    for key, choices in {
        "aspect": ("wide", "square", "portrait"), "resolution": ("1080", "2160"),
        "exportFormat": ("mp4", "webm", "mov"), "style": ("kinetic", "stack", "spotlight"),
    }.items():
        if settings[key] not in choices:
            raise ValueError(f"Unsupported {key}.")
    if type(settings["fps"]) is not int or settings["fps"] not in (24, 30, 50, 60):
        raise ValueError("Frame rate must be 24, 30, 50, or 60.")
    for key in ("transparent", "uppercase"):
        if type(settings[key]) is not bool:
            raise ValueError(f"{key} must be true or false.")
    if settings["transparent"] and settings["exportFormat"] == "mp4":
        raise ValueError("MP4 cannot preserve transparency. Choose WebM or MOV.")
    finite_number(settings["motion"], "Motion", 0, 2)
    if type(settings["groupSize"]) is not int or not 2 <= settings["groupSize"] <= 9:
        raise ValueError("Group size must be an integer from 2 to 9.")
    settings["font"] = family_name(settings["font"])
    for key in ("background", "foreground", "accent"):
        if not isinstance(settings[key], str) or not re.fullmatch(r"#[0-9a-fA-F]{6}", settings[key]):
            raise ValueError(f"{key} must be a six-digit hex color.")
    input_words = data.get("words")
    if not isinstance(input_words, list) or not 1 <= len(input_words) <= 50000:
        raise ValueError("The project needs 1–50,000 timed words.")
    words, used_ids = [], set()
    for word in input_words:
        if not isinstance(word, dict):
            raise ValueError("Every word must be an object.")
        word_id, text = word.get("id"), word.get("text")
        if not isinstance(word_id, str) or not word_id or len(word_id) > 200 or word_id in used_ids:
            raise ValueError("Word IDs must be unique strings, preserved from the editor.")
        if not isinstance(text, str) or not text.strip() or len(text) > 1000:
            raise ValueError("Each word needs 1–1,000 text characters.")
        start = finite_number(word.get("start"), "Word start", 0, MAX_DURATION)
        end = finite_number(word.get("end"), "Word end", 0, MAX_DURATION)
        if end <= start:
            raise ValueError("Each word must end after it starts.")
        # Preserve every renderer-relevant field and stable ID; discard editor
        # metadata instead of passing unrecognized input through to the page.
        normalized = {"id": word_id, "text": text, "start": start, "end": end}
        for key in ("emphasis", "breakBefore"):
            if key in word:
                if type(word[key]) is not bool:
                    raise ValueError(f"Word {key} must be true or false.")
                normalized[key] = word[key]
        words.append(normalized)
        used_ids.add(word_id)
    raw_fonts = data.get("fonts", [])
    if not isinstance(raw_fonts, list) or len(raw_fonts) > 32:
        raise ValueError("Provide at most 32 embedded font faces.")
    fonts = []
    for font in raw_fonts:
        if not isinstance(font, dict) or set(font) - {"family", "data", "descriptors"}:
            raise ValueError("Fonts must contain family, embedded data, and optional descriptors.")
        family = family_name(font.get("family"))
        encoded = font.get("data")
        if not isinstance(encoded, str) or len(encoded) > math.ceil(MAX_FONT_BYTES / 3) * 4:
            raise ValueError("Each embedded font must be smaller than 10 MiB.")
        try:
            decoded = base64.b64decode(encoded, validate=True)
        except (ValueError, binascii.Error) as error:
            raise ValueError("Font data must be plain base64 bytes.") from error
        if len(decoded) > MAX_FONT_BYTES or decoded[:4] not in (b"\x00\x01\x00\x00", b"OTTO", b"wOFF", b"wOF2", b"ttcf", b"true", b"typ1"):
            raise ValueError("Provide a valid TTF, OTF, WOFF, or WOFF2 font.")
        descriptors = font.get("descriptors", {})
        if not isinstance(descriptors, dict) or set(descriptors) - {"weight", "style", "stretch", "unicodeRange"}:
            raise ValueError("Unsupported embedded font descriptors.")
        for key, value in descriptors.items():
            if not isinstance(value, str) or len(value) > 4096 or re.search(r"[\x00-\x1f<>\"'\\;{}()]", value):
                raise ValueError(f"Invalid font {key} descriptor.")
        fonts.append({"family": family, "data": encoded, "descriptors": descriptors})
    side = int(settings["resolution"])
    width, height = {
        "wide": (side * 16 // 9, side), "square": (side, side),
        "portrait": (side, side * 16 // 9),
    }[settings["aspect"]]
    return {"settings": settings, "words": words, "fonts": fonts, "duration": duration,
            "width": width, "height": height,
            "totalFrames": max(1, math.ceil(duration * settings["fps"] - 1e-9))}


def load_project(path: Path) -> dict:
    if not path.is_file() or path.stat().st_size > MAX_PROJECT_BYTES:
        raise ValueError("The project must be a JSON file smaller than 30 MiB.")
    try:
        data = json.loads(path.read_text(encoding="utf-8"),
                          parse_constant=lambda value: (_ for _ in ()).throw(ValueError("Non-finite JSON number.")))
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise ValueError("The project is not a valid UTF-8 JSON file.") from error
    return validate_project(data)


def require_font(project: dict) -> None:
    family = project["settings"]["font"]
    if any(font["family"] == family for font in project["fonts"]):
        return
    result = subprocess.run(["fc-match", "--format=%{family}", family],
                            capture_output=True, text=True, timeout=10, check=True)
    families = {item.strip().casefold() for item in result.stdout.split(",")}
    if family.casefold() not in families:
        raise ValueError(f'The cloud server does not have "{family}". Upload that font in the editor, '
                         "ask the operator to install it, or use browser export.")


def chromium_executable() -> str:
    configured = os.environ.get("JAA_CHROMIUM_EXECUTABLE")
    if configured:
        if not Path(configured).is_file() or not os.access(configured, os.X_OK):
            raise ValueError("JAA_CHROMIUM_EXECUTABLE must name an executable Chromium binary.")
        return configured
    cache = os.environ.get("PLAYWRIGHT_BROWSERS_PATH")
    if cache == "0":
        import playwright
        root = Path(playwright.__file__).resolve().parent / "driver/package/.local-browsers"
    elif cache:
        root = Path(cache)
    else:
        root = Path(os.environ.get("XDG_CACHE_HOME", Path.home() / ".cache")) / "ms-playwright"
    # Playwright pins and installs Chromium, but its automation connection would
    # copy raw frame POST bodies through CDP. Launch the bundled headless shell
    # directly; only the private local HTTP bridge handles frame traffic.
    candidates = sorted(root.glob("chromium_headless_shell-*/chrome-linux*/headless_shell"),
                        key=lambda item: item.stat().st_mtime, reverse=True)
    for candidate in candidates:
        if candidate.is_file() and os.access(candidate, os.X_OK):
            return str(candidate)
    raise ValueError("Chromium is missing. Run python -m playwright install --with-deps chromium.")


def validate_audio(path: Path) -> None:
    if not path.is_file() or not 1 <= path.stat().st_size <= MAX_AUDIO_BYTES:
        raise ValueError("Audio must be a file between 1 byte and 100 MiB.")
    result = subprocess.run([
        "ffprobe", "-v", "error", "-protocol_whitelist", "file,pipe",
        "-format_whitelist", MEDIA_FORMATS, "-select_streams", "a:0",
        "-show_entries", "stream=codec_type", "-of", "json", str(path.resolve()),
    ], capture_output=True, text=True, timeout=30)
    if result.returncode or not json.loads(result.stdout or "{}").get("streams"):
        raise ValueError("Upload a supported audio file, or a video containing an audio track.")


def ffmpeg_command(project: dict, audio_path: Path, output: Path, threads: int) -> list[str]:
    settings = project["settings"]
    command = [
        "ffmpeg", "-hide_banner", "-loglevel", "error", "-nostdin", "-y",
        "-f", "rawvideo", "-pixel_format", "rgba", "-video_size",
        f'{project["width"]}x{project["height"]}', "-framerate", str(settings["fps"]), "-i", "pipe:0",
        "-protocol_whitelist", "file,pipe", "-format_whitelist", MEDIA_FORMATS,
        "-i", str(audio_path.resolve()), "-map", "0:v:0", "-map", "1:a:0",
        "-map_metadata", "-1", "-threads", str(threads), "-filter_threads", str(threads),
    ]
    format_name = settings["exportFormat"]
    if format_name == "mp4":
        command += ["-c:v", "libx264", "-preset", "veryfast", "-crf", "18", "-pix_fmt", "yuv420p",
                    "-movflags", "+faststart", "-c:a", "aac", "-b:a", "192k"]
    elif format_name == "webm":
        command += ["-c:v", "libvpx-vp9", "-deadline", "realtime", "-cpu-used", "6",
                    "-row-mt", "1", "-tile-columns", "2", "-b:v", "0", "-crf", "24",
                    "-lag-in-frames", "0", "-auto-alt-ref", "0",
                    "-pix_fmt", "yuva420p" if settings["transparent"] else "yuv420p",
                    "-c:a", "libopus", "-b:a", "192k"]
        if settings["transparent"]:
            # Lossy VP9 can turn zero alpha into 1/255, leaving a faint full-frame
            # rectangle when composited. Preserve the alpha plane exactly.
            command += ["-lossless", "1", "-crf", "0"]
    else:
        command += ["-c:v", "prores_ks", "-profile:v", "4", "-pix_fmt", "yuva444p10le",
                    "-alpha_bits", "16", "-c:a", "pcm_s16le"]
    command += ["-ar", "48000", "-ac", "2", "-af",
                f'apad,atrim=duration={project["duration"]:.9f}', str(output)]
    return command


class FrameBridge(HTTPServer):
    allow_reuse_address = False

    def __init__(self, project: dict, encoder, canceled: threading.Event):
        self.project, self.encoder, self.canceled = project, encoder, canceled
        self.prefix = "/" + secrets.token_urlsafe(24) + "/"
        self.frame_index, self.failure, self.last_progress = 0, None, 0.0
        self.completed = threading.Event()
        self.project_bytes = json.dumps(project, separators=(",", ":")).encode()
        self.assets = {
            "": ((HERE / "render-page.html").read_bytes(), "text/html; charset=utf-8"),
            "kinetic-renderer.js": ((HERE / "kinetic-renderer.js").read_bytes(), "text/javascript"),
            "render-page.js": ((HERE / "render-page.js").read_bytes(), "text/javascript"),
            "project.json": (self.project_bytes, "application/json"),
        }
        super().__init__(("127.0.0.1", 0), FrameHandler)

    @property
    def origin(self):
        return f"http://127.0.0.1:{self.server_port}"


class FrameHandler(BaseHTTPRequestHandler):
    def log_message(self, *_args):
        pass

    def reply(self, status: int, body: bytes = b"", content_type: str = "text/plain"):
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Security-Policy", "default-src 'none'; script-src 'self'; connect-src 'self'; font-src 'self'")
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        bridge = self.server
        if self.path.startswith(bridge.prefix):
            asset = bridge.assets.get(self.path[len(bridge.prefix):])
            if asset:
                self.reply(200, *asset)
                return
        self.reply(404)

    def do_POST(self):
        bridge = self.server
        try:
            if self.headers.get("Origin") != bridge.origin:
                raise ValueError("Invalid frame origin.")
            if self.path in (bridge.prefix + "complete", bridge.prefix + "error"):
                length = int(self.headers.get("Content-Length", "-1"))
                if self.headers.get("Content-Type") != "application/json" or not 1 <= length <= 8192:
                    raise ValueError("Invalid render completion message.")
                message = json.loads(self.rfile.read(length))
                if not isinstance(message, dict):
                    raise ValueError("Invalid render completion message.")
                if self.path.endswith("/error"):
                    bridge.failure = "Canvas rendering failed: " + str(message.get("message", "Unknown error"))[:1000]
                elif message.get("frames") != bridge.frame_index or bridge.frame_index != bridge.project["totalFrames"]:
                    raise ValueError("The renderer returned an incomplete video.")
                self.reply(200)
                bridge.completed.set()
                return
            if self.path != bridge.prefix + "frame/" + str(bridge.frame_index):
                raise ValueError("Unexpected or duplicate render frame.")
            expected = bridge.project["width"] * bridge.project["height"] * 4
            if self.headers.get("Content-Type") != "application/octet-stream" or int(self.headers.get("Content-Length", "-1")) != expected:
                raise ValueError("Invalid RGBA frame length.")
            if bridge.frame_index >= bridge.project["totalFrames"] or bridge.canceled.is_set():
                raise RenderCanceled("Render canceled or timed out.")
            self.connection.settimeout(30)
            remaining = expected
            while remaining:
                if bridge.canceled.is_set():
                    raise RenderCanceled("Render canceled or timed out.")
                chunk = self.rfile.read(min(remaining, 128 * 1024))
                if not chunk:
                    raise ValueError("Incomplete RGBA frame.")
                bridge.encoder.stdin.write(chunk)
                remaining -= len(chunk)
            bridge.encoder.stdin.flush()
            bridge.frame_index += 1
            if time.monotonic() - bridge.last_progress >= 2:
                print(f'JAA_PROGRESS {bridge.frame_index}/{bridge.project["totalFrames"]}', flush=True)
                bridge.last_progress = time.monotonic()
            self.reply(200)
        except (ValueError, OSError, RenderCanceled) as error:
            bridge.failure = str(error)
            bridge.completed.set()
            try:
                self.reply(400, str(error).encode())
            except OSError:
                pass


def stop_process(process) -> None:
    if process is not None and process.poll() is None:
        try:
            process.terminate()
        except ProcessLookupError:
            return
        try:
            process.wait(timeout=3)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait(timeout=3)


def render(project_path: Path, audio_path: Path, output_dir: Path,
           *, cancel_event: threading.Event | None = None, deadline_seconds: float = MAX_RENDER_SECONDS) -> Path:
    """Render one project and atomically publish its successful output only."""
    canceled = cancel_event or threading.Event()
    if canceled.is_set():
        raise RenderCanceled("Render canceled.")
    project = load_project(project_path)
    validate_audio(audio_path)
    require_font(project)
    chromium = chromium_executable()

    encoder = bridge = browser = timer = temporary = None
    server_thread = None
    previous_handlers = {}
    started = time.monotonic()
    deadline_seconds = max(0.001, min(float(deadline_seconds), MAX_RENDER_SECONDS))

    def cancel(_signum=None, _frame=None):
        canceled.set()
        stop_process(encoder)
        stop_process(browser)

    if threading.current_thread() is threading.main_thread():
        for signum in (signal.SIGTERM, signal.SIGINT):
            previous_handlers[signum] = signal.getsignal(signum)
            signal.signal(signum, cancel)
    try:
        temporary = tempfile.TemporaryDirectory(prefix="jaa-render-")
        work = Path(temporary.name)
        output = work / ("video." + project["settings"]["exportFormat"])
        threads = max(1, min(16, len(os.sched_getaffinity(0)) if hasattr(os, "sched_getaffinity") else os.cpu_count() or 1))
        with (work / "encoder.log").open("wb") as log, (work / "browser.log").open("wb") as browser_log:
            encoder = subprocess.Popen(ffmpeg_command(project, audio_path, output, threads),
                                       stdin=subprocess.PIPE, stdout=subprocess.DEVNULL, stderr=log)
            timer = threading.Timer(deadline_seconds, cancel)
            timer.daemon = True
            timer.start()
            bridge = FrameBridge(project, encoder, canceled)
            server_thread = threading.Thread(target=bridge.serve_forever, kwargs={"poll_interval": 0.1}, daemon=True)
            server_thread.start()
            browser = subprocess.Popen([
                chromium, "--headless", "--no-sandbox", "--disable-dev-shm-usage",
                "--no-first-run", "--disable-background-networking", "--disable-extensions",
                "--disable-sync", "--mute-audio", "--hide-scrollbars",
                "--user-data-dir=" + str(work / "chromium"), bridge.origin + bridge.prefix,
            ], stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=browser_log)
            # CSP restricts scripts, fonts, and connections to the local
            # bridge. Completion/error callbacks replace browser automation.
            while not bridge.completed.wait(0.1):
                if canceled.is_set():
                    raise RenderCanceled("Render canceled or timed out.")
                if encoder.poll() not in (None, 0):
                    details = (work / "encoder.log").read_text(errors="replace")[-3000:]
                    raise RuntimeError("Native video encoding failed: " + details)
                if browser.poll() is not None:
                    raise RuntimeError("Chromium exited before completing the video.")
            if canceled.is_set():
                raise RenderCanceled("Render canceled or timed out.")
            frames = bridge.frame_index
            if bridge.failure or frames != project["totalFrames"]:
                raise RuntimeError(bridge.failure or "The renderer returned an incomplete video.")
            encoder.stdin.close()
            remaining = max(0.001, deadline_seconds - (time.monotonic() - started))
            encoder.wait(timeout=remaining)
            if canceled.is_set():
                raise RenderCanceled("Render canceled or timed out.")
            if encoder.returncode:
                details = (work / "encoder.log").read_text(errors="replace")[-3000:]
                raise RuntimeError("Native video encoding failed: " + details)
            if not output.is_file() or output.stat().st_size < 256:
                raise RuntimeError("The renderer returned an empty video.")
            print(f'JAA_PROGRESS {frames}/{frames}', flush=True)
            output_dir.mkdir(parents=True, exist_ok=True)
            destination = output_dir / output.name
            shutil.move(str(output), destination)
            print(f'Rendered {frames} frames in {time.monotonic() - started:.2f}s', flush=True)
            return destination
    except BaseException as error:
        if canceled.is_set():
            raise RenderCanceled("Render canceled or timed out.") from error
        raise
    finally:
        if timer:
            timer.cancel()
        stop_process(encoder)
        if encoder and encoder.stdin and not encoder.stdin.closed:
            try:
                encoder.stdin.close()
            except OSError:
                pass
        stop_process(browser)
        if bridge:
            bridge.shutdown()
            bridge.server_close()
        if server_thread:
            server_thread.join(timeout=2)
        if temporary:
            temporary.cleanup()
        for signum, handler in previous_handlers.items():
            signal.signal(signum, handler)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Render a JAA project with native FFmpeg.")
    parser.add_argument("project", type=Path)
    parser.add_argument("audio", type=Path)
    parser.add_argument("output_dir", type=Path)
    args = parser.parse_args()
    print(render(args.project, args.audio, args.output_dir))
