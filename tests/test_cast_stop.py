from pathlib import Path
import importlib.util
import unittest

SOURCE = Path(__file__).resolve().parents[1] / "custom_components/halarm/cast_stop.py"
spec = importlib.util.spec_from_file_location("halarm_cast_stop", SOURCE)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class CastStopTests(unittest.TestCase):
    def test_nest_hub_stop(self):
        assert module.is_early_stop("playing", "off", 17, 14, 60)[0]

    def test_nest_audio_stop_idle(self):
        assert module.is_early_stop("playing", "idle", 17, 14, 60)[0]

    def test_nest_mini_stop_paused(self):
        assert module.is_early_stop("playing", "paused", 17, 14, 60)[0]

    def test_intermediate_buffering_stop(self):
        assert module.is_early_stop("buffering", "off", 20, 18, 62)[0]

    def test_natural_end_keeps_loop(self):
        stopped, reason = module.is_early_stop("playing", "idle", 61, 59.7, 60)
        assert not stopped and reason == "naturlig afslutning"

    def test_media_position_can_detect_end(self):
        stopped, reason = module.is_early_stop("playing", "idle", 40, 39, 60, 59.8)
        assert not stopped and reason == "fil tæt på slutning"

    def test_confirmed_playing_can_be_stopped_immediately(self):
        assert module.is_early_stop("playing", "idle", 1.8, 1.1, 60)[0]

    def test_off_to_idle_not_mistaken_for_stop(self):
        assert not module.is_early_stop("off", "idle", 10, 8, 60)[0]

    def test_playing_to_buffering_is_not_stop(self):
        assert not module.is_early_stop("playing", "buffering", 10, 8, 60)[0]


if __name__ == "__main__":
    unittest.main()
