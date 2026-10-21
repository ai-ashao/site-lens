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

- `npm test`：16/16 通过，0 失败、0 跳过。Node.js v22.23.0；fake-indexeddb + jsdom，用于可控时间与故障注入。
- `npm run test:chrome`：6/6 集成检查通过。macOS ARM64，Google Chrome for Testing **153.0.8010.12**，真实加载未打包 MV3 扩展，使用原生 IndexedDB、Offscreen Document 和 DOMParser。
- `node --check`：所有根目录 JavaScript 通过。
- `git diff --check`：通过。
- 测试依赖安装后 `npm audit` 报告 0 vulnerabilities。它不是对扩展的全面安全审计。

Node 用例：首次基线、正常新增/移出/lastmod、子文件网络失败、跨域页面和子 Sitemap、无效 XML、缺失 loc、空根/空子文件/空索引、首次空结果、异常下降与延迟独立复核、复核不一致、重启续跑、旧租约失效、批量/手动并发去重、重复中断/整体超时、robots 失败、提交重放、v1 数据升级、多个声明入口、404 fallback、解析超时、网络 abort、子文件数异常减少。

真实 Chrome 集成：首次基线、正常增删、部分/跨域失败保留基线、空 Sitemap 保留基线、CDP 强制停止正在抓取子文件的 Worker 后由真实 alarm 唤醒并恢复、每日 alarm 执行两个站点的批次。

中断测试在已保存第一个子文件检查点后停止真实 Worker，确认恢复只重抓第二个子文件；最终没有重复变化记录。为避免测试空等，测试直接将持久租约设为过期，并提前重试 alarm；没有替换 Worker、IndexedDB 或 XML 解析实现。5 分钟异常复核、30 分钟超时和完整租约等待由 Node 的可控时钟验证；真实 Chrome 未等待这些完整时长。

## 残余风险与保守边界

- 没有在 Chrome 116、用户日常 Chrome Profile、整机重启/睡眠、断电或接近 100,000 URL / 80 文件上限时做压力测试；这些不能由当前集成结果证明。
- 远端可以连续两次返回语法完整且相同、但业务上遗漏 URL 的 Sitemap。独立复核降低误报概率，无法证明远端内容完整；Sitemap 移出也不等于网页删除。
- 连续变化的大规模站点可能长时间处于待复核；空文件、跨域托管 Sitemap、robots 非 404/410 错误会保留旧快照并报错。这是准确性优先的明确策略。
- 检查点会保存暂存 URL，较大站点有额外 IndexedDB 读写开销。下载至少一次、最终提交至多一次；中断发生在检查点前，允许重复 GET，不能保证网络请求恰好一次。
- alarm 依赖 Chrome 运行且允许延迟，不保证精确分钟级执行；超过任务整体截止时间的旧任务会失败并保留基线，下一次手动/每日扫描从头开始。
