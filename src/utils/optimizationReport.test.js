const test = require('node:test');
const assert = require('node:assert/strict');
const { allocateProfileCuts } = require('./profileOptimizer');
const { summarizeItems, buildOptimizationReportHtml, profileWasteStats } = require('./optimizationReport');
const makePlan = () => allocateProfileCuts([
  {sapCode:'P1',stockLength:6000,pieceLength:3000,quantity:1,source:{key:'1:1',label:'Window <1>',instance:1},row:{description:'Frame'}},
  {sapCode:'P1',stockLength:6000,pieceLength:2000,quantity:1,source:{key:'2:1',label:'Window 2',instance:1},row:{description:'Frame'}}
]).plans;
test('item wastage allocation reconciles with physical bar leftovers', () => {
  const plans = makePlan();
  const items = summarizeItems(plans);
  assert.equal(items[0].waste,600);
  assert.equal(items[1].waste,400);
  assert.equal(items.reduce((s,i) => s+i.waste,0),plans[0].totalLeftoverMm);
  assert.deepEqual([...items[0].bars],[1]);
});
test('report includes item identity, actual waste, escaped text and proof status', () => {
  const plans = makePlan();
  plans[0].optimal = false;
  const html = buildOptimizationReportHtml({projectCode:'Q1',project:'Example',profileCuttingPlans:plans});
  assert.match(html,/Window &lt;1&gt;/);
  assert.match(html,/Rest length:<\/td><td>1000.0 mm/);
  assert.match(html,/minimum not proven/);
  assert.match(html,/10 mm allowance/);
  assert.match(html,/proportional/);
});
test('empty quotation produces an explicit empty report', () => {
  assert.match(buildOptimizationReportHtml({}),/No profile cuts configured/);
});
test('groups all profiles and copies under their parent ref code in quotation order', () => {
  const demand = (refKey, refCode, key, sapCode, length, description) => ({sapCode,stockLength:6000,pieceLength:length,quantity:1,
    source:{refKey,refCode,key,label:refCode,instance:1},row:{description}});
  const plans = allocateProfileCuts([
    demand('2','w2','2:1','50120001',3000,'Frame'),
    demand('1','w1','1.1:1','50120001',2000,'Frame'),
    demand('1','w1','1.1:2','50120001',500,'Frame'),
    demand('1','w1','join:1:1','50120002',1500,'Mullion'),
    demand('2','w2','2:1','50120003',1000,'Shutter')
  ]).plans;
  const items = summarizeItems(plans);
  assert.equal(items.length,4);
  assert.equal(items[0].refCode,'w1');
  assert.equal(items[0].used,2500);
  assert.equal(items[0].cuts,2);
  assert.ok(Math.abs(items.reduce((s,i) => s+i.waste,0)-plans.reduce((s,p) => s+p.totalLeftoverMm,0))<0.0001);
  const html=buildOptimizationReportHtml({profileCuttingPlans:plans});
  const first=html.indexOf('Ref Code: w1');
  const second=html.indexOf('Ref Code: w2');
  assert.ok(first<second);
  const w1=html.slice(first,second);
  assert.match(w1,/50120001/);
  assert.match(w1,/50120002/);
  assert.doesNotMatch(w1,/50120003/);
  assert.match(w1,/Profile 2/);
});
test('sample-style waste includes cutting allowance and separates reusable rest', () => {
  const plan={barCount:2,stockLengthMm:6000,kgm:0.58,bars:[
    {leftoverMm:100,cuts:[{lengthMm:5900,cutLengthMm:5890,allowanceMm:10}]},
    {leftoverMm:1000,cuts:[{lengthMm:5000,cutLengthMm:4990,allowanceMm:10}]}
  ]};
  const result=profileWasteStats(plan,300);
  assert.equal(result.inclusive,1120);
  assert.equal(result.exclusive,120);
  assert.equal(result.reusable,1000);
  assert.equal(result.restCount,1);
  assert.equal(result.optimizationPercent,1);
  assert.ok(Math.abs(result.inclusiveKg-0.6496)<1e-10);
  assert.equal(profileWasteStats({...plan,bars:[{leftoverMm:300,cuts:[]}]},300).reusable,300);
});
test('profile report embeds catalog image and labels raw cut length, ref and direction', () => {
  const image='data:image/png;base64,aGVsbG8=';
  const plans=allocateProfileCuts([{sapCode:'50120001',stockLength:6000,pieceLength:2010,cutLengthMm:2000,allowanceMm:10,position:'H',cutAngle:'45',quantity:1,source:{key:'1',label:'W1',refCode:'W1'},row:{description:'Frame'}}]).plans;
  Object.assign(plans[0],{image,description:'Frame',kgm:0.58,colors:['Dark Grey']});
  const html=buildOptimizationReportHtml({profileCuttingPlans:plans});
  assert.ok(html.includes(`src="${image}"`));
  assert.match(html,/1\) W1-H/);
  assert.match(html,/Color : Dark Grey/);
  assert.match(html,/Incl. Reusable/);
  assert.match(html,/Excl. Reusable/);
  assert.match(html,/Wastage Summary/);
});
test('matches the reference CMT BEAD summary including tolerance and reusable rest', () => {
  const leftovers=[10,10,10,13,14,17,19,19,19,19,30,1156,1696];
  const plan={barCount:13,stockLengthMm:6000,kgm:0.302,bars:leftovers.map((leftoverMm,i)=>({leftoverMm,cuts:Array.from({length:i===0?6:4},()=>({allowanceMm:10}))}))};
  const s=profileWasteStats(plan,300);
  assert.equal(s.pieces,54);
  assert.equal(s.reusable,2852);
  assert.equal(s.inclusive,3572);
  assert.equal(s.exclusive,720);
  assert.equal(s.totalPercent.toFixed(2),'4.58');
  assert.equal(s.optimizationPercent.toFixed(2),'0.92');
  assert.equal(s.inclusiveKg.toFixed(3),'1.079');
});
