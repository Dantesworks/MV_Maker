"""Generation-only checks; no ComfyUI installation or model weights required."""
import importlib
import json
import math
import sys
import types
import unittest
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
PACKAGE = "mv_maker_test_package"
package = types.ModuleType(PACKAGE)
package.__path__ = [str(ROOT)]
sys.modules[PACKAGE] = package
sys.modules.setdefault("folder_paths", types.ModuleType("folder_paths"))
nodes = importlib.import_module(f"{PACKAGE}.nodes")
core = importlib.import_module(f"{PACKAGE}.core")


class GenerationTests(unittest.TestCase):
    def test_frame_rule_and_ten_second_limit(self):
        self.assertEqual(core.simple_clip_frames(6), 141)
        self.assertEqual(core.simple_clip_frames(8), 192)
        self.assertEqual(core.simple_clip_frames(10), 226)
        for bad in (0, -1, 11, math.nan, math.inf):
            with self.assertRaises(ValueError):
                core.simple_clip_frames(bad)

    def test_individual_durations_required(self):
        with self.assertRaisesRegex(ValueError, "clip 2"):
            core.explicit_board_timing(json.dumps({"clips": {"1": {"seconds": 6}}}), 12)

    def test_selected_clip_and_lazy_bank_routing(self):
        audio = {"waveform": types.SimpleNamespace(shape=(1, 2, 288000), ndim=3), "sample_rate": 24000}
        board = json.dumps({"default": {"theme": 1}, "clips": {
            "1": {"seconds": 6, "theme": 1, "prompt": "first", "seed": 11, "take": 2},
            "2": {"seconds": 8, "theme": 2, "prompt": "second", "seed": 22, "take": 3}}})
        bank = nodes.MiniMaxH3SimpleReferenceBank().build("Location 2", ref_image_1="face", ref_image_2="outfit")[0]
        director = nodes.MiniMaxH3SimpleDirector()
        self.assertEqual(director.check_lazy_status(audio, 2, "project", board, "song.mp3"), ["theme_2"])
        result = director.direct(audio, 2, "project", board, "song.mp3", theme_2=bank)
        self.assertEqual(result[:7], (2, 141 / 24, 192, "second", 22, 3, "project"))
        self.assertIs(result[7], bank)
        with self.assertRaisesRegex(ValueError, "unconnected"):
            director.direct(audio, 2, "project", board, "song.mp3")
        clamped = director.direct(audio, 9999, "project", board, "song.mp3", theme_2=bank)
        self.assertEqual(clamped[:7], result[:7])

    def test_reference_order_and_native_encoder_delegation(self):
        native = types.ModuleType("comfy_extras.nodes_minimax_h3")
        captured = []
        def execute(**kwargs):
            captured.append(kwargs)
            return types.SimpleNamespace(result=("conditioning", "latent"))
        native.MiniMaxH3ReferenceToVideo = types.SimpleNamespace(execute=execute)
        with patch.dict(sys.modules, {"comfy_extras": types.ModuleType("comfy_extras"),
                                     "comfy_extras.nodes_minimax_h3": native}):
            result = nodes.MiniMaxH3SimpleReferenceToVideo().encode(
                {"images": ["face", "outfit", "location", None]}, "clip", "vae", "audio", "unchanged", 1088, 1920, 192)
        self.assertEqual(result, ("conditioning", "latent"))
        self.assertEqual(len(captured), 1)
        self.assertEqual(list(captured[0]["ref_images"].values()), ["face", "outfit", "location"])
        self.assertEqual(captured[0]["prompt"], "unchanged")

    def test_generation_only_registration_and_schemas(self):
        self.assertEqual(set(nodes.NODE_CLASS_MAPPINGS), {
            "MiniMaxH3SimpleDirector", "MiniMaxH3SimpleReferenceBank",
            "MiniMaxH3SimpleReferenceToVideo", "MiniMaxH3StudioTakeFilenamePrefix"})
        schema = nodes.MiniMaxH3SimpleDirector.INPUT_TYPES()["required"]
        self.assertNotIn("clip_seconds", schema)
        self.assertNotIn("context_frames", schema)
        self.assertNotIn("prompt_fragment", nodes.MiniMaxH3SimpleReferenceBank.INPUT_TYPES()["required"])
        self.assertFalse((ROOT / "folder_assembly.py").exists())
        self.assertFalse((ROOT / "web/h3_studio_folder_assembler.js").exists())

    def test_template_graph_and_blank_media_state(self):
        paths = list((ROOT / "workflows").glob("*.json"))
        self.assertEqual(len(paths), 1)
        w = json.loads(paths[0].read_text(encoding="utf-8"))
        ns = {n["id"]: n for n in w["nodes"]}
        for lid, src, out, dst, inp, typ in w["links"]:
            self.assertIn(lid, ns[src]["outputs"][out]["links"])
            self.assertEqual(ns[dst]["inputs"][inp]["link"], lid)
        for n in ns.values():
            self.assertNotIn("FolderAssembler", n["type"])
            self.assertNotIn("FaceRefine", n["type"])
            self.assertNotIn("widgets_values_named", n)
            if n["type"] in ("LoadAudio", "LoadImage"):
                self.assertEqual(n["widgets_values"][0], "")
            if n["type"] == "MiniMaxH3SimpleDirector":
                self.assertEqual(n["widgets_values"][0], 1)
                self.assertEqual(json.loads(n["widgets_values"][2])["clips"], {})
                self.assertEqual(n["widgets_values"][3], "")
        text = paths[0].read_text(encoding="utf-8")
        self.assertNotIn("Folder Assembly", text)
        self.assertNotIn("Melt MV - Master Song", text)

    def test_project_clip_take_filename(self):
        with patch.object(nodes.folder_paths, "get_output_directory", return_value=str(ROOT), create=True):
            prefix, folder = nodes.MiniMaxH3StudioTakeFilenamePrefix().build("My Project", 2, 3, "video/h3_music_video_studio")
        self.assertEqual(prefix, "video/h3_music_video_studio/My_Project/clips/clip_0002_take_0003")
        self.assertTrue(folder.endswith(str(Path("My_Project/clips"))))


if __name__ == "__main__":
    unittest.main()
