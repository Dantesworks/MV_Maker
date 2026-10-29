import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

const NODE_NAME = "MiniMaxH3StudioDirector";
const SIMPLE_NODE_NAME = "MiniMaxH3SimpleDirector";

function isSimpleDirector(node) {
    return node?.comfyClass === SIMPLE_NODE_NAME || node?.type === SIMPLE_NODE_NAME;
}
const FPS = 24;
const AUDIO_PREVIEW_QUANTUM_SECONDS = 0.1;
const AUDIO_SEEK_TOLERANCE_SECONDS = 0.075;
const AUDIO_SEEK_TIMEOUT_MS = 2500;
const DIRECTOR_DEFAULT_WIDTH = 760;
const DIRECTOR_DEFAULT_HEIGHT = 3000;
const DIRECTOR_MIN_HEIGHT = 900;
const DIRECTOR_MAX_HEIGHT = 3200;
const PROMPT_MIN_HEIGHT = 640;
const PROMPT_MAX_HEIGHT = 1400;
const MAX_THEME_BANKS = 32;
const THEME_COLORS = [
    "#d96f91", "#547cc7", "#d09245", "#6f9d62",
    "#8a69ba", "#4f9d9d", "#b46652", "#777f91",
    "#bc6ea8", "#4c8eaf", "#b18b49", "#6b9b80",
    "#8c78c8", "#549c86", "#c77767", "#677eaa",
];
const directors = new Set();
const durationCache = new Map();
const durationRequests = new Map();

function isDirector(node) {
    return node?.comfyClass === NODE_NAME || node?.type === NODE_NAME || isSimpleDirector(node);
}

function widget(node, name) {
    return node?.widgets?.find((item) => item.name === name) ?? null;
}

function hideWidget(item) {
    if (!item || item._h3DirectorHidden) return;
    item._h3DirectorHidden = true;
    item.computeSize = () => [0, -4];
    item.hidden = true;
}

function graphLink(graph, linkId) {
    if (linkId == null) return null;
    return graph?.links?.[linkId] ?? graph?._links?.[linkId] ?? null;
}

function linkedNode(node, inputName) {
    const input = node?.inputs?.find((item) => item.name === inputName);
    const link = graphLink(node?.graph ?? app.graph, input?.link);
    const originId = link?.origin_id ?? link?.[1];
    if (originId == null) return null;
    return (node?.graph ?? app.graph)?.getNodeById?.(originId) ?? null;
}

function linkedWidgetValue(node, inputName, widgetName = "value") {
    const origin = linkedNode(node, inputName);
    return widget(origin, widgetName)?.value;
}

function songFilename(node) {
    const origin = linkedNode(node, "master_audio");
    return String(widget(origin, "audio")?.value ?? "").trim();
}

function numericSetting(node, inputName, fallback) {
    const linked = Number(linkedWidgetValue(node, inputName));
    if (Number.isFinite(linked)) return linked;
    const own = Number(widget(node, inputName)?.value);
    return Number.isFinite(own) ? own : fallback;
}

function h3FrameLength(seconds, simple = false) {
    const target = Math.max(5, Number(seconds) * FPS);
    const lowerStep = Math.max(0, Math.floor((target - 5) / 17));
    const lower = 5 + lowerStep * 17;
    const upper = lower + 17;
    const frames = target - lower <= upper - target ? lower : upper;
    return simple ? Math.min(frames, 226) : frames;
}

function effectiveContextFrames(clipFrames, requested) {
    if (requested <= 0) return 0;
    const even = clipFrames - (clipFrames % 2);
    const bounded = Math.max(5, Math.min(Math.trunc(requested), even / 2));
    return bounded - ((((bounded - 5) % 17) + 17) % 17);
}

function requestedClipSeconds(board, clipIndex, defaultSeconds) {
    const value = Number(board?.clips?.[String(clipIndex)]?.seconds);
    return Number.isFinite(value) && value > 0 ? value : defaultSeconds;
}

function timelinePlan(duration, defaultSeconds, requestedContext, board, simple = false) {
    const songSeconds = Math.max(0, Number(duration) || 0);
    if (!songSeconds) return [];
    const segments = [];
    let startFrame = 0;
    for (let index = 1; index <= 9999; index++) {
        const requestedSeconds = requestedClipSeconds(board, index, defaultSeconds);
        const frames = h3FrameLength(requestedSeconds, simple);
        const context = effectiveContextFrames(frames, requestedContext);
        const start = startFrame / FPS;
        const end = Math.min(songSeconds, (startFrame + frames) / FPS);
        segments.push({
            index,
            requestedSeconds,
            frames,
            actualSeconds: frames / FPS,
            context,
            advance: frames - context,
            start,
            end,
            duration: Math.max(0, end - start),
        });
        if (startFrame + frames >= songSeconds * FPS) break;
        startFrame += frames - context;
    }
    return segments;
}

function durationOverridesKey(board) {
    return Object.entries(board?.clips ?? {})
        .filter(([, entry]) => Number.isFinite(Number(entry?.seconds)) && Number(entry.seconds) > 0)
        .map(([index, entry]) => [Number(index), Number(entry.seconds)])
        .sort((left, right) => left[0] - right[0]);
}

function formatTime(seconds) {
    const value = Math.max(0, Number(seconds) || 0);
    const minutes = Math.floor(value / 60);
    const remainder = (value - minutes * 60).toFixed(1).padStart(4, "0");
    return `${minutes}:${remainder}`;
}

function formatTimePrecise(seconds) {
    const value = Math.max(0, Number(seconds) || 0);
    const minutes = Math.floor(value / 60);
    const remainder = (value - minutes * 60).toFixed(3).padStart(6, "0");
    return `${String(minutes).padStart(2, "0")}:${remainder}`;
}

function readDuration(filename) {
    if (durationCache.has(filename)) return Promise.resolve(durationCache.get(filename));
    if (durationRequests.has(filename)) return durationRequests.get(filename);
    const request = new Promise((resolve, reject) => {
        const audio = document.createElement("audio");
        const timeout = setTimeout(() => reject(new Error("audio metadata timed out")), 15000);
        const done = (fn, value) => {
            clearTimeout(timeout);
            audio.removeAttribute("src");
            fn(value);
        };
        audio.preload = "metadata";
        audio.addEventListener("loadedmetadata", () => {
            if (Number.isFinite(audio.duration) && audio.duration > 0) done(resolve, audio.duration);
            else done(reject, new Error("duration unavailable"));
        }, { once: true });
        audio.addEventListener("error", () => done(reject, new Error(`cannot read ${filename}`)), { once: true });
        audio.src = api.apiURL(`/view?${new URLSearchParams({ filename, type: "input" })}`);
    }).then((duration) => {
        durationCache.set(filename, duration);
        durationRequests.delete(filename);
        return duration;
    }).catch((error) => {
        durationRequests.delete(filename);
        throw error;
    });
    durationRequests.set(filename, request);
    return request;
}

function inputMediaURL(filename) {
    return api.apiURL(`/view?${new URLSearchParams({ filename, type: "input" })}`);
}

function stopAudioPreview(ui, reset = false) {
    if (!ui) return;
    if (ui.audioStopTimer) {
        clearTimeout(ui.audioStopTimer);
        ui.audioStopTimer = null;
    }
    const audio = ui.audioPreview;
    if (!audio) return;
    audio.pause();
    if (reset && Number.isFinite(ui.audioSegmentStart) && audio.readyState > 0) {
        audio.currentTime = ui.audioSegmentStart;
    }
}

function freshBoard() {
    return {
        version: 1,
        default: { theme: 1, prompt: "", seed: 0, take: 1 },
        clips: {},
    };
}

function parseBoard(node) {
    const raw = String(widget(node, "board_data")?.value ?? "").trim();
    try {
        const parsed = JSON.parse(raw || "{}");
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return freshBoard();
        parsed.version = 1;
        parsed.default = { ...freshBoard().default, ...(parsed.default ?? {}) };
        parsed.clips = parsed.clips && typeof parsed.clips === "object" ? parsed.clips : {};
        return parsed;
    } catch (_) {
        return freshBoard();
    }
}

function randomSeed() {
    return Math.floor(Math.random() * 900000000000000) + 100000000000000;
}

function randomSeedNotIn(used) {
    let value = randomSeed();
    while (used.has(value)) value = randomSeed();
    used.add(value);
    return value;
}

function newTakeAndSeeds(node, scope) {
    const ui = node._h3DirectorUI;
    const count = Math.max(0, Math.trunc(Number(ui?.clipCount) || 0));
    if (!ui || !count) return;

    const targets = scope === "all"
        ? Array.from({ length: count }, (_, index) => index + 1)
        : [...ui.selected].filter((index) => index >= 1 && index <= count).sort((a, b) => a - b);
    if (!targets.length) return;
    if (scope === "all" && !window.confirm(
        `Assign unique new seeds and increment the take number for all ${count} clips?`,
    )) return;

    const targetSet = new Set(targets);
    const board = parseBoard(node);
    const used = new Set();
    for (let index = 1; index <= count; index++) {
        const entry = ensureClip(board, index);
        if (!targetSet.has(index)) used.add(entry.seed);
    }

    const graph = node.graph ?? app.graph;
    graph?.beforeChange?.();
    try {
        for (const index of targets) {
            const entry = ensureClip(board, index);
            entry.seed = randomSeedNotIn(used);
            entry.take = Math.max(1, Math.trunc(Number(entry.take) || 1)) + 1;
        }
        saveBoard(node, board);
    } finally {
        graph?.afterChange?.();
    }
    renderDirector(node, true);
}

function ensureClip(board, index) {
    const key = String(index);
    if (!board.clips[key] || typeof board.clips[key] !== "object") {
        board.clips[key] = {
            theme: Number(board.default.theme) || 1,
            prompt: String(board.default.prompt ?? ""),
            seed: Number(board.default.seed) || randomSeed(),
            take: Number(board.default.take) || 1,
        };
    }
    const entry = board.clips[key];
    entry.theme = Math.max(1, Math.min(MAX_THEME_BANKS, Math.trunc(Number(entry.theme) || 1)));
    entry.prompt = String(entry.prompt ?? "");
    entry.seed = Math.max(0, Math.trunc(Number(entry.seed) || 0));
    entry.take = Math.max(1, Math.trunc(Number(entry.take) || 1));
    if ("seconds" in entry) {
        const seconds = Number(entry.seconds);
        if (Number.isFinite(seconds) && seconds > 0) entry.seconds = seconds;
        else delete entry.seconds;
    }
    return entry;
}

function saveBoard(node, board) {
    const item = widget(node, "board_data");
    if (!item) return;
    const value = JSON.stringify(board);
    if (item.value !== value) {
        item.value = value;
        item.callback?.(value);
        node.graph?.setDirtyCanvas?.(true, true);
    }
}

function themeInfo(node, slot) {
    const origin = linkedNode(node, `theme_${slot}`);
    const name = String(widget(origin, "theme_name")?.value ?? `Theme ${slot}`).trim() || `Theme ${slot}`;
    return { name, connected: Boolean(origin), color: THEME_COLORS[slot - 1] };
}

function element(tag, styles = {}, text = "") {
    const item = document.createElement(tag);
    Object.assign(item.style, styles);
    if (text) item.textContent = text;
    return item;
}

function button(text, click) {
    const item = element("button", {
        border: "1px solid #555",
        borderRadius: "5px",
        background: "#292929",
        color: "#eee",
        padding: "5px 8px",
        cursor: "pointer",
        fontSize: "12px",
    }, text);
    item.type = "button";
    item.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        click(event);
    });
    return item;
}

function labeledInput(labelText, input) {
    const wrap = element("label", { display: "flex", flexDirection: "column", gap: "3px", flex: "1" });
    wrap.append(element("span", { color: "#bbb", fontSize: "11px" }, labelText), input);
    return wrap;
}

function styleInput(input) {
    Object.assign(input.style, {
        boxSizing: "border-box",
        width: "100%",
        border: "1px solid #555",
        borderRadius: "4px",
        background: "#181818",
        color: "#eee",
        padding: "5px",
        fontSize: "12px",
    });
    return input;
}

function clampPromptHeight(value) {
    return Math.max(PROMPT_MIN_HEIGHT, Math.min(PROMPT_MAX_HEIGHT, Number(value) || 0));
}

function rememberedPromptHeight(node) {
    return clampPromptHeight(node?.properties?.h3_prompt_editor_height);
}

function rememberPromptHeight(node, prompt) {
    if (!node || !prompt) return;
    node.properties ??= {};
    const height = clampPromptHeight(prompt.getBoundingClientRect().height);
    node.properties.h3_prompt_editor_height = height;
    node._h3DirectorUI.promptHeight = height;
}

function fitPromptEditor(node, prompt) {
    requestAnimationFrame(() => {
        if (!prompt?.isConnected || node?._h3DirectorUI?.promptInput !== prompt) return;
        const ui = node._h3DirectorUI;
        const remembered = Math.max(ui.promptHeight || 0, rememberedPromptHeight(node));
        prompt.style.height = "auto";
        const height = clampPromptHeight(Math.max(remembered, prompt.scrollHeight + 2));
        prompt.style.height = `${height}px`;
        ui.promptHeight = height;
    });
}

function setQueueAllStatus(ui, text, color = "#b9d9f4") {
    if (!ui?.queueAllStatus) return;
    ui.queueAllStatus.textContent = text;
    ui.queueAllStatus.style.color = color;
    ui.queueAllStatus.style.display = text ? "block" : "none";
}

function selectedClipIndexes(ui) {
    const count = Math.max(0, Math.trunc(Number(ui.clipCount) || 0));
    return [...(ui?.selected ?? [])]
        .map((index) => Math.trunc(Number(index)))
        .filter((index) => index >= 1 && index <= count)
        .sort((left, right) => left - right);
}

function updateQueueAllButton(ui) {
    const allButton = ui?.queueAllButton;
    const selectedButton = ui?.queueSelectedButton;
    if (!allButton || !selectedButton) return;
    const count = Math.max(0, Math.trunc(Number(ui.clipCount) || 0));
    const selectedCount = selectedClipIndexes(ui).length;
    if (ui.queueAllRunning) {
        const targetCount = Math.max(0, Math.trunc(Number(ui.queueTargetCount) || 0));
        const activeButton = ui.queueMode === "selected" ? selectedButton : allButton;
        const inactiveButton = ui.queueMode === "selected" ? allButton : selectedButton;
        activeButton.textContent = `STOP QUEUING (${ui.queueAllProgress || 0}/${targetCount})`;
        activeButton.style.background = "#7b3030";
        activeButton.title = "Stop submitting additional clip jobs. Jobs already placed in the ComfyUI queue remain queued.";
        activeButton.disabled = false;
        activeButton.style.opacity = "1";
        inactiveButton.disabled = true;
        inactiveButton.style.opacity = "0.45";
        return;
    }

    selectedButton.textContent = selectedCount ? `QUEUE SELECTED ${selectedCount} CLIPS` : "QUEUE SELECTED CLIPS";
    selectedButton.style.background = "#315f42";
    selectedButton.title = selectedCount
        ? `Queue ${selectedCount} independent generation jobs, one for each selected clip.`
        : "Select one or more clips to queue them.";
    selectedButton.disabled = selectedCount < 1;
    selectedButton.style.opacity = selectedCount < 1 ? "0.45" : "1";

    allButton.textContent = count ? `QUEUE ALL ${count} CLIPS` : "QUEUE ALL CLIPS";
    allButton.style.background = "#315f42";
    allButton.title = count
        ? `Queue ${count} independent generation jobs, one for each clip with its assigned theme, prompt, seed, take, audio slice, and filename.`
        : "Load a master song before queueing all clips.";
    allButton.disabled = count < 1;
    allButton.style.opacity = count < 1 ? "0.45" : "1";
}

async function queueClips(node, requestedIndexes, mode) {
    const ui = node?._h3DirectorUI;
    if (!ui) return;
    if (node._localPromptBatchEditor?.busy) {
        setQueueAllStatus(ui, "Finish or cancel the prompt edits before queueing clips.", "#ffd166");
        return;
    }
    if (ui.queueAllRunning) {
        ui.queueAllCancelled = true;
        setQueueAllStatus(ui, "Stopping after the current clip is submitted…", "#ffd166");
        updateQueueAllButton(ui);
        return;
    }

    const clipCount = Math.max(0, Math.trunc(Number(ui.clipCount) || 0));
    const indexes = [...new Set(requestedIndexes)]
        .map((index) => Math.trunc(Number(index)))
        .filter((index) => index >= 1 && index <= clipCount)
        .sort((left, right) => left - right);
    const count = indexes.length;
    if (!count) {
        setQueueAllStatus(ui, mode === "selected"
            ? "Select one or more clips before queueing."
            : "Load a master song before queueing all clips.", "#ff8f8f");
        return;
    }
    const board = parseBoard(node);
    const missingPrompts = [];
    for (const index of indexes) {
        if (!ensureClip(board, index).prompt.trim()) missingPrompts.push(index);
    }
    if (missingPrompts.length) {
        setQueueAllStatus(
            ui,
            `Queue cancelled: add prompts for clips ${missingPrompts.join(", ")}.`,
            "#ff8f8f",
        );
        return;
    }

    const selectionLabel = mode === "selected" ? `${count} selected clips` : `all ${count} clips`;
    const confirmed = window.confirm(
        `Queue ${selectionLabel} as separate H3 generation jobs?\n\n`
        + "Each queued job uses that clip's assigned theme, prompt, seed, take number, exact song interval, and automatic filename.",
    );
    if (!confirmed) return;

    const selectedWidget = widget(node, "selected_clip");
    if (!selectedWidget) {
        setQueueAllStatus(ui, "Queue cancelled: the selected_clip control is unavailable.", "#ff8f8f");
        return;
    }

    const originalPrimary = Math.max(1, Math.trunc(Number(selectedWidget.value) || 1));
    const originalSelection = new Set(ui.selected);
    const originalAnchor = ui.anchor;
    let queued = 0;
    let failure = null;
    ui.queueAllRunning = true;
    ui.queueAllCancelled = false;
    ui.queueAllProgress = 0;
    ui.queueMode = mode;
    ui.queueTargetCount = count;
    updateQueueAllButton(ui);

    try {
        for (const index of indexes) {
            if (ui.queueAllCancelled) break;
            setPrimaryClip(node, index, true);
            ui.queueAllProgress = queued;
            setQueueAllStatus(ui, `Submitting clip ${index} (${queued + 1} of ${count})…`);
            updateQueueAllButton(ui);
            await Promise.resolve();
            try {
                const accepted = await app.queuePrompt(0, 1);
                if (accepted === false) throw new Error("ComfyUI rejected the job.");
            } catch (error) {
                throw new Error(`Clip ${index}: ${error?.message ?? error}`);
            }
            queued += 1;
            ui.queueAllProgress = queued;
            setQueueAllStatus(ui, `Queued ${queued} of ${count} clips.`);
            updateQueueAllButton(ui);
        }
    } catch (error) {
        failure = error;
        console.error("H3 Studio Director batch queue failed:", error);
    } finally {
        const cancelled = ui.queueAllCancelled;
        setPrimaryClip(node, originalPrimary, true);
        ui.selected = originalSelection;
        ui.anchor = originalAnchor;
        ui.queueAllRunning = false;
        ui.queueAllCancelled = false;
        ui.queueAllProgress = queued;
        ui.queueMode = null;
        ui.queueTargetCount = 0;
        if (failure) {
            setQueueAllStatus(ui, `Stopped after ${queued} of ${count}: ${failure.message}`, "#ff8f8f");
        } else if (cancelled) {
            setQueueAllStatus(
                ui,
                `Stopped after ${queued} of ${count}. Already queued jobs remain in the ComfyUI queue.`,
                "#ffd166",
            );
        } else {
            setQueueAllStatus(ui, `All ${queued} ${mode === "selected" ? "selected " : ""}clip jobs are queued.`, "#9ed8ac");
        }
        updateQueueAllButton(ui);
        renderDirector(node, true);
    }
}

function queueSelectedClips(node) {
    return queueClips(node, selectedClipIndexes(node?._h3DirectorUI), "selected");
}

function queueAllClips(node) {
    const count = Math.max(0, Math.trunc(Number(node?._h3DirectorUI?.clipCount) || 0));
    return queueClips(node, Array.from({ length: count }, (_, index) => index + 1), "all");
}

function buildDirectorUI(node) {
    if (node._h3DirectorUI) return;
    node._h3DirectorUI = {};
    hideWidget(widget(node, "board_data"));
    hideWidget(widget(node, "song_filename"));

    const root = element("div", {
        width: "100%",
        height: "100%",
        boxSizing: "border-box",
        display: "flex",
        flexDirection: "column",
        gap: "8px",
        padding: "8px",
        overflow: "auto",
        background: "#202124",
        color: "#eee",
        fontFamily: "Arial, sans-serif",
    });
    root.addEventListener("pointerdown", (event) => event.stopPropagation());

    const status = element("div", {
        padding: "7px",
        borderRadius: "5px",
        background: "#17212b",
        color: "#b9d9f4",
        fontSize: "12px",
        fontWeight: "600",
    }, "Select a song in the connected Load Audio node.");
    const instructions = element("div", { color: "#aaa", fontSize: "11px", lineHeight: "1.35" },
        "Click a clip to set its target seconds, edit it, and preview its matching master-song interval. Preview seeks are rounded to 0.1s for reliable MP3 playback; exact workflow timing stays frame-aligned. H3 uses the nearest legal frame length, and changing one clip shifts every later interval. Turn on Multi-select, Ctrl/Cmd-click, or Shift-click to select several clips for theme assignment, new seeds, or Queue Selected. Queue All submits every populated clip.");
    const themeBar = element("div", { display: "grid", gridTemplateColumns: "repeat(4, minmax(0, 1fr))", gap: "5px" });
    const controls = element("div", { display: "flex", gap: "6px", alignItems: "center", flexWrap: "wrap" });
    const queueAllStatus = element("div", {
        display: "none",
        padding: "6px 7px",
        borderRadius: "5px",
        background: "#17212b",
        color: "#b9d9f4",
        fontSize: "11px",
        fontWeight: "600",
    });
    const clipGrid = element("div", {
        display: "grid",
        gridTemplateColumns: "repeat(9, minmax(0, 1fr))",
        gap: "5px",
        minHeight: "40px",
        flexShrink: "0",
    });
    const editor = element("div", {
        display: "flex",
        flexDirection: "column",
        gap: "7px",
        paddingTop: "7px",
        borderTop: "1px solid #444",
    });

    const multiButton = button("Multi-select: OFF", () => {
        node._h3DirectorUI.multiMode = !node._h3DirectorUI.multiMode;
        renderDirector(node, true);
    });
    const queueSelectedButton = button("QUEUE SELECTED CLIPS", () => queueSelectedClips(node));
    queueSelectedButton.style.fontWeight = "700";
    queueSelectedButton.style.marginLeft = "auto";
    const queueAllButton = button("QUEUE ALL CLIPS", () => queueAllClips(node));
    queueAllButton.style.fontWeight = "700";
    const newSelectedSeedsButton = button("NEW TAKE + SEEDS — SELECTED", () => newTakeAndSeeds(node, "selected"));
    newSelectedSeedsButton.title = "Give every selected clip a unique random seed and increment its take number.";
    const newAllSeedsButton = button("NEW TAKE + SEEDS — ALL", () => newTakeAndSeeds(node, "all"));
    newAllSeedsButton.title = "Give every clip a unique random seed and increment every take number.";
    controls.append(
        multiButton,
        button("Select all clips", () => {
            const count = node._h3DirectorUI.clipCount || 0;
            node._h3DirectorUI.selected = new Set(Array.from({ length: count }, (_, i) => i + 1));
            renderDirector(node);
        }),
        button("Clear selection", () => {
            const selected = Math.max(1, Math.trunc(Number(widget(node, "selected_clip")?.value) || 1));
            node._h3DirectorUI.selected = new Set([selected]);
            renderDirector(node);
        }),
        newSelectedSeedsButton,
        newAllSeedsButton,
        queueSelectedButton,
        queueAllButton,
    );

    root.append(status, instructions, themeBar, controls, queueAllStatus, clipGrid, editor);
    node.addDOMWidget("clip_board", "h3-studio-director", root, {
        serialize: false,
        hideOnZoom: false,
        getMinHeight: () => DIRECTOR_MIN_HEIGHT,
        getMaxHeight: () => DIRECTOR_MAX_HEIGHT,
    });
    node._h3DirectorUI = {
        root, status, themeBar, clipGrid, editor, multiButton, queueSelectedButton, queueAllButton, queueAllStatus,
        selected: new Set([Math.max(1, Math.trunc(Number(widget(node, "selected_clip")?.value) || 1))]),
        multiMode: false,
        anchor: 1,
        clipCount: 0,
        duration: 0,
        timeline: [],
        settingsKey: "",
        renderKey: "",
        audioPreview: null,
        audioStopTimer: null,
        audioSegmentStart: 0,
        audioSegmentEnd: 0,
        promptHeight: rememberedPromptHeight(node),
        queueAllRunning: false,
        queueAllCancelled: false,
        queueAllProgress: 0,
        queueMode: null,
        queueTargetCount: 0,
    };
    const selectedWidget = widget(node, "selected_clip");
    if (selectedWidget && !selectedWidget._h3DirectorCallback) {
        selectedWidget._h3DirectorCallback = true;
        const original = selectedWidget.callback;
        selectedWidget.callback = function(value, ...args) {
            const result = original?.call(this, value, ...args);
            if (node._h3DirectorSuppressSelectedCallback) return result;
            const selected = Math.max(1, Math.trunc(Number(value) || 1));
            node._h3DirectorUI.selected = new Set([selected]);
            node._h3DirectorUI.anchor = selected;
            renderDirector(node, true);
            return result;
        };
    }
    // Grow older saved nodes once, but never shrink a node the user has made larger.
    // Subsequent clip changes only rebuild the contents and leave this size alone.
    node.setSize?.([
        Math.max(DIRECTOR_DEFAULT_WIDTH, node.size?.[0] ?? 0),
        Math.max(isSimpleDirector(node) ? 1700 : DIRECTOR_DEFAULT_HEIGHT, node.size?.[1] ?? 0),
    ]);
    refreshDirector(node, true);
}

function setPrimaryClip(node, index, preserveSelection = false) {
    const selectedWidget = widget(node, "selected_clip");
    if (selectedWidget && Number(selectedWidget.value) !== index) {
        node._h3DirectorSuppressSelectedCallback = preserveSelection;
        try {
            selectedWidget.value = index;
            selectedWidget.callback?.(index);
        } finally {
            node._h3DirectorSuppressSelectedCallback = false;
        }
    }
    if (!preserveSelection) node._h3DirectorUI.selected = new Set([index]);
    node._h3DirectorUI.anchor = index;
}

function renderDirector(node, force = false) {
    const ui = node._h3DirectorUI;
    if (!ui?.root) return;
    const count = ui.clipCount;
    updateQueueAllButton(ui);
    const board = parseBoard(node);
    for (let index = 1; index <= count; index++) ensureClip(board, index);
    saveBoard(node, board);
    const primary = Math.max(1, Math.min(count || 1, Math.trunc(Number(widget(node, "selected_clip")?.value) || 1)));
    const themeNames = Array.from({ length: MAX_THEME_BANKS }, (_, i) => themeInfo(node, i + 1));
    const key = JSON.stringify({ count, board, selected: [...ui.selected].sort((a, b) => a - b), primary, themes: themeNames.map((t) => [t.name, t.connected]) });
    // Typing changes board_data on every keystroke. The periodic Director
    // refresh must not rebuild the textarea while it owns keyboard focus.
    // Accept the new render key because the textarea already displays the
    // current value, then defer structural rebuilding until another control
    // actually requires it.
    if (!force && ui.promptInput && document.activeElement === ui.promptInput) {
        ui.renderKey = key;
        return;
    }
    if (!force && ui.renderKey === key) return;
    ui.renderKey = key;
    ui.multiButton.textContent = `Multi-select: ${ui.multiMode ? "ON" : "OFF"}`;
    ui.multiButton.style.background = ui.multiMode ? "#80651a" : "#292929";

    ui.themeBar.replaceChildren();
    themeNames.forEach((theme, index) => {
        if (isSimpleDirector(node) && !theme.connected) return;
        const slot = index + 1;
        const item = button(`${slot}. ${theme.name}`, () => {
            const targets = ui.selected.size ? [...ui.selected] : [primary];
            for (const clip of targets) ensureClip(board, clip).theme = slot;
            saveBoard(node, board);
            renderDirector(node, true);
        });
        item.style.background = theme.connected ? theme.color : "#3b3b3b";
        item.style.opacity = theme.connected ? "1" : "0.7";
        item.title = theme.connected ? `Assign ${theme.name}` : `Theme slot ${slot} is not connected yet`;
        ui.themeBar.append(item);
    });

    ui.clipGrid.replaceChildren();
    if (!count) {
        ui.clipGrid.append(element("div", { color: "#999", gridColumn: "1 / -1", padding: "12px" }, "Waiting for song duration…"));
    }
    for (let index = 1; index <= count; index++) {
        const entry = ensureClip(board, index);
        const segment = ui.timeline[index - 1];
        const selected = ui.selected.has(index);
        const isPrimary = index === primary;
        const item = button(String(index), (event) => {
            if (event.shiftKey) {
                const start = Math.min(ui.anchor || index, index);
                const end = Math.max(ui.anchor || index, index);
                ui.selected = new Set(Array.from({ length: end - start + 1 }, (_, i) => start + i));
                setPrimaryClip(node, index, true);
            } else if (ui.multiMode || event.ctrlKey || event.metaKey) {
                if (ui.selected.has(index) && ui.selected.size > 1) ui.selected.delete(index);
                else ui.selected.add(index);
                setPrimaryClip(node, index, true);
            } else {
                ui.selected = new Set([index]);
                setPrimaryClip(node, index, true);
            }
            renderDirector(node, true);
        });
        item.style.background = THEME_COLORS[entry.theme - 1];
        item.style.border = isPrimary ? "3px solid #fff" : selected ? "2px solid #ffd166" : "1px solid #555";
        item.style.padding = "7px 3px";
        item.title = segment
            ? `Clip ${index}: ${themeNames[entry.theme - 1].name}; ${segment.requestedSeconds.toFixed(3)}s requested → ${segment.actualSeconds.toFixed(6)}s (${segment.frames} frames); take ${entry.take}`
            : `Clip ${index}: ${themeNames[entry.theme - 1].name}; take ${entry.take}`;
        ui.clipGrid.append(item);
    }

    stopAudioPreview(ui);
    ui.audioPreview = null;
    ui.editor.replaceChildren();
    if (!count) return;
    const entry = ensureClip(board, primary);
    const heading = element("div", { fontWeight: "700", color: "#fff" },
        `Clip ${primary} details${ui.selected.size > 1 ? ` — ${ui.selected.size} clips selected for bulk actions` : ""}`);
    const clipSeconds = numericSetting(node, "clip_seconds", 7);
    const segment = ui.timeline[primary - 1] ?? timelinePlan(
        ui.duration,
        clipSeconds,
        numericSetting(node, "context_frames", 0),
        board,
        isSimpleDirector(node),
    )[primary - 1];
    const previewStart = Math.max(
        0,
        Math.round(segment.start / AUDIO_PREVIEW_QUANTUM_SECONDS) * AUDIO_PREVIEW_QUANTUM_SECONDS,
    );
    const previewEnd = previewStart + segment.duration;
    ui.audioSegmentStart = previewStart;
    ui.audioSegmentEnd = previewEnd;
    const audioPanel = element("div", {
        display: "flex",
        flexDirection: "column",
        gap: "6px",
        padding: "8px",
        border: "1px solid #465665",
        borderRadius: "5px",
        background: "#17212b",
    });
    const audioHeading = element("div", { color: "#d9e7f2", fontSize: "12px", fontWeight: "700" },
        `Clip ${primary} audio — ${formatTimePrecise(segment.start)} to ${formatTimePrecise(segment.end)} (${segment.duration.toFixed(3)}s)`);
    const previewOffset = previewStart - segment.start;
    const previewSeekNote = Math.abs(previewOffset) >= 0.0005
        ? ` Preview playback begins at ${formatTimePrecise(previewStart)}, rounded ${previewOffset > 0 ? "forward" : "back"} ${Math.abs(previewOffset).toFixed(3)}s for reliable MP3 seeking.`
        : "";
    const audioStatus = element("div", { color: "#aebdcc", fontSize: "11px" },
        `${segment.requestedSeconds.toFixed(3)}s requested → nearest H3 duration ${segment.actualSeconds.toFixed(6)}s (${segment.frames} frames).${previewSeekNote}`);
    const audioControls = element("div", { display: "flex", gap: "7px", flexWrap: "wrap" });
    const audio = document.createElement("audio");
    audio.controls = true;
    audio.preload = "metadata";
    audio.src = inputMediaURL(songFilename(node));
    Object.assign(audio.style, { width: "100%", height: "36px" });
    ui.audioPreview = audio;
    let preparingPlayback = false;
    const waitForMetadata = () => {
        if (audio.readyState > 0) return Promise.resolve();
        return new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
                cleanup();
                reject(new Error("the master song did not finish loading"));
            }, AUDIO_SEEK_TIMEOUT_MS);
            const cleanup = () => {
                clearTimeout(timeout);
                audio.removeEventListener("loadedmetadata", onReady);
                audio.removeEventListener("error", onError);
            };
            const onReady = () => {
                cleanup();
                resolve();
            };
            const onError = () => {
                cleanup();
                reject(new Error("the master song could not be loaded"));
            };
            audio.addEventListener("loadedmetadata", onReady, { once: true });
            audio.addEventListener("error", onError, { once: true });
            audio.load();
        });
    };
    const seekOnce = () => new Promise((resolve, reject) => {
        if (!audio.seeking && Math.abs(audio.currentTime - previewStart) <= AUDIO_SEEK_TOLERANCE_SECONDS) {
            resolve();
            return;
        }
        const timeout = setTimeout(() => {
            cleanup();
            reject(new Error("the browser did not complete the audio seek"));
        }, AUDIO_SEEK_TIMEOUT_MS);
        const cleanup = () => {
            clearTimeout(timeout);
            audio.removeEventListener("seeked", onSeeked);
            audio.removeEventListener("error", onError);
        };
        const onSeeked = () => {
            cleanup();
            resolve();
        };
        const onError = () => {
            cleanup();
            reject(new Error("the master song could not be sought"));
        };
        audio.addEventListener("seeked", onSeeked, { once: true });
        audio.addEventListener("error", onError, { once: true });
        try {
            audio.currentTime = previewStart;
        } catch (error) {
            cleanup();
            reject(error);
        }
    });
    const seekToStart = async (allowReload = true) => {
        await waitForMetadata();
        try {
            await seekOnce();
        } catch (error) {
            if (!allowReload) throw error;
            // A compressed MP3 seek can occasionally stall in Chromium. Reload
            // the element to discard that decoder state, then make one clean retry.
            audio.pause();
            audio.load();
            await waitForMetadata();
            await seekOnce();
        }
    };
    const isOutsideSegment = (endTolerance = 0) => {
        return audio.currentTime < previewStart - AUDIO_SEEK_TOLERANCE_SECONDS
            || audio.currentTime >= previewEnd - endTolerance;
    };
    const scheduleBoundaryStop = () => {
        if (ui.audioStopTimer) clearTimeout(ui.audioStopTimer);
        const remaining = Math.max(0, previewEnd - audio.currentTime);
        ui.audioStopTimer = setTimeout(() => {
            audio.pause();
            void seekToStart();
            audioStatus.textContent = `Clip ${primary} interval finished — ready to replay.`;
            ui.audioStopTimer = null;
        }, remaining * 1000 + 25);
    };
    let playButton;
    const startPreviewPlayback = async () => {
        if (preparingPlayback) return;
        preparingPlayback = true;
        playButton.disabled = true;
        audioStatus.style.color = "#aebdcc";
        audioStatus.textContent = `Preparing clip ${primary} audio at ${formatTimePrecise(previewStart)}…`;
        try {
            audio.pause();
            await seekToStart();
            await audio.play();
        } catch (error) {
            audioStatus.textContent = `Could not play the song: ${error.message}`;
            audioStatus.style.color = "#ffb4ab";
        } finally {
            preparingPlayback = false;
            playButton.disabled = false;
        }
    };
    playButton = button(`▶ PLAY CLIP ${primary} AUDIO`, startPreviewPlayback);
    const replayButton = button("↶ RESTART INTERVAL", async () => {
        stopAudioPreview(ui);
        try {
            await seekToStart();
            audioStatus.style.color = "#aebdcc";
            audioStatus.textContent = `Ready at ${formatTimePrecise(previewStart)}.`;
        } catch (error) {
            audioStatus.style.color = "#ffb4ab";
            audioStatus.textContent = `Could not restart the interval: ${error.message}`;
        }
    });
    audio.addEventListener("loadedmetadata", () => {
        audioStatus.textContent = `Song loaded — clip ${primary} will start at ${formatTimePrecise(previewStart)} and stop at ${formatTimePrecise(previewEnd)}.`;
    });
    audio.addEventListener("play", () => {
        if (!preparingPlayback && isOutsideSegment(0.03)) {
            audio.pause();
            void startPreviewPlayback();
            return;
        }
        audioStatus.style.color = "#8ee3a1";
        audioStatus.textContent = `Playing clip ${primary}: ${formatTimePrecise(previewStart)}–${formatTimePrecise(previewEnd)}.`;
        scheduleBoundaryStop();
    });
    audio.addEventListener("pause", () => {
        if (ui.audioStopTimer) {
            clearTimeout(ui.audioStopTimer);
            ui.audioStopTimer = null;
        }
    });
    audio.addEventListener("seeked", () => {
        if (!audio.paused) scheduleBoundaryStop();
    });
    audio.addEventListener("timeupdate", () => {
        if (audio.currentTime >= previewEnd - 0.015) {
            audio.pause();
            void seekToStart();
            audioStatus.textContent = `Clip ${primary} interval finished — ready to replay.`;
        }
    });
    audio.addEventListener("error", () => {
        audioStatus.style.color = "#ffb4ab";
        audioStatus.textContent = "The selected master song could not be loaded for preview.";
    });
    audioControls.append(playButton, replayButton);
    audioPanel.append(audioHeading, audioStatus, audioControls, audio);
    const row = element("div", { display: "flex", gap: "8px" });
    row.style.flexWrap = "wrap";
    const themeSelect = styleInput(document.createElement("select"));
    themeNames.forEach((theme, index) => {
        if (isSimpleDirector(node) && !theme.connected && index + 1 !== entry.theme) return;
        const option = document.createElement("option");
        option.value = String(index + 1);
        option.textContent = `${index + 1}. ${theme.name}${theme.connected ? "" : " (not connected)"}`;
        themeSelect.append(option);
    });
    themeSelect.value = String(entry.theme);
    themeSelect.addEventListener("change", () => {
        const slot = Number(themeSelect.value);
        const targets = ui.selected.size ? [...ui.selected] : [primary];
        for (const clip of targets) ensureClip(board, clip).theme = slot;
        saveBoard(node, board);
        renderDirector(node, true);
    });
    const seedInput = styleInput(document.createElement("input"));
    seedInput.type = "number";
    seedInput.min = "0";
    seedInput.step = "1";
    seedInput.value = String(entry.seed);
    seedInput.addEventListener("change", () => {
        entry.seed = Math.max(0, Math.trunc(Number(seedInput.value) || 0));
        saveBoard(node, board);
        renderDirector(node, true);
    });
    const takeInput = styleInput(document.createElement("input"));
    takeInput.type = "number";
    takeInput.min = "1";
    takeInput.step = "1";
    takeInput.value = String(entry.take);
    takeInput.addEventListener("change", () => {
        entry.take = Math.max(1, Math.trunc(Number(takeInput.value) || 1));
        saveBoard(node, board);
        renderDirector(node, true);
    });
    const secondsWrap = element("div", { display: "flex", gap: "5px", alignItems: "flex-end" });
    const secondsInput = styleInput(document.createElement("input"));
    secondsInput.type = "number";
    secondsInput.min = "0.25";
    secondsInput.max = isSimpleDirector(node) ? "10" : "60";
    secondsInput.step = "0.01";
    secondsInput.value = String(requestedClipSeconds(board, primary, clipSeconds));
    secondsInput.title = "Requested duration for this clip. It is snapped to the nearest legal MiniMax H3 frame run.";
    secondsInput.addEventListener("change", () => {
        entry.seconds = Math.max(0.25, Math.min(isSimpleDirector(node) ? 10 : 60, Number(secondsInput.value) || clipSeconds));
        saveBoard(node, board);
        refreshDirector(node, true);
    });
    const useGlobalButton = button("Use global", () => {
        delete entry.seconds;
        saveBoard(node, board);
        refreshDirector(node, true);
    });
    useGlobalButton.title = `Remove this override and follow the global ${clipSeconds.toFixed(2)}s target.`;
    secondsWrap.append(secondsInput);
    if (!isSimpleDirector(node)) secondsWrap.append(useGlobalButton);
    row.append(
        labeledInput("Theme (applies to selected clips)", themeSelect),
        labeledInput("Target seconds (this clip)", secondsWrap),
        labeledInput("Seed", seedInput),
        labeledInput("Take", takeInput),
    );
    const prompt = styleInput(document.createElement("textarea"));
    prompt.placeholder = "Paste or write the complete H3 prompt for this clip here.";
    prompt.value = entry.prompt;
    prompt.style.resize = "vertical";
    prompt.style.fontFamily = "Consolas, monospace";
    prompt.style.lineHeight = "1.4";
    prompt.style.minHeight = `${PROMPT_MIN_HEIGHT}px`;
    prompt.style.maxHeight = `${PROMPT_MAX_HEIGHT}px`;
    prompt.style.overflowY = "auto";
    prompt.addEventListener("input", () => {
        entry.prompt = prompt.value;
        saveBoard(node, board);
        fitPromptEditor(node, prompt);
    });
    // A manually resized prompt keeps that height when another clip is selected.
    prompt.addEventListener("pointerup", () => rememberPromptHeight(node, prompt));
    ui.promptInput = prompt;
    const promptWrap = labeledInput("Complete prompt for this clip", prompt);
    promptWrap.style.flex = "1 0 auto";
    ui.editor.append(heading, audioPanel, row, promptWrap);
    fitPromptEditor(node, prompt);
}

function refreshDirector(node, force = false) {
    const ui = node._h3DirectorUI;
    if (!ui) return;
    const filename = songFilename(node);
    const filenameWidget = widget(node, "song_filename");
    if (filenameWidget && filenameWidget.value !== filename) filenameWidget.value = filename;
    const clipSeconds = numericSetting(node, "clip_seconds", 7);
    const contextFrames = numericSetting(node, "context_frames", 0);
    const board = parseBoard(node);
    const settingsKey = JSON.stringify({
        filename,
        clipSeconds,
        contextFrames,
        durationOverrides: durationOverridesKey(board),
    });
    if (!force && ui.settingsKey === settingsKey) {
        renderDirector(node);
        return;
    }
    ui.settingsKey = settingsKey;
    if (!filename) {
        ui.clipCount = 0;
        ui.duration = 0;
        ui.timeline = [];
        ui.status.textContent = "Select or upload a song in the connected Load Audio node.";
        renderDirector(node, true);
        return;
    }
    const applyDuration = (duration) => {
        if (ui.settingsKey !== settingsKey) return;
        ui.duration = duration;
        ui.timeline = timelinePlan(duration, clipSeconds, contextFrames, board, isSimpleDirector(node));
        if (isSimpleDirector(node)) {
            // New clips start at seven requested seconds, then persist their own
            // duration. There is no shared timing control or inherited duration.
            for (const segment of ui.timeline) {
                const entry = ensureClip(board, segment.index);
                if (!(Number(entry.seconds) > 0)) entry.seconds = segment.requestedSeconds;
            }
            saveBoard(node, board);
        }
        ui.clipCount = ui.timeline.length;
        const selectedWidget = widget(node, "selected_clip");
        const selected = Math.max(1, Math.min(ui.clipCount, Math.trunc(Number(selectedWidget?.value) || 1)));
        if (selectedWidget && Number(selectedWidget.value) !== selected) selectedWidget.value = selected;
        ui.selected = new Set([...ui.selected].filter((value) => value >= 1 && value <= ui.clipCount));
        if (!ui.selected.size) ui.selected.add(selected);
        const overrideCount = durationOverridesKey(board).length;
        const globalFrames = h3FrameLength(clipSeconds);
        ui.status.textContent = `${filename} — ${formatTime(duration)} — ${ui.clipCount} clips; global ${clipSeconds.toFixed(2)}s → ${(globalFrames / FPS).toFixed(6)}s H3 (${globalFrames}f)${overrideCount ? `; ${overrideCount} per-clip override${overrideCount === 1 ? "" : "s"}` : ""}`;
        if (isSimpleDirector(node)) {
            ui.status.textContent = `${filename} — ${formatTime(duration)} — ${ui.clipCount} clips; edit each clip's duration below (H3 frame aligned, up to 10 actual seconds).`;
        }
        renderDirector(node, true);
    };
    if (durationCache.has(filename)) {
        applyDuration(durationCache.get(filename));
        return;
    }
    ui.status.textContent = `${filename} — reading duration…`;
    renderDirector(node, true);
    readDuration(filename).then(applyDuration).catch((error) => {
        if (ui.settingsKey !== settingsKey) return;
        ui.status.textContent = `${filename} — duration unavailable (${error.message})`;
        console.warn("H3 Studio Director:", error);
    });
}

function bindDirector(node) {
    if (!isDirector(node)) return;
    directors.add(node);
    buildDirectorUI(node);
    const originalRemoved = node.onRemoved;
    node.onRemoved = function(...args) {
        stopAudioPreview(this._h3DirectorUI);
        directors.delete(this);
        return originalRemoved?.apply(this, args);
    };
    for (const item of node.widgets ?? []) {
        if (item._h3DirectorBeforeQueued) continue;
        item._h3DirectorBeforeQueued = true;
        const original = item.beforeQueued;
        item.beforeQueued = function(...args) {
            refreshDirector(node, true);
            return original?.apply(this, args);
        };
    }
}

app.registerExtension({
    name: "openai.H3MusicVideoStudioDirector",
    async nodeCreated(node) {
        if (isDirector(node)) queueMicrotask(() => bindDirector(node));
    },
    async afterConfigureGraph() {
        for (const node of app.graph?._nodes ?? []) {
            if (isDirector(node)) bindDirector(node);
        }
    },
    async setup() {
        setInterval(() => {
            if (app.canvas?.isDragging) return;
            for (const node of directors) refreshDirector(node);
        }, 500);
    },
});
