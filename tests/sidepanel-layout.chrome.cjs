// npm install --no-save --package-lock=false playwright
// npx playwright install chromium; node tests/sidepanel-layout.chrome.cjs
const {chromium}=require('playwright');
const fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path');
const assert=require('node:assert/strict');
(async()=>{
  const profile=await fs.mkdtemp(path.join(os.tmpdir(),'sitelens-layout-'));
  const output=process.env.SITELENS_QA_DIR||path.join(os.tmpdir(),'sitelens-layout-qa');
  let context;
  try{
    await fs.mkdir(output,{recursive:true});
    context=await chromium.launchPersistentContext(profile,{headless:true,channel:'chromium',viewport:{width:560,height:900},
      ...(process.env.CHROME_EXECUTABLE?{executablePath:process.env.CHROME_EXECUTABLE}:{}),
      args:['--disable-extensions-except='+process.cwd(),'--load-extension='+process.cwd()]});
    const worker=context.serviceWorkers()[0]||await context.waitForEvent('serviceworker');
    const id=new URL(worker.url()).host,page=await context.newPage(),errors=[];
    page.on('pageerror',e=>errors.push(e.message));
    await page.goto('chrome-extension://'+id+'/sidepanel.html');
    await page.waitForFunction(()=>document.querySelector('#site-status')?.textContent==='不支持');
    // Local deterministic content; no external requests or user profile changes.
    await page.evaluate(async()=>{
      current.domain='coolgamesfree.org';
      current.page={url:'https://coolgamesfree.org/',title:'Cool Games Free & Online | Ready To Play!',
        description:'Cool games, totally free. Play action, puzzle, sports, and IO games online instantly at CoolGamesFree.org. No downloads needed.',
        keywords:'cool games, coolgames, cool games free',canonical:'https://coolgamesfree.org/',metaRobots:'',htmlLang:'en-US',viewport:'width=device-width, initial-scale=1',
        headings:[{level:1,text:'Cool Games Free'},{level:1,text:'Popular online games'},{level:2,text:'Recommended games'}],
        images:[{src:'https://coolgamesfree.org/game-cover.png',alt:'',missingAlt:true}],imageStats:{total:24,missingAlt:1,lazy:18},
        links:[{href:'https://coolgamesfree.org/puzzle',text:'Puzzle games',external:false,rel:''}],linkStats:{total:83,internal:75,external:8,nofollow:0,sponsored:0,ugc:0},
        schemas:[{valid:true,type:'WebSite',keys:['@context','@type','name','url']}],hreflangs:[{lang:'en',href:'https://coolgamesfree.org/'}],metaTags:[{name:'description',content:'Free online games'}],
        wordCount:1250,keywordUnique:180,keywordStats:[{word:'games',count:35,percent:2.8}],social:{ogTitle:'Cool Games Free',ogDescription:'Play free online games.',ogImage:'https://coolgamesfree.org/social.png',twitterCard:'summary_large_image'}};
      current.rdap={domain:'coolgamesfree.org',created:'2026-01-15T04:03:47Z',expires:'2027-01-15T04:03:47Z',changed:'2026-10-20T00:00:00Z',age:.8,registrar:'Example registrar',nameservers:['ns1.example.com'],statuses:['active']};
      current.site=await SiteLensDB.addSite(current.domain);
      document.querySelector('#site-host').textContent=current.domain;document.querySelector('#site-url').textContent='/';document.querySelector('#site-status').textContent='已分析';render();
    });
    const tabs=['overview','issues','headings','density','images','links','structured','domain','sitemap'];
    for(const width of [320,380,440,560,720]){
      await page.setViewportSize({width,height:800});
      for(const tab of tabs){
        await page.locator(`[data-tab="${tab}"]`).click();
        await page.waitForFunction(()=>document.querySelector('#content').textContent.trim().length>0);
        const geometry=await page.evaluate(()=>{
          const nav=document.querySelector('#tabs').getBoundingClientRect(),content=document.querySelector('#content').getBoundingClientRect();
          const main=document.querySelector('#content'),active=document.querySelector('[aria-current="page"]');
          return {overflow:document.documentElement.scrollWidth>innerWidth,navLeft:nav.left,navRight:nav.right,contentLeft:content.left,
            contentOverflow:main.scrollWidth>main.clientWidth,active:active?.dataset.tab};
        });
        assert.equal(geometry.active,tab);assert.equal(geometry.overflow,false,`${width}/${tab} page overflow`);
        assert.equal(geometry.contentOverflow,false,`${width}/${tab} content overflow`);assert.ok(geometry.navRight<=geometry.contentLeft);
      }
      await page.locator('[data-tab="overview"]').click();
      await page.evaluate(()=>{document.querySelector('#content').scrollTop=0;document.querySelector('#tabs').scrollTop=0;});
      await page.screenshot({path:path.join(output,`sidepanel-${width}.png`)});
    }
    // Navigation remains fixed when the detail pane scrolls; short panels can
    // scroll navigation independently and still expose Sitemap and dashboard.
    await page.setViewportSize({width:380,height:480});
    const before=await page.locator('#tabs').boundingBox();
    await page.evaluate(()=>{document.querySelector('#content').scrollTop=500;});
    assert.equal((await page.locator('#tabs').boundingBox()).y,before.y);
    await page.locator('[data-tab="issues"]').click();
    assert.equal(await page.locator('#content').evaluate(node=>node.scrollTop),0,'tab switch resets details scroll');
    await page.locator('[data-tab="overview"]').click();await page.locator('[data-action="goto-sitemap"]').click();
    assert.equal(await page.locator('[aria-current="page"]').getAttribute('data-tab'),'sitemap');
    await page.locator('#dashboard').click();
    await page.waitForTimeout(200);
    const dashboard=context.pages().find(p=>p.url().endsWith('/dashboard.html'));
    assert.ok(dashboard,'dashboard opens from sidebar');
    const seq=await page.evaluate(()=>current.seq);await page.locator('#refresh').click();
    await page.waitForFunction(before=>current.seq>before,seq);
    assert.deepEqual(errors,[]);
    console.log('PASS 45 tab/viewport checks (320/380/440/560/720px), independent scrolling, dashboard action; Chrome '+context.browser().version());
    console.log('Screenshots: '+output);
  }finally{await context?.close();await fs.rm(profile,{recursive:true,force:true});}
})().catch(e=>{console.error(e);process.exitCode=1;});
