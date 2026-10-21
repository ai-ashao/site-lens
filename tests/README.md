# 本地兼容性与侧栏布局检查

安装仅用于开发的测试依赖（扩展运行不需要安装）：

```sh
npm install --no-save --package-lock=false fake-indexeddb playwright
npx playwright install chromium
node --test tests/db-compat.test.cjs
node tests/db-compat.chrome.cjs
node tests/sidepanel-layout.chrome.cjs
```

可通过 `CHROME_EXECUTABLE=/absolute/path/to/chrome` 选择已有 Chrome for Testing。
测试均使用隔离的临时 Profile，不读取或修改用户浏览器数据。布局测试注入固定页面分析数据，验证呈现与交互，不代表真实网站 SEO 抓取测试。

2026-10-21 实际结果：

- 数据库兼容性 3/3 通过：新安装、已有 v1 升级、已有 v2 数据保留。
- Chrome 153.0.8010.12：Sitemap 历史读取与显示通过，未出现 VersionError。
- Chrome 153.0.8010.12：320、380、440、560、720px 五种宽度 × 九栏目，共 45 次切换通过，无页面或内容区横向溢出。
- 额外通过：右侧独立滚动、短窗口导航滚动、切换栏目回到内容顶部、总览跳转 Sitemap、侧栏打开监控后台、刷新按钮执行重新分析。
- 预览截图保存在系统临时目录的 `sitelens-layout-qa`；可通过 `SITELENS_QA_DIR` 指定输出目录。
