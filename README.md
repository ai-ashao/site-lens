# SiteLens

**SiteLens — SEO Competitor Monitor** 是一个免费、本地优先的 Chrome 扩展，用于监控竞争对手网站的 Sitemap 和 URL 变化。

## 产品定位

- 打开竞品网站即可添加监控；
- 自动发现 robots.txt 里声明的 Sitemap，并支持 Sitemap Index；
- 首次扫描建立基线，以后比较新增 URL、从 Sitemap 移出的 URL、lastmod 变化；
- 用 IndexedDB 保存当前 URL 集合和历史变化，Chrome 重启后数据仍在；
- 支持 Chrome alarms 周期检查、手动扫描、CSV/JSON 导出；
- 不接入收费 API，不依赖第三方服务器，不要求用户提供 GSC 权限。

> **数据解释**：URL 移出 Sitemap ≠ 页面已被删除；lastmod 变化 ≠ 正文确定修改。只有完整成功的扫描才能触发“移出 URL”的判断。

## 安装

1. 下载/克隆本仓库；
2. Chrome 打开 `chrome://extensions`；
3. 开启右上角“开发者模式”；
4. 点击“加载已解压的扩展程序”，选择本项目根目录；
5. 打开目标网站，点击 SiteLens 图标添加监控；点击“打开监控面板”查看详细数据。

无需 `npm install`、无需本地 Python 服务。

## 技术

- Chrome Extension Manifest V3；纯 HTML/CSS/JavaScript，无构建依赖
- IndexedDB：站点、当前 URL、扫描记录与变更历史
- `chrome.alarms`：定时检查（要求 Chrome 运行；设备休眠期间不能保证按时执行）
- Offscreen Document + DOMParser：在 MV3 的 Service Worker 外解析 XML
- Sitemap：解析 robots.txt、sitemap.xml、sitemap_index.xml、wp-sitemap.xml；支持 XML、Sitemap Index、常见 gzip XML

## 数据与安全

- 监控数据只保存在当前 Chrome Profile 的本地 IndexedDB，不向 SiteLens 服务器上传。
- 首次扫描建立基线，不将全部既有 URL 误标为新增。
- 若 Sitemap 获取失败、存在解析错误或超出扫描限额，不覆盖旧的 URL 数据，也不产生错误的删除记录。
- 请求仅用于读取目标网站公开的 robots.txt 和 Sitemap；限制单次扫描规模，不绕过登录/反爬机制。
- 删除扩展或清除扩展数据可能导致历史丢失，请定期导出 JSON 备份。

## 首版范围

首版重点是 **Sitemap 可监控性与历史变更**，不显示竞品真实月访问量、跳出率等无法免费可靠获得的数据，也尚未集成 RDAP、Cloudflare Radar、页面正文差异监控。

## 开发路线

1. 批量监控与手动扫描
2. Sitemap 变更历史和 CSV/JSON 导出
3. 页面 TDK/H1 快照与变化检测
4. 跨站新增 URL/关键词聚类
