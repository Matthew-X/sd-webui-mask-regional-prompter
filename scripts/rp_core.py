"""Core logic for Mask Regional Prompter.

Contains mask processing, attention hooks, and region management.
"""

from __future__ import annotations

import colorsys
import math
from inspect import isfunction
from typing import Any, Callable, TypeVar

import cv2
import numpy as np
import torch
from einops import rearrange, repeat
from PIL import Image
from torch import Tensor, einsum
from torchvision.transforms import InterpolationMode, Resize

from modules import devices, launch_utils

# Type aliases
T = TypeVar("T")
NDArrayUint8 = np.ndarray  # Shape: (H, W, 3), dtype: uint8
NDArrayFloat = np.ndarray  # Shape: (H, W), dtype: float

# Constants
MAXCOLREG: int = 359  # HSV hue degrees
CCHANNELS: int = 3
CBLACK: int = 255
COLWHITE: tuple[int, int, int] = (255, 255, 255)
HSV_RANGE: tuple[float, float] = (0.49, 0.51)
HSV_VAL: float = 0.5
TOKENSCON: int = 77
TOKENS: int = 75

# Detect Forge/reForge environment
try:
    _git_tag = launch_utils.git_tag()
    forge: bool = _git_tag[0:2] == "f2" or _git_tag == "neo"
    reforge: bool = _git_tag[0:2] == "f1" or _git_tag == "classic"
except Exception:
    forge = False
    reforge = False

# Global color registry
COLREG: NDArrayUint8 | None = None
REGUSE: dict[int, list[int]] = {}
VARIANT: int = 0


def exists(val: T | None) -> bool:
    """Check if a value is not None."""
    return val is not None


def default(val: T | None, d: T | Callable[[], T]) -> T:
    """Return val if it exists, otherwise return d (or call d if callable)."""
    if exists(val):
        return val  # type: ignore
    return d() if isfunction(d) else d


def deterministic_colours(n: int, lcol: NDArrayUint8 | None = None) -> NDArrayUint8 | None:
    """Generate n visually distinct and consistent colours as RGB tuples.
    
    Uses binary subdivision of hue space for even distribution.
    """
    global COLREG
    if n <= 0:
        return None

    pcyc: float = -1
    cval: float = 0
    dlt: float = 0

    if lcol is None:
        st = 0
    elif n <= len(lcol):
        return lcol
    else:
        st = len(lcol)
        if st > 0:
            pcyc = np.ceil(np.log2(st))
            dlt = 1 / (2 ** pcyc)
            cval = dlt + 2 * dlt * (st % (2 ** (pcyc - 1)) - 1)

    lhsv: list[float] = []
    for i in range(st, n):
        ccyc = np.ceil(np.log2(i + 1))
        if ccyc == 0:
            cval = 0
            pcyc = ccyc
        elif pcyc != ccyc:
            dlt = 1 / (2 ** ccyc)
            cval = dlt
            pcyc = ccyc
        else:
            cval = cval + 2 * dlt
        lhsv.append(cval)

    hsv_tuples = [(v, 0.5, 0.5) for v in lhsv]
    lrgb = [colorsys.hsv_to_rgb(*hsv) for hsv in hsv_tuples]
    lrgb_arr = (np.array(lrgb) * (CBLACK + 1)).astype(np.uint8)
    lrgb_arr = lrgb_arr.reshape(-1, CCHANNELS)

    if lcol is not None:
        lrgb_arr = np.concatenate([lcol, lrgb_arr])

    return lrgb_arr


def get_colours(img: NDArrayUint8) -> NDArrayUint8:
    """Extract unique colours from an image."""
    return np.unique(img.reshape(-1, img.shape[-1]), axis=0)


def create_canvas(h: int, w: int, indwipe: bool = True) -> NDArrayUint8:
    """Create a new blank white canvas for mask editing."""
    global VARIANT, REGUSE
    VARIANT = 1 - VARIANT
    if indwipe:
        REGUSE = {}
    return np.zeros(shape=(h + VARIANT, w + VARIANT, CCHANNELS), dtype=np.uint8) + CBLACK


def change_color(index: int) -> Any:
    """Get Gradio brush update for the specified layer index."""
    import gradio as gr

    colors = deterministic_colours(index + 1)
    if colors is None or len(colors) == 0:
        return gr.update()
    rgb = colors[-1]
    html_color = f"#{rgb[0]:02x}{rgb[1]:02x}{rgb[2]:02x}"
    try:
        return gr.ImageEditor.update(brush=gr.Brush(colors=[html_color], color_mode="fixed"))
    except Exception:
        return gr.update()


def detect_image_colours(img: NDArrayUint8 | None) -> tuple[NDArrayUint8 | None, None]:
    """Detect and normalize HSV colours in an image mask."""
    global REGUSE, COLREG, VARIANT

    if img is None:
        return None, None

    VARIANT = 0
    h, w, c = img.shape

    lrgb = get_colours(img)
    lhsv = np.apply_along_axis(lambda x: colorsys.rgb_to_hsv(*x), axis=-1, arr=lrgb / CBLACK)
    msk = (
        (lhsv[:, 1] >= HSV_RANGE[0])
        & (lhsv[:, 1] <= HSV_RANGE[1])
        & (lhsv[:, 2] >= HSV_RANGE[0])
        & (lhsv[:, 2] <= HSV_RANGE[1])
    )

    lfltrgb = lrgb[msk]
    lflthsv = lhsv[msk]
    lflthsv[:, 1:] = HSV_VAL

    if len(lfltrgb) > 0:
        lfltfix = np.apply_along_axis(lambda x: colorsys.hsv_to_rgb(*x), axis=-1, arr=lflthsv)
        lfltfix = (lfltfix * (CBLACK + 1)).astype(np.uint8)
    else:
        lfltfix = lfltrgb

    cnt = len(lfltrgb)
    img2 = img.reshape(-1, c, 1)
    img2 = np.moveaxis(img2, 0, -1)
    lfltrgb2 = np.moveaxis(lfltrgb, -1, 0)
    lfltrgb2 = lfltrgb2.reshape(c, -1, 1)
    msk2 = (img2 == lfltrgb2).all(axis=0).reshape(cnt, h, w)

    for i in range(len(lfltrgb)):
        img[msk2[i]] = lfltfix[i]

    COLREG = deterministic_colours(2 * MAXCOLREG, COLREG)

    return img, None


def draw_image(img: NDArrayUint8, inddict: bool = False) -> tuple[NDArrayUint8 | None, None, NDArrayFloat | None]:
    """Run colour detection on uploaded image."""
    img, clearer = detect_image_colours(img)
    mask = detect_mask(img, -1)
    return img, clearer, mask


def draw_region(img: dict[str, Any], num: int) -> tuple[NDArrayUint8, int, NDArrayFloat | None]:
    """Draw a region polygon and return updated mask."""
    img_out, num2 = detect_polygons(img, num)
    mask = detect_mask(img_out, num)
    return img_out, num2, mask


def detect_polygons(img: dict[str, Any], num: int) -> tuple[NDArrayUint8, int]:
    """Convert stroke + region to standard coloured mask."""
    global COLREG, VARIANT, REGUSE

    if VARIANT != 0:
        out = img["image"][:-VARIANT, :-VARIANT, :CCHANNELS]
        mask_layer = img["mask"][:-VARIANT, :-VARIANT, :CCHANNELS]
    else:
        out = img["image"][:, :, :CCHANNELS]
        mask_layer = img["mask"][:, :, :CCHANNELS]

    if mask_layer is None:
        mask_layer = np.zeros([512, 512, CCHANNELS], dtype=np.uint8) + CBLACK
    if out is None:
        out = np.zeros_like(mask_layer) + CBLACK

    bimg = cv2.cvtColor(mask_layer, cv2.COLOR_RGB2GRAY)
    contours, _ = cv2.findContours(bimg, cv2.RETR_TREE, cv2.CHAIN_APPROX_SIMPLE)

    img2 = out

    if num < 0:
        color: tuple[int, ...] | NDArrayUint8 = COLWHITE
    else:
        COLREG = deterministic_colours(int(num) + 1, COLREG)
        color = COLREG[int(num), :]
        REGUSE[num] = color.tolist()

    for cnt in contours:
        approx = cv2.approxPolyDP(cnt, 0.0001 * cv2.arcLength(cnt, True), True)
        if cv2.contourArea(cnt) > cv2.arcLength(cnt, True) * 1.5:
            color_int = [int(v) for v in color]
            cv2.fillPoly(img2, [approx], color=color_int)

    skimg = create_canvas(img2.shape[0], img2.shape[1], indwipe=False)
    if VARIANT != 0:
        skimg[:-VARIANT, :-VARIANT, :] = img2
    else:
        skimg[:, :, :] = img2

    return skimg, num + 1 if (num >= 0 and num + 1 <= CBLACK) else num


def detect_mask(img: NDArrayUint8 | dict[str, Any] | None, num: int, mult: int = CBLACK) -> NDArrayFloat | None:
    """Extract a binary mask for a specific colour region."""
    global REGUSE

    if isinstance(img, dict):
        img = img.get("image")

    if img is None:
        return None

    indnot = False
    if num < 0:
        color_arr = np.array(list(REGUSE.values()))
        if len(color_arr) == 0:
            return np.ones((img.shape[0], img.shape[1])) * mult
        color_arr = np.moveaxis(color_arr, -1, 0)
        color_arr = color_arr.reshape(1, 1, *color_arr.shape)
        img = img.reshape(*img.shape, 1)
        indnot = True
    else:
        color_arr = deterministic_colours(int(num) + 1)[-1]
        color_arr = color_arr.reshape([1, 1, CCHANNELS])

    if indnot:
        mask = (~(img == color_arr)).all(-1).all(-1)
        mask = mask * mult
    else:
        mask = ((img == color_arr).all(-1)) * mult

    if mask.sum() > 0 and num >= 0:
        REGUSE[num] = color_arr.reshape(-1).tolist()

    return mask


def save_mask(img: NDArrayUint8 | dict[str, Any], flpath: str) -> None:
    """Save mask image to file."""
    if isinstance(img, dict):
        img = img.get("layers", [None])[0] if "layers" in img else img.get("image")

    if img is None:
        return

    if VARIANT != 0:
        img = img[:-VARIANT, :-VARIANT, :]

    img = cv2.cvtColor(img, cv2.COLOR_RGB2BGR)
    cv2.imwrite(flpath, img)


def load_mask(flpath: str) -> NDArrayUint8 | None:
    """Load mask image from file."""
    try:
        img = cv2.imread(flpath)
        img = cv2.cvtColor(img, cv2.COLOR_BGR2RGB)
    except Exception:
        img = None
    return img


class MaskRegionProcessor:
    """Handles mask-based regional prompting during image generation."""

    def __init__(
        self,
        height: int,
        width: int,
        batch_size: int,
        is_forge: bool = False,
        is_reforge: bool = False,
    ) -> None:
        """Initialize the processor with image dimensions and environment flags."""
        self.height = height
        self.width = width
        self.batch_size = batch_size
        self.is_forge = is_forge
        self.is_reforge = is_reforge

        self.regmasks: list[Tensor] = []
        self.regbase: Tensor | None = None
        self.hooked: bool = False
        self.active: bool = False

        self.pt: list[Any] = []
        self.nt: list[Any] = []
        self.pn: bool = True
        self.count: int = 0

        self.cshape: tuple[int, ...] | None = None
        self.ucshape: tuple[int, ...] | None = None

        model = None
        try:
            from modules import shared
            model = shared.sd_model
        except Exception:
            pass

        self.is_sdxl = (
            type(model).__name__ == "StableDiffusionXL" or getattr(model, "is_sdxl", False)
        ) if model else False
        self.is_sd2 = (
            type(model).__name__ == "StableDiffusion2" or getattr(model, "is_sd2", False)
        ) if model else False
        self.is_flux = (
            type(model).__name__ == "Flux" or getattr(model, "is_flux", False)
        ) if model else False

    def setup_masks(self, mask_image: NDArrayUint8, layer_count: int) -> None:
        """Process the mask image and extract region masks."""
        global REGUSE, COLREG

        if mask_image is None:
            return

        if isinstance(mask_image, np.ndarray) and len(mask_image.shape) == 2:
            mask_image = np.stack([mask_image] * 3, axis=-1)

        COLREG = deterministic_colours(max(int(layer_count) + 1, MAXCOLREG), COLREG)

        self.regmasks = []
        tm: NDArrayFloat | None = None

        detected_regions: list[tuple[int, NDArrayFloat]] = []
        for c in range(int(layer_count)):
            color = COLREG[c]
            color_match = np.all(
                np.abs(mask_image.astype(np.int16) - color.astype(np.int16)) < 10, axis=-1
            )
            if np.any(color_match):
                detected_regions.append((c, color_match))
                REGUSE[c] = color.tolist()

        for _, color_match in detected_regions:
            m = color_match.astype(np.float16)
            if m.any():
                if tm is None:
                    tm = np.zeros_like(m)
                tm = tm + m
                m = m.reshape([1, *m.shape])
                t = torch.from_numpy(m).to(devices.device)
                self.regmasks.append(t)

        if tm is not None:
            m = (1 - np.clip(tm, 0, 1)).astype(np.float16)
            m = m.reshape([1, *m.shape])
            t = torch.from_numpy(m).to(devices.device)
            self.regbase = t

        self.active = True

    def hook_forwards(self, p: Any) -> None:
        """Hook the attention mechanism for regional prompting."""
        if self.is_forge:
            self._hook_forwards_forge(p.sd_model.forge_objects.unet.model)
        else:
            self._hook_forwards_standard(p.sd_model.model.diffusion_model)
        self.hooked = True

    def unhook_forwards(self, p: Any) -> None:
        """Remove attention hooks."""
        if self.hooked:
            if self.is_forge:
                self._hook_forwards_forge(p.sd_model.forge_objects.unet.model, remove=True)
            else:
                self._hook_forwards_standard(p.sd_model.model.diffusion_model, remove=True)
            self.hooked = False

    def _hook_forwards_forge(self, root_module: Any, remove: bool = False) -> None:
        """Hook or unhook forwards for Forge environment."""
        for name, module in root_module.named_modules():
            if "attn2" in name and module.__class__.__name__ == "CrossAttention":
                if remove:
                    if hasattr(module, "_original_forward"):
                        module.forward = module._original_forward
                        del module._original_forward
                else:
                    module._original_forward = module.forward
                    module.forward = self._create_forward_hook(module)

    def _hook_forwards_standard(self, root_module: Any, remove: bool = False) -> None:
        """Hook or unhook forwards for standard WebUI environment."""
        for name, module in root_module.named_modules():
            if "attn2" in name and module.__class__.__name__ == "CrossAttention":
                if remove:
                    if hasattr(module, "_original_forward"):
                        module.forward = module._original_forward
                        del module._original_forward
                else:
                    module._original_forward = module.forward
                    module.forward = self._create_forward_hook(module)

    def _create_forward_hook(self, module: Any) -> Callable[..., Tensor]:
        """Create a forward hook for mask-based attention with split prompts per region."""
        processor = self

        def _do_attention(
            mod: Any, x: Tensor, context: Tensor, mask: Tensor | None, h: int
        ) -> Tensor:
            """Perform attention calculation for a given context chunk."""
            q = mod.to_q(x)
            k = mod.to_k(default(context, x))
            v = mod.to_v(default(context, x))

            _, _, dim_head = q.shape
            dim_head //= h
            scale_factor = dim_head ** -0.5

            q, k, v = map(lambda t: rearrange(t, "b n (h d) -> (b h) n d", h=h), (q, k, v))
            sim = einsum("b i d, b j d -> b i j", q, k) * scale_factor

            if exists(mask):
                mask_r = rearrange(mask, "b ... -> b (...)")
                max_neg_value = -torch.finfo(sim.dtype).max
                mask_r = repeat(mask_r, "b j -> (b h) () j", h=h)
                sim.masked_fill_(~mask_r, max_neg_value)

            attn = sim.softmax(dim=-1)
            out = einsum("b i j, b j d -> b i d", attn, v)
            out = rearrange(out, "(b h) n d -> b n (h d)", h=h)
            return out

        def forward(x: Tensor, context: Tensor | None = None, mask: Tensor | None = None, **kwargs: Any) -> Tensor:
            if not processor.active or len(processor.regmasks) == 0:
                return module._original_forward(x, context, mask, **kwargs)

            h = module.heads
            xs = x.size()[1]

            scale = math.ceil(math.log2(math.sqrt(processor.height * processor.width / xs)))
            dsh = processor._repeat_div(processor.height, scale)
            dsw = processor._repeat_div(processor.width, scale)

            context_to_use = default(context, x)
            total_tokens = context_to_use.shape[1]
            num_chunks = total_tokens // TOKENSCON

            if num_chunks <= 1:
                return module._original_forward(x, context, mask, **kwargs)

            ftrans = Resize((dsh, dsw), interpolation=InterpolationMode("nearest"))

            base_context = context_to_use[:, 0:TOKENSCON, :]
            base_out = _do_attention(module, x, base_context, mask, h)
            base_out = base_out.reshape(base_out.size()[0], dsh, dsw, base_out.size()[2])

            if processor.regbase is not None:
                rmask = processor.regbase
                rmask2 = ftrans(rmask.reshape([1, *rmask.shape]))
                rmask2 = rmask2.reshape(1, dsh, dsw, 1)
                ox = base_out * rmask2
            else:
                ox = torch.zeros_like(base_out)

            for i, rmask in enumerate(processor.regmasks):
                chunk_idx = i + 1
                if chunk_idx < num_chunks:
                    region_context = context_to_use[:, chunk_idx * TOKENSCON:(chunk_idx + 1) * TOKENSCON, :]
                else:
                    region_context = base_context

                region_out = _do_attention(module, x, region_context, mask, h)
                region_out = region_out.reshape(region_out.size()[0], dsh, dsw, region_out.size()[2])

                rmask2 = ftrans(rmask.reshape([1, *rmask.shape]))
                rmask2 = rmask2.reshape(1, dsh, dsw, 1)
                ox = ox + region_out * rmask2

            ox = ox.reshape(x.size()[0], x.size()[1], x.size()[2])
            out = module.to_out(ox)

            return out

        return forward

    def _repeat_div(self, x: int, y: int) -> int:
        """Imitate dimension halving in convolution operations."""
        while y > 0:
            x = math.ceil(x / 2)
            y = y - 1
        return x
