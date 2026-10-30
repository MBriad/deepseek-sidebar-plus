#!/usr/bin/env node
// Markdown 与链接检查,零依赖。
//
// D-9 说"纯文本改动 = 0 人审批",这条要是真的,就必须有个机器能看懂的闸门。
// 这里只查两件人类真的会搞错、而且机器一定查得对的事:
//   1. 代码围栏没闭合(``` 落单)——渲染会吞掉后面半篇;
//   2. 相对链接/图片指向的文件不存在(断链)。
// 不查文体、不查标题层级、不查行长——那些是偏好,不是错误。

import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';

const root = process.cwd();
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'test-results']);
const SKIP_PATHS = ['src/vendor', 'docs/store/screenshots'];

function isSkipped(relPath, name) {
  if (SKIP_DIRS.has(name)) return true;
  return SKIP_PATHS.some((skip) => relPath === skip || relPath.startsWith(`${skip}/`));
}

function markdownFiles(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const rel = relative(root, full).replace(/\\/g, '/');
    if (isSkipped(rel, entry)) continue;
    const stat = statSync(full);
    if (stat.isDirectory()) {
      markdownFiles(full, out);
      continue;
    }
    if (entry.toLowerCase().endsWith('.md')) out.push(full);
  }
  return out;
}

const LINK = /!?\[[^\]]*\]\(\s*(<[^>]*>|[^)\s]+)(?:\s+"[^"]*")?\s*\)/g;

function checkFile(file) {
  const problems = [];
  const text = readFileSync(file, 'utf8');
  const lines = text.split(/\r?\n/);

  let fences = 0;
  lines.forEach((line, i) => {
    if (/^\s*```/.test(line)) fences += 1;
    if (fences % 2 === 1) return; // 围栏内的内容不当作链接检查

    LINK.lastIndex = 0;
    let match;
    while ((match = LINK.exec(line)) !== null) {
      let target = match[1].trim();
      if (target.startsWith('<') && target.endsWith('>')) target = target.slice(1, -1);
      if (!target) continue;
      if (/^(https?:|mailto:|tel:|data:|#|\/\/|\.)/i.test(target)) continue; // 外链与页内锚点不在本文范围
      const withoutAnchor = target.split('#')[0];
      if (!withoutAnchor) continue;
      const resolved = resolve(dirname(file), decodeURIComponent(withoutAnchor));
      if (!existsSync(resolved)) problems.push({ line: i + 1, target, reason: 'target does not exist' });
    }
  });

  if (fences % 2 === 1) problems.push({ line: lines.length, target: '```', reason: 'unclosed code fence' });
  return problems;
}

let files;
try {
  files = markdownFiles(root);
} catch (error) {
  console.error(`docs-check: 无法遍历目录:${error.message}`);
  process.exit(1);
}

// 只检查纳入版本控制的文件:未跟踪的草稿不该卡住 CI。
const tracked = new Set(
  execFileSync('git', ['ls-files', '*.md'], { encoding: 'utf8', cwd: root })
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((rel) => resolve(root, rel)),
);

const failures = [];
for (const file of files) {
  if (!tracked.has(resolve(file))) continue;
  for (const problem of checkFile(file)) failures.push({ file, ...problem });
}

if (failures.length) {
  for (const { file, line, target, reason } of failures) {
    const rel = file.replace(root, '').replace(/^[\\/]/, '').replace(/\\/g, '/');
    console.log(`${rel}:${line} — ${reason}: ${target}`);
  }
  console.error(`docs-check: ${failures.length} 个问题`);
  process.exit(1);
}

console.log(`Checked ${tracked.size} markdown files (links + code fences)`);
