"""Small Cog interface; renderer.py also runs without Cog for local testing."""
import tempfile
import atexit
import os
import shutil
from pathlib import Path as LocalPath

from cog import BasePredictor, Input, Path

from renderer import render


class Predictor(BasePredictor):
    def setup(self):
        # Sync predict is single-concurrency in Cog. Cleaning the previous result
        # is safe once Cog has completed its upload and accepts the next job.
        if os.environ.get("COG_MAX_CONCURRENCY", "1") != "1":
            raise ValueError("JAA requires COG_MAX_CONCURRENCY=1 per instance.")
        self._result_dir = None
        atexit.register(self._clean_previous_result)

    def _clean_previous_result(self):
        if self._result_dir:
            shutil.rmtree(self._result_dir, ignore_errors=True)
            self._result_dir = None

    def predict(
        self,
        project: Path = Input(description="JAA schemaVersion 1 JSON project, maximum 30 MiB"),
        audio: Path = Input(description="Audio or video containing audio, maximum 100 MiB"),
    ) -> Path:
        self._clean_previous_result()
        # Cog uploads the returned file after predict returns. Keep the current
        # result until the next serialized job so warm workers use bounded disk.
        result_dir = LocalPath(tempfile.mkdtemp(prefix="jaa-result-"))
        try:
            result = Path(render(LocalPath(project), LocalPath(audio), result_dir))
            self._result_dir = result_dir
            return result
        except BaseException:
            shutil.rmtree(result_dir, ignore_errors=True)
            raise
