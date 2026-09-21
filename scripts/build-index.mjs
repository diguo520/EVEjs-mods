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
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const ROOT = process.cwd();
const SOURCES_FILE = path.join(ROOT, "sources.json");
const AUTHOR_KEYS_FILE = path.join(ROOT, "author-keys.json");
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

const mods = [];
const byId = new Map();
const rejected = [];
let authorKeysChanged = false;

for (const repo of sources) {
  const url = "https://raw.githubusercontent.com/" + repo + "/HEAD/" + LISTING_NAME;
  const res = await fetchJson(url);
  if (!res.ok) {
    rejected.push({ repo, reason: "抓不到 " + LISTING_NAME + "（" + res.reason + "）" });
    continue;
  }
  const entry = res.data;
  if (!entry || typeof entry !== "object") { rejected.push({ repo, reason: "不是 JSON 对象" }); continue; }
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
  mods.push({ ...entry, source: repo, downloadUrls: usable });
}

mods.sort((a, b) => String(a.displayName || a.id).localeCompare(String(b.displayName || b.id)));

const index = { schemaVersion: 1, publishedAt: new Date().toISOString(), mods };

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