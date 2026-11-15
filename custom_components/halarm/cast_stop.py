"""Cast stop classification without depending on Home Assistant.

Cast exposes playback states, not the origin of a stop command. Only an idle
transition near a known track ending is safe to repeat. Pause/off always stop.
"""
from __future__ import annotations

import math


def is_early_stop(old_state: str, new_state: str, elapsed: float,
                  since_playing: float, duration: float | None,
                  position: float | None = None) -> tuple[bool, str]:
    """Classify a terminal transition after confirmed playback.

    elapsed is retained for API compatibility; Cast startup latency must never
    count towards the audio duration. The caller confirms ownership/playback.
    """
    if new_state not in ("off", "idle", "paused"):
        return False, "ikke en stoptilstand"
    if old_state not in ("playing", "buffering", "paused", "idle"):
        return False, "ikke fra en aktiv afspilning"
    if new_state in ("off", "paused"):
        return True, "højttaleren slukket eller sat på pause"
    if duration is not None and math.isfinite(duration) and duration > 0:
        margin = max(0.15, min(duration * 0.04, 1.5))
        if since_playing >= duration - margin:
            return False, "naturlig afslutning"
        if position is not None and math.isfinite(position) and position >= duration - margin:
            return False, "fil tæt på slutning"
    return True, "afspilningen stoppet før slutning"
