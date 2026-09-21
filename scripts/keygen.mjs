#!/usr/bin/env node
/**
 * 生成索引签名密钥对（Ed25519）—— **只在你本机跑一次**。
 *
 * 用法：
 *   node scripts/keygen.mjs --out .keys/index
 *
 * 产出：
 *   .keys/index.key  私钥（PKCS8 PEM）→ 内容整段存进 GitHub 仓库 Secret: INDEX_SIGNING_KEY
 *   .keys/index.pub  公钥（raw base64）→ 贴进启动器 src/main/modSigner.ts 的 BUILTIN_PUBKEYS
 *
 * 注意：私钥**永远不要**提交进仓库（.gitignore 已忽略 .keys/）。
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const args = process.argv.slice(2);
const outIdx = args.indexOf("--out");
const outBase = outIdx >= 0 && args[outIdx + 1] ? args[outIdx + 1] : ".keys/index";

const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
const spki = publicKey.export({ type: "spki", format: "der" });
const raw = spki.subarray(spki.length - 32); // Ed25519 原始公钥就是 SPKI 末尾 32 字节
const keyId = crypto.createHash("sha256").update(raw).digest("hex").slice(0, 12);
const pem = privateKey.export({ type: "pkcs8", format: "pem" });

fs.mkdirSync(path.dirname(outBase), { recursive: true });
fs.writeFileSync(outBase + ".key", pem, { encoding: "utf8", mode: 0o600 });
fs.writeFileSync(outBase + ".pub", raw.toString("base64") + "\n", "utf8");

console.log("=== 1) 私钥（PKCS8 PEM）===");
console.log("已写入：" + outBase + ".key");
console.log("把**整个文件内容**（含 BEGIN/END 两行）复制到 GitHub：");
console.log("  仓库 → Settings → Secrets and variables → Actions → New repository secret");
console.log("  Name: INDEX_SIGNING_KEY");
console.log("");
console.log("=== 2) 公钥 + keyId（贴进启动器）===");
console.log("keyId:      " + keyId);
console.log("publicKey:  " + raw.toString("base64"));
console.log("");
console.log("把下面这一行加进 launcher/launcher/src/main/modSigner.ts 的 BUILTIN_PUBKEYS：");
console.log('  "' + keyId + '": "' + raw.toString("base64") + '",');