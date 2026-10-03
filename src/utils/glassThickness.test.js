const test = require('node:test');
const assert = require('node:assert/strict');
const OptionSet = require('../models/Quotation/OptionSet');
const {createOptionSet,updateOptionSet,listOptionSets}=require('../controllers/quotationAdminController');
const response = () => ({statusCode:200,status(code){this.statusCode=code;return this;},json(body){this.body=body;return this;}});
test('glass name, rate and decimal thickness round-trip through create and list', async t => {
  let stored;
  t.mock.method(OptionSet,'create',async payload => {stored=new OptionSet(payload);await stored.validate();return stored;});
  const res=response();
  await createOptionSet({body:{type:'glassSpec',values:{'6.5 mm glass':250},glassThicknessMm:{'6.5 mm glass':6.5}}},res);
  assert.equal(res.statusCode,201);
  assert.equal(res.body.values['6.5 mm glass'],250);
  assert.equal(res.body.glassThicknessMm['6.5 mm glass'],6.5);
  assert.equal(stored.glassThicknessMm.get('6[dot]5 mm glass'),6.5);
  t.mock.method(OptionSet,'find',()=>({populate(){return this;},lean:async()=>[stored.toObject()]}));
  const list=response();await listOptionSets({query:{type:'glassSpec'}},list);
  assert.equal(list.body.optionSets[0].glassThicknessMm['6.5 mm glass'],6.5);
});
test('updates thickness, allows removal and preserves it when omitted by older clients', async t => {
  let last;
  t.mock.method(OptionSet,'findByIdAndUpdate',async (_id,payload)=>{last=payload;return new OptionSet({type:'glassSpec',values:{Glass:100},...payload});});
  for(const thickness of [{Glass:8},{}]) {
    const res=response();await updateOptionSet({params:{id:'id'},body:{glassThicknessMm:thickness}},res);
    assert.deepEqual(res.body.glassThicknessMm,thickness);
  }
  await updateOptionSet({params:{id:'id'},body:{values:{Glass:200}}},response());
  assert.equal(Object.hasOwn(last,'glassThicknessMm'),false);
});
test('rejects invalid thickness without writing to database', async t => {
  t.mock.method(console,'error',()=>{});
  const write=t.mock.method(OptionSet,'create',()=>{throw Error('must not write');});
  for(const thickness of [-1,0,'invalid',Infinity]) {
    const res=response();await createOptionSet({body:{type:'glassSpec',values:{Glass:100},glassThicknessMm:{Glass:thickness}}},res);
    assert.equal(res.statusCode,400);
  }
  assert.equal(write.mock.callCount(),0);
});
