# SiteLens — Free SEO Analyzer & Sitemap Monitor

SiteLens is a free Chrome Extension (Manifest V3) that opens in **Chrome's Side Panel**, inspired by the free on-page analysis features of AITDK, plus persistent competitor Sitemap monitoring.

## Install and use
1. Download the repository as a ZIP and unzip it.
2. Open `chrome://extensions` and turn on Developer mode.
3. Choose **Load unpacked** and select the project folder.
4. Open any ordinary website and click the SiteLens toolbar icon.
5. The SEO analysis panel opens alongside the current web page. Choose tabs for Overview, Issues, Headings, Keywords, Images, Links, Structured Data, Domain and Sitemap.

The original full-screen multi-site monitoring dashboard is available via **监控后台**.

## Free data features
- Title, Meta Description, Meta Keywords, Canonical, Meta Robots, H1-H6, language and viewport.
- On-page SEO issue checks, heading hierarchy, approximate keyword density, images and alt status, internal/external links and nofollow/sponsored/ugc rel.
- Schema JSON-LD parsing, hreflang, Open Graph and Twitter metadata.
- RDAP domain registration, expiration (when published), registrar and nameservers.
- Optional A/AAAA/MX/NS lookups from Google DNS-over-HTTPS.
- Sitemap URL counts, newly observed URLs, removed Sitemap entries, lastmod changes, scan history, IndexedDB history and JSON/CSV export.

No paid API or server is required. Domain information and DNS require network connectivity. Visits, bounce rate and duration estimates are NOT fabricated: they are not generally available through a reliable free public API.

## Sitemap behavior
First successful scan builds the baseline; future successful scans compare the URL set. Note:
- Removed from Sitemap does not mean the actual page was deleted.
- A changed lastmod does not prove page content changed.
- Background automation is subject to Chrome execution/suspension rules.

## Known limitations and next work
- Some RDAP registries do not return expiration. Root-domain detection uses a limited common-suffix heuristic, not a complete Public Suffix List.
- Keyword density is a local visible-text approximation, not Google's search performance.
- Structured JSON parsing does not verify Rich Results eligibility.
- Chrome built-in and protected pages cannot be analyzed via script injection.
- The initial Sitemap crawler still needs P0 reliability improvements (resumable scanning, protection from anomalous/partial results).

Architecture: vanilla JS, Chrome Side Panel, scripting API, IndexedDB, offscreen XML parser. No npm, Python server or paid service.
