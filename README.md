# EVEjs-mods —— EvEJS 启动器的模组索引仓库

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

---

## 目录结构

```
EVEjs-mods/
  sources.json                  收录了哪些作者仓库
  author-keys.json              author.id ↔ 公钥 绑定记录（CI 自动维护，防借名）
  scripts/
    keygen.mjs                 维护者生成签名密钥对（只跑一次）
    build-index.mjs            抓取 → 校验 → 合并 → 签名 → 输出 docs/mod-index.json
  .github/workflows/
    build-index.yml            每 6 小时 + 手动触发 + push 触发
  docs/                        CI 产物（GitHub Pages 从 gh-pages 发布）
    mod-index.json
```

---

## 作者怎么上架自己的模组（不需要向你提 PR 改索引）

1. 在自己仓库里放模组源码，用**启动器**的「提交模组 → ② 发布到我的仓库」：
   启动器会帮他写好 `evejs-mod.json` 并建 Release、上传 ZIP；
2. 用启动器的「③ 申请收录」往本仓库 `sources.json` 加一行 `<owner>/<repo>`（**一次性** PR）；
   - 之后**发新版不需要再提 PR** —— 他推自己的仓库，CI 下次跑就会带上新版本；
3. 你在 PR 里人工看一遍（下面有收录规范），合并即可。

---

## 收录规范（PR 检查清单）

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

---

## 维护者操作（第一次）

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

**④（可选）没配 secret 时的兜底**：本机手动跑一次再提交

```bash
cd <这个仓库>
INDEX_SIGNING_KEY="$(cat .keys/index.key)" node scripts/build-index.mjs
git add docs/mod-index.json && git commit -m "chore(index): refresh" && git push
```


仓库 → Settings → Pages → **Source: Deploy from a branch** → Branch: **`gh-pages`** / **`/ (root)`** → Save
（`gh-pages` 分支由 workflow 自动创建，第一次跑完 CI 才会出现）

**③ 跑一次 CI**

仓库 → Actions → `build-index` → **Run workflow** → 跑完后访问：

```
https://diguo520.github.io/EVEjs-mods/mod-index.json
```

（首次生效可能要等 1~2 分钟）

---

## 本地调试

```bash
# 用测试密钥在本机生成一份索引（不推仓库）
node scripts/keygen.mjs --out .keys/test
INDEX_SIGNING_KEY="$(cat .keys/test.key)" node scripts/build-index.mjs
```

`docs/mod-index.json` 生成后，可以拿启动器的验签逻辑对一遍（`src/main/modSigner.ts` 的 `verifyIndexSignature`）。