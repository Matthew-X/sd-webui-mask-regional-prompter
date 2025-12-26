# Mask Regional Prompter

A Stable Diffusion WebUI (Forge/reForge compatible) extension for region-based prompting using color-coded masks.

## ✨ Features

*   **Custom Mask Editor**: HTML5 Canvas editor with brush and lasso tools.
*   **Infinite Layers**: Create an unlimited number of mask layers, each with its own prompt.
*   **Deterministic Colors**: Automatic, consistent color assignment to layers.
*   **Base Image Support**: Drag and drop a reference image to draw over.
*   **Save & Load**: Save and restore your mask/prompt configurations.
*   **Keyboard Shortcuts**: `B` for Brush, `L` for Lasso, `E` for Eraser toggle, `[`/`]` for brush size, and more.

## 📦 Installation

1.  Navigate to your WebUI's `extensions` directory.
2.  Clone this repository:
    ```bash
    git clone https://github.com/<YOUR_USERNAME>/sd-webui-mask-regional-prompter.git
    ```
3.  Restart the WebUI.

## 🚀 Usage

1.  Open the **txt2img** or **img2img** tab.
2.  Find the **Mask Regional Prompter** accordion panel.
3.  Enable the extension.
4.  Set canvas dimensions or upload a base image.
5.  Add layers and draw masks for each region.
6.  Enter prompts for each layer.
7.  Generate!

## 🎨 Mask Editor Shortcuts

| Key       | Action           |
| :-------- | :--------------- |
| `B`       | Brush Tool       |
| `L`       | Lasso Tool       |
| `E`       | Toggle Eraser    |
| `[` / `]` | Decrease/Increase Brush Size |
| `Ctrl+Z`  | Undo             |
| `Ctrl+Y`  | Redo             |
| `Ctrl+0`  | Fit to Screen    |
| `Space`   | Pan (Hold)       |

## 📜 License

MIT License
