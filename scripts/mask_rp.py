"""Mask Regional Prompter Extension.

Custom HTML5 Canvas-based mask editor with layer management for regional prompting.
"""

from __future__ import annotations

import base64
import datetime
import io
import json
import os
from typing import Any

import gradio as gr
import numpy as np
from PIL import Image, PngImagePlugin

from modules import launch_utils, scripts
from modules.processing import StableDiffusionProcessing

from scripts.rp_core import (
    MAXCOLREG,
    MaskRegionProcessor,
    deterministic_colours,
    load_mask,
    save_mask,
)

# Detect Forge/reForge environment
try:
    _git_tag = launch_utils.git_tag()
    forge: bool = _git_tag[0:2] == "f2" or _git_tag == "neo"
    reforge: bool = _git_tag[0:2] == "f1" or _git_tag == "classic"
except Exception:
    forge = False
    reforge = False

# Check Gradio version
try:
    IS_GRADIO_4: bool = int(gr.__version__.split(".")[0]) >= 4
except Exception:
    IS_GRADIO_4 = False

EXTENSION_NAME: str = "Mask Regional Prompter"
EXTENSION_DIR: str = scripts.basedir()


class Script(scripts.Script):
    """Main extension script for Mask Regional Prompter."""

    def __init__(self) -> None:
        """Initialize the extension state."""
        super().__init__()
        self.active: bool = False
        self.processor: MaskRegionProcessor | None = None

    def title(self) -> str:
        """Return the extension title."""
        return EXTENSION_NAME

    def show(self, is_img2img: bool) -> scripts.AlwaysVisible:
        """Return visibility mode for the extension."""
        return scripts.AlwaysVisible

    def ui(self, is_img2img: bool) -> list[Any]:
        """Build the Gradio UI with custom canvas editor."""
        tab_id = "i2i" if is_img2img else "t2i"

        saves_dir = os.path.join(EXTENSION_DIR, "saves")
        os.makedirs(saves_dir, exist_ok=True)

        def get_timestamp() -> str:
            """Generate a timestamp string for auto-naming saves."""
            return datetime.datetime.now().strftime("%Y-%m-%d_%H-%M-%S")

        def list_saved_files() -> list[dict[str, Any]]:
            """List all saved files with metadata."""
            files: list[dict[str, Any]] = []
            if os.path.exists(saves_dir):
                for f in os.listdir(saves_dir):
                    if f.endswith(".png"):
                        filepath = os.path.join(saves_dir, f)
                        stat = os.stat(filepath)
                        is_custom = not (f.startswith("20") and "_" in f and f[4] == "-")
                        files.append({
                            "name": f[:-4],
                            "path": filepath,
                            "size": stat.st_size,
                            "mtime": stat.st_mtime,
                            "is_custom": is_custom,
                        })
            files.sort(key=lambda x: x["mtime"], reverse=True)
            return files

        def render_recent_files_html() -> str:
            """Render the HTML for recent files list."""
            files = list_saved_files()
            if not files:
                return "<div class='mrp-recent-empty'>No saved files yet</div>"

            html = "<div class='mrp-recent-grid'>"
            for f in files[:20]:
                icon = "📌" if f["is_custom"] else "🕐"
                safe_name = f["name"].replace("'", "\\'")
                html += f"""
                <div class="mrp-recent-item" onclick="MRPLoadFile('{tab_id}', '{safe_name}')">
                    <img src="file={f['path']}" alt="{f['name']}" loading="lazy" />
                    <div class="mrp-recent-name-overlay" title="{f['name']}">{icon} {f['name'][:18]}{'...' if len(f['name']) > 18 else ''}</div>
                    <button class="mrp-recent-delete-overlay" onclick="event.stopPropagation(); MRPDeleteFile('{tab_id}', '{safe_name}')" title="Delete">🗑</button>
                </div>
                """
            html += "</div>"
            return html

        def cleanup_auto_saves(limit: int) -> None:
            """Delete oldest auto-saves if exceeding limit."""
            files = list_saved_files()
            auto_files = [f for f in files if not f["is_custom"]]

            if len(auto_files) > limit:
                to_delete = auto_files[limit:]
                for f in to_delete:
                    try:
                        os.remove(f["path"])
                    except Exception:
                        pass

        def on_save(
            mask_data: str,
            composite_data: str,
            base_prompt: str,
            base_neg_prompt: str,
            prompts_dump: str,
            filename: str,
            save_limit: int,
            layer_data: str,
            base_image_data: str,
        ) -> tuple[str, str]:
            """Save the complete editor state to a PNG with embedded metadata."""
            save_image_data = composite_data if composite_data else mask_data
            if not save_image_data:
                return filename, render_recent_files_html()

            try:
                if not filename or filename.strip() == "":
                    filename = get_timestamp()
                    is_auto = True
                else:
                    is_auto = False

                filename = "".join(c for c in filename if c.isalnum() or c in "-_").strip()
                if not filename:
                    filename = get_timestamp()
                    is_auto = True

                if save_image_data.startswith("data:image"):
                    save_image_data = save_image_data.split(",")[1]
                img_bytes = base64.b64decode(save_image_data)
                img = Image.open(io.BytesIO(img_bytes))

                np_img = np.array(img.convert("RGB"))
                if np.mean(np_img) > 254:
                    return filename, render_recent_files_html()

                metadata = PngImagePlugin.PngInfo()
                state = {
                    "base_prompt": base_prompt or "",
                    "base_neg_prompt": base_neg_prompt or "",
                    "prompts": prompts_dump or "{}",
                    "is_auto": is_auto,
                    "layer_data": layer_data or "[]",
                    "base_image": base_image_data or "",
                }
                metadata.add_text("MRP_State", json.dumps(state))

                filepath = os.path.join(saves_dir, f"{filename}.png")
                img.save(filepath, pnginfo=metadata)

                if is_auto:
                    cleanup_auto_saves(int(save_limit))

                return "", render_recent_files_html()

            except Exception:
                return filename, render_recent_files_html()

        def on_load(filename: str) -> tuple[str, str, str, str, str, str, str]:
            """Load editor state from a saved PNG file."""
            if not filename:
                return "", "", "", "{}", "[]", "", render_recent_files_html()

            try:
                filepath = os.path.join(saves_dir, f"{filename}.png")
                if not os.path.exists(filepath):
                    return "", "", "", "{}", "[]", "", render_recent_files_html()

                img = Image.open(filepath)

                buffer = io.BytesIO()
                img.save(buffer, format="PNG")
                b64 = base64.b64encode(buffer.getvalue()).decode("utf-8")
                mask_data = f"data:image/png;base64,{b64}"

                state: dict[str, Any] = {}
                if hasattr(img, "info") and "MRP_State" in img.info:
                    try:
                        state = json.loads(img.info["MRP_State"])
                    except Exception:
                        pass

                return (
                    mask_data,
                    state.get("base_prompt", ""),
                    state.get("base_neg_prompt", ""),
                    state.get("prompts", "{}"),
                    state.get("layer_data", "[]"),
                    state.get("base_image", ""),
                    render_recent_files_html(),
                )

            except Exception:
                return "", "", "", "{}", "[]", "", render_recent_files_html()

        def on_delete(filename: str) -> str:
            """Delete a saved file."""
            if not filename:
                return render_recent_files_html()

            try:
                filepath = os.path.join(saves_dir, f"{filename}.png")
                if os.path.exists(filepath):
                    os.remove(filepath)
            except Exception:
                pass

            return render_recent_files_html()

        def on_refresh() -> str:
            """Refresh the recent files list."""
            return render_recent_files_html()

        def on_open_save_dialog() -> str:
            """Called when save dialog opens - auto-fill timestamp."""
            return get_timestamp()

        with gr.Accordion(EXTENSION_NAME, open=False, elem_id=f"mrp_accordion_{tab_id}"):
            with gr.Row():
                active = gr.Checkbox(
                    value=False,
                    label="Enable Mask Regional Prompter",
                    elem_id=f"mrp_active_{tab_id}",
                )

            with gr.Column(elem_id=f"mrp_main_wrapper_{tab_id}", elem_classes=["mrp-main-wrapper"]):
                with gr.Row(elem_id=f"mrp_toolbar_{tab_id}", elem_classes=["mrp-toolbar"]):
                    fullscreen_btn = gr.Button(value="", elem_id=f"mrp_fullscreen_btn_{tab_id}", elem_classes=["mrp-sq-btn", "mrp-fullscreen-btn"])
                    fit_view_btn = gr.Button(value="", elem_id=f"mrp_fit_view_btn_{tab_id}", elem_classes=["mrp-sq-btn", "mrp-fit-view-btn"])

                    gr.HTML("<div class='mrp-sep'></div>")

                    with gr.Row(elem_classes=["mrp-group"]):
                        gr.HTML("<span class='mrp-label'>Zoom</span>")
                        zoom_level = gr.Number(value=100, elem_id=f"mrp_zoom_level_{tab_id}", elem_classes=["mrp-num-input", "mrp-with-arrows"], show_label=False, container=False, precision=0, interactive=True)
                        gr.HTML("<span class='mrp-unit'>%</span>")

                    gr.HTML("<div class='mrp-sep'></div>")

                    with gr.Row(elem_classes=["mrp-group"]):
                        eraser_btn = gr.Button(value="", elem_id=f"mrp_eraser_btn_{tab_id}", elem_classes=["mrp-sq-btn", "mrp-eraser-btn"])
                        gr.HTML("<span class='mrp-tool-gap'></span>")
                        lasso_btn = gr.Button(value="", elem_id=f"mrp_lasso_btn_{tab_id}", elem_classes=["mrp-sq-btn", "mrp-lasso-btn"])
                        brush_btn = gr.Button(value="", elem_id=f"mrp_brush_btn_{tab_id}", elem_classes=["mrp-sq-btn", "mrp-active", "mrp-brush-btn"])
                        gr.HTML("<span class='mrp-label'>Size</span>")
                        brush_size = gr.Number(value=100, elem_id=f"mrp_brush_size_{tab_id}", elem_classes=["mrp-num-input", "mrp-with-arrows"], show_label=False, container=False, precision=0, interactive=True)

                    gr.HTML("<div class='mrp-sep'></div>")

                    with gr.Row(elem_classes=["mrp-group"]):
                        gr.HTML("<span class='mrp-label'>Opacity</span>")
                        layer_opacity = gr.Number(value=30, elem_id=f"mrp_layer_opacity_{tab_id}", elem_classes=["mrp-num-input", "mrp-with-arrows"], show_label=False, container=False, precision=0, interactive=True)
                        gr.HTML("<span class='mrp-unit'>%</span>")

                    gr.HTML("<div class='mrp-sep'></div>")

                    gr.HTML(f"""<div class="mrp-help-btn" id="mrp_help_btn_{tab_id}" title="Keyboard Shortcuts">
                        <span>ⓘ</span>
                        <div class="mrp-shortcuts-tooltip">
                            <div class="mrp-tooltip-title">Keyboard Shortcuts</div>
                            <div class="mrp-tooltip-row"><kbd>B</kbd> Brush tool</div>
                            <div class="mrp-tooltip-row"><kbd>E</kbd> Toggle eraser</div>
                            <div class="mrp-tooltip-row"><kbd>L</kbd> Lasso tool</div>
                            <div class="mrp-tooltip-row"><kbd>[</kbd> <kbd>]</kbd> Brush size</div>
                            <div class="mrp-tooltip-row"><kbd>Ctrl+Wheel</kbd> Zoom</div>
                            <div class="mrp-tooltip-row"><kbd>Ctrl+0</kbd> Fit to view</div>
                            <div class="mrp-tooltip-row"><kbd>Space+Drag</kbd> Pan</div>
                            <div class="mrp-tooltip-row"><kbd>Middle Click</kbd> Pan</div>
                            <div class="mrp-tooltip-row"><kbd>Ctrl+Z</kbd> Undo</div>
                            <div class="mrp-tooltip-row"><kbd>Ctrl+Y</kbd> Redo</div>
                        </div>
                    </div>""")

                canvas_html = f"""
                <div id="mrp_canvas_{tab_id}" class="mrp-canvas-editor">
                    <div class="mrp-editor-placeholder">
                        <p>Create a canvas or drag &amp; drop an image to start</p>
                    </div>
                </div>
                """
                gr.HTML(canvas_html, elem_id=f"mrp_canvas_container_{tab_id}")

                with gr.Row(elem_id=f"mrp_bottom_bar_{tab_id}", elem_classes=["mrp-bottom-bar"]):
                    with gr.Row(elem_classes=["mrp-group"]):
                        gr.HTML("<span class='mrp-label'>W</span>")
                        canvas_width = gr.Number(value=512, elem_id=f"mrp_width_{tab_id}", elem_classes=["mrp-num-input"], show_label=False, container=False, precision=0, interactive=True)

                        gr.HTML("<span class='mrp-label'>H</span>")
                        canvas_height = gr.Number(value=512, elem_id=f"mrp_height_{tab_id}", elem_classes=["mrp-num-input"], show_label=False, container=False, precision=0, interactive=True)

                    with gr.Row(elem_classes=["mrp-group"]):
                        copy_from_sd_btn = gr.Button(value="From SD", elem_id=f"mrp_copy_sd_{tab_id}", elem_classes=["mrp-btn"])
                        create_canvas_btn = gr.Button(value="Create", elem_id=f"mrp_create_canvas_{tab_id}", elem_classes=["mrp-btn", "mrp-primary"])
                        reset_btn = gr.Button(value="Reset", elem_id=f"mrp_reset_{tab_id}", elem_classes=["mrp-btn"])

                mask_data_state = gr.Textbox(value="", elem_id=f"mrp_mask_data_{tab_id}", visible=False)
                composite_data_state = gr.Textbox(value="", elem_id=f"mrp_composite_data_{tab_id}", visible=False)
                layer_data_state = gr.Textbox(value="", elem_id=f"mrp_layer_data_{tab_id}", visible=False)
                base_image_data_state = gr.Textbox(value="", elem_id=f"mrp_base_image_data_{tab_id}", visible=False)

            gr.HTML("<div class='mrp-divider'></div>")

            with gr.Column(elem_id=f"mrp_prompts_{tab_id}", elem_classes=["mrp-prompts"]):
                base_prompt = gr.Textbox(
                    label="Base Prompt",
                    placeholder="Applies to entire image...",
                    lines=2,
                    elem_id=f"mrp_base_prompt_{tab_id}",
                    elem_classes=["mrp-prompt", "mrp-prompt-base"],
                )

                base_neg_prompt = gr.Textbox(
                    label="Base Negative",
                    placeholder="Base negative prompt...",
                    lines=1,
                    elem_id=f"mrp_base_neg_prompt_{tab_id}",
                    elem_classes=["mrp-prompt", "mrp-prompt-neg"],
                )

                gr.HTML(elem_id=f"mrp_prompts_container_{tab_id}", elem_classes=["mrp-prompts-container"])

                prompts_dump = gr.Textbox(elem_id=f"mrp_prompts_dump_{tab_id}", params_dict={"visible": False}, visible=False)

                layer_count_state = gr.State(value=1)

            with gr.Accordion("Save/Load", open=False, elem_id=f"mrp_save_load_{tab_id}", elem_classes=["mrp-save-load"]):
                with gr.Row(elem_classes=["mrp-settings-row"]):
                    auto_save_on_gen = gr.Checkbox(
                        value=True,
                        label="Auto-save on Generate",
                        elem_id=f"mrp_auto_save_{tab_id}",
                    )
                    save_limit = gr.Number(
                        value=20,
                        label="Max Auto-Saves",
                        elem_id=f"mrp_save_limit_{tab_id}",
                        elem_classes=["mrp-compact-number"],
                        precision=0,
                        minimum=1,
                        maximum=10000,
                    )

                with gr.Row(elem_classes=["mrp-save-row"]):
                    mask_filename = gr.Textbox(
                        label="Save Name",
                        placeholder="Leave empty for automatic timestamp",
                        elem_id=f"mrp_filename_{tab_id}",
                        scale=4,
                    )
                    save_mask_btn = gr.Button(
                        value="💾 Save",
                        elem_id=f"mrp_save_btn_{tab_id}",
                        elem_classes=["mrp-save-btn"],
                        variant="primary",
                        scale=1,
                    )

                gr.Markdown("### Recent Saves")
                recent_files_html = gr.HTML(
                    value=render_recent_files_html(),
                    elem_id=f"mrp_recent_files_{tab_id}",
                    elem_classes=["mrp-recent-files"],
                )

                selected_file = gr.Textbox(visible=False, elem_id=f"mrp_selected_file_{tab_id}")
                load_trigger = gr.Button(visible=False, elem_id=f"mrp_load_trigger_{tab_id}")
                delete_trigger = gr.Button(visible=False, elem_id=f"mrp_delete_trigger_{tab_id}")
                refresh_trigger = gr.Button(visible=False, elem_id=f"mrp_refresh_trigger_{tab_id}")

        save_mask_btn.click(
            fn=on_save,
            inputs=[mask_data_state, composite_data_state, base_prompt, base_neg_prompt, prompts_dump, mask_filename, save_limit, layer_data_state, base_image_data_state],
            outputs=[mask_filename, recent_files_html],
        )

        load_trigger.click(
            fn=on_load,
            inputs=[selected_file],
            outputs=[mask_data_state, base_prompt, base_neg_prompt, prompts_dump, layer_data_state, base_image_data_state, recent_files_html],
        ).then(
            fn=None,
            inputs=[mask_data_state, base_prompt, base_neg_prompt, prompts_dump, layer_data_state, base_image_data_state],
            outputs=[],
            _js=f"(maskData, basePrompt, baseNegPrompt, promptsDump, layerData, baseImageData) => {{ window.MRP_ApplyLoad('{tab_id}', maskData, basePrompt, baseNegPrompt, promptsDump, layerData, baseImageData); }}",
        )

        delete_trigger.click(
            fn=on_delete,
            inputs=[selected_file],
            outputs=[recent_files_html],
        )

        refresh_trigger.click(
            fn=on_refresh,
            inputs=[],
            outputs=[recent_files_html],
        )

        return [
            active,
            mask_data_state,
            base_prompt,
            base_neg_prompt,
            prompts_dump,
            layer_count_state,
        ]

    def process(
        self,
        p: StableDiffusionProcessing,
        active: bool,
        mask_data: str,
        base_prompt: str,
        base_neg_prompt: str,
        prompts_dump: str,
        layer_count: int,
    ) -> None:
        """Process the image generation with regional masks."""
        if not active:
            return

        if not mask_data or not mask_data.startswith("data:image"):
            return

        try:
            b64_data = mask_data.split(",")[1]
            img_bytes = base64.b64decode(b64_data)
            mask_image = np.array(Image.open(io.BytesIO(img_bytes)).convert("RGB"))
        except Exception:
            return

        self.processor = MaskRegionProcessor(
            height=p.height,
            width=p.width,
            batch_size=p.batch_size,
            is_forge=forge,
            is_reforge=reforge,
        )

        layer_prompts_map: dict[str, str] = {}
        try:
            if prompts_dump:
                layer_prompts_map = json.loads(prompts_dump)
        except Exception:
            pass

        actual_layer_count = len(layer_prompts_map) if layer_prompts_map else int(layer_count) if layer_count else 0

        prompts = [base_prompt] if base_prompt else [""]

        for i in range(1, actual_layer_count + 1):
            layer_text = layer_prompts_map.get(str(i), "")
            prompts.append(layer_text if layer_text else "_")

        combined_prompt = " BREAK ".join(prompts) if len(prompts) > 1 else prompts[0]

        self.processor.setup_masks(mask_image, actual_layer_count)
        self.processor.hook_forwards(p)

        p.prompt = combined_prompt
        p.all_prompts = [combined_prompt] * len(p.all_prompts) if hasattr(p, "all_prompts") and p.all_prompts else [combined_prompt]

        if base_neg_prompt:
            p.negative_prompt = base_neg_prompt
            p.all_negative_prompts = [base_neg_prompt] * len(p.all_negative_prompts) if hasattr(p, "all_negative_prompts") and p.all_negative_prompts else [base_neg_prompt]

        p.extra_generation_params.update({
            "MRP Active": True,
            "MRP Regions": actual_layer_count + 1,
            "MRP Prompt": combined_prompt[:200] + "..." if len(combined_prompt) > 200 else combined_prompt,
        })

        self.active = True

    def postprocess(self, p: StableDiffusionProcessing, processed: Any, *args: Any) -> None:
        """Clean up attention hooks after generation."""
        if self.active and self.processor:
            self.processor.unhook_forwards(p)
            self.processor = None
            self.active = False
