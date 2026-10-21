/* Real extension integration: native IndexedDB + offscreen DOMParser + MV3 worker.
 * Local HTTPS fixtures, isolated temporary profile; no user browser data. */
const {chromium}=require('playwright');
const fs=require('node:fs/promises');
const os=require('node:os');
const path=require('node:path');
const https=require('node:https');
const {execFileSync}=require('node:child_process');
const assert=require('node:assert/strict');
(async()=>{
  const temp=await fs.mkdtemp(path.join(os.tmpdir(),'sitelens-chrome-'));
  let context,server,release;
  const host='lens.test',requests=[];
  const xml=rows=>'<urlset>'+rows.map(loc=>'<url><loc>https://lens.test/'+loc+'</loc></url>').join('')+'</urlset>';
  const idx='<sitemapindex><sitemap><loc>https://lens.test/one.xml</loc></sitemap><sitemap><loc>https://lens.test/two.xml</loc></sitemap></sitemapindex>';
  let root=xml(['a','b','c','d','e']),one=xml(['a','b','c']),two=xml(['d','e']),hold=false;
  try{
    execFileSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',path.join(temp,'key.pem'),'-out',path.join(temp,'cert.pem'),'-days','1','-subj','/CN=lens.test'],{stdio:'ignore'});
    server=https.createServer({key:await fs.readFile(path.join(temp,'key.pem')),cert:await fs.readFile(path.join(temp,'cert.pem'))},async(req,res)=>{
      requests.push(req.url);
      if(req.url==='/two.xml'&&hold)await new Promise(resolve=>{release=resolve;});
      const body=req.url==='/sitemap.xml'?root:req.url==='/one.xml'?one:req.url==='/two.xml'?two:null;
      res.writeHead(body===null?404:200,{'content-type':'application/xml'});res.end(body?.replaceAll('lens.test',req.headers.host.split(':')[0])||'not found');
    });
    await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
    context=await chromium.launchPersistentContext(path.join(temp,'profile'),{
      headless:true,channel:'chromium',
      ...(process.env.CHROME_EXECUTABLE?{executablePath:process.env.CHROME_EXECUTABLE}:{}),
      args:['--disable-extensions-except='+process.cwd(),'--load-extension='+process.cwd(),
        '--host-resolver-rules=MAP lens.test 127.0.0.1:'+server.address().port+', MAP second.test 127.0.0.1:'+server.address().port,'--no-proxy-server','--ignore-certificate-errors']
    });
    const worker=context.serviceWorkers()[0]||await context.waitForEvent('serviceworker');
    const id=new URL(worker.url()).host;
    const page=await context.newPage();await page.goto('chrome-extension://'+id+'/dashboard.html');
    const send=(type,data={})=>page.evaluate(async({type,data})=>{
      const result=await chrome.runtime.sendMessage({type,...data});if(!result.ok)throw new Error(result.error);return result.data;
    },{type,data});
    const inspect=()=>page.evaluate(async()=>({site:await SiteLensDB.getSite('lens.test'),urls:await SiteLensDB.getSiteUrls('lens.test'),scans:await SiteLensDB.listScans('lens.test'),changes:await SiteLensDB.listChanges('lens.test'),jobs:await SiteLensDB.listJobs()}));
    async function waitFor(check,label,timeout=20000){
      const start=Date.now();while(Date.now()-start<timeout){const value=await inspect();if(check(value))return value;await new Promise(r=>setTimeout(r,100));}
      throw new Error('Timed out: '+label+' '+JSON.stringify(await inspect()));
    }
    await send('SITELENS_ADD_SITE',{domain:host});await send('SITELENS_SCAN_SITE',{domain:host});
    let result=await waitFor(v=>v.site.lastStatus==='success'&&!v.jobs.length,'baseline');
    assert.equal(result.urls.length,5);assert.equal(result.changes.length,0);console.log('PASS real Chrome baseline/offscreen/IndexedDB');
    root=xml(['a','b','c','d','f']);await send('SITELENS_SCAN_SITE',{domain:host});
    result=await waitFor(v=>v.scans.length===2&&!v.jobs.length,'normal diff');
    assert.deepEqual(result.changes.map(x=>x.type).sort(),['added','removed']);console.log('PASS real Chrome normal diff');
    root=idx;two='<urlset><url><loc>https://foreign.test/a</loc></url></urlset>';
    await send('SITELENS_SCAN_SITE',{domain:host});
    result=await waitFor(v=>v.site.lastError&&v.jobs[0]?.attempts===1,'cross-domain failure');
    assert.equal(result.urls.length,5);assert.equal(result.changes.length,2);
    // Expedite bounded retries without waiting two real minutes.
    for(let i=0;i<2;i++){
      await page.evaluate(async()=>{const j=(await SiteLensDB.listJobs())[0];const db=await new Promise((r,j)=>{const q=indexedDB.open('sitelens',2);q.onsuccess=()=>r(q.result);q.onerror=()=>j(q.error);});await new Promise((r,jj)=>{const tx=db.transaction('jobs','readwrite');tx.objectStore('jobs').put({...j,readyAt:0});tx.oncomplete=r;tx.onerror=()=>jj(tx.error);});db.close();await chrome.alarms.create('sitelens-queue',{when:Date.now()+100});});
      await waitFor(v=>i===1?!v.jobs.length:v.jobs[0]?.attempts===2,'retry');
    }
    console.log('PASS real Chrome partial/cross-domain failure retains baseline');
    root='<urlset/>';await send('SITELENS_SCAN_SITE',{domain:host});
    await waitFor(v=>v.jobs[0]?.attempts===1,'empty protection');
    result=await inspect();assert.equal(result.urls.length,5);assert.equal(result.changes.length,2);
    // Remove failed fixture job, leaving production data intact for interruption test.
    await page.evaluate(async()=>{const db=await new Promise(r=>{const q=indexedDB.open('sitelens',2);q.onsuccess=()=>r(q.result);});await new Promise(r=>{const tx=db.transaction('jobs','readwrite');tx.objectStore('jobs').clear();tx.oncomplete=r;});db.close();});
    console.log('PASS real Chrome empty Sitemap protection');
    root=idx;two=xml(['d','f']);hold=true;const before=requests.length;
    await send('SITELENS_SCAN_SITE',{domain:host});
    await waitFor(v=>v.jobs[0]?.state?.visited?.includes('https://lens.test/one.xml')&&!!release,'child checkpoint');
    const cdp=await context.newCDPSession(page);let versions=[];
    cdp.on('ServiceWorker.workerVersionUpdated',event=>{versions=event.versions;});
    await cdp.send('ServiceWorker.enable');
    for(let i=0;i<100&&!versions.some(v=>v.scriptURL.endsWith('/background.js'));i++)await new Promise(r=>setTimeout(r,50));
    const version=versions.find(v=>v.scriptURL.endsWith('/background.js')&&v.runningStatus==='running');
    assert.ok(version,'extension service worker version found');
    await cdp.send('ServiceWorker.stopWorker',{versionId:version.versionId});
    hold=false;release();
    // Simulate lease expiry only; wakeup is a real Chrome alarm and new worker.
    await page.evaluate(async()=>{const j=(await SiteLensDB.listJobs())[0];const db=await new Promise(r=>{const q=indexedDB.open('sitelens',2);q.onsuccess=()=>r(q.result);});await new Promise(r=>{const tx=db.transaction('jobs','readwrite');tx.objectStore('jobs').put({...j,leaseUntil:0});tx.oncomplete=r;});db.close();await chrome.alarms.create('sitelens-queue',{when:Date.now()+200});});
    result=await waitFor(v=>!v.jobs.length&&v.site.lastStatus==='success','worker restart');
    const tail=requests.slice(before);
    assert.equal(tail.filter(p=>p==='/one.xml').length,1);
    assert.equal(tail.filter(p=>p==='/two.xml').length,2);
    assert.equal(result.urls.length,5);assert.equal(result.changes.length,2);
    console.log('PASS real Chrome forced worker stop + alarm restart; checkpoint retained; no duplicate diff');
    const successes=result.scans.filter(s=>s.status==='success').length;
    await send('SITELENS_ADD_SITE',{domain:'second.test'});
    await page.evaluate(()=>chrome.alarms.create('sitelens-daily',{when:Date.now()+100}));
    await waitFor(v=>!v.jobs.length&&v.scans.filter(s=>s.status==='success').length===successes+1,'daily batch');
    const second=await page.evaluate(async()=>({site:await SiteLensDB.getSite('second.test'),scans:await SiteLensDB.listScans('second.test')}));
    assert.equal(second.site.lastCount,5);assert.equal(second.scans.length,1);
    console.log('PASS real Chrome daily alarm persists and drains a two-site batch');
    console.log('Browser: '+context.browser().version());
  }finally{
    release?.();await context?.close();
    if(server)await new Promise(r=>{server.close(r);server.closeAllConnections();});
    await fs.rm(temp,{recursive:true,force:true});
  }
})().catch(e=>{console.error(e);process.exitCode=1;});
