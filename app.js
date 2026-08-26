"use strict";

/* =========================================================
   Floorplanner Pro - Performance Optimized
   2D / 3D floor planner
   Pointer Events based interaction
   Desktop + Tablet + Smartphone
========================================================= */

const canvas = document.getElementById("c2d");
const ctx = canvas.getContext("2d");
const viewport = document.getElementById("viewport");
const container3d = document.getElementById("canvas3d");

/* Element type cache for O(1) lookups */
const RECTANGULAR_TYPES = new Set(["room", "bed", "sofa", "table"]);
const LINEAR_TYPES = new Set(["wall", "door", "window"]);

const state = {
    tool: "room",
    view: "2d",

    elements: [],
    selected: null,

    snap: true,
    gridSize: 20,

    zoom: 1,
    minZoom: 0.25,
    maxZoom: 4,

    panX: 0,
    panY: 0,

    pointerMap: new Map(),

    drawing: false,
    dragging: false,
    panning: false,

    startWorld: null,
    currentWorld: null,

    dragOffsetX: 0,
    dragOffsetY: 0,

    pinchStartDistance: 0,
    pinchStartZoom: 1,

    panStartX: 0,
    panStartY: 0,
    panOriginX: 0,
    panOriginY: 0,

    history: [],
    historyIndex: -1,
    lastHistoryState: null,

    renderer3d: null,
    scene3d: null,
    camera3d: null,

    spatialIndex: null,
    spatialIndexDirty: true,

    statsCache: { dirty: true, value: "Area: 0 m²" }
};


/* =========================================================
   DOM
========================================================= */

const statsBadge = document.getElementById("stats-badge");
const snapButton = document.getElementById("snap-btn");
const deleteButton = document.getElementById("deleteBtn");
const zoomInButton = document.getElementById("zoomInBtn");
const zoomOutButton = document.getElementById("zoomOutBtn");
const fitButton = document.getElementById("fitBtn");

const undoButton = document.getElementById("undoBtn");
const redoButton = document.getElementById("redoBtn");

const btn2d = document.getElementById("btn2d");
const btn3d = document.getElementById("btn3d");

const exportButton = document.getElementById("exportBtn");
const importInput = document.getElementById("importInput");
const clearButton = document.getElementById("clearBtn");

let menuItemsCache = null;
function getMenuItems() {
    if (!menuItemsCache) {
        menuItemsCache = document.querySelectorAll(".menu-item");
    }
    return menuItemsCache;
}


/* =========================================================
   Utility
========================================================= */

function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
}

function distance(a, b) {
    return Math.hypot(
        a.clientX - b.clientX,
        a.clientY - b.clientY
    );
}

function midpoint(a, b) {
    return {
        x: (a.clientX + b.clientX) / 2,
        y: (a.clientY + b.clientY) / 2
    };
}

function deepClone(value) {
    if (typeof structuredClone !== 'undefined') {
        return structuredClone(value);
    }
    return JSON.parse(JSON.stringify(value));
}


/* =========================================================
   Spatial Indexing
========================================================= */

class SpatialIndex {
    constructor(cellSize = 100) {
        this.cellSize = cellSize;
        this.cells = new Map();
    }

    clear() {
        this.cells.clear();
    }

    add(element, id) {
        const bounds = this.getBounds(element);
        const minCellX = Math.floor(bounds.minX / this.cellSize);
        const maxCellX = Math.floor(bounds.maxX / this.cellSize);
        const minCellY = Math.floor(bounds.minY / this.cellSize);
        const maxCellY = Math.floor(bounds.maxY / this.cellSize);

        for (let x = minCellX; x <= maxCellX; x++) {
            for (let y = minCellY; y <= maxCellY; y++) {
                const key = `${x},${y}`;
                if (!this.cells.has(key)) {
                    this.cells.set(key, []);
                }
                this.cells.get(key).push(id);
            }
        }
    }

    getBounds(element) {
        if (RECTANGULAR_TYPES.has(element.type)) {
            return {
                minX: element.x,
                minY: element.y,
                maxX: element.x + element.w,
                maxY: element.y + element.h
            };
        } else {
            return {
                minX: Math.min(element.x1, element.x2),
                minY: Math.min(element.y1, element.y2),
                maxX: Math.max(element.x1, element.x2),
                maxY: Math.max(element.y1, element.y2)
            };
        }
    }

    query(x, y) {
        const cellX = Math.floor(x / this.cellSize);
        const cellY = Math.floor(y / this.cellSize);
        const key = `${cellX},${cellY}`;
        return this.cells.get(key) || [];
    }
}

const spatialIndex = new SpatialIndex(200);

function rebuildSpatialIndex() {
    spatialIndex.clear();
    state.elements.forEach((el, i) => {
        spatialIndex.add(el, i);
    });
    state.spatialIndexDirty = false;
}


/* =========================================================
   Canvas Resize
========================================================= */

function resizeCanvas() {
    const rect = viewport.getBoundingClientRect();

    const dpr = Math.min(window.devicePixelRatio || 1, 2);

    canvas.width = Math.max(1, Math.round(rect.width * dpr));
    canvas.height = Math.max(1, Math.round(rect.height * dpr));

    canvas.style.width = `${rect.width}px`;
    canvas.style.height = `${rect.height}px`;

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    redraw2D();
}

window.addEventListener("resize", resizeCanvas);

if ("ResizeObserver" in window) {
    new ResizeObserver(resizeCanvas).observe(viewport);
}


/* =========================================================
   Coordinate System
========================================================= */

function screenToWorld(clientX, clientY) {
    const rect = viewport.getBoundingClientRect();

    const sx = clientX - rect.left;
    const sy = clientY - rect.top;

    return {
        x: (sx - state.panX) / state.zoom,
        y: (sy - state.panY) / state.zoom
    };
}

function worldToScreen(x, y) {
    return {
        x: x * state.zoom + state.panX,
        y: y * state.zoom + state.panY
    };
}

function snap(value) {
    if (!state.snap) return value;
    return Math.round(value / state.gridSize) * state.gridSize;
}

function getWorldPosition(event) {
    const p = screenToWorld(
        event.clientX,
        event.clientY
    );

    return {
        x: snap(p.x),
        y: snap(p.y)
    };
}


/* =========================================================
   Tool Management
========================================================= */

function setTool(tool) {
    state.tool = tool;
    state.selected = null;
    state.drawing = false;
    state.dragging = false;
    state.panning = false;

    getMenuItems().forEach(item => {
        item.classList.toggle(
            "active",
            item.dataset.tool === tool
        );
    });

    canvas.style.cursor =
        tool === "select"
            ? "default"
            : "crosshair";

    redraw2D();
}

getMenuItems().forEach(item => {
    item.addEventListener("click", () => {
        setTool(item.dataset.tool);
    });
});


/* =========================================================
   View
========================================================= */

function switchView(view) {
    state.view = view;

    btn2d.classList.toggle("active", view === "2d");
    btn3d.classList.toggle("active", view === "3d");

    if (view === "3d") {
        canvas.style.display = "none";
        container3d.style.display = "block";
        render3D();
    } else {
        container3d.style.display = "none";
        canvas.style.display = "block";
        resizeCanvas();
    }
}

btn2d.addEventListener("click", () => switchView("2d"));
btn3d.addEventListener("click", () => switchView("3d"));


/* =========================================================
   Snap
========================================================= */

function toggleSnap() {
    state.snap = !state.snap;
    snapButton.classList.toggle(
        "active-snap",
        state.snap
    );
}

snapButton.addEventListener("click", toggleSnap);


/* =========================================================
   Element Hit Testing
========================================================= */

function pointInRect(x, y, el) {
    return (
        x >= el.x &&
        x <= el.x + el.w &&
        y >= el.y &&
        y <= el.y + el.h
    );
}

function distanceToSegment(px, py, x1, y1, x2, y2) {
    const dx = x2 - x1;
    const dy = y2 - y1;

    if (dx === 0 && dy === 0) {
        return Math.hypot(px - x1, py - y1);
    }

    const t = clamp(
        ((px - x1) * dx + (py - y1) * dy) /
        (dx * dx + dy * dy),
        0,
        1
    );

    const cx = x1 + t * dx;
    const cy = y1 + t * dy;

    return Math.hypot(px - cx, py - cy);
}

function hitTest(x, y) {
    if (state.spatialIndexDirty) {
        rebuildSpatialIndex();
    }

    const candidateIndices = spatialIndex.query(x, y);

    for (let i = candidateIndices.length - 1; i >= 0; i--) {
        const idx = candidateIndices[i];
        const el = state.elements[idx];

        if (RECTANGULAR_TYPES.has(el.type)) {
            if (pointInRect(x, y, el)) {
                return el;
            }
        } else {
            const threshold =
                Math.max(10, 10 / state.zoom);

            if (
                distanceToSegment(
                    x,
                    y,
                    el.x1,
                    el.y1,
                    el.x2,
                    el.y2
                ) <= threshold
            ) {
                return el;
            }
        }
    }

    return null;
}


/* =========================================================
   Pointer Interaction
========================================================= */

canvas.addEventListener("pointerdown", onPointerDown);
canvas.addEventListener("pointermove", onPointerMove);
canvas.addEventListener("pointerup", onPointerUp);
canvas.addEventListener("pointercancel", onPointerUp);
canvas.addEventListener("pointerleave", onPointerLeave);

function onPointerDown(event) {
    event.preventDefault();

    canvas.setPointerCapture(event.pointerId);

    state.pointerMap.set(event.pointerId, event);

    if (state.pointerMap.size >= 2) {
        beginPinch();
        return;
    }

    const world = getWorldPosition(event);

    if (state.tool === "select") {

        const hit = hitTest(world.x, world.y);

        if (hit) {
            state.selected = hit;

            if (RECTANGULAR_TYPES.has(hit.type)) {
                state.dragOffsetX =
                    world.x - hit.x;

                state.dragOffsetY =
                    world.y - hit.y;
            } else {
                state.dragOffsetX =
                    world.x - hit.x1;

                state.dragOffsetY =
                    world.y - hit.y1;
            }

            state.dragging = true;
            saveHistoryPoint();

        } else {
            state.selected = null;

            beginPan(
                event.clientX,
                event.clientY
            );
        }

        redraw2D();
        return;
    }

    if (["bed", "sofa", "table"].includes(state.tool)) {
        createObject(
            state.tool,
            world.x,
            world.y
        );

        redraw2D();
        return;
    }

    state.drawing = true;
    state.startWorld = {
        x: world.x,
        y: world.y
    };

    state.currentWorld = {
        x: world.x,
        y: world.y
    };
}

function onPointerMove(event) {
    event.preventDefault();

    state.pointerMap.set(event.pointerId, event);

    if (state.pointerMap.size >= 2) {
        updatePinch();
        return;
    }

    const world = getWorldPosition(event);

    if (state.dragging && state.selected) {
        moveSelected(world);
        state.spatialIndexDirty = true;
        redraw2D();
        return;
    }

    if (state.panning) {
        const dx =
            event.clientX - state.panStartX;

        const dy =
            event.clientY - state.panStartY;

        state.panX =
            state.panOriginX + dx;

        state.panY =
            state.panOriginY + dy;

        redraw2D();
        return;
    }

    if (state.drawing) {
        state.currentWorld = world;
        redraw2D();
    }
}

function onPointerUp(event) {
    state.pointerMap.delete(event.pointerId);

    if (state.pointerMap.size === 0) {

        if (state.dragging) {
            state.dragging = false;
            commitHistory();
        }

        if (state.panning) {
            state.panning = false;
        }

        if (state.drawing) {
            finishDrawing();
        }

        state.pinchStartDistance = 0;
    }
}

function onPointerLeave() {
    /* Pointer capture handles actual release. */
}


/* =========================================================
   Pinch Zoom
========================================================= */

function beginPinch() {
    const points =
        [...state.pointerMap.values()];

    if (points.length < 2) return;

    state.pinchStartDistance =
        distance(points[0], points[1]);

    state.pinchStartZoom =
        state.zoom;

    state.panning = false;
    state.dragging = false;
    state.drawing = false;
}

function updatePinch() {
    const points =
        [...state.pointerMap.values()];

    if (points.length < 2) return;

    const currentDistance =
        distance(points[0], points[1]);

    if (!state.pinchStartDistance) {
        beginPinch();
        return;
    }

    const center =
        midpoint(points[0], points[1]);

    const ratio =
        currentDistance /
        state.pinchStartDistance;

    zoomAt(
        center.x,
        center.y,
        state.pinchStartZoom * ratio
    );
}


/* =========================================================
   Pan
========================================================= */

function beginPan(clientX, clientY) {
    state.panning = true;

    state.panStartX = clientX;
    state.panStartY = clientY;

    state.panOriginX = state.panX;
    state.panOriginY = state.panY;
}


/* =========================================================
   Zoom
========================================================= */

function zoomAt(clientX, clientY, targetZoom) {
    const rect =
        viewport.getBoundingClientRect();

    const sx = clientX - rect.left;
    const sy = clientY - rect.top;

    const oldZoom = state.zoom;

    const newZoom =
        clamp(
            targetZoom,
            state.minZoom,
            state.maxZoom
        );

    if (newZoom === oldZoom) return;

    const worldX =
        (sx - state.panX) / oldZoom;

    const worldY =
        (sy - state.panY) / oldZoom;

    state.zoom = newZoom;

    state.panX =
        sx - worldX * newZoom;

    state.panY =
        sy - worldY * newZoom;

    redraw2D();
}

function zoomCenter(factor) {
    const rect =
        viewport.getBoundingClientRect();

    zoomAt(
        rect.left + rect.width / 2,
        rect.top + rect.height / 2,
        state.zoom * factor
    );
}

zoomInButton.addEventListener(
    "click",
    () => zoomCenter(1.2)
);

zoomOutButton.addEventListener(
    "click",
    () => zoomCenter(1 / 1.2)
);


/* =========================================================
   Wheel Zoom
========================================================= */

canvas.addEventListener(
    "wheel",
    event => {
        event.preventDefault();

        const factor =
            Math.exp(-event.deltaY * 0.001);

        zoomAt(
            event.clientX,
            event.clientY,
            state.zoom * factor
        );
    },
    { passive: false }
);


/* =========================================================
   Drawing
========================================================= */

function finishDrawing() {
    state.drawing = false;

    if (
        !state.startWorld ||
        !state.currentWorld
    ) {
        return;
    }

    const start = state.startWorld;
    const end = state.currentWorld;

    if (
        Math.abs(end.x - start.x) < 2 &&
        Math.abs(end.y - start.y) < 2
    ) {
        state.startWorld = null;
        state.currentWorld = null;
        redraw2D();
        return;
    }

    saveHistoryPoint();

    if (state.tool === "room") {

        const x = Math.min(start.x, end.x);
        const y = Math.min(start.y, end.y);

        const w = Math.abs(end.x - start.x);
        const h = Math.abs(end.y - start.y);

        if (w >= state.gridSize &&
            h >= state.gridSize) {

            state.elements.push({
                id: crypto.randomUUID(),
                type: "room",
                x,
                y,
                w,
                h
            });

            state.spatialIndexDirty = true;
        }

    } else if (LINEAR_TYPES.has(state.tool)) {

        state.elements.push({
            id: crypto.randomUUID(),
            type: state.tool,
            x1: start.x,
            y1: start.y,
            x2: end.x,
            y2: end.y
        });

        state.spatialIndexDirty = true;
    }

    commitHistory();

    state.startWorld = null;
    state.currentWorld = null;

    updateStats();
    redraw2D();
}


/* =========================================================
   Objects
========================================================= */

function createObject(type, x, y) {

    const definitions = {

        bed: {
            w: 80,
            h: 60,
            name: "Bed"
        },

        sofa: {
            w: 100,
            h: 50,
            name: "Sofa"
        },

        table: {
            w: 70,
            h: 70,
            name: "Table"
        }
    };

    const def = definitions[type];

    if (!def) return;

    saveHistoryPoint();

    state.elements.push({
        id: crypto.randomUUID(),
        type,
        x: x - def.w / 2,
        y: y - def.h / 2,
        w: def.w,
        h: def.h,
        name: def.name
    });

    state.spatialIndexDirty = true;

    commitHistory();
    updateStats();
}


/* =========================================================
   Move
========================================================= */

function moveSelected(world) {

    const el = state.selected;

    if (!el) return;

    if (RECTANGULAR_TYPES.has(el.type)) {
        el.x = snap(
            world.x - state.dragOffsetX
        );

        el.y = snap(
            world.y - state.dragOffsetY
        );

    } else {

        const dx =
            snap(world.x - state.dragOffsetX) -
            el.x1;

        const dy =
            snap(world.y - state.dragOffsetY) -
            el.y1;

        el.x1 += dx;
        el.y1 += dy;

        el.x2 += dx;
        el.y2 += dy;
    }
}


/* =========================================================
   Delete
========================================================= */

function deleteSelected() {

    if (!state.selected) return;

    saveHistoryPoint();

    state.elements =
        state.elements.filter(
            el => el !== state.selected
        );

    state.selected = null;
    state.spatialIndexDirty = true;

    commitHistory();

    updateStats();
    redraw2D();
}

deleteButton.addEventListener(
    "click",
    deleteSelected
);


/* =========================================================
   Keyboard
========================================================= */

window.addEventListener("keydown", event => {

    if (
        event.key === "Delete" ||
        event.key === "Backspace"
    ) {
        deleteSelected();
    }

    if (
        (event.ctrlKey || event.metaKey) &&
        event.key.toLowerCase() === "z"
    ) {
        event.preventDefault();

        if (event.shiftKey) {
            redo();
        } else {
            undo();
        }
    }

    if (
        (event.ctrlKey || event.metaKey) &&
        event.key.toLowerCase() === "y"
    ) {
        event.preventDefault();
        redo();
    }

    if (event.key === "Escape") {
        state.selected = null;
        state.drawing = false;
        state.dragging = false;
        redraw2D();
    }
});


/* =========================================================
   History
========================================================= */

function arraysEqual(a, b) {
    if (!Array.isArray(a) || !Array.isArray(b)) return false;
    if (a.length !== b.length) return false;

    for (let i = 0; i < a.length; i++) {
        const aItem = a[i];
        const bItem = b[i];

        if (aItem.type !== bItem.type ||
            aItem.id !== bItem.id) {
            return false;
        }

        if (RECTANGULAR_TYPES.has(aItem.type)) {
            if (aItem.x !== bItem.x ||
                aItem.y !== bItem.y ||
                aItem.w !== bItem.w ||
                aItem.h !== bItem.h) {
                return false;
            }
        } else {
            if (aItem.x1 !== bItem.x1 ||
                aItem.y1 !== bItem.y1 ||
                aItem.x2 !== bItem.x2 ||
                aItem.y2 !== bItem.y2) {
                return false;
            }
        }
    }

    return true;
}

function saveHistoryPoint() {

    const currentState = deepClone(state.elements);

    if (state.lastHistoryState && arraysEqual(state.lastHistoryState, currentState)) {
        return;
    }

    state.history =
        state.history.slice(
            0,
            state.historyIndex + 1
        );

    state.history.push(currentState);

    if (state.history.length > 50) {
        state.history.shift();
    }

    state.historyIndex =
        state.history.length - 1;

    state.lastHistoryState = deepClone(currentState);

    updateHistoryButtons();
}

function commitHistory() {

    const currentState = deepClone(state.elements);

    if (state.lastHistoryState && arraysEqual(state.lastHistoryState, currentState)) {
        updateHistoryButtons();
        return;
    }

    state.history =
        state.history.slice(
            0,
            state.historyIndex + 1
        );

    state.history.push(currentState);

    if (state.history.length > 50) {
        state.history.shift();
    }

    state.historyIndex =
        state.history.length - 1;

    state.lastHistoryState = deepClone(currentState);

    updateHistoryButtons();
}

function undo() {

    if (state.historyIndex <= 0) return;

    state.historyIndex--;

    state.elements =
        deepClone(
            state.history[state.historyIndex]
        );

    state.selected = null;
    state.spatialIndexDirty = true;

    updateStats();
    redraw2D();
    updateHistoryButtons();
}

function redo() {

    if (
        state.historyIndex >=
        state.history.length - 1
    ) return;

    state.historyIndex++;

    state.elements =
        deepClone(
            state.history[state.historyIndex]
        );

    state.selected = null;
    state.spatialIndexDirty = true;

    updateStats();
    redraw2D();
    updateHistoryButtons();
}

function updateHistoryButtons() {

    undoButton.disabled =
        state.historyIndex <= 0;

    redoButton.disabled =
        state.historyIndex >=
        state.history.length - 1;
}

undoButton.addEventListener("click", undo);
redoButton.addEventListener("click", redo);


/* =========================================================
   2D Rendering
========================================================= */

function redraw2D() {

    const rect =
        viewport.getBoundingClientRect();

    const width = rect.width;
    const height = rect.height;

    ctx.clearRect(
        0,
        0,
        width,
        height
    );

    ctx.save();

    ctx.translate(
        state.panX,
        state.panY
    );

    ctx.scale(
        state.zoom,
        state.zoom
    );

    drawGrid(
        width,
        height
    );

    state.elements.forEach(drawElement);

    if (
        state.drawing &&
        state.startWorld &&
        state.currentWorld
    ) {
        drawPreview();
    }

    ctx.restore();

    updateStats();
}

function drawGrid(width, height) {

    const grid = state.gridSize;

    const topLeft =
        screenToWorld(
            0,
            0
        );

    const bottomRight =
        screenToWorld(
            width,
            height
        );

    const startX =
        Math.floor(topLeft.x / grid) * grid;

    const endX =
        Math.ceil(bottomRight.x / grid) * grid;

    const startY =
        Math.floor(topLeft.y / grid) * grid;

    const endY =
        Math.ceil(bottomRight.y / grid) * grid;

    ctx.strokeStyle = "#e8edf3";
    ctx.lineWidth = 1 / state.zoom;

    ctx.beginPath();

    for (
        let x = startX;
        x <= endX;
        x += grid
    ) {
        ctx.moveTo(x, startY);
        ctx.lineTo(x, endY);
    }

    for (
        let y = startY;
        y <= endY;
        y += grid
    ) {
        ctx.moveTo(startX, y);
        ctx.lineTo(endX, y);
    }

    ctx.stroke();

    /* Major grid */
    ctx.strokeStyle = "#dce3eb";
    ctx.lineWidth = 1.2 / state.zoom;

    ctx.beginPath();

    const major = grid * 5;

    const majorStartX =
        Math.floor(topLeft.x / major) * major;

    const majorEndX =
        Math.ceil(bottomRight.x / major) * major;

    const majorStartY =
        Math.floor(topLeft.y / major) * major;

    const majorEndY =
        Math.ceil(bottomRight.y / major) * major;

    for (
        let x = majorStartX;
        x <= majorEndX;
        x += major
    ) {
        ctx.moveTo(x, majorStartY);
        ctx.lineTo(x, majorEndY);
    }

    for (
        let y = majorStartY;
        y <= majorEndY;
        y += major
    ) {
        ctx.moveTo(majorStartX, y);
        ctx.lineTo(majorEndX, y);
    }

    ctx.stroke();
}

function drawElement(el) {

    const selected =
        el === state.selected;

    ctx.save();

    if (el.type === "room") {

        ctx.fillStyle =
            selected
                ? "rgba(249,115,22,.12)"
                : "rgba(37,99,235,.045)";

        ctx.strokeStyle =
            selected
                ? "#f97316"
                : "#334155";

        ctx.lineWidth =
            selected ? 3 : 2;

        ctx.fillRect(
            el.x,
            el.y,
            el.w,
            el.h
        );

        ctx.strokeRect(
            el.x,
            el.y,
            el.w,
            el.h
        );

        drawRoomLabel(el);

    } else if (el.type === "wall") {

        drawLineElement(
            el,
            selected ? "#f97316" : "#1e293b",
            selected ? 7 : 5
        );

    } else if (el.type === "door") {

        drawLineElement(
            el,
            selected ? "#f97316" : "#d97706",
            5
        );

        drawDoorArc(el);

    } else if (el.type === "window") {

        drawLineElement(
            el,
            selected ? "#f97316" : "#0ea5e9",
            5
        );

        drawWindowDetail(el);

    } else {

        drawObject(el, selected);
    }

    ctx.restore();
}

function drawLineElement(el, color, width) {

    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.lineCap = "round";

    ctx.beginPath();

    ctx.moveTo(
        el.x1,
        el.y1
    );

    ctx.lineTo(
        el.x2,
        el.y2
    );

    ctx.stroke();
}

function drawRoomLabel(el) {

    const metersW =
        (el.w / 20).toFixed(1);

    const metersH =
        (el.h / 20).toFixed(1);

    ctx.fillStyle = "#64748b";
    ctx.font =
        "11px -apple-system, BlinkMacSystemFont, sans-serif";

    ctx.fillText(
        `${metersW}m × ${metersH}m`,
        el.x + 8,
        el.y + 18
    );
}

function drawObject(el, selected) {

    const colors = {
        bed: "#2563eb",
        sofa: "#d97706",
        table: "#059669"
    };

    ctx.fillStyle =
        selected
            ? "#f97316"
            : colors[el.type];

    ctx.strokeStyle =
        selected
            ? "#ea580c"
            : "rgba(15,23,42,.2)";

    ctx.lineWidth = 1.5;

    ctx.fillRect(
        el.x,
        el.y,
        el.w,
        el.h
    );

    ctx.strokeRect(
        el.x,
        el.y,
        el.w,
        el.h
    );

    ctx.fillStyle = "white";

    ctx.font =
        "10px -apple-system, BlinkMacSystemFont, sans-serif";

    ctx.fillText(
        el.name,
        el.x + 6,
        el.y + 17
    );
}

function drawDoorArc(el) {

    const dx = el.x2 - el.x1;
    const dy = el.y2 - el.y1;

    const len = Math.hypot(dx, dy);

    if (len < 1) return;

    const angle =
        Math.atan2(dy, dx);

    ctx.save();

    ctx.translate(
        el.x1,
        el.y1
    );

    ctx.rotate(angle);

    ctx.strokeStyle = "#d97706";
    ctx.lineWidth = 1.5;

    ctx.beginPath();

    ctx.arc(
        0,
        0,
        len,
        0,
        Math.PI / 2
    );

    ctx.stroke();

    ctx.restore();
}

function drawWindowDetail(el) {

    const dx = el.x2 - el.x1;
    const dy = el.y2 - el.y1;

    const len = Math.hypot(dx, dy);

    if (len < 1) return;

    const nx = -dy / len;
    const ny = dx / len;

    const offset = 3;

    ctx.strokeStyle = "#0ea5e9";
    ctx.lineWidth = 1;

    ctx.beginPath();

    ctx.moveTo(
        el.x1 + nx * offset,
        el.y1 + ny * offset
    );

    ctx.lineTo(
        el.x2 + nx * offset,
        el.y2 + ny * offset
    );

    ctx.moveTo(
        el.x1 - nx * offset,
        el.y1 - ny * offset
    );

    ctx.lineTo(
        el.x2 - nx * offset,
        el.y2 - ny * offset
    );

    ctx.stroke();
}

function drawPreview() {

    const start = state.startWorld;
    const end = state.currentWorld;

    ctx.save();

    ctx.strokeStyle = "#2563eb";
    ctx.fillStyle = "rgba(37,99,235,.07)";
    ctx.lineWidth = 1.5 / state.zoom;
    ctx.setLineDash([
        6 / state.zoom,
        5 / state.zoom
    ]);

    if (state.tool === "room") {

        const x = Math.min(start.x, end.x);
        const y = Math.min(start.y, end.y);

        const w = Math.abs(end.x - start.x);
        const h = Math.abs(end.y - start.y);

        ctx.fillRect(x, y, w, h);
        ctx.strokeRect(x, y, w, h);

    } else {

        ctx.beginPath();

        ctx.moveTo(
            start.x,
            start.y
        );

        ctx.lineTo(
            end.x,
            end.y
        );

        ctx.stroke();
    }

    ctx.restore();
}


/* =========================================================
   Stats
========================================================= */

function updateStats() {
    if (!state.statsCache.dirty) {
        return;
    }

    let totalAreaPx = 0;

    state.elements.forEach(el => {

        if (el.type === "room") {
            totalAreaPx +=
                Math.abs(el.w * el.h);
        }
    });

    const m2 =
        totalAreaPx / 400;

    state.statsCache.value =
        `Area: ${m2.toFixed(1)} m²`;

    state.statsCache.dirty = false;
    statsBadge.textContent = state.statsCache.value;
}


/* =========================================================
   Fit View
========================================================= */

function fitView() {

    if (!state.elements.length) {

        state.zoom = 1;
        state.panX = 0;
        state.panY = 0;

        redraw2D();
        return;
    }

    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;

    state.elements.forEach(el => {

        if (RECTANGULAR_TYPES.has(el.type)) {

            minX = Math.min(
                minX,
                el.x
            );

            minY = Math.min(
                minY,
                el.y
            );

            maxX = Math.max(
                maxX,
                el.x + el.w
            );

            maxY = Math.max(
                maxY,
                el.y + el.h
            );

        } else {

            minX = Math.min(
                minX,
                el.x1,
                el.x2
            );

            minY = Math.min(
                minY,
                el.y1,
                el.y2
            );

            maxX = Math.max(
                maxX,
                el.x1,
                el.x2
            );

            maxY = Math.max(
                maxY,
                el.y1,
                el.y2
            );
        }
    });

    const rect =
        viewport.getBoundingClientRect();

    const padding = 80;

    const width =
        Math.max(1, maxX - minX);

    const height =
        Math.max(1, maxY - minY);

    state.zoom =
        clamp(
            Math.min(
                (rect.width - padding * 2) / width,
                (rect.height - padding * 2) / height
            ),
            state.minZoom,
            state.maxZoom
        );

    state.panX =
        rect.width / 2 -
        ((minX + maxX) / 2) * state.zoom;

    state.panY =
        rect.height / 2 -
        ((minY + maxY) / 2) * state.zoom;

    redraw2D();
}

fitButton.addEventListener(
    "click",
    fitView
);


/* =========================================================
   3D
========================================================= */

function render3D() {

    if (
        typeof THREE === "undefined"
    ) {
        return;
    }

    if (!state.renderer3d) {
        initializeScene3D();
    }

    updateScene3D();

    state.renderer3d.render(
        state.scene3d,
        state.camera3d
    );
}

function initializeScene3D() {
    container3d.innerHTML = "";

    const width =
        container3d.clientWidth;

    const height =
        container3d.clientHeight;

    const scene =
        new THREE.Scene();

    scene.background =
        new THREE.Color(0xf8fafc);

    const camera =
        new THREE.PerspectiveCamera(
            45,
            width / Math.max(height, 1),
            1,
            5000
        );

    camera.position.set(
        500,
        650,
        700
    );

    camera.lookAt(
        400,
        0,
        300
    );

    const renderer =
        new THREE.WebGLRenderer({
            antialias: true,
            powerPreference: "high-performance"
        });

    renderer.setPixelRatio(
        Math.min(
            window.devicePixelRatio || 1,
            2
        )
    );

    renderer.setSize(
        width,
        height
    );

    container3d.appendChild(
        renderer.domElement
    );

    scene.add(
        new THREE.AmbientLight(
            0xffffff,
            1
        )
    );

    const light =
        new THREE.DirectionalLight(
            0xffffff,
            .7
        );

    light.position.set(
        200,
        700,
        300
    );

    scene.add(light);

    const grid =
        new THREE.GridHelper(
            1600,
            80,
            0xcbd5e1,
            0xe2e8f0
        );

    grid.position.set(
        400,
        0,
        300
    );

    scene.add(grid);

    state.renderer3d = renderer;
    state.scene3d = scene;
    state.camera3d = camera;
}

function updateScene3D() {
    const scene = state.scene3d;

    const meshesToRemove = [];
    scene.children.forEach(child => {
        if (child instanceof THREE.Mesh && !(child.geometry instanceof THREE.GridHelper)) {
            meshesToRemove.push(child);
        }
    });
    meshesToRemove.forEach(mesh => scene.remove(mesh));

    state.elements.forEach(el => {

        if (el.type === "room") {

            const mesh =
                new THREE.Mesh(
                    new THREE.BoxGeometry(
                        el.w,
                        2,
                        el.h
                    ),
                    new THREE.MeshLambertMaterial({
                        color: 0xe2e8f0
                    })
                );

            mesh.position.set(
                el.x + el.w / 2,
                1,
                el.y + el.h / 2
            );

            scene.add(mesh);

        } else if (el.type === "wall") {

            const dx =
                el.x2 - el.x1;

            const dz =
                el.y2 - el.y1;

            const len =
                Math.hypot(dx, dz);

            const angle =
                Math.atan2(dz, dx);

            const mesh =
                new THREE.Mesh(
                    new THREE.BoxGeometry(
                        len,
                        60,
                        6
                    ),
                    new THREE.MeshLambertMaterial({
                        color: 0x334155
                    })
                );

            mesh.position.set(
                (el.x1 + el.x2) / 2,
                30,
                (el.y1 + el.y2) / 2
            );

            mesh.rotation.y =
                -angle;

            scene.add(mesh);

        } else if (
            LINEAR_TYPES.has(el.type) && el.type !== "wall"
        ) {

            const dx =
                el.x2 - el.x1;

            const dz =
                el.y2 - el.y1;

            const len =
                Math.hypot(dx, dz);

            const angle =
                Math.atan2(dz, dx);

            const color =
                el.type === "door"
                    ? 0xd97706
                    : 0x0ea5e9;

            const mesh =
                new THREE.Mesh(
                    new THREE.BoxGeometry(
                        len,
                        45,
                        5
                    ),
                    new THREE.MeshLambertMaterial({
                        color
                    })
                );

            mesh.position.set(
                (el.x1 + el.x2) / 2,
                22.5,
                (el.y1 + el.y2) / 2
            );

            mesh.rotation.y =
                -angle;

            scene.add(mesh);

        } else {

            const colors = {
                bed: 0x2563eb,
                sofa: 0xd97706,
                table: 0x059669
            };

            const mesh =
                new THREE.Mesh(
                    new THREE.BoxGeometry(
                        el.w,
                        30,
                        el.h
                    ),
                    new THREE.MeshLambertMaterial({
                        color:
                            colors[el.type]
                    })
                );

            mesh.position.set(
                el.x + el.w / 2,
                15,
                el.y + el.h / 2
            );

            scene.add(mesh);
        }
    });
}


/* =========================================================
   Export / Import
========================================================= */

function saveProject() {

    const project = {
        version: 2,
        application: "Floorplanner Pro",
        createdAt:
            new Date().toISOString(),

        settings: {
            gridSize: state.gridSize,
            snap: state.snap
        },

        elements:
            deepClone(state.elements)
    };

    const blob =
        new Blob(
            [
                JSON.stringify(
                    project,
                    null,
                    2
                )
            ],
            {
                type:
                    "application/json;charset=utf-8"
            }
        );

    const url =
        URL.createObjectURL(blob);

    const anchor =
        document.createElement("a");

    anchor.href = url;

    anchor.download =
        "floorplanner-pro-project.json";

    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();

    setTimeout(
        () => URL.revokeObjectURL(url),
        1000
    );
}

exportButton.addEventListener(
    "click",
    saveProject
);

importInput.addEventListener(
    "change",
    async event => {

        const file =
            event.target.files?.[0];

        if (!file) return;

        try {

            const text =
                await file.text();

            const data =
                JSON.parse(text);

            const imported =
                Array.isArray(data)
                    ? data
                    : data.elements;

            if (!Array.isArray(imported)) {
                throw new Error(
                    "Invalid project format"
                );
            }

            const valid =
                imported.every(
                    validateElement
                );

            if (!valid) {
                throw new Error(
                    "Invalid element data"
                );
            }

            saveHistoryPoint();

            state.elements =
                deepClone(imported);

            state.selected = null;
            state.spatialIndexDirty = true;

            commitHistory();

            updateStats();
            redraw2D();

        } catch (error) {

            console.error(error);

            alert(
                "JSONファイルを読み込めませんでした。"
            );
        }

        event.target.value = "";
    }
);

function validateElement(el) {

    if (
        !el ||
        typeof el.type !== "string"
    ) {
        return false;
    }

    if (RECTANGULAR_TYPES.has(el.type)) {

        return [
            el.x,
            el.y,
            el.w,
            el.h
        ].every(
            Number.isFinite
        );

    }

    if (LINEAR_TYPES.has(el.type)) {

        return [
            el.x1,
            el.y1,
            el.x2,
            el.y2
        ].every(
            Number.isFinite
        );
    }

    return false;
}


/* =========================================================
   Reset
========================================================= */

clearButton.addEventListener(
    "click",
    () => {

        if (
            !confirm(
                "すべての内容をリセットしますか？"
            )
        ) {
            return;
        }

        saveHistoryPoint();

        state.elements = [];
        state.selected = null;
        state.spatialIndexDirty = true;

        state.zoom = 1;
        state.panX = 0;
        state.panY = 0;

        commitHistory();

        updateStats();
        redraw2D();
    }
);


/* =========================================================
   Initial State
========================================================= */

function initialize() {

    resizeCanvas();

    state.history = [
        []
    ];

    state.historyIndex = 0;

    updateHistoryButtons();
    updateStats();

    document.addEventListener(
        "gesturestart",
        event => event.preventDefault(),
        { passive: false }
    );

    document.addEventListener(
        "gesturechange",
        event => event.preventDefault(),
        { passive: false }
    );

    document.addEventListener(
        "gestureend",
        event => event.preventDefault(),
        { passive: false }
    );
}

initialize();
