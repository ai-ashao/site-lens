const $=id=>document.getElementById(id);
let activeDomain=null;
async function send(type,data={}) {
  const result=await chrome.runtime.sendMessage({type,...data});
  if(!result?.ok) throw new Error(result?.error||"操作失败");
  return result.data;
}
function message(value,isError=false){$("status").textContent=value;$("status").className="notice"+(isError?" error":"");}
async function updateCount(){
  const sites=await send("SITELENS_LIST_SITES");
  $("count").textContent="已监控 "+sites.length+" 个网站";
  $("add").textContent=sites.some(s=>s.id===activeDomain)?"已添加 · 再次添加不会重复":"添加到监控列表";
}
(async()=>{
  try {
    const [tab]=await chrome.tabs.query({active:true,currentWindow:true});
    if(tab?.url&&/^https?:\/\//.test(tab.url)){
      activeDomain=new URL(tab.url).hostname.toLowerCase().replace(/\.$/,"");
      $("domain").textContent=activeDomain;
    }else{
      $("domain").textContent="请打开一个 HTTP(S) 网站";
      $("add").disabled=true;$("scan").disabled=true;
    }
    await updateCount();
  }catch(e){message(e.message,true);}
})();
$("add").addEventListener("click",async()=>{
  try {
    if(!activeDomain)return;
    await send("SITELENS_ADD_SITE",{domain:activeDomain});message("已添加监控；首次扫描会建立基线。");
    await updateCount();
  }catch(e){message(e.message,true);}
});
$("scan").addEventListener("click",async()=>{
  try{
    if(!activeDomain)return;
    await send("SITELENS_ADD_SITE",{domain:activeDomain});
    await send("SITELENS_SCAN_SITE",{domain:activeDomain});
    message("扫描任务已启动。详情请在面板中查看。");
    await updateCount();
  }catch(e){message(e.message,true);}
});
$("dashboard").addEventListener("click",()=>chrome.runtime.openOptionsPage());
