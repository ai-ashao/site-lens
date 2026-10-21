importScripts("db.js","sitemap.js");
// Click the extension icon to open its right-hand Chrome side panel.
chrome.sidePanel.setPanelBehavior({openPanelOnActionClick:true}).catch(console.error);
const ALARM="sitelens-daily"; const running=new Set();
async function initAlarm(){
  const alarm=await chrome.alarms.get(ALARM);
  if(!alarm) chrome.alarms.create(ALARM,{periodInMinutes:1440});
}
chrome.runtime.onInstalled.addListener(()=>{initAlarm().catch(console.error);});
chrome.runtime.onStartup.addListener(()=>{initAlarm().catch(console.error);});
initAlarm().catch(console.error);
async function scanSite(siteId) {
  if(running.has(siteId)) return {started:false,reason:"already_running"};
  running.add(siteId);
  try{
    await SiteLensDB.markScanning(siteId);
    const data=await SiteLensSitemap.collect(siteId);
    const summary=await SiteLensDB.commitScan(siteId,data.pages,{root:data.root,files:data.files});
    chrome.runtime.sendMessage({type:"SITELENS_SCAN_DONE",siteId,summary}).catch(()=>{});
  }catch(e){
    await SiteLensDB.failScan(siteId,e);
    chrome.runtime.sendMessage({type:"SITELENS_SCAN_DONE",siteId,error:String(e?.message||e)}).catch(()=>{});
  }finally{running.delete(siteId);}
  return {started:true};
}
chrome.alarms.onAlarm.addListener(async alarm=>{
  if(alarm.name!==ALARM) return;
  const sites=await SiteLensDB.listSites();
  // Serial to avoid flooding remote servers.
  for(const site of sites) await scanSite(site.id);
});
chrome.runtime.onMessage.addListener((msg,sender,respond)=>{
  if(!msg?.type?.startsWith("SITELENS_")||msg.type==="SITELENS_PARSE_XML"||msg.type==="SITELENS_SCAN_DONE") return;
  (async()=>{
    if(msg.type==="SITELENS_ADD_SITE")return await SiteLensDB.addSite(msg.domain);
    if(msg.type==="SITELENS_SCAN_SITE"){
      const id=SiteLensDB.normalizeDomain(msg.domain);
      if(!await SiteLensDB.getSite(id)) throw new Error("请先添加该域名");
      // Kick off scan without waiting for all Sitemap downloads.
      scanSite(id);
      return {started:true};
    }
    if(msg.type==="SITELENS_DELETE_SITE"){
      if(running.has(msg.domain)) throw new Error("Site is being scanned; try again later");
      await SiteLensDB.deleteSite(msg.domain);return {deleted:true};
    }
    if(msg.type==="SITELENS_LIST_SITES")return await SiteLensDB.listSites();
    throw new Error("Unknown action");
  })().then(data=>respond({ok:true,data}),error=>respond({ok:false,error:String(error?.message||error)}));
  return true;
});
