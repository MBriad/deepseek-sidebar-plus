# REVIEW.md — verification

<!-- Owner-authored. 只在 diff 触及本模块时加载;reviewer 不得修改本文件。 -->

Covers: `tests/`, `scripts/`

## What failure looks like here
- 断言写的是用户看不见的东西:函数名、storage 键名、CSS class。
- 用真实站点替换了 mock 站点(P-4):新用例必须另起一套,不许替换现有的。
- 为了让测试变绿而改断言,而不是改行为。
- 新增用例只有成功路径,没有任何失败路径。
- 测试没覆盖我能感受到的行为,只在内部实现上挑刺:这种用例全绿也不说明功能对。

## Paths to skip
- `tests/fixtures/*.pdf`:二进制夹具。
- `waitFor` 的轮询间隔与超时参数。
- 测试里 mock 页面的 HTML 写法:它不是产品代码。

## Evidence format
- 附 `npm test` 的真实输出。
- 新增用例要说明"它证明了哪个用户可见行为",而不是"提高了覆盖率"。

## Nit budget
- 至多 2 条。
