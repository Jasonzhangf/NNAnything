#!/usr/bin/env node
// 版本 bumper：只改版本号最后一段，并同步 graph 的 operator_version 与 NodeDefinition.version。
// 版本升级必须走本脚本，禁止手改，避免图、算子、节点定义漂移。
//
// 用法：
//   node scripts/bump-version.mjs                    # 干跑：两张 CLI 图最后一段 +1
//   node scripts/bump-version.mjs --write            # 落盘
//   node scripts/bump-version.mjs --to 0.3.0 --write # 显式设到某个版本（不推导）
//   node scripts/bump-version.mjs --sync --write     # 不升版：把 lib/nodes 版本对齐到图
//   node scripts/bump-version.mjs --segments 3 --write
//   node scripts/bump-version.mjs workflows/a.graph.json --write
//
// 规则：
// - 默认只升最后一段：0.3.0 → 0.3.1；0.3.0.4 → 0.3.0.5。
// - 文本替换，不重排 JSON，保证 diff 只落在版本行。
// - 不重写 docs 正文；只列出仍引用旧版本号的文件，由作者判断。
import { readFileSync, writeFileSync, readdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const defaultGraphs = ["workflows/cli-file-property.graph.json", "workflows/cli-filesystem-training.graph.json"];

const argv = process.argv.slice(2);
const write = argv.includes("--write");
const sync = argv.includes("--sync");
const segmentsFlag = argv.indexOf("--segments");
const bumpSegment = segmentsFlag >= 0 ? Number(argv[segmentsFlag + 1]) : null;
const toFlag = argv.indexOf("--to");
const explicitVersion = toFlag >= 0 ? argv[toFlag + 1] : null;
const valueFlags = new Set(["--segments", "--to"]);
const graphArgs = argv.filter((value, index) => !value.startsWith("--") && !valueFlags.has(argv[index - 1]));
const graphs = graphArgs.length > 0 ? graphArgs : defaultGraphs;

if (bumpSegment !== null && (!Number.isInteger(bumpSegment) || bumpSegment < 1)) {
  console.error("--segments 需要正整数，例如 --segments 3");
  process.exit(2);
}
if (explicitVersion !== null && !/^\d+(\.\d+)+$/.test(explicitVersion)) {
  console.error(`--to 需要点分数字版本，例如 --to 0.3.0；收到 ${explicitVersion}`);
  process.exit(2);
}

// 尾段固定四位计数：MAJOR.MINOR.PATCH.NNNN，每次只把最后一段加 1。
const TAIL_DIGITS = 4;

function normalize(version) {
  const parts = version.split(".");
  if (!parts.every(part => /^\d+$/.test(part))) throw new Error(`版本不是纯数字分段：${version}`);
  while (parts.length < 4) parts.push("0");
  parts[parts.length - 1] = parts[parts.length - 1].padStart(TAIL_DIGITS, "0");
  return parts.join(".");
}

function bump(version) {
  const parts = normalize(version).split(".");
  const index = bumpSegment === null ? parts.length - 1 : bumpSegment - 1;
  if (index < 0 || index >= parts.length) throw new Error(`${version} 没有第 ${bumpSegment} 段`);
  const width = index === parts.length - 1 ? TAIL_DIGITS : 0;
  const next = Number(parts[index]) + 1;
  if (width > 0 && String(next).length > width) throw new Error(`尾段计数溢出 ${TAIL_DIGITS} 位：${version}`);
  parts[index] = width > 0 ? String(next).padStart(width, "0") : String(next);
  return parts.join(".");
}

// 文本替换版本值，保留原文件排版（紧凑或展开都不改）。
function replaceVersionValue(text, key, was, now) {
  const pattern = new RegExp(`("${key}"\\s*:\\s*")${was.replace(/\./g, "\\.")}(")`, "g");
  return text.replace(pattern, `$1${now}$2`);
}

const nodeDir = join(root, "lib", "nodes");
const nodeFiles = readdirSync(nodeDir).filter(name => name.endsWith(".ts")).map(name => join("lib", "nodes", name));
const nodeSources = new Map(nodeFiles.map(file => [file, readFileSync(join(root, file), "utf8")]));

const summary = [];
const nodeUpdates = [];
const docRefs = [];

for (const graphFile of graphs) {
  const path = join(root, graphFile);
  if (!existsSync(path)) {
    console.error(`找不到图：${graphFile}`);
    process.exit(2);
  }
  const text = readFileSync(path, "utf8");
  const graph = JSON.parse(text);
  const was = graph.version;
  const now = sync ? was : (explicitVersion ?? bump(was));
  const operators = Array.isArray(graph.nodes) ? graph.nodes : [];
  const operatorWas = operators.map(node => node.operator_version);
  const stale = operatorWas.filter(version => version !== now).length;

  let next = text;
  if (!sync && now !== was) {
    next = replaceVersionValue(next, "version", was, now);
    next = replaceVersionValue(next, "operator_version", was, now);
  }

  summary.push({
    graph: graphFile,
    was,
    now,
    operators: operators.length,
    operatorVersionsUpdated: sync ? 0 : stale,
  });

  // recursive-goal owns its definitions in a shared runtime factory, not lib/nodes.
  if (graph.id === "recursive-goal") {
    const file = "lib/workflow/recursive-goal/module.ts";
    const source = readFileSync(join(root, file), "utf8");
    const match = /const OPERATOR_VERSION = "([^"]+)";/.exec(source);
    if (match === null) throw new Error(`找不到 ${file} 的共享算子版本`);
    if (match[1] !== now) {
      nodeUpdates.push({file, operator: "goal.recursive.*", was: match[1], now});
      nodeSources.set(file, source.replace(match[0], `const OPERATOR_VERSION = "${now}";`));
    }
  }

  // NodeDefinition.version 按 operator id 在其定义块内同步。
  // 支持两种写法：显式 `operator: "x.y.z"`，以及共享工厂的模板串 `operator: \`x.y.${name}\``。
  for (const node of operators) {
    const operator = node.operator;
    const templatePrefix = operator.slice(0, operator.lastIndexOf("."));
    for (const [file, source] of nodeSources) {
      const exactIndex = source.indexOf(`operator: "${operator}"`);
      const operatorIndex = exactIndex >= 0 ? exactIndex : source.indexOf(`operator: \`${templatePrefix}.\${`);
      if (operatorIndex < 0) continue;
      const versionMatch = /version:\s*"([^"]+)"/.exec(source.slice(operatorIndex));
      if (!versionMatch) continue;
      const current = versionMatch[1];
      if (current === now) continue;
      nodeUpdates.push({ file, operator, was: current, now });
      if (!write) continue;
      const start = operatorIndex + versionMatch.index;
      nodeSources.set(file, `${source.slice(0, start)}version: "${now}"${source.slice(start + versionMatch[0].length)}`);
    }
  }

  if (write && next !== text) writeFileSync(path, next);

  for (const dir of ["docs", "workflows"]) {
    for (const name of readdirSync(join(root, dir))) {
      if (!/\.(md|json)$/.test(name) || name.endsWith(".graph.json")) continue;
      if (readFileSync(join(root, dir, name), "utf8").includes(was)) docRefs.push(`${dir}/${name}`);
    }
  }
}

if (write) {
  for (const [file, source] of nodeSources) {
    if (source !== readFileSync(join(root, file), "utf8")) writeFileSync(join(root, file), source);
  }
}

console.log(JSON.stringify({
  mode: write ? "write" : "dry-run",
  action: sync ? "sync-node-definitions" : "bump",
  bumpedSegment: sync ? null : (explicitVersion ? null : (bumpSegment ?? "last")),
  graphs: summary,
  nodeDefinitions: nodeUpdates,
  docsStillMentioningOldVersion: [...new Set(docRefs)],
}, null, 2));

if (!write) console.log("\n干跑：未写文件。加 --write 落盘。");
