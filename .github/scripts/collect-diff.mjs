#!/usr/bin/env node
// 在**没有密钥**的 job 里运行:把评审需要的东西从 PR 上摘下来,写成一个 artifact。
//
// 为什么要有这一步:持密钥的 job 不应该碰 PR 的工作区。这里做的所有读取都经过
// `git show`,不读文件系统——符号链接、路径穿越从源头上不存在。
//
// 产出(目录名与条目名都固定,调用方不传名字):
//   diff.txt           ← 已截断的 diff
//   files.json         ← { 路径: 新侧内容 },只含送模型的文件、有单文件与总量上限
//   classification.json← 分类器结果(哪些文件要送模型、用哪份 REVIEW.md)
//   meta.json          ← 基准 sha、是否截断、文件数

import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { classify } from '../../scripts/classify.mjs';

const MAX_DIFF_CHARS = 60000;
const MAX_FILE_CHARS = 120000;
const MAX_TOTAL_CHARS = 1500000;

const argv = process.argv.slice(2);
const valueOf = (name) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
};

const prDir = resolve(valueOf('pr') || '.');
const outDir = resolve(valueOf('out') || 'review-input');
const baseSha = process.env.BASE_SHA || '';
const headSha = process.env.HEAD_SHA || '';

if (!baseSha || !headSha) {
  console.error('collect-diff: BASE_SHA / HEAD_SHA 未设置');
  process.exit(1);
}

const git = (args) => execFileSync('git', ['-C', prDir, ...args], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });

// 路径只接受"仓库内的相对路径"。真正的防线是不用它做文件访问,
// 这里过滤只是不想让垃圾进到 artifact 里。
function isSafePath(path) {
  if (!path || path.includes('\0') || path.includes('\\')) return false;
  if (path.startsWith('/') || /^[A-Za-z]:/.test(path)) return false;
  return !path.split('/').includes('..');
}

// 首轮审全量;后续 push 只审新增的那一段(D-7),避免同一条发现被反复报。
const eventAction = process.env.EVENT_ACTION || '';
const beforeSha = process.env.EVENT_BEFORE || '';
let incremental =
  eventAction === 'synchronize' && /^[0-9a-f]{40}$/.test(beforeSha) && !/^0+$/.test(beforeSha);

// force-push 之后,事件里的 before 指向一个在新 checkout 里根本不存在的 commit
// (PR ref 只带它自己的历史)。这时增量范围算不出来,退回全量 —— 否则整个采集直接失败。
if (incremental) {
  try {
    execFileSync('git', ['-C', prDir, 'cat-file', '-e', `${beforeSha}^{commit}`], { stdio: 'ignore' });
  } catch {
    console.log(`collect-diff: before ${beforeSha.slice(0, 8)} 不在本次 checkout 里,按全量处理`);
    incremental = false;
  }
}

const range = incremental ? `${beforeSha}..${headSha}` : `${baseSha}...${headSha}`;

const cwd = process.cwd();
let classification;
try {
  process.chdir(prDir); // 分类器按 cwd 跑 git
  classification = classify({ range });
} catch (error) {
  console.error(`collect-diff: 分类失败:${error.message}`);
  process.exit(1);
} finally {
  process.chdir(cwd);
}

const modelFiles = classification.files.filter((f) => f.sendToModel && isSafePath(f.path)).map((f) => f.path);

const diffFull = modelFiles.length ? git(['diff', range, '--', ...modelFiles]) : '';
const diff = diffFull.slice(0, MAX_DIFF_CHARS);

const contents = {};
let total = 0;
let skippedLarge = 0;
for (const path of modelFiles) {
  let text;
  try {
    text = git(['show', `${headSha}:${path}`]);
  } catch {
    continue; // 本次被删除的文件没有新侧内容
  }
  if (text.length > MAX_FILE_CHARS) {
    skippedLarge += 1;
    continue;
  }
  if (total + text.length > MAX_TOTAL_CHARS) break;
  contents[path] = text;
  total += text.length;
}

mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, 'diff.txt'), diff);
writeFileSync(join(outDir, 'files.json'), JSON.stringify(contents));
writeFileSync(join(outDir, 'classification.json'), JSON.stringify(classification));
writeFileSync(
  join(outDir, 'meta.json'),
  JSON.stringify(
    {
      base: baseSha,
      head: headSha,
      incremental,
      diffTruncated: diffFull.length > MAX_DIFF_CHARS,
      files: modelFiles.length,
      included: Object.keys(contents).length,
      skippedLarge,
      chars: total,
    },
    null,
    2,
  ),
);

console.log(
  `collect-diff: ${modelFiles.length} 个文件待评,diff ${diff.length} 字符` +
    `(截断:${diffFull.length > MAX_DIFF_CHARS}),内容 ${Object.keys(contents).length} 份 / ${total} 字符`,
);
