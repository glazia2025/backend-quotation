const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const policy=require('./businessAccess');
function setup({own=true,allowed=true,found=true,module='QUOTATION_ERP'}={}) {
  const business={_id:'business',phoneNumber:'9000000001',members:[{_id:'member',phoneNumber:'9000000002',isActive:true,permissions:{survey:{enabled:true,allQuotations:true},quotation:{enabled:allowed,allQuotations:!own}}}]};
  const claims={role:'user',userId:'business',phoneNumber:'9000000002',memberId:'member',accessModule:module};
  let filter;
  const context={module:{exports:{}},require:name=>{
    if(name.includes('authCookies'))return {extractAuthToken:()=> 'token'};
    if(name.endsWith('/jwt'))return {verifyJwt:()=>claims};
    if(name.endsWith('/User'))return {findById:()=>({lean:async()=>business})};
    if(name.endsWith('/Quotation'))return {exists:async value=>{filter=value;return found;}};
    if(name==='dotenv')return {config(){}};
    return policy;
  }};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../middleware/userMiddleware.js'),'utf8'),context);
  return {business,claims,get filter(){return filter;},async call(params={}){const req={params};const res={statusCode:200,status(n){this.statusCode=n;return this;},json(v){this.body=v;return this;}};let next=false;await context.module.exports(req,res,()=>next=true);return {req,res,next};}};
}
test('direct quotation access includes business and creator checks',async()=>{
  const s=setup();assert.equal((await s.call({id:'a'.repeat(24)})).next,true);
  assert.equal(s.filter.user,'business');assert.equal(s.filter.createdByActor,'member');
});
test('inaccessible detail/export/item routes stop before controller execution',async()=>{
  const s=setup({found:false});const r=await s.call({id:'a'.repeat(24)});assert.equal(r.next,false);assert.equal(r.res.statusCode,404);
  assert.equal((await s.call({userId:'another-business'})).res.statusCode,403);
});
test('list and analytics carry own scope while survey has its independent scope',async()=>{
  assert.equal((await setup().call()).req.quotationScope.createdByActor,'member');
  assert.equal((await setup({module:'SURVEY_APP'}).call()).req.quotationScope.createdByActor,undefined);
});
test('revoked permissions and removed memberships invalidate existing tokens',async()=>{
  assert.equal((await setup({allowed:false}).call()).res.statusCode,403);
  const s=setup();s.business.members=[];assert.equal((await s.call()).res.statusCode,403);
});
