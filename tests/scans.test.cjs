const {test}=require('node:test');
const assert=require('node:assert/strict');
const {environment,host,root,xml,index,drain,scan}=require('./helpers.cjs');
async function setup(){const e=environment();await e.db.addSite(host);return e;}
test('first scan establishes baseline; normal additions/removals/lastmod are atomic',async()=>{
  const e=await setup();await scan(e,['a','b','c','d','e']);
  assert.equal((await e.db.listChanges(host)).length,0);
  await scan(e,[{path:'a',lastmod:'2026-10-21'},'b','c','d','f']);
  assert.deepEqual(Array.from(await e.db.listChanges(host),r=>r.type).sort(),['added','lastmod','removed']);
  assert.equal((await e.db.getSiteUrls(host)).length,5);
  assert.equal((await e.db.listJobs()).length,0);
});
test('failed child, filtered URL, malformed XML and missing loc never replace baseline',async()=>{
  for(const body of [new Error('network'),'<urlset><url><loc>https://other.com/a</loc></url></urlset>',
    '<urlset><url></url></urlset>','<urlset><url>', '<sitemapindex><sitemap><loc>https://other.com/map</loc></sitemap></sitemapindex>']){
    const e=await setup();await scan(e,['a','b','c']);
    e.routes.set(root,index(['https://example.com/one.xml','https://example.com/two.xml']));
    e.routes.set('https://example.com/one.xml',xml(['a']));e.routes.set('https://example.com/two.xml',body);
    await e.db.enqueueSites([host]);await drain(e);
    for(let i=0;i<2;i++){e.advance(60000);await drain(e);}
    assert.equal((await e.db.getSiteUrls(host)).length,3);
    assert.equal((await e.db.listChanges(host)).length,0);
    assert.equal((await e.db.getSite(host)).lastStatus,'error');
  }
});
test('empty root, empty leaf and empty index retain existing snapshot',async()=>{
  for(const body of ['<urlset/>','<sitemapindex/>',index(['https://example.com/empty.xml'])]){
    const e=await setup();await scan(e,['a','b']);
    e.routes.set(root,body);e.routes.set('https://example.com/empty.xml','<urlset/>');
    await e.db.enqueueSites([host]);await drain(e);
    assert.equal((await e.db.getSiteUrls(host)).length,2);
    assert.equal((await e.db.listChanges(host)).length,0);
  }
});
test('first empty scan cannot establish a baseline',async()=>{
  const e=await setup();await scan(e,[]);
  assert.equal((await e.db.getSite(host)).lastSuccessAt,null);
});
test('large decline requires delayed independent identical scan; commits only once',async()=>{
  const e=await setup();await scan(e,['a','b','c','d','e']);await scan(e,['a','b']);
  assert.equal((await e.db.getSiteUrls(host)).length,5);
  assert.equal((await e.db.getSite(host)).lastStatus,'review');
  assert.equal((await e.db.listChanges(host)).length,0);
  e.advance(300000);await drain(e);
  assert.equal((await e.db.getSiteUrls(host)).length,2);
  assert.equal((await e.db.listChanges(host)).length,3);
  await drain(e);assert.equal((await e.db.listChanges(host)).length,3);
});
test('unstable review and temporary empty verification never erase baseline',async()=>{
  const e=await setup();await scan(e,['a','b','c','d','e']);await scan(e,['a']);
  e.routes.set(root,xml(['b']));e.advance(300000);await drain(e);
  assert.equal((await e.db.getSiteUrls(host)).length,5);
  assert.equal((await e.db.listJobs()).length,0);
  await scan(e,[]);assert.equal((await e.db.getSiteUrls(host)).length,5);
});
test('restart replays only uncheckpointed file, stale worker cannot write or commit',async()=>{
  let e=await setup();e.routes.set(root,index(['https://example.com/one.xml','https://example.com/two.xml']));
  e.routes.set('https://example.com/one.xml',xml(['a']));e.routes.set('https://example.com/two.xml',xml(['b']));
  await e.db.enqueueSites([host]);
  for(let i=0;i<3;i++){const job=await e.db.claimJob();await e.db.checkpoint(job,await e.sitemap.step(job.state||e.sitemap.initial(host)));}
  const stale=await e.db.claimJob();
  const restarted=environment({indexedDB:e.indexedDB,now:e.now()});restarted.routes.set('https://example.com/two.xml',xml(['b']));
  assert.equal(await restarted.db.claimJob(),null);restarted.advance(60001);
  const replacement=await restarted.db.claimJob();
  assert.equal(await e.db.checkpoint(stale,{phase:'done',pages:[]}),false);
  await restarted.db.checkpoint(replacement,await restarted.sitemap.step(replacement.state));
  await drain(restarted);
  assert.deepEqual(restarted.calls,['https://example.com/two.xml']);
  assert.equal((await restarted.db.getSiteUrls(host)).length,2);
  await assert.rejects(()=>e.db.commitScan(host,[],{complete:true},stale));
});
test('concurrent batch/manual enqueue deduplicates and serializes claims across sites',async()=>{
  const e=await setup();await e.db.addSite('second.com');
  await Promise.all([e.db.enqueueSites([host,'second.com']),e.db.enqueueSites([host]),e.db.enqueueSites([host,'second.com'])]);
  assert.equal((await e.db.listJobs()).length,2);
  const job=await e.db.claimJob();assert.equal(await e.db.claimJob(),null);
  await e.db.failJob({...job,attempts:3},'failed');
  const next=await e.db.claimJob();assert.notEqual(next.siteId,job.siteId);
});
test('repeated interruptions and overall timeout terminate without altering baseline',async()=>{
  const e=await setup();await scan(e,['a','b']);await e.db.enqueueSites([host]);
  for(let i=0;i<3;i++){await e.db.claimJob();e.advance(60001);}
  await drain(e);assert.equal((await e.db.listJobs()).length,0);
  assert.equal((await e.db.getSite(host)).lastStatus,'error');
  await e.db.enqueueSites([host]);await e.db.claimJob();e.advance(e.db.JOB_MS+1);await drain(e);
  assert.equal((await e.db.listJobs()).length,0);assert.equal((await e.db.getSiteUrls(host)).length,2);
});
test('robots denied or cross-domain declaration cannot fall back to smaller sitemap',async()=>{
  for(const robots of [new Error('denied'),'Sitemap: https://other.com/sitemap.xml']){
    const e=await setup();e.routes.set('https://example.com/robots.txt',robots);e.routes.set(root,xml(['a']));
    await assert.rejects(()=>e.sitemap.collect(host));assert.equal(e.calls.includes(root),false);
  }
});
test('commit replay with old lease token cannot duplicate scan history or changes',async()=>{
  const e=await setup();await scan(e,['a','b','c','d','e']);e.routes.set(root,xml(['a','b','c','d','f']));
  await e.db.enqueueSites([host]);let job;
  while(true){job=await e.db.claimJob();if(job.state?.phase==='done')break;await e.db.checkpoint(job,await e.sitemap.step(job.state||e.sitemap.initial(host)));}
  const info={root,files:1,complete:true};
  assert.equal((await e.db.commitScan(host,job.state.pages,info,job)).status,'success');
  assert.equal((await e.db.commitScan(host,job.state.pages,info,job)).status,'stale');
  assert.equal((await e.db.listScans(host)).length,2);assert.equal((await e.db.listChanges(host)).length,2);
});
test('version 1 migration preserves baseline and history while adding jobs',async()=>{
  const e=environment();
  await new Promise((resolve,reject)=>{
    const req=e.indexedDB.open('sitelens',1);
    req.onupgradeneeded=()=>{
      const db=req.result;db.createObjectStore('sites',{keyPath:'id'});
      const urls=db.createObjectStore('urls',{keyPath:['siteId','loc']});urls.createIndex('bySite','siteId');
      for(const name of ['scans','changes']){const store=db.createObjectStore(name,{keyPath:'id',autoIncrement:true});store.createIndex('bySiteTime',['siteId','at']);}
    };
    req.onsuccess=()=>{const db=req.result;const tx=db.transaction(['sites','urls','scans'],'readwrite');
      tx.objectStore('sites').put({id:host,lastSuccessAt:100,lastCount:1,lastStatus:'success'});
      tx.objectStore('urls').put({siteId:host,loc:'https://example.com/a'});
      tx.objectStore('scans').add({siteId:host,at:100,status:'success'});
      tx.oncomplete=()=>{db.close();resolve();};};req.onerror=()=>reject(req.error);
  });
  assert.equal((await e.db.getSiteUrls(host)).length,1);assert.equal((await e.db.listScans(host)).length,1);
  await e.db.enqueueSites([host]);assert.equal((await e.db.listJobs()).length,1);
});
test('robots declarations are all required and fallback only skips absent paths',async()=>{
  const e=await setup();e.routes.set('https://example.com/robots.txt','Sitemap: https://example.com/one.xml\nSitemap: https://example.com/two.xml');
  e.routes.set('https://example.com/one.xml',xml(['a']));
  await assert.rejects(()=>e.sitemap.collect(host));
  const fallback=environment();fallback.routes.set('https://example.com/sitemap_index.xml',xml(['a']));
  assert.equal((await fallback.sitemap.collect(host)).pages.length,1);
});
test('parser messaging timeout preserves saved baseline',async()=>{
  const e=await setup();await scan(e,['a','b']);
  e.context.chrome.runtime.sendMessage=()=>new Promise(()=>{});
  // Accelerate timers only in the fixture; production uses 12s per fetch/parser.
  e.context.setTimeout=(fn)=>setTimeout(fn,5);
  await e.db.enqueueSites([host]);await drain(e);
  assert.equal((await e.db.getSiteUrls(host)).length,2);assert.equal((await e.db.listChanges(host)).length,0);
});
test('network fetch timeout aborts and never replaces baseline',async()=>{
  const e=await setup();await scan(e,['a','b']);
  e.context.fetch=(_url,{signal})=>new Promise((_,reject)=>signal.addEventListener('abort',()=>reject(new Error('Aborted fetch'))));
  e.context.setTimeout=fn=>setTimeout(fn,5);
  await e.db.enqueueSites([host]);await drain(e);
  assert.match((await e.db.getSite(host)).lastError,/Aborted/);
  assert.equal((await e.db.getSiteUrls(host)).length,2);assert.equal((await e.db.listChanges(host)).length,0);
});
test('disappearing child file triggers review even with a small URL decline',async()=>{
  const e=await setup();e.routes.set(root,index(['https://example.com/one.xml','https://example.com/two.xml']));
  e.routes.set('https://example.com/one.xml',xml(['a','b','c','d']));e.routes.set('https://example.com/two.xml',xml(['e']));
  await e.db.enqueueSites([host]);await drain(e);
  e.routes.set(root,index(['https://example.com/one.xml']));await e.db.enqueueSites([host]);await drain(e);
  assert.equal((await e.db.getSite(host)).lastStatus,'review');
  assert.equal((await e.db.getSiteUrls(host)).length,5);assert.equal((await e.db.listChanges(host)).length,0);
});
