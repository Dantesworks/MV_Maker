# MV Maker

A ComfyUI workflow and custom nodes for generating MiniMax H3 music-video clips
against an original master song.

![Generation workflow](docs/workflow-overview.svg)

## Included

- [Music Video Studio — Simple](workflows/H3%20Music%20Video%20Studio%20-%20Simple.json)
- Clip Director with a song timeline, per-clip duration, complete prompt, reference
  bank assignment, seed, take number, and audio preview.
- Image-only reference banks passed to H3 through one connection.
- Automatic project / clip / take filenames and separate clip queueing.

This package covers generation only. It does not include Folder Assembly or
face-refinement workflows. Generated MP4 clips can be assembled in your video editor.

## Requirements

Install these before opening the workflow:

| Component | Purpose |
| --- | --- |
| [ComfyUI](https://github.com/Comfy-Org/ComfyUI) with native MiniMax H3 support | H3 model loading, text/image conditioning, resolution selection, sampling and decoding |
| [H3 Motion Context MultiRef](https://github.com/seitanism/ComfyUI-H3-Motion-Context-MultiRef) | `MiniMaxH3SongMaskedAVContext`, which supplies the exact master-song slice |
| [VideoHelperSuite](https://github.com/Kosinkadink/ComfyUI-VideoHelperSuite) | Saving MP4 clips with audio and pruning intermediate output |

Use a ComfyUI version that provides `MiniMaxH3ReferenceToVideo` and
`ResolutionSelector`. MV Maker uses ComfyUI's Python environment and adds no
separate Python package requirements. Install the dependencies required by the
two external node packs according to their own instructions.

Model weights are not included. The saved workflow selects:

| Model | Folder under `ComfyUI/models/` |
| --- | --- |
| `minimax_h3_hybrid_fl2va_ref2va_b30-49-int8.safetensors` | `diffusion_models/` |
| `qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors` | `text_encoders/` |
| `minimax_h3_video_vae_fp16.safetensors` | `vae/` |
| `minimax_h3_audio_vae_fp32.safetensors` | `vae/` |

Select your installed compatible H3 model variants in the loader nodes. Quantized
variants need the corresponding loader support in your ComfyUI installation.

## Installation

From your `ComfyUI/custom_nodes` directory:

```sh
git clone https://github.com/Dantesworks/MV_Maker.git
```

Alternatively, download the repository ZIP and extract it as
`ComfyUI/custom_nodes/MV_Maker`.

Restart ComfyUI, refresh its browser tab, and open
`workflows/H3 Music Video Studio - Simple.json` by dragging it onto the canvas
or using ComfyUI's workflow-open command. The repository itself is the custom
node package: `__init__.py`, `nodes.py`, `core.py` and `web/` must stay together.

If you already use the local H3 Music Video Studio prototype, avoid loading both
copies of the same Simple node classes and Director extension. Keep one installed
copy of those nodes. Installation does not require replacing ComfyUI core files.

## Use

1. Select the model files and output resolution. Defaults retain the saved
   workflow's widescreen 2 MP selection, 24 FPS, `res_multistep`, simple scheduler
   and 20 steps.
2. Load the original master song. The Clip Director creates the song's clip board.
3. Load reference images into the location banks and name each bank. The template
   starts with two banks. Populated images become Picture 1, Picture 2, etc. in
   bank order. The template labels them face/hair, outfit/body/shoes and location
   views. Reference images guide identity and setting; they are not opening frames.
4. Select each clip and set its reference bank, requested duration, complete H3
   prompt, seed and take. **All generation prompts are entered in the Clip Director.**
   New clips start with their own editable seven-second value. There is no global
   target duration or separate theme prompt field.
5. Preview the clip's song interval, then queue the current clip, selected clips,
   or every populated clip. Each clip is an independent generation job.
6. Save your workflow after editing. Changing a clip's duration moves every later
   song interval while keeping prompts and assignments attached to clip numbers.
   Render affected later clips again if their audio intervals change.

H3 lengths snap to its legal `5 + 17k` frame grid. The Director displays the actual
duration. Generations stay within ten actual seconds; requests near ten seconds
use 226 frames (about 9.417 seconds) to stay inside that limit. Precise timing is
stored in the clip table and node connections. MP3 preview seeking is rounded to
0.1 seconds; generation timing remains frame aligned.

Rendered clips are saved under:

```text
ComfyUI/output/video/h3_music_video_studio/<project>/clips/
  clip_0001_take_0001_00001-audio.mp4
  clip_0002_take_0001_00001-audio.mp4
```

The Qwen prompt-editing panel is not included. The Qwen-based H3 **text encoder**
remains required for generation.

## Checks

Run from this repository's root:

```sh
python -m unittest discover -s tests -p "test_generation.py" -v
node tests/test_simple_director.mjs
```

The checks cover explicit per-clip timing, selected-bank routing, reference order,
the ten-second limit, saved workflow connections and blank media selections.
They run without loading H3 weights. A complete H3 render still depends on your
installed model files, node packs and hardware.

The published workflow is a clean copy of the saved generation workflow. Local
song selections and clip-board state have been cleared; model, sampler,
resolution and output settings were retained. No songs, reference images, model
weights or generated clips are distributed here.
