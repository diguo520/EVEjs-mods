#!/usr/bin/env node
/**
 * 维护者审核工具（收录 / 拒绝 / 下架 / 恢复）。
 *
 * 审核结果写在 moderation.json，build-index.mjs 会读它：
 *   - action=reject → 该来源/条目**不进索引**（拒绝收录），原因照样发布到索引里，作者在启动器「我创建的」能看到；
 *   - action=delist → 条目仍进索引但标记 delisted（从市场下架），启动器市场显示「已下架」并禁止安装，作者也能看到原因。
 *
 * 用法：
 *   node scripts/moderate.mjs list                        # 看当前收录与审核状态
 *   node scripts/moderate.mjs approve <owner/repo>        # 收录通过（写进 sources.json）
 *   node scripts/moderate.mjs reject <id|owner/repo> --zh "原因" --en "reason"
 *   node scripts/moderate.mjs delist <id|owner/repo> --zh "原因" --en "reason"
 *   node scripts/moderate.mjs restore <id|owner/repo>     # 撤销审核结果
 *   node scripts/moderate.mjs pr-text <id|owner/repo>     # 生成可直接贴到 PR 的中英双语说明
 *
 * 加 --by <署名> 可改署名，默认 diguo520。
 * 改完记得重新构建索引并推送：node scripts/build-index.mjs && git commit/push
 */
import fs from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const SOURCES_FILE = path.join(ROOT, "sources.json");
const MODERATION_FILE = path.join(ROOT, "moderation.json");

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}
function writeJson(file, value) {
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + "\n", "utf8");
}
function readSources() {
  const data = readJson(SOURCES_FILE, { schemaVersion: 1, sources: [] });
  const list = Array.isArray(data.sources) ? data.sources : [];
  return { data, list: list.filter((x) => typeof x === "string" && x.trim()).map((x) => x.trim()) };
}
function readModeration() {
  const data = readJson(MODERATION_FILE, { schemaVersion: 1, updatedAt: "", entries: [] });
  if (!Array.isArray(data.entries)) data.entries = [];
  return data;
}
function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("--")) { flags[key] = next; i++; }
      else flags[key] = true;
    } else positional.push(a);
  }
  return { positional, flags };
}
function kindOf(target, flags) {
  if (flags.kind === "id" || flags.kind === "source") return flags.kind;
  return String(target).includes("/") ? "source" : "id";
}
function upsertEntry(target, kind, action, flags) {
  const data = readModeration();
  const zh = String(flags.zh || "").trim();
  const en = String(flags.en || zh).trim();
  if (!zh) {
    console.error("必须给拒绝/下架原因：--zh \"中文原因\"（--en 可选，缺省沿用中文）");
    process.exit(2);
  }
  const entry = {
    target: String(target).trim(),
    kind,
    action,
    reason: { zh, en },
    at: new Date().toISOString(),
    by: String(flags.by || "diguo520")
  };
  const rest = data.entries.filter((e) => !(e && String(e.target).toLowerCase() === entry.target.toLowerCase() && (e.kind || "id") === kind));
  rest.push(entry);
  data.entries = rest;
  data.schemaVersion = 1;
  data.updatedAt = entry.at;
  writeJson(MODERATION_FILE, data);
  return entry;
}
function removeEntry(target, kind) {
  const data = readModeration();
  const before = data.entries.length;
  data.entries = data.entries.filter((e) => !(e && String(e.target).toLowerCase() === String(target).toLowerCase() && (e.kind || "id") === kind));
  data.updatedAt = new Date().toISOString();
  writeJson(MODERATION_FILE, data);
  return before - data.entries.length;
}

const { positional, flags } = parseArgs(process.argv.slice(2));
const cmd = positional[0] || "list";

if (cmd === "list") {
  const { list } = readSources();
  const mod = readModeration();
  console.log("== 收录来源 (" + list.length + ") ==");
  for (const repo of list) {
    const rule = mod.entries.find((e) => (e.kind === "source") && String(e.target).toLowerCase() === repo.toLowerCase());
    console.log("  " + (rule ? (rule.action === "reject" ? "[已拒绝] " : "[已下架] ") : "[正常] ") + repo +
      (rule ? "  ← " + (rule.reason && rule.reason.zh ? rule.reason.zh : "") : ""));
  }
  const idRules = mod.entries.filter((e) => (e.kind || "id") === "id");
  console.log("== 模组级审核 (" + idRules.length + ") ==");
  for (const e of idRules) console.log("  " + (e.action === "reject" ? "[拒绝] " : "[下架] ") + e.target + "  ← " + (e.reason && e.reason.zh ? e.reason.zh : ""));
  if (!idRules.length) console.log("  （无）");
  process.exit(0);
}

if (cmd === "approve") {
  const repo = String(positional[1] || "").replace(/\s+/g, "").trim();
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) {
    console.error("用法：node scripts/moderate.mjs approve <owner/repo>");
    process.exit(2);
  }
  const { data, list } = readSources();
  if (!list.includes(repo)) list.push(repo);
  data.schemaVersion = 1;
  data.sources = list;
  writeJson(SOURCES_FILE, data);
  removeEntry(repo, "source");   // 收录通过就撤销之前的拒绝
  console.log("已收录：" + repo + "（sources.json 现有 " + list.length + " 个来源）");
  console.log("接下来：node scripts/build-index.mjs → git commit/push");
  process.exit(0);
}

if (cmd === "reject" || cmd === "delist") {
  const target = String(positional[1] || "").trim();
  if (!target) { console.error("用法：node scripts/moderate.mjs " + cmd + " <id|owner/repo> --zh \"原因\" [--en \"reason\"]"); process.exit(2); }
  const kind = kindOf(target, flags);
  const entry = upsertEntry(target, kind, cmd, flags);
  console.log((cmd === "reject" ? "已拒绝收录" : "已下架") + "：" + entry.target + "（" + kind + "）—— " + entry.reason.zh);
  if (cmd === "reject" && kind === "source") {
    const { data, list } = readSources();
    data.sources = list.filter((x) => x.toLowerCase() !== target.toLowerCase());
    writeJson(SOURCES_FILE, data);
    console.log("同时已把它从 sources.json 移除");
  }
  console.log("接下来：node scripts/build-index.mjs → git commit/push");
  process.exit(0);
}

if (cmd === "restore") {
  const target = String(positional[1] || "").trim();
  if (!target) { console.error("用法：node scripts/moderate.mjs restore <id|owner/repo>"); process.exit(2); }
  const kind = kindOf(target, flags);
  const n = removeEntry(target, kind);
  console.log(n ? "已撤销审核结果：" + target : "没有找到审核记录：" + target);
  console.log("接下来：node scripts/build-index.mjs → git commit/push");
  process.exit(0);
}

if (cmd === "pr-text") {
  const target = String(positional[1] || "").trim();
  const data = readModeration();
  const entry = data.entries.find((e) => String(e.target).toLowerCase() === target.toLowerCase());
  if (!entry) { console.error("没有找到审核记录，先跑 reject/delist 再生成文案"); process.exit(2); }
  const zh = entry.reason.zh || "";
  const en = entry.reason.en || zh;
  const actionZh = entry.action === "reject" ? "暂时不收录" : "已下架";
  const actionEn = entry.action === "reject" ? "not accepted for listing" : "delisted";
  console.log("--- 直接贴到 PR / Issue 的回复 ---");
  console.log("感谢提交！这个模组" + actionZh + "。\n\n原因：" + zh + "\n\n改好后重新提交即可，我们会重新审核。\n\n---\nThanks for the submission. This mod is " + actionEn + ".\n\nReason: " + en + "\n\nFix it and resubmit and we will review again.");
  process.exit(0);
}

console.error("未知命令：" + cmd);
console.error("可用：list | approve | reject | delist | restore | pr-text");
process.exit(2);
