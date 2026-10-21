importScripts("db.js","sitemap.js");
const ALARM="sitelens-daily", QUEUE_ALARM="sitelens-queue";
let pumping=null;
async function initAlarms(){
  if(!await chrome.alarms.get(ALARM))await chrome.alarms.create(ALARM,{periodInMinutes:1440});
  // A persistent watchdog wakes a reclaimed worker and retries expired leases.
  // One minute works with the extension's minimum Chrome version (116).
  if(!await chrome.alarms.get(QUEUE_ALARM))await chrome.alarms.create(QUEUE_ALARM,{periodInMinutes:1});
}
function notify(siteId,summary,error){
  chrome.runtime.sendMessage({type:"SITELENS_SCAN_DONE",siteId,summary,error}).catch(()=>{});
}
async function runQueue(){
  const until=Date.now()+20000;
  do {
    const job=await SiteLensDB.claimJob();
    if(!job)return;
    try {
      if(job.attempts>3 || Date.now()-job.startedAt>SiteLensDB.JOB_MS)
        throw new Error("Scan interrupted repeatedly or exceeded 30 minute deadline");
      if(job.state?.phase==="done"){
        const state=job.state;
        const summary=await SiteLensDB.commitScan(job.siteId,state.pages,{
          root:state.roots.join(", "),files:state.visited.length,complete:true
        },job);
        notify(job.siteId,summary,summary.status==="review"?"异常结果待复核，旧快照已保留":undefined);
      }else{
        const state=await SiteLensSitemap.step(job.state||SiteLensSitemap.initial(job.siteId));
        await SiteLensDB.checkpoint(job,state);
      }
    }catch(error){
      await SiteLensDB.failJob(job,error);
      notify(job.siteId,null,String(error?.message||error));
    }
  }while(Date.now()<until);
}
function pump(){
  if(!pumping)pumping=runQueue().finally(()=>{pumping=null;});
  return pumping;
}
async function boot(){
  await initAlarms();
  // v1 had no durable jobs. Surface interrupted legacy scans for a fresh scan.
  const sites=await SiteLensDB.listSites(), jobs=await SiteLensDB.listJobs();
  await SiteLensDB.enqueueSites(sites.filter(s=>s.lastStatus==="scanning"&&!jobs.some(j=>j.siteId===s.id)).map(s=>s.id));
  await pump();
}
chrome.runtime.onInstalled.addListener(()=>{boot().catch(console.error);});
chrome.runtime.onStartup.addListener(()=>{boot().catch(console.error);});
chrome.alarms.onAlarm.addListener(alarm=>{
  (async()=>{
    if(alarm.name===ALARM)await SiteLensDB.enqueueSites((await SiteLensDB.listSites()).map(s=>s.id));
    if(alarm.name===ALARM||alarm.name===QUEUE_ALARM)await pump();
  })().catch(console.error);
});
chrome.runtime.onMessage.addListener((msg,sender,respond)=>{
  if(!msg?.type?.startsWith("SITELENS_")||msg.type==="SITELENS_PARSE_XML"||msg.type==="SITELENS_SCAN_DONE")return;
  (async()=>{
    if(msg.type==="SITELENS_ADD_SITE")return SiteLensDB.addSite(msg.domain);
    if(msg.type==="SITELENS_SCAN_SITE"){
      const id=SiteLensDB.normalizeDomain(msg.domain);
      if(!await SiteLensDB.getSite(id))throw new Error("请先添加该域名");
      await initAlarms();
      await SiteLensDB.enqueueSites([id]);
      pump().catch(console.error);
      return {started:true};
    }
    if(msg.type==="SITELENS_DELETE_SITE"){
      const id=SiteLensDB.normalizeDomain(msg.domain);
      if((await SiteLensDB.listJobs()).some(j=>j.siteId===id))throw new Error("Site has a pending scan; try again later");
      await SiteLensDB.deleteSite(id);return {deleted:true};
    }
    if(msg.type==="SITELENS_LIST_SITES")return SiteLensDB.listSites();
    throw new Error("Unknown action");
  })().then(data=>respond({ok:true,data}),error=>respond({ok:false,error:String(error?.message||error)}));
  return true;
});
boot().catch(console.error);
