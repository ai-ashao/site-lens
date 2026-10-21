const $=id=>document.getElementById(id);
const state={sites:[],selected:null,view:"overview",filter:"all",query:"",changes:[],scans:[],urls:[]};
const labels={added:"新增 URL",removed:"移出 Sitemap",lastmod:"lastmod 变化"};
function escapeHTML(v){return String(v??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));}
function dtime(t){return t?new Date(t).toLocaleString("zh-CN",{hour12:false}):"—";}
function number(n){return Number(n||0).toLocaleString("en-US");}
function pill(status){const names={pending:"未扫描",scanning:"扫描中",success:"正常",error:"失败"};return '<span class="pill '+status+'">'+(names[status]||"未知")+"</span>";}
function toast(value,error=false) {const node=$("toast");node.textContent=value;node.className="toast visible"+(error?" error":"");clearTimeout(toast.timer);toast.timer=setTimeout(()=>node.className="toast",4200);}
async function send(type,data={}){
  const out=await chrome.runtime.sendMessage({type,...data});
  if(!out?.ok)throw new Error(out?.error||"Operation failed");return out.data;
}
async function refresh(){
  state.sites=await SiteLensDB.listSites();
  if(!state.sites.some(s=>s.id===state.selected)) state.selected=state.sites[0]?.id||null;
  const site=state.sites.find(s=>s.id===state.selected);
  $("site-count").textContent=state.sites.length;
  $("site-list").innerHTML=state.sites.length?state.sites.map(s=>
    '<button class="site-option '+(s.id===state.selected?"selected":"")+'" data-action="select" data-site="'+escapeHTML(s.id)+'"><span class="site-dot '+s.lastStatus+'"></span><span class="site-option-name">'+escapeHTML(s.id)+'</span></button>'
  ).join(""):'<div class="empty-side">尚未添加竞争对手网站</div>';
  const total=state.sites.reduce((sum,s)=>sum+(s.lastCount||0),0);
  const updated=state.sites.reduce((sum,s)=>sum+(s.lastUpdated||0),0);
  const newPages=state.sites.reduce((sum,s)=>sum+(s.lastAdded||0),0);
  $("global-stats").innerHTML=[
    ["监控网站",state.sites.length,"个竞争对手"],
    ["当前 Sitemap URL",number(total),"最新成功快照之和"],
    ["最近扫描新增",number(newPages),"各站最近一次成功扫描"],
    ["最近 lastmod 变化",number(updated),"不等于正文已更新"]
  ].map(([title,value,subtitle])=>'<article class="stat"><div class="stat-label">'+title+'</div><div class="stat-value">'+value+'</div><div class="muted tiny">'+subtitle+'</div></article>').join("");
  if(!site){
    $("detail-content").innerHTML='<div class="empty-state"><div class="empty-icon">⌁</div><h2>开始监控你的第一个竞品</h2><p>输入域名并点击添加，然后执行第一次 Sitemap 扫描建立基线。</p><p>第一次扫描不会把现有页面全部计为新增。</p></div>';
    return;
  }
  [state.changes,state.scans]=await Promise.all([SiteLensDB.listChanges(site.id,800),SiteLensDB.listScans(site.id,60)]);
  if(state.view==="urls") state.urls=await SiteLensDB.getSiteUrls(site.id);
  renderSite(site);
}
function renderSite(site){
  const id=escapeHTML(site.id);
  const head=`<div class="detail-top"><div><div class="eyebrow">SITE OVERVIEW</div><h2>${id}</h2>
  <div class="detail-meta">${pill(site.lastStatus)}<span>最后扫描：${escapeHTML(dtime(site.lastScanAt))}</span></div></div>
  <div class="detail-buttons"><button class="button secondary" data-action="export-site">导出此站</button><button class="button primary" data-action="scan">扫描 Sitemap</button></div></div>
  ${site.lastError?'<div class="warning">最近扫描失败：'+escapeHTML(site.lastError)+'。旧快照已保留。</div>':""}
  <div class="site-metrics">
    <div><span class="muted">当前 URL</span><strong>${number(site.lastCount)}</strong></div>
    <div><span class="muted">最近新增</span><strong class="green">+${number(site.lastAdded)}</strong></div>
    <div><span class="muted">最近移出</span><strong class="red">−${number(site.lastRemoved)}</strong></div>
    <div><span class="muted">lastmod 变化</span><strong>${number(site.lastUpdated)}</strong></div>
  </div>
  <div class="tabs"><button data-action="tab" data-tab="overview" class="${state.view==="overview"?"active":""}">概览</button><button data-action="tab" data-tab="changes" class="${state.view==="changes"?"active":""}">变更记录</button><button data-action="tab" data-tab="urls" class="${state.view==="urls"?"active":""}">URL 清单</button></div>`;
  let body="";
  if(state.view==="overview"){
    body=`<div class="two-col">
      <div class="panel"><h3>最近监测动作</h3>${changesTable(state.changes.slice(0,12),true)}</div>
      <div class="panel"><h3>扫描历史</h3>${state.scans.length?'<div class="timeline">'+state.scans.slice(0,14).map(s=>
        '<div class="timeline-row"><span class="timeline-dot '+(s.status==="success"?"":"failed")+'"></span><div><div class="strong">'+escapeHTML(dtime(s.at))+'</div><div class="muted tiny">'+
        (s.status==="error"?"失败 · "+escapeHTML(s.error||""):(s.baseline?"首次基线":"新增 "+s.added+" / 移出 "+s.removed+" / 更新 "+s.updated)+" · 总计 "+number(s.total||0)+" URL")+
        '</div></div></div>').join("")+'</div>':'<div class="muted block-padding">暂无扫描历史</div>'}
      <div class="info-note">Sitemap 入口：${escapeHTML(site.sitemapUrl||"等待首次扫描")}</div><div class="muted tiny">Sitemap 文件数：${number(site.sitemapFiles)}</div>
      </div></div>`;
  }else if(state.view==="changes"){
    body=`<div class="panel"><div class="panel-toolbar"><div><h3>历史变更</h3><div class="muted tiny">最近最多 800 条，扫描失败不会产生误报</div></div>
    <div class="filters"><select id="change-filter"><option value="all">全部类型</option><option value="added">新增</option><option value="removed">移出</option><option value="lastmod">lastmod 变化</option></select><button class="button secondary small" data-action="export-changes">导出 CSV</button></div></div>
    <div id="change-list"></div></div>`;
  }else {
    body=`<div class="panel"><div class="panel-toolbar"><div><h3>当前 Sitemap URL 清单</h3><div class="muted tiny">共 ${number(state.urls.length)} 条，最多展示 300 条匹配结果</div></div>
    <div class="filters"><input id="url-search" placeholder="搜索 URL 路径…" value="${escapeHTML(state.query)}"><button class="button secondary small" data-action="export-urls">导出 CSV</button></div></div>
    <div id="url-list"></div></div>`;
  }
  $("detail-content").innerHTML=head+body+'<div class="footnote">提示：移出 Sitemap 不代表页面已经删除；lastmod 变化不代表正文确定变化。</div><button class="text-danger" data-action="delete">移除此站监控及历史记录</button>';
  if(state.view==="changes"){
    $("change-filter").value=state.filter;renderChanges();
  }
  if(state.view==="urls")renderUrls();
}
function changesTable(items,compact=false){
  if(!items.length)return '<div class="empty-mini">暂无变更。首次成功扫描仅建立基线。</div>';
  const rows=items.map(c=>'<tr><td><span class="change-chip '+c.type+'">'+(labels[c.type]||c.type)+'</span></td><td class="url-cell"><a href="'+escapeHTML(c.loc)+'" target="_blank" rel="noopener noreferrer">'+escapeHTML(c.loc)+'</a></td><td class="muted nowrap">'+escapeHTML(dtime(c.at))+'</td></tr>').join("");
  return '<div class="table-wrap"><table><thead><tr><th>动作</th><th>URL</th><th>时间</th></tr></thead><tbody>'+rows+'</tbody></table></div>';
}
function renderChanges(){
  const list=state.filter==="all"?state.changes:state.changes.filter(c=>c.type===state.filter);
  $("change-list").innerHTML=changesTable(list);
}
function renderUrls(){
  const q=state.query.trim().toLowerCase();
  const rows=state.urls.filter(u=>!q||u.loc.toLowerCase().includes(q)).slice(0,300);
  $("url-list").innerHTML=rows.length?'<div class="table-wrap"><table><thead><tr><th>URL</th><th>lastmod</th></tr></thead><tbody>'+rows.map(u=>
    '<tr><td class="url-cell"><a href="'+escapeHTML(u.loc)+'" target="_blank" rel="noopener noreferrer">'+escapeHTML(u.loc)+'</a></td><td class="muted nowrap">'+escapeHTML(u.lastmod||"—")+'</td></tr>').join("")+'</tbody></table></div>':'<div class="empty-mini">没有匹配的 URL</div>';
}
function download(name,content,mime){
  const blob=new Blob([content],{type:mime});const href=URL.createObjectURL(blob);
  const a=document.createElement("a");a.href=href;a.download=name;document.body.append(a);a.click();a.remove();
  setTimeout(()=>URL.revokeObjectURL(href),30000);
}
function csv(rows,columns) {
  const q=v=>'"'+String(v??"").replace(/"/g,'""')+'"';
  return "\uFEFF"+[columns.map(c=>q(c)).join(","),...rows.map(row=>columns.map(c=>q(row[c])).join(","))].join("\r\n");
}
async function exportData(singleSite){
  const sites=singleSite?state.sites.filter(s=>s.id===singleSite):state.sites;
  const bundle={format:"SiteLens JSON export",version:1,exportedAt:new Date().toISOString(),sites:[]};
  for(const site of sites) bundle.sites.push({site,urls:await SiteLensDB.getSiteUrls(site.id),
    scans:await SiteLensDB.listScans(site.id,1000000),changes:await SiteLensDB.listChanges(site.id,1000000)});
  download("sitelens-"+(singleSite||"all")+"-"+new Date().toISOString().slice(0,10)+".json",JSON.stringify(bundle,null,2),"application/json");
  toast("JSON 导出已开始，请妥善保存备份。");
}
$("add-form").addEventListener("submit",async e=>{
  e.preventDefault();const input=$("add-domain");const domain=input.value.trim();
  try {
    const site=await send("SITELENS_ADD_SITE",{domain});
    state.selected=site.id;state.view="overview";input.value="";await refresh();
    toast("已添加 "+site.id+"。点击“扫描 Sitemap”建立初始基线。");
  }catch(err){toast(err.message,true);}
});
document.addEventListener("click",async e=>{
  const el=e.target.closest("[data-action]");if(!el)return;
  const action=el.dataset.action;
  try {
    if(action==="select"){state.selected=el.dataset.site;state.view="overview";state.query="";await refresh();}
    if(action==="tab"){state.view=el.dataset.tab;state.query="";await refresh();}
    if(action==="scan"){
      await send("SITELENS_SCAN_SITE",{domain:state.selected});
      toast("扫描已启动，完成后将自动刷新。");
      await refresh();
    }
    if(action==="delete"){
      if(!confirm("确定移除 "+state.selected+" 并永久删除它的本地监控历史吗？"))return;
      await send("SITELENS_DELETE_SITE",{domain:state.selected});
      state.selected=null;await refresh();toast("已移除站点");
    }
    if(action==="export-site")await exportData(state.selected);
    if(action==="export-changes")download("sitelens-changes-"+state.selected+".csv",csv(state.changes.map(c=>({type:c.type,url:c.loc,date:new Date(c.at).toISOString(),lastmod:c.lastmod})),["type","url","date","lastmod"]),"text/csv");
    if(action==="export-urls")download("sitelens-urls-"+state.selected+".csv",csv(state.urls.map(u=>({url:u.loc,lastmod:u.lastmod})),["url","lastmod"]),"text/csv");
  }catch(err){toast(err.message,true);}
});
document.addEventListener("change",e=>{if(e.target.id==="change-filter"){state.filter=e.target.value;renderChanges();}});
document.addEventListener("input",e=>{if(e.target.id==="url-search"){state.query=e.target.value;renderUrls();}});
$("export-all").addEventListener("click",()=>exportData(null).catch(e=>toast(e.message,true)));
chrome.runtime.onMessage.addListener(msg=>{
  if(msg?.type==="SITELENS_SCAN_DONE")refresh().then(()=>toast(msg.error?"扫描失败："+msg.error:"Sitemap 扫描完成",!!msg.error)).catch(console.error);
});
setInterval(()=>{if(document.visibilityState==="visible")refresh().catch(console.error);},10000);
refresh().catch(e=>toast(e.message,true));
