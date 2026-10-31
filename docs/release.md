# 发布流程（手动版）

本仓库没有发布流水线，发布按下面的步骤手动执行。合并到 `main` 之后的每一步都在 `main` 上做。

## 1. 升版本号

改动集中在 6 个文件（`check.mjs` 会校验版本一致，漏一个就会红）：

```powershell
$files = 'manifest.json','package.json','src\sidebar.html','README.md','INSTALL.md','RELEASE_NOTES.md'
foreach ($f in $files) {
  $t = [IO.File]::ReadAllText($f)
  $t = $t.Replace('1.13.0','1.13.1')
  [IO.File]::WriteAllText($f,$t)
}
```

同时更新 `RELEASE_NOTES.md`：把标题改成新版本，补上这一版的行为变化。

## 2. 校验 + 构建 + 提交

```powershell
npm run check
npm test
npm run build
git add -A
git commit -m "chore: release <版本号>"
git push
```

`npm run build` 产出：

- `dist\portable\` — 可直接加载的解压目录；
- `dist\AI-Sidebar-Enhanced-v<版本号>-portable.zip` — 分发用安装包（文件名由 `scripts/build-portable.mjs` 生成，版本从 `manifest.json` 读取）。

`dist/` 在 `.gitignore` 里，不进仓库。

## 3. 打 tag 并创建 Release

```powershell
git tag v<版本号>
git push origin v<版本号>

gh release create v<版本号> --repo MBriad/deepseek-sidebar-plus `
  --title "v<版本号> — <一句话主题>" `
  --notes-file RELEASE_NOTES.md
```

## 4. 上传安装包作为 Release 附件

**这一步最容易漏**：`gh release create` 只创建页面，不会自动附带 zip。

```powershell
gh release upload v<版本号> "dist\AI-Sidebar-Enhanced-v<版本号>-portable.zip" `
  --repo MBriad/deepseek-sidebar-plus --clobber
```

## 5. 验证

```powershell
gh release view v<版本号> --repo MBriad/deepseek-sidebar-plus
git show v<版本号> --no-patch --oneline
Get-ChildItem dist | Select-Object Name,Length
```

确认：Release 页面的附件名与本地 zip 同名；tag 指向本次发布提交。

## 6. 清理旧安装包（可选）

`dist` 里会累积历史 zip，只保留当前版本：

```powershell
$dist = (Resolve-Path 'dist').Path
Get-ChildItem $dist -Filter '*.zip' | Where-Object { $_.Name -ne 'AI-Sidebar-Enhanced-v<版本号>-portable.zip' } |
  Remove-Item -Force
```

## 注意事项

- **tag 不要随意移动**：`git tag -f` + 强推会改变 tag 指向，其他人已拉取的历史会不一致。只有刚推送、确认无人使用时才这么做（本次 v1.13.1 出现过一次）。
- **附件与 tag 是分开的**：附件挂在 Release 上，换 tag 不会自动换附件；替换附件用 `--clobber`。
- **Release 会自动生成源码包**（`Source code (zip)`），那是按 tag 打包的 git 内容，不是我们上传的 zip。
- 商店包（`*-store.zip`）与这里的分发包是两套，商店提交步骤见 `STORE_SUBMISSION.md`。
