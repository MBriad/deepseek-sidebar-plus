#!/usr/bin/env node
// 打包 portable 扩展 —— 本地与 CI 共用这一份清单,避免两边靠人记文件列表(D-10)。
//
// 用法:
//   node scripts/build-portable.mjs                 # 输出到 dist\
//   node scripts/build-portable.mjs --out <dir>     # 输出到指定目录(用于本地试跑,不动 dist)
//
// 清掉 dist\portable 与上一份同名 portable zip;dist 下其他文件(例如改名备份)不动。
// Edge 会在被加载的扩展目录里生成 _metadata,那份东西不进包。

import { cpSync, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';

const root = process.cwd();
const args = process.argv.slice(2);
const outFlag = args.indexOf('--out');
if (outFlag >= 0 && !args[outFlag + 1]) throw new Error('--out 需要一个目录参数');
const outRoot = resolve(root, outFlag >= 0 ? args[outFlag + 1] : 'dist');
if (outRoot === root) throw new Error('--out 不能是仓库根目录');

const INCLUDE = [
  'manifest.json',
  'background.js',
  'rules.json',
  'INSTALL.md',
  'PRIVACY.md',
  'LICENSE',
  'NOTICE',
  'icons',
  'src',
  '_locales'
];

for (const item of INCLUDE) {
  if (!existsSync(join(root, item))) throw new Error(`missing ${item}`);
}

const portableDir = join(outRoot, 'portable');
const zipPath = join(outRoot, 'deepseek-sidebar-plus-portable.zip');

rmSync(portableDir, { recursive: true, force: true });
mkdirSync(portableDir, { recursive: true });
for (const item of INCLUDE) {
  cpSync(join(root, item), join(portableDir, item), { recursive: true });
}
rmSync(join(portableDir, '_metadata'), { recursive: true, force: true });

const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const manifest = JSON.parse(readFileSync(join(portableDir, 'manifest.json'), 'utf8'));
if (manifest.version !== pkg.version) {
  throw new Error(`version mismatch: manifest ${manifest.version} vs package ${pkg.version}`);
}

// Windows 自带 bsdtar(-a 按扩展名生成 zip);Linux/CI 用 zip。
const command = process.platform === 'win32' ? 'tar' : 'zip';
const zipArgs = process.platform === 'win32'
  ? ['-a', '-c', '-f', zipPath, ...INCLUDE]
  : ['-qr', zipPath, ...INCLUDE];

rmSync(zipPath, { force: true });
const result = spawnSync(command, zipArgs, { cwd: portableDir, stdio: 'inherit' });
if (result.error) throw result.error;
if (result.status !== 0) throw new Error(`${command} exited with ${result.status}`);

console.log(`portable: ${portableDir}`);
console.log(`zip:      ${zipPath} (manifest ${manifest.version})`);
