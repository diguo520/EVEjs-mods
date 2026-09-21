# EVEjs-mods — mod index for the EvEJS Launcher / EvEJS 启动器的模组索引仓库

The signed, serverless mod index that the [EvEJS Launcher](https://github.com/diguo520/EVEjs-launcher) reads.
[EvEJS 启动器](https://github.com/diguo520/EVEjs-launcher) 读取的签名模组索引，不需要任何服务器。

- Index file the launcher reads: <https://diguo520.github.io/EVEjs-mods/mod-index.json>
- Launcher repository: <https://github.com/diguo520/EVEjs-launcher>

**English** ｜ [中文](#中文)

---

## English

### What this repository does

This repository does exactly three things:

1. `sources.json` records which author repositories are listed;
2. CI periodically fetches each repository's `evejs-mod.json` and merges them into one **`mod-index.json`**;
3. CI signs that file with the private key kept in a repository secret and publishes it to GitHub Pages.

The launcher reads exactly one file:

```
https://diguo520.github.io/EVEjs-mods/mod-index.json
```

> **No server required.** The index is static JSON on GitHub Pages, and mod ZIPs are hosted in each author's own
> repository. Integrity comes from the `sha256` recorded in the index, and the index itself is signed with the
> maintainer's private key — the client **verifies the signature first and only then trusts any URL or hash inside it**.

### Repository layout

```
EVEjs-mods/
  sources.json                  which author repositories are listed
  author-keys.json              author.id <-> public key bindings (maintained by CI, prevents impersonation)
  moderation.json               maintainer decisions (reject / delist + reasons)
  scripts/
    keygen.mjs                  maintainer: generate the signing key pair (run once)
    build-index.mjs             fetch -> validate -> merge -> sign -> docs/mod-index.json
    moderate.mjs                reviewer CLI: list / approve / reject / delist / restore / pr-text
  .github/workflows/
    build-index.yml             every 6 hours + manual trigger + push trigger
  docs/                         CI output, published by GitHub Pages (main branch / docs)
    mod-index.json
```

### How an author gets listed (no PR against the index needed)

1. Put the mod source in their own repository and use the launcher's **Submit mod -> Publish to my repo**:
   the launcher writes `evejs-mod.json`, creates the Release and uploads the ZIP;
2. Use the launcher's **Request listing** to add `<owner>/<repo>` to `sources.json` (**one-off** PR);
   - new versions afterwards need **no further PR** — they push to their own repository and the next CI run picks the new version up;
3. The maintainer reviews the PR (checklist below) and merges it.

### Listing checklist (PR review)

- [ ] the repository added to `sources.json` is the **author's own** (not somebody else's, re-registered as theirs)
- [ ] the repository root contains `evejs-mod.json` with:
      `id` / `displayName` / `version` / `author{id,name,keyId,publicKey}` /
      `sizeBytes` / `sha256` (64 hex chars) / `downloadUrls[]` (at least one `https://` direct link)
- [ ] the ZIP lives in the author's own GitHub Releases (this index repository stores **no binaries**)
- [ ] the category uses one of the fixed values: `玩法` / `经济` / `AI` / `画面` / `工具`

CI automatically enforces three **ownership rules** (entries that fail are skipped and listed in the log):

1. **`id` is globally unique, first come first served** — only the first repository in `sources.json` that registered an `id` can update it;
2. **`author.id` <-> public key binding** — the first `keyId` used for an `author.id` is pinned; swapping keys later is rejected (prevents impersonation);
3. **Source is visible** — every index entry records `source` (owner/repo) and the launcher displays it.

### How to fill download URLs (important for reachability in China)

`downloadUrls[]` in `evejs-mod.json` is tried **in ascending `priority` order**; the recommended ordering is:

```jsonc
"downloadUrls": [
  // 1) jsDelivr CDN — much more reachable than raw; single file <= 20MB
  { "mirror": "jsdelivr",   "url": "https://cdn.jsdelivr.net/gh/<owner>/<repo>@main/<id>-<version>.zip", "priority": 1 },
  // 2) GitHub raw — most up to date, but often unreachable
  { "mirror": "github-raw", "url": "https://raw.githubusercontent.com/<owner>/<repo>/main/<id>-<version>.zip", "priority": 2 },
  // 3) github.com/raw — fallback
  { "mirror": "github",     "url": "https://github.com/<owner>/<repo>/raw/main/<id>-<version>.zip", "priority": 3 }
]
```

Warning: jsDelivr caches **branch references** for up to ~12 hours, so a version you just pushed may still serve the
old file for a while. Putting the version in the file name (`<id>-<version>.zip`) avoids this — a new version is a new
file name and cannot hit the stale cache.

### Local / offline build (optional)

`build-index.mjs` normally fetches each repository's `evejs-mod.json` over the network (raw -> jsDelivr -> github).
If your network cannot reach them (or you want to use a listing you just edited but have not pushed yet), override it
with a local file:

```bash
INDEX_LOCAL_LISTINGS="owner/repo=/abs/path/evejs-mod.json" \
INDEX_SIGNING_KEY="$(cat .keys/index.key)" node scripts/build-index.mjs
```

Separate several sources with `;`.

### Maintainer setup (one time)

**1. Generate the signing key pair** (run locally only)

```bash
node scripts/keygen.mjs --out .keys/index
```

It prints two things:

- `.keys/index.key` (private key) -> copy the **entire file content** into Settings -> Secrets and variables -> Actions -> `INDEX_SIGNING_KEY`
- `keyId` + `publicKey` -> paste into `launcher/launcher/src/main/modSigner.ts` under `BUILTIN_PUBKEYS` (the script prints that exact line)

Never commit the private key (`.gitignore` already ignores `.keys/`). Lose it and you can never sign an index the
client accepts again.

**2. Enable GitHub Pages** (recommended: publish `/docs` from `main`)

Repository -> Settings -> Pages -> **Source: Deploy from a branch** -> Branch: **`main`** / **`/docs`** -> Save

> `https://diguo520.github.io/EVEjs-mods/mod-index.json` becomes available immediately (`docs/mod-index.json` is
> already in the repository). Each CI run commits the new index back into `docs/` on `main` and Pages republishes
> automatically — no `gh-pages` branch involved.

**3. Run the workflow once**

Repository -> Actions -> `build-index` -> **Run workflow**. Afterwards open:

```
https://diguo520.github.io/EVEjs-mods/mod-index.json
```

(The first generation may take 1-2 minutes.)

**Optional fallback when no secret is configured**: build locally and commit

```bash
cd <this repo>
INDEX_SIGNING_KEY="$(cat .keys/index.key)" node scripts/build-index.mjs
git add docs/mod-index.json && git commit -m "chore(index): refresh" && git push
```

### Local debugging

```bash
# generate a throwaway index with a test key (nothing is pushed)
node scripts/keygen.mjs --out .keys/test
INDEX_SIGNING_KEY="$(cat .keys/test.key)" node scripts/build-index.mjs
```

You can then feed the generated `docs/mod-index.json` to the launcher's verification logic
(`src/main/modSigner.ts` -> `verifyIndexSignature`).

### Maintainer moderation: approve / reject / delist

#### The easy way: double-click `审核台.bat` (review console)

1. Open the `EVEjs-mods` folder and double-click **`审核台.bat`** (needs Node.js) — your browser opens `http://127.0.0.1:8790`.
2. In the page:
   - **Quick actions** — paste an author's `owner/repo` and hit **收录通过 / accept**: that is the same as merging their listing PR, no PR needed.
     If you merged a PR on GitHub instead, click **重新构建签名索引并推送 / rebuild and push** once so it takes effect immediately.
   - **Market mods** — every row has **下架 / delist**, **恢复上架 / restore** and **拒绝收录 / reject**. Delist and reject ask for a reason, and the author sees it in the launcher.
3. Every click does three things for you: writes `moderation.json` → rebuilds and signs the index with `.keys/index.key` → `git commit` + `git push`.
4. Close the window to stop the console. (No GitHub token needed — it uses your local git credentials.)

> The CLI below is the exact equivalent if you prefer the terminal.

Every moderation result lives in **`moderation.json`**, written for you by `scripts/moderate.mjs`;
`build-index.mjs` reads it when generating the index.

```bash
node scripts/moderate.mjs list                       # reviewer dashboard
node scripts/moderate.mjs approve <owner/repo>       # accept a listing (writes sources.json)
node scripts/moderate.mjs reject <id|owner/repo> --zh "reason" --en "reason"
node scripts/moderate.mjs delist <id|owner/repo> --zh "reason" --en "reason"
node scripts/moderate.mjs restore <id|owner/repo>    # undo a moderation result
node scripts/moderate.mjs pr-text <id|owner/repo>    # bilingual reply you can paste into the PR
```

Rebuild and push so clients see the change:

```bash
node scripts/build-index.mjs
git add -A && git commit -m "chore(index): moderation" && git push
```

| action | in the index | launcher: Mod market | launcher: My mods (author) |
| --- | --- | --- | --- |
| (none) | normal entry | listed, installable | Listed |
| `delist` | entry kept with `delisted:true` + `delistReason` | **not listed**, install/update blocked | red "Delisted" badge + reason |
| `reject` | entry dropped, recorded in the `moderation` map | not listed | red "Not accepted" badge + reason |

> Moderation acts on the **index layer**: the ZIP always stays in the author's own repository — you only decide
> whether it is visible in the market.

---

## 中文

这个仓库**只做三件事**：

1. 用 `sources.json` 登记"哪些作者仓库要收录"；
2. 用 CI 定时抓这些仓库的 `evejs-mod.json`，合并成一份 **`mod-index.json`**；
3. 用仓库 Secret 里的私钥给它**签名**，发布到 GitHub Pages。

启动器读的就是这一个文件：

```
https://diguo520.github.io/EVEjs-mods/mod-index.json
```

> **不需要服务器**：索引是静态 JSON（GitHub Pages），模组 ZIP 由作者自己的仓库托管，
> 完整性靠索引里的 sha256，而索引本身由维护者私钥签名 —— 客户端**先验签，再信任里面的任何地址与哈希**。

### 目录结构

```
EVEjs-mods/
  sources.json                  收录了哪些作者仓库
  author-keys.json              author.id ↔ 公钥 绑定记录（CI 自动维护，防借名）
  moderation.json               维护者审核结果（拒绝收录 / 下架 + 原因）
  scripts/
    keygen.mjs                 维护者生成签名密钥对（只跑一次）
    build-index.mjs            抓取 → 校验 → 合并 → 签名 → 输出 docs/mod-index.json
    moderate.mjs               审核 CLI：list / approve / reject / delist / restore / pr-text
  .github/workflows/
    build-index.yml            每 6 小时 + 手动触发 + push 触发
  docs/                        CI 产物，由 GitHub Pages 从 main 分支的 /docs 发布
    mod-index.json
```

### 作者怎么上架自己的模组（不需要向你提 PR 改索引）

1. 在自己仓库里放模组源码，用**启动器**的「提交模组 → 发布到我的仓库」：
   启动器会帮他写好 `evejs-mod.json` 并建 Release、上传 ZIP；
2. 用启动器的「申请收录」往本仓库 `sources.json` 加一行 `<owner>/<repo>`（**一次性** PR）；
   - 之后**发新版不需要再提 PR** —— 他推自己的仓库，CI 下次跑就会带上新版本；
3. 你在 PR 里人工看一遍（下面有收录规范），合并即可。

### 收录规范（PR 检查清单）

- [ ] `sources.json` 里新增的是**作者自己的仓库**（不是把别人的仓库登记成自己的）
- [ ] 该仓库根目录有 `evejs-mod.json`，且包含：
      `id` / `displayName` / `version` / `author{id,name,keyId,publicKey}` /
      `sizeBytes` / `sha256`(64 位 hex) / `downloadUrls[]`（至少一个 `https://` 直链）
- [ ] ZIP 放在作者自己的 GitHub Releases（本索引仓库**不存二进制**）
- [ ] 分类使用统一取值：`玩法` / `经济` / `AI` / `画面` / `工具`

CI 会自动执行三条**归属硬规则**（不合格的条目会被跳过并在日志里列出）：

1. **`id` 全局唯一、先到先得** —— 同一个 `id` 只有 `sources.json` 里第一次出现的仓库能更新它；
2. **`author.id` ↔ 公钥绑定** —— 同一个 `author.id` 第一次用的 `keyId` 固定，之后换钥匙会被拒绝（防借名）；
3. **来源可见** —— 每条索引都会写 `source`（owner/repo），启动器会展示来源。

### 下载地址怎么填（重要：国内可达性）

`evejs-mod.json` 的 `downloadUrls[]` **按 priority 从小到大尝试**，建议这样排：

```jsonc
"downloadUrls": [
  // 1) jsDelivr CDN —— 国内可达性明显好过 raw；单文件 ≤20MB
  { "mirror": "jsdelivr",   "url": "https://cdn.jsdelivr.net/gh/<owner>/<repo>@main/<id>-<version>.zip", "priority": 1 },
  // 2) GitHub raw —— 最及时，但国内经常连不上
  { "mirror": "github-raw", "url": "https://raw.githubusercontent.com/<owner>/<repo>/main/<id>-<version>.zip", "priority": 2 },
  // 3) github.com/raw —— 兜底
  { "mirror": "github",     "url": "https://github.com/<owner>/<repo>/raw/main/<id>-<version>.zip", "priority": 3 }
]
```

⚠️ 注意 **jsDelivr 对「分支引用」的内容缓存最长约 12 小时**：刚提交的新版本可能短期内还拿到旧文件。
版本号写在文件名里（`<id>-<version>.zip`）可以规避这个问题 —— 新版本是新文件名，不会命中旧缓存。

### 本地 / 离线构建（可选）

`build-index.mjs` 默认联网抓各仓库的 `evejs-mod.json`（raw → jsDelivr → github 依次尝试）。
如果你本地网络抓不到（或想用刚改完还没推上去的清单），可以用本地文件覆盖：

```bash
INDEX_LOCAL_LISTINGS="owner/repo=/abs/path/evejs-mod.json" \
INDEX_SIGNING_KEY="$(cat .keys/index.key)" node scripts/build-index.mjs
```

多个来源用 `;` 分隔。

### 维护者操作（第一次）

**① 生成签名密钥对**（只在本机跑）

```bash
node scripts/keygen.mjs --out .keys/index
```

会打印两样东西：

- `.keys/index.key`（私钥）→ 复制**整个文件内容** → 仓库 Settings → Secrets and variables → Actions → `INDEX_SIGNING_KEY`
- `keyId` + `publicKey` → 贴进启动器 `launcher/launcher/src/main/modSigner.ts` 的 `BUILTIN_PUBKEYS`（脚本会直接打印那一行）

⚠️ 私钥**永远不要**提交（`.gitignore` 已忽略 `.keys/`）。丢了私钥就再也签不出被客户端认可的索引。

**② 开 GitHub Pages**（推荐：直接发布 `main` 分支的 `/docs`）

仓库 → Settings → Pages → **Source: Deploy from a branch** → Branch: **`main`** / **`/docs`** → Save

> 这样 `https://diguo520.github.io/EVEjs-mods/mod-index.json` 立刻可用（`docs/mod-index.json` 已经在仓库里）。
> CI 每次跑完会把新索引**提交回 main 的 `docs/`**，Pages 自动重新发布，不需要 `gh-pages` 分支。

**③ 跑一次 CI**

仓库 → Actions → `build-index` → **Run workflow** → 跑完访问：

```
https://diguo520.github.io/EVEjs-mods/mod-index.json
```

（首次生效可能要等 1~2 分钟）

**（可选）没配 secret 时的兜底**：本机手动跑一次再提交

```bash
cd <这个仓库>
INDEX_SIGNING_KEY="$(cat .keys/index.key)" node scripts/build-index.mjs
git add docs/mod-index.json && git commit -m "chore(index): refresh" && git push
```

### 本地调试

```bash
# 用测试密钥在本地生成一份索引（不推仓库）
node scripts/keygen.mjs --out .keys/test
INDEX_SIGNING_KEY="$(cat .keys/test.key)" node scripts/build-index.mjs
```

生成的 `docs/mod-index.json` 可以拿去对启动器的验签逻辑（`src/main/modSigner.ts` 的 `verifyIndexSignature`）跑一遍。

### 维护者审核：收录 / 拒绝 / 下架

#### 最简单的方式：双击 `审核台.bat`

1. 打开 `EVEjs-mods` 文件夹，**双击 `审核台.bat`**（需要 Node.js）—— 浏览器会自动打开 `http://127.0.0.1:8790`。
2. 页面里：
   - **快捷操作**：把作者的 `owner/repo` 填进去点 **收录通过**，等价于合并他的收录 PR（连 PR 都不用开）；
     如果你是在 GitHub 网页上 Merge 的 PR，回来点一次 **重新构建签名索引并推送** 就立刻生效。
   - **市场里的模组**：每行有 **下架 / 恢复上架 / 拒绝收录**；下架与拒绝会让你填原因，作者在启动器里就能看到。
3. 每次点击它自动做三件事：写 `moderation.json` → 用 `.keys/index.key` 重建并签名索引 → `git commit` + `git push`。
4. 关掉那个黑窗口就停止（不需要 GitHub 令牌，用的是你本机已保存的 git 凭据）。

> 下面的命令行是等价做法，喜欢敲命令时用。

所有审核结果都写在 **`moderation.json`**，由 `scripts/moderate.mjs` 帮你写；`build-index.mjs` 读它来出索引。

```bash
node scripts/moderate.mjs list                       # 看现在收了谁、有没有被拒/下架
node scripts/moderate.mjs approve <owner/repo>       # 审核通过（写进 sources.json）
node scripts/moderate.mjs reject <id|owner/repo> --zh "原因" --en "reason"
node scripts/moderate.mjs delist <id|owner/repo> --zh "原因" --en "reason"
node scripts/moderate.mjs restore <id|owner/repo>    # 撤销审核结果（重新上架 / 恢复收录）
node scripts/moderate.mjs pr-text <id|owner/repo>    # 生成可直接贴到 PR 的中英双语文案
```

改完必须重跑构建 + 推送，客户端才会看到：

```bash
node scripts/build-index.mjs
git add -A && git commit -m "chore(index): moderation" && git push
```

三种状态的效果：

| action | 索引里 | 启动器「模组市场」 | 启动器「我创建的」（作者） |
| --- | --- | --- | --- |
| 不填（正常） | 正常条目 | 正常展示、可安装 | 已上架 |
| `delist` | 条目保留，带 `delisted: true` + `delistReason` | **不再列出**，也不能安装/更新 | 红标「已下架」+ 原因 |
| `reject` | 条目被丢弃，只留在 `moderation` 表 | 不出现 | 红标「已拒绝收录」+ 原因 |

> 审核是**索引层**的动作：ZIP 始终在作者自己的仓库里，你只决定它在市场里可见还是不可见。