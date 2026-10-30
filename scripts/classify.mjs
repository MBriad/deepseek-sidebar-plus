#!/usr/bin/env node
// PR 变更分类器 —— 确定性,无外部依赖,本地与 CI 用同一份。
//
// 为什么单独一个文件:风险档位决定"谁能合、要不要人工",这件事不能交给模型判断,
// 也不能在本地和 CI 各写一张路径表(两张表必然漂移)。
// reviewer 只从这里拿"审什么、按什么档审";本文件从不调用模型。
//
// 原则:**只升不降**。命中任一升级项,整份变更按最高档处理。
//
// 输出:默认 markdown(贴 PR);`--json` 给机器读。

import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const TIER_ORDER = ['low', 'medium', 'high'];
const maxTier = (...tiers) =>
  tiers.reduce((a, b) => (TIER_ORDER.indexOf(b) > TIER_ORDER.indexOf(a) ? b : a), 'low');

// 路径 → 模块 / 评审口径 / 基线档 / 是否送模型。顺序有意义:先匹配到的生效。
const PATH_RULES = [
  // 第三方整包:改了就是高危,而且不送模型(模型对着 vendored 代码只会说废话)。
  {
    prefix: 'src/vendor/',
    module: 'vendor',
    spec: null,
    tier: 'high',
    model: false,
    alwaysHuman: 'vendored 第三方代码,任何改动都属于 remote-code 红线',
  },
  { prefix: 'docs/store/', module: 'store-assets', spec: null, tier: 'low', model: false },
  // CI 与工作流:文章的口径是"任何 CI workflow 文件都必须有人看"。
  {
    prefix: '.github/workflows/',
    module: 'platform',
    spec: 'REVIEW.md',
    tier: 'high',
    alwaysHuman: 'CI / 工作流改动',
  },
  {
    prefix: '.github/',
    module: 'platform',
    spec: 'REVIEW.md',
    tier: 'high',
    alwaysHuman: 'CI 配置 / 评审脚本改动',
  },
  { prefix: 'src/content/', module: 'content', spec: 'src/content/REVIEW.md', tier: 'medium' },
  { prefix: 'src/', module: 'pages', spec: 'src/REVIEW.md', tier: 'medium' },
  { prefix: 'tests/', module: 'verification', spec: 'tests/REVIEW.md', tier: 'medium' },
  { prefix: 'scripts/', module: 'verification', spec: 'tests/REVIEW.md', tier: 'medium' },
  { prefix: '_locales/', module: 'docs', spec: 'docs/REVIEW.md', tier: 'low' },
  { prefix: 'docs/', module: 'docs', spec: 'docs/REVIEW.md', tier: 'low' },
  // 根 REVIEW.md 归平台模块(它审自己),不能掉进下面的"根目录 markdown"兜底。
  { files: ['REVIEW.md'], module: 'platform', spec: 'REVIEW.md', tier: 'medium' },
  { files: ['rules.json'], module: 'platform', spec: 'REVIEW.md', tier: 'high' },
  { files: ['manifest.json'], module: 'platform', spec: 'REVIEW.md', tier: 'medium' },
  { files: ['background.js'], module: 'platform', spec: 'REVIEW.md', tier: 'medium' },
  { files: ['package.json'], module: 'platform', spec: 'REVIEW.md', tier: 'medium' },
  { files: ['package-lock.json'], module: 'platform', spec: null, tier: 'low', model: false },
];

// 只对新增行做内容探测。命中即升级,从不降级。
const PROBES = [
  {
    id: 'manifest-surface',
    file: (f) => f === 'manifest.json',
    line: (t) =>
      /"(permissions|optional_permissions|host_permissions|content_scripts|web_accessible_resources|externally_connectable|all_frames|matches|run_at)"/.test(
        t,
      ),
    tier: 'high',
    reason: 'manifest 的权限 / 注入面发生变化',
  },
  {
    id: 'outbound-request',
    file: (f) => f.startsWith('src/') && !f.startsWith('src/vendor/'),
    line: (t) => /\bfetch\s*\(|\bXMLHttpRequest\b|\bsendBeacon\b|new WebSocket\b/.test(t),
    tier: 'high',
    reason: '新增对外网络请求;需要说明 URL 是否受页面内容或用户输入影响',
  },
  {
    id: 'storage-key',
    file: (f) => f.startsWith('src/') || f === 'background.js',
    line: (t) => /chrome\.storage\.[a-z]+\.(get|set|remove)\(\s*['"`]/.test(t),
    tier: 'high',
    reason: 'storage 键字面量出现;键是数据格式,改名等于迁移',
  },
  {
    id: 'review-caliber',
    file: (f) => /(^|\/)REVIEW\.md$/.test(f) || f === 'docs/PROJECT_CONTEXT.md',
    any: true,
    // 口径改动不是"高危权限",但必须有人看:它改变的是以后怎么审,不是这次审什么。
    tier: 'medium',
    reason: '评审口径本身被改动;本次必须按 base 版本的口径审,新口径需所有者确认',
  },
  {
    id: 'privacy-surface',
    file: (f) => f === 'PRIVACY.md' || f === 'docs/privacy.html',
    any: true,
    tier: 'medium',
    reason: '隐私声明被改动;若同一 PR 改了 storage 写入,两份必须同轮更新',
  },
  {
    id: 'dependency-change',
    file: (f) => f === 'package.json',
    line: (t) => /"(dependencies|devDependencies)"/.test(t),
    tier: 'high',
    reason: '依赖变化:供应链与安装体积',
  },
  {
    id: 'test-assertion-removed',
    file: (f) => f.startsWith('tests/'),
    removed: (t) => /\bexpect\s*\(|\bassert\./.test(t),
    tier: 'medium',
    reason: '测试断言被删除;需要写明为什么原来的断言不再成立',
  },
];

function git(args) {
  return execFileSync('git', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}

function defaultBase() {
  for (const ref of ['origin/main', 'main']) {
    try {
      git(['rev-parse', '--verify', '--quiet', ref]);
      return ref;
    } catch {
      /* try next */
    }
  }
  throw new Error('找不到 base 分支(origin/main 或 main),请用 --base 指定');
}

function changedFiles(range) {
  const out = git(['diff', '--name-status', range]);
  return out
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const parts = line.split('\t');
      const status = parts[0][0];
      const path = status === 'R' || status === 'C' ? parts[2] : parts[1];
      return { path, status, oldPath: status === 'R' || status === 'C' ? parts[1] : undefined };
    })
    .filter((entry) => entry.path);
}

// 解析 unified diff,只保留"新增行"(带新侧行号)与"删除行"(带旧侧行号)。
function parseDiff(range) {
  const byFile = new Map();
  let current = null;
  let newLine = 0;
  let oldLine = 0;

  for (const line of git(['diff', range]).split('\n')) {
    const header = /^diff --git a\/(.+) b\/(.+)$/.exec(line);
    if (header) {
      current = header[2];
      byFile.set(current, { added: [], removed: [] });
      continue;
    }
    if (!current) continue;
    if (line.startsWith('+++') || line.startsWith('---') || line.startsWith('index ')) continue;

    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (hunk) {
      oldLine = Number(hunk[1]);
      newLine = Number(hunk[2]);
      continue;
    }

    const bucket = byFile.get(current);
    if (line.startsWith('+')) {
      bucket.added.push({ line: newLine, text: line.slice(1) });
      newLine += 1;
    } else if (line.startsWith('-')) {
      bucket.removed.push({ line: oldLine, text: line.slice(1) });
      oldLine += 1;
    } else if (line.startsWith(' ') || line === '') {
      newLine += 1;
      oldLine += 1;
    }
  }
  return byFile;
}

function ruleFor(file) {
  for (const rule of PATH_RULES) {
    if (rule.files && rule.files.includes(file)) return rule;
    if (rule.prefix && file.startsWith(rule.prefix)) return rule;
  }
  // 根目录的 markdown / NOTICE 归文档模块;其余未归类的路径一律保守处理。
  if (!file.includes('/') && (/\.md$/i.test(file) || file === 'NOTICE' || file === 'LICENSE')) {
    return { module: 'docs', spec: 'docs/REVIEW.md', tier: 'low' };
  }
  return {
    module: 'unclassified',
    spec: null,
    tier: 'medium',
    alwaysHuman: '未归类的路径;先把它加进分类器的路径表,再合',
  };
}

function evidenceFor(tier) {
  if (tier === 'low') return ['check(Markdown 与链接检查包含在内)'];
  if (tier === 'medium') return ['check', 'test', 'screenshot'];
  return ['check', 'test', 'screenshot', 'owner-confirm'];
}

// 「下一步该干什么」——分类器的第三种输出。
// 档位说"谁能合",evidence 说"要交什么",advice 说"这次最容易漏的是什么"。
// 只写有成文依据的建议,不写泛泛的"请注意质量"。
const ADVICE = [
  {
    when: ({ files }) => files.some((f) => f.path.startsWith('.github/workflows/')),
    text: '工作流被改:旧 CI 的绿灯是旧工作流打出来的,不构成本次改动的证据。合并前必须在最新 main 上重跑(阶段 3),合并后用一个临时 PR 验证新工作流真的会触发。',
  },
  {
    when: ({ files }) => files.some((f) => f.path.startsWith('.github/scripts/')),
    text: '评审脚本被改:PR 上的评审仍用 base 版本执行(review.yml 会从 base 恢复),新脚本第一次真实运行在合并之后——本地先跑 REVIEW_DRY_RUN=1 验证输出。',
  },
  {
    when: ({ escalators }) => escalators.some((e) => e.reason.includes('评审口径')),
    text: '评审口径被改:本次按 base 版本的口径审,新口径从合并后的第一个 PR 起生效。',
  },
  {
    when: ({ files }) => files.some((f) => f.module === 'vendor'),
    text: 'vendored 代码不送模型评审:必须人工逐行看 diff,并确认没有引入远程代码。',
  },
  {
    when: ({ tier }) => tier === 'low',
    text: '低风险纯文本:Markdown 与链接检查绿即可合,不需要真人批准。',
  },
  {
    when: ({ tier }) => tier === 'high',
    text: '高风险:按 AGENTS.md 风险分级所有者逐条确认,不许合批。',
  },
];

export function classify({ base, head, range } = {}) {
  const baseRef = base || (range ? null : defaultBase());
  const span = range || `${baseRef}...${head || 'HEAD'}`;

  const changed = changedFiles(span);
  if (changed.length === 0) {
    return {
      range: span,
      files: [],
      modules: [],
      tier: 'low',
      escalators: [],
      needsHuman: false,
      needsHumanReason: [],
      requiredEvidence: evidenceFor('low'),
      advice: [],
      sendToModel: false,
    };
  }

  const diffs = parseDiff(span);
  const files = changed.map(({ path, status, oldPath }) => {
    const rule = ruleFor(path);
    const isPage = rule.module === 'docs' && /\.html?$/i.test(path);
    const tier = isPage ? maxTier(rule.tier, 'medium') : rule.tier;
    return {
      path,
      status,
      oldPath,
      module: rule.module,
      spec: rule.spec,
      tier,
      sendToModel: false,
      tierReason: isPage ? '文档页面(HTML),要截图' : undefined,
      alwaysHuman: rule.alwaysHuman,
    };
  });

  const escalators = [];
  for (const file of files) {
    const diff = diffs.get(file.path);
    for (const probe of PROBES) {
      if (!probe.file(file.path)) continue;
      if (probe.any) {
        escalators.push({ file: file.path, line: null, tier: probe.tier, reason: probe.reason });
        continue;
      }
      const hits = probe.line
        ? diff?.added ?? []
        : [];
      const removedHits = probe.removed ? diff?.removed ?? [] : [];
      for (const hit of hits) {
        if (!probe.line(hit.text)) continue;
        escalators.push({ file: file.path, line: hit.line, tier: probe.tier, reason: probe.reason });
        break; // 同一探针在同一文件里只记一次,免得一个 30 行的改动刷出 30 条
      }
      for (const hit of removedHits) {
        if (!probe.removed(hit.text)) continue;
        escalators.push({ file: file.path, line: hit.line, tier: probe.tier, reason: probe.reason });
        break;
      }
    }
  }

  const tier = maxTier(...files.map((f) => f.tier), ...escalators.map((e) => e.tier));

  // 同一原因只留一条:一个 PR 改 5 个 workflow 文件不该刷 5 条。
  const needsHumanReason = [
    ...(tier !== 'low' ? [`tier=${tier}`] : []),
    ...new Set(files.filter((f) => f.alwaysHuman).map((f) => f.alwaysHuman)),
  ];
  const dedupedReasons = needsHumanReason;

  const modules = [...new Map(files.map((f) => [f.module, f])).values()]
    .filter((f) => f.spec)
    .map((f) => ({ module: f.module, spec: f.spec, files: files.filter((x) => x.module === f.module).map((x) => x.path) }));

  return {
    range: span,
    files,
    modules,
    tier,
    escalators,
    needsHuman: dedupedReasons.length > 0,
    needsHumanReason: dedupedReasons,
    requiredEvidence: evidenceFor(tier),
    advice: ADVICE.filter((a) => a.when({ files, tier, escalators })).map((a) => a.text),
    sendToModel: files.some((f) => f.sendToModel),
  };
}

function toMarkdown(result) {
  const label = { low: '低', medium: '中', high: '高' }[result.tier];
  const lines = [`- Tier: **${label}** — ${result.files.length} 个文件`];
  if (result.escalators.length) {
    lines.push('- Escalators:');
    for (const item of result.escalators) {
      const at = item.line ? `${item.file}:${item.line}` : item.file;
      lines.push(`  - \`${at}\` — ${item.reason}`);
    }
  } else {
    lines.push('- Escalators: 无');
  }
  lines.push(
    `- Modules: ${
      result.modules.map((m) => `${m.module} → \`${m.spec}\``).join('、') || '无匹配口径'
    }`,
  );
  lines.push(
    `- Human required: ${result.needsHuman ? '**是**' : '否'} — ${
      result.needsHumanReason.join(';') || '低风险,CI 绿即放行'
    }`,
  );
  lines.push(`- Required evidence: ${result.requiredEvidence.join(' / ')}`);
  lines.push(
    `- Model review: ${result.sendToModel ? `需要(${result.files.filter((f) => f.sendToModel).length} 个文件)` : '不需要(全部在跳过清单)'}`,
  );
  if (result.advice.length) {
    lines.push('- Advice:');
    for (const text of result.advice) lines.push(`  - ${text}`);
  }
  return lines.join('\n');
}

function main(argv) {
  const flags = new Set(argv.filter((a) => a.startsWith('--')));
  const valueOf = (name) => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 ? argv[i + 1] : undefined;
  };

  const result = classify({ base: valueOf('base'), head: valueOf('head'), range: valueOf('range') });
  console.log(flags.has('--json') ? JSON.stringify(result, null, 2) : toMarkdown(result));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(`classify 失败:${error.message}`);
    process.exitCode = 1;
  }
}
