"""Validation tests plus opt-in real Chromium/FFmpeg verification.

Run: JAA_NATIVE_TESTS=1 python -m unittest discover -s cloud/tests -p test_renderer.py -v
"""
import base64
import copy
import importlib.util
import json
import math
import os
import struct
import subprocess
import sys
import tempfile
import threading
import types
import unittest
import wave
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "cloud" / "replicate"))
import renderer


def project(**settings):
    return {
        "schemaVersion": 1, "rendererVersion": renderer.renderer_version(), "duration": 0.37,
        "words": [{"id": "original-1", "text": "EXACT", "start": 0, "end": 0.18},
                  {"id": "original-2", "text": "TIMING", "start": 0.18, "end": 0.37, "emphasis": True}],
        "settings": {"font": "DejaVu Sans", **settings}, "fonts": [],
    }


class ValidationTests(unittest.TestCase):
    def test_renderer_version_fails_closed_and_copied_source_matches(self):
        self.assertEqual((ROOT / "kinetic-renderer.js").read_bytes(),
                         (ROOT / "cloud/replicate/kinetic-renderer.js").read_bytes())
        data = project()
        data["rendererVersion"] = "stale-version"
        with self.assertRaisesRegex(ValueError, "versions differ"):
            renderer.validate_project(data)

    def test_allowed_settings_and_fractional_frame_rounding(self):
        for aspect, dimensions in [("wide", (3840, 2160)), ("square", (2160, 2160)), ("portrait", (2160, 3840))]:
            data = renderer.validate_project(project(aspect=aspect, resolution="2160", fps=60))
            self.assertEqual((data["width"], data["height"]), dimensions)
            self.assertEqual(data["totalFrames"], 23)
            self.assertEqual(data["words"][0]["id"], "original-1")

    def test_invalid_or_expensive_manifests_rejected(self):
        for key, value in [("duration", float("nan")), ("duration", 1801), ("duration", 0),
                           ("words", []), ("settings", {"fps": 240}),
                           ("settings", {"transparent": True, "exportFormat": "mp4"}),
                           ("settings", {"resolution": "8192"}), ("settings", {"font": 'url(https://x)'}),
                           ("settings", {"script": "alert(1)"}), ("fonts", [{"url": "https://x"}])]:
            with self.subTest(key=key, value=value):
                data = project()
                data[key] = value
                with self.assertRaises(ValueError):
                    renderer.validate_project(data)

    def test_duplicate_ids_and_invalid_fonts_rejected(self):
        data = project()
        data["words"][1]["id"] = data["words"][0]["id"]
        with self.assertRaisesRegex(ValueError, "unique"):
            renderer.validate_project(data)
        data = project()
        data["fonts"] = [{"family": "My Font", "data": base64.b64encode(b"not a font").decode()}]
        with self.assertRaisesRegex(ValueError, "valid TTF"):
            renderer.validate_project(data)

    def test_font_substitution_is_never_silent(self):
        result = mock.Mock(stdout="Liberation Sans")
        with mock.patch.object(renderer.subprocess, "run", return_value=result):
            with self.assertRaisesRegex(ValueError, 'does not have "Arial Black"'):
                renderer.require_font(renderer.validate_project(project(font="Arial Black")))
        with mock.patch.object(renderer.subprocess, "run", return_value=mock.Mock(stdout="Arial Black")):
            renderer.require_font(renderer.validate_project(project(font="Arial Black")))

    def test_precanceled_job_cannot_start_encoding(self):
        event = threading.Event()
        event.set()
        with mock.patch.object(renderer.subprocess, "Popen") as spawn:
            with self.assertRaises(renderer.RenderCanceled):
                renderer.render(Path("unused"), Path("unused"), Path("unused"), cancel_event=event)
            spawn.assert_not_called()

    def test_warm_predictor_reclaims_previous_success_and_failed_outputs(self):
        # Exercise Cog's retained output lifecycle without installing Cog or
        # contacting Replicate. Cog must be able to read the returned file until
        # the next serialized prediction begins.
        cog_stub = types.SimpleNamespace(BasePredictor=object, Path=Path,
                                         Input=lambda **_kwargs: None)
        spec = importlib.util.spec_from_file_location("jaa_predict_for_test", ROOT / "cloud/replicate/predict.py")
        wrapper = importlib.util.module_from_spec(spec)
        with mock.patch.dict(sys.modules, {"cog": cog_stub}):
            spec.loader.exec_module(wrapper)
        with tempfile.TemporaryDirectory(prefix="jaa-warm-test-") as temporary:
            outputs = []

            def make_result_dir(**_kwargs):
                directory = Path(temporary) / str(len(outputs))
                directory.mkdir()
                outputs.append(directory)
                return str(directory)

            def succeed(_project, _audio, output_dir):
                output = output_dir / "video.mp4"
                output.write_bytes(b"retained until Cog uploads this file")
                return output

            with mock.patch.object(wrapper.atexit, "register"), \
                 mock.patch.object(wrapper.tempfile, "mkdtemp", side_effect=make_result_dir), \
                 mock.patch.object(wrapper, "render", side_effect=succeed) as render_mock:
                predictor = wrapper.Predictor()
                predictor.setup()
                first = predictor.predict(Path("project"), Path("audio"))
                self.assertTrue(first.is_file())
                second = predictor.predict(Path("project"), Path("audio"))
                self.assertFalse(outputs[0].exists())
                self.assertTrue(second.is_file())
                render_mock.side_effect = renderer.RenderCanceled("Canceled")
                with self.assertRaises(renderer.RenderCanceled):
                    predictor.predict(Path("project"), Path("audio"))
                self.assertTrue(all(not directory.exists() for directory in outputs))

    def test_warm_predictor_rejects_parallel_predictions(self):
        cog_stub = types.SimpleNamespace(BasePredictor=object, Path=Path,
                                         Input=lambda **_kwargs: None)
        spec = importlib.util.spec_from_file_location("jaa_predict_for_test", ROOT / "cloud/replicate/predict.py")
        wrapper = importlib.util.module_from_spec(spec)
        with mock.patch.dict(sys.modules, {"cog": cog_stub}):
            spec.loader.exec_module(wrapper)
        with mock.patch.dict(os.environ, {"COG_MAX_CONCURRENCY": "2"}):
            with self.assertRaisesRegex(ValueError, "COG_MAX_CONCURRENCY=1"):
                wrapper.Predictor().setup()


@unittest.skipUnless(os.environ.get("JAA_NATIVE_TESTS") == "1", "Set JAA_NATIVE_TESTS=1 for real video checks")
class NativeRenderTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temporary = tempfile.TemporaryDirectory(prefix="jaa-render-tests-")
        cls.work = Path(cls.temporary.name)
        cls.audio = cls.work / "tone.wav"
        with wave.open(str(cls.audio), "wb") as audio:
            audio.setnchannels(1)
            audio.setsampwidth(2)
            audio.setframerate(48000)
            audio.writeframes(b"".join(struct.pack("<h", int(5000 * math.sin(2 * math.pi * 440 * i / 48000))) for i in range(9600)))

    @classmethod
    def tearDownClass(cls):
        cls.temporary.cleanup()

    def render_project(self, data, name, **kwargs):
        path = self.work / (name + ".json")
        path.write_text(json.dumps(data))
        return renderer.render(path, self.audio, self.work / name, **kwargs)

    def assert_video(self, output, format_name, expected_frames=9, fps=24, dimensions=(1920, 1080)):
        info = json.loads(subprocess.check_output([
            "ffprobe", "-v", "error", "-count_frames", "-show_streams", "-show_format", "-of", "json", str(output),
        ]))
        video = next(stream for stream in info["streams"] if stream["codec_type"] == "video")
        audio = next(stream for stream in info["streams"] if stream["codec_type"] == "audio")
        self.assertEqual(video["nb_read_frames"], str(expected_frames))
        self.assertEqual(video["r_frame_rate"], f"{fps}/1")
        self.assertEqual((video["width"], video["height"]), dimensions)
        self.assertEqual(audio["sample_rate"], "48000")
        self.assertEqual(audio["channels"], 2)
        self.assertLess(abs(float(info["format"]["duration"]) - expected_frames / fps), 0.03)
        self.assertEqual(video["codec_name"], {"mp4": "h264", "webm": "vp9", "mov": "prores"}[format_name])
        pcm = subprocess.check_output([
            "ffmpeg", "-v", "error", "-i", str(output), "-map", "0:a:0", "-f", "s16le", "-ac", "1", "-ar", "48000", "-",
        ])
        self.assertGreaterEqual(len(pcm), int(0.36 * 48000 * 2), "Audio duration must cover the requested duration")
        self.assertTrue(any(pcm[:12000]), "Original non-silent audio must be retained")
        tail_samples = struct.unpack("<1000h", pcm[-2000:])
        # Lossy codecs can add a few least-significant bits to encoded silence.
        self.assertLess(max(abs(value) for value in tail_samples), 8,
                        "Audio shorter than the project must be padded with silence")
        return video

    def test_real_mp4_audio_timing(self):
        output = self.render_project(project(exportFormat="mp4"), "mp4")
        self.assert_video(output, "mp4")

    def test_sustained_animation_and_native_4k_portrait(self):
        data = project(exportFormat="mp4")
        data["duration"] = 3.01
        data["words"] = [{"id": f"word-{index}", "text": text, "start": index * 0.25,
                          "end": (index + 1) * 0.25, "emphasis": index % 3 == 0}
                         for index, text in enumerate("Every single animated word keeps its original timing across this complete export".split())]
        output = self.render_project(data, "sustained")
        self.assert_video(output, "mp4", expected_frames=73)
        data = project(exportFormat="mp4", resolution="2160", aspect="portrait", fps=60)
        output = self.render_project(data, "4k")
        self.assert_video(output, "mp4", expected_frames=23, fps=60, dimensions=(2160, 3840))

    def test_real_transparent_webm_and_mov_keep_alpha_every_frame(self):
        for format_name in ("webm", "mov"):
            with self.subTest(format=format_name):
                output = self.render_project(project(exportFormat=format_name, transparent=True), format_name)
                video = self.assert_video(output, format_name)
                if format_name == "mov":
                    self.assertEqual(video["profile"], "4444")
                    self.assertTrue(video["pix_fmt"].startswith("yuva"))
                else:
                    self.assertEqual(video["tags"].get("alpha_mode", video["tags"].get("ALPHA_MODE")), "1")
                arguments = ["ffmpeg", "-v", "error"]
                if format_name == "webm":
                    arguments += ["-c:v", "libvpx-vp9"]
                arguments += ["-i", str(output), "-vf", "alphaextract", "-f", "rawvideo", "-pix_fmt", "gray", "-"]
                alpha = subprocess.check_output(arguments)
                frame_size = 1920 * 1080
                self.assertEqual(len(alpha), frame_size * 9)
                for index in range(9):
                    frame = alpha[index * frame_size:(index + 1) * frame_size]
                    self.assertEqual(frame[0], 0, "Background alpha must remain clear in every frame")
                    self.assertGreater(max(frame), 0, "Animated text must survive alpha encoding")
                self.assertGreater(max(alpha), 250)
                self.assertTrue(any(4 < value < 250 for value in alpha), "Antialiased edges must remain semitransparent")

    def test_embedded_font_renders_and_missing_family_fails(self):
        font_file = subprocess.check_output(["fc-match", "--format=%{file}", "DejaVu Sans"], text=True)
        data = project(font="JAA_Test_Embedded_Font")
        data["fonts"] = [{"family": "JAA_Test_Embedded_Font", "data": base64.b64encode(Path(font_file).read_bytes()).decode(),
                          "descriptors": {"weight": "900", "style": "normal"}}]
        output = self.render_project(data, "embedded")
        self.assert_video(output, "mp4")
        with self.assertRaisesRegex(ValueError, "does not have"):
            self.render_project(project(font="Definitely Missing Font 984327"), "missing")

    def test_browser_font_error_returns_without_waiting_for_deadline(self):
        data = project(font="Invalid Embedded Font")
        data["fonts"] = [{"family": "Invalid Embedded Font", "data": base64.b64encode(b"OTTOinvalid").decode()}]
        with self.assertRaisesRegex(RuntimeError, "Canvas rendering failed"):
            self.render_project(data, "bad-font", deadline_seconds=5)

    def test_deadline_stops_encoding_and_keeps_output_empty(self):
        data = project()
        data["duration"] = 120
        with self.assertRaises(renderer.RenderCanceled):
            self.render_project(data, "cancel", deadline_seconds=0.05)
        self.assertFalse((self.work / "cancel/video.mp4").exists())

    def test_playlist_inputs_are_rejected(self):
        playlist = self.work / "hostile.m3u8"
        playlist.write_text("#EXTM3U\n#EXTINF:10,\nhttps://example.invalid/secret\n")
        with self.assertRaisesRegex(ValueError, "supported audio"):
            renderer.validate_audio(playlist)


if __name__ == "__main__":
    unittest.main()
