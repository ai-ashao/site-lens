# P0 修复与测试记录

检查基线：`origin/main` 的 `fd24b91`。测试日期：2026-10-21（Asia/Shanghai）。

## 根因和修改

| 文件 | 根因 / 修复 |
| --- | --- |
| `background.js` | 内存 Set 和 fire-and-forget 全站扫描无法跨 Worker 生命周期；替换为持久队列调度、watchdog alarm、有限工作片和启动恢复。每日批次先一次性持久入队。 |
| `db.js` | 无持久任务、去重锁、超时和异常保护；新增 v2 jobs、事务入队/租约、检查点、token fencing、失败重试和截止时间；快照/变更/任务完成原子提交；异常候选延迟独立复核。 |
| `sitemap.js` | 跨域 loc 静默过滤、发现失败过度 fallback；改为逐文件步骤，所有声明入口和子文件都必须完整，严格拒绝不完整结果，解析增加超时。 |
| `offscreen.js` | 缺失 loc 被静默忽略；严格验证条目和 loc，解析错误终止扫描。 |
| `dashboard.js` | 仅补“等待扫描”“待复核”状态和历史文案；没有改变页面结构或移除现有功能。 |
| `tests/`、`package*.json`、`.github/workflows/tests.yml`、`.gitignore` | 加入开发测试与 CI；运行时仍是 MV3 + 原生 JavaScript + IndexedDB，无框架、后端或收费服务。 |
| `README.md`、`TESTING.md` | 记录保护策略、执行结果和边界。 |

## 重现命令

```sh
npm ci
npm test
npx playwright install chromium
npm run test:chrome
```

可用 `CHROME_EXECUTABLE=/absolute/path/to/chrome npm run test:chrome` 指定已有 Chrome for Testing。
Chrome 测试使用临时 Profile、自签名本地 HTTPS fixture 和临时端口；证书忽略、DNS 映射仅在该测试浏览器启用，不修改用户 Profile 或扩展安全配置。结束后关闭浏览器并删除临时目录。

## 实际执行结果

- `npm test`：27/27 通过，0 失败、0 跳过。Node.js v22.23.0；fake-indexeddb + jsdom，用于可控时间与故障注入。
- `npm run test:chrome`：7/7 集成检查通过。macOS ARM64，Google Chrome for Testing **153.0.8010.12**，真实加载未打包 MV3 扩展，使用原生 IndexedDB、Offscreen Document 和 DOMParser。
- `node --check`：所有根目录 JavaScript 通过。
- `git diff --check`：通过。
- 测试依赖安装后 `npm audit` 报告 0 vulnerabilities。它不是对扩展的全面安全审计。

Node 用例：首次基线、正常新增/移出/lastmod、子文件网络失败、跨域页面和子 Sitemap、无效 XML、缺失 loc、空根/空子文件/空索引、首次空结果、异常下降与延迟独立复核、复核不一致、重启续跑、旧租约失效、批量/手动并发去重、重复中断/整体超时、robots 失败、提交重放、v1 数据升级、多个声明入口、404 fallback、解析超时、网络 abort、子文件数异常减少。

真实 Chrome 集成：首次基线、正常增删、部分/跨域失败保留基线、空 Sitemap 保留基线、CDP 强制停止正在抓取子文件的 Worker 后由真实 alarm 唤醒并恢复、每日 alarm 执行两个站点的批次。

中断测试在已保存第一个子文件检查点后停止真实 Worker，确认恢复只重抓第二个子文件；最终没有重复变化记录。为避免测试空等，测试直接将持久租约设为过期，并提前重试 alarm；没有替换 Worker、IndexedDB 或 XML 解析实现。5 分钟异常复核、30 分钟超时和完整租约等待由 Node 的可控时钟验证；真实 Chrome 未等待这些完整时长。真实 Chrome 新增异常候选保留与独立完整复核提交检查，通过调整持久候选的时间和 alarm 加速，复核抓取、原生 IndexedDB 事务和最终变更记录均真实执行。

## PR #1 二次 Review

复查起点：`93a0c1b`。按 review 检查清单审查并发、数据安全、时间窗口与状态消费者，另进行了独立只读复查。没有合并 main。

确认并修复以下问题，置信度均为 10/10（代码路径与回归用例实际复现）：

| 级别 | 问题根因 | 修复与证据 |
| --- | --- | --- |
| P1 | boot 分开读取 sites 和 jobs，可能读取旧 scanning 状态，再看到刚完成的任务已删除，从而重复入队。 | `recoverJobs()` 在同一读写事务内检查站点状态、任务存在性和插入；覆盖提交与启动交错、多个启动与手动入队、已有租约不被替换。 |
| P1 | 租约和整体截止时间未在写回时复查，迟到的检查点或最终提交可在无人接管时越过租约/整体截止时间。 | `fenced()` 在写入事务中复查持久任务的 token、租约、截止时间与中断次数；过期失败清理仍仅在当前 token 匹配时执行。覆盖持有过期租约、摘要计算期间过期、旧失败处理器、最终检查点后重启；stale 结果不通知成功。 |
| P1 | 复核只比较完成时间差，采集过早但延迟提交可通过；旧候选也永久有效。 | 新任务使用稳定 scanId；候选绑定基线和任务，要求不同任务在候选后至少 5 分钟才开始，候选证据最长有效 30 分钟。过期候选重新建立并排队复核。覆盖提前采集/延后提交、隔天恢复、独立复核及其真实 Chrome 路径。 |
| P1 | 仅比较入口和文件数，替换子 Sitemap 后文件数相同或更多、URL 只少量下降时，仍会产生直接移出记录。 | 保存完整 `sitemapSources`，任何原有子文件消失都触发复核，指纹也纳入排序后的文件 URL。覆盖文件数相同/增加、复核时文件身份再次变化。 |

新增 `tests/recovery-review.test.cjs` 的 11 项回归；已有 16 项保留。最初新增回归实际复现了 6 项失败，修复后全套 27 项通过。Chrome 由原来的 6 项扩展到 7 项，均通过。新增测试直接执行 `background.js` 的启动/队列函数，另保留辅助函数的可控故障注入。

参考：[Chrome Worker 生命周期](https://developer.chrome.com/docs/extensions/develop/concepts/service-workers/lifecycle)、[IndexedDB 事务事件与自动提交](https://developer.mozilla.org/en-US/docs/Web/API/IDBTransaction)。

## 残余风险与保守边界

- 没有在 Chrome 116、用户日常 Chrome Profile、整机重启/睡眠、断电或接近 100,000 URL / 80 文件上限时做压力测试；这些不能由当前集成结果证明。
- 远端可以连续两次返回语法完整且相同、但业务上遗漏 URL 的 Sitemap。独立复核降低误报概率，无法证明远端内容完整；Sitemap 移出也不等于网页删除。
- 连续变化的大规模站点可能长时间处于待复核；空文件、跨域托管 Sitemap、robots 非 404/410 错误会保留旧快照并报错。这是准确性优先的明确策略。
- 旧版本快照未记录子 Sitemap URL；首次升级后的比较只能依靠旧计数/入口/URL 集合，文件身份保护从下一次成功快照起完整生效。没有修改或重建旧历史。
- 检查点会保存暂存 URL，较大站点有额外 IndexedDB 读写开销。下载至少一次、最终提交至多一次；中断发生在检查点前，允许重复 GET，不能保证网络请求恰好一次。
- alarm 依赖 Chrome 运行且允许延迟，不保证精确分钟级执行；超过任务整体截止时间的旧任务会失败并保留基线，下一次手动/每日扫描从头开始。
