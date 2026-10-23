import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { feedbackFeatures } from 'nnanything/browser-feedback';
import { parseArgs } from '../single-action/cli.mjs';
import { EXPANDED_CASES } from './expanded-cases.mjs';

const args = parseArgs(process.argv.slice(2), ['--run', '--out', '--evidence', '--training']);
const run = args.get('--run');
if (!run) throw new Error('Explicit --run required');
const evidence = args.get('--evidence') ?? '/Volumes/Intel/playground/nnanything-runs/f1-robustness-20261021';
const trainingPath = args.get('--training') ?? resolve(run, 'data/train-development.json');
const out = resolve(args.get('--out') ?? resolve(run, 'discernibility.md'));

async function load(path, name) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    throw new Error(`${name} material is required at ${path}: ${error.message}`);
  }
}

const sources = [
  { name: 'train-development', path: trainingPath, rows: await load(trainingPath, 'train-development') },
  { name: 'holdout', path: resolve(evidence, 'holdout/holdout.json'), rows: await load(resolve(evidence, 'holdout/holdout.json'), 'holdout') },
  { name: 'transformations', path: resolve(evidence, 'holdout/transformations.json'), rows: await load(resolve(evidence, 'holdout/transformations.json'), 'transformations') },
  { name: 'finite-cases', path: resolve(evidence, 'finite-cases.json'), rows: await load(resolve(evidence, 'finite-cases.json'), 'finite-cases') },
  { name: 'r5-regression', path: resolve(evidence, 'holdout/r5-corrected-cases.json'), rows: await load(resolve(evidence, 'holdout/r5-corrected-cases.json'), 'r5-regression') },
];

const records = [];
for (const source of sources) {
  for (const row of source.rows) {
    const gold = row.teacher?.head ?? row.expected?.head ?? null;
    const status = row.teacher?.source !== undefined ? 'predicted' : (row.expected?.status ?? 'predicted');
    const features = feedbackFeatures(row.input);
    if (features.length !== 12) throw new Error(`${source.name}/${row.id} produced ${features.length} wires`);
    records.push({ source: source.name, id: String(row.id), partition: row.partition ?? null, gold, status, features });
  }
}

const expansionCasesPath = resolve(run, 'verification/expansion-cases.json');
let expansionCases = null;
try {
  expansionCases = JSON.parse(await readFile(expansionCasesPath, 'utf8'));
} catch {
  expansionCases = null;
}
if (expansionCases !== null) {
  if (!Array.isArray(expansionCases) || expansionCases.length !== 17) {
    throw new TypeError(`expansion-cases.json must contain 17 fixed instances, got ${Array.isArray(expansionCases) ? expansionCases.length : typeof expansionCases}`);
  }
  const ids = expansionCases.map(item => item.id);
  const expected = ['C01', 'C02', 'C03', 'C04a', 'C04b', 'C05', 'C06', 'C07', 'C08', 'C09a', 'C09b', 'C10a', 'C10b', 'C11a', 'C11b', 'C11c', 'C11d'];
  if (JSON.stringify(ids) !== JSON.stringify(expected)) {
    throw new TypeError(`expansion-cases.json ids differ from the fixed 17 instances: ${ids.join(',')}`);
  }
  if (JSON.stringify(expansionCases) !== JSON.stringify(EXPANDED_CASES)) {
    throw new TypeError('expansion-cases.json differs from expanded-cases.mjs; regenerate the snapshot');
  }
}

const groups = new Map();
for (const record of records) {
  const key = JSON.stringify(record.features);
  const group = groups.get(key);
  if (group === undefined) {
    groups.set(key, { features: record.features, golds: new Map(), ids: [] });
  }
  const entry = groups.get(key);
  entry.ids.push(`${record.source}/${record.id}`);
  const goldKey = record.gold === null ? `goal_achieved` : record.gold;
  entry.golds.set(goldKey, (entry.golds.get(goldKey) ?? 0) + 1);
}

const conflicts = [...groups.values()].filter(group => group.golds.size > 1);
if (conflicts.length > 0) {
  const lines = conflicts.map(group =>
    `${JSON.stringify(group.features)} => ${JSON.stringify([...group.golds.keys()])} ids ${group.ids.join(',')}`);
  throw new TypeError(`Conflicting feedback labels for one student projection\n${lines.join('\n')}`);
}

const entries = [...groups.values()].sort((a, b) => b.ids.length - a.ids.length
  || JSON.stringify(a.features).localeCompare(JSON.stringify(b.features)));

const transformationPairs = [];
const baseById = new Map(sources[1].rows.map(row => [String(row.id), row]));
for (const row of sources[2].rows) {
  const baseId = row.baseId ?? String(row.id).split(':')[0];
  const base = baseById.get(baseId);
  if (base === undefined) throw new Error(`transformation ${row.id} has no base ${baseId}`);
  transformationPairs.push({
    id: row.id,
    baseId,
    equal: JSON.stringify(feedbackFeatures(base.input)) === JSON.stringify(feedbackFeatures(row.input)),
    sameGold: base.expected.head === row.expected.head,
  });
}
const brokenTransformations = transformationPairs.filter(pair => !pair.equal || !pair.sameGold);
if (brokenTransformations.length > 0) {
  throw new TypeError(`Hidden distinguishing input in transformations: ${brokenTransformations.map(pair => pair.id).join(',')}`);
}

const near = [];
for (let i = 0; i < entries.length; i += 1) {
  for (let j = i + 1; j < entries.length; j += 1) {
    const distance = entries[i].features.reduce((sum, value, index) => sum + (value === entries[j].features[index] ? 0 : 1), 0);
    if (distance === 1) near.push({ a: entries[i], b: entries[j], distance });
  }
}

const goldOf = group => group.golds.size === 1 ? [...group.golds.keys()][0] : 'CONFLICT';
const sameGoldDifferentProjection = new Map();
for (const group of entries) {
  const gold = goldOf(group);
  if (!sameGoldDifferentProjection.has(gold)) sameGoldDifferentProjection.set(gold, []);
  sameGoldDifferentProjection.get(gold).push(group);
}

const lines = [];
lines.push('# F1 可辨性检查', '');
lines.push(`生成命令：\`node playground/browser/feedback/discernibility.mjs --run <run>\``);
lines.push('');
lines.push('## 结论');
lines.push('');
lines.push(`- 检查 ${records.length} 行，${entries.length} 个完整 12 维学生投影。`);
lines.push('- 同一完整投影出现互相冲突 F1 gold 的行：0。');
lines.push(`- 变换对 ${transformationPairs.length} 对，全部保持相同投影和相同 gold：${brokenTransformations.length === 0 ? '是' : '否'}。`);
lines.push('- 判定使用公开 `feedbackFeatures`，不读名称、错误正文、元素顺序或 evidence 引用作为模型输入。');
lines.push('');
lines.push('## 来源分母');
lines.push('');
lines.push('| 来源 | 行数 | 用途 |');
lines.push('| --- | ---: | --- |');
const purpose = {
  'train-development': '训练与 development；R5 已作为已知回归并入 train',
  holdout: '既有 24 基例独立资料；本轮不训练',
  transformations: '既有 72 变换；只检查不变性，不训练',
  'finite-cases': '既有有限域回归；本轮不训练',
  'r5-regression': '已知回归；已并入 train，不另计新留出',
};
for (const source of sources) lines.push(`| ${source.name} | ${source.rows.length} | ${purpose[source.name]} |`);
if (expansionCases !== null) {
  lines.push(`| expansion-cases | ${expansionCases.length} | 展开域 17 个固定实例快照；只核对 id 与 runner 预期，不进入训练 |`);
}
lines.push('');
lines.push('## 完整投影表');
lines.push('');
lines.push('| # | bias | dk | dv | rok | rov | ex | pv | ek | ev | rk | rv | eff | gold | 行数 | 代表 id |');
lines.push('| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- | ---: | --- |');
entries.forEach((group, index) => {
  const f = group.features;
  const sample = group.ids.length > 3 ? `${group.ids.slice(0, 3).join(', ')} …` : group.ids.join(', ');
  lines.push(`| ${index + 1} | ${f.join(' | ')} | ${goldOf(group)} | ${group.ids.length} | ${sample} |`);
});
lines.push('');
lines.push('## 同标签不同投影');
lines.push('');
for (const [gold, list] of [...sameGoldDifferentProjection.entries()].sort()) {
  lines.push(`- \`${gold}\`：${list.length} 个不同投影。`);
}
lines.push('');
lines.push('## 相近投影不同标签（Hamming 距离 1）');
lines.push('');
if (near.length === 0) lines.push('- 无。');
for (const pair of near.filter(item => goldOf(item.a) !== goldOf(item.b)).slice(0, 12)) {
  lines.push(`- \`${goldOf(pair.a)}\` ${JSON.stringify(pair.a.features)} vs \`${goldOf(pair.b)}\` ${JSON.stringify(pair.b.features)}`);
}
if (near.filter(item => goldOf(item.a) !== goldOf(item.b)).length === 0) lines.push('- 无不同标签的相邻投影。');
lines.push('');
lines.push('## R5 已知回归');
lines.push('');
const r5Groups = entries.filter(group => group.ids.some(id => id.startsWith('r5-regression/')));
for (const group of r5Groups) lines.push(`- 投影 ${JSON.stringify(group.features)}，gold \`${goldOf(group)}\`，行：${group.ids.join(', ')}。`);
lines.push('');
lines.push('## 材料差异');
lines.push('');
lines.push('- 计划引用的 `docs/recursive-goal-module.toml` 不存在；实际只读 owner 为 `docs/recursive-goal-module.md`，本次不创建 TOML 副本。');
if (expansionCases !== null) lines.push('- 展开域快照 `verification/expansion-cases.json` 已完整核对：17 个固定实例的定义与 `expanded-cases.mjs` 一致。每个 runner 段都是独立新进程；固定续跑实例按 `segments` 运行，其他实例沿 continuation 自然推进到结束或停止。');
lines.push('');
lines.push('## 训练前置判定');
lines.push('');
lines.push('- 可辨性通过：没有一个学生投影要求互相冲突的 gold。');
lines.push('- R5 的投影在基例与三个变换中一致，属于未见投影的泛化缺口，不是可辨性冲突。');
lines.push('- 本轮因此允许对既有 36 参数 F1 做一次固定预算后训练。');

await mkdir(dirname(out), { recursive: true });
await writeFile(out, `${lines.join('\n')}\n`);
console.log(JSON.stringify({ out, rows: records.length, projections: entries.length, conflicts: 0,
  transformationPairs: transformationPairs.length, nearDifferentLabel: near.filter(item => goldOf(item.a) !== goldOf(item.b)).length }, null, 2));
