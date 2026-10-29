"""Music-video generation nodes for MV_Maker."""
from __future__ import annotations
import json
import re
from pathlib import Path
import folder_paths
from .core import MAX_THEME_BANKS, MAX_THEME_REFS, explicit_board_timing, resolve_director_board

CATEGORY = "conditioning/minimax/MV Maker"

class MiniMaxH3SimpleDirector:
    EMPTY_BOARD = json.dumps({"version": 1, "default": {"theme": 1, "prompt": "", "seed": 0, "take": 1}, "clips": {}}, separators=(",", ":"))

    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {
            "master_audio": ("AUDIO",),
            "selected_clip": ("INT", {"default": 1, "min": 1, "max": 9999, "step": 1}),
            "project_name": ("STRING", {"default": "My Music Video"}),
            "board_data": ("STRING", {"default": cls.EMPTY_BOARD, "multiline": True, "dynamicPrompts": False}),
            "song_filename": ("STRING", {"default": ""}),
        }, "optional": {f"theme_{i}": ("H3_STUDIO_THEME", {"lazy": True}) for i in range(1, MAX_THEME_BANKS + 1)}}

    RETURN_TYPES = ("INT", "FLOAT", "INT", "STRING", "INT", "INT", "STRING", "H3_STUDIO_THEME", "STRING")
    RETURN_NAMES = ("selected_clip", "clip_start_seconds", "generation_frames", "clip_prompt",
                    "seed", "take_number", "project_name", "reference_bank", "timeline_summary")
    FUNCTION = "direct"
    CATEGORY = CATEGORY

    def _plan(self, master_audio, board_data, selected_clip):
        waveform = master_audio.get("waveform")
        rate = int(master_audio.get("sample_rate", 0))
        if waveform is None or rate <= 0 or getattr(waveform, "ndim", 0) != 3:
            raise ValueError("master_audio must contain waveform [B,C,L] and a valid sample rate")
        duration = int(waveform.shape[-1]) / rate
        normalized, frames = explicit_board_timing(board_data, duration)
        selected = max(1, min(int(selected_clip), len(frames)))
        return duration, frames, selected, resolve_director_board(normalized, selected)

    def check_lazy_status(self, master_audio, selected_clip, project_name, board_data, song_filename, **kwargs):
        _, _, _, assignment = self._plan(master_audio, board_data, selected_clip)
        name = f"theme_{assignment['theme']}"
        return [name] if kwargs.get(name) is None else []

    def direct(self, master_audio, selected_clip, project_name, board_data, song_filename, **kwargs):
        duration, frames, selected, assignment = self._plan(master_audio, board_data, selected_clip)
        slot = assignment["theme"]
        bank = kwargs.get(f"theme_{slot}")
        if bank is None:
            raise ValueError(f"clip {selected} is assigned to unconnected reference bank {slot}")
        start = sum(frames[i] for i in range(1, selected)) / 24.0
        end = min(duration, start + frames[selected] / 24.0)
        summary = (f"{song_filename or 'Song'}: {duration:.3f}s -> {len(frames)} clips. "
                   f"Selected clip {selected}, {start:.3f}-{end:.3f}s, "
                   f"{frames[selected]} H3 frames ({frames[selected] / 24.0:.6f}s), "
                   f"bank {slot} ({bank.get('name', slot)}), take {assignment['take']}.")
        return (selected, start, frames[selected], assignment["prompt"], assignment["seed"],
                assignment["take"], str(project_name), bank, summary)



class MiniMaxH3SimpleReferenceBank:
    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {"theme_name": ("STRING", {"default": "Location 1"})},
                "optional": {f"ref_image_{i}": ("IMAGE",) for i in range(1, MAX_THEME_REFS + 1)}}

    RETURN_TYPES = ("H3_STUDIO_THEME",)
    RETURN_NAMES = ("reference_bank",)
    FUNCTION = "build"
    CATEGORY = CATEGORY

    def build(self, theme_name, **kwargs):
        return ({"name": str(theme_name),
                 "images": [kwargs.get(f"ref_image_{i}") for i in range(1, MAX_THEME_REFS + 1)]},)


class MiniMaxH3SimpleReferenceToVideo:
    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {
            "reference_bank": ("H3_STUDIO_THEME",), "clip": ("CLIP",),
            "vae": ("VAE",), "audio_vae": ("VAE",),
            "prompt": ("STRING", {"forceInput": True}),
            "width": ("INT", {"forceInput": True}),
            "height": ("INT", {"forceInput": True}),
            "length": ("INT", {"forceInput": True}),
            "ref_image_size": (["match", "max"], {"default": "match"}),
        }}

    RETURN_TYPES = ("CONDITIONING", "LATENT")
    RETURN_NAMES = ("positive", "LATENT")
    FUNCTION = "encode"
    CATEGORY = CATEGORY

    def encode(self, reference_bank, clip, vae, audio_vae, prompt, width, height, length, ref_image_size="match"):
        from comfy_extras.nodes_minimax_h3 import MiniMaxH3ReferenceToVideo

        images = list(reference_bank.get("images") or [])[:MAX_THEME_REFS]
        # Preserve image order; the native encoder assigns Picture 1, Picture 2,
        # etc. to populated sockets in exactly this order, just as before.
        refs = {f"ref_image_{i}": img for i, img in enumerate(images) if img is not None}
        return MiniMaxH3ReferenceToVideo.execute(
            clip=clip, vae=vae, audio_vae=audio_vae, prompt=prompt,
            width=width, height=height, length=length, ref_image_size=ref_image_size,
            ref_images=refs,
        ).result


def _safe_name(value: str, fallback: str = "project") -> str:
    text = re.sub(r"[^A-Za-z0-9._-]+", "_", str(value).strip()).strip("._")
    return text or fallback


def _safe_relative_folder(value: str, fallback: str) -> Path:
    raw = str(value).strip().replace("\\", "/")
    parts = [_safe_name(item, "") for item in raw.split("/") if item not in {"", ".", ".."}]
    parts = [item for item in parts if item]
    return Path(*parts) if parts else Path(fallback)


class MiniMaxH3StudioTakeFilenamePrefix:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "project_name": ("STRING", {"default": "My Music Video"}),
                "clip_number": ("INT", {"default": 1, "min": 1, "max": 9999}),
                "take_number": ("INT", {"default": 1, "min": 1, "max": 9999}),
                "target_root": ("STRING", {"default": "video/h3_music_video_studio"}),
            }
        }

    RETURN_TYPES = ("STRING", "STRING")
    RETURN_NAMES = ("filename_prefix", "clips_folder")
    FUNCTION = "build"
    CATEGORY = "conditioning/minimax/H3 Music Video Studio"

    def build(self, project_name, clip_number, take_number, target_root):
        root = _safe_relative_folder(target_root, "video/h3_music_video_studio")
        project = _safe_name(project_name)
        folder = root / project / "clips"
        stem = f"clip_{int(clip_number):04d}_take_{int(take_number):04d}"
        return ((folder / stem).as_posix(), str((Path(folder_paths.get_output_directory()) / folder).resolve()))


NODE_CLASS_MAPPINGS = {cls.__name__: cls for cls in (
    MiniMaxH3SimpleDirector, MiniMaxH3SimpleReferenceBank,
    MiniMaxH3SimpleReferenceToVideo, MiniMaxH3StudioTakeFilenamePrefix)}
NODE_DISPLAY_NAME_MAPPINGS = {
    "MiniMaxH3SimpleDirector": "H3 Simple — Clip Director",
    "MiniMaxH3SimpleReferenceBank": "H3 Simple — Reference Bank (images only)",
    "MiniMaxH3SimpleReferenceToVideo": "H3 Simple — Encode Selected References & Prompt",
    "MiniMaxH3StudioTakeFilenamePrefix": "H3 Studio — Clip / Take Filename",
}
