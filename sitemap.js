/* Public Sitemap fetcher. Incomplete scans THROW and never replace the saved baseline. */
const SiteLensSitemap = (()=>{
  const MAX_FILES=80,MAX_URLS=100000,MAX_BYTES=12_000_000,TIMEOUT_MS=12000;
  let creatingOffscreen=null;
  function sameSite(url,host){
    try {const u=new URL(url);const a=u.hostname.toLowerCase(),b=host.toLowerCase();
      return ["http:","https:"].includes(u.protocol) && (a===b || a==="www."+b || b==="www."+a);
    }catch{return false;}
  }
  function absoluteUrl(input,base,host){
    try {const u=new URL(input,base);u.hash="";
      return sameSite(u.href,host)?u.href:null;
    }catch{return null;}
  }
  async function getText(url,host){
    if(!sameSite(url,host)) throw new Error("Cross-domain Sitemap URL rejected: "+url);
    const controller=new AbortController(), timer=setTimeout(()=>controller.abort(),TIMEOUT_MS);
    try {
      const res=await fetch(url,{signal:controller.signal,credentials:"omit",redirect:"follow",cache:"no-store"});
      if(!res.ok) throw new Error("HTTP "+res.status+" at "+url);
      if(!sameSite(res.url,host)) throw new Error("Cross-domain redirect rejected");
      const declared=Number(res.headers.get("content-length")||"0");
      if(declared>MAX_BYTES) throw new Error("Sitemap exceeds size limit");
      const bytes=new Uint8Array(await res.arrayBuffer());
      if(bytes.length>MAX_BYTES) throw new Error("Sitemap exceeds size limit");
      const gzip=bytes.length>=2&&bytes[0]===0x1f&&bytes[1]===0x8b;
      const data=gzip?await new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"))).arrayBuffer():bytes;
      if(data.byteLength>MAX_BYTES) throw new Error("Uncompressed Sitemap exceeds size limit");
      return new TextDecoder("utf-8").decode(data);
    } finally {clearTimeout(timer);}
  }
  async function ensureOffscreen(){
    const url=chrome.runtime.getURL("offscreen.html");
    const contexts=await chrome.runtime.getContexts({contextTypes:["OFFSCREEN_DOCUMENT"],documentUrls:[url]});
    if(contexts.length) return;
    if(!creatingOffscreen) creatingOffscreen=chrome.offscreen.createDocument({
      url:"offscreen.html",reasons:["DOM_PARSER"],
      justification:"Parse public competitor Sitemap XML safely outside the service worker"
    }).finally(()=>{creatingOffscreen=null;});
    await creatingOffscreen;
  }
  async function parseXml(xml){
    await ensureOffscreen();
    const reply=await chrome.runtime.sendMessage({type:"SITELENS_PARSE_XML",xml});
    if(!reply?.ok) throw new Error(reply?.error||"Unable to parse Sitemap XML");
    return reply;
  }
  async function collect(host){
    const start="https://"+host+"/";
    let declared=[];
    try {
      const robots=await getText(new URL("robots.txt",start).href,host);
      declared=robots.split(/\r?\n/).map(line=>line.match(/^\s*sitemap\s*:\s*(\S+)/i)?.[1])
        .filter(Boolean).map(v=>absoluteUrl(v,start,host)).filter(Boolean);
    } catch {} // A missing robots file is normal; use common Sitemap paths.
    const fallbacks=["sitemap.xml","sitemap_index.xml","wp-sitemap.xml"].map(p=>new URL(p,start).href);
    let rootUrls=[],rootResults=[];
    if(declared.length) {
      rootUrls=[...new Set(declared)];
      for(const url of rootUrls) rootResults.push({url,data:await parseXml(await getText(url,host))});
    } else {
      let lastError;
      for(const url of fallbacks) {
        try {rootResults=[{url,data:await parseXml(await getText(url,host))}];rootUrls=[url];break;}
        catch(e){lastError=e;}
      }
      if(!rootResults.length) throw new Error("No public Sitemap found. "+String(lastError?.message||""));
    }
    const queue=[...rootResults], visited=new Set(),pageMap=new Map();
    let processed=0;
    while(queue.length){
      const item=queue.shift();
      if(visited.has(item.url)) continue;
      visited.add(item.url); processed++;
      if(processed>MAX_FILES) throw new Error("More than "+MAX_FILES+" Sitemap files; keeping previous scan unchanged");
      const data=item.data||await parseXml(await getText(item.url,host));
      if(data.kind==="index"){
        for(const raw of data.links){
          const loc=absoluteUrl(raw,item.url,host);
          if(loc&&!visited.has(loc) && !queue.some(x=>x.url===loc)) queue.push({url:loc});
        }
      } else {
        for(const row of data.pages){
          const loc=absoluteUrl(row.loc,item.url,host);
          if(loc) pageMap.set(loc,{loc,lastmod:row.lastmod||""});
          if(pageMap.size>MAX_URLS) throw new Error("More than "+MAX_URLS+" URLs; keeping previous scan unchanged");
        }
      }
    }
    return {pages:[...pageMap.values()],root:rootUrls.join(", "),files:processed};
  }
  return {collect};
})();
