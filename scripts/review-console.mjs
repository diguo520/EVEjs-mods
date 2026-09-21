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
function git(args) {
  try {
    return execFileSync("git", args, { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  } catch (e) {
    const out = e && e.stdout ? String(e.stdout) : "";
    const err = e && e.stderr ? String(e.stderr) : e instanceof Error ? e.message : String(e);
    return (out + err).trim();
  }
}
function state() {
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
    sources: (Array.isArray(sources.sources) ? sources.sources : []).map((repo) => ({
      repo,
      rule: ruleFor(repo, "source")
    })),
    mods: (Array.isArray(index.mods) ? index.mods : []).map((m) => ({
      id: m.id,
      displayName: m.displayName || m.id,
      version: m.version || "",
      category: m.category || "",
      source: m.source || "",
      delisted: m.delisted === true,
      rule: ruleFor(m.id, "id") || ruleFor(m.source || "", "source")
    })),
    indexPublishedAt: index.publishedAt || ""
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

  if (action === "restore") {
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

  // 2) 本地重建 + 签名索引（CI 的签名密钥没配好时，这一步是必须的）
  if (fs.existsSync(KEY_FILE) && !DRY) {
    const pem = fs.readFileSync(KEY_FILE, "utf8");
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
    log.push("  ✓ 索引已重建并重新签名");
  } else if (DRY) {
    log.push("$ node scripts/build-index.mjs（dry-run，跳过）");
  } else {
    log.push("⚠ 找不到 .keys/index.key，跳过本地重建：这次改动要等 CI 签名（CI 密钥没配好时不会生效）");
  }

  // 3) 提交 + 推送
  const desc = action === "approve" ? "approve " : action === "reject" ? "reject " : action === "delist" ? "delist " : "restore ";
  const commitMsg = "chore(index): " + desc + target + (zh ? " - " + zh.slice(0, 60) : "");
  for (const [label, args] of [
    ["git add -A", ["add", "-A"]],
    ["git commit", ["commit", "-m", commitMsg]],
    ["git push", ["push"]]
  ]) {
    log.push("$ " + label);
    if (DRY) {
      log.push("  （dry-run，跳过）");
      continue;
    }
    const out = git(args);
    if (out) log.push(out);
    if (git(["status", "--porcelain"]).length === 0 && label === "git add -A") {
      log.push("  （没有需要提交的改动）");
    }
  }
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
    <h2>收录来源 sources.json <span class="pill" id="srcCount">0</span></h2>
    <table><thead><tr><th>仓库</th><th>状态</th><th style="width:300px">操作</th></tr></thead><tbody id="srcBody"></tbody></table>
  </section>
  <section>
    <h2>市场里的模组 mod-index.json <span class="pill" id="modCount">0</span> <span class="pill" id="published"></span></h2>
    <table><thead><tr><th>模组</th><th>版本</th><th>分类</th><th>来源</th><th>状态</th><th style="width:260px">操作</th></tr></thead><tbody id="modBody"></tbody></table>
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
  document.getElementById("srcCount").textContent = st.sources.length;
  document.getElementById("modCount").textContent = st.mods.length;
  document.getElementById("published").textContent = st.indexPublishedAt ? "签名于 " + new Date(st.indexPublishedAt).toLocaleString() : "";
  document.getElementById("warn").innerHTML = st.hasKey ? "" :
    '<div class="warnbox">没有找到 .keys/index.key：本地无法重新签名索引。请确认这是维护者机器上的仓库副本，否则改动要等 CI（目前 CI 的 INDEX_SIGNING_KEY 未生效）。</div>';
  document.getElementById("srcBody").innerHTML = st.sources.map((s)=>{
    const rule = s.rule;
    const pill = rule ? '<span class="pill ' + (rule.action === "reject" ? "reject" : "delist") + '">' + (rule.action === "reject" ? "拒绝收录" : "下架") + '</span>' : '<span class="pill">正常</span>';
    const btns = rule
      ? '<button class="ok" onclick="act(\\'restore\\',\\'' + esc(s.repo) + '\\',\\'source\\')">恢复收录</button>'
      : '<button class="bad" onclick="ask(\\'reject\\',\\'' + esc(s.repo) + '\\',\\'source\\',\\'拒绝收录：\\')">拒绝收录</button>';
    return "<tr><td><code>" + esc(s.repo) + "</code></td><td>" + pill + "</td><td>" + btns + "</td></tr>";
  }).join("") || '<tr><td colspan="3" style="color:#7e93a8">（sources.json 里还没有任何仓库）</td></tr>';
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
    res.end(JSON.stringify(state()));
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