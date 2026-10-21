/* SiteLens: free on-page analyzer and sitemap inspector. All user-facing HTML is escaped. */
const $ = (id) => document.getElementById(id);
const current = {tab:null, page:null, domain:null, site:null, rdap:null, rdapError:null, dns:null, selected:'overview', seq:0, scanning:false};
const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
const fmtDate = value => value ? new Date(value).toLocaleString('zh-CN',{hour12:false}) : '—';
const fmtInt = value => Number(value || 0).toLocaleString('en-US');
const niceUrl = value => {
  if(!value)return '<span class="muted">未设置</span>';
  try{const parsed=new URL(value);if(!['https:','http:'].includes(parsed.protocol))return `<span class="muted break">${escapeHtml(value)}</span>`;}
  catch{return `<span class="muted break">${escapeHtml(value)}</span>`;}
  return `<a target="_blank" rel="noopener noreferrer" href="${escapeHtml(value)}">${escapeHtml(value)}</a>`;
};
const nchar = value => [...String(value || '')].length;
const tag = (text,kind='') => `<span class="tag ${kind}">${escapeHtml(text)}</span>`;
const noData = (text='未发现相关信息') => `<div class="empty">${escapeHtml(text)}</div>`;
const card = (title,content,extra='') => `<section class="card"><div class="section-head"><h2>${escapeHtml(title)}</h2>${extra}</div>${content}</section>`;
const field = (name,value,more='') => `<div class="field"><div class="field-label">${escapeHtml(name)}</div><div class="field-value${value ? '' : ' missing'}">${value ? escapeHtml(value) : '未设置'}</div>${more ? '<div class="field-sub">'+escapeHtml(more)+'</div>':''}</div>`;
const metrics = items => `<div class="metrics">${items.map(([label,value])=>`<div class="metric"><span class="metric-label">${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong></div>`).join('')}</div>`;
function mainTabContent(html){$('content').innerHTML=html;}
function rootDomain(host){
  // Lightweight public-suffix approximation; special-case common multi-part suffixes.
  // Do not pretend this is a complete PSL implementation.
  const parts=host.toLowerCase().replace(/\.$/,'').split('.');
  if(parts.length<=2)return host.toLowerCase();
  const suffix2=parts.slice(-2).join('.');
  const known=new Set(['co.uk','org.uk','ac.uk','gov.uk','com.au','net.au','org.au','co.nz','com.br','com.cn','net.cn','org.cn','com.tw','com.hk','co.jp','co.kr','co.in','com.sg','com.mx','com.tr','co.za']);
  return parts.slice(known.has(suffix2)?-3:-2).join('.');
}
async function send(type,data={}){
  const result=await chrome.runtime.sendMessage({type,...data});
  if(!result?.ok)throw new Error(result?.error||'插件后台处理失败');
  return result.data;
}
async function loadPage(){
  const seq=++current.seq;
  current.page=null; current.site=null; current.rdap=null; current.rdapError=null;current.dns=null;
  $('site-status').textContent='分析中';
  const tabs=await chrome.tabs.query({active:true,currentWindow:true});
  const tab=tabs[0];
  current.tab=tab || null;
  if(!tab?.id || !tab.url || !/^https?:\/\//i.test(tab.url)){
    current.domain=null; $('site-host').textContent='无法分析此标签页'; $('site-url').textContent='';
    $('site-status').textContent='不支持';
    mainTabContent(card('页面限制','<div class="warning">请打开普通 HTTP(S) 网站。Chrome 内部页面、新标签页、扩展页面和某些受保护网页无法注入分析脚本。</div>'));
    return;
  }
  const url=new URL(tab.url);current.domain=url.hostname.toLowerCase().replace(/^www\./,'');
  $('site-host').textContent=current.domain;
  $('site-url').textContent=url.pathname+(url.search||'');
  mainTabContent('<p class="loading">正在读取页面 SEO 数据…</p>');
  const siteTask=SiteLensDB.getSite(current.domain).catch(()=>null);
  const domainTask=fetchRdap(rootDomain(current.domain)).catch(error=>({error:String(error.message||error)}));
  try{
    const injected=await chrome.scripting.executeScript({target:{tabId:tab.id},func:extractPageSEO});
    if(seq!==current.seq)return;
    current.page=injected?.[0]?.result||null;
    if(!current.page)throw new Error('未收到页面分析结果');
    $('site-status').textContent='已分析';
    current.site=await siteTask;
    render();
  }catch(error){
    if(seq!==current.seq)return;
    $('site-status').textContent='受限制';
    mainTabContent(card('页面分析失败',`<div class="warning bad-warning">${escapeHtml(error.message||error)}</div><p class="small muted">可尝试刷新目标网页，再点击上方重新分析。Sitemap 监控仍可独立使用。</p>`));
    current.site=await siteTask;
    if(current.selected==='sitemap'||current.selected==='domain')render();
  }
  const rdap=await domainTask;
  if(seq!==current.seq)return;
  if(rdap?.error)current.rdapError=rdap.error;else current.rdap=rdap;
  render();
}
async function fetchJsonWithTimeout(url,ms=12000){
  const c=new AbortController();const t=setTimeout(()=>c.abort(),ms);
  try{const r=await fetch(url,{signal:c.signal,credentials:'omit',cache:'no-store'});if(!r.ok)throw new Error('HTTP '+r.status);
    const data=await r.json();if(!data||typeof data!=='object')throw new Error('响应不是 JSON');return data;
  }finally{clearTimeout(t);}
}
async function fetchRdap(domain){
  const data=await fetchJsonWithTimeout('https://rdap.org/domain/'+encodeURIComponent(domain));
  const events=Array.isArray(data.events)?data.events:[];
  const event=(types)=>events.find(e=>types.includes(String(e.eventAction||'').toLowerCase()))?.eventDate||null;
  const registrar=(data.entities||[]).find(e=>Array.isArray(e.roles)&&e.roles.includes('registrar'));
  const vcard=registrar?.vcardArray?.[1]||[];
  const registrarName=vcard.find(e=>e[0]==='fn')?.[3]||registrar?.handle||null;
  return {domain,created:event(['registration']),expires:event(['expiration']),changed:event(['last changed','last update of rdap database']),
    registrar:registrarName,nameservers:(data.nameservers||[]).map(x=>x.ldhName).filter(Boolean),
    statuses:Array.isArray(data.status)?data.status:[],handle:data.handle||'',source:'RDAP',
    age:event(['registration'])?Math.max(0,((Date.now()-Date.parse(event(['registration'])))/(365.2425*864e5))):null};
}
async function fetchDNS(){
  if(!current.domain)return;
  const d=rootDomain(current.domain);
  current.dns={loading:true};render();
  const kinds=['A','AAAA','MX','NS'];
  const result=await Promise.all(kinds.map(async type=>{
    try{const json=await fetchJsonWithTimeout('https://dns.google/resolve?name='+encodeURIComponent(d)+'&type='+type,9000);
      return [type,(json.Answer||[]).map(x=>x.data).filter(Boolean)];
    }catch(err){return [type,['查询失败：'+String(err.message||err)]];}
  }));
  current.dns=Object.fromEntries(result);render();
}
function getIssues(p){
  const issues=[]; const push=(severity,title,desc)=>issues.push({severity,title,desc});
  if(!p.title)push('bad','缺少 Title','页面没有设置 title 元素。');
  else if(nchar(p.title)>65)push('warn','Title 可能过长','建议结合 SERP 实际展示检查，字符长度不是硬性排名规则。');
  else if(nchar(p.title)<15)push('warn','Title 较短','检查是否准确覆盖页面主要搜索意图。');
  if(!p.description)push('warn','缺少 Meta Description','Google 可能从正文自动生成摘要。');
  else if(nchar(p.description)>165)push('warn','Description 可能过长','搜索摘要可能被截断或重写。');
  if(p.headings.filter(h=>h.level===1).length===0)push('warn','缺少 H1','页面没有 H1 标题。');
  if(p.headings.filter(h=>h.level===1).length>1)push('warn','多个 H1','不是硬性 SEO 错误，但应确认标题层级语义清晰。');
  if(!p.canonical)push('warn','未设置 Canonical','可考虑声明首选规范 URL。');
  if(p.canonical && p.canonical!==p.url.split('#')[0])push('warn','Canonical 指向其他地址','可能是正常规范化设置，请核实是否符合预期。');
  if(p.imageStats.missingAlt)push('warn','存在缺少 Alt 的图片',`${p.imageStats.missingAlt} 张图片缺少或使用空 alt；装饰图不一定需要描述文字。`);
  if(p.schemas.some(s=>!s.valid))push('bad','JSON-LD 解析失败','发现至少一段无法解析的 JSON-LD。');
  if(p.metaRobots && /noindex/i.test(p.metaRobots))push('warn','页面声明 noindex','该设置可能阻止页面进入搜索索引。');
  if(!p.htmlLang)push('warn','缺少 HTML lang','建议为页面声明主语言。');
  return issues;
}
function render(){
  const p=current.page;
  for(const btn of document.querySelectorAll('#tabs button')){
    const active=btn.dataset.tab===current.selected;
    btn.classList.toggle('active',active);
    if(active)btn.setAttribute('aria-current','page');else btn.removeAttribute('aria-current');
  }
  if(!current.domain)return;
  if(!p && !['sitemap','domain'].includes(current.selected)){
    mainTabContent(card('无法读取页面', '<div class="warning">当前页面暂不可分析。可以切换到「域名」或「Sitemap」查看公开数据。</div>'));
    return;
  }
  const functions={overview:renderOverview,issues:renderIssues,headings:renderHeadings,density:renderDensity,
    images:renderImages,links:renderLinks,structured:renderStructured,domain:renderDomain,sitemap:renderSitemap};
  mainTabContent(functions[current.selected]());
}
function renderOverview(){
  const p=current.page;const titleLength=nchar(p.title),descLength=nchar(p.description);
  const h1=p.headings.filter(h=>h.level===1);
  const head=`<div class="page-heading"><h1>页面总览</h1><span>当前页面的 SEO 信息</span></div><div class="overview-status"><span>标题<b>${p.title?'已设置':'缺失'}</b></span><span>SEO 问题<b>${getIssues(p).length}</b></span><span>H1<b>${h1.length}</b></span></div>`;
  const detail=(label,value,count='',limit=0,hint='')=>`<div class="overview-field"><div class="overview-label"><span>${label}</span>${count!==''?`<span title="字符数仅供排版参考，不是排名规则" class="length-badge ${count>limit?'warn':''}">${count} / ${limit}</span>`:''}</div><div class="overview-value">${value?escapeHtml(value):'<span class="muted">未设置</span>'}</div>${hint?'<div class="field-sub">'+escapeHtml(hint)+'</div>':''}</div>`;
  const titleMeta='<section class="overview-sheet" aria-label="页面标题与描述">'+detail('Title',p.title,titleLength,60)+detail('Description',p.description,descLength,160)+detail('Keywords',p.keywords,'',0,'仅供查看，Google 通常不将 meta keywords 用于网页排名')+detail('URL',p.url)+detail('Canonical',p.canonical)+'</section>';
  const pageSummary=card('页面结构',metrics([['H2',p.headings.filter(h=>h.level===2).length],['图片',p.imageStats.total],['链接',p.linkStats.total]])+field('H1',h1.map(x=>x.text).join(' / '))+field('Viewport',p.viewport)+field('Robots（Meta）',p.metaRobots)+field('页面语言',p.htmlLang));
  const social=card('Social & Metadata',field('OG Title',p.social.ogTitle)+field('OG Description',p.social.ogDescription)+field('OG Image',p.social.ogImage)+field('Twitter Card',p.social.twitterCard));
  const r=current.rdap;
  const whois=card('域名信息',r?`<table class="domain-summary"><tbody><tr><th scope="row">注册日期</th><td>${escapeHtml(r.created?.slice(0,10)||'未知')}</td></tr><tr><th scope="row">到期日期</th><td>${escapeHtml(r.expires?.slice(0,10)||'未知')}</td></tr><tr><th scope="row">域名年龄</th><td>${r.age===null?'未知':r.age.toFixed(1)+' 年'}</td></tr></tbody></table><div class="note">来源：RDAP · 部分 TLD 不提供到期信息</div>`:
    `<div class="muted small">${current.rdapError?'RDAP 查询失败：'+escapeHtml(current.rdapError):'正在查询公开 RDAP 数据…'}</div>`);
  const sitemap=card('Sitemap 监控',current.site?metrics([['当前 URL',fmtInt(current.site.lastCount)],['最近新增','+'+fmtInt(current.site.lastAdded)],['最近移出','-'+fmtInt(current.site.lastRemoved)]])+'<button class="button secondary" data-action="goto-sitemap">查看 Sitemap 变化 →</button>':
    `<p class="muted small">当前网站尚未加入监控。可以免费保存 Sitemap 快照，追踪后续变化。</p><button class="button secondary" data-action="goto-sitemap">添加并扫描 Sitemap →</button>`);
  return `${head}${whois}${titleMeta}${pageSummary}${sitemap}${social}`;
}
function renderIssues(){const p=current.page;const issues=getIssues(p);return `<div class="eyebrow">SEO ISSUES</div>${metrics([['问题数',issues.length],['重点问题',issues.filter(x=>x.severity==='bad').length],['提醒',issues.filter(x=>x.severity==='warn').length]])}`+
  card('页面 SEO 检查',issues.length?issues.map(i=>`<div class="issue ${i.severity}"><strong>${escapeHtml(i.title)}</strong><p>${escapeHtml(i.desc)}</p></div>`).join(''):'<div class="good-panel">当前规则下未发现明显的页面 SEO 问题。此结果不代表完整的 Google SEO 审核。</div>');}
function renderHeadings(){const p=current.page;const counts=[1,2,3,4,5,6].map(n=>['H'+n,p.headings.filter(h=>h.level===n).length]);
  return `<div class="eyebrow">HEADING STRUCTURE</div>${metrics(counts.slice(0,3))}`+card('H1–H6 标题层级',p.headings.length?`<div class="scroll-list">${p.headings.slice(0,200).map(h=>`<div class="heading h${h.level}"><span class="type">H${h.level}</span>${escapeHtml(h.text)||'<span class="muted">（空标题）</span>'}</div>`).join('')}</div>`:noData('未发现 H1–H6 标题'))+card('完整标题统计',counts.map(([a,b])=>`<div class="kv"><span>${a}</span><strong>${b}</strong></div>`).join(''));}
function renderDensity(){const p=current.page;return `<div class="eyebrow">KEYWORD DENSITY</div>${metrics([['正文词数',fmtInt(p.wordCount)],['不同词汇',fmtInt(p.keywordUnique)],['显示关键词',Math.min(p.keywordStats.length,30)]])}`+
  card('页面高频关键词','<p class="note">只统计当前网页可见文本的近似词频，不等于搜索引擎实际使用的关键词权重。</p>'+
    (p.keywordStats.length?`<table class="mini-table"><thead><tr><th>关键词</th><th>次数 / 词频</th></tr></thead><tbody>${p.keywordStats.slice(0,30).map(k=>`<tr><td>${escapeHtml(k.word)}<div class="meter"><div style="width:${Math.min(100,k.percent*15)}%"></div></div></td><td>${k.count} / ${k.percent.toFixed(2)}%</td></tr>`).join('')}</tbody></table>`:noData()));}
function renderImages(){const p=current.page;return `<div class="eyebrow">IMAGE ANALYSIS</div>${metrics([['图片总数',p.imageStats.total],['空/缺 Alt',p.imageStats.missingAlt],['延迟加载',p.imageStats.lazy]])}`+
  card('图片清单（前 200 项）',p.images.length?`<div class="scroll-list">${p.images.map(img=>`<div class="item"><div class="item-title">${niceUrl(img.src)}</div><div class="item-detail">Alt：${escapeHtml(img.alt)||'（空）'} ${img.missingAlt?tag('缺少 Alt','warn'):''}</div></div>`).join('')}</div>`:noData('未发现 img 标签'));
}
function renderLinks(){const p=current.page;return `<div class="eyebrow">LINK ANALYSIS</div>${metrics([['链接总数',p.linkStats.total],['站内链接',p.linkStats.internal],['站外链接',p.linkStats.external]])}`+
  card('链接属性',metrics([['Nofollow',p.linkStats.nofollow],['Sponsored',p.linkStats.sponsored],['UGC',p.linkStats.ugc]])+
    '<div class="note">以下为最多 200 条链接，不包含状态码检测。</div>')+
  card('页面链接',p.links.length?`<div class="scroll-list">${p.links.map(x=>`<div class="item"><div class="item-title">${niceUrl(x.href)}</div><div class="item-detail">${escapeHtml(x.text||'（无文本）')} · ${x.external?'外链':'内链'}${x.rel?' · '+escapeHtml(x.rel):''}</div></div>`).join('')}</div>`:noData());
}
function renderStructured(){const p=current.page;return `<div class="eyebrow">STRUCTURED DATA + SOCIAL</div>${metrics([['JSON-LD',p.schemas.length],['Hreflang',p.hreflangs.length],['Meta 标签',p.metaTags.length]])}`+
  card('JSON-LD',p.schemas.length?p.schemas.map((s,i)=>`<div class="item"><div class="row-between"><strong>Schema #${i+1} · ${escapeHtml(s.type||'未知类型')}</strong>${tag(s.valid?'有效 JSON':'解析失败',s.valid?'good':'bad')}</div>${s.valid?'<div class="item-detail">属性：'+escapeHtml(s.keys.join(', '))+'</div>':'<div class="item-detail">'+escapeHtml(s.error)+'</div>'}</div>`).join(''):noData('未发现 JSON-LD'))+
  card('Hreflang',p.hreflangs.length?p.hreflangs.map(x=>`<div class="kv"><span>${escapeHtml(x.lang)}</span><strong>${niceUrl(x.href)}</strong></div>`).join(''):noData('未发现 hreflang'))+
  card('Social Metadata',field('og:title',p.social.ogTitle)+field('og:description',p.social.ogDescription)+field('og:image',p.social.ogImage)+field('twitter:card',p.social.twitterCard))+
  card('全部 Meta（前 100）',p.metaTags.length?p.metaTags.map(x=>field(x.name,x.content)).join(''):noData());
}
function renderDomain(){const r=current.rdap;let html=`<div class="eyebrow">WHOIS / RDAP + DNS</div>`;
  if(!r){html+=card('公开 RDAP 域名记录',current.rdapError?`<div class="warning">查询失败：${escapeHtml(current.rdapError)}。有些域名的注册局不开放 RDAP 数据。</div>`:'<p class="loading">正在加载注册信息…</p>');}
  else html+=metrics([['域名年龄',r.age===null?'未知':r.age.toFixed(1)+' 年'],['注册日期',r.created?.slice(0,10)||'未知'],['到期日期',r.expires?.slice(0,10)||'未知']])+
    card('域名信息',field('根域名（近似识别）',r.domain)+field('注册商',r.registrar)+field('注册日期',r.created)+field('到期日期',r.expires)+field('最后更新',r.changed)+field('名称服务器',r.nameservers.join(', '))+field('状态',r.statuses.join(', ')))+
    '<div class="note">RDAP 日期来自注册局公开数据。部分顶级域名不提供到期日期；复杂后缀的根域名识别可能需要人工核实。</div>';
  let dnsHtml='';
  if(current.dns?.loading)dnsHtml='<p class="loading">正在查询 DNS…</p>';
  else if(current.dns)dnsHtml=Object.entries(current.dns).map(([k,v])=>field(k,v.join('\n')||'无记录')).join('');
  else dnsHtml='<p class="muted small">可按需查询公开 A、AAAA、MX、NS 记录（通过 Google DNS-over-HTTPS）。</p><button data-action="dns" class="button secondary">查询 DNS</button>';
  return html+card('DNS 查询',dnsHtml);
}
function renderSitemap(){const s=current.site;let html='<div class="eyebrow">SITEMAP COMPETITOR WATCH</div>';
  if(!s)return html+card('开启 Sitemap 监控','<p class="small muted">将当前域名加入本地监控列表，首次扫描建立基线；后续比较新增 URL、移出 URL、lastmod 变化。</p><div class="action-row"><button class="button" data-action="add-scan">添加并扫描 Sitemap</button></div><p class="note">Sitemap 中没有的 URL 不代表页面不存在；页面移出 Sitemap 不等于网页删除。</p>');
  const st=s.lastStatus==='error'?tag('上次扫描失败','bad'):s.lastStatus==='scanning'?tag('扫描中','warn'):s.lastSuccessAt?tag('扫描成功','good'):tag('尚未扫描');
  const action='<div class="action-row"><button class="button" data-action="scan">'+(s.lastStatus==='scanning'?'继续等待':'扫描 Sitemap')+'</button><button class="button secondary" data-action="dashboard">打开完整监控后台 ↗</button></div>';
  html+=metrics([['当前 URL',fmtInt(s.lastCount)],['新增','+'+fmtInt(s.lastAdded)],['移出','-'+fmtInt(s.lastRemoved)]])+card('当前站点',`<div class="row-between">${st}<span class="lastmod">${escapeHtml(fmtDate(s.lastScanAt))}</span></div><div class="separator"></div>${action}`+
    (s.lastError?`<div class="warning">${escapeHtml(s.lastError)}</div>`:'')+
    field('Sitemap 入口',s.sitemapUrl)+field('Sitemap 子文件',String(s.sitemapFiles||0)))+
    card('最近扫描变化',`<div id="sitemap-changes"><p class="loading">读取历史记录…</p></div>`)+
    '<p class="note">仅当成功读取可信、完整的 Sitemap 时，才应更新快照；异常结果需要复核。</p>';
  Promise.resolve().then(()=>fillSitemapChanges(s.id)).catch(console.error);
  return html;
}
async function fillSitemapChanges(domain){
  const rows=await SiteLensDB.listChanges(domain,30);if(current.domain!==domain||current.selected!=='sitemap')return;
  const node=$('sitemap-changes');if(!node)return;
  node.innerHTML=rows.length?'<div class="scroll-list">'+rows.map(row=>`<div class="item"><div class="row-between">${tag(row.type==='added'?'新增':row.type==='removed'?'移出':'lastmod 变化',row.type==='added'?'good':row.type==='removed'?'bad':'warn')}<span class="lastmod">${escapeHtml(fmtDate(row.at))}</span></div><div class="path">${niceUrl(row.loc)}</div></div>`).join('')+'</div>':noData('没有变化记录。首次成功扫描只建立基线，不会产生新增事件。');
}
async function launchScan(add){
  if(!current.domain)return;
  try{
    if(add)current.site=await send('SITELENS_ADD_SITE',{domain:current.domain});
    if(!current.site)current.site=await SiteLensDB.getSite(current.domain);
    await send('SITELENS_SCAN_SITE',{domain:current.domain});
    current.scanning=true;current.site=await SiteLensDB.getSite(current.domain);render();
  }catch(err){mainTabContent(`<div class="warning">${escapeHtml(err.message||err)}</div>`);}
}
function selectTab(tab){
  current.selected=tab;render();$('content').scrollTop=0;
}
$('tabs').addEventListener('click',ev=>{const tab=ev.target.closest('button[data-tab]');if(tab)selectTab(tab.dataset.tab);});
$('refresh').addEventListener('click',()=>loadPage().catch(err=>mainTabContent(card('分析失败',`<div class="warning">${escapeHtml(err.message)}</div>`))));
$('dashboard').addEventListener('click',()=>chrome.runtime.openOptionsPage());
$('content').addEventListener('click',ev=>{
  const action=ev.target.closest('[data-action]')?.dataset.action;if(!action)return;
  if(action==='goto-sitemap')selectTab('sitemap');
  else if(action==='dashboard')chrome.runtime.openOptionsPage();
  else if(action==='dns')fetchDNS().catch(err=>mainTabContent(card('DNS 查询失败',escapeHtml(err.message))));
  else if(action==='scan'||action==='add-scan')launchScan(action==='add-scan');
});
chrome.tabs.onActivated.addListener(()=>loadPage().catch(console.error));
chrome.tabs.onUpdated.addListener((tabId,info)=>{if(tabId===current.tab?.id && (info.status==='complete'||info.url))loadPage().catch(console.error);});
chrome.runtime.onMessage.addListener(msg=>{
  if(msg?.type==='SITELENS_SCAN_DONE' && msg.siteId===current.domain){
    SiteLensDB.getSite(current.domain).then(site=>{current.site=site;current.scanning=false;render();});
  }
});
loadPage().catch(err=>mainTabContent(card('初始化失败',`<div class="warning">${escapeHtml(err.message||err)}</div>`)));

/* Function runs INSIDE the analyzed web page (isolated world). It must be self-contained. */
function extractPageSEO(){
  const shrink=(text,n=280)=>String(text??'').replace(/\s+/g,' ').trim().slice(0,n);
  const meta=(name)=>[...document.querySelectorAll('meta')].find(e=>e.getAttribute('name')?.toLowerCase()===name.toLowerCase())?.content||'';
  const prop=(name)=>[...document.querySelectorAll('meta')].find(e=>e.getAttribute('property')?.toLowerCase()===name.toLowerCase())?.content||'';
  const canonical=document.querySelector('link[rel~="canonical"]')?.href||'';
  const headings=[...document.querySelectorAll('h1,h2,h3,h4,h5,h6')].slice(0,500).map(e=>({level:Number(e.tagName[1]),text:shrink(e.innerText||e.textContent)}));
  const allImages=[...document.querySelectorAll('img')];
  const images=allImages.slice(0,200).map(e=>({src:(e.currentSrc||e.src||'').slice(0,1000),alt:shrink(e.getAttribute('alt')||''),missingAlt:!e.getAttribute('alt')?.trim(),lazy:e.loading==='lazy'}));
  const allLinks=[...document.querySelectorAll('a[href]')];
  const origin=location.hostname.replace(/^www\./,'').toLowerCase();
  const external=u=>{try{return new URL(u,document.baseURI).hostname.replace(/^www\./,'').toLowerCase()!==origin;}catch{return false;}};
  const links=allLinks.slice(0,200).map(e=>({href:e.href.slice(0,1300),text:shrink(e.innerText||e.textContent,160),rel:e.rel||'',external:external(e.href)}));
  const allSchemas=[...document.querySelectorAll('script[type="application/ld+json"]')];
  const schemas=allSchemas.slice(0,40).map(e=>{try{const json=JSON.parse(e.textContent||'');const root=Array.isArray(json)?json[0]:json;
    return {valid:true,type:String(root?.['@type']||root?.['@graph']?.[0]?.['@type']||'unknown'),keys:Object.keys(root||{}).slice(0,35)};
  }catch(err){return {valid:false,error:String(err.message).slice(0,150)};}});
  const hreflangs=[...document.querySelectorAll('link[rel~="alternate"][hreflang]')].slice(0,100).map(e=>({lang:e.hreflang,href:e.href}));
  const metaTags=[...document.querySelectorAll('meta')].slice(0,100).map(e=>({name:e.name||e.getAttribute('property')||e.getAttribute('http-equiv')||'unnamed',content:shrink(e.content,550)}));
  const text=String(document.body?.innerText||'').slice(0,150000);
  const language=(document.documentElement.lang||'').toLowerCase().startsWith('zh')?'zh':'en';
  let words=[];
  try{const seg=new Intl.Segmenter(language,{granularity:'word'});words=[...seg.segment(text)].filter(x=>x.isWordLike).map(x=>x.segment.toLowerCase());}
  catch{words=(text.toLowerCase().match(/[\p{L}\p{N}]+/gu)||[]);}
  const stop=new Set('the a an and or but of in on at for from with to this that these those it is are was were be as by not have has had you your our we they their get free online all more can use new best how what when where who home about just very now no yes my do does did into out up down also one two via than only page website games game'.split(' '));
  const stats=new Map();for(const w of words){if(w.length<2 || w.length>35 || stop.has(w) || /^\d+$/.test(w))continue;stats.set(w,(stats.get(w)||0)+1);}
  const keywordStats=[...stats].sort((a,b)=>b[1]-a[1]).slice(0,60).map(([word,count])=>({word,count,percent:100*count/Math.max(words.length,1)}));
  return {url:location.href.split('#')[0],title:document.title,description:meta('description'),keywords:meta('keywords'),metaRobots:meta('robots'),viewport:meta('viewport'),canonical,htmlLang:document.documentElement.lang||'',headings,images,
    imageStats:{total:allImages.length,missingAlt:allImages.filter(x=>!x.getAttribute('alt')?.trim()).length,lazy:allImages.filter(x=>x.loading==='lazy').length},
    links,linkStats:{total:allLinks.length,internal:allLinks.filter(x=>!external(x.href)).length,external:allLinks.filter(x=>external(x.href)).length,
      nofollow:allLinks.filter(x=>x.relList?.contains('nofollow')).length,sponsored:allLinks.filter(x=>x.relList?.contains('sponsored')).length,ugc:allLinks.filter(x=>x.relList?.contains('ugc')).length},
    schemas,hreflangs,metaTags,wordCount:words.length,keywordStats,keywordUnique:stats.size,
    social:{ogTitle:prop('og:title'),ogDescription:prop('og:description'),ogImage:prop('og:image'),twitterCard:meta('twitter:card')}};
}