import { readFileSync } from "node:fs";
import vm from "node:vm";
import assert from "node:assert/strict";

const source = readFileSync(new URL("../web/h3_studio_director.js", import.meta.url), "utf8").replace(/^import .*;\r?\n/gm, "");
const context = vm.createContext({ app: { registerExtension() {} }, api: {}, console, setTimeout, clearTimeout });
vm.runInContext(source, context);
const evaluate = code => vm.runInContext(code, context);
assert.equal(evaluate("isDirector({type:'MiniMaxH3SimpleDirector'})"), true);
assert.equal(evaluate("isDirector({type:'MiniMaxH3StudioDirector'})"), true);
assert.equal(evaluate("h3FrameLength(10,true)"), 226);
assert.equal(evaluate("h3FrameLength(10,false)"), 243);
evaluate(`
    var song = {widgets:[{name:'audio',value:'song.mp3'}]};
    var graph = {links:{1:{origin_id:1}},getNodeById:id=>song,setDirtyCanvas(){}};
    var node = {type:'MiniMaxH3SimpleDirector',graph,inputs:[{name:'master_audio',link:1}],widgets:[
        {name:'board_data',value:JSON.stringify({version:1,default:{theme:1,prompt:'',seed:11,take:1},clips:{}})},
        {name:'song_filename',value:''},{name:'selected_clip',value:1}],
        _h3DirectorUI:{selected:new Set([1]),status:{},settingsKey:''}};
    renderDirector=()=>{};
    durationCache.set('song.mp3',30);
    refreshDirector(node,true);
`);
assert.equal(evaluate("node._h3DirectorUI.clipCount"), 5);
assert.equal(evaluate("Object.values(parseBoard(node).clips).every(c=>c.seconds===7)"), true);
assert.doesNotMatch(evaluate("node._h3DirectorUI.status.textContent"), /global|override/i);
evaluate(`
    var board=parseBoard(node);
    board.clips['2'].seconds=6;
    board.clips['3'].seconds=8;
    board.clips['3'].prompt='unchanged user text';
    saveBoard(node,board);
    refreshDirector(node,true);
`);
assert.equal(evaluate("node._h3DirectorUI.timeline[2].start"), 316/24);
assert.equal(evaluate("node._h3DirectorUI.timeline[2].frames"), 192);
assert.equal(evaluate("parseBoard(node).clips['3'].prompt"), "unchanged user text");
assert.equal(evaluate("parseBoard(node).clips['1'].seconds"), 7);
evaluate(`
    board=parseBoard(node);
    for (const clip of Object.values(board.clips)) clip.seconds=1;
    saveBoard(node,board);
    refreshDirector(node,true);
`);
assert.ok(evaluate("node._h3DirectorUI.clipCount") > 5);
assert.equal(evaluate("Object.values(parseBoard(node).clips).every(c=>Number(c.seconds)>0)"), true);
assert.equal(evaluate("parseBoard(node).clips['6'].seconds"), 7);
assert.equal(evaluate("parseBoard(node).clips['3'].prompt"), "unchanged user text");
console.log("Simple Director: explicit durations persist, edits shift later intervals, new clips get individual values, prompts survive, 10-second memory limit is respected.");
