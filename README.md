# Mask Regional Prompter

A Stable Diffusion WebUI (Forge/reForge compatible) extension for region-based prompting using color-coded masks.

> **Note:** This extension is currently in early development. Please be aware that you may encounter bugs or unexpected behaviors.

![Generation Result](example%20generation%20result.png)

## ✨ Features

*   **Custom Mask Editor**: HTML5 Canvas editor with brush and lasso tools.
*   **Infinite Layers**: Create an unlimited number of mask layers, each with its own prompt.
*   **Deterministic Colors**: Automatic, consistent color assignment to layers.
*   **Base Image Support**: Drag and drop a reference image to draw over.
*   **Save & Load**: Save and restore your mask/prompt configurations.
*   **Keyboard Shortcuts**: `B` for Brush, `L` for Lasso, `E` for Eraser toggle, `[`/`]` for brush size, and more.

## 📸 Examples

### Mask Interface
The extension provides a full-featured mask editor directly in the WebUI. You can upload a **Base Image** to serve as a reference, allowing you to easily trace and mask specific areas of your composition.
![Mask Editor](example%20editor.png)

### Regional Prompts & Management
Define prompts for each region independently. Save your layer setups to recall them later.
![Prompts and Save/Load](example%20prompts%20and%20save_load.png)

### Advanced Prompting Capabilities
You can use LoRAs and other standard prompt features within individual regions.
![LoRA in Prompts](example%20lora%20in%20prompts.png)

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

## 🤝 Compatibility & Integration

*   **Integrated Support**: Works seamlessly with [a1111-sd-webui-tagcomplete](https://github.com/DominikDoom/a1111-sd-webui-tagcomplete) for prompt autocompletion and [stable-diffusion-webui-state](https://github.com/ilian6806/stable-diffusion-webui-state) for preserving extension state across reloads.
*   **ControlNet usage**: Regional prompting results are often significantly improved when used in combination with ControlNet.

## 🙏 Credits

*   Implementation concepts and inspiration drawn from [sd-webui-regional-prompter](https://github.com/hako-mikan/sd-webui-regional-prompter) by **hako-mikan**.

## 📜 License

GNU AFFERO GENERAL PUBLIC LICENSE
