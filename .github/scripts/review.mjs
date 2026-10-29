// 在 PR 上运行的 reviewer。
//
// 口径来源(按重要性):
//   1. 本次改动触及的模块的 REVIEW.md —— 由仓库所有者撰写
//   2. 下面的 REVIEWER_BRIEF —— 流程约定,只讲"怎么报",不讲"报什么"
//
// 本脚本只读 diff,不改仓库、不批准 PR。输出是一条 PR 评论。

import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, readFileSync } from 'node:fs';

const API = 'https://api.deepseek.com/chat/completions';
// API 只接受 deepseek-flash 和 deepseek-v4-pro 两个名字(传 deepseek-flash-4.1 会被拒)。
// 默认与 CI 保持一致:flash 更便宜,实测能产出可用的发现。
const MODEL = process.env.REVIEW_MODEL || 'deepseek-flash';
const MAX_DIFF_CHARS = 60000;
const MAX_FINDINGS = 5;
// 两个可用模型都是推理模型:max_tokens 同时被 reasoning 和正文消耗。
// 实测:8000 时两个模型都可能把预算全烧在思考上、正文返回空字符串;
// 32000 才能稳定产出。代价是慢(约 80 秒)且输出 token 多,所以上限可调。
const MAX_TOKENS = Number(process.env.REVIEW_MAX_TOKENS || 32000);
const SPEC_SECTIONS = ['What failure looks like here', 'Paths to skip', 'Evidence format', 'Nit budget'];

// 模块 → 该模块的 REVIEW.md。顺序有意义:先匹配到的生效。
// 只按前缀和平台文件枚举;根目录的文档类文件用下面的通配兜底,
// 免得每加一个根级 markdown 就要记得改这张表(AGENTS.md 的口径是「根目录 *.md」)。
const MODULES = [
  { prefix: 'src/content/', spec: 'src/content/REVIEW.md' },
  { prefix: 'src/vendor/', spec: null },
  { prefix: 'src/', spec: 'src/REVIEW.md' },
  { prefix: 'tests/', spec: 'tests/REVIEW.md' },
  { prefix: 'scripts/', spec: 'tests/REVIEW.md' },
  { prefix: 'docs/store/', spec: null },
  { prefix: 'docs/', spec: 'docs/REVIEW.md' },
  { files: ['background.js', 'rules.json', 'manifest.json'], spec: 'REVIEW.md' },
  { prefix: '.github/', spec: 'REVIEW.md' },
];

const BRIEF = `You are a code reviewer for a Microsoft Edge side-panel extension (Manifest V3, plain JS, no build step).
You only read. You cannot change files, commit, or approve.

Report only what passes all three gates:
1. It will break (blank panel, thrown error, feature entirely dead)
2. It is wrong behaviour (differs from what the user would expect, or from the surrounding logic)
3. It is a security / privacy risk (widened permissions, data leak, writing data where it should not go)
For documentation changes, also report: a path or filename that does not exist, a stated fact that contradicts the code, or two statements that contradict each other.

Do not report: style, naming, formatting, "consider extracting a helper", test coverage,
wording preferences, or anything you cannot pin to a concrete line.

Hard requirements:
- Every finding needs file:line plus a quoted snippet. A guess from a name is not a finding.
- At most ${MAX_FINDINGS} findings. If there is nothing solid, say so plainly instead of padding.
- Tag every finding as 严重 (breaks or security), 一般 (real defect, not fatal), or 既存 (already existed before this change - do not blame the diff for it).

Output: GitHub-flavoured markdown, in Chinese. Start with one line: 发现:严重 a / 一般 b / 既存 c.
Then one block per finding: bold tag, file:line, what breaks, and the smallest fix. Nothing else.`;

function run(cmd, args) {
  return execFileSync(cmd, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}

function changedFiles(range) {
  const out = run('git', ['diff', '--name-only', range]);
  return out.split('\n').map((s) => s.trim()).filter(Boolean);
}

function specFor(file) {
  for (const mod of MODULES) {
    if (mod.files && mod.files.includes(file)) return mod.spec;
    if (mod.prefix && file.startsWith(mod.prefix)) return mod.spec;
  }
  // 兜底:根目录的文档类文件(markdown 与 NOTICE)归文档模块。
  // 这样根 REVIEW.md 本身、以后新增的根级 markdown 都不会漏掉口径。
  if (!file.includes('/') && (/\.md$/i.test(file) || file === 'NOTICE')) return 'docs/REVIEW.md';
  return null;
}

function isSkipped(file) {
  return (
    file.startsWith('src/vendor/') ||
    file.startsWith('docs/store/') ||
    file === 'package-lock.json'
  );
}

function summarizeSpecs(files) {
  const specs = [...new Set(files.map(specFor).filter(Boolean))];
  return specs.map((spec) => {
    if (!existsSync(spec)) return { spec, text: `（${spec} 不存在）`, filled: [] };
    const text = readFileSync(spec, 'utf8');
    const filled = SPEC_SECTIONS.filter((section) => {
      const m = text.split(new RegExp(`^##\\s*${section}\\s*$`, 'm'))[1];
      if (!m) return false;
      return m.split(/^##\s/m)[0].replace(/<!--[\s\S]*?-->/g, '').trim().length > 0;
    });
    return { spec, text, filled };
  });
}

function buildPrompt(files, specs, diff, truncated) {
  const specBlock = specs.length
    ? specs
        .map(({ spec, text, filled }) => {
          const note = filled.length === 0
            ? `\n> 注意:这份 REVIEW.md 的所有小节都还是空的,所有者尚未填写。本次只能按上面的通用口径审,不要假装这里有模块专属标准。`
            : `\n> 已填写的小节:${filled.join('、')}`;
          return `### ${spec}${note}\n\n${text}`;
        })
        .join('\n\n')
    : '（本次改动没有匹配到任何模块的 REVIEW.md）';

  const truncNote = truncated
    ? `\n> ⚠️ diff 已截断至前 ${MAX_DIFF_CHARS} 字符,末尾不完整。不要据此判断语法完整性(缺大括号、文件被切断等),只评你确实看到的完整片段。\n`
    : '';

  return `改动涉及的文件:\n${files.map((f) => `- ${f}`).join('\n')}\n\n` +
    `---\n\n以下是仓库所有者为这些模块撰写的评审口径(REVIEW.md),请遵守:\n\n${specBlock}\n\n` +
    `---\n${truncNote}\n以下是 diff:\n\n\`\`\`diff\n${diff}\n\`\`\``;
}

async function callModel(system, user) {
  const res = await fetch(API, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${process.env.DEEPSEEK_API_KEY}`,
    },
    body: JSON.stringify({
      model: MODEL,
      temperature: 0.1,
      max_tokens: MAX_TOKENS,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
    }),
    signal: AbortSignal.timeout(300000),
  });
  if (!res.ok) throw new Error(`API ${res.status}: ${(await res.text()).slice(0, 400)}`);
  const json = await res.json();
  const msg = json.choices?.[0];
  return {
    content: msg?.message?.content?.trim() || '',
    finishReason: msg?.finish_reason || 'unknown',
    usage: json.usage || {},
  };
}

async function postComment(body) {
  const repo = process.env.GITHUB_REPOSITORY;
  const number = process.env.PR_NUMBER;
  const res = await fetch(`https://api.github.com/repos/${repo}/issues/${number}/comments`, {
    method: 'POST',
    headers: {
      accept: 'application/vnd.github+json',
      authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ body }),
  });
  if (!res.ok) throw new Error(`comment ${res.status}: ${(await res.text()).slice(0, 300)}`);
}

function stepSummary(text) {
  const path = process.env.GITHUB_STEP_SUMMARY;
  if (!path) return;
  try {
    appendFileSync(path, `${text}\n`);
  } catch {
    /* summary is best-effort */
  }
}

const { BASE_SHA, HEAD_SHA, PR_NUMBER } = process.env;

if (!process.env.DEEPSEEK_API_KEY) {
  console.log('DEEPSEEK_API_KEY 未配置(通常是 fork PR 拿不到 secret),跳过评审。');
  process.exit(0);
}

// 首轮审全量;后续 push 只审新增的那一段,避免同一条发现被反复报。
// 用 pull_request 事件自带的 before 字段,不依赖读上一轮评论(CI 里拿评论要额外的 API 调用)。
const BEFORE = process.env.EVENT_BEFORE || '';
const isIncremental =
  process.env.EVENT_ACTION === 'synchronize' && /^[0-9a-f]{40}$/.test(BEFORE) && !/^0+$/.test(BEFORE);
const diffRange = isIncremental ? `${BEFORE}..${HEAD_SHA}` : `${BASE_SHA}...${HEAD_SHA}`;

// 这一段全是 git 调用。评审是建议性的,基础设施失败不该把 PR 卡成红,
// 所以统一兜住:写 step summary 说明原因,然后正常退出。
let all;
let files;
let specs;
let diff;
let truncated;
try {
  all = changedFiles(diffRange);
  files = all.filter((f) => !isSkipped(f));

  if (files.length === 0) {
    console.log(`改动的 ${all.length} 个文件全部在跳过清单里,不发评论。`);
    process.exit(0);
  }

  specs = summarizeSpecs(files);
  diff = run('git', ['diff', diffRange, '--', ...files]).slice(0, MAX_DIFF_CHARS);
  truncated = diff.length >= MAX_DIFF_CHARS;
} catch (error) {
  console.log(`读取 diff 失败:${error.message}`);
  stepSummary(`## Agent review 未执行\n\n读取 diff 失败(评审是建议性的,不阻塞 PR):\n\n\`\`\`\n${error.message}\n\`\`\`\n`);
  process.exit(0);
}

let result;
try {
  result = await callModel(BRIEF, buildPrompt(files, specs, diff, truncated));
} catch (error) {
  console.log(`评审调用失败:${error.message}`);
  stepSummary(`## Agent review 未完成\n\n调用模型失败:\n\n\`\`\`\n${error.message}\n\`\`\`\n`);
  process.exit(0);
}

if (!result.content) {
  const detail =
    `finish_reason=${result.finishReason} ` +
    `completion_tokens=${result.usage.completion_tokens ?? '?'} ` +
    `reasoning_tokens=${result.usage.completion_tokens_details?.reasoning_tokens ?? '?'}`;
  console.log(`模型返回空正文,不发评论。${detail}`);
  stepSummary(`## Agent review 未产出内容\n\n模型没有返回正文,通常是被 max_tokens 截断在思考阶段。\n\n\`\`\`\n${detail}\n\`\`\`\n`);
  process.exit(0);
}

const findings = result.content;

const coverage = specs.length
  ? specs
      .map(({ spec, filled }) => `${spec}${filled.length ? '' : '（空,未填写）'}`)
      .join('、')
  : '无匹配模块';

const body = [
  '## Agent review',
  '',
  findings,
  '',
  '---',
  `<sub>diff ${files.length} 个文件${isIncremental ? '（增量:仅本次 push）' : '（全量:与 base 比对）'}${truncated ? `（已截断至 ${MAX_DIFF_CHARS} 字符）` : ''} · 口径:${coverage} · 模型:${MODEL}${result.finishReason === 'length' ? ' · ⚠️ 回答被 max_tokens 截断' : ''}</sub>`,
  `<sub>用量:${result.usage.completion_tokens ?? '?'} 输出 token(其中思考 ${result.usage.completion_tokens_details?.reasoning_tokens ?? '?'})</sub>`,
  '<sub>这是自动评审,**不构成批准**。每条发现仍需作者裁决,合并由所有者决定。</sub>',
].join('\n');

if (process.env.REVIEW_DRY_RUN) {
  console.log('=== DRY RUN,以下为将发布的评论 ===');
  console.log(body);
  process.exit(0);
}

try {
  await postComment(body);
  console.log(`已发布评论(diff ${files.length} 个文件,口径 ${coverage})`);
} catch (error) {
  console.log(`发评论失败:${error.message}`);
  stepSummary(`## Agent review 未能发布\n\n\`\`\`\n${error.message}\n\`\`\`\n`);
}
