const fs=require('node:fs');
const vm=require('node:vm');
const {webcrypto}=require('node:crypto');
const {IDBFactory,IDBKeyRange}=require('fake-indexeddb');
const {JSDOM}=require('jsdom');
function environment(options={}){
  let now=options.now||1700000000000;
  const routes=new Map(),calls=[];
  let parser;
  class Clock extends Date {constructor(...args){super(...(args.length?args:[now]));}static now(){return now;}}
  const context=vm.createContext({console,Date:Clock,indexedDB:options.indexedDB||new IDBFactory(),IDBKeyRange,
    crypto:webcrypto,TextEncoder,TextDecoder,URL,AbortController,Response,Blob,DecompressionStream,
    structuredClone,setTimeout,clearTimeout,DOMParser:new JSDOM('').window.DOMParser,
    chrome:{runtime:{getURL:p=>'chrome-extension://test/'+p,getContexts:async()=>[{}],
      onMessage:{addListener:f=>{parser=f;}},sendMessage:async msg=>new Promise(resolve=>parser(msg,{},resolve))}},
    fetch:async url=>{
      calls.push(url);const body=routes.get(url);
      if(body instanceof Error)throw body;
      const response=new Response(body??'missing',{status:body===undefined?404:200});
      Object.defineProperty(response,'url',{value:url});return response;
    }});
  function load(file,name){vm.runInContext(fs.readFileSync(file,'utf8'),context,{filename:file});return name?vm.runInContext(name,context):null;}
  load('offscreen.js');
  return {db:load('db.js','SiteLensDB'),sitemap:load('sitemap.js','SiteLensSitemap'),context,routes,calls,
    advance:ms=>{now+=ms;},now:()=>now,indexedDB:context.indexedDB,load};
}
const host='example.com',root='https://example.com/sitemap.xml';
function xml(rows){return '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">'+rows.map(r=>'<url><loc>https://example.com/'+(typeof r==='string'?r:r.path)+'</loc><lastmod>'+(r.lastmod||'')+'</lastmod></url>').join('')+'</urlset>';}
function index(links){return '<sitemapindex>'+links.map(loc=>'<sitemap><loc>'+loc+'</loc></sitemap>').join('')+'</sitemapindex>';}
async function drain(env){
  for(let i=0;i<200;i++){
    const job=await env.db.claimJob();if(!job)return;
    try{
      if(job.attempts>3||env.now()-job.startedAt>env.db.JOB_MS)throw new Error('deadline/interruption');
      if(job.state?.phase==='done')await env.db.commitScan(host,job.state.pages,{root:job.state.roots.join(', '),files:job.state.visited.length,complete:true},job);
      else await env.db.checkpoint(job,await env.sitemap.step(job.state||env.sitemap.initial(job.siteId)));
    }catch(e){await env.db.failJob(job,e);}
  }
  throw new Error('queue did not yield');
}
async function scan(env,rows){env.routes.set(root,xml(rows));await env.db.enqueueSites([host]);await drain(env);}
module.exports={environment,host,root,xml,index,drain,scan};
