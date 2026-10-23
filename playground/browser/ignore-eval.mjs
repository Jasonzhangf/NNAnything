// Read-only evaluation of a candidate profile against the gold-357 replay set and
// the Weibo-152 unknown rows. Usage:
//   node playground/browser/ignore-eval.mjs --gold <dir> --weibo <file> --profile default|<weightfile>
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { classifyBasicKind, DEFAULT_BASIC_KIND_CONFIG, DEFAULT_BASIC_KIND_PROFILE } from "nnanything/browser";
import { parseBrowserWeightAsset } from "nnanything/browser-classify";

const args = new Map();
for (let i = 2; i < process.argv.length; i += 2) args.set(process.argv[i], process.argv[i + 1]);

async function loadProfile(spec) {
  if (spec === "default") return structuredClone(DEFAULT_BASIC_KIND_PROFILE);
  const raw = JSON.parse(await readFile(resolve(spec), "utf8"));
  return parseBrowserWeightAsset(raw, spec).profile;
}

const profileA = await loadProfile(args.get("--profile-a"));
const profileB = await loadProfile(args.get("--profile-b"));
const classifyA = properties => classifyBasicKind(properties, DEFAULT_BASIC_KIND_CONFIG, profileA);
const classifyB = properties => classifyBasicKind(properties, DEFAULT_BASIC_KIND_CONFIG, profileB);

async function loadGold(dir) {
  const existing = JSON.parse(await readFile(resolve(dir, "reviewed-existing.json"), "utf8"));
  const unseen = JSON.parse(await readFile(resolve(dir, "unseen/reviewed-unseen.json"), "utf8"));
  return [...existing.rows, ...unseen.rows]
    .filter(row => row.review.status === "verified")
    .map(row => ({ sampleId: row.sampleId, sourceFile: row.sampleId.startsWith("weibo") ? "unseen" : "existing", expectedLabel: row.review.expectedLabel, properties: row.properties }));
}

const gold = await loadGold(resolve(args.get("--gold")));

const goldOut = gold.map(row => {
  const a = classifyA(row.properties);
  const b = classifyB(row.properties);
  return {
    sampleId: row.sampleId,
    expectedLabel: row.expectedLabel,
    old: { judgmentStatus: a.judgmentStatus, basicKind: a.basicKind },
    new: { judgmentStatus: b.judgmentStatus, basicKind: b.basicKind, score: b.score, margin: b.margin, family: b.family },
    changed: a.basicKind !== b.basicKind || a.judgmentStatus !== b.judgmentStatus,
    falseIgnore: row.expectedLabel !== "ignore" && b.basicKind === "ignore",
    oldFalseIgnore: row.expectedLabel !== "ignore" && a.basicKind === "ignore",
    ignoreRecalled: row.expectedLabel === "ignore" && b.basicKind === "ignore",
  };
});

const weibo = JSON.parse(await readFile(resolve(args.get("--weibo")), "utf8")).rows;
const proposals = JSON.parse(await readFile(resolve(args.get("--teacher")), "utf8")).rows;
const byRef = new Map(proposals.map(row => [row.nodeRef, row.proposal]));
const weiboOut = weibo.map(row => {
  const a = classifyA(row.properties);
  const judgment = classifyB(row.properties);
  return {
    nodeRef: row.nodeRef,
    proposal: byRef.get(row.nodeRef),
    old: { judgmentStatus: a.judgmentStatus, basicKind: a.basicKind },
    changed: a.basicKind !== judgment.basicKind || a.judgmentStatus !== judgment.judgmentStatus,
    judgmentStatus: judgment.judgmentStatus,
    basicKind: judgment.basicKind,
    score: judgment.score,
    reasons: judgment.reasons,
  };
});
const count = (rows, predicate) => rows.filter(predicate).length;
const summary = {
  profileA: args.get("--profile-a"),
  profileB: args.get("--profile-b"),
  gold: {
    total: goldOut.length,
    changed: count(goldOut, row => row.changed === true),
    falseIgnore: count(goldOut, row => row.falseIgnore),
    ignoreRecalled: count(goldOut, row => row.ignoreRecalled),
    changedRows: goldOut.filter(row => row.changed === true).map(row => ({ sampleId: row.sampleId, expectedLabel: row.expectedLabel, old: row.old, new: row.new })),
  },
  weibo: {
    total: weiboOut.length,
    ignoreProposals: count(weiboOut, row => row.proposal === "ignore"),
    ignoreRecalled: count(weiboOut, row => row.proposal === "ignore" && row.basicKind === "ignore"),
    retainProposals: count(weiboOut, row => row.proposal === "retain"),
    retainFalseIgnore: count(weiboOut, row => row.proposal === "retain" && row.basicKind === "ignore"),
    ambiguousProposals: count(weiboOut, row => row.proposal === "ambiguous"),
    ambiguousJudgedIgnore: count(weiboOut, row => row.proposal === "ambiguous" && row.basicKind === "ignore"),
    judged: count(weiboOut, row => row.judgmentStatus === "judged"),
    changed: count(weiboOut, row => row.changed),
  },
  rows: { gold: goldOut, weibo: weiboOut },
};
console.log(JSON.stringify(summary));
