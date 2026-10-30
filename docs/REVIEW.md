# REVIEW.md — documentation and store material

<!-- Owner-authored. 只在 diff 触及本模块时加载;reviewer 不得修改本文件。 -->

Covers: `docs/`, and root-level markdown — `README.md`, `STORE_SUBMISSION.md`,
`PRIVACY.md`, `NOTICE`, `RELEASE_NOTES.md`, `INSTALL.md`, `AGENTS.md`,
`docs/DECISIONS.md`

## What failure looks like here
- 链接或文件名指向不存在的东西(`npm run check` 会抓已提交的部分)。
- 陈述与代码矛盾:例如说某条权限不存在、某个命令不存在。
- 两处说法互相矛盾(上一轮的 DNR 三域范围就出过这个)。
- 把"待办"写成"已完成"。

## Paths to skip
- `docs/store/` 下的商店素材与生成脚本。
- 措辞、排版、标题风格这类偏好。

## Evidence format
- 文档类改动给渲染截图;纯文本修改按 D-9 可省略,但要在 PR 里写明"纯文本"。

## Nit budget
- 至多 3 条。
