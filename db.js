/* Shared by extension service worker and dashboard. IndexedDB is local-only. */
const SiteLensDB = (() => {
  const NAME = "sitelens"; const VERSION = 2;
  function open() {
    return new Promise((resolve,reject)=>{
      const req=indexedDB.open(NAME,VERSION);
      req.onupgradeneeded=()=>{
        const db=req.result;
        if(!db.objectStoreNames.contains("jobs")) db.createObjectStore("jobs",{keyPath:"siteId"});
        if(!db.objectStoreNames.contains("sites")) db.createObjectStore("sites",{keyPath:"id"});
        if(!db.objectStoreNames.contains("urls")) {
          const s=db.createObjectStore("urls",{keyPath:["siteId","loc"]});
          s.createIndex("bySite","siteId");
        }
        if(!db.objectStoreNames.contains("scans")) {
          const s=db.createObjectStore("scans",{keyPath:"id",autoIncrement:true});
          s.createIndex("bySiteTime",["siteId","at"]);
        }
        if(!db.objectStoreNames.contains("changes")) {
          const s=db.createObjectStore("changes",{keyPath:"id",autoIncrement:true});
          s.createIndex("bySiteTime",["siteId","at"]);
        }
      };
      req.onsuccess=()=>resolve(req.result);
      req.onerror=()=>reject(req.error);
    });
  }
  function one(request) {return new Promise((res,rej)=>{request.onsuccess=()=>res(request.result);request.onerror=()=>rej(request.error);});}
  async function read(store,call) {
    const db=await open();
    try { return await one(call(db.transaction(store,"readonly").objectStore(store))); }
    finally {db.close();}
  }
  async function write(stores,fn) {
    const db=await open();
    try {return await new Promise((resolve,reject)=>{
      const tx=db.transaction(stores,"readwrite");
      tx.oncomplete=()=>resolve();
      tx.onerror=()=>reject(tx.error||new Error("IndexedDB write failed"));
      tx.onabort=()=>reject(tx.error||new Error("IndexedDB transaction aborted"));
      try {fn(tx);} catch(e){tx.abort();reject(e);}
    });} finally{db.close();}
  }
  function normalizeDomain(input) {
    const raw=String(input||"").trim();
    if(!raw) throw new Error("请输入有效域名");
    const url=new URL(/^[a-z]+:\/\//i.test(raw)?raw:"https://"+raw);
    if(!["http:","https:"].includes(url.protocol)) throw new Error("Only HTTP(S) domains are supported");
    const host=url.hostname.toLowerCase().replace(/\.$/,"");
    if(!host.includes(".") || host==="localhost" || /^\d+(\.\d+){3}$/.test(host))
      throw new Error("请输入公开域名，不支持 IP 或 localhost");
    return host;
  }
  async function getSite(id){return read("sites",s=>s.get(id));}
  async function listSites(){const rows=await read("sites",s=>s.getAll());return rows.sort((a,b)=>a.id.localeCompare(b.id));}
  async function putSite(site){await write(["sites"],tx=>tx.objectStore("sites").put(site));return site;}
  async function addSite(input){
    const id=normalizeDomain(input);
    const exists=await getSite(id); if(exists) return exists;
    const site={id,createdAt:Date.now(),lastSuccessAt:null,lastScanAt:null,lastStatus:"pending",lastError:null,
      lastCount:0,lastAdded:0,lastRemoved:0,lastUpdated:0,sitemapUrl:null,sitemapFiles:0};
    await putSite(site);return site;
  }
  async function getSiteUrls(id){return read("urls",s=>s.index("bySite").getAll(IDBKeyRange.only(id)));}
  async function getRecent(store,siteId,limit=200) {
    const db=await open();try{return await new Promise((resolve,reject)=>{
      const results=[];
      const tx=db.transaction(store,"readonly");
      const range=IDBKeyRange.bound([siteId,0],[siteId,Number.MAX_SAFE_INTEGER]);
      const req=tx.objectStore(store).index("bySiteTime").openCursor(range,"prev");
      req.onsuccess=()=>{const c=req.result;if(c && results.length<limit){results.push(c.value);c.continue();}else resolve(results);};
      req.onerror=()=>reject(req.error);
    });} finally {db.close();}
  }
  async function listChanges(siteId,limit=300){return getRecent("changes",siteId,limit);}
  async function listScans(siteId,limit=60){return getRecent("scans",siteId,limit);}
  const LEASE_MS=60000, JOB_MS=30*60*1000, REVIEW_MS=5*60*1000;
  async function listJobs(){return read("jobs",s=>s.getAll());}
  async function enqueueSites(ids,now=Date.now()){
    // Unique site key and a single transaction deduplicate manual/daily requests.
    await write(["sites","jobs"],tx=>{
      for(const siteId of new Set(ids)){
        const jobs=tx.objectStore("jobs");
        jobs.get(siteId).onsuccess=e=>{
          if(e.target.result)return;
          tx.objectStore("sites").get(siteId).onsuccess=e=>{
            if(!e.target.result)return;
            jobs.put({siteId,createdAt:now,readyAt:now,attempts:0,state:null});
            tx.objectStore("sites").put({...e.target.result,lastStatus:"queued"});
          };
        };
      }
    });
  }
  async function claimJob(now=Date.now()){
    let claimed=null;
    await write(["jobs","sites"],tx=>{
      const jobs=tx.objectStore("jobs");
      jobs.getAll().onsuccess=e=>{
        const rows=e.target.result;
        if(rows.some(j=>j.leaseUntil>now))return;
        const job=rows.filter(j=>j.readyAt<=now).sort((a,b)=>a.createdAt-b.createdAt||a.siteId.localeCompare(b.siteId))[0];
        if(!job)return;
        claimed={...job,startedAt:job.startedAt??now,token:crypto.randomUUID(),leaseUntil:now+LEASE_MS,attempts:job.attempts+1};
        jobs.put(claimed);
        tx.objectStore("sites").get(job.siteId).onsuccess=e=>{
          if(e.target.result)tx.objectStore("sites").put({...e.target.result,lastStatus:"scanning"});
        };
      };
    });
    return claimed;
  }
  // Fence all writes by lease token: a late response cannot overwrite a resumed job.
  async function fenced(job,stores,fn){
    let applied=false;
    await write([...new Set(["jobs",...stores])],tx=>{
      tx.objectStore("jobs").get(job.siteId).onsuccess=e=>{
        if(e.target.result?.token!==job.token)return;
        applied=true;fn(tx);
      };
    });
    return applied;
  }
  async function checkpoint(job,state,now=Date.now()){
    return fenced(job,[],tx=>tx.objectStore("jobs").put({...job,state,token:null,leaseUntil:0,attempts:0,readyAt:now}));
  }
  async function failJob(job,error,now=Date.now()){
    const retry=job.attempts<3 && now-job.startedAt<JOB_MS;
    const message=String(error?.message||error).slice(0,400);
    await fenced(job,["sites","scans"],tx=>{
      const jobs=tx.objectStore("jobs");
      if(retry)jobs.put({...job,token:null,leaseUntil:0,readyAt:now+60000});
      else jobs.delete(job.siteId);
      tx.objectStore("sites").get(job.siteId).onsuccess=e=>{
        if(e.target.result)tx.objectStore("sites").put({...e.target.result,lastStatus:retry?"queued":"error",lastScanAt:now,lastError:message});
      };
      if(!retry)tx.objectStore("scans").add({siteId:job.siteId,at:now,status:"error",error:message});
    });
  }
  async function commitScan(id,pages,info,job){
    if(!job || job.siteId!==id || info.complete!==true || job.state?.phase!=="done")
      throw new Error("A complete durable job is required to commit");
    if(!pages.length)throw new Error("Empty Sitemap; previous snapshot retained");
    const site=await getSite(id);if(!site) throw new Error("Site removed during scan");
    const previous=await getSiteUrls(id);
    const before=new Map(previous.map(row=>[row.loc,row]));
    const after=new Map(pages.map(row=>[row.loc,row]));
    const baseline=!site.lastSuccessAt;
    const at=Date.now();const events=[];
    const missing=previous.filter(row=>!after.has(row.loc)).length;
    const sourceChanged=(site.sitemapUrl && site.sitemapUrl!==info.root) || info.files<site.sitemapFiles;
    const suspicious=!baseline && (after.size<=before.size*0.7 || missing>=before.size*0.3 || sourceChanged);
    const canonical=JSON.stringify({root:info.root,files:info.files,pages:[...after.values()].sort((a,b)=>a.loc.localeCompare(b.loc))});
    const fingerprint=Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256",new TextEncoder().encode(canonical))),b=>b.toString(16).padStart(2,"0")).join("");
    if(suspicious && !(site.review?.fingerprint===fingerprint && at-site.review.at>=REVIEW_MS)){
      const message="Sitemap URL 数量、覆盖范围或入口异常；保留旧快照，需独立完整复核";
      const applied=await fenced(job,["sites","scans"],tx=>{
        tx.objectStore("sites").put({...site,lastStatus:"review",lastScanAt:at,lastError:message,
          review:{fingerprint,at,total:after.size}});
        tx.objectStore("scans").add({siteId:id,at,status:"review",total:after.size,error:message});
        // One independent refetch after five minutes. Unstable candidates require
        // another manual/daily scan instead of an endless automatic retry loop.
        if(!job.reviewAttempt)tx.objectStore("jobs").put({siteId:id,createdAt:at,readyAt:at+REVIEW_MS,attempts:0,state:null,reviewAttempt:true});
        else tx.objectStore("jobs").delete(id);
      });
      return {status:applied?"review":"stale",total:after.size};
    }
    if(!baseline) {
      for(const [loc,row] of after){
        const prev=before.get(loc);
        if(!prev) events.push({siteId:id,at,type:"added",loc,lastmod:row.lastmod||""});
        else if((prev.lastmod||"")!==(row.lastmod||""))
          events.push({siteId:id,at,type:"lastmod",loc,lastmod:row.lastmod||"",previousLastmod:prev.lastmod||""});
      }
      for(const [loc,row] of before) if(!after.has(loc))
        events.push({siteId:id,at,type:"removed",loc,lastmod:row.lastmod||""});
    }
    const added=events.filter(e=>e.type==="added").length;
    const removed=events.filter(e=>e.type==="removed").length;
    const updated=events.filter(e=>e.type==="lastmod").length;
    const updatedSite={...site,lastStatus:"success",lastScanAt:at,lastSuccessAt:at,lastError:null,
      review:null,lastCount:after.size,lastAdded:added,lastRemoved:removed,lastUpdated:updated,
      sitemapUrl:info.root,sitemapFiles:info.files};
    const applied=await fenced(job,["sites","urls","scans","changes"],tx=>{
      tx.objectStore("jobs").delete(id);
      tx.objectStore("sites").put(updatedSite);
      const urls=tx.objectStore("urls");
      for(const row of pages) urls.put({siteId:id,loc:row.loc,lastmod:row.lastmod||"",seenAt:at});
      for(const row of previous) if(!after.has(row.loc)) urls.delete([id,row.loc]);
      tx.objectStore("scans").add({siteId:id,at,status:"success",baseline,total:after.size,added,removed,updated,files:info.files});
      for(const event of events) tx.objectStore("changes").add(event);
    });
    return {status:applied?"success":"stale",baseline,total:after.size,added,removed,updated};
  }
  async function deleteSite(id){
    const oldUrls=await getSiteUrls(id), oldChanges=await listChanges(id,1000000), oldScans=await listScans(id,1000000);
    await write(["sites","urls","scans","changes","jobs"],tx=>{
      tx.objectStore("jobs").delete(id);
      tx.objectStore("sites").delete(id);
      for(const u of oldUrls) tx.objectStore("urls").delete([id,u.loc]);
      for(const e of oldChanges) tx.objectStore("changes").delete(e.id);
      for(const e of oldScans) tx.objectStore("scans").delete(e.id);
    });
  }
  return {normalizeDomain,getSite,listSites,addSite,putSite,getSiteUrls,listChanges,listScans,
    enqueueSites,listJobs,claimJob,checkpoint,failJob,commitScan,deleteSite,JOB_MS};
})();
