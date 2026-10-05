const test = require('node:test');
const assert = require('node:assert/strict');
const { getMullionRemovedSides, appliesToFrame, removedSidesForRateItem } = require('./combinationFrame');
const { __test: { itemRowsForSchedule } } = require('../controllers/cuttingScheduleController');
const { __test: { calculateProfileMaterialBaseRate } } = require('../services/quotationRateService');
const leaf = (id,x,y,w,h) => ({id,x,y,w,h});
const three = {id:'root',children:[leaf('a',0,0,1/3,1),leaf('b',1/3,0,1/3,1),leaf('c',2/3,0,1/3,1)]};
const joins = [{p1:'a',p2:'b',type:'Mullion'},{p1:'b',p2:'c',type:'Mullion'}];
const sorted = sides => [...sides].sort();
test('three vertical sections remove four touching outer sides and preserve inner profiles', () => {
  const sides=getMullionRemovedSides(three,joins);
  assert.deepEqual(sides.get('a'),['outer-right']);
  assert.deepEqual(sorted(sides.get('b')),['outer-left','outer-right']);
  assert.deepEqual(sides.get('c'),['outer-left']);
  for(const placement of ['inner','outer-top','outer-bottom','',undefined]) assert.equal(appliesToFrame({itemType:'profile',placement},sides.get('b')),true);
  assert.equal(appliesToFrame({itemType:'profile',placement:'outer-left'},sides.get('b')),false);
  assert.equal(appliesToFrame({itemType:'hardware',placement:'outer-left'},sides.get('b')),true);
});
test('horizontal split removes bottom of upper section and top of lower section regardless of join order', () => {
  const layout={children:[leaf('a',0,0,1,0.5),leaf('b',0,0.5,1,0.5)]};
  const sides=getMullionRemovedSides(layout,[{p1:'b',p2:'a',type:'Mullion'}]);
  assert.deepEqual(sides.get('a'),['outer-bottom']);
  assert.deepEqual(sides.get('b'),['outer-top']);
});
test('couplers and absent joins retain frames', () => {
  for (const joinList of [[],joins.map(j=>({...j,type:'Coupler'}))]) {
    assert.ok([...getMullionRemovedSides(three,joinList).values()].every(s=>s.length===0));
  }
});
test('nested joins remove only boundary leaves, covering a full adjoining edge across multiple leaves', () => {
  const layout={children:[{id:'left',children:[leaf('a',0,0,0.5,0.5),leaf('b',0,0.5,0.5,0.5)]},leaf('c',0.5,0,0.5,1)]};
  const sides=getMullionRemovedSides(layout,[{p1:'left',p2:'c',type:'Mullion'}]);
  assert.deepEqual(sides.get('a'),['outer-right']);
  assert.deepEqual(sides.get('b'),['outer-right']);
  assert.deepEqual(sides.get('c'),['outer-left']);
  const partial=getMullionRemovedSides(layout,[{p1:'a',p2:'c',type:'Mullion'}]);
  assert.deepEqual(partial.get('c'),[]);
});
test('schedule expansion attaches the same removal rules while preserving parent quantity', () => {
  const rows=itemRowsForSchedule({items:[{systemType:'Combination',refCode:'W1',width:3000,height:1800,quantity:2,configuratorLayout:three,joins,subItems:['a','b','c'].map(id=>({id,systemType:'Casement'}))}]});
  assert.deepEqual(sorted(rows[1].removedFrameSides),['outer-left','outer-right']);
  assert.equal(rows[1].quantity,2);
  assert.equal(rows[1].width,1000);
});
test('pricing removes outer sides but keeps sash quantities with the same SAP code', () => {
  const item={width:1000,height:1800,area:20,combinationContext:{layout:three,joins,sectionId:'b'}};
  const lines=['outer-left','outer-right','outer-top','outer-bottom','inner'].map(placement=>({itemType:'profile',sapCode:'P1',placement,dimensionFormula:'1000',quantityFormula:placement==='inner'?'4':'1'}));
  const result=calculateProfileMaterialBaseRate({item,schedule:{lines},productsByCode:new Map([['P1',{kgm:1}]]),profileMetadataByCode:new Map(),profilePricing:{},nalcoPrice:200000});
  assert.equal(result.profiles.length,3);
  assert.equal(result.profiles.reduce((sum,p)=>sum+p.pieceQuantity,0),6);
  assert.equal(result.totalWeightKg,6.06);
  assert.deepEqual(sorted(removedSidesForRateItem({...item,combinationContext:{...item.combinationContext,sectionId:'old',sectionIndex:1}})),['outer-left','outer-right']);
});
test('schedule and optimized BOM agree on removed sides and retained sash and mullions', async t => {
  const mongoose=require('mongoose');
  const {__test:{buildBomData,buildScheduleData}}=require('../controllers/cuttingScheduleController');
  const chain = value => ({lean:async()=>value,sort(){return this;},collation(){return this;}});
  const identity={systemType:'Casement',series:'S',description:'Fix'};
  const lines=['outer-left','outer-right','outer-top','outer-bottom','inner'].map(placement=>({itemType:'profile',sapCode:'P1',placement,dimensionFormula:'1000',quantityFormula:placement==='inner'?'4':'1'}));
  const configs=[{...identity,schedules:[{key:'90_90',lines}]}];
  for(const [model,records] of [
    ['Quotation/CuttingScheduleConfig',configs],['Quotation/GlassBeadingConfig',[]],['Quotation/HardwareLinkingConfig',[]],
    ['Quotation/MullionCouplerConfig',[{systemType:'Casement',series:'S',mullions:[{sapCode:'M1',formula:'H',quantity:1}]}]],
    ['Hardware',[]],['Product',[{sapCode:'P1',length:6000,kgm:1},{sapCode:'M1',length:6000,kgm:1}]]
  ]) t.mock.method(require(`../models/${model}`),'find',()=>chain(records));
  t.mock.method(require('../models/ProfileOptions'),'findOne',()=>chain({categories:{}}));
  t.mock.method(require('../models/Quotation/OptionSet'),'findOne',()=>chain(null));
  const Nalco=mongoose.models.nalco || mongoose.model('nalco',new mongoose.Schema({nalcoPrice:Number},{collection:'nalcos'}));
  t.mock.method(Nalco,'findOne',()=>chain({nalcoPrice:200000}));
  const quote={_id:'test',items:[{systemType:'Combination',refCode:'W1',width:3000,height:1800,quantity:2,configuratorLayout:three,joins,subItems:['a','b','c'].map(id=>({...identity,id,refCode:`W1-${id}`,cuttingScheduleKey:'90_90'}))}]};
  const schedule=await buildScheduleData(quote);
  const scheduleRows=schedule.sections.flatMap(s=>s.rows);
  assert.equal(scheduleRows.filter(r=>r.itemType==='profile').reduce((s,r)=>s+r.quantity,0),40);
  assert.equal(scheduleRows.filter(r=>r.itemType==='mullion').reduce((s,r)=>s+r.quantity,0),4);
  const bom=await buildBomData(quote);
  const profiles=bom.profileCuttingPlans.find(p=>p.sapCode==='P1');
  const mullions=bom.profileCuttingPlans.find(p=>p.sapCode==='M1');
  assert.equal(profiles.bars.flatMap(b=>b.cuts).length,40);
  assert.equal(mullions.bars.flatMap(b=>b.cuts).length,4);
  // 40 x 1010 mm packs five cuts per 6000 mm bar.
  assert.equal(profiles.barCount,8);
});
