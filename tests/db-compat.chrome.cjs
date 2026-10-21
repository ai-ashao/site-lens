// Prerequisite: npm install --no-save --package-lock=false playwright
// Then: npx playwright install chromium; node tests/db-compat.chrome.cjs
const {chromium}=require('playwright');
const fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path');
const assert=require('node:assert/strict');
(async()=>{
  const profile=await fs.mkdtemp(path.join(os.tmpdir(),'sitelens-compat-'));let context;
  try{
    context=await chromium.launchPersistentContext(profile,{headless:true,channel:'chromium',
      ...(process.env.CHROME_EXECUTABLE?{executablePath:process.env.CHROME_EXECUTABLE}:{}),
      args:['--disable-extensions-except='+process.cwd(),'--load-extension='+process.cwd()]});
    const worker=context.serviceWorkers()[0]||await context.waitForEvent('serviceworker');
    const id=new URL(worker.url()).host,page=await context.newPage();
    const errors=[];page.on('pageerror',e=>errors.push(e.message));
    await page.goto('chrome-extension://'+id+'/sidepanel.html');
    await page.waitForFunction(()=>document.querySelector('#site-status')?.textContent==='不支持');
    await page.evaluate(async()=>{
      const db=await new Promise((resolve,reject)=>{const req=indexedDB.open('sitelens',2);
        req.onupgradeneeded=()=>{const db=req.result;db.createObjectStore('sites',{keyPath:'id'});
          const urls=db.createObjectStore('urls',{keyPath:['siteId','loc']});urls.createIndex('bySite','siteId');
          for(const name of ['scans','changes']){const store=db.createObjectStore(name,{keyPath:'id',autoIncrement:true});store.createIndex('bySiteTime',['siteId','at']);}
          db.createObjectStore('jobs',{keyPath:'siteId'});
        };req.onsuccess=()=>resolve(req.result);req.onerror=()=>reject(req.error);});
      await new Promise((resolve,reject)=>{const tx=db.transaction(['sites','urls','scans','changes','jobs'],'readwrite');
        tx.objectStore('sites').put({id:'example.com',lastStatus:'success',lastSuccessAt:100,lastCount:1,sitemapFiles:1});
        tx.objectStore('urls').put({siteId:'example.com',loc:'https://example.com/saved'});
        tx.objectStore('scans').add({siteId:'example.com',at:100,status:'success'});
        tx.objectStore('changes').add({siteId:'example.com',at:100,type:'added',loc:'https://example.com/saved'});
        tx.objectStore('jobs').put({siteId:'example.com',scanId:'keep-me',state:{phase:'files'}});
        tx.oncomplete=resolve;tx.onerror=()=>reject(tx.error);});db.close();
      current.domain='example.com';current.selected='sitemap';current.site=await SiteLensDB.getSite(current.domain);render();
    });
    await page.waitForFunction(()=>document.querySelector('#sitemap-changes')?.textContent.includes('/saved'));
    assert.equal((await page.locator('body').innerText()).includes('requested version'),false);
    const saved=await page.evaluate(async()=>({urls:await SiteLensDB.getSiteUrls('example.com'),scans:await SiteLensDB.listScans('example.com')}));
    assert.equal(saved.urls.length,1);assert.equal(saved.scans.length,1);assert.deepEqual(errors,[]);
    console.log('PASS real Chrome v2 data and Sitemap history render without VersionError ('+context.browser().version()+')');
  }finally{await context?.close();await fs.rm(profile,{recursive:true,force:true});}
})().catch(e=>{console.error(e);process.exitCode=1;});
