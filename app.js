"use strict";

/* =========================================================
   FLOORPLANNER PRO
   2D / 3D Residential Environment Planning System
========================================================= */


/* =========================================================
   DOM
========================================================= */

const canvas = document.getElementById("c2d");
const ctx = canvas.getContext("2d");
const viewport = document.getElementById("viewport");
const container3d = document.getElementById("canvas3d");

const propertiesPanel = document.getElementById("propertiesPanel");
const propertyContent = document.getElementById("propertyContent");
const propertyTitle = document.getElementById("propertyTitle");

const emptyState = document.getElementById("emptyState");

const statsArea = document.getElementById("statsArea");
const statsObjects = document.getElementById("statsObjects");

const zoomLabel = document.getElementById("zoomLabel");
const cursorPosition = document.getElementById("cursorPosition");
const currentToolLabel = document.getElementById("currentToolLabel");
const toolHint = document.getElementById("toolHint");
const saveStatus = document.getElementById("saveStatus");

const projectNameInput = document.getElementById("projectName");

const undoBtn = document.getElementById("undoBtn");
const redoBtn = document.getElementById("redoBtn");


/* =========================================================
   CONSTANTS
========================================================= */

const APP_VERSION = "2.0";

const GRID_SIZE = 20;

/*
    20px = 1m

    1px = 0.05m
*/
const METERS_PER_PIXEL = 0.05;

const STORAGE_KEY = "floorplanner-pro-project-v2";

const OBJECT_DEFAULTS = {

    bed: {
        w: 180 / 5,
        h: 210 / 5,
        name: "介護ベッド"
    },

    sofa: {
        w: 200 / 5,
        h: 90 / 5,
        name: "ソファ"
    },

    table: {
        w: 120 / 5,
        h: 80 / 5,
        name: "テーブル"
    },

    wheelchair: {
        w: 70 / 5,
        h: 110 / 5,
        name: "車椅子"
    }
};


/* =========================================================
   STATE
========================================================= */

let project = {
    version: APP_VERSION,
    name: "新規住宅環境図",
    scale: METERS_PER_PIXEL,
    gridSize: GRID_SIZE,
    elements: []
};

let currentTool = "select";
let currentView = "2d";

let selectedElement = null;

let isDrawing = false;
let isDragging = false;
let isPanning = false;

let startPoint = null;
let lastPointer = null;

let dragOffset = {
    x: 0,
    y: 0
};

let panStart = {
    x: 0,
    y: 0
};

let camera = {
    x: 0,
    y: 0,
    zoom: 1
};

let showGrid = true;
let snapToGrid = true;

let spacePressed = false;

let history = [];
let historyIndex = -1;

let autosaveTimer = null;

let three = {
    scene: null,
    camera: null,
    renderer: null,
    initialized: false
};


/* =========================================================
   INITIALIZATION
========================================================= */

document.addEventListener("DOMContentLoaded", () => {

    resizeCanvas();

    loadLocalProject();

    setupPointerEvents();

    setupKeyboard();

    updateUI();

    redraw2D();

    updateHistoryButtons();

});


window.addEventListener("resize", () => {

    resizeCanvas();

    resize3D();

});


/* =========================================================
   PROJECT
========================================================= */

function createId() {

    return (
        Date.now().toString(36) +
        "-" +
        Math.random().toString(36).substring(2, 9)
    );
}


function cloneProject() {

    return JSON.parse(JSON.stringify(project));
}


function pushHistory() {

    const snapshot = cloneProject();

    history = history.slice(0, historyIndex + 1);

    history.push(snapshot);

    if (history.length > 80) {
        history.shift();
    }

    historyIndex = history.length - 1;

    updateHistoryButtons();

    scheduleAutosave();
}


function restoreSnapshot(snapshot) {

    project = JSON.parse(JSON.stringify(snapshot));

    selectedElement = null;

    project.name = project.name || "新規住宅環境図";

    project.elements = Array.isArray(project.elements)
        ? project.elements
        : [];

    projectNameInput.value = project.name;

    updateUI();

    redraw2D();

    if (currentView === "3d") {
        init3D();
    }
}


function undo() {

    if (historyIndex <= 0) {
        return;
    }

    historyIndex--;

    restoreSnapshot(history[historyIndex]);

    updateHistoryButtons();
}


function redo() {

    if (historyIndex >= history.length - 1) {
        return;
    }

    historyIndex++;

    restoreSnapshot(history[historyIndex]);

    updateHistoryButtons();
}


function updateHistoryButtons() {

    undoBtn.disabled = historyIndex <= 0;

    redoBtn.disabled =
        historyIndex < 0 ||
        historyIndex >= history.length - 1;
}


/* =========================================================
   LOCAL STORAGE
========================================================= */

function scheduleAutosave() {

    clearTimeout(autosaveTimer);

    saveStatus.textContent = "保存中...";

    autosaveTimer = setTimeout(() => {

        try {

            localStorage.setItem(
                STORAGE_KEY,
                JSON.stringify(project)
            );

            saveStatus.textContent = "自動保存済み";

        } catch (error) {

            console.error(error);

            saveStatus.textContent = "保存失敗";
        }

    }, 500);
}


function loadLocalProject() {

    const saved = localStorage.getItem(STORAGE_KEY);

    if (!saved) {

        history = [cloneProject()];
        historyIndex = 0;

        return;
    }

    try {

        const parsed = JSON.parse(saved);

        if (
            parsed &&
            Array.isArray(parsed.elements)
        ) {

            project = parsed;

            project.name =
                project.name ||
                "新規住宅環境図";

            projectNameInput.value =
                project.name;

        }

    } catch (error) {

        console.error("Local project load error:", error);

    }

    history = [cloneProject()];
    historyIndex = 0;
}


/* =========================================================
   EXPORT / IMPORT
========================================================= */

function saveProject() {

    const data = {
        ...project,
        exportedAt: new Date().toISOString()
    };

    const blob = new Blob(
        [
            JSON.stringify(data, null, 2)
        ],
        {
            type: "application/json"
        }
    );

    const url = URL.createObjectURL(blob);

    const link = document.createElement("a");

    link.href = url;

    link.download =
        `${sanitizeFileName(project.name)}.json`;

    document.body.appendChild(link);

    link.click();

    link.remove();

    setTimeout(() => {
        URL.revokeObjectURL(url);
    }, 1000);

    saveStatus.textContent = "書き出し済み";
}


function sanitizeFileName(name) {

    return String(name)
        .replace(/[\\/:*?"<>|]/g, "_")
        .trim() || "floorplanner-project";
}


document
    .getElementById("fileInput")
    .addEventListener("change", function () {

        const file = this.files[0];

        if (!file) {
            return;
        }

        const reader = new FileReader();

        reader.onload = event => {

            try {

                const imported =
                    JSON.parse(event.target.result);

                if (
                    !imported ||
                    !Array.isArray(imported.elements)
                ) {

                    throw new Error(
                        "Invalid project"
                    );
                }

                project = {
                    version: APP_VERSION,
                    name:
                        imported.name ||
                        "読み込んだ図面",
                    scale:
                        imported.scale ||
                        METERS_PER_PIXEL,
                    gridSize:
                        imported.gridSize ||
                        GRID_SIZE,
                    elements:
                        imported.elements
                };

                selectedElement = null;

                projectNameInput.value =
                    project.name;

                history = [cloneProject()];
                historyIndex = 0;

                scheduleAutosave();

                updateUI();

                redraw2D();

                if (currentView === "3d") {
                    init3D();
                }

            } catch (error) {

                alert(
                    "JSONファイルを読み込めませんでした。"
                );

                console.error(error);

            } finally {

                this.value = "";
            }
        };

        reader.readAsText(file);
    });


function clearAll() {

    if (
        project.elements.length > 0 &&
        !confirm("現在の図面をすべて削除しますか？")
    ) {
        return;
    }

    project.elements = [];

    selectedElement = null;

    pushHistory();

    updateUI();

    redraw2D();
}


/* =========================================================
   PROJECT NAME
========================================================= */

function updateProjectName(value) {

    project.name =
        String(value).trim() ||
        "新規住宅環境図";

    projectNameInput.value =
        project.name;

    pushHistory();
}


/* =========================================================
   TOOL
========================================================= */

const TOOL_NAMES = {

    select: "選択",

    room: "部屋作成",

    wall: "壁",

    door: "ドア",

    window: "窓",

    bed: "介護ベッド",

    sofa: "ソファ",

    table: "テーブル",

    wheelchair: "車椅子",

    marker: "注意マーカー"
};


const TOOL_HINTS = {

    select:
        "クリックして選択・ドラッグで移動",

    room:
        "ドラッグして部屋を作成",

    wall:
        "ドラッグして壁を描画",

    door:
        "ドラッグしてドアを配置",

    window:
        "ドラッグして窓を配置",

    bed:
        "クリックして介護ベッドを配置",

    sofa:
        "クリックしてソファを配置",

    table:
        "クリックしてテーブルを配置",

    wheelchair:
        "クリックして車椅子を配置",

    marker:
        "クリックして注意マーカーを配置"
};


function setTool(tool) {

    currentTool = tool;

    selectedElement = null;

    document
        .querySelectorAll(".menu-item[data-tool]")
        .forEach(item => {

            item.classList.toggle(
                "active",
                item.dataset.tool === tool
            );

        });

    currentToolLabel.textContent =
        TOOL_NAMES[tool] || tool;

    toolHint.textContent =
        TOOL_HINTS[tool] || "";

    propertiesPanel.classList.add("hidden");

    canvas.style.cursor =
        tool === "select"
            ? "default"
            : "crosshair";

    redraw2D();
}


/* =========================================================
   VIEW
========================================================= */

function switchView(view) {

    currentView = view;

    document
        .getElementById("btn2d")
        .classList.toggle(
            "active",
            view === "2d"
        );

    document
        .getElementById("btn3d")
        .classList.toggle(
            "active",
            view === "3d"
        );

    if (view === "3d") {

        canvas.style.display = "none";

        container3d.style.display = "block";

        init3D();

    } else {

        canvas.style.display = "block";

        container3d.style.display = "none";

        redraw2D();
    }
}


/* =========================================================
   CANVAS / COORDINATES
========================================================= */

function resizeCanvas() {

    const rect =
        viewport.getBoundingClientRect();

    const dpr =
        Math.max(1, window.devicePixelRatio || 1);

    canvas.width =
        Math.floor(rect.width * dpr);

    canvas.height =
        Math.floor(rect.height * dpr);

    canvas.style.width =
        rect.width + "px";

    canvas.style.height =
        rect.height + "px";

    ctx.setTransform(
        dpr,
        0,
        0,
        dpr,
        0,
        0
    );

    redraw2D();
}


function getViewportSize() {

    return {
        width: viewport.clientWidth,
        height: viewport.clientHeight
    };
}


function screenToWorld(clientX, clientY) {

    const rect =
        canvas.getBoundingClientRect();

    const sx =
        clientX - rect.left;

    const sy =
        clientY - rect.top;

    return {

        x:
            (sx - camera.x) /
            camera.zoom,

        y:
            (sy - camera.y) /
            camera.zoom
    };
}


function worldToScreen(x, y) {

    return {

        x:
            x * camera.zoom +
            camera.x,

        y:
            y * camera.zoom +
            camera.y
    };
}


function snapValue(value) {

    return Math.round(
        value / GRID_SIZE
    ) * GRID_SIZE;
}


function getWorldPoint(event, allowSnap = true) {

    const point =
        screenToWorld(
            event.clientX,
            event.clientY
        );

    const shouldSnap =
        allowSnap &&
        snapToGrid &&
        !event.ctrlKey;

    if (!shouldSnap) {
        return point;
    }

    return {

        x: snapValue(point.x),

        y: snapValue(point.y)
    };
}


/* =========================================================
   POINTER EVENTS
========================================================= */

function setupPointerEvents() {

    canvas.addEventListener(
        "pointerdown",
        onPointerDown
    );

    canvas.addEventListener(
        "pointermove",
        onPointerMove
    );

    canvas.addEventListener(
        "pointerup",
        onPointerUp
    );

    canvas.addEventListener(
        "pointercancel",
        onPointerUp
    );

    canvas.addEventListener(
        "wheel",
        onWheel,
        { passive: false }
    );

    canvas.addEventListener(
        "dblclick",
        onDoubleClick
    );
}


function onPointerDown(event) {

    if (currentView !== "2d") {
        return;
    }

    canvas.setPointerCapture(event.pointerId);

    lastPointer = {
        x: event.clientX,
        y: event.clientY
    };

    if (
        spacePressed ||
        event.button === 1
    ) {

        isPanning = true;

        panStart = {
            x: event.clientX,
            y: event.clientY
        };

        canvas.style.cursor = "grabbing";

        return;
    }

    const point =
        getWorldPoint(event);

    updateCursorPosition(point);


    /* SELECT */

    if (currentTool === "select") {

        const hit =
            findElementAt(
                point.x,
                point.y
            );

        if (hit) {

            selectedElement = hit;

            isDragging = true;

            dragOffset = getDragOffset(
                hit,
                point
            );

            showProperties(hit);

            redraw2D();

        } else {

            selectedElement = null;

            propertiesPanel
                .classList
                .add("hidden");

            redraw2D();
        }

        return;
    }


    /* FURNITURE */

    if (
        [
            "bed",
            "sofa",
            "table",
            "wheelchair",
            "marker"
        ].includes(currentTool)
    ) {

        createPointObject(
            currentTool,
            point
        );

        return;
    }


    /* DRAWING */

    if (
        [
            "room",
            "wall",
            "door",
            "window"
        ].includes(currentTool)
    ) {

        isDrawing = true;

        startPoint = point;

        redraw2D();
    }
}


function onPointerMove(event) {

    const point =
        getWorldPoint(event);

    updateCursorPosition(point);


    if (isPanning) {

        const dx =
            event.clientX -
            lastPointer.x;

        const dy =
            event.clientY -
            lastPointer.y;

        camera.x += dx;
        camera.y += dy;

        lastPointer = {
            x: event.clientX,
            y: event.clientY
        };

        redraw2D();

        return;
    }


    if (isDragging && selectedElement) {

        moveElement(
            selectedElement,
            point
        );

        redraw2D();

        return;
    }


    if (isDrawing) {

        redraw2D();

        drawPreview(
            startPoint,
            point
        );

        return;
    }

    lastPointer = {
        x: event.clientX,
        y: event.clientY
    };
}


function onPointerUp(event) {

    if (isPanning) {

        isPanning = false;

        canvas.style.cursor =
            currentTool === "select"
                ? "default"
                : "crosshair";

        return;
    }


    if (isDragging) {

        isDragging = false;

        pushHistory();

        showProperties(selectedElement);

        return;
    }


    if (!isDrawing) {
        return;
    }

    isDrawing = false;

    const endPoint =
        getWorldPoint(event);

    finishDrawing(
        startPoint,
        endPoint
    );

    startPoint = null;

    updateUI();

    redraw2D();
}


function onDoubleClick(event) {

    const point =
        getWorldPoint(event, false);

    const hit =
        findElementAt(
            point.x,
            point.y
        );

    if (hit) {

        selectedElement = hit;

        showProperties(hit);

        redraw2D();
    }
}


/* =========================================================
   ZOOM / PAN
========================================================= */

function onWheel(event) {

    event.preventDefault();

    const mouse =
        screenToWorld(
            event.clientX,
            event.clientY
        );

    const direction =
        event.deltaY < 0
            ? 1.1
            : 0.9;

    const nextZoom =
        clamp(
            camera.zoom * direction,
            0.2,
            4
        );

    const before =
        worldToScreen(
            mouse.x,
            mouse.y
        );

    camera.zoom = nextZoom;

    const after =
        worldToScreen(
            mouse.x,
            mouse.y
        );

    camera.x +=
        before.x -
        after.x;

    camera.y +=
        before.y -
        after.y;

    updateZoomUI();

    redraw2D();
}


function zoomIn() {

    zoomAroundCenter(1.2);
}


function zoomOut() {

    zoomAroundCenter(.833333);
}


function zoomAroundCenter(factor) {

    const size =
        getViewportSize();

    const center = {
        x: size.width / 2,
        y: size.height / 2
    };

    const world =
        screenToWorld(
            center.x,
            center.y
        );

    camera.zoom =
        clamp(
            camera.zoom * factor,
            .2,
            4
        );

    const screen =
        worldToScreen(
            world.x,
            world.y
        );

    camera.x +=
        center.x -
        screen.x;

    camera.y +=
        center.y -
        screen.y;

    updateZoomUI();

    redraw2D();
}


function resetView() {

    camera.zoom = 1;

    const size =
        getViewportSize();

    camera.x =
        size.width / 2 -
        500;

    camera.y =
        size.height / 2 -
        300;

    updateZoomUI();

    redraw2D();
}


function updateZoomUI() {

    zoomLabel.textContent =
        `${Math.round(camera.zoom * 100)}%`;
}


/* =========================================================
   DRAWING
========================================================= */

function finishDrawing(start, end) {

    if (
        Math.abs(start.x - end.x) < 2 &&
        Math.abs(start.y - end.y) < 2
    ) {
        return;
    }


    if (currentTool === "room") {

        const element = {

            id: createId(),

            type: "room",

            x: Math.min(start.x, end.x),

            y: Math.min(start.y, end.y),

            w: Math.abs(end.x - start.x),

            h: Math.abs(end.y - start.y),

            name: "部屋",

            rotation: 0
        };

        project.elements.push(element);

        selectedElement = element;

        pushHistory();

        showProperties(element);

        return;
    }


    if (
        [
            "wall",
            "door",
            "window"
        ].includes(currentTool)
    ) {

        const element = {

            id: createId(),

            type: currentTool,

            x1: start.x,
            y1: start.y,

            x2: end.x,
            y2: end.y,

            thickness:
                currentTool === "wall"
                    ? 10
                    : 5
        };

        project.elements.push(element);

        selectedElement = element;

        pushHistory();

        showProperties(element);
    }
}


function createPointObject(type, point) {

    if (type === "marker") {

        const element = {

            id: createId(),

            type: "marker",

            x: point.x,

            y: point.y,

            radius: 10,

            name: "注意",

            note: "注意事項を入力",

            rotation: 0
        };

        project.elements.push(element);

        selectedElement = element;

        pushHistory();

        showProperties(element);

        updateUI();

        redraw2D();

        return;
    }


    const defaults =
        OBJECT_DEFAULTS[type];

    const element = {

        id: createId(),

        type,

        x:
            point.x -
            defaults.w / 2,

        y:
            point.y -
            defaults.h / 2,

        w: defaults.w,

        h: defaults.h,

        name: defaults.name,

        rotation: 0
    };

    project.elements.push(element);

    selectedElement = element;

    pushHistory();

    showProperties(element);

    updateUI();

    redraw2D();
}


/* =========================================================
   PREVIEW
========================================================= */

function drawPreview(start, end) {

    ctx.save();

    ctx.setTransform(
        window.devicePixelRatio || 1,
        0,
        0,
        window.devicePixelRatio || 1,
        0,
        0
    );

    const s =
        worldToScreen(
            start.x,
            start.y
        );

    const e =
        worldToScreen(
            end.x,
            end.y
        );

    ctx.strokeStyle = "#2563eb";

    ctx.fillStyle =
        "rgba(37,99,235,.08)";

    ctx.lineWidth = 2;

    ctx.setLineDash([6, 4]);


    if (currentTool === "room") {

        ctx.fillRect(
            s.x,
            s.y,
            e.x - s.x,
            e.y - s.y
        );

        ctx.strokeRect(
            s.x,
            s.y,
            e.x - s.x,
            e.y - s.y
        );

    } else {

        ctx.beginPath();

        ctx.moveTo(
            s.x,
            s.y
        );

        ctx.lineTo(
            e.x,
            e.y
        );

        ctx.stroke();
    }

    ctx.restore();
}


/* =========================================================
   MOVE
========================================================= */

function getDragOffset(element, point) {

    if (
        [
            "wall",
            "door",
            "window"
        ].includes(element.type)
    ) {

        return {

            x:
                point.x -
                element.x1,

            y:
                point.y -
                element.y1
        };
    }

    return {

        x:
            point.x -
            element.x,

        y:
            point.y -
            element.y
    };
}


function moveElement(element, point) {

    if (
        [
            "wall",
            "door",
            "window"
        ].includes(element.type)
    ) {

        const dx =
            point.x -
            dragOffset.x -
            element.x1;

        const dy =
            point.y -
            dragOffset.y -
            element.y1;

        element.x1 += dx;
        element.y1 += dy;

        element.x2 += dx;
        element.y2 += dy;

        return;
    }


    if (element.type === "marker") {

        element.x =
            point.x -
            dragOffset.x;

        element.y =
            point.y -
            dragOffset.y;

        return;
    }


    element.x =
        point.x -
        dragOffset.x;

    element.y =
        point.y -
        dragOffset.y;
}


/* =========================================================
   HIT TEST
========================================================= */

function findElementAt(x, y) {

    const elements =
        project.elements;

    for (
        let i = elements.length - 1;
        i >= 0;
        i--
    ) {

        const element =
            elements[i];

        if (
            hitTest(
                element,
                x,
                y
            )
        ) {
            return element;
        }
    }

    return null;
}


function hitTest(element, x, y) {

    if (
        [
            "wall",
            "door",
            "window"
        ].includes(element.type)
    ) {

        return (
            distanceToSegment(
                x,
                y,
                element.x1,
                element.y1,
                element.x2,
                element.y2
            ) <=
            Math.max(
                10,
                element.thickness || 5
            )
        );
    }


    if (element.type === "marker") {

        return (
            Math.hypot(
                x - element.x,
                y - element.y
            ) <=
            element.radius + 8
        );
    }


    const cx =
        element.x +
        element.w / 2;

    const cy =
        element.y +
        element.h / 2;

    const dx =
        x - cx;

    const dy =
        y - cy;

    const angle =
        -(element.rotation || 0) *
        Math.PI /
        180;

    const localX =
        dx * Math.cos(angle) -
        dy * Math.sin(angle);

    const localY =
        dx * Math.sin(angle) +
        dy * Math.cos(angle);

    return (
        Math.abs(localX) <=
            element.w / 2 &&
        Math.abs(localY) <=
            element.h / 2
    );
}


function distanceToSegment(
    px,
    py,
    x1,
    y1,
    x2,
    y2
) {

    const dx = x2 - x1;
    const dy = y2 - y1;

    if (dx === 0 && dy === 0) {

        return Math.hypot(
            px - x1,
            py - y1
        );
    }

    const t =
        clamp(
            (
                (px - x1) * dx +
                (py - y1) * dy
            ) /
            (dx * dx + dy * dy),
            0,
            1
        );

    const x =
        x1 + t * dx;

    const y =
        y1 + t * dy;

    return Math.hypot(
        px - x,
        py - y
    );
}


/* =========================================================
   DRAW 2D
========================================================= */

function redraw2D() {

    const dpr =
        window.devicePixelRatio || 1;

    const width =
        canvas.clientWidth;

    const height =
        canvas.clientHeight;

    ctx.setTransform(
        dpr,
        0,
        0,
        dpr,
        0,
        0
    );

    ctx.clearRect(
        0,
        0,
        width,
        height
    );


    /* Background */

    ctx.fillStyle = "#f8fafc";

    ctx.fillRect(
        0,
        0,
        width,
        height
    );


    /* Grid */

    if (showGrid) {
        drawGrid(
            width,
            height
        );
    }


    /* Objects */

    project.elements.forEach(
        element => {

            drawElement(
                element,
                element === selectedElement
            );

        }
    );


    updateEmptyState();

    updateUI();
}


function drawGrid(width, height) {

    const step =
        GRID_SIZE *
        camera.zoom;

    if (step < 5) {
        return;
    }

    const offsetX =
        positiveModulo(
            camera.x,
            step
        );

    const offsetY =
        positiveModulo(
            camera.y,
            step
        );

    ctx.beginPath();

    ctx.strokeStyle = "#e8edf3";

    ctx.lineWidth = 1;

    for (
        let x = offsetX;
        x <= width;
        x += step
    ) {

        ctx.moveTo(
            Math.round(x) + .5,
            0
        );

        ctx.lineTo(
            Math.round(x) + .5,
            height
        );
    }

    for (
        let y = offsetY;
        y <= height;
        y += step
    ) {

        ctx.moveTo(
            0,
            Math.round(y) + .5
        );

        ctx.lineTo(
            width,
            Math.round(y) + .5
        );
    }

    ctx.stroke();


    /* Major grid */

    const majorStep =
        step * 5;

    if (majorStep > 25) {

        const majorX =
            positiveModulo(
                camera.x,
                majorStep
            );

        const majorY =
            positiveModulo(
                camera.y,
                majorStep
            );

        ctx.beginPath();

        ctx.strokeStyle = "#dce3eb";

        for (
            let x = majorX;
            x <= width;
            x += majorStep
        ) {

            ctx.moveTo(
                Math.round(x) + .5,
                0
            );

            ctx.lineTo(
                Math.round(x) + .5,
                height
            );
        }

        for (
            let y = majorY;
            y <= height;
            y += majorStep
        ) {

            ctx.moveTo(
                0,
                Math.round(y) + .5
            );

            ctx.lineTo(
                width,
                Math.round(y) + .5
            );
        }

        ctx.stroke();
    }
}


function drawElement(element, selected) {

    ctx.save();

    const color =
        selected
            ? "#f97316"
            : "#334155";


    if (
        [
            "wall",
            "door",
            "window"
        ].includes(element.type)
    ) {

        drawLineElement(
            element,
            selected
        );

        ctx.restore();

        return;
    }


    if (element.type === "marker") {

        drawMarker(
            element,
            selected
        );

        ctx.restore();

        return;
    }


    const center =
        worldToScreen(
            element.x +
                element.w / 2,
            element.y +
                element.h / 2
        );

    ctx.translate(
        center.x,
        center.y
    );

    ctx.rotate(
        (element.rotation || 0) *
        Math.PI /
        180
    );

    const w =
        element.w *
        camera.zoom;

    const h =
        element.h *
        camera.zoom;


    if (element.type === "room") {

        ctx.fillStyle =
            selected
                ? "rgba(249,115,22,.11)"
                : "rgba(37,99,235,.035)";

        ctx.strokeStyle =
            selected
                ? "#f97316"
                : "#334155";

        ctx.lineWidth =
            selected ? 2.5 : 1.8;

        ctx.fillRect(
            -w / 2,
            -h / 2,
            w,
            h
        );

        ctx.strokeRect(
            -w / 2,
            -h / 2,
            w,
            h
        );

        drawRoomLabel(
            element,
            w,
            h
        );

    } else {

        drawFurniture(
            element,
            w,
            h,
            selected
        );
    }

    ctx.restore();
}


function drawRoomLabel(
    element,
    w,
    h
) {

    if (
        w < 60 ||
        h < 35
    ) {
        return;
    }

    ctx.fillStyle = "#64748b";

    ctx.font =
        `${Math.max(
            9,
            10 * camera.zoom
        )}px sans-serif`;

    ctx.textAlign = "center";

    ctx.textBaseline = "middle";

    ctx.fillText(
        element.name ||
            "部屋",
        0,
        -5
    );

    ctx.font =
        `${Math.max(
            8,
            8 * camera.zoom
        )}px sans-serif`;

    ctx.fillStyle = "#94a3b8";

    const widthM =
        element.w *
        METERS_PER_PIXEL;

    const heightM =
        element.h *
        METERS_PER_PIXEL;

    ctx.fillText(
        `${widthM.toFixed(2)}m × ${heightM.toFixed(2)}m`,
        0,
        9
    );
}


function drawFurniture(
    element,
    w,
    h,
    selected
) {

    let fill = "#64748b";

    if (element.type === "bed") {
        fill = "#2563eb";
    }

    if (element.type === "sofa") {
        fill = "#d97706";
    }

    if (element.type === "table") {
        fill = "#059669";
    }

    if (element.type === "wheelchair") {
        fill = "#7c3aed";
    }

    ctx.fillStyle =
        selected
            ? "#f97316"
            : fill;

    ctx.strokeStyle =
        selected
            ? "#ea580c"
            : "rgba(15,23,42,.25)";

    ctx.lineWidth =
        selected ? 2.5 : 1;

    ctx.fillRect(
        -w / 2,
        -h / 2,
        w,
        h
    );

    ctx.strokeRect(
        -w / 2,
        -h / 2,
        w,
        h
    );


    if (element.type === "bed") {

        ctx.fillStyle =
            "rgba(255,255,255,.8)";

        ctx.fillRect(
            -w / 2 + 4,
            -h / 2 + 4,
            w - 8,
            h * .22
        );

    }


    if (element.type === "wheelchair") {

        ctx.strokeStyle =
            "rgba(255,255,255,.8)";

        ctx.lineWidth = 2;

        ctx.beginPath();

        ctx.arc(
            -w * .25,
            h * .25,
            Math.max(
                5,
                h * .22
            ),
            0,
            Math.PI * 2
        );

        ctx.stroke();

        ctx.beginPath();

        ctx.arc(
            w * .25,
            h * .25,
            Math.max(
                5,
                h * .22
            ),
            0,
            Math.PI * 2
        );

        ctx.stroke();
    }


    if (
        w > 45 &&
        h > 25
    ) {

        ctx.fillStyle = "#fff";

        ctx.font =
            `${Math.max(
                8,
                9 * camera.zoom
            )}px sans-serif`;

        ctx.textAlign = "center";

        ctx.textBaseline = "middle";

        ctx.fillText(
            element.name || "",
            0,
            0
        );
    }
}


function drawLineElement(
    element,
    selected
) {

    const p1 =
        worldToScreen(
            element.x1,
            element.y1
        );

    const p2 =
        worldToScreen(
            element.x2,
            element.y2
        );

    ctx.beginPath();

    ctx.moveTo(
        p1.x,
        p1.y
    );

    ctx.lineTo(
        p2.x,
        p2.y
    );

    if (selected) {

        ctx.strokeStyle = "#f97316";

    } else if (element.type === "wall") {

        ctx.strokeStyle = "#1e293b";

    } else if (element.type === "door") {

        ctx.strokeStyle = "#d97706";

    } else {

        ctx.strokeStyle = "#0ea5e9";
    }

    ctx.lineWidth =
        (
            element.thickness ||
            5
        ) *
        camera.zoom;

    ctx.lineCap = "round";

    ctx.stroke();


    if (
        selected &&
        camera.zoom > .5
    ) {

        drawEndpoint(
            p1.x,
            p1.y
        );

        drawEndpoint(
            p2.x,
            p2.y
        );
    }
}


function drawEndpoint(x, y) {

    ctx.fillStyle = "#fff";

    ctx.strokeStyle = "#f97316";

    ctx.lineWidth = 2;

    ctx.beginPath();

    ctx.arc(
        x,
        y,
        4,
        0,
        Math.PI * 2
    );

    ctx.fill();

    ctx.stroke();
}


function drawMarker(
    element,
    selected
) {

    const p =
        worldToScreen(
            element.x,
            element.y
        );

    const r =
        element.radius *
        camera.zoom;

    ctx.beginPath();

    ctx.arc(
        p.x,
        p.y,
        r,
        0,
        Math.PI * 2
    );

    ctx.fillStyle =
        selected
            ? "#f97316"
            : "#e11d48";

    ctx.fill();

    ctx.strokeStyle = "#fff";

    ctx.lineWidth = 2;

    ctx.stroke();


    ctx.fillStyle = "#fff";

    ctx.font = "bold 12px sans-serif";

    ctx.textAlign = "center";

    ctx.textBaseline = "middle";

    ctx.fillText(
        "!",
        p.x,
        p.y
    );
}


/* =========================================================
   PROPERTIES
========================================================= */

function showProperties(element) {

    if (!element) {

        propertiesPanel.classList.add("hidden");

        return;
    }

    propertiesPanel.classList.remove("hidden");

    propertyTitle.textContent =
        TOOL_NAMES[element.type] ||
        "オブジェクト";

    let html = "";


    if (
        [
            "room",
            "bed",
            "sofa",
            "table",
            "wheelchair"
        ].includes(element.type)
    ) {

        html += `
            <div class="property-group">
                <label>名称</label>
                <input
                    class="property-input"
                    value="${escapeHtmlAttribute(element.name || "")}"
                    onchange="updateElementProperty('name', this.value)"
                >
            </div>

            <div class="property-group">
                <label>サイズ</label>

                <div class="property-grid">

                    <div>
                        <label>幅 cm</label>
                        <input
                            class="property-input"
                            type="number"
                            min="1"
                            step="1"
                            value="${pixelsToCm(element.w)}"
                            onchange="updateDimension('w', this.value)"
                        >
                    </div>

                    <div>
                        <label>奥行 cm</label>
                        <input
                            class="property-input"
                            type="number"
                            min="1"
                            step="1"
                            value="${pixelsToCm(element.h)}"
                            onchange="updateDimension('h', this.value)"
                        >
                    </div>

                </div>
            </div>

            <div class="property-group">
                <label>回転</label>

                <input
                    class="property-input"
                    type="number"
                    step="15"
                    value="${Math.round(element.rotation || 0)}"
                    onchange="updateRotation(this.value)"
                >
            </div>
        `;
    }


    if (
        [
            "wall",
            "door",
            "window"
        ].includes(element.type)
    ) {

        const length =
            Math.hypot(
                element.x2 - element.x1,
                element.y2 - element.y1
            );

        html += `
            <div class="property-group">
                <label>長さ</label>

                <input
                    class="property-input"
                    value="${pixelsToCm(length)} cm"
                    readonly
                >
            </div>

            <div class="property-group">
                <label>厚み</label>

                <input
                    class="property-input"
                    type="number"
                    min="1"
                    value="${pixelsToCm(element.thickness || 5)}"
                    onchange="updateLineThickness(this.value)"
                >
            </div>
        `;
    }


    if (element.type === "marker") {

        html += `
            <div class="property-group">
                <label>名称</label>

                <input
                    class="property-input"
                    value="${escapeHtmlAttribute(element.name || "")}"
                    onchange="updateElementProperty('name', this.value)"
                >
            </div>

            <div class="property-group">
                <label>注意事項</label>

                <input
                    class="property-input"
                    value="${escapeHtmlAttribute(element.note || "")}"
                    onchange="updateElementProperty('note', this.value)"
                >
            </div>
        `;
    }


    html += `
        <div class="property-group">
            <button
                class="property-delete"
                onclick="deleteSelected()"
            >
                このオブジェクトを削除
            </button>
        </div>
    `;

    propertyContent.innerHTML = html;
}


function updateElementProperty(
    property,
    value
) {

    if (!selectedElement) {
        return;
    }

    selectedElement[property] =
        value;

    pushHistory();

    updateUI();

    redraw2D();
}


function updateDimension(
    property,
    value
) {

    if (!selectedElement) {
        return;
    }

    const cm =
        Number(value);

    if (
        !Number.isFinite(cm) ||
        cm <= 0
    ) {
        return;
    }

    selectedElement[property] =
        cmToPixels(cm);

    pushHistory();

    redraw2D();
}


function updateRotation(value) {

    if (!selectedElement) {
        return;
    }

    let rotation =
        Number(value);

    if (!Number.isFinite(rotation)) {
        rotation = 0;
    }

    selectedElement.rotation =
        rotation % 360;

    pushHistory();

    redraw2D();
}


function updateLineThickness(value) {

    if (!selectedElement) {
        return;
    }

    const cm =
        Number(value);

    if (
        !Number.isFinite(cm) ||
        cm <= 0
    ) {
        return;
    }

    selectedElement.thickness =
        cmToPixels(cm);

    pushHistory();

    redraw2D();
}


function clearSelection() {

    selectedElement = null;

    propertiesPanel
        .classList
        .add("hidden");

    redraw2D();
}


/* =========================================================
   DELETE / DUPLICATE
========================================================= */

function deleteSelected() {

    if (!selectedElement) {
        return;
    }

    const index =
        project.elements.indexOf(
            selectedElement
        );

    if (index === -1) {
        return;
    }

    project.elements.splice(
        index,
        1
    );

    selectedElement = null;

    propertiesPanel
        .classList
        .add("hidden");

    pushHistory();

    updateUI();

    redraw2D();
}


function duplicateSelected() {

    if (!selectedElement) {
        return;
    }

    const copy =
        JSON.parse(
            JSON.stringify(
                selectedElement
            )
        );

    copy.id = createId();

    if (
        [
            "wall",
            "door",
            "window"
        ].includes(copy.type)
    ) {

        copy.x1 += GRID_SIZE;
        copy.y1 += GRID_SIZE;

        copy.x2 += GRID_SIZE;
        copy.y2 += GRID_SIZE;

    } else if (
        copy.type === "marker"
    ) {

        copy.x += GRID_SIZE;
        copy.y += GRID_SIZE;

    } else {

        copy.x += GRID_SIZE;
        copy.y += GRID_SIZE;
    }

    project.elements.push(copy);

    selectedElement = copy;

    pushHistory();

    showProperties(copy);

    updateUI();

    redraw2D();
}


/* =========================================================
   GRID
========================================================= */

function toggleGrid() {

    showGrid = !showGrid;

    document
        .getElementById("gridBtn")
        .classList.toggle(
            "active",
            showGrid
        );

    redraw2D();
}


function toggleSnap() {

    snapToGrid = !snapToGrid;

    document
        .getElementById("snapBtn")
        .classList.toggle(
            "active",
            snapToGrid
        );
}


/* =========================================================
   KEYBOARD
========================================================= */

function setupKeyboard() {

    document.addEventListener(
        "keydown",
        event => {

            if (
                event.target.tagName === "INPUT" ||
                event.target.tagName === "TEXTAREA"
            ) {
                return;
            }


            if (event.code === "Space") {

                spacePressed = true;

                event.preventDefault();

                return;
            }


            if (
                event.ctrlKey &&
                event.key.toLowerCase() === "z"
            ) {

                event.preventDefault();

                if (event.shiftKey) {
                    redo();
                } else {
                    undo();
                }

                return;
            }


            if (
                event.ctrlKey &&
                event.key.toLowerCase() === "y"
            ) {

                event.preventDefault();

                redo();

                return;
            }


            if (
                event.ctrlKey &&
                event.key.toLowerCase() === "d"
            ) {

                event.preventDefault();

                duplicateSelected();

                return;
            }


            if (
                event.key === "Delete" ||
                event.key === "Backspace"
            ) {

                deleteSelected();

                return;
            }


            const shortcuts = {

                v: "select",
                r: "room",
                w: "wall",
                d: "door",
                n: "window",
                b: "bed"
            };

            const tool =
                shortcuts[
                    event.key.toLowerCase()
                ];

            if (tool) {

                setTool(tool);
            }
        }
    );


    document.addEventListener(
        "keyup",
        event => {

            if (event.code === "Space") {

                spacePressed = false;

                canvas.style.cursor =
                    currentTool === "select"
                        ? "default"
                        : "crosshair";
            }
        }
    );
}


/* =========================================================
   STATS
========================================================= */

function updateUI() {

    const rooms =
        project.elements.filter(
            el => el.type === "room"
        );

    const area =
        rooms.reduce(
            (sum, room) =>
                sum +
                room.w *
                room.h *
                Math.pow(
                    METERS_PER_PIXEL,
                    2
                ),
            0
        );

    statsArea.textContent =
        `面積 ${area.toFixed(1)} m²`;

    statsObjects.textContent =
        `${project.elements.length} オブジェクト`;

    emptyState.classList.toggle(
        "hidden",
        project.elements.length > 0
    );

    if (selectedElement) {

        showProperties(
            selectedElement
        );
    }
}


function updateEmptyState() {

    emptyState.classList.toggle(
        "hidden",
        project.elements.length > 0
    );
}


/* =========================================================
   CURSOR
========================================================= */

function updateCursorPosition(point) {

    const x =
        point.x *
        METERS_PER_PIXEL;

    const y =
        point.y *
        METERS_PER_PIXEL;

    cursorPosition.textContent =
        `X: ${x.toFixed(2)}m　Y: ${y.toFixed(2)}m`;
}


/* =========================================================
   3D
========================================================= */

function init3D() {

    container3d.innerHTML = "";

    three.scene =
        new THREE.Scene();

    three.scene.background =
        new THREE.Color(
            0xf8fafc
        );


    const width =
        container3d.clientWidth;

    const height =
        container3d.clientHeight;


    three.camera =
        new THREE.PerspectiveCamera(
            45,
            width / height,
            .1,
            5000
        );


    three.camera.position.set(
        600,
        700,
        800
    );


    three.camera.lookAt(
        400,
        0,
        300
    );


    three.renderer =
        new THREE.WebGLRenderer({
            antialias: true
        });


    three.renderer.setPixelRatio(
        Math.min(
            window.devicePixelRatio || 1,
            2
        )
    );


    three.renderer.setSize(
        width,
        height
    );


    container3d.appendChild(
        three.renderer.domElement
    );


    three.scene.add(
        new THREE.AmbientLight(
            0xffffff,
            .8
        )
    );


    const light =
        new THREE.DirectionalLight(
            0xffffff,
            .7
        );

    light.position.set(
        300,
        700,
        400
    );

    three.scene.add(light);


    const grid =
        new THREE.GridHelper(
            2000,
            100,
            0xcbd5e1,
            0xe2e8f0
        );

    grid.position.set(
        500,
        0,
        400
    );

    three.scene.add(grid);


    build3DScene();

    three.initialized = true;

    render3D();
}


function build3DScene() {

    project.elements.forEach(
        element => {

            if (element.type === "room") {

                add3DRoom(
                    element
                );

            } else if (
                element.type === "wall"
            ) {

                add3DWall(
                    element
                );

            } else if (
                [
                    "door",
                    "window"
                ].includes(
                    element.type
                )
            ) {

                add3DOpening(
                    element
                );

            } else if (
                [
                    "bed",
                    "sofa",
                    "table",
                    "wheelchair"
                ].includes(
                    element.type
                )
            ) {

                add3DFurniture(
                    element
                );
            }
        }
    );
}


function add3DRoom(element) {

    const geometry =
        new THREE.BoxGeometry(
            element.w,
            3,
            element.h
        );

    const material =
        new THREE.MeshLambertMaterial({
            color: 0xe2e8f0
        });

    const mesh =
        new THREE.Mesh(
            geometry,
            material
        );

    mesh.position.set(
        element.x +
            element.w / 2,
        1.5,
        element.y +
            element.h / 2
    );

    three.scene.add(mesh);
}


function add3DWall(element) {

    const dx =
        element.x2 -
        element.x1;

    const dz =
        element.y2 -
        element.y1;

    const length =
        Math.hypot(
            dx,
            dz
        );

    const angle =
        Math.atan2(
            dz,
            dx
        );

    const thickness =
        Math.max(
            5,
            element.thickness || 10
        );


    const geometry =
        new THREE.BoxGeometry(
            length,
            60,
            thickness
        );

    const material =
        new THREE.MeshLambertMaterial({
            color: 0x334155
        });

    const mesh =
        new THREE.Mesh(
            geometry,
            material
        );

    mesh.position.set(
        (
            element.x1 +
            element.x2
        ) / 2,

        30,

        (
            element.y1 +
            element.y2
        ) / 2
    );

    mesh.rotation.y =
        -angle;

    three.scene.add(mesh);
}


function add3DOpening(element) {

    const dx =
        element.x2 -
        element.x1;

    const dz =
        element.y2 -
        element.y1;

    const length =
        Math.hypot(
            dx,
            dz
        );

    const angle =
        Math.atan2(
            dz,
            dx
        );


    const color =
        element.type === "door"
            ? 0xd97706
            : 0x0ea5e9;


    const geometry =
        new THREE.BoxGeometry(
            length,
            5,
            7
        );

    const material =
        new THREE.MeshLambertMaterial({
            color
        });

    const mesh =
        new THREE.Mesh(
            geometry,
            material
        );

    mesh.position.set(
        (
            element.x1 +
            element.x2
        ) / 2,

        35,

        (
            element.y1 +
            element.y2
        ) / 2
    );

    mesh.rotation.y =
        -angle;

    three.scene.add(mesh);
}


function add3DFurniture(element) {

    let color =
        0x64748b;

    let height = 30;


    if (element.type === "bed") {

        color = 0x2563eb;

        height = 30;

    } else if (
        element.type === "sofa"
    ) {

        color = 0xd97706;

        height = 35;

    } else if (
        element.type === "table"
    ) {

        color = 0x059669;

        height = 45;

    } else if (
        element.type === "wheelchair"
    ) {

        color = 0x7c3aed;

        height = 25;
    }


    const geometry =
        new THREE.BoxGeometry(
            element.w,
            height,
            element.h
        );

    const material =
        new THREE.MeshLambertMaterial({
            color
        });

    const mesh =
        new THREE.Mesh(
            geometry,
            material
        );

    mesh.position.set(
        element.x +
            element.w / 2,

        height / 2,

        element.y +
            element.h / 2
    );

    mesh.rotation.y =
        -(element.rotation || 0) *
        Math.PI /
        180;

    three.scene.add(mesh);
}


function render3D() {

    if (
        !three.renderer ||
        !three.scene ||
        !three.camera
    ) {
        return;
    }

    three.renderer.render(
        three.scene,
        three.camera
    );
}


function resize3D() {

    if (
        currentView !== "3d" ||
        !three.renderer
    ) {
        return;
    }

    const width =
        container3d.clientWidth;

    const height =
        container3d.clientHeight;

    three.camera.aspect =
        width / height;

    three.camera.updateProjectionMatrix();

    three.renderer.setSize(
        width,
        height
    );

    render3D();
}


/* =========================================================
   UTILITIES
========================================================= */

function pixelsToCm(px) {

    return Math.round(
        px *
        METERS_PER_PIXEL *
        100
    );
}


function cmToPixels(cm) {

    return (
        Number(cm) /
        100 /
        METERS_PER_PIXEL
    );
}


function clamp(
    value,
    min,
    max
) {

    return Math.min(
        Math.max(
            value,
            min
        ),
        max
    );
}


function positiveModulo(
    value,
    divisor
) {

    return (
        (
            value %
            divisor
        ) +
        divisor
    ) %
    divisor;
}


function escapeHtmlAttribute(value) {

    return String(value)
        .replace(/&/g, "&amp;")
        .replace(/"/g, "&quot;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;");
}


/* =========================================================
   INITIAL CAMERA
========================================================= */

setTimeout(() => {

    resetView();

}, 100);
