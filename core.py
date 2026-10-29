"""Generation timing and clip-board helpers; no assembly dependency."""
from __future__ import annotations
import json
import math

MAX_THEME_BANKS = 32
MAX_THEME_REFS = 9

def h3_frame_length(seconds: float, fps: float = 24.0) -> int:
    """Snap a requested duration to the nearest exact H3 17k+5 frame run."""
    target = max(5.0, float(seconds) * float(fps))
    lower_step = max(0, math.floor((target - 5.0) / 17.0))
    lower = 5 + lower_step * 17
    upper = lower + 17
    # Prefer the shorter run for an exact midpoint so a requested duration is
    # never expanded arbitrarily when both legal H3 runs are equally close.
    return lower if target - lower <= upper - target else upper


def resolve_director_board(board_text: str, selected_clip: int) -> dict:
    """Resolve one clip from the visual director's persisted board state."""
    try:
        board = json.loads(board_text or "{}")
    except json.JSONDecodeError as exc:
        raise ValueError(f"director board data is invalid: {exc}") from exc
    if not isinstance(board, dict):
        raise ValueError("director board data must be an object")

    defaults = board.get("default", {}) or {}
    clips = board.get("clips", {}) or {}
    if not isinstance(defaults, dict):
        raise ValueError("director board default must be an object")
    if not isinstance(clips, dict):
        raise ValueError("director board clips must be an object")

    selected = max(1, int(selected_clip))
    entry = dict(defaults)
    clip_entry = clips.get(str(selected), {}) or {}
    if not isinstance(clip_entry, dict):
        raise ValueError(f"director board clip {selected} must be an object")
    entry.update(clip_entry)

    theme = int(entry.get("theme", 1))
    if not 1 <= theme <= MAX_THEME_BANKS:
        raise ValueError(f"director board clip {selected} has invalid theme {theme}")
    return {
        "theme": theme,
        "prompt": str(entry.get("prompt", "")),
        "seed": max(0, int(entry.get("seed", 0))),
        "take": max(1, int(entry.get("take", 1))),
    }


def simple_clip_frames(seconds: float) -> int:
    seconds = float(seconds)
    if not math.isfinite(seconds) or not 0.25 <= seconds <= 10:
        raise ValueError("each clip duration must be between 0.25 and 10 seconds")
    # The nearest run to 10 seconds is 243 frames (>10s). Use the last legal
    # run within the user's independent-generation memory limit instead.
    return min(h3_frame_length(seconds), 226)


def explicit_board_timing(board_data: str, song_duration: float) -> tuple[str, dict[int, int]]:
    board = json.loads(board_data or "{}")
    clips = board.get("clips", {})
    frames = {}
    total = 0
    for index in range(1, 10000):
        entry = clips.get(str(index), {})
        if "seconds" not in entry:
            raise ValueError(f"set the duration for clip {index} in the Clip Director before queueing")
        frames[index] = simple_clip_frames(entry["seconds"])
        total += frames[index]
        if total >= song_duration * 24:
            break
    else:
        raise ValueError("the clip plan needs more than 9999 clips")
    # Reuse the original Director's frame-aligned router with a complete table.
    # Every interval is explicit, so its legacy fallback cannot affect timing.
    for index, length in frames.items():
        clips[str(index)]["seconds"] = length / 24.0
    return json.dumps(board), frames
