'use strict';
// Public, invented fixtures only. No profile, real sheet, network, or live deployment.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const args = process.argv.slice(2), selfTest = args[2] === '--self-test';
if ((!selfTest && args.length !== 2) || (selfTest && args.length !== 3)) throw Error('Usage: node compat.cjs BASE CANDIDATE [--self-test]');
const html = p => fs.readFileSync(fs.statSync(p).isDirectory() ? path.join(p,'index.html') : p, 'utf8');
const csv = rows => '\uFEFF' + rows.map(row => row.map(x => '"' + String(x).replaceAll('"','""') + '"').join(',')).join('\r\n');
const files = {
  price: csv([['name','price','aliases','category','note','source','sourcePage','honorCost'],
    ['Example One','123','DemoAlias','消耗品','sample, "quoted"','Fiction','17','7'],
    ['Example Zero','0','','消耗品','','','','']]),
  process: csv([['name','rank','price','weapon','armor','multiCountable','maxCount','recordType','table','prefix'],
    ['Example Finish','B',17,1,0,1,3,'','',''],['Example Finish','SS',59,1,0,1,3,'','',''],['','','','','','','','prefix','Example Table','Example Prefix']]),
  honor: csv([['id','type','school','name','honorCost','freeEligible','prerequisites','source','sourcePage','notes'],
    ['test-parent','school','','Example School',31,'false','','Fiction','12',''],
    ['test-child','art','test-parent','Example Art',11,'true','','Fiction','13','sample']]),
  general: csv([['skill','check','abilities','aliases','minLevel','notes'],
    ['Example Skill','Example Check','Dex|Int','SkillAlias',2,'sample, "quoted"']]),
  palette: csv([['id','category','name','trigger','requires','skill','level','mp','command','notes','source','modifier'],
    ['test-palette','loot','Example Loot','base','','','','','2d+${loot} Example','','Fiction','']]),
};
const url='https://release-compat.invalid/';
async function open(context, source) {
  const errors = [];
  const page = await context.newPage();
  page.setDefaultTimeout(5000);
  page.on('pageerror', e => errors.push(e.message));
  await page.route('**/*', route => {
    const u=route.request().url();
    if (u===url) return route.fulfill({body:source,contentType:'text/html; charset=utf-8'});
    if (u===url+'local-json-files.json') return route.fulfill({body:'[]',contentType:'application/json'});
    return route.abort('blockedbyclient');
  });
  await page.goto(url);
  const version=await page.evaluate(() => VERSION);
  const match=/^v(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (!match) throw Error('Unsupported release version: '+version);
  const [,maj,min,patch]=match.map(Number);
  const palette=maj>1 || (maj===1 && (min>10 || (min===10 && patch>=60)));
  assert.equal(await page.locator('#pcPaletteFile').count(),Number(palette),'missing/unexpected palette importer');
  assert.deepEqual(errors,[],'initialization errors');
  return {page,errors,palette,version};
}
async function seed(instance) {
  const {page,palette}=instance;
  const file = (id,kind) => page.locator('#'+id).setInputFiles({name:'example-'+kind+'.csv',mimeType:'text/csv',buffer:Buffer.from(files[kind])});
  await file('priceCsvFile','price');
  await page.locator('#applyPriceDictionaryImportBtn').click();
  await file('processCsvFile','process');
  await page.locator('#confirmOkBtn').click();
  await file('honorCsvFile','honor'); await file('generalSkillCsvFile','general');
  if(palette) await file('pcPaletteFile','palette');
  // FileReader/Blob callbacks may still be pending. Observe completion in the running app.
  await page.waitForFunction(want => state.confirmedPriceItems.length>=2 && state.processMaster.some(x=>x.name==='Example Finish')
    && state.honorCatalog.length && state.generalSkillCatalog.length && (!want || pcPaletteRules.length),palette,{timeout:5000});
}
async function assertRecords(instance,hasPalette) {
  const {page,errors}=instance;
  const data=await page.evaluate(want => {
    const quote = getItemPriceQuote('DemoAlias'), item=quote.item || {};
    const zero=getItemPriceQuote('Example Zero'), missing=getItemPriceQuote('Missing Example');
    const general=state.generalSkillCatalog.find(r=>r.name==='Example Skill');
    return {
      price: [quote.found,quote.price,item.name,item.note,item.source,item.sourcePage,Number(item.honorCost),zero.found,zero.price,missing.found],
      process: state.processMaster.filter(r=>r.name==='Example Finish').map(r=>[r.rank,r.price,r.weapon,r.armor,r.maxCount]).sort(),
      prefix: getActiveProcessPrefixRows().filter(r=>r.table==='Example Table').map(r=>r.prefix),
      honor: state.honorCatalog.filter(r=>r.id.startsWith('test-')).map(r=>[r.id,r.school,r.honorCost,r.freeEligible]),
      general: general && [general.aliases,general.checks.map(c=>[c.name,c.abilities,c.minLevel,c.notes])],
      palette: want ? pcPaletteLines({},pcPaletteRules).loot : null,
    };
  },hasPalette);
  const expected={
    price:[true,123,'Example One','sample, "quoted"','Fiction','17',7,true,0,false],
    process:[['B',17,true,false,3],['SS',59,true,false,3]],
    prefix:['Example Prefix'], honor:[['test-parent','',31,false],['test-child','test-parent',11,true]],
    general:[['SkillAlias'],[['Example Check',['Dex','Int'],2,'sample, "quoted"']]],
    palette:hasPalette?['2d+0 Example']:null,
  };
  for(const key of Object.keys(expected)) assert.deepEqual(data[key],expected[key],key+' compatibility');
  assert.deepEqual(errors,[],'runtime errors');
}
async function run() {
  const base=html(args[0]),candidate=html(args[1]);
  const browser=await chromium.launch({headless:true,...(process.env.TEST_CHROME?{executablePath:process.env.TEST_CHROME}:{})});
  const context=()=>browser.newContext({serviceWorkers:'block'});
  try {
    const existing=await context();
    const old=await open(existing,base);
    await seed(old); await assertRecords(old,old.palette); await old.page.close();
    const upgraded=await open(existing,candidate);
    if(old.palette && !upgraded.palette) throw Error('existing optional CSV importer disappeared');
    await assertRecords(upgraded,old.palette); await upgraded.page.close();
    // Even a one-time destructive migration must be noticed after a second launch.
    const again=await open(existing,candidate);
    await assertRecords(again,old.palette); await again.page.close();
    const fresh=await context(), next=await open(fresh,candidate);
    await seed(next); await assertRecords(next,next.palette); await fresh.close();
    if(selfTest) {
      // Simulate a version that silently loses one saved catalog (memory only).
      const broken=await open(existing,candidate.replace('</head>', '<script>localStorage.removeItem("sw25_honor_csv_text");<\/script></head>'));
      await assert.rejects(assertRecords(broken,old.palette),/honor compatibility/,'negative control must detect lost data');
    }
    console.log('CSV compatibility passed:',old.version,'->',next.version,'; existing browser, repeat launch and fresh import'+(selfTest?'; negative control passed':''));
  } finally { await browser.close(); }
}
run().catch(e=>{console.error(e);process.exitCode=1;});
