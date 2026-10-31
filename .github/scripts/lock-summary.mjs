// 依赖锁摘要。
//
// 为什么需要它:lockfile 是生成物,几百到几万行,放进 diff 没有评审信号(所以分类器
// 把它标成 model: false)。但"这次改动里有没有 lockfile"是评审必须知道的事实 ——
// 否则模型只看到 ci.yml 里的 `npm ci`,就会报"没提交 lockfile 就硬上 npm ci"。
// PR #19 上真实发生过一次误报,这条摘要就是那次的修复。
//
// 约定:这里只产出**纯数据**(版本号、包名),不产出任何指令性文本;
// 调用方负责把它当数据拼进提示词,并做截断/清洗。

export const MAX_PACKAGES = 400;
const MAX_DEPS = 40;

// 改了这些,就等于改了"装完之后是什么",对应的 lockfile 必须在同一轮更新。
const INSTALL_AFFECTING_FILES = new Set(['package.json', '.npmrc', '.nvmrc']);
const INSTALL_AFFECTING_PREFIXES = ['.github/workflows/'];

export function isInstallAffecting(path) {
  return (
    INSTALL_AFFECTING_FILES.has(path) ||
    INSTALL_AFFECTING_PREFIXES.some((prefix) => path.startsWith(prefix))
  );
}

function pickDeps(value) {
  return Object.fromEntries(Object.entries(value || {}).slice(0, MAX_DEPS));
}

export function summarizeLockfile(text) {
  const lock = JSON.parse(text);
  const entries = Object.entries(lock.packages || {}).filter(([name]) => name);
  const packages = entries
    .slice(0, MAX_PACKAGES)
    .map(([name, info]) => `${name.replace(/^node_modules\//, '')}@${info && info.version ? info.version : '?'}`)
    .sort();
  const root = (lock.packages && lock.packages['']) || {};
  return {
    lockfileVersion: lock.lockfileVersion || null,
    root: { dependencies: pickDeps(root.dependencies), devDependencies: pickDeps(root.devDependencies) },
    packages,
    omitted: Math.max(0, entries.length - packages.length),
  };
}
