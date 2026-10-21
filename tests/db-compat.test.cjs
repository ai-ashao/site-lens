// Prerequisite: npm install --no-save --package-lock=false fake-indexeddb
const {test}=require('node:test');
const assert=require('node:assert/strict');
const vm=require('node:vm');
const fs=require('node:fs');
const {IDBFactory,IDBKeyRange}=require('fake-indexeddb');
const code=fs.readFileSync(require('node:path').join(__dirname,'..','db.js'),'utf8');
function environment(){
  const indexedDB=new IDBFactory();
  const context=vm.createContext({indexedDB,IDBKeyRange,URL,console});
  vm.runInContext(code,context);
  return {indexedDB,db:vm.runInContext('SiteLensDB',context)};
}
function open(factory,version,upgrade){return new Promise((resolve,reject)=>{
  const req=factory.open('sitelens',version);req.onupgradeneeded=()=>upgrade?.(req.result);
  req.onsuccess=()=>resolve(req.result);req.onerror=()=>reject(req.error);
});}
async function seed(factory,version){
  const db=await open(factory,version,db=>{
    db.createObjectStore('sites',{keyPath:'id'});
    const urls=db.createObjectStore('urls',{keyPath:['siteId','loc']});urls.createIndex('bySite','siteId');
    for(const name of ['scans','changes']){
      const store=db.createObjectStore(name,{keyPath:'id',autoIncrement:true});store.createIndex('bySiteTime',['siteId','at']);
    }
    if(version===2)db.createObjectStore('jobs',{keyPath:'siteId'});
  });
  await new Promise((resolve,reject)=>{
    const tx=db.transaction(Array.from(db.objectStoreNames),'readwrite');
    tx.objectStore('sites').put({id:'example.com',lastSuccessAt:100,lastCount:1});
    tx.objectStore('urls').put({siteId:'example.com',loc:'https://example.com/a'});
    tx.objectStore('scans').add({siteId:'example.com',at:100,status:'success'});
    tx.objectStore('changes').add({siteId:'example.com',at:100,type:'added',loc:'https://example.com/a'});
    if(version===2)tx.objectStore('jobs').put({siteId:'example.com',scanId:'keep-me',state:{phase:'files'}});
    tx.oncomplete=resolve;tx.onabort=()=>reject(tx.error);
  });db.close();
}
for(const version of [1,2])test(`opens existing v${version} and preserves saved data`,async()=>{
  const {indexedDB,db}=environment();await seed(indexedDB,version);
  assert.equal((await db.listSites()).length,1);
  assert.equal((await db.getSite('example.com')).lastSuccessAt,100);
  assert.equal((await db.getSiteUrls('example.com')).length,1);
  assert.equal((await db.listScans('example.com')).length,1);
  assert.equal((await db.listChanges('example.com')).length,1);
  const connection=await open(indexedDB);assert.equal(connection.version,2);assert.ok(connection.objectStoreNames.contains('jobs'));
  if(version===2){
    const row=await new Promise((resolve,reject)=>{const q=connection.transaction('jobs').objectStore('jobs').get('example.com');q.onsuccess=()=>resolve(q.result);q.onerror=()=>reject(q.error);});
    assert.equal(row.scanId,'keep-me');assert.equal(row.state.phase,'files');
  }
  connection.close();
});
test('fresh installation creates schema compatible with the durable queue branch',async()=>{
  const {indexedDB,db}=environment();await db.addSite('example.com');
  const connection=await open(indexedDB);assert.equal(connection.version,2);
  assert.deepEqual(Array.from(connection.objectStoreNames),['changes','jobs','scans','sites','urls']);connection.close();
});
