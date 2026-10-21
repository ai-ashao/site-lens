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
  async function parseXmlInner(xml){
    await ensureOffscreen();
    const reply=await chrome.runtime.sendMessage({type:"SITELENS_PARSE_XML",xml});
    if(!reply?.ok) throw new Error(reply?.error||"Unable to parse Sitemap XML");
    return reply;
  }
  async function parseXml(xml){
    let timer;
    try{return await Promise.race([parseXmlInner(xml),new Promise((_,reject)=>{
      timer=setTimeout(()=>reject(new Error("Sitemap parser timeout")),TIMEOUT_MS);
    })]);}finally{clearTimeout(timer);}
  }
  // One network document per step. The caller persists the returned state before
  // taking another step; only the unfinished document can be fetched again.
  function initial(host){return {phase:"robots",host,roots:[],pending:[],visited:[],pages:[]};}
  function requiredUrl(raw,base,host){
    if(!raw || !String(raw).trim()) throw new Error("Incomplete Sitemap: missing loc");
    const loc=absoluteUrl(raw,base,host);
    if(!loc) throw new Error("Incomplete Sitemap: cross-domain or invalid loc: "+raw);
    return loc;
  }
  async function step(saved){
    const state=structuredClone(saved),host=state.host,start="https://"+host+"/";
    if(state.phase==="robots"){
      let robots="";
      try {robots=await getText(new URL("robots.txt",start).href,host);}
      catch(e){if(!/^HTTP (404|410) at /.test(e.message)) throw e;}
      const declarations=robots.split(/\r?\n/).map(line=>line.match(/^\s*sitemap\s*:\s*(\S+)/i)?.[1]).filter(Boolean);
      state.roots=[...new Set(declarations.map(raw=>requiredUrl(raw,start,host)))];
      state.pending=[...state.roots];state.phase=state.roots.length?"files":"fallback";
      state.fallback=0;return state;
    }
    let url,data;
    if(state.phase==="fallback"){
      url=new URL(["sitemap.xml","sitemap_index.xml","wp-sitemap.xml"][state.fallback],start).href;
      try {data=await parseXml(await getText(url,host));}
      catch(e){
        // Only an absent path permits discovery to continue. Invalid XML, network
        // errors or access denial cannot establish that a smaller source is complete.
        if(!/^HTTP (404|410) at /.test(e.message) || ++state.fallback===3) throw e;
        return state;
      }
      state.roots=[url];state.pending=[url];state.phase="files";
    }
    url=state.pending[0];
    if(!url) throw new Error("Missing Sitemap work item");
    if(state.visited.length>=MAX_FILES) throw new Error("Sitemap file limit exceeded");
    data=data||await parseXml(await getText(url,host));
    if(data.kind==="index"){
      if(!Array.isArray(data.links)||!data.links.length) throw new Error("Empty Sitemap index; completeness unknown");
      for(const raw of data.links){
        const loc=requiredUrl(raw,url,host);
        if(!state.visited.includes(loc)&&!state.pending.includes(loc))state.pending.push(loc);
      }
    }else if(data.kind==="urls"&&Array.isArray(data.pages)){
      const pages=new Map(state.pages.map(row=>[row.loc,row]));
      for(const row of data.pages){
        const loc=requiredUrl(row.loc,url,host),lastmod=row.lastmod||"";
        if(pages.has(loc)&&pages.get(loc).lastmod!==lastmod) throw new Error("Conflicting lastmod for "+loc);
        pages.set(loc,{loc,lastmod});
        if(pages.size>MAX_URLS)throw new Error("Sitemap URL limit exceeded");
      }
      // Empty leaves can mean a transient outage even inside a nonempty index.
      if(!data.pages.length)throw new Error("Empty Sitemap; previous snapshot retained");
      state.pages=[...pages.values()];
    }else throw new Error("Invalid Sitemap parser response");
    state.visited.push(url);state.pending.shift();
    if(state.visited.length+state.pending.length>MAX_FILES) throw new Error("Sitemap file limit exceeded");
    if(!state.pending.length)state.phase="done";
    return state;
  }
  async function collect(host){
    let state=initial(host);
    while(state.phase!=="done")state=await step(state);
    return {pages:state.pages,root:state.roots.join(", "),files:state.visited.length,complete:true};
  }
  return {initial,step,collect};
})();
