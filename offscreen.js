/* DOMParser is not available in extension service workers: parse XML here. */
function firstChildText(node, name) {
  const child = Array.from(node.children).find(c => c.localName === name);
  return child ? child.textContent.trim() : "";
}
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || message.type !== "SITELENS_PARSE_XML") return;
  try {
    const doc = new DOMParser().parseFromString(message.xml, "application/xml");
    if (doc.querySelector("parsererror")) throw new Error("Invalid Sitemap XML");
    const root = doc.documentElement;
    const entries = Array.from(root.children);
    const expected=root.localName==="sitemapindex"?"sitemap":"url";
    if(entries.some(e=>e.localName!==expected))throw new Error("Unexpected Sitemap entry");
    if(entries.some(e=>Array.from(e.children).filter(c=>c.localName==="loc").length!==1 || !firstChildText(e,"loc")))
      throw new Error("Missing or duplicate Sitemap loc");
    if (root.localName === "sitemapindex") {
      sendResponse({ok:true, kind:"index", links:entries.filter(e=>e.localName==="sitemap").map(e=>firstChildText(e,"loc"))});
    } else if (root.localName === "urlset") {
      sendResponse({ok:true, kind:"urls", pages:entries.filter(e=>e.localName==="url").map(e=>({loc:firstChildText(e,"loc"),lastmod:firstChildText(e,"lastmod")}))});
    } else throw new Error("Not a Sitemap XML (root: " + root.localName + ")");
  } catch (error) { sendResponse({ok:false,error:String(error.message||error)}); }
});
