#!/usr/bin/env node
/**
 * 把 sources.json 里登记的每个作者仓库的 evejs-mod.json 抓下来，合并成一份
 * **签名过的** mod-index.json，输出到 docs/（GitHub Pages 从这里发布）。
 *
 * 用法：  INDEX_SIGNING_KEY="<PKCS8 PEM>" node scripts/build-index.mjs
 * 依赖：  无（只用 node 内置模块）
 *
 * 归属三原则（防"改署名/抢注"，见 launcher 的 docs/mod-signing-and-marketplace-plan.md §7.6）：
 *   1. id 全局唯一、先到先得 —— 同一个 id 只有 sources.json 里**第一次**出现的那个仓库能更新它
 *   2. author.id ↔ 公钥绑定 —— 同一个 author.id 第一次用哪把 keyId，之后就只能是那把（记在 author-keys.json）
 *   3. 来源可见 —— 每条写进 source 字段（owner/repo），客户端会展示
 * 不合格的条目会被**跳过并打印**，不会污染索引；其余条目照常发布。
 *
 * 维护者审核（moderation.json，见 scripts/moderate.mjs）：
 *   action=reject → 该条目/来源**不进索引**（拒绝收录），拒绝原因照样发布，作者在启动器里能看到；
 *   action=delist → 条目仍进索引但标记 delisted（从市场下架），客户端显示「已下架」并禁止安装。
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const ROOT = process.cwd();
const SOURCES_FILE = path.join(ROOT, "sources.json");
const AUTHOR_KEYS_FILE = path.join(ROOT, "author-keys.json");
const MODERATION_FILE = path.join(ROOT, "moderation.json");
const OUT_DIR = path.join(ROOT, "docs");
const OUT_FILE = path.join(OUT_DIR, "mod-index.json");
const LISTING_NAME = "evejs-mod.json";
const FETCH_TIMEOUT_MS = 15000;

function sortKeysDeep(value) {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value && typeof value === "object") {
    const out = {};
    for (const key of Object.keys(value).sort()) out[key] = sortKeysDeep(value[key]);
    return out;
  }
  return value;
}

/** 与启动器 modSigner.canonicalManifestJson 完全一致：去掉 signature 后按 key 升序序列化 */
function canonicalJson(obj) {
  const { signature: _omit, ...rest } = obj;
  return JSON.stringify(sortKeysDeep(rest));
}

function keyIdFromRaw(raw) {
  return crypto.createHash("sha256").update(raw).digest("hex").slice(0, 12);
}

/**
 * 取默认分支最新 commit SHA。
 * 为什么要它：jsDelivr 对「分支引用」(@main) 有最长约 12 小时缓存，作者刚发新版时
 * 索引会抓到旧清单（实测踩过：索引里留着已删除的旧版本地址 → 用户安装 404）。
 * 用 @<commit-sha> 是每个 commit 一个不可变地址，CDN 缓存命中的也是当前版本。
 */
async function fetchHeadSha(repo) {
  const token = process.env.GH_API_TOKEN || process.env.GITHUB_TOKEN || "";
  const headers = { "User-Agent": "EveJS-mods-index", Accept: "application/vnd.github+json" };
  if (token) headers.Authorization = "Bearer " + token;
  try {
    const res = await fetch("https://api.github.com/repos/" + repo + "/commits?per_page=1", {
      headers,
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
    });
    if (!res.ok) return "";
    const list = await res.json();
    return Array.isArray(list) && list[0] && typeof list[0].sha === "string" ? list[0].sha : "";
  } catch {
    return "";
  }
}

/** 兜底：直接问 GitHub API 要清单内容（完全无 CDN 缓存） */
async function fetchListingViaApi(repo) {
  const token = process.env.GH_API_TOKEN || process.env.GITHUB_TOKEN || "";
  const headers = { "User-Agent": "EveJS-mods-index", Accept: "application/vnd.github.raw" };
  if (token) headers.Authorization = "Bearer " + token;
  try {
    const res = await fetch("https://api.github.com/repos/" + repo + "/contents/" + LISTING_NAME, {
      headers,
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
    });
    if (!res.ok) return { ok: false, reason: "HTTP " + res.status };
    return { ok: true, data: JSON.parse(await res.text()) };
  } catch (e) {
    return { ok: false, reason: e && e.message ? e.message : String(e) };
  }
}

async function fetchJson(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { headers: { "User-Agent": "EveJS-mods-index" }, signal: controller.signal });
    if (!res.ok) return { ok: false, reason: "HTTP " + res.status };
    return { ok: true, data: await res.json() };
  } catch (e) {
    return { ok: false, reason: e?.name === "AbortError" ? "超时" : String(e && e.message ? e.message : e) };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 统计一个仓库所有 Release 资产的下载次数（GitHub 官方计数，含重复下载）。
 * 注意：只有「把 ZIP 传到 Release」的模组才统计得到；直接把 ZIP 放仓库文件（raw/jsDelivr）是没有计数的。
 * 匿名 API 限 60 次/小时，所以 CI 里会带 GITHUB_TOKEN（5000 次/小时）。
 */
async function fetchReleaseDownloads(repo) {
  const token = process.env.GH_API_TOKEN || "";
  const headers = { "User-Agent": "EveJS-mods-index", Accept: "application/vnd.github+json" };
  if (token) headers.Authorization = "Bearer " + token;
  try {
    const res = await fetch("https://api.github.com/repos/" + repo + "/releases?per_page=100", { headers });
    if (!res.ok) return { ok: false, reason: "HTTP " + res.status };
    const list = await res.json();
    let total = 0;
    for (const r of Array.isArray(list) ? list : []) {
      for (const a of Array.isArray(r.assets) ? r.assets : []) total += Number(a.download_count) || 0;
    }
    return { ok: true, total };
  } catch (e) {
    return { ok: false, reason: e && e.message ? e.message : String(e) };
  }
}

/**
 * jsDelivr CDN 命中次数（次选来源）。
 * 启动器的下载镜像顺序是 jsDelivr → raw → github，所以「ZIP 直接放仓库文件」的模组
 * 也能在这里拿到真实计数（Release 资产那条路统计不到它们）。
 * 注意：只有经 jsDelivr CDN 的请求才算，直连 raw.githubusercontent.com 不计入。
 */
async function fetchJsdelivrHits(repo) {
  try {
    const res = await fetch("https://data.jsdelivr.com/v1/stats/packages/gh/" + repo, {
      headers: { "User-Agent": "EveJS-mods-index", Accept: "application/json" }
    });
    if (!res.ok) return { ok: false, reason: "HTTP " + res.status };
    const data = await res.json();
    const total = Number(data && data.hits ? data.hits.total : NaN);
    return Number.isFinite(total) ? { ok: true, total } : { ok: false, reason: "响应里没有 hits.total" };
  } catch (e) {
    return { ok: false, reason: e && e.message ? e.message : String(e) };
  }
}

const sources = (() => {
  try {
    const parsed = JSON.parse(fs.readFileSync(SOURCES_FILE, "utf8"));
    const list = Array.isArray(parsed.sources) ? parsed.sources : [];
    return list.filter((x) => typeof x === "string" && /^[\w.-]+\/[\w.-]+$/.test(x.trim())).map((x) => x.trim());
  } catch {
    console.error("读不到或解析不了 sources.json，按空列表处理");
    return [];
  }
})();

const authorKeys = (() => {
  try {
    const parsed = JSON.parse(fs.readFileSync(AUTHOR_KEYS_FILE, "utf8"));
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
})();

/**
 * 本地清单覆盖（可选）：INDEX_LOCAL_LISTINGS="owner/repo=/abs/path/evejs-mod.json;owner2/repo2=/abs/..."
 * 用途：本地/离线构建时，不依赖 CDN（jsDelivr 对分支引用有最长约 12h 缓存，刚改完清单时读到的可能是旧的）。
 */
const LOCAL_LISTINGS = (process.env.INDEX_LOCAL_LISTINGS || "")
  .split(";")
  .map((x) => x.trim())
  .filter(Boolean)
  .map((x) => { const i = x.indexOf("="); return i > 0 ? { repo: x.slice(0, i).trim().toLowerCase(), path: x.slice(i + 1).trim() } : null; })
  .filter(Boolean);

/**
 * 维护者审核规则：moderation.json
 *   { entries: [ { target, kind:"id"|"source", action:"reject"|"delist", reason:{zh,en}, at, by } ] }
 * target 是模组 id（kind=id）或 owner/repo（kind=source）。
 */
const moderationRules = (() => {
  try {
    const parsed = JSON.parse(fs.readFileSync(MODERATION_FILE, "utf8"));
    const list = Array.isArray(parsed.entries) ? parsed.entries : [];
    return list.filter((e) => e && typeof e.target === "string" && e.target.trim() &&
      (e.action === "reject" || e.action === "delist"));
  } catch {
    return [];   // 没有这个文件 = 全部放行
  }
})();

function reasonsOf(rule) {
  const r = rule && rule.reason && typeof rule.reason === "object" ? rule.reason : {};
  return { zh: String(r.zh || ""), en: String(r.en || r.zh || "") };
}

function ruleFor(kind, target) {
  const t = String(target || "").trim().toLowerCase();
  if (!t) return null;
  const hit = moderationRules.filter((e) => (e.kind === "source" ? "source" : "id") === kind &&
    String(e.target).trim().toLowerCase() === t);
  return hit.length ? hit[hit.length - 1] : null;   // 同目标多条时以最后一条为准
}

const mods = [];
const moderationLog = {};   // 会原样发布进索引，作者据此看到原因
const byId = new Map();
const rejected = [];
let authorKeysChanged = false;

for (const repo of sources) {
  // 来源级审核：整仓被拒绝收录 → 不抓取、不进索引，但原因照样发布
  const srcRule = ruleFor("source", repo);
  if (srcRule && srcRule.action === "reject") {
    rejected.push({ repo, reason: "维护者已拒绝收录：" + (reasonsOf(srcRule).zh || "未填写原因") });
    moderationLog[repo] = { source: repo, action: "reject", reason: reasonsOf(srcRule), at: srcRule.at || "", by: srcRule.by || "" };
    continue;
  }
  // 多镜像候选（顺序 = 新鲜度）：
  //   1) raw 直连 + 时间戳（raw 本身不走 CDN，时间戳再挡一层代理缓存）
  //   2) jsDelivr 用 @<commit-sha>（不可变引用，**不会**命中 @main 的 12h 分支缓存）
  //   3) jsDelivr @main（国内可达性好，但可能是旧的）
  //   4) github.com/raw 兜底
  const headSha = await fetchHeadSha(repo);
  const stamp = Date.now();
  const candidates = [
    "https://raw.githubusercontent.com/" + repo + "/HEAD/" + LISTING_NAME + "?t=" + stamp,
    ...(headSha ? ["https://cdn.jsdelivr.net/gh/" + repo + "@" + headSha + "/" + LISTING_NAME] : []),
    "https://cdn.jsdelivr.net/gh/" + repo + "@main/" + LISTING_NAME,
    "https://github.com/" + repo + "/raw/HEAD/" + LISTING_NAME + "?t=" + stamp
  ];
  let entry = null;
  let entrySource = "";
  const failures = [];
  const local = LOCAL_LISTINGS.find((l) => l.repo === repo.toLowerCase());
  if (local) {
    try {
      entry = JSON.parse(fs.readFileSync(local.path, "utf8"));
      console.log("（用本地清单）" + repo + " ← " + local.path);
    } catch (e) {
      console.warn("本地清单读取失败，回退到联网抓取：" + (e && e.message ? e.message : e));
      entry = null;
    }
  }
  for (const url of entry ? [] : candidates) {
    const res = await fetchJson(url);
    if (res.ok && res.data && typeof res.data === "object") { entry = res.data; entrySource = url; break; }
    failures.push(url.replace(/^https:\/\//, "").split("/").slice(0, 1)[0] + "→" + (res.reason || "失败"));
  }
  if (!entry) {
    // 兜底：直接问 GitHub API（无 CDN 缓存），CI 里有 GITHUB_TOKEN
    const viaApi = await fetchListingViaApi(repo);
    if (viaApi.ok && viaApi.data && typeof viaApi.data === "object") {
      entry = viaApi.data;
      entrySource = "api.github.com/contents";
      console.log("（API 兜底）" + repo + " ← api.github.com contents");
    } else {
      failures.push("api→" + (viaApi.reason || "失败"));
    }
  }
  if (!entry) {
    rejected.push({ repo, reason: "抓不到 " + LISTING_NAME + "（" + failures.join("；") + "）" });
    continue;
  }
  if (!entry || typeof entry !== "object") { rejected.push({ repo, reason: "不是 JSON 对象" }); continue; }
  if (entrySource) {
    const label = entrySource.includes("/" + (entrySource.match(/@([0-9a-f]{7,40})\//) || [, ""])[1]) && entrySource.includes("jsdelivr")
      ? "jsDelivr@commit"
      : entrySource.includes("jsdelivr") ? "jsDelivr@main"
      : entrySource.includes("raw.githubusercontent") ? "raw(带时间戳)" : "github raw";
    console.log("  " + repo + " 清单来源：" + label + "（v" + String(entry.version || "?") + "）");
  }
  const id = typeof entry.id === "string" ? entry.id.trim() : "";
  const version = typeof entry.version === "string" ? entry.version.trim() : "";
  const sha256 = typeof entry.sha256 === "string" ? entry.sha256.trim().toLowerCase() : "";
  if (!id) { rejected.push({ repo, reason: "缺 id" }); continue; }
  if (!version) { rejected.push({ repo, reason: "缺 version" }); continue; }
  if (!/^[0-9a-f]{64}$/.test(sha256)) { rejected.push({ repo, reason: "sha256 不是 64 位 hex" }); continue; }

  // 原则 1：id 先到先得
  if (byId.has(id)) {
    rejected.push({ repo, reason: "id「" + id + "」已被 " + byId.get(id) + " 占用（先到先得）" });
    continue;
  }

  // 原则 2：author.id ↔ 公钥绑定
  const author = entry.author && typeof entry.author === "object" ? entry.author : {};
  const authorId = typeof author.id === "string" ? author.id.trim() : "";
  const keyId = typeof author.keyId === "string" ? author.keyId.trim() : "";
  const publicKey = typeof author.publicKey === "string" ? author.publicKey.trim() : "";
  if (authorId) {
    const known = authorKeys[authorId];
    if (!known) {
      authorKeys[authorId] = { keyId, publicKey, repo, firstSeen: new Date().toISOString().slice(0, 10) };
      authorKeysChanged = true;
    } else if (keyId && known.keyId && keyId !== known.keyId) {
      rejected.push({ repo, reason: "author.id「" + authorId + "」已绑定 keyId " + known.keyId + "（提交的是 " + keyId + "）" });
      continue;
    }
  }

  const downloads = Array.isArray(entry.downloadUrls) ? entry.downloadUrls : [];
  const usable = downloads.filter((u) => u && typeof u.url === "string" && /^https:\/\//i.test(u.url));
  if (!usable.length) { rejected.push({ repo, reason: "没有可用的 https 下载地址" }); continue; }

  byId.set(id, repo);
  const dl = await fetchReleaseDownloads(repo);
  const cdn = await fetchJsdelivrHits(repo);
  const withDl = { ...entry, source: repo, downloadUrls: usable };
  if (dl.ok || cdn.ok) {
    // Release 资产与 jsDelivr CDN 是两条互不重叠的下载通道，相加即为总下载量
    withDl.downloads = (dl.ok ? dl.total : 0) + (cdn.ok ? cdn.total : 0);
    console.log("  " + id + "：下载 " + withDl.downloads + " 次（Release " + (dl.ok ? dl.total : "未统计") +
      " + jsDelivr " + (cdn.ok ? cdn.total : "未统计") + "）");
  } else {
    console.log("  " + id + "：下载次数未统计（Release: " + dl.reason + " / jsDelivr: " + cdn.reason + "）");
  }
  // 条目级审核：id 规则优先，其次来源规则
  const rule = ruleFor("id", id) || ruleFor("source", repo);
  if (rule && rule.action === "reject") {
    rejected.push({ repo, reason: "维护者已拒绝收录 id「" + id + "」：" + (reasonsOf(rule).zh || "未填写原因") });
    moderationLog[id] = { id, source: repo, authorId, action: "reject", reason: reasonsOf(rule), at: rule.at || "", by: rule.by || "" };
    continue;
  }
  if (rule && rule.action === "delist") {
    withDl.delisted = true;
    withDl.delistReason = reasonsOf(rule);
    withDl.moderatedAt = rule.at || "";
    withDl.moderatedBy = rule.by || "";
    moderationLog[id] = { id, source: repo, authorId, action: "delist", reason: reasonsOf(rule), at: rule.at || "", by: rule.by || "" };
    console.log("  " + id + "：已被维护者下架（" + (reasonsOf(rule).zh || "未填写原因") + "）");
  }
  mods.push(withDl);
}

mods.sort((a, b) => String(a.displayName || a.id).localeCompare(String(b.displayName || b.id)));

const index = { schemaVersion: 1, publishedAt: new Date().toISOString(), mods };
if (Object.keys(moderationLog).length) index.moderation = moderationLog;

const pem = (process.env.INDEX_SIGNING_KEY || "").replace(/\\n/g, "\n").trim();
if (!pem) {
  console.error("缺少环境变量 INDEX_SIGNING_KEY（私钥 PEM）。本地调试可临时用它跑一次。");
  process.exit(2);
}
let privateKey;
try {
  privateKey = crypto.createPrivateKey(pem);
} catch (e) {
  console.error("私钥解析失败：" + (e && e.message ? e.message : e));
  process.exit(2);
}
const spki = crypto.createPublicKey(privateKey).export({ type: "spki", format: "der" });
const raw = spki.subarray(spki.length - 32);
const keyId = keyIdFromRaw(raw);
const sig = crypto.sign(null, Buffer.from(canonicalJson(index), "utf8"), privateKey).toString("base64");
index.signature = { alg: "ed25519", keyId, sig, signedAt: new Date().toISOString() };

fs.mkdirSync(OUT_DIR, { recursive: true });
fs.writeFileSync(OUT_FILE, JSON.stringify(index, null, 2) + "\n", "utf8");
try {
  fs.writeFileSync(path.join(OUT_DIR, "index.html"), "<!doctype html><meta charset=\"utf-8\"><title>EVEjs mods index</title><p>这是 EvEJS 启动器的模组索引，入口是 <a href=\"./mod-index.json\">mod-index.json</a>。\n", "utf8");
} catch { /* 可选 */ }

if (authorKeysChanged) {
  fs.writeFileSync(AUTHOR_KEYS_FILE, JSON.stringify(authorKeys, null, 2) + "\n", "utf8");
}

console.log("索引已生成：" + OUT_FILE);
console.log("  条目：" + mods.length + "  来源：" + sources.length + "  签名 keyId：" + keyId);
if (rejected.length) {
  console.log("");
  console.log("=== 被跳过的来源（" + rejected.length + "）===");
  for (const r of rejected) console.log("  ✗ " + r.repo + " —— " + r.reason);
}
const moderated = Object.values(moderationLog);
if (moderated.length) {
  console.log("");
  console.log("=== 维护者审核（" + moderated.length + "）===");
  for (const m of moderated) console.log("  " + (m.action === "delist" ? "⛔ 下架" : "✗ 拒绝") + " " + (m.id || m.source) + " —— " + (m.reason.zh || "未填写原因"));
}