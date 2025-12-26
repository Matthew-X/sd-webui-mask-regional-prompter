/**
 * Mask Regional Prompter - Custom Mask Editor
 * HTML5 Canvas - Fits editor, proper prompt sync, editable inputs
 */

(function () {
    'use strict';

    // Dynamic color generation - MUST MATCH Python's deterministic_colours()
    // Uses binary subdivision for even hue distribution, with S=0.5, V=0.5 in HSV
    function getLayerColor(index) {
        // Compute the hue value using binary subdivision (matches Python exactly)
        function getHueForIndex(idx) {
            if (idx === 0) return 0;
            const cycle = Math.ceil(Math.log2(idx + 1));
            const delta = 1 / Math.pow(2, cycle);
            const posInCycle = idx - Math.pow(2, cycle - 1);
            return delta + 2 * delta * posInCycle;
        }

        const hue = getHueForIndex(index) * 360;

        // Convert HSV (hue, 0.5, 0.5) to RGB - matches Python's colorsys.hsv_to_rgb
        function hsvToRgb(h, s, v) {
            h = h / 360;
            let r, g, b;
            const hi = Math.floor(h * 6) % 6;
            const f = h * 6 - Math.floor(h * 6);
            const p = v * (1 - s);
            const q = v * (1 - f * s);
            const t = v * (1 - (1 - f) * s);
            switch (hi) {
                case 0: r = v; g = t; b = p; break;
                case 1: r = q; g = v; b = p; break;
                case 2: r = p; g = v; b = t; break;
                case 3: r = p; g = q; b = v; break;
                case 4: r = t; g = p; b = v; break;
                case 5: r = v; g = p; b = q; break;
            }
            return [Math.round(r * 256), Math.round(g * 256), Math.round(b * 256)];
        }

        const [r, g, b] = hsvToRgb(hue, 0.5, 0.5);
        // Clamp to 255 since Python uses (CBLACK + 1) = 256 but clips to uint8
        const rgb = [Math.min(255, r), Math.min(255, g), Math.min(255, b)];
        const hex = `#${rgb[0].toString(16).padStart(2, '0')}${rgb[1].toString(16).padStart(2, '0')}${rgb[2].toString(16).padStart(2, '0')}`;

        return {
            hex: hex,
            rgb: rgb,
            bg: `rgba(${rgb[0]}, ${rgb[1]}, ${rgb[2]}, 0.1)`,
            border: `rgb(${Math.max(0, rgb[0] - 30)}, ${Math.max(0, rgb[1] - 30)}, ${Math.max(0, rgb[2] - 30)})`,
            name: `Layer ${index + 1}`
        };
    }

    // Helper to update the hidden JSON field
    function updatePromptsDump(tabId) {
        const dumpEl = document.getElementById(`mrp_prompts_dump_${tabId}`)?.querySelector('textarea');
        if (dumpEl && window.MaskEditors[tabId]) {
            const prompts = window.MaskEditors[tabId].layerPrompts || {};
            const jsonStr = JSON.stringify(prompts);
            if (dumpEl.value !== jsonStr) {
                dumpEl.value = jsonStr;
                dumpEl.dispatchEvent(new Event('input', { bubbles: true }));
            }
        }
    }

    function registerWithTagcomplete(textareas) {
        if (typeof addAutocompleteToArea === 'function') {
            textareas.forEach(ta => {
                if (!ta.classList.contains('autocomplete')) {
                    addAutocompleteToArea(ta);
                }
            });
        }
    }

    function setupTagcompleteForBasePrompts() {
        ['t2i', 'i2i'].forEach(tabId => {
            const basePrompt = document.querySelector(`#mrp_base_prompt_${tabId} textarea`);
            const baseNeg = document.querySelector(`#mrp_base_neg_prompt_${tabId} textarea`);
            const textareas = [basePrompt, baseNeg].filter(Boolean);
            if (textareas.length > 0) {
                registerWithTagcomplete(textareas);
            }
        });
    }

    class MaskEditor {
        constructor(containerId, tabId) {
            this.containerId = containerId;
            this.tabId = tabId;
            this.layerPrompts = {};
            this.container = null;
            this.mainCanvas = null;
            this.ctx = null;

            this.width = 512;
            this.height = 512;

            this.layers = [];
            this.baseImage = null;
            this.activeLayerIndex = 0;

            this.isDrawing = false;
            this.isPanning = false;
            this.isSpaceDown = false; // For spacebar panning
            this.lastX = 0;
            this.lastY = 0;
            this.panStartX = 0;
            this.panStartY = 0;
            this.tool = 'brush'; // 'brush' or 'lasso'
            this.eraserMode = false; // Toggle modifier for erasing instead of drawing
            this.brushSize = 100;
            this.zoom = 1;
            this.maskOpacity = 30; // 0-100: 0 = masks fully visible, 100 = masks transparent (see-through)

            this.cursorPos = null; // {x, y} in canvas coordinates

            // Lasso tool
            this.lassoPath = []; // Array of {x, y} points for lasso selection

            this.saveTimeout = null;

            // Undo/Redo History
            this.history = [];
            this.historyIndex = -1;
            this.MAX_HISTORY = 30;
            this.pendingHistoryState = null; // Stores state before a stroke

            // Pan offset for transform-based panning
            this.panOffsetX = 0;
            this.panOffsetY = 0;

            this.init();
        }

        init() {
            this.container = document.getElementById(this.containerId);
            if (!this.container) {
                return;
            }

            // Don't auto-create layer - wait for user to click Create
            this.syncPromptFields(); // Hide all prompts initially
        }

        setupDOM() {
            this.container.innerHTML = `
                <div class="mrp-editor-viewport">
                    <div class="mrp-canvas-wrapper">
                        <canvas class="mrp-main-canvas"></canvas>
                    </div>
                </div>
                <div class="mrp-layers-panel">
                    <div class="mrp-layers-list"></div>
                </div>
            `;

            this.viewport = this.container.querySelector('.mrp-editor-viewport');
            this.canvasWrapper = this.container.querySelector('.mrp-canvas-wrapper');
            this.mainCanvas = this.container.querySelector('.mrp-main-canvas');
            this.ctx = this.mainCanvas.getContext('2d');
            this.layersList = this.container.querySelector('.mrp-layers-list');

            this.mainCanvas.width = this.width;
            this.mainCanvas.height = this.height;

            this.setupEventListeners();
            this.setupDragAndDrop();
            this.setupVisibilityObserver();
        }

        // Monitor viewport visibility - trigger fitToScreen when container becomes visible
        setupVisibilityObserver() {
            if (!this.viewport) return;

            let wasHidden = true;
            const observer = new ResizeObserver((entries) => {
                for (const entry of entries) {
                    const { width, height } = entry.contentRect;
                    const isVisible = width > 0 && height > 0;

                    if (isVisible && wasHidden) {
                        // Container just became visible - re-fit and render
                        wasHidden = false;
                        setTimeout(() => {
                            this.fitToScreen();
                            this.render();
                        }, 100);
                    } else if (!isVisible) {
                        wasHidden = true;
                    }
                }
            });

            observer.observe(this.viewport);
        }

        setupEventListeners() {
            // Bound handlers for window-level events (allows drawing outside canvas)
            this._onWindowMouseMove = (e) => {
                const c = this.getCanvasCoords(e);
                this.cursorPos = c;

                if (this.isPanning) {
                    this.pan(e);
                } else if (this.isDrawing) {
                    this.draw(e);
                }
                this.render();
            };

            this._onWindowMouseUp = (e) => {
                // Remove window listeners
                window.removeEventListener('mousemove', this._onWindowMouseMove);
                window.removeEventListener('mouseup', this._onWindowMouseUp);

                if (e.button === 1 || this.isPanning) {
                    this.endPan();
                } else {
                    this.endDraw();
                }
            };

            // Drawing - mousedown on canvas starts, then we track on window
            this.mainCanvas.addEventListener('mousedown', (e) => {
                if (e.button === 1 || (e.button === 0 && this.isSpaceDown)) {
                    e.preventDefault();
                    this.startPan(e);
                    // Attach to window for global tracking
                    window.addEventListener('mousemove', this._onWindowMouseMove);
                    window.addEventListener('mouseup', this._onWindowMouseUp);
                } else if (e.button === 0) {
                    this.startDraw(e);
                    // Attach to window for global tracking
                    window.addEventListener('mousemove', this._onWindowMouseMove);
                    window.addEventListener('mouseup', this._onWindowMouseUp);
                }
            });

            // Canvas mousemove for cursor preview when NOT drawing (hover cursor)
            this.mainCanvas.addEventListener('mousemove', (e) => {
                if (!this.isDrawing && !this.isPanning) {
                    const c = this.getCanvasCoords(e);
                    this.cursorPos = c;
                    this.render();
                }
            });

            // Mouseleave - only hide cursor preview, do NOT stop drawing/panning
            this.mainCanvas.addEventListener('mouseleave', () => {
                if (!this.isDrawing && !this.isPanning) {
                    this.cursorPos = null;
                    this.render();
                }
            });

            this.mainCanvas.addEventListener('contextmenu', (e) => e.preventDefault());
            this.mainCanvas.addEventListener('auxclick', (e) => e.preventDefault());

            this.mainCanvas.addEventListener('touchstart', (e) => {
                e.preventDefault();
                this.startDraw(e.touches[0]);
            });
            this.mainCanvas.addEventListener('touchmove', (e) => {
                e.preventDefault();
                // Touch usually doesn't need hover cursor, but we could add it if desired
                this.draw(e.touches[0]);
            });
            this.mainCanvas.addEventListener('touchend', () => this.endDraw());

            // Cursor-centered zoom with Ctrl + mouse wheel - works in both modes
            this.viewport.addEventListener('wheel', (e) => {
                if (!e.ctrlKey) return; // Only zoom with Ctrl+wheel
                e.preventDefault();
                const zoomFactor = e.deltaY > 0 ? 0.9 : 1.1;
                this.setZoomAtPoint(this.zoom * zoomFactor, e.clientX, e.clientY);
            }, { passive: false });

            // Keyboard shortcuts
            this.setupKeyboardShortcuts();
        }

        setupKeyboardShortcuts() {
            const handleKeyDown = (e) => {
                // Only handle if editor is active and no input is focused
                const activeEl = document.activeElement;
                const isInputFocused = activeEl && (activeEl.tagName === 'INPUT' || activeEl.tagName === 'TEXTAREA');
                if (isInputFocused) return;

                // Check if this editor instance is visible/active
                if (!this.container || !this.container.offsetParent) return;

                switch (e.key) {
                    case ' ': // Spacebar for panning
                        if (!this.isSpaceDown) {
                            e.preventDefault();
                            this.isSpaceDown = true;
                            if (this.mainCanvas) this.mainCanvas.style.cursor = 'grab';
                        }
                        break;

                    case 'b':
                    case 'B':
                        e.preventDefault();
                        this.setTool('brush');
                        this.updateToolButtons();
                        break;

                    case 'e':
                    case 'E':
                        e.preventDefault();
                        this.toggleEraserMode();
                        this.updateToolButtons();
                        break;

                    case 'l':
                    case 'L':
                        e.preventDefault();
                        this.setTool('lasso');
                        this.updateToolButtons();
                        break;

                    case '[':
                        e.preventDefault();
                        this.setBrushSize(this.brushSize - 5);
                        this.updateBrushSizeInput();
                        this.render();
                        break;

                    case ']':
                        e.preventDefault();
                        this.setBrushSize(this.brushSize + 5);
                        this.updateBrushSizeInput();
                        this.render();
                        break;

                    case '=':
                    case '+':
                        if (e.ctrlKey) {
                            e.preventDefault();
                            this.setZoom(this.zoom * 1.2);
                        }
                        break;

                    case '-':
                    case '_':
                        if (e.ctrlKey) {
                            e.preventDefault();
                            this.setZoom(this.zoom * 0.8);
                        }
                        break;

                    case '0':
                        if (e.ctrlKey) {
                            e.preventDefault();
                            this.fitToScreen();
                        }
                        break;

                    case 'z':
                    case 'Z':
                        if (e.ctrlKey && !e.shiftKey) {
                            e.preventDefault();
                            this.undo();
                        } else if (e.ctrlKey && e.shiftKey) {
                            e.preventDefault();
                            this.redo();
                        }
                        break;

                    case 'y':
                    case 'Y':
                        if (e.ctrlKey) {
                            e.preventDefault();
                            this.redo();
                        }
                        break;
                }
            };

            const handleKeyUp = (e) => {
                if (e.key === ' ') {
                    this.isSpaceDown = false;
                    if (!this.isPanning) {
                        this.updateCursor();
                    }
                }
            };

            document.addEventListener('keydown', handleKeyDown);
            document.addEventListener('keyup', handleKeyUp);
        }

        updateToolButtons() {
            const brushBtn = document.getElementById(`mrp_brush_btn_${this.tabId}`);
            const eraserBtn = document.getElementById(`mrp_eraser_btn_${this.tabId}`);
            const lassoBtn = document.getElementById(`mrp_lasso_btn_${this.tabId}`);
            const brushSizeContainer = document.getElementById(`mrp_brush_size_${this.tabId}`);

            brushBtn?.classList.remove('mrp-active');
            lassoBtn?.classList.remove('mrp-active');

            if (this.tool === 'brush') brushBtn?.classList.add('mrp-active');
            if (this.tool === 'lasso') lassoBtn?.classList.add('mrp-active');

            if (this.eraserMode) {
                eraserBtn?.classList.add('mrp-eraser-active');
            } else {
                eraserBtn?.classList.remove('mrp-eraser-active');
            }

            // Disable brush size controls when lasso is active
            if (brushSizeContainer) {
                const brushSizeInput = brushSizeContainer.querySelector('input');
                if (this.tool === 'lasso') {
                    brushSizeContainer.classList.add('mrp-disabled');
                    if (brushSizeInput) brushSizeInput.disabled = true;
                } else {
                    brushSizeContainer.classList.remove('mrp-disabled');
                    if (brushSizeInput) brushSizeInput.disabled = false;
                }
            }
        }

        updateBrushSizeInput() {
            const input = document.querySelector(`#mrp_brush_size_${this.tabId} input`);
            if (input) input.value = this.brushSize;
        }

        setupDragAndDrop() {
            const vp = this.viewport;
            if (!vp) return;

            ['dragenter', 'dragover', 'dragleave', 'drop'].forEach(evt => {
                vp.addEventListener(evt, (e) => { e.preventDefault(); e.stopPropagation(); });
            });
            vp.addEventListener('dragenter', () => vp.classList.add('mrp-drag-over'));
            vp.addEventListener('dragleave', () => vp.classList.remove('mrp-drag-over'));
            vp.addEventListener('drop', (e) => {
                vp.classList.remove('mrp-drag-over');
                const files = e.dataTransfer.files;
                if (files.length > 0 && files[0].type.startsWith('image/')) {
                    const reader = new FileReader();
                    reader.onload = (ev) => this.setBaseImage(ev.target.result);
                    reader.readAsDataURL(files[0]);
                }
            });
        }

        // ==================== Panning ====================

        // Check if in fullscreen mode
        isFullscreen() {
            const wrapper = document.getElementById(`mrp_main_wrapper_${this.tabId}`);
            return wrapper && wrapper.classList.contains('mrp-fullscreen-active');
        }

        startPan(e) {
            this.isPanning = true;
            this.panStartMouseX = e.clientX;
            this.panStartMouseY = e.clientY;
            this.panStartOffsetX = this.panOffsetX;
            this.panStartOffsetY = this.panOffsetY;
            if (this.mainCanvas) this.mainCanvas.style.cursor = 'grabbing';
        }

        pan(e) {
            if (!this.isPanning) return;

            const deltaX = e.clientX - this.panStartMouseX;
            const deltaY = e.clientY - this.panStartMouseY;

            this.panOffsetX = this.panStartOffsetX + deltaX;
            this.panOffsetY = this.panStartOffsetY + deltaY;

            this.applyCanvasTransform();
        }

        endPan() {
            this.isPanning = false;
            this.updateCursor();
        }

        // Apply both zoom and pan transforms to the canvas wrapper
        applyCanvasTransform() {
            if (!this.canvasWrapper) return;
            this.canvasWrapper.style.transform = `translate(${this.panOffsetX}px, ${this.panOffsetY}px)`;
        }

        // Reset pan offset (e.g., when fitting to screen)
        resetPanOffset() {
            this.panOffsetX = 0;
            this.panOffsetY = 0;
            this.applyCanvasTransform();
        }

        // ==================== Undo/Redo History ====================

        saveHistoryState() {
            const layer = this.layers[this.activeLayerIndex];
            if (!layer) return;

            // Save current state before modification
            this.pendingHistoryState = {
                layerIndex: this.activeLayerIndex,
                imageData: layer.ctx.getImageData(0, 0, layer.canvas.width, layer.canvas.height)
            };
        }

        commitHistoryState() {
            if (!this.pendingHistoryState) return;

            const layer = this.layers[this.pendingHistoryState.layerIndex];
            if (!layer) {
                this.pendingHistoryState = null;
                return;
            }

            const afterImageData = layer.ctx.getImageData(0, 0, layer.canvas.width, layer.canvas.height);

            // Check if anything actually changed
            const before = this.pendingHistoryState.imageData.data;
            const after = afterImageData.data;
            let changed = false;
            for (let i = 0; i < before.length; i++) {
                if (before[i] !== after[i]) {
                    changed = true;
                    break;
                }
            }

            if (!changed) {
                this.pendingHistoryState = null;
                return;
            }

            // Truncate any redo history
            this.history = this.history.slice(0, this.historyIndex + 1);

            // Push new state
            this.history.push({
                layerIndex: this.pendingHistoryState.layerIndex,
                before: this.pendingHistoryState.imageData,
                after: afterImageData
            });

            // Limit history size
            if (this.history.length > this.MAX_HISTORY) {
                this.history.shift();
            } else {
                this.historyIndex++;
            }

            this.pendingHistoryState = null;
        }

        undo() {
            if (this.historyIndex < 0) {
                return;
            }

            const state = this.history[this.historyIndex];
            const layer = this.layers[state.layerIndex];

            if (layer) {
                layer.ctx.putImageData(state.before, 0, 0);
                this.render();
                this.renderThumbnails();
                this.triggerAutoSave();
            }

            this.historyIndex--;
        }

        redo() {
            if (this.historyIndex >= this.history.length - 1) {
                return;
            }

            this.historyIndex++;
            const state = this.history[this.historyIndex];
            const layer = this.layers[state.layerIndex];

            if (layer) {
                layer.ctx.putImageData(state.after, 0, 0);
                this.render();
                this.renderThumbnails();
                this.triggerAutoSave();
            }
        }

        // ==================== Canvas ====================

        setSize(width, height) {
            this.width = width;
            this.height = height;

            if (this.mainCanvas) {
                this.mainCanvas.width = width;
                this.mainCanvas.height = height;
            }

            this.layers.forEach(layer => {
                const old = layer.canvas;
                layer.canvas = document.createElement('canvas');
                layer.canvas.width = width;
                layer.canvas.height = height;
                layer.ctx = layer.canvas.getContext('2d');
                layer.ctx.drawImage(old, 0, 0);
            });

            this.render();
            this.updateViewportMaxHeight();
            this.fitToScreen();
        }

        createCanvas() {
            // Setup DOM if not exists
            if (!this.mainCanvas) {
                this.setupDOM();
            }

            this.mainCanvas.width = this.width;
            this.mainCanvas.height = this.height;

            this.layers = [];
            this.baseImage = null;
            this.activeLayerIndex = 0;

            // Create first layer
            this.createLayer();

            this.updateViewportMaxHeight();
            this.fitToScreen();
            this.render();
            this.updateLayerPanel();
            this.triggerAutoSave();
        }

        reset() {
            this.layers = [];
            this.baseImage = null;
            this.activeLayerIndex = 0;
            this.zoom = 1;
            this.width = 512;
            this.height = 512;

            this.updateDimensionInputs();
            const zoomInput = document.querySelector(`#mrp_zoom_level_${this.tabId} input`);
            if (zoomInput) zoomInput.value = 100;

            // Show placeholder
            this.container.innerHTML = `
                <div class="mrp-editor-viewport">
                    <div class="mrp-editor-placeholder">
                        <p>Create a canvas or drag & drop an image to start</p>
                    </div>
                </div>
                <div class="mrp-layers-panel">
                    <div class="mrp-layers-list"></div>
                </div>
            `;
            this.viewport = this.container.querySelector('.mrp-editor-viewport');
            this.layersList = this.container.querySelector('.mrp-layers-list');
            this.mainCanvas = null;
            this.ctx = null;
            this.canvasWrapper = null;

            this.setupDragAndDrop();
            this.syncPromptFields();

            // Clear all hidden data fields to ensure state extension saves empty state
            const fieldsToReset = [
                `#mrp_mask_data_${this.tabId} textarea`,
                `#mrp_base_image_data_${this.tabId} textarea`,
                `#mrp_layer_data_${this.tabId} textarea`,
                `#mrp_composite_data_${this.tabId} textarea`,
                `#mrp_prompts_dump_${this.tabId} textarea`
            ];

            fieldsToReset.forEach(selector => {
                const el = document.querySelector(selector);
                if (el && el.value) {
                    el.value = '';
                    el.dispatchEvent(new Event('input', { bubbles: true }));
                }
            });
        }

        fitToScreen() {
            if (!this.viewport || !this.mainCanvas || !this.canvasWrapper) return;

            // 1. Apply layout adjustments for fullscreen mode
            if (this.isFullscreen()) {
                const toolbar = document.querySelector(`#mrp_toolbar_${this.tabId}`);
                const layersPanel = this.container.querySelector('.mrp-layers-panel');

                const toolbarHeight = toolbar ? toolbar.getBoundingClientRect().height : 44;
                const layersPanelHeight = layersPanel ? layersPanel.getBoundingClientRect().height : 80;

                // Explicitly calculate available height for the editor area
                // Use absolute positioning to guarantee exact placement without flex gaps
                const availableHeight = window.innerHeight - toolbarHeight - layersPanelHeight;

                if (this.container) {
                    this.container.style.position = 'absolute';
                    this.container.style.top = `${toolbarHeight}px`;
                    this.container.style.left = '0';
                    this.container.style.width = '100%';
                    this.container.style.height = `${availableHeight}px`;
                    this.container.style.marginTop = '0';
                    this.container.style.marginBottom = '0';
                    this.container.style.zIndex = '50';
                }
            } else {
                if (this.container) {
                    this.container.style.position = '';
                    this.container.style.top = '';
                    this.container.style.left = '';
                    this.container.style.width = '';
                    this.container.style.height = '';
                    this.container.style.marginTop = '';
                    this.container.style.marginBottom = '';
                    this.container.style.zIndex = '';
                }
            }

            // 2. Measure the actual available viewport space AFTER layout changes
            // This ensures we fit to the real visible area, whether fullscreen or not
            const vpRect = this.viewport.getBoundingClientRect();
            const vpWidth = vpRect.width;
            const vpHeight = vpRect.height;

            // 3. Calculate scale to fit
            const scaleX = vpWidth / this.width;
            const scaleY = vpHeight / this.height;
            this.zoom = Math.min(scaleX, scaleY);

            // Cap zoom at 100% (1.0) to prevent upscaling small images
            this.zoom = Math.min(this.zoom, 1);

            // 4. Apply scale
            this.mainCanvas.style.transform = `scale(${this.zoom})`;
            this.mainCanvas.style.transformOrigin = 'top left';

            // 5. Center based on the SAME viewport dimensions we measured
            const scaledWidth = this.width * this.zoom;
            const scaledHeight = this.height * this.zoom;

            // Use Math.max(0, ...) to ensure top-left alignment if zoom > viewport (though min scale prevents this usually)
            // But for "fit to screen", zoom is calculated to fit, so offsets should be >= 0
            this.panOffsetX = (vpWidth - scaledWidth) / 2;
            this.panOffsetY = (vpHeight - scaledHeight) / 2;

            this.applyCanvasTransform();

            // Update zoom input
            const input = document.querySelector(`#mrp_zoom_level_${this.tabId} input`);
            if (input) input.value = Math.round(this.zoom * 100);
        }

        // Update viewport max height based on canvas dimensions
        updateViewportMaxHeight() {
            if (!this.viewport) return;

            // Add some padding (e.g., 50px) to the canvas height for the max viewport height
            const maxHeight = this.height + 50;
            this.viewport.style.setProperty('--viewport-max-height', `${maxHeight}px`);
        }

        setBaseImage(imageData) {
            const img = new Image();
            img.onload = () => {
                this.width = img.width;
                this.height = img.height;

                if (!this.mainCanvas) {
                    this.setupDOM();
                }

                this.mainCanvas.width = img.width;
                this.mainCanvas.height = img.height;
                this.baseImage = img;
                this.updateDimensionInputs();

                this.layers.forEach(layer => {
                    layer.canvas.width = img.width;
                    layer.canvas.height = img.height;
                    layer.ctx = layer.canvas.getContext('2d');
                });

                if (this.layers.length === 0) this.createLayer();

                this.updateViewportMaxHeight();
                this.fitToScreen();
                this.render();
                this.updateLayerPanel();
                this.syncPromptFields();
                this.triggerAutoSave();
            };
            img.src = imageData;
        }

        updateDimensionInputs() {
            const wInput = document.querySelector(`#mrp_width_${this.tabId} input`);
            const hInput = document.querySelector(`#mrp_height_${this.tabId} input`);
            if (wInput) { wInput.value = this.width; wInput.dispatchEvent(new Event('input', { bubbles: true })); }
            if (hInput) { hInput.value = this.height; hInput.dispatchEvent(new Event('input', { bubbles: true })); }
        }

        // ==================== Layers ====================

        createLayer() {
            if (!this.mainCanvas) {
                this.setupDOM();
            }

            const idx = this.layers.length;
            const color = getLayerColor(idx);
            const canvas = document.createElement('canvas');
            canvas.width = this.width;
            canvas.height = this.height;

            this.layers.push({
                id: Date.now() + idx,
                canvas,
                ctx: canvas.getContext('2d'),
                visible: true,
                name: color.name,
                color: color.hex,
                rgb: color.rgb  // Use rgb from getLayerColor
            });

            this.activeLayerIndex = this.layers.length - 1;
            this.updateLayerPanel();
            this.syncPromptFields();
            this.triggerAutoSave();
        }

        recolorLayerContent(layer, oldRgb, newRgb) {
            const ctx = layer.ctx;
            const imageData = ctx.getImageData(0, 0, layer.canvas.width, layer.canvas.height);
            const data = imageData.data;

            for (let i = 0; i < data.length; i += 4) {
                if (Math.abs(data[i] - oldRgb[0]) < 30 &&
                    Math.abs(data[i + 1] - oldRgb[1]) < 30 &&
                    Math.abs(data[i + 2] - oldRgb[2]) < 30 &&
                    data[i + 3] > 0) {
                    data[i] = newRgb[0];
                    data[i + 1] = newRgb[1];
                    data[i + 2] = newRgb[2];
                }
            }

            ctx.putImageData(imageData, 0, 0);
        }

        deleteLayer(index) {
            if (this.layers.length <= 1) return;
            this.layers.splice(index, 1);

            this.layers.forEach((layer, i) => {
                const newColor = getLayerColor(i);
                const oldRgb = layer.rgb;
                const newRgb = newColor.rgb;

                if (oldRgb[0] !== newRgb[0] || oldRgb[1] !== newRgb[1] || oldRgb[2] !== newRgb[2]) {
                    this.recolorLayerContent(layer, oldRgb, newRgb);
                }

                layer.name = newColor.name;
                layer.color = newColor.hex;
                layer.rgb = newRgb;
            });

            if (this.activeLayerIndex >= this.layers.length) {
                this.activeLayerIndex = this.layers.length - 1;
            }
            this.updateLayerPanel();
            this.syncPromptFields();
            this.render();
            this.triggerAutoSave();
        }

        selectLayer(index) {
            if (index >= 0 && index < this.layers.length) {
                this.activeLayerIndex = index;
                this.updateLayerPanel();
            }
        }

        updateLayerPanel() {
            if (!this.layersList) return;

            let html = '';

            if (this.baseImage) {
                html += `<div class="mrp-layer-thumb mrp-layer-base" data-index="-1">
                    <canvas class="mrp-thumb-canvas" width="50" height="50"></canvas>
                    <span class="mrp-layer-name">Base</span>
                </div>`;
            }

            this.layers.forEach((layer, i) => {
                const canDelete = this.layers.length > 1;
                html += `<div class="mrp-layer-thumb ${i === this.activeLayerIndex ? 'mrp-layer-active' : ''}" 
                    data-index="${i}" style="border-color: ${layer.color}">
                    <canvas class="mrp-thumb-canvas" width="50" height="50"></canvas>
                    <span class="mrp-layer-name" style="color: ${layer.color}">${layer.name}</span>
                    ${canDelete ? `<div class="mrp-layer-delete" data-delete="${i}" title="Delete layer">🗑</div>` : ''}
                </div>`;
            });

            html += `<div class="mrp-layer-thumb mrp-layer-add" data-action="add">
                <span class="mrp-add-icon">+</span>
            </div>`;

            this.layersList.innerHTML = html;
            this.renderThumbnails();

            this.layersList.querySelectorAll('.mrp-layer-thumb').forEach(el => {
                el.addEventListener('click', (e) => {
                    if (e.target.classList.contains('mrp-layer-delete')) {
                        const delIdx = parseInt(e.target.dataset.delete);
                        this.deleteLayer(delIdx);
                        return;
                    }

                    if (el.dataset.action === 'add') {
                        this.createLayer();
                        this.render();
                    } else {
                        const idx = parseInt(el.dataset.index);
                        if (idx >= 0) this.selectLayer(idx);
                    }
                });
            });
        }

        renderThumbnails() {
            if (this.baseImage) {
                const thumb = this.layersList.querySelector('[data-index="-1"] .mrp-thumb-canvas');
                if (thumb) {
                    const ctx = thumb.getContext('2d');
                    // ctx.fillStyle = '#1a1a2e';
                    // ctx.fillRect(0, 0, 50, 50);
                    ctx.clearRect(0, 0, 50, 50);
                    const s = Math.min(50 / this.baseImage.width, 50 / this.baseImage.height);
                    ctx.drawImage(this.baseImage, (50 - this.baseImage.width * s) / 2, (50 - this.baseImage.height * s) / 2, this.baseImage.width * s, this.baseImage.height * s);
                }
            }

            this.layers.forEach((layer, i) => {
                const thumb = this.layersList.querySelector(`[data-index="${i}"] .mrp-thumb-canvas`);
                if (thumb) {
                    const ctx = thumb.getContext('2d');
                    // ctx.fillStyle = '#1a1a2e';
                    // ctx.fillRect(0, 0, 50, 50);
                    ctx.clearRect(0, 0, 50, 50);
                    const s = Math.min(50 / this.width, 50 / this.height);
                    ctx.drawImage(layer.canvas, (50 - this.width * s) / 2, (50 - this.height * s) / 2, this.width * s, this.height * s);
                }
            });
        }

        // Sync prompt fields with layers - only show if layers exist
        // Sync prompt fields with layers - Dynamic Generation
        syncPromptFields() {
            const layerCount = this.layers.length;
            const container = document.getElementById(`mrp_prompts_container_${this.tabId}`);
            if (!container) return;

            // Only rebuild if count changed to avoid losing focus if used elsewhere
            // But since we are likely calling this after add/delete, rebuild is fine.
            // If count matches, just update values and return (avoids losing focus if unrelated, but ensures data sync)
            if (container.children.length === layerCount) {
                Array.from(container.children).forEach((wrapper, i) => {
                    const textarea = wrapper.querySelector('textarea');
                    if (textarea) {
                        const val = this.layerPrompts[String(i + 1)] || "";
                        if (textarea.value !== val) textarea.value = val;
                    }
                });
                return;
            }

            container.innerHTML = '';

            for (let i = 1; i <= layerCount; i++) {
                const color = getLayerColor(i - 1);
                const promptText = this.layerPrompts[String(i)] || "";

                const wrapper = document.createElement('div');
                wrapper.className = 'mrp-prompt mrp-prompt-dynamic';
                wrapper.style.setProperty('--layer-color', color.hex);
                wrapper.style.setProperty('--layer-color-bg', color.bg);

                const label = document.createElement('label');
                label.innerHTML = `<span style="display:flex;align-items:center;gap:4px;margin-bottom:2px;font-weight:bold;font-size:12px;color:${color.hex}">● Layer ${i}</span>`;

                const textarea = document.createElement('textarea');
                textarea.value = promptText;
                textarea.rows = 2;
                textarea.className = 'scroll-hide';
                textarea.placeholder = `Prompt for layer ${i}...`;
                textarea.style.width = '100%';
                textarea.style.resize = 'vertical';
                textarea.style.padding = '6px';
                textarea.style.color = 'var(--body-text-color, #eee)';

                // Bind events
                textarea.addEventListener('input', (e) => {
                    this.layerPrompts[String(i)] = e.target.value;
                    updatePromptsDump(this.tabId);
                });

                wrapper.appendChild(label);
                wrapper.appendChild(textarea);
                container.appendChild(wrapper);
            }

            updatePromptsDump(this.tabId);

            setTimeout(() => {
                const textareas = container.querySelectorAll('textarea');
                registerWithTagcomplete(Array.from(textareas));
            }, 100);
        }

        // ==================== Drawing ====================

        getCanvasCoords(e) {
            const rect = this.mainCanvas.getBoundingClientRect();
            return {
                x: (e.clientX - rect.left) * (this.mainCanvas.width / rect.width),
                y: (e.clientY - rect.top) * (this.mainCanvas.height / rect.height)
            };
        }

        startDraw(e) {
            if (this.layers.length === 0 || !this.mainCanvas) return;
            if (this.isSpaceDown) return; // Don't draw while panning

            // Save history state before drawing
            this.saveHistoryState();

            this.isDrawing = true;
            const c = this.getCanvasCoords(e);
            this.lastX = c.x;
            this.lastY = c.y;

            if (this.tool === 'lasso') {
                // Start a new lasso path
                this.lassoPath = [{ x: c.x, y: c.y }];
                this.render();
            } else {
                this.drawPoint(c.x, c.y);
            }
        }

        draw(e) {
            if (!this.isDrawing) return;
            const c = this.getCanvasCoords(e);

            if (this.tool === 'lasso') {
                // Add point to lasso path
                this.lassoPath.push({ x: c.x, y: c.y });
                this.render();
            } else {
                this.drawLine(this.lastX, this.lastY, c.x, c.y);
                this.lastX = c.x;
                this.lastY = c.y;
                this.render();
            }
        }

        endDraw() {
            if (this.isDrawing) {
                this.isDrawing = false;

                if (this.tool === 'lasso' && this.lassoPath.length > 2) {
                    // Complete the lasso - fill the enclosed area
                    this.fillLassoPath();
                    this.lassoPath = [];
                }

                // Commit history state after drawing completes
                this.commitHistoryState();

                this.triggerAutoSave();
                this.renderThumbnails();
            }
        }

        // Fill the lasso selection with the current layer color (or erase if in eraser mode)
        fillLassoPath() {
            const layer = this.layers[this.activeLayerIndex];
            if (!layer || this.lassoPath.length < 3) return;

            const ctx = layer.ctx;
            ctx.save();

            // Use eraser mode if enabled
            if (this.eraserMode) {
                ctx.globalCompositeOperation = 'destination-out';
                ctx.fillStyle = 'rgba(0,0,0,1)';
            } else {
                ctx.globalCompositeOperation = 'source-over';
                ctx.fillStyle = layer.color;
            }

            ctx.beginPath();
            ctx.moveTo(this.lassoPath[0].x, this.lassoPath[0].y);

            for (let i = 1; i < this.lassoPath.length; i++) {
                ctx.lineTo(this.lassoPath[i].x, this.lassoPath[i].y);
            }

            ctx.closePath();
            ctx.fill();
            ctx.restore();

            this.render();
        }

        // Draw the lasso path preview on the main canvas
        drawLassoPreview() {
            if (this.lassoPath.length < 2) return;

            this.ctx.save();
            // Use different colors for eraser mode vs fill mode
            const isErasing = this.eraserMode;
            this.ctx.strokeStyle = isErasing ? 'rgba(255, 100, 100, 0.9)' : 'rgba(255, 255, 255, 0.9)';
            this.ctx.lineWidth = 2 / this.zoom;
            this.ctx.setLineDash([5 / this.zoom, 5 / this.zoom]);

            this.ctx.beginPath();
            this.ctx.moveTo(this.lassoPath[0].x, this.lassoPath[0].y);

            for (let i = 1; i < this.lassoPath.length; i++) {
                this.ctx.lineTo(this.lassoPath[i].x, this.lassoPath[i].y);
            }

            // Draw line back to start if close to completion
            if (this.lassoPath.length > 2) {
                this.ctx.lineTo(this.lassoPath[0].x, this.lassoPath[0].y);
            }

            this.ctx.stroke();

            // Draw fill preview with low opacity
            if (this.lassoPath.length > 2) {
                if (isErasing) {
                    // Show eraser preview as dark/transparent
                    this.ctx.fillStyle = 'rgba(0, 0, 0, 0.3)';
                } else {
                    const layer = this.layers[this.activeLayerIndex];
                    if (layer) {
                        this.ctx.fillStyle = layer.color;
                        this.ctx.globalAlpha = 0.2;
                    }
                }
                this.ctx.fill();
            }

            this.ctx.restore();

            // Draw start point indicator
            this.ctx.save();
            this.ctx.fillStyle = isErasing ? '#dc3545' : '#6366f1';
            this.ctx.beginPath();
            this.ctx.arc(this.lassoPath[0].x, this.lassoPath[0].y, 6 / this.zoom, 0, Math.PI * 2);
            this.ctx.fill();
            this.ctx.restore();
        }

        drawCursor() {
            if (!this.cursorPos || !this.ctx || this.isPanning) return;

            const { x, y } = this.cursorPos;
            const size = this.brushSize;

            this.ctx.save();
            this.ctx.beginPath();

            // Draw visual cursor
            this.ctx.arc(x, y, size / 2, 0, Math.PI * 2);

            // High contrast stroke
            this.ctx.strokeStyle = 'rgba(255, 255, 255, 0.8)';
            this.ctx.lineWidth = 1 / this.zoom; // Keep line width constant regardless of zoom
            this.ctx.stroke();

            // Inner dark stroke for visibility on light backgrounds
            this.ctx.beginPath();
            this.ctx.arc(x, y, size / 2, 0, Math.PI * 2);
            this.ctx.strokeStyle = 'rgba(0, 0, 0, 0.5)';
            this.ctx.lineWidth = 1 / this.zoom;
            // Offset logic for inner stroke not strictly necessary if we just use a contrasting color
            // or we can draw it slightly smaller/larger? 
            // Let's just do a simple white outline with a slight shadow effect via shadowBlur or just simple
            // white is usually enough on dark canvas, but we have checkerboard.
            // Let's stick to the white stroke above, maybe add a fill?
            // No fill, we want to see what we are masking.
            // Let's add a dash pattern for "marching ants" look? Nah too complex.
            // Simple white ring is standard. 
            // Let's add a black outline *outside* the white one for max contrast.
            this.ctx.stroke();

            this.ctx.restore();
        }

        drawPoint(x, y) {
            const layer = this.layers[this.activeLayerIndex];
            if (!layer) return;
            const ctx = layer.ctx;
            ctx.globalCompositeOperation = this.eraserMode ? 'destination-out' : 'source-over';
            ctx.fillStyle = this.eraserMode ? 'rgba(0,0,0,1)' : layer.color;
            ctx.beginPath();
            ctx.arc(x, y, this.brushSize / 2, 0, Math.PI * 2);
            ctx.fill();
            this.render();
        }

        drawLine(x1, y1, x2, y2) {
            const layer = this.layers[this.activeLayerIndex];
            if (!layer) return;
            const ctx = layer.ctx;
            ctx.globalCompositeOperation = this.eraserMode ? 'destination-out' : 'source-over';
            ctx.strokeStyle = this.eraserMode ? 'rgba(0,0,0,1)' : layer.color;
            ctx.lineWidth = this.brushSize;
            ctx.lineCap = 'round';
            ctx.lineJoin = 'round';
            ctx.beginPath();
            ctx.moveTo(x1, y1);
            ctx.lineTo(x2, y2);
            ctx.stroke();
        }

        // ==================== Rendering ====================

        render() {
            if (!this.ctx) return;

            // Use clearRect to let CSS background (theme variable) show through
            // this.ctx.fillStyle = '#252540';
            // this.ctx.fillRect(0, 0, this.width, this.height);
            this.ctx.clearRect(0, 0, this.width, this.height);
            this.drawCheckerboard();

            if (this.baseImage) {
                this.ctx.globalAlpha = 1;
                this.ctx.drawImage(this.baseImage, 0, 0);
            }

            // Opacity slider: 100% = see through masks (transparent), 0% = masks fully visible
            // Convert slider value (0-100) to alpha (1-0)
            const maskAlpha = 1 - (this.maskOpacity / 100);

            this.layers.forEach((layer, i) => {
                if (layer.visible) {
                    // Active layer slightly more visible, but scaled by global mask opacity
                    const baseAlpha = i === this.activeLayerIndex ? 0.9 : 0.6;
                    this.ctx.globalAlpha = baseAlpha * maskAlpha;
                    this.ctx.drawImage(layer.canvas, 0, 0);
                }
            });

            this.ctx.globalAlpha = 1;

            // Draw lasso preview if in lasso mode and drawing
            if (this.tool === 'lasso' && this.lassoPath.length > 0) {
                this.drawLassoPreview();
            }

            // Draw Cursor on top of everything (hide for lasso tool entirely)
            if (this.tool !== 'lasso') {
                this.drawCursor();
            }
        }

        drawCheckerboard() {
            const size = 16;
            // Use semi-transparent fill so it works on both dark and light CSS backgrounds
            this.ctx.fillStyle = 'rgba(128, 128, 128, 0.15)';
            for (let y = 0; y < this.height; y += size) {
                for (let x = 0; x < this.width; x += size) {
                    if ((x / size + y / size) % 2 === 0) {
                        this.ctx.fillRect(x, y, size, size);
                    }
                }
            }
        }

        // ==================== Tools ====================

        setTool(tool) {
            // Clear lasso path if switching away from lasso
            if (this.tool === 'lasso' && tool !== 'lasso') {
                this.lassoPath = [];
                this.render();
            }

            this.tool = tool;
            this.updateCursor();
            this.updateToolButtons();
        }

        // Toggle eraser mode (works with both brush and lasso)
        setEraserMode(enabled) {
            this.eraserMode = enabled;
            this.updateCursor();
        }

        // Toggle eraser mode on/off
        toggleEraserMode() {
            this.eraserMode = !this.eraserMode;
            this.updateCursor();
            return this.eraserMode;
        }

        // Update cursor based on current tool and eraser mode
        updateCursor() {
            if (!this.mainCanvas) return;

            if (this.eraserMode) {
                this.mainCanvas.style.cursor = 'cell';
            } else if (this.tool === 'lasso') {
                this.mainCanvas.style.cursor = 'crosshair';
            } else {
                this.mainCanvas.style.cursor = 'crosshair';
            }
        }

        setBrushSize(size) {
            this.brushSize = Math.max(1, Math.min(200, size));
        }

        setZoom(level) {
            this.zoom = Math.max(0.1, Math.min(4, level));

            if (this.mainCanvas) {
                this.mainCanvas.style.transform = `scale(${this.zoom})`;
                this.mainCanvas.style.transformOrigin = 'top left';
            }

            const input = document.querySelector(`#mrp_zoom_level_${this.tabId} input`);
            if (input) input.value = Math.round(this.zoom * 100);
        }

        // Zoom towards a specific screen point (for cursor-centered zoom)
        setZoomAtPoint(newZoom, clientX, clientY) {
            if (!this.viewport || !this.canvasWrapper) {
                this.setZoom(newZoom);
                return;
            }

            const oldZoom = this.zoom;
            newZoom = Math.max(0.1, Math.min(4, newZoom));

            // Get wrapper position including current pan offset
            const wrapperRect = this.canvasWrapper.getBoundingClientRect();

            // Mouse position relative to the canvas wrapper (considering current transform)
            const mouseXInWrapper = clientX - wrapperRect.left;
            const mouseYInWrapper = clientY - wrapperRect.top;

            // Canvas coordinates under cursor (in original canvas space)
            const canvasX = mouseXInWrapper / oldZoom;
            const canvasY = mouseYInWrapper / oldZoom;

            // Apply new zoom - only transform the canvas, don't change wrapper size
            this.zoom = newZoom;
            this.mainCanvas.style.transform = `scale(${this.zoom})`;
            this.mainCanvas.style.transformOrigin = 'top left';

            // Calculate where the same canvas point would be at new zoom
            const newMouseXInWrapper = canvasX * newZoom;
            const newMouseYInWrapper = canvasY * newZoom;

            // Adjust pan offset to keep the canvas point under cursor
            this.panOffsetX += mouseXInWrapper - newMouseXInWrapper;
            this.panOffsetY += mouseYInWrapper - newMouseYInWrapper;
            this.applyCanvasTransform();

            const input = document.querySelector(`#mrp_zoom_level_${this.tabId} input`);
            if (input) input.value = Math.round(this.zoom * 100);
        }

        setMaskOpacity(opacity) {
            this.maskOpacity = Math.max(0, Math.min(100, opacity));
            this.render();
        }

        // ==================== Data ====================

        triggerAutoSave() {
            clearTimeout(this.saveTimeout);
            this.saveTimeout = setTimeout(() => this.saveToGradio(), 300);
        }

        saveToGradio() {
            if (!this.mainCanvas) return;

            // 1. Create "Clean Mask" for generation (White background + layers)
            const cleanMask = document.createElement('canvas');
            cleanMask.width = this.width;
            cleanMask.height = this.height;
            const cleanCtx = cleanMask.getContext('2d');

            cleanCtx.fillStyle = '#ffffff';
            cleanCtx.fillRect(0, 0, this.width, this.height);
            this.layers.forEach(l => cleanCtx.drawImage(l.canvas, 0, 0));

            const cleanDataUrl = cleanMask.toDataURL('image/png');
            const stateEl = document.querySelector(`#mrp_mask_data_${this.tabId} textarea`);
            if (stateEl) {
                stateEl.value = cleanDataUrl;
                stateEl.dispatchEvent(new Event('input', { bubbles: true }));
            }

            // 2. Create "Composite" for save preview (Base image OR white + layers)
            const composite = document.createElement('canvas');
            composite.width = this.width;
            composite.height = this.height;
            const compCtx = composite.getContext('2d');

            if (this.baseImage) {
                // Draw base image as background
                compCtx.drawImage(this.baseImage, 0, 0, this.width, this.height);
            } else {
                // No base image, use white background
                compCtx.fillStyle = '#ffffff';
                compCtx.fillRect(0, 0, this.width, this.height);
            }
            this.layers.forEach(l => compCtx.drawImage(l.canvas, 0, 0));

            const compositeDataUrl = composite.toDataURL('image/png');
            const compositeEl = document.querySelector(`#mrp_composite_data_${this.tabId} textarea`);
            if (compositeEl) {
                compositeEl.value = compositeDataUrl;
                compositeEl.dispatchEvent(new Event('input', { bubbles: true }));
            }

            // 3. Serialize exact layer data for metadata persistence
            const layersData = this.layers.map(l => ({
                name: l.name,
                color: l.color,
                rgb: l.rgb,
                image: l.canvas.toDataURL('image/png')
            }));

            const layerStateEl = document.querySelector(`#mrp_layer_data_${this.tabId} textarea`);
            if (layerStateEl) {
                layerStateEl.value = JSON.stringify(layersData);
                layerStateEl.dispatchEvent(new Event('input', { bubbles: true }));
            }

            // 4. Serialize base image for restoration
            if (this.baseImage) {
                const baseCanvas = document.createElement('canvas');
                baseCanvas.width = this.baseImage.width || this.width;
                baseCanvas.height = this.baseImage.height || this.height;
                const baseCtx = baseCanvas.getContext('2d');
                baseCtx.drawImage(this.baseImage, 0, 0);
                const baseImageDataUrl = baseCanvas.toDataURL('image/png');

                const baseImageEl = document.querySelector(`#mrp_base_image_data_${this.tabId} textarea`);
                if (baseImageEl) {
                    baseImageEl.value = baseImageDataUrl;
                    baseImageEl.dispatchEvent(new Event('input', { bubbles: true }));
                }
            } else {
                // Clear base image data if no base image
                const baseImageEl = document.querySelector(`#mrp_base_image_data_${this.tabId} textarea`);
                if (baseImageEl && baseImageEl.value) {
                    baseImageEl.value = '';
                    baseImageEl.dispatchEvent(new Event('input', { bubbles: true }));
                }
            }
        }

        exportMaskImage() {
            if (!this.mainCanvas) return null;

            const composite = document.createElement('canvas');
            composite.width = this.width;
            composite.height = this.height;
            const ctx = composite.getContext('2d');
            ctx.fillStyle = '#ffffff';
            ctx.fillRect(0, 0, this.width, this.height);
            this.layers.forEach(l => ctx.drawImage(l.canvas, 0, 0));
            return composite.toDataURL('image/png');
        }

        // Load editor state from mask image data (reconstructs layers from colors)
        loadFromMaskData(imageData, layerDataJson) {
            if (!imageData) return;

            const img = new Image();
            img.onload = () => {
                this.width = img.width;
                this.height = img.height;

                if (!this.mainCanvas) {
                    this.setupDOM();
                }

                this.mainCanvas.width = img.width;
                this.mainCanvas.height = img.height;

                // Check for metadata first (Exact Restore)
                if (layerDataJson) {
                    try {
                        const layers = JSON.parse(layerDataJson);
                        if (Array.isArray(layers) && layers.length > 0) {
                            this.loadFromLayerJson(layers, img.width, img.height);
                            return;
                        }
                    } catch (e) {
                        // Parse failed, fallback to image analysis
                    }
                }

                // Fallback: Reconstruct from image analysis
                this.loadFromImageAnalysis(img);
            };
            img.src = imageData;
        }

        loadFromLayerJson(layers, width, height) {
            this.layers = [];
            let loadedCount = 0;

            layers.forEach((lData, index) => {
                const canvas = document.createElement('canvas');
                canvas.width = width;
                canvas.height = height;
                const ctx = canvas.getContext('2d');

                const layerImg = new Image();
                layerImg.onload = () => {
                    ctx.drawImage(layerImg, 0, 0);
                    loadedCount++;

                    if (loadedCount === layers.length) {
                        this.finishLoading();
                    }
                };
                layerImg.src = lData.image;

                this.layers.push({
                    id: Date.now() + index,
                    canvas,
                    ctx,
                    visible: true,
                    name: lData.name,
                    color: lData.color,
                    rgb: lData.rgb
                });
            });
        }

        loadFromImageAnalysis(img) {
            // Clear existing layers
            this.layers = [];

            // Create a temp canvas to analyze the image
            const tempCanvas = document.createElement('canvas');
            tempCanvas.width = img.width;
            tempCanvas.height = img.height;
            const tempCtx = tempCanvas.getContext('2d');
            tempCtx.drawImage(img, 0, 0);

            const imgData = tempCtx.getImageData(0, 0, img.width, img.height);
            const data = imgData.data;

            // Find unique colors (excluding white background)
            const uniqueColors = [];
            const TOLERANCE = 20;

            for (let i = 0; i < data.length; i += 4) {
                const r = data[i];
                const g = data[i + 1];
                const b = data[i + 2];
                const a = data[i + 3];

                // Skip white (background) and transparent
                if ((r > 250 && g > 250 && b > 250) || a < 128) continue;

                let matched = false;
                for (const existing of uniqueColors) {
                    if (Math.abs(r - existing[0]) < TOLERANCE &&
                        Math.abs(g - existing[1]) < TOLERANCE &&
                        Math.abs(b - existing[2]) < TOLERANCE) {
                        matched = true;
                        break;
                    }
                }

                if (!matched) {
                    uniqueColors.push([r, g, b]);
                }
            }

            uniqueColors.forEach((rgb, index) => {
                const color = getLayerColor(index);
                const canvas = document.createElement('canvas');
                canvas.width = img.width;
                canvas.height = img.height;
                const ctx = canvas.getContext('2d');

                // Extract pixels of this color
                const layerData = ctx.createImageData(img.width, img.height);

                for (let i = 0; i < data.length; i += 4) {
                    const r = data[i];
                    const g = data[i + 1];
                    const b = data[i + 2];

                    // Check if this pixel matches this layer's original color (within tolerance)
                    if (Math.abs(r - rgb[0]) < 20 &&
                        Math.abs(g - rgb[1]) < 20 &&
                        Math.abs(b - rgb[2]) < 20) {
                        // Use the standardized layer color
                        layerData.data[i] = color.rgb[0];
                        layerData.data[i + 1] = color.rgb[1];
                        layerData.data[i + 2] = color.rgb[2];
                        layerData.data[i + 3] = 255;
                    }
                }

                ctx.putImageData(layerData, 0, 0);

                this.layers.push({
                    id: Date.now() + index,
                    canvas,
                    ctx,
                    visible: true,
                    name: color.name,
                    color: color.hex,
                    rgb: color.rgb
                });
            });

            // Ensure at least one layer exists
            if (this.layers.length === 0) {
                this.createLayer();
            }

            this.finishLoading();
        }

        finishLoading() {
            this.activeLayerIndex = 0;
            this.updateDimensionInputs();
            this.updateViewportMaxHeight();
            this.fitToScreen();
            this.render();
            this.updateLayerPanel();
            this.syncPromptFields();
            this.triggerAutoSave();
        }
    }

    // ==================== Editable Number Inputs ====================

    function setupInputs(tabId) {
        const configs = [
            { selector: `#mrp_width_${tabId}`, step: 64, min: 64, max: 4096 },
            { selector: `#mrp_height_${tabId}`, step: 64, min: 64, max: 4096 },
            { selector: `#mrp_brush_size_${tabId}`, step: 1, min: 1, max: 200, onChange: (v) => MaskEditorAPI.setBrushSize(tabId, v) },
            { selector: `#mrp_zoom_level_${tabId}`, step: 10, min: 10, max: 400, onChange: (v) => { const e = window.MaskEditors[tabId]; if (e) e.setZoom(v / 100); } },
            { selector: `#mrp_layer_opacity_${tabId}`, step: 5, min: 0, max: 100, onChange: (v) => { const e = window.MaskEditors[tabId]; if (e) e.setMaskOpacity(v); } }
        ];

        configs.forEach(cfg => {
            const wrapper = document.querySelector(cfg.selector);
            if (!wrapper) return;

            const input = wrapper.querySelector('input');
            if (!input) return;

            // Standard editable input
            input.type = 'number';
            input.style.cursor = 'text';
            input.removeAttribute('readonly');

            // Create arrow buttons
            const arrowUp = document.createElement('div');
            arrowUp.className = 'mrp-arrow mrp-arrow-up';
            arrowUp.innerHTML = '▲';
            arrowUp.title = `+${cfg.step}`;

            const arrowDown = document.createElement('div');
            arrowDown.className = 'mrp-arrow mrp-arrow-down';
            arrowDown.innerHTML = '▼';
            arrowDown.title = `-${cfg.step}`;

            wrapper.style.position = 'relative';
            wrapper.appendChild(arrowUp);
            wrapper.appendChild(arrowDown);

            arrowUp.addEventListener('click', (e) => {
                e.preventDefault();
                e.stopPropagation();
                const val = Math.min(cfg.max, (parseFloat(input.value) || 0) + cfg.step);
                input.value = val;
                input.dispatchEvent(new Event('input', { bubbles: true }));
                input.dispatchEvent(new Event('change', { bubbles: true }));
                if (cfg.onChange) cfg.onChange(val);
            });

            arrowDown.addEventListener('click', (e) => {
                e.preventDefault();
                e.stopPropagation();
                const val = Math.max(cfg.min, (parseFloat(input.value) || 0) - cfg.step);
                input.value = val;
                input.dispatchEvent(new Event('input', { bubbles: true }));
                input.dispatchEvent(new Event('change', { bubbles: true }));
                if (cfg.onChange) cfg.onChange(val);
            });

            // On change (manual typing)
            input.addEventListener('change', () => {
                let val = parseFloat(input.value) || cfg.min;
                val = Math.max(cfg.min, Math.min(cfg.max, val));
                input.value = val;
                if (cfg.onChange) cfg.onChange(val);
            });

            input.addEventListener('keydown', (e) => {
                if (e.key === 'Enter') {
                    input.blur();
                }
            });
        });

        // Initialize dump
        updatePromptsDump(tabId);
    }

    // ==================== Button Setup ====================

    function setupButtons(tabId) {
        const createBtn = document.getElementById(`mrp_create_canvas_${tabId}`);
        if (createBtn) {
            createBtn.addEventListener('click', () => {
                const wInput = document.querySelector(`#mrp_width_${tabId} input`);
                const hInput = document.querySelector(`#mrp_height_${tabId} input`);
                const w = parseInt(wInput?.value) || 512;
                const h = parseInt(hInput?.value) || 512;
                MaskEditorAPI.createCanvas(tabId, w, h);
            });
        }

        const resetBtn = document.getElementById(`mrp_reset_${tabId}`);
        if (resetBtn) {
            resetBtn.addEventListener('click', () => {
                MaskEditorAPI.reset(tabId);
            });
        }

        const fromSD = document.getElementById(`mrp_copy_sd_${tabId}`);
        if (fromSD) {
            fromSD.addEventListener('click', () => {
                const prefix = tabId === 't2i' ? 'txt2img' : 'img2img';
                const selectors = [
                    `#${prefix}_width input[type="number"]`,
                    `#${prefix}_width input`,
                    `[id*="${prefix}_width"] input`
                ];
                let wVal = 512, hVal = 512;

                for (const sel of selectors) {
                    const wEl = document.querySelector(sel);
                    const hEl = document.querySelector(sel.replace('width', 'height'));
                    if (wEl && hEl) {
                        wVal = parseInt(wEl.value) || 512;
                        hVal = parseInt(hEl.value) || 512;
                        break;
                    }
                }

                const wInput = document.querySelector(`#mrp_width_${tabId} input`);
                const hInput = document.querySelector(`#mrp_height_${tabId} input`);
                if (wInput) { wInput.value = wVal; wInput.dispatchEvent(new Event('input', { bubbles: true })); }
                if (hInput) { hInput.value = hVal; hInput.dispatchEvent(new Event('input', { bubbles: true })); }
            });
        }

        const fsBtn = document.getElementById(`mrp_fullscreen_btn_${tabId}`);
        if (fsBtn) {
            fsBtn.title = 'Enter Fullscreen';

            fsBtn.addEventListener('click', () => {
                const wrapper = document.getElementById(`mrp_main_wrapper_${tabId}`);
                if (wrapper) {
                    wrapper.classList.toggle('mrp-fullscreen-active');
                    const isFullscreen = wrapper.classList.contains('mrp-fullscreen-active');
                    document.body.style.overflow = isFullscreen ? 'hidden' : '';

                    if (isFullscreen) {
                        fsBtn.classList.remove('mrp-fullscreen-btn');
                        fsBtn.classList.add('mrp-fullscreen-active-btn');
                    } else {
                        fsBtn.classList.remove('mrp-fullscreen-active-btn');
                        fsBtn.classList.add('mrp-fullscreen-btn');
                    }

                    fsBtn.title = isFullscreen ? 'Exit Fullscreen' : 'Enter Fullscreen';
                    // Fit to screen after toggling fullscreen
                    setTimeout(() => {
                        const editor = window.MaskEditors[tabId];
                        if (editor) editor.fitToScreen();
                    }, 100);
                }
            });
        }

        const fitViewBtn = document.getElementById(`mrp_fit_view_btn_${tabId}`);
        if (fitViewBtn) {
            fitViewBtn.addEventListener('click', () => {
                const editor = window.MaskEditors[tabId];
                if (editor) editor.fitToScreen();
            });
        }

        const brushBtn = document.getElementById(`mrp_brush_btn_${tabId}`);
        const eraserBtn = document.getElementById(`mrp_eraser_btn_${tabId}`);
        const lassoBtn = document.getElementById(`mrp_lasso_btn_${tabId}`);

        // Clear tool selection (brush/lasso only, not eraser toggle)
        const clearToolActive = () => {
            brushBtn?.classList.remove('mrp-active');
            lassoBtn?.classList.remove('mrp-active');
        };

        if (brushBtn) brushBtn.addEventListener('click', () => {
            MaskEditorAPI.setTool(tabId, 'brush');
            clearToolActive();
            brushBtn.classList.add('mrp-active');
        });

        // Eraser is a toggle modifier, not a tool
        if (eraserBtn) eraserBtn.addEventListener('click', () => {
            const isActive = MaskEditorAPI.toggleEraserMode(tabId);
            if (isActive) {
                eraserBtn.classList.add('mrp-eraser-active');
            } else {
                eraserBtn.classList.remove('mrp-eraser-active');
            }
        });

        if (lassoBtn) lassoBtn.addEventListener('click', () => {
            MaskEditorAPI.setTool(tabId, 'lasso');
            clearToolActive();
            lassoBtn.classList.add('mrp-active');
        });

        // Save button - sync canvas to Gradio before save handler fires
        const saveBtn = document.getElementById(`mrp_save_btn_${tabId}`);
        if (saveBtn) {
            saveBtn.addEventListener('click', () => {
                const editor = window.MaskEditors[tabId];
                if (editor) {
                    // Sync canvas state to Gradio BEFORE the save handler fires
                    editor.saveToGradio();
                }
            }, true);  // Use capture phase to fire before Gradio's handler
        }
    }

    // ==================== Global API ====================

    window.MaskEditors = window.MaskEditors || {};

    function initEditor(tabId) {
        const containerId = `mrp_canvas_${tabId}`;
        const container = document.getElementById(containerId);

        if (container && !window.MaskEditors[tabId]) {
            window.MaskEditors[tabId] = new MaskEditor(containerId, tabId);
            setupButtons(tabId);
            setupInputs(tabId);
        }
    }

    window.MaskEditorAPI = {
        init: initEditor,
        get: (tabId) => window.MaskEditors[tabId],
        createCanvas: (tabId, w, h) => {
            const editor = window.MaskEditors[tabId];
            if (editor) { editor.setSize(w, h); editor.createCanvas(); }
        },
        reset: (tabId) => {
            const editor = window.MaskEditors[tabId];
            if (editor) editor.reset();
        },
        loadImage: (tabId, data) => {
            const editor = window.MaskEditors[tabId];
            if (editor) editor.setBaseImage(data);
        },
        setTool: (tabId, tool) => {
            const editor = window.MaskEditors[tabId];
            if (editor) editor.setTool(tool);
        },
        setEraserMode: (tabId, enabled) => {
            const editor = window.MaskEditors[tabId];
            if (editor) editor.setEraserMode(enabled);
        },
        toggleEraserMode: (tabId) => {
            const editor = window.MaskEditors[tabId];
            if (editor) return editor.toggleEraserMode();
            return false;
        },
        setBrushSize: (tabId, size) => {
            const editor = window.MaskEditors[tabId];
            if (editor) editor.setBrushSize(size);
        },
        setZoom: (tabId, level) => {
            const editor = window.MaskEditors[tabId];
            if (editor) editor.setZoom(level / 100);
        },
        exportMask: (tabId) => {
            const editor = window.MaskEditors[tabId];
            return editor ? editor.exportMaskImage() : null;
        },
        setMaskOpacity: (tabId, opacity) => {
            const editor = window.MaskEditors[tabId];
            if (editor) editor.setMaskOpacity(opacity);
        },
        fitToScreen: (tabId) => {
            const editor = window.MaskEditors[tabId];
            if (editor) editor.fitToScreen();
        },
        loadMaskData: (tabId, imageData, layerData) => {
            const editor = window.MaskEditors[tabId];
            if (editor) editor.loadFromMaskData(imageData, layerData);
        }
    };

    function initAll() {
        const check = setInterval(() => {
            const t2i = document.getElementById('mrp_canvas_t2i');
            const i2i = document.getElementById('mrp_canvas_i2i');
            if (t2i) initEditor('t2i');
            if (i2i) initEditor('i2i');
            if (t2i || i2i) clearInterval(check);
        }, 500);
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', initAll);
    } else {
        initAll();
    }

    // ... (Interception code skipped for brevity, keeping as is) ...
    // Note: Since I am replacing a chunk, I must ensure I don't delete the interception code if it overlaps.
    // However, the target content for replacement seems to be further down?
    // Let me target MaskEditorAPI specifically and MRPLoadFile specifically.
    // I will use multi_replace for safer editing.


    // ==================== Prompt Interception System ====================

    // Track the currently focused MRP prompt field
    window.MRPActivePrompt = {
        tabId: null,
        element: null,
        type: null // 'base', 'base_neg', or layer number as string
    };

    // Setup prompt focus tracking for a tab
    function setupPromptTracking(tabId) {
        // Track base prompt focus
        const basePrompt = document.querySelector(`#mrp_base_prompt_${tabId} textarea`);
        if (basePrompt) {
            basePrompt.addEventListener('focus', () => {
                window.MRPActivePrompt = { tabId, element: basePrompt, type: 'base' };
            });
        }

        // Track base negative prompt focus
        const baseNeg = document.querySelector(`#mrp_base_neg_prompt_${tabId} textarea`);
        if (baseNeg) {
            baseNeg.addEventListener('focus', () => {
                window.MRPActivePrompt = { tabId, element: baseNeg, type: 'base_neg' };
            });
        }

        // Use MutationObserver to track dynamically created layer prompts
        const promptsContainer = document.getElementById(`mrp_prompts_container_${tabId}`);
        if (promptsContainer) {
            const observer = new MutationObserver(() => {
                // Re-attach focus listeners to all layer textareas
                promptsContainer.querySelectorAll('textarea').forEach((textarea, index) => {
                    // Remove old listener to prevent duplicates
                    textarea.removeEventListener('focus', textarea._mrpFocusHandler);

                    textarea._mrpFocusHandler = () => {
                        window.MRPActivePrompt = { tabId, element: textarea, type: String(index + 1) };
                    };
                    textarea.addEventListener('focus', textarea._mrpFocusHandler);
                });
            });
            observer.observe(promptsContainer, { childList: true, subtree: true });
        }
    }

    // Toggle SD WebUI prompt greying based on extension state
    function updateSDPromptState(tabId, enabled) {
        const prefix = tabId === 't2i' ? 'txt2img' : 'img2img';

        // Find the SD WebUI prompt containers
        const promptSelectors = [
            `#${prefix}_prompt_container`,
            `#${prefix}_neg_prompt_container`,
            `#${prefix}_prompt`,
            `#${prefix}_neg_prompt`,
            `[id*="${prefix}_prompt"]`,
            `[id*="${prefix}_neg_prompt"]`
        ];

        // Add/remove the disabled class
        promptSelectors.forEach(sel => {
            document.querySelectorAll(sel).forEach(el => {
                if (enabled) {
                    el.classList.add('mrp-sd-prompt-disabled');
                } else {
                    el.classList.remove('mrp-sd-prompt-disabled');
                }
            });
        });

        // Also target the main prompt textareas more specifically
        const promptTextarea = document.querySelector(`#${prefix}_prompt textarea`);
        const negPromptTextarea = document.querySelector(`#${prefix}_neg_prompt textarea`);

        [promptTextarea, negPromptTextarea].forEach(textarea => {
            if (textarea) {
                if (enabled) {
                    textarea.classList.add('mrp-sd-prompt-disabled');
                    textarea.setAttribute('data-mrp-disabled', 'true');
                } else {
                    textarea.classList.remove('mrp-sd-prompt-disabled');
                    textarea.removeAttribute('data-mrp-disabled');
                }
            }
        });
    }

    // Intercept extra network card clicks (LoRA, embeddings, etc.)
    // Strategy: Let SD WebUI insert into its prompts, then capture and redirect to MRP prompts
    function setupExtraNetworkInterception() {
        // Track what was in the SD prompts before any insertion
        let lastPositivePrompt = { t2i: '', i2i: '' };
        let lastNegativePrompt = { t2i: '', i2i: '' };
        let pendingRedirect = null;

        // Store the last known content of SD prompts
        function captureSDPromptState() {
            ['t2i', 'i2i'].forEach(tabId => {
                const prefix = tabId === 't2i' ? 'txt2img' : 'img2img';
                const posPrompt = document.querySelector(`#${prefix}_prompt textarea`);
                const negPrompt = document.querySelector(`#${prefix}_neg_prompt textarea`);
                if (posPrompt) lastPositivePrompt[tabId] = posPrompt.value;
                if (negPrompt) lastNegativePrompt[tabId] = negPrompt.value;
            });
        }

        // Check what was added to SD prompts and redirect to MRP
        function checkAndRedirect(tabId) {
            if (!window.MRPActivePrompt.element) return;

            const prefix = tabId === 't2i' ? 'txt2img' : 'img2img';
            const posPrompt = document.querySelector(`#${prefix}_prompt textarea`);
            const negPrompt = document.querySelector(`#${prefix}_neg_prompt textarea`);

            if (!posPrompt || !negPrompt) return;

            const newPositive = posPrompt.value;
            const newNegative = negPrompt.value;
            const oldPositive = lastPositivePrompt[tabId];
            const oldNegative = lastNegativePrompt[tabId];

            // Detect what was added
            let addedPositive = '';
            let addedNegative = '';

            if (newPositive !== oldPositive) {
                // Find what was added
                if (newPositive.startsWith(oldPositive)) {
                    addedPositive = newPositive.slice(oldPositive.length);
                } else if (newPositive.endsWith(oldPositive)) {
                    addedPositive = newPositive.slice(0, newPositive.length - oldPositive.length);
                } else {
                    // More complex change - try to find the difference
                    addedPositive = newPositive.replace(oldPositive, '');
                }
                addedPositive = addedPositive.trim();
            }

            if (newNegative !== oldNegative) {
                if (newNegative.startsWith(oldNegative)) {
                    addedNegative = newNegative.slice(oldNegative.length);
                } else if (newNegative.endsWith(oldNegative)) {
                    addedNegative = newNegative.slice(0, newNegative.length - oldNegative.length);
                } else {
                    addedNegative = newNegative.replace(oldNegative, '');
                }
                addedNegative = addedNegative.trim();
            }

            // Restore SD prompts to their original state
            if (newPositive !== oldPositive) {
                posPrompt.value = oldPositive;
                posPrompt.dispatchEvent(new Event('input', { bubbles: true }));
            }
            if (newNegative !== oldNegative) {
                negPrompt.value = oldNegative;
                negPrompt.dispatchEvent(new Event('input', { bubbles: true }));
            }

            // Now insert into MRP prompts
            if (addedPositive) {
                insertIntoMRPPrompt(addedPositive, 'positive', tabId);
            }
            if (addedNegative) {
                insertIntoMRPNegativePrompt(addedNegative, tabId);
            }

            // Update our stored state
            lastPositivePrompt[tabId] = oldPositive;
            lastNegativePrompt[tabId] = oldNegative;
        }

        // Insert text into the currently focused MRP prompt - always appends at end
        function insertIntoMRPPrompt(text, type, tabId) {
            const textarea = window.MRPActivePrompt.element;
            if (!textarea) return;

            // Clean incoming text
            text = text.trim();
            if (!text) return;

            // Extract LoRA/Hypernet name for toggle detection
            const loraMatch = text.match(/<lora:([^:>]+):[^>]+>/i);
            const hyperMatch = text.match(/<hypernet:([^:>]+):[^>]+>/i);

            let networkName = null;
            let networkType = null;

            if (loraMatch) {
                networkName = loraMatch[1];
                networkType = 'lora';
            } else if (hyperMatch) {
                networkName = hyperMatch[1];
                networkType = 'hypernet';
            }

            let currentValue = textarea.value.trim();

            // Check if this LoRA/network is already in the prompt (toggle OFF)
            if (networkName) {
                const tagPrefix = networkType === 'lora' ? 'lora' : 'hypernet';
                const checkPattern = new RegExp(`<${tagPrefix}:${escapeRegex(networkName)}:[\\d.]+>`, 'i');

                if (checkPattern.test(currentValue)) {
                    // REMOVE MODE: Remove the LoRA and all associated trigger words
                    console.log(`[MRP] Removing ${networkType}: ${networkName}`);

                    // Extract trigger words from the text being toggled
                    const textWithoutNetworkTag = text.replace(/<[^>]+>/g, '').trim();
                    const triggers = textWithoutNetworkTag
                        .split(/[,\s]+/)
                        .map(t => t.trim())
                        .filter(t => t.length > 0);

                    // Remove the network tag (with any weight value)
                    const removeTagPattern = new RegExp(`\\s*,?\\s*<${tagPrefix}:${escapeRegex(networkName)}:[\\d.]+>\\s*,?\\s*`, 'gi');
                    currentValue = currentValue.replace(removeTagPattern, ', ');

                    // Remove each trigger word
                    triggers.forEach(trigger => {
                        // Match the trigger word with optional surrounding commas/spaces
                        const triggerPattern = new RegExp(`\\s*,?\\s*\\b${escapeRegex(trigger)}\\b\\s*,?\\s*`, 'gi');
                        currentValue = currentValue.replace(triggerPattern, ', ');
                    });

                    // Clean up formatting
                    currentValue = cleanupPromptFormatting(currentValue);

                    textarea.value = currentValue;
                    textarea.dispatchEvent(new Event('input', { bubbles: true }));

                    return;
                }
            }

            // ADD MODE: Append at the end of the prompt

            let newValue = currentValue;

            // Add comma separator if there's existing content
            if (newValue.length > 0) {
                // Check if it already ends with comma or space
                if (!newValue.endsWith(',') && !newValue.endsWith(' ')) {
                    newValue += ', ';
                } else if (newValue.endsWith(',')) {
                    newValue += ' ';
                } else if (newValue.endsWith(' ') && !newValue.endsWith(', ')) {
                    // Ends with space but not ", " - add comma before
                    newValue = newValue.trimEnd() + ', ';
                }
            }

            newValue += text;
            newValue = cleanupPromptFormatting(newValue);

            textarea.value = newValue;
            // Position cursor at the end
            textarea.selectionStart = textarea.selectionEnd = newValue.length;
            textarea.dispatchEvent(new Event('input', { bubbles: true }));
            textarea.focus();
        }

        // Insert into the MRP base negative prompt - always appends at end
        function insertIntoMRPNegativePrompt(text, tabId) {
            const negPrompt = document.querySelector(`#mrp_base_neg_prompt_${tabId} textarea`);
            if (!negPrompt) return;

            text = text.trim();
            if (!text) return;

            let currentValue = negPrompt.value.trim();

            // Check if already present (toggle removal)
            // For negative prompts, just check if the exact text exists
            if (currentValue.includes(text)) {
                // Remove it
                let newValue = currentValue.replace(text, '');
                newValue = cleanupPromptFormatting(newValue);
                negPrompt.value = newValue;
                negPrompt.dispatchEvent(new Event('input', { bubbles: true }));
                return;
            }

            // Add separator if needed and append at end
            let newValue = currentValue;
            if (newValue.length > 0) {
                if (!newValue.endsWith(',') && !newValue.endsWith(' ')) {
                    newValue += ', ';
                } else if (newValue.endsWith(',')) {
                    newValue += ' ';
                } else if (newValue.endsWith(' ') && !newValue.endsWith(', ')) {
                    newValue = newValue.trimEnd() + ', ';
                }
            }

            newValue += text;
            negPrompt.value = cleanupPromptFormatting(newValue);
            negPrompt.dispatchEvent(new Event('input', { bubbles: true }));
        }

        // Clean up prompt formatting (extra spaces, commas)
        function cleanupPromptFormatting(text) {
            return text
                .replace(/,\s*,/g, ',')           // Double commas -> single
                .replace(/\s+,/g, ',')             // Space before comma -> comma
                .replace(/,\s+/g, ', ')            // Normalize comma spacing
                .replace(/\s{2,}/g, ' ')           // Multiple spaces -> single
                .replace(/^\s*,\s*/, '')           // Leading comma
                .replace(/\s*,\s*$/, '')           // Trailing comma
                .trim();
        }

        // Monitor SD prompts for changes
        function setupSDPromptMonitors() {
            ['t2i', 'i2i'].forEach(tabId => {
                const prefix = tabId === 't2i' ? 'txt2img' : 'img2img';

                const checkPrompts = setInterval(() => {
                    const posPrompt = document.querySelector(`#${prefix}_prompt textarea`);
                    const negPrompt = document.querySelector(`#${prefix}_neg_prompt textarea`);

                    if (posPrompt && negPrompt) {
                        clearInterval(checkPrompts);

                        // Initial capture
                        lastPositivePrompt[tabId] = posPrompt.value;
                        lastNegativePrompt[tabId] = negPrompt.value;

                        // Monitor for changes with a debounced check
                        let changeTimeout = null;

                        const handleChange = () => {
                            const mrpActive = document.querySelector(`#mrp_active_${tabId} input[type="checkbox"]`)?.checked;
                            if (!mrpActive || !window.MRPActivePrompt.element) {
                                // Not active or no focused prompt, just update our cache
                                lastPositivePrompt[tabId] = posPrompt.value;
                                lastNegativePrompt[tabId] = negPrompt.value;
                                return;
                            }

                            // Debounce to catch all changes from a single card click
                            clearTimeout(changeTimeout);
                            changeTimeout = setTimeout(() => {
                                checkAndRedirect(tabId);
                            }, 50);
                        };

                        posPrompt.addEventListener('input', handleChange);
                        negPrompt.addEventListener('input', handleChange);
                    }
                }, 500);
            });
        }

        // Also intercept card clicks to capture state before SD processes them
        document.addEventListener('mousedown', (e) => {
            // Allow auxiliary buttons to work normally
            const isAuxButton = e.target.closest('.metadata-button') ||
                e.target.closest('.edit-button') ||
                e.target.closest('.copy-path-button') ||
                e.target.closest('[onclick*="copy"]') ||
                e.target.closest('[onclick*="metadata"]') ||
                e.target.closest('[onclick*="settings"]') ||
                e.target.closest('.additional') ||
                e.target.closest('.button-row') ||
                e.target.closest('.actions') ||
                e.target.tagName === 'A' ||
                e.target.closest('a');

            if (isAuxButton) return;

            const card = e.target.closest('.card');
            if (!card) return;

            const isExtraNetworkCard = card.closest('.extra-network-cards') ||
                card.closest('[id*="extra"]') ||
                card.dataset.name;

            if (!isExtraNetworkCard) return;

            // Capture current state before SD WebUI processes the click
            captureSDPromptState();
        }, true);

        // Initialize monitors
        setupSDPromptMonitors();
    }

    // Helper function to escape regex special characters
    function escapeRegex(string) {
        return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }

    // Setup checkbox listeners for the active toggle
    function setupActiveToggleListeners() {
        ['t2i', 'i2i'].forEach(tabId => {
            const checkInterval = setInterval(() => {
                const checkbox = document.querySelector(`#mrp_active_${tabId} input[type="checkbox"]`);
                if (checkbox) {
                    clearInterval(checkInterval);

                    // Initial state
                    updateSDPromptState(tabId, checkbox.checked);

                    // Listen for changes
                    checkbox.addEventListener('change', () => {
                        updateSDPromptState(tabId, checkbox.checked);
                    });

                    // Setup prompt tracking
                    setupPromptTracking(tabId);
                }
            }, 500);
        });
    }

    // Initialize interception system
    function initInterception() {
        setupActiveToggleListeners();
        setupExtraNetworkInterception();
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', initInterception);
    } else {
        setTimeout(initInterception, 1000); // Delay to ensure SD WebUI elements are loaded
    }

    // ==================== Save/Load File Browser ====================

    // Global functions for file browser interactions (called from HTML onclick)
    window.MRPLoadFile = function (tabId, filename) {
        const selectedFileInput = document.querySelector(`#mrp_selected_file_${tabId} textarea, #mrp_selected_file_${tabId} input`);
        const loadTrigger = document.querySelector(`#mrp_load_trigger_${tabId}`);

        if (selectedFileInput && loadTrigger) {
            selectedFileInput.value = filename;
            selectedFileInput.dispatchEvent(new Event('input', { bubbles: true }));

            // Small delay to ensure value is set, then trigger load
            // The actual data application is handled by MRP_ApplyLoad called from Gradio's .then()
            setTimeout(() => {
                loadTrigger.click();
            }, 50);
        }
    };

    // Called by Gradio .then() after on_load completes - receives data directly
    window.MRP_ApplyLoad = function (tabId, maskData, basePrompt, baseNegPrompt, promptsDump, layerData, baseImageData) {
        const editor = window.MaskEditors[tabId];
        if (!editor) {
            return;
        }

        // Helper to finish loading after base image (or immediately if no base image)
        const finishLoad = () => {
            // Load layers from mask data
            if (maskData) {
                if (window.MaskEditorAPI) {
                    window.MaskEditorAPI.loadMaskData(tabId, maskData, layerData || null);
                }
            }

            // Restore prompts
            if (promptsDump) {
                try {
                    const prompts = JSON.parse(promptsDump);
                    editor.layerPrompts = prompts;
                    editor.syncPromptFields();
                } catch (e) {
                    // Parse failed
                }
            }

            editor.updateViewportMaxHeight();
            editor.fitToScreen();
            editor.render();
            editor.updateLayerPanel();
        };

        // Load base image first if present (async), then load layers on top
        if (baseImageData) {
            const img = new Image();
            img.onload = () => {
                editor.width = img.width;
                editor.height = img.height;

                if (!editor.mainCanvas) {
                    editor.setupDOM();
                }

                editor.mainCanvas.width = img.width;
                editor.mainCanvas.height = img.height;
                editor.baseImage = img;
                editor.updateDimensionInputs();

                finishLoad();
            };
            img.onerror = () => {
                finishLoad();
            };
            img.src = baseImageData;
        } else {
            // No base image, proceed directly
            finishLoad();
        }
    };

    window.MRPDeleteFile = function (tabId, filename) {
        if (!confirm(`Delete "${filename}"?`)) return;

        const selectedFileInput = document.querySelector(`#mrp_selected_file_${tabId} textarea, #mrp_selected_file_${tabId} input`);
        const deleteTrigger = document.querySelector(`#mrp_delete_trigger_${tabId}`);

        if (selectedFileInput && deleteTrigger) {
            selectedFileInput.value = filename;
            selectedFileInput.dispatchEvent(new Event('input', { bubbles: true }));

            setTimeout(() => {
                deleteTrigger.click();
            }, 50);
        }
    };

    window.MRPRefreshFiles = function (tabId) {
        const refreshTrigger = document.querySelector(`#mrp_refresh_trigger_${tabId}`);
        if (refreshTrigger) {
            refreshTrigger.click();
        }
    };

    // ==================== Auto-Save on Generate ====================

    function setupAutoSaveOnGenerate() {
        // Hook into the generate buttons for txt2img and img2img
        const hookGenerateButton = (prefix, tabId) => {
            const checkButton = setInterval(() => {
                const generateBtn = document.querySelector(`#${prefix}_generate`);

                if (generateBtn) {
                    clearInterval(checkButton);

                    // Add a click listener that fires before generation
                    generateBtn.addEventListener('click', () => {
                        // Check if MRP is active and auto-save is enabled
                        const activeCheckbox = document.querySelector(`#mrp_active_${tabId} input[type="checkbox"]`);
                        const autoSaveCheckbox = document.querySelector(`#mrp_auto_save_${tabId} input[type="checkbox"]`);

                        if (activeCheckbox?.checked && autoSaveCheckbox?.checked) {
                            // Trigger a save with empty filename (will auto-generate timestamp)
                            const saveBtn = document.querySelector(`#mrp_save_btn_${tabId}`);
                            const filenameInput = document.querySelector(`#mrp_filename_${tabId} textarea, #mrp_filename_${tabId} input`);

                            if (saveBtn && filenameInput) {
                                // Clear filename to trigger auto-timestamp
                                filenameInput.value = '';
                                filenameInput.dispatchEvent(new Event('input', { bubbles: true }));

                                // Click save
                                setTimeout(() => {
                                    saveBtn.click();
                                }, 100);
                            }
                        }
                    }, true);  // Use capture to fire before other handlers
                }
            }, 500);
        };

        hookGenerateButton('txt2img', 't2i');
        hookGenerateButton('img2img', 'i2i');
    }

    // Initialize auto-save hooks
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', setupAutoSaveOnGenerate);
    } else {
        setTimeout(setupAutoSaveOnGenerate, 1500);
    }

    let mrpTagcompleteBaseInit = false;
    const tagcompleteCheckInterval = setInterval(() => {
        if (mrpTagcompleteBaseInit) {
            clearInterval(tagcompleteCheckInterval);
            return;
        }

        if (typeof addAutocompleteToArea !== 'function' || typeof TAC_CFG === 'undefined' || !TAC_CFG) {
            return;
        }

        ['t2i', 'i2i'].forEach(tabId => {
            const basePrompt = document.querySelector(`#mrp_base_prompt_${tabId} textarea`);
            const baseNeg = document.querySelector(`#mrp_base_neg_prompt_${tabId} textarea`);

            [basePrompt, baseNeg].forEach(ta => {
                if (ta && !ta.classList.contains('autocomplete')) {
                    addAutocompleteToArea(ta);
                }
            });
        });

        mrpTagcompleteBaseInit = true;
        clearInterval(tagcompleteCheckInterval);
    }, 500);

})();
