const {test}=require('node:test');
const assert=require('node:assert/strict');
const {environment,host,root,xml,index,drain,scan}=require('./helpers.cjs');
async function setup(){const e=environment();await e.db.addSite(host);return e;}
async function ready(e){
  for(let i=0;i<100;i++){
    const job=await e.db.claimJob();assert.ok(job,'runnable job');
    if(job.state?.phase==='done')return job;
    await e.db.checkpoint(job,await e.sitemap.step(job.state||e.sitemap.initial(host)));
  }
  throw new Error('no completed candidate');
}
function commit(e,job){return e.db.commitScan(host,job.state.pages,{root:job.state.roots.join(', '),files:job.state.visited.length,sources:job.state.visited,complete:true},job);}
test('commit cannot cross a lease or overall deadline, even without a replacement worker',async()=>{
  for(const timeout of [60000,30*60*1000]){
    const e=await setup();await scan(e,['a','b','c','d','e']);
    e.routes.set(root,xml(['a','b','c','d','f']));await e.db.enqueueSites([host]);const job=await ready(e);
    e.advance(timeout+1);
    await assert.rejects(()=>commit(e,job),/lease|deadline/i);
    assert.equal((await e.db.listScans(host)).length,1);assert.equal((await e.db.listChanges(host)).length,0);
    await e.db.failJob(job,'expired');
  }
});
test('late checkpoint cannot reset interruption attempts after its lease expires',async()=>{
  const e=await setup();await e.db.enqueueSites([host]);const job=await e.db.claimJob();
  e.advance(60001);await assert.rejects(()=>e.db.checkpoint(job,{phase:'done',pages:[]}),/lease/i);
  assert.equal((await e.db.listJobs())[0].attempts,1);
});
test('confirmation collected before the separation interval cannot be accepted by delaying commit',async()=>{
  const e=await setup();await scan(e,['a','b','c','d','e']);await scan(e,['a']);
  e.advance(300000);e.routes.set(root,xml(['b']));await drain(e); // unstable auto review ends
  e.advance(299000);await e.db.enqueueSites([host]);const job=await ready(e);
  e.advance(2000); // still within the lease; now passes 5m by completion time only
  assert.equal((await commit(e,job)).status,'review');
  assert.equal((await e.db.getSiteUrls(host)).length,5);assert.equal((await e.db.listChanges(host)).length,0);
});
test('old review evidence expires across a long browser shutdown',async()=>{
  const e=await setup();await scan(e,['a','b','c','d','e']);await scan(e,['a']);
  e.advance(24*60*60*1000);await drain(e);
  assert.equal((await e.db.getSiteUrls(host)).length,5);assert.equal((await e.db.getSite(host)).lastStatus,'review');
  e.advance(300000);await drain(e);
  assert.equal((await e.db.getSiteUrls(host)).length,1);
});
test('equal or growing file counts do not hide a replaced child Sitemap',async()=>{
  for(const grow of [false,true]){
    const e=await setup(),one='https://example.com/one.xml',two='https://example.com/two.xml';
    e.routes.set(root,index([one,two]));e.routes.set(one,xml(['a','b','c','d']));e.routes.set(two,xml(['e']));
    await e.db.enqueueSites([host]);await drain(e);
    const replacement='https://example.com/new.xml';e.routes.set(replacement,xml(['a']));
    const links=[one,replacement];if(grow){links.push('https://example.com/extra.xml');e.routes.set(links[2],xml(['b']));}
    e.routes.set(root,index(links));await e.db.enqueueSites([host]);await drain(e);
    assert.equal((await e.db.getSite(host)).lastStatus,'review');
    assert.equal((await e.db.getSiteUrls(host)).length,5);assert.equal((await e.db.listChanges(host)).length,0);
  }
});
test('startup recovery cannot resurrect a scan completed while boot reads site status',async()=>{
  const e=await setup();await scan(e,['a','b','c','d','e']);
  await e.db.enqueueSites([host]);const job=await ready(e);
  const listSites=e.db.listSites;
  let signalRead,signalCommit;
  const read=new Promise(resolve=>{signalRead=resolve;});
  const completed=new Promise(resolve=>{signalCommit=resolve;});
  e.db.listSites=async()=>{
    const snapshot=await listSites();signalRead();await completed;return snapshot;
  };
  const boot=e.startBackground();
  // Old boot reads listSites here; atomic recovery never calls this split read.
  await Promise.race([read,new Promise(resolve=>setTimeout(resolve,10))]);
  await commit(e,job);signalCommit();await boot;
  assert.equal((await e.db.listScans(host)).length,2);
  assert.equal((await e.db.listJobs()).length,0);
});
test('parallel boots recover only orphaned legacy scans and do not duplicate an active job',async()=>{
  const e=await setup();const site=await e.db.getSite(host);
  await e.db.putSite({...site,lastStatus:'scanning'});e.routes.set(root,xml(['a','b','c']));
  await Promise.all([e.db.recoverJobs(),e.db.recoverJobs(),e.db.enqueueSites([host])]);
  assert.equal((await e.db.listJobs()).length,1);
  const original=await e.db.claimJob();const scanId=original.scanId;
  await Promise.all([e.db.recoverJobs(),e.db.recoverJobs()]);
  assert.equal((await e.db.listJobs())[0].scanId,scanId);
  await e.db.checkpoint(original,await e.sitemap.step(e.sitemap.initial(host)));
  await e.startBackground();
  assert.equal((await e.db.listScans(host)).length,1);assert.equal((await e.db.listJobs()).length,0);
});
test('late failure handler cannot replace the resumed job or change site status',async()=>{
  const e=await setup();await e.db.enqueueSites([host]);const old=await e.db.claimJob();
  e.advance(60001);const resumed=await e.db.claimJob();
  assert.equal(await e.db.failJob(old,'late error'),false);
  assert.equal((await e.db.listJobs())[0].token,resumed.token);assert.equal((await e.db.getSite(host)).lastStatus,'scanning');
});
test('write-time fencing catches expiry during fingerprint calculation',async()=>{
  const e=await setup();await scan(e,['a','b','c','d','e']);
  e.routes.set(root,xml(['a','b','c','d','f']));await e.db.enqueueSites([host]);const job=await ready(e);
  const crypto=e.context.crypto;
  e.context.crypto={...crypto,subtle:{digest:async(...args)=>{e.advance(e.db.JOB_MS+1);return crypto.subtle.digest(...args);}}};
  await assert.rejects(()=>commit(e,job),/deadline/i);
  assert.equal((await e.db.listScans(host)).length,1);assert.equal((await e.db.listChanges(host)).length,0);
});
test('restart after final checkpoint commits once without downloading completed files again',async()=>{
  const e=await setup();await scan(e,['a','b','c','d','e']);
  e.routes.set(root,xml(['a','b','c','d','f']));await e.db.enqueueSites([host]);const old=await ready(e);
  const restarted=environment({indexedDB:e.indexedDB,now:e.now()+60001});
  await restarted.startBackground();
  assert.deepEqual(restarted.calls,[]);assert.equal((await restarted.db.listScans(host)).length,2);
  assert.equal((await restarted.db.listChanges(host)).length,2);assert.equal((await restarted.db.listJobs()).length,0);
  assert.equal((await commit(e,old)).status,'stale');
  assert.equal((await restarted.db.listChanges(host)).length,2);
});
test('confirmation fingerprint includes child identities even when pages and file counts match',async()=>{
  const e=await setup(),one='https://example.com/one.xml',two='https://example.com/two.xml',replacement='https://example.com/new.xml';
  e.routes.set(root,index([one,two]));e.routes.set(one,xml(['a','b','c','d']));e.routes.set(two,xml(['e']));
  await e.db.enqueueSites([host]);await drain(e);
  e.routes.set(replacement,xml(['a']));e.routes.set(root,index([one,replacement]));
  await e.db.enqueueSites([host]);await drain(e);const first=(await e.db.getSite(host)).review.fingerprint;
  e.advance(300000);const another='https://example.com/newer.xml';e.routes.set(another,xml(['a']));e.routes.set(root,index([one,another]));
  await drain(e);
  assert.notEqual((await e.db.getSite(host)).review.fingerprint,first);
  assert.equal((await e.db.getSiteUrls(host)).length,5);assert.equal((await e.db.listChanges(host)).length,0);
});
