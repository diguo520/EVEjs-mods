#!/usr/bin/env node
/**
 * EVEjs-mods 维护者审核台（本地小网页，零依赖）
 *
 * 为什么做这个：审核要改 moderation.json + 用私钥重建签名索引 + git 推送，
 * 命令行三步对维护者太重。这里做成「双击 审核台.bat → 浏览器点按钮」。
 *
 * 它做的事（每次点击）：
 *   1) 调 scripts/moderate.mjs 写 moderation.json（收录 / 拒绝 / 下架 / 恢复）
 *   2) 用本机 .keys/index.key 重新构建 + 签名 docs/mod-index.json
 *   3) git add -A → commit → push（用你本机已保存的 git 凭据，不需要 GitHub 令牌）
 * 推上去之后 GitHub Pages 自动重新发布，客户端刷新索引即可看到。
 *
 * 用法：node scripts/review-console.mjs [--port 8790] [--no-open]
 * 环境变量 REVIEW_CONSOLE_DRY=1 → 只打印将执行的命令，不真的构建/提交/推送（自测用）
 */
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { execFileSync, spawnSync } from "node:child_process";

const ROOT = process.cwd();
const PORT = (() => {
  const i = process.argv.indexOf("--port");
  return i >= 0 && process.argv[i + 1] ? Number(process.argv[i + 1]) : 8790;
})();
const NO_OPEN = process.argv.includes("--no-open");
const DRY = process.env.REVIEW_CONSOLE_DRY === "1";

const SOURCES_FILE = path.join(ROOT, "sources.json");
const MODERATION_FILE = path.join(ROOT, "moderation.json");
const INDEX_FILE = path.join(ROOT, "docs", "mod-index.json");
const KEY_FILE = path.join(ROOT, ".keys", "index.key");

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}
function runGit(args) {
  try {
    const out = execFileSync("git", args, { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    return { ok: true, out: String(out).trim() };
  } catch (e) {
    const stdout = e && e.stdout ? String(e.stdout) : "";
    const stderr = e && e.stderr ? String(e.stderr) : e instanceof Error ? e.message : String(e);
    return { ok: false, out: (stdout + stderr).trim() };
  }
}
function git(args) {
  return runGit(args).out;
}

/**
 * 列出「还没进 main 的 PR」。GitHub 把每个 PR 的 head 暴露成 refs/pull/<n>/head，
 * git ls-remote 就能读到，不需要任何令牌；head 已经是 origin/main 祖先的就当已合并跳过。
 */
function listPrs() {
  const res = runGit(["ls-remote", "origin", "refs/pull/*/head"]);
  if (!res.ok) return [];
  const out = [];
  for (const line of res.out.split("\n")) {
    const m = line.match(/^([0-9a-f]{7,40})\s+refs\/pull\/(\d+)\/head$/);
    if (!m) continue;
    const sha = m[1];
    const number = Number(m[2]);
    const known = runGit(["cat-file", "-e", sha]);
    if (known.ok && runGit(["merge-base", "--is-ancestor", sha, "origin/main"]).ok) continue;
    out.push({ number, sha, known: known.ok });
  }
  return out.sort((a, b) => b.number - a.number).slice(0, 20);
}
/**
 * 检查作者仓库是否还在（两个镜像都试）。
 *   可达   = 清单能抓到
 *   抓不到 = 两个镜像都 404 → 仓库被删/改名/转私有（这时要「移除来源」下架）
 *   未知   = 网络问题，不代表仓库没了
 */
/**
 * 检查作者仓库是否还在。要点：**不能只看清单文件** —— jsDelivr 对已删除仓库还有 CDN 缓存，
 * 会把「仓库已删」误判成「可达」。所以先查仓库本身，再查清单。
 *   返回 ok         = 仓库在 + 清单能抓到
 *        missing    = 仓库已删除 / 改名 / 转私有（要「移除来源」下架）
 *        no-listing = 仓库在，但 evejs-mod.json 抓不到（可能被删/改名）
 *        cache-only = 仓库查不到，但 CDN 还有缓存（很可能已删除）
 *        unknown    = 网络问题，判断不了
 */
async function fetchStatus(url, ms) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    const res = await fetch(url, { headers: { "User-Agent": "EveJS-mods-review" }, signal: ctrl.signal });
    return res.status;
  } catch {
    return 0;   // 0 = 网络/证书/超时
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 检查作者仓库是否还在。
 * 主判据用 **jsDelivr 的包 API**：data.jsdelivr.com/v1/packages/gh/<owner>/<repo>
 *   - 仓库存在 → 200；仓库被删/改名/转私有 → 404
 *   - 国内可达（github.com / api.github.com 在不少网络下直接连不上）
 *   - 不受「文件缓存」影响：光看 evejs-mod.json 会被 jsDelivr 的 CDN 缓存骗到（已删仓库仍返回旧文件）
 * 返回：ok / missing（仓库没了）/ no-listing（仓库在但清单抓不到）/ cache-only / unknown
 */
async function sourceStatus(repo) {
  const rawUrl = "https://raw.githubusercontent.com/" + repo + "/main/evejs-mod.json";
  const cdnUrl = "https://cdn.jsdelivr.net/gh/" + repo + "@main/evejs-mod.json";

  let exists = null;
  const jd = await fetchStatus("https://data.jsdelivr.com/v1/packages/gh/" + repo, 8000);
  if (jd === 404) exists = false;
  else if (jd >= 200 && jd < 300) exists = true;
  if (exists === null) {
    const html = await fetchStatus("https://github.com/" + repo, 8000);
    if (html === 404) exists = false;
    else if (html >= 200 && html < 400) exists = true;
  }
  if (exists === false) return "missing";

  const rawStatus = await fetchStatus(rawUrl, 8000);
  if (rawStatus >= 200 && rawStatus < 300) return "ok";
  const cdnStatus = await fetchStatus(cdnUrl, 8000);
  const cdnOk = cdnStatus >= 200 && cdnStatus < 300;
  // 仓库确实存在时，raw 不通但 CDN 通也算可达（启动器下载本来就优先用 jsDelivr）
  if (exists === true) return cdnOk ? "ok" : "no-listing";
  if (cdnOk) return "cache-only";
  return "unknown";
}

async function state() {
  const sources = readJson(SOURCES_FILE, { sources: [] });
  const moderation = readJson(MODERATION_FILE, { entries: [] });
  const index = readJson(INDEX_FILE, { mods: [] });
  const entries = Array.isArray(moderation.entries) ? moderation.entries : [];
  const ruleFor = (target, kind) =>
    entries.find((e) => String(e.target || "").toLowerCase() === String(target).toLowerCase() && (e.kind || "id") === kind) || null;
  return {
    hasKey: fs.existsSync(KEY_FILE),
    branch: git(["rev-parse", "--abbrev-ref", "HEAD"]),
    dirty: git(["status", "--porcelain"]).length > 0,
    sources: await Promise.all(
      (Array.isArray(sources.sources) ? sources.sources : []).map(async (repo) => ({
        repo,
        rule: ruleFor(repo, "source"),
        reach: await sourceStatus(repo)
      }))
    ),
    mods: (Array.isArray(index.mods) ? index.mods : []).map((m) => ({
      id: m.id,
      displayName: m.displayName || m.id,
      version: m.version || "",
      category: m.category || "",
      source: m.source || "",
      delisted: m.delisted === true,
      rule: ruleFor(m.id, "id") || ruleFor(m.source || "", "source")
    })),
    indexPublishedAt: index.publishedAt || "",
    prs: listPrs(),
    moderation: entries.map((e) => ({
      target: String(e.target || ""),
      kind: e.kind === "source" ? "source" : "id",
      action: String(e.action || ""),
      zh: (e.reason && e.reason.zh) || "",
      en: (e.reason && e.reason.en) || "",
      at: String(e.at || ""),
      by: String(e.by || "")
    }))
  };
}

/** 跑一步命令，把输出并进日志 */
function step(log, label, file, args, extraEnv) {
  log.push("$ " + label);
  if (DRY) {
    log.push("  （dry-run，跳过）");
    return true;
  }
  const res = spawnSync(process.execPath, [file, ...args], {
    cwd: ROOT,
    encoding: "utf8",
    env: { ...process.env, ...(extraEnv || {}) }
  });
  const out = ((res.stdout || "") + (res.stderr || "")).trim();
  if (out) log.push(out);
  const ok = res.status === 0;
  log.push(ok ? "  ✓ " + label : "  ✗ " + label + "（退出码 " + res.status + "）");
  return ok;
}

function applyAction(input) {
  const log = [];
  const action = String(input.action || "");
  const target = String(input.target || "").trim();
  const kind = String(input.kind || "id") === "source" ? "source" : "id";
  const zh = String(input.zh || "").trim();
  const en = String(input.en || "").trim() || zh;

  if (action === "remove-source") {
    const data = readJson(SOURCES_FILE, { schemaVersion: 1, sources: [] });
    const list = (Array.isArray(data.sources) ? data.sources : []).map((x) => String(x));
    const next = list.filter((x) => x.toLowerCase() !== target.toLowerCase());
    if (next.length === list.length) return { ok: false, log: ["sources.json 里没有 " + target] };
    fs.writeFileSync(SOURCES_FILE, JSON.stringify({ schemaVersion: 1, sources: next }, null, 2) + "\n");
    const mod = readJson(MODERATION_FILE, { schemaVersion: 1, entries: [] });
    mod.entries = (Array.isArray(mod.entries) ? mod.entries : []).filter(
      (e) => !(e && (e.kind || "id") === "source" && String(e.target).toLowerCase() === target.toLowerCase())
    );
    fs.writeFileSync(MODERATION_FILE, JSON.stringify(mod, null, 2) + "\n");
    log.push("已从 sources.json 移除：" + target + "（它带的所有模组都会从市场消失）");
  } else if (action === "merge-pr") {
    const n = String(target).replace(/[^0-9]/g, "");
    if (DRY) {
      log.push("$ git fetch + git merge（dry-run，跳过）");
      return finish(log, "merge-pr", target, zh);
    }
    if (!n) return { ok: false, log: ["PR 编号非法"] };
    if (git(["status", "--porcelain"]).length) {
      return { ok: false, log: ["工作区有未提交改动。先点一次「重新构建签名索引并推送」，或先处理本地改动，再来合并 PR。"] };
    }
    const branch = "pr-" + n;
    log.push("$ git fetch origin pull/" + n + "/head:" + branch);
    let r = runGit(["fetch", "origin", "pull/" + n + "/head:" + branch, "--force"]);
    if (r.out) log.push(r.out);
    if (!r.ok) { log.push("  ✗ 取不到这个 PR（可能已被删除）"); return { ok: false, log }; }
    log.push("$ git log -1 --format=%s " + branch);
    log.push("  " + git(["log", "-1", "--format=%s", branch]));
    log.push("$ git diff --stat origin/main..." + branch + "（这个 PR 改了什么）");
    log.push(git(["diff", "--stat", "origin/main..." + branch]));
    log.push("$ git merge --no-ff " + branch);
    r = runGit(["merge", "--no-ff", branch, "-m", "Merge pull request #" + n + " (local review)"]);
    if (r.out) log.push(r.out);
    if (!r.ok) {
      runGit(["merge", "--abort"]);
      log.push("  ✗ 合并冲突，已用 git merge --abort 回滚。这个 PR 需要手动处理，或让作者重新提交。");
      return { ok: false, log };
    }
    log.push("  ✓ 已合并到本地 main（接下来重建签名索引并推送，GitHub 会自动把该 PR 标成 merged）");
    runGit(["branch", "-D", branch]);
  } else if (action === "rebuild") {
    log.push("不修改审核记录，只重建签名索引并推送");
  } else if (action === "restore") {
    if (!step(log, "撤销审核记录：" + target, "scripts/moderate.mjs", ["restore", target, "--kind", kind])) {
      return { ok: false, log };
    }
  } else if (action === "approve") {
    if (!step(log, "收录通过：" + target, "scripts/moderate.mjs", ["approve", target])) return { ok: false, log };
  } else if (action === "reject" || action === "delist") {
    if (!zh) return { ok: false, log: ["需要填写原因（中文），作者会在启动器里看到它"] };
    const args = [action, target, "--kind", kind, "--zh", zh];
    if (en) args.push("--en", en);
    if (!step(log, (action === "reject" ? "拒绝收录：" : "下架：") + target, "scripts/moderate.mjs", args)) {
      return { ok: false, log };
    }
  } else {
    return { ok: false, log: ["未知操作：" + action] };
  }

  return finish(log, action, target, zh);
}

/** 重建签名索引 + git 提交推送（所有动作共用） */
function finish(log, action, target, zh) {
  // 2) 本地重建 + 签名索引（CI 的签名密钥没配好时，这一步是必须的）
  if (fs.existsSync(KEY_FILE) && !DRY) {
    const pem = fs.readFileSync(KEY_FILE, "utf8");
    // 重建前的索引条目（带 source，用来判断“丢了模组”是不是因为来源被你主动移除）
    const beforeMods = (() => {
      const j = readJson(INDEX_FILE, { mods: [] });
      return (Array.isArray(j.mods) ? j.mods : [])
        .map((m) => ({ id: String(m.id || ""), source: String(m.source || "").toLowerCase() }))
        .filter((m) => m.id);
    })();
    const sourcesNow = (() => {
      const j = readJson(SOURCES_FILE, { sources: [] });
      return (Array.isArray(j.sources) ? j.sources : []).map((s) => String(s).toLowerCase());
    })();
    const rejectedTargets = (() => {
      const j = readJson(MODERATION_FILE, { entries: [] });
      return (Array.isArray(j.entries) ? j.entries : [])
        .filter((e) => e && e.action === "reject")
        .map((e) => String(e.target || ""));
    })();
    log.push("$ node scripts/build-index.mjs（用 .keys/index.key 签名）");
    const res = spawnSync(process.execPath, ["scripts/build-index.mjs"], {
      cwd: ROOT,
      encoding: "utf8",
      env: { ...process.env, INDEX_SIGNING_KEY: pem }
    });
    const out = ((res.stdout || "") + (res.stderr || "")).trim();
    if (out) log.push(out);
    if (res.status !== 0) {
      log.push("  ✗ 重建索引失败，已停止（没有提交）");
      return { ok: false, log };
    }
    // 抓取类失败（不是「维护者已拒绝收录」的跳过）= 真问题，必须拦下
    const hardSkip = /✗\s+\S+\s+——\s+(?!维护者已拒绝)/.test(out);
    // 构建日志里那些「维护者已拒绝收录」的来源 = 本来就不该出模组，0 个也正常
    const modSkippedSources = [...out.matchAll(/✗\s+(\S+)\s+——\s+维护者已拒绝收录/g)].map((m) => m[1].toLowerCase());
    const afterIds = (() => {
      const j = readJson(INDEX_FILE, { mods: [] });
      return (Array.isArray(j.mods) ? j.mods : []).map((m) => String(m.id || "")).filter(Boolean);
    })();
    // 只把「来源还在收录列表里、也不是被审核挡掉、却没出现在新索引」算作真丢模组；
    // 来源被你自己从 sources.json 移除（=主动下架）不算问题
    const lost = beforeMods
      .filter((m) => !afterIds.includes(m.id))
      .filter((m) => !rejectedTargets.includes(m.id))
      .filter((m) => !modSkippedSources.includes(m.source))
      .filter((m) => sourcesNow.includes(m.source))
      .map((m) => m.id);
    const expectedSources = sourcesNow.filter((s) => !modSkippedSources.includes(s));
    if ((expectedSources.length > 0 && afterIds.length === 0) || hardSkip || lost.length) {
      runGit(["checkout", "--", "docs/mod-index.json"]);
      log.push("  ✗ 重建结果不健康，已回滚本地索引，没有提交：");
      if (hardSkip) log.push("     有来源抓取失败（上面「被跳过的来源」里不是「维护者已拒绝收录」的那些）。如果作者已经删了仓库，回上一页点那个来源的「移除来源（下架）」。");
      if (lost.length) log.push("     会丢掉已上架的模组：" + lost.join(", "));
      if (expectedSources.length > 0 && afterIds.length === 0) log.push("     sources.json 里有 " + expectedSources.length + " 个未被审核挡掉的来源，但重建出来是 0 个模组");
      log.push("    多半是访问 raw.githubusercontent.com / jsDelivr 失败，过一会儿再点一次即可。");
      return { ok: false, log };
    }
    log.push("  ✓ 索引已重建并重新签名（模组 " + afterIds.length + " 个）");
  } else if (DRY) {
    log.push("$ node scripts/build-index.mjs（dry-run，跳过）");
  } else {
    log.push("⚠ 找不到 .keys/index.key，跳过本地重建：这次改动要等 CI 签名（CI 密钥没配好时不会生效）");
  }

  // 3) 提交 + 推送
  const desc =
    action === "approve" ? "approve " :
    action === "reject" ? "reject " :
    action === "delist" ? "delist " :
    action === "rebuild" ? "rebuild" :
    action === "merge-pr" ? "merged" :
    action === "remove-source" ? "remove source " : "restore ";
  const commitMsg =
    action === "merge-pr"
      ? "chore(index): rebuild signed index after PR #" + String(target).replace(/[^0-9]/g, "")
      : "chore(index): " + desc + (action === "rebuild" ? "" : " " + target) + (zh ? " - " + zh.slice(0, 60) : "");
  for (const [label, args] of [
    ["git add -A", ["add", "-A"]],
    ["git commit", ["commit", "-m", commitMsg]]
  ]) {
    log.push("$ " + label);
    if (DRY) {
      log.push("  （dry-run，跳过）");
      continue;
    }
    const out = git(args);
    if (out) log.push(out);
  }
  if (DRY) {
    log.push("$ git pull --rebase + git push（dry-run，跳过）");
    return { ok: true, log };
  }
  log.push("$ git pull --rebase origin main");
  let pull = runGit(["pull", "--rebase", "origin", "main"]);
  if (pull.out) log.push(pull.out);
  if (!pull.ok) {
    runGit(["rebase", "--abort"]);
    log.push("  ✗ rebase 失败（可能有冲突），已回滚，没有推送。");
    return { ok: false, log };
  }
  log.push("$ git push");
  let push = runGit(["push"]);
  if (push.out) log.push(push.out);
  if (!push.ok) {
    log.push("  （第一次推送失败，重新对齐远端再试一次）");
    pull = runGit(["pull", "--rebase", "origin", "main"]);
    if (pull.out) log.push(pull.out);
    push = runGit(["push"]);
    if (push.out) log.push(push.out);
    if (!push.ok) {
      log.push("  ✗ 推送仍然失败：改动只在本机，远端没有生效。看上面的报错。");
      return { ok: false, log };
    }
  }
  log.push("  ✓ 已推送到 GitHub（等 1 分钟左右 Pages 刷新，启动器再拉一次索引即可看到）");
  return { ok: true, log };
}

const PAGE = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>EVEjs-mods 审核台</title>
<style>
 body{margin:0;background:#0a0f16;color:#cfe3f5;font:14px/1.6 "Microsoft YaHei UI","Segoe UI",sans-serif}
 header{padding:18px 24px;border-bottom:1px solid #1d2b3a;background:#0d141d}
 h1{margin:0;font-size:18px;color:#fff} .sub{color:#7e93a8;font-size:12px;margin-top:4px}
 main{padding:18px 24px;display:grid;gap:18px;max-width:1200px}
 section{background:#0f1720;border:1px solid #1d2b3a;border-radius:6px;padding:14px 16px}
 h2{margin:0 0 10px;font-size:14px;color:#8fd3ff;font-weight:600}
 table{width:100%;border-collapse:collapse;font-size:13px}
 th,td{text-align:left;padding:7px 8px;border-bottom:1px solid #17222e;vertical-align:middle}
 th{color:#7e93a8;font-weight:500;font-size:12px}
 code{background:#0a0f16;border:1px solid #1d2b3a;padding:1px 5px;border-radius:3px;color:#8fd3ff;font-size:12px}
 button{background:#132234;border:1px solid #24425f;color:#8fd3ff;padding:5px 11px;border-radius:4px;cursor:pointer;font-size:12px}
 button:hover{background:#193049}
 button.warn{color:#ffb454;border-color:#5a4322} button.bad{color:#ff6b6b;border-color:#5c2b2b}
 button.ok{color:#57d9a3;border-color:#225c45}
 .pill{font-size:11px;padding:2px 7px;border-radius:10px;border:1px solid #24425f;color:#7e93a8}
 .pill.delist{color:#ffb454;border-color:#5a4322} .pill.reject{color:#ff6b6b;border-color:#5c2b2b}
 pre{background:#080d13;border:1px solid #17222e;padding:10px;border-radius:4px;max-height:320px;overflow:auto;font-size:12px;white-space:pre-wrap}
 dialog{background:#0f1720;color:#cfe3f5;border:1px solid #24425f;border-radius:6px;padding:18px;width:520px}
 dialog h3{margin:0 0 12px;font-size:15px;color:#fff}
 label{display:block;margin:10px 0 4px;font-size:12px;color:#7e93a8}
 input,textarea{width:100%;box-sizing:border-box;background:#0a0f16;border:1px solid #24425f;color:#cfe3f5;padding:8px;border-radius:4px;font-size:13px}
 .row{display:flex;gap:8px;justify-content:flex-end;margin-top:14px}
 .warnbox{background:#2a1d10;border:1px solid #5a4322;color:#ffb454;padding:9px 12px;border-radius:4px;font-size:12px}
</style></head><body>
<header>
  <h1>EVEjs-mods 审核台</h1>
  <div class="sub">改 moderation.json → 本地重建签名索引 → git 提交推送。点按钮即可，不用敲命令。</div>
</header>
<main>
  <div id="warn"></div>
  <section>
    <h2>快捷操作</h2>
    <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
      <input id="newRepo" placeholder="作者仓库 owner/repo（例如 someone/my-evejs-mod）" style="flex:1;min-width:320px">
      <button class="ok" onclick="approveRepo()">收录通过</button>
      <button onclick="rebuildNow()">重新构建签名索引并推送</button>
    </div>
    <div class="sub" style="margin-top:8px">作者把 ZIP 发到自己仓库后，把 owner/repo 填进来点「收录通过」，等价于合并 PR。若你是在 GitHub 网页上点的 Merge，回来点一次「重建」就能立刻生效。</div>
  </section>
  <section>
    <h2>待审核的作者提交（Pull Request）<span class="pill" id="prCount">0</span></h2>
    <table><thead><tr><th>PR</th><th>head</th><th style="width:300px">操作</th></tr></thead><tbody id="prBody"></tbody></table>
    <div class="sub" style="margin-top:8px">作者用启动器「③ 申请收录」提交后会出现在这里。点「本地合并」= 合并进 main → 重建签名索引 → 推送，GitHub 会自动把该 PR 标成 merged，全程不用开 GitHub 网页。</div>
  </section>
  <section>
    <h2>收录来源 sources.json <span class="pill" id="srcCount">0</span></h2>
    <table><thead><tr><th>仓库</th><th>审核</th><th>仓库状态</th><th style="width:300px">操作</th></tr></thead><tbody id="srcBody"></tbody></table>
  </section>
  <section>
    <h2>市场里的模组 mod-index.json <span class="pill" id="modCount">0</span> <span class="pill" id="published"></span></h2>
    <table><thead><tr><th>模组</th><th>版本</th><th>分类</th><th>来源</th><th>状态</th><th style="width:260px">操作</th></tr></thead><tbody id="modBody"></tbody></table>
  </section>
  <section>
    <h2>审核记录（拒绝收录 / 已下架）<span class="pill" id="modCount2">0</span></h2>
    <table><thead><tr><th>类型</th><th>目标</th><th>原因</th><th>时间</th><th style="width:120px">操作</th></tr></thead><tbody id="modBody2"></tbody></table>
    <div class="sub" style="margin-top:8px">被「拒绝收录」的模组不会出现在上面的市场表里，要撤销就在这里点「恢复」。</div>
  </section>
  <section><h2>操作日志</h2><pre id="log">（点上面的按钮后，这里会显示做了什么）</pre></section>
</main>

<dialog id="dlg">
  <h3 id="dlgTitle">操作</h3>
  <label>原因（中文，必填 —— 会显示给作者）</label>
  <textarea id="dlgZh" rows="3" placeholder="例如：欢迎广播文案需要改成可配置后再上架"></textarea>
  <label>Reason (English, optional)</label>
  <input id="dlgEn" placeholder="e.g. make the welcome wording configurable and resubmit">
  <div class="row">
    <button onclick="document.getElementById('dlg').close()">取消</button>
    <button class="bad" id="dlgGo">确认</button>
  </div>
</dialog>

<script>
let pending = null;
function esc(s){return String(s==null?"":s).replace(/[&<>"']/g,(c)=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));}
async function load(){
  const st = await (await fetch("/api/state")).json();
  document.getElementById("prCount").textContent = st.prs.length;
  document.getElementById("prBody").innerHTML = st.prs.map(function(p){
    var link = "https://github.com/diguo520/EVEjs-mods/pull/" + p.number;
    return "<tr><td><b>#" + p.number + "</b></td><td><code>" + esc(p.sha.slice(0,10)) + "</code></td><td>" +
      "<button class='ok' data-pr='" + p.number + "'>本地合并</button> " +
      "<button data-url='" + link + "'>打开 PR 页面</button></td></tr>";
  }).join("") || "<tr><td colspan='3' style='color:#7e93a8'>（没有待审核的 PR）</td></tr>";
  document.getElementById("modCount2").textContent = st.moderation.length;
  document.getElementById("modBody2").innerHTML = st.moderation.map(function(m){
    var when = m.at ? new Date(m.at).toLocaleString() : '';
    return "<tr><td>" + (m.action === 'reject' ? '拒绝收录' : '下架') + "</td><td><code>" + esc(m.target) + "</code> <span class='pill'>" + esc(m.kind) + "</span></td><td>" + esc(m.zh || m.en) + "</td><td>" + esc(when) + "</td><td>" +
      "<button class='ok' data-restore='" + esc(m.target) + "|" + m.kind + "'>恢复</button></td></tr>";
  }).join("") || "<tr><td colspan='5' style='color:#7e93a8'>（没有审核记录）</td></tr>";
  document.getElementById("srcCount").textContent = st.sources.length;
  document.getElementById("modCount").textContent = st.mods.length;
  document.getElementById("published").textContent = st.indexPublishedAt ? "签名于 " + new Date(st.indexPublishedAt).toLocaleString() : "";
  document.getElementById("warn").innerHTML = st.hasKey ? "" :
    '<div class="warnbox">没有找到 .keys/index.key：本地无法重新签名索引。请确认这是维护者机器上的仓库副本，否则改动要等 CI（目前 CI 的 INDEX_SIGNING_KEY 未生效）。</div>';
  document.getElementById("srcBody").innerHTML = st.sources.map((s)=>{
    const reachMap = {
      "ok": "<span class='pill'>清单可达</span>",
      "missing": "<span class='pill reject'>仓库已删除 / 改名</span>",
      "no-listing": "<span class='pill reject'>仓库在，但 evejs-mod.json 抓不到</span>",
      "cache-only": "<span class='pill delist'>只有 CDN 缓存（很可能已删除）</span>",
      "unknown": "<span class='pill delist'>未检测到（网络/限流）</span>"
    };
    const reach = reachMap[s.reach] || reachMap.unknown;
    const rule = s.rule;
    const pill = rule ? '<span class="pill ' + (rule.action === "reject" ? "reject" : "delist") + '">' + (rule.action === "reject" ? "拒绝收录" : "下架") + '</span>' : '<span class="pill">正常</span>';
    const btns = rule
      ? '<button class="ok" onclick="act(\\'restore\\',\\'' + esc(s.repo) + '\\',\\'source\\')">恢复收录</button>'
      : '<button class="bad" onclick="ask(\\'reject\\',\\'' + esc(s.repo) + '\\',\\'source\\',\\'拒绝收录：\\')">拒绝收录</button>';
    const removeBtn = (s.reach === "missing" || s.reach === "no-listing" || s.reach === "cache-only")
      ? " <button class='bad' data-remove='" + esc(s.repo) + "'>移除来源（下架）</button>"
      : "";
    return "<tr><td><code>" + esc(s.repo) + "</code></td><td>" + pill + "</td><td>" + reach + "</td><td>" + btns + removeBtn + "</td></tr>";
  }).join("") || '<tr><td colspan="4" style="color:#7e93a8">（sources.json 里还没有任何仓库）</td></tr>';
  document.getElementById("modBody").innerHTML = st.mods.map((m)=>{
    const rule = m.rule;
    const pill = m.delisted || (rule && rule.action === "delist")
      ? '<span class="pill delist">已下架</span>'
      : rule && rule.action === "reject" ? '<span class="pill reject">已拒绝</span>' : '<span class="pill">上架中</span>';
    const delistBtn = m.delisted
      ? '<button class="ok" onclick="act(\\'restore\\',\\'' + esc(m.id) + '\\',\\'id\\')">恢复上架</button>'
      : '<button class="warn" onclick="ask(\\'delist\\',\\'' + esc(m.id) + '\\',\\'id\\',\\'下架：\\')">下架</button>';
    const rejectBtn = rule && rule.action === "reject" ? "" : '<button class="bad" onclick="ask(\\'reject\\',\\'' + esc(m.id) + '\\',\\'id\\',\\'拒绝收录：\\')">拒绝收录</button>';
    return "<tr><td><b>" + esc(m.displayName) + "</b><br><code>" + esc(m.id) + "</code></td><td>" + esc(m.version) + "</td><td>" + esc(m.category) + "</td><td><code>" + esc(m.source) + "</code></td><td>" + pill + "</td><td>" + delistBtn + " " + rejectBtn + "</td></tr>";
  }).join("") || '<tr><td colspan="6" style="color:#7e93a8">（索引里还没有模组）</td></tr>';
}
async function approveRepo(){
  const v = document.getElementById("newRepo").value.trim();
  const parts = v.split("/");
  if(parts.length !== 2 || !parts[0] || !parts[1]){ alert("请填成 owner/repo 的形式，例如 someone/my-evejs-mod"); return; }
  document.getElementById("newRepo").value = "";
  await act("approve", v, "source");
}
function rebuildNow(){ return act("rebuild", "-", "id"); }
function ask(action, target, kind, titlePrefix){
  pending = { action, target, kind };
  document.getElementById("dlgTitle").textContent = titlePrefix + target;
  document.getElementById("dlgZh").value = "";
  document.getElementById("dlgEn").value = "";
  document.getElementById("dlg").showModal();
}
document.getElementById("dlgGo").onclick = async ()=>{
  const zh = document.getElementById("dlgZh").value.trim();
  const en = document.getElementById("dlgEn").value.trim();
  if(!zh){ alert("原因必填：作者会看到这句话"); return; }
  document.getElementById("dlg").close();
  await act(pending.action, pending.target, pending.kind, zh, en);
};
async function act(action, target, kind, zh, en){
  const log = document.getElementById("log");
  log.textContent = "执行中… " + action + " " + target + "\\n";
  const res = await (await fetch("/api/action", {
    method:"POST", headers:{ "Content-Type":"application/json" },
    body: JSON.stringify({ action, target, kind, zh, en })
  })).json();
  log.textContent = (res.log || []).join("\\n") + "\\n\\n" + (res.ok ? "✓ 完成：等 CI/Pages 刷新后，作者启动器里就能看到结果" : "✗ 失败：看上面的输出");
  await load();
}
// data- 属性按钮：避免在模板里写嵌套引号的 onclick
document.addEventListener("click", function(e){
  var t = e.target;
  var b = t && t.closest ? t.closest("button[data-pr]") : null;
  if(b){ act("merge-pr", b.getAttribute("data-pr"), "id"); return; }
  var rm = t && t.closest ? t.closest("button[data-remove]") : null;
  if(rm){ var repo = rm.getAttribute("data-remove"); if(confirm("确认把 " + repo + " 从 sources.json 移除？它的模组会立刻从市场消失（等价于下架）。")){ act("remove-source", repo, "source"); } return; }
  var r = t && t.closest ? t.closest("button[data-restore]") : null;
  if(r){ var v = String(r.getAttribute("data-restore")).split("|"); act("restore", v[0], v[1] || "id"); return; }
  var u = t && t.closest ? t.closest("button[data-url]") : null;
  if(u){ window.open(u.getAttribute("data-url")); }
});
load();
</script>
</body></html>`;

const server = http.createServer((req, res) => {
  const url = new URL(req.url || "/", "http://127.0.0.1");
  if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(PAGE);
    return;
  }
  if (req.method === "GET" && url.pathname === "/api/state") {
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    state().then((st) => res.end(JSON.stringify(st))).catch((e) => res.end(JSON.stringify({ error: String(e && e.message ? e.message : e) })));
    return;
  }
  if (req.method === "POST" && url.pathname === "/api/action") {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      let body = {};
      try {
        body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
      } catch {
        /* 保持空对象 */
      }
      let result;
      try {
        result = applyAction(body);
      } catch (e) {
        result = { ok: false, log: ["异常：" + (e instanceof Error ? e.message : String(e))] };
      }
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify(result));
    });
    return;
  }
  res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
  res.end("404");
});

server.listen(PORT, "127.0.0.1", () => {
  const url = "http://127.0.0.1:" + PORT + "/";
  console.log("审核台已启动：" + url + (DRY ? "（dry-run 模式）" : ""));
  console.log("仓库目录：" + ROOT);
  console.log("关掉这个窗口即停止。");
  if (!NO_OPEN && process.platform === "win32") {
    spawnSync("cmd", ["/c", "start", "", url], { stdio: "ignore" });
  }
});