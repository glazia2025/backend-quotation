const test = require('node:test');
const assert = require('node:assert/strict');
const { optimizeProfileCuts, allocateProfileCuts } = require('./profileOptimizer');
const pack = (lengths, options) => optimizeProfileCuts(lengths.map(length => ({ length })), 6000, options);
test('packs across window order and improves beyond greedy longest-first', () => {
  for (const cuts of [[2000,2000,4000,4000],[4000,2000,4000,2000],[3600,3000,1800,1200,1200,1200]]) {
    const result = pack(cuts);
    assert.equal(result.barCount,2);
    assert.equal(result.totalLeftoverMm,0);
    assert.equal(result.optimal,true);
    assert.deepEqual(result.bars.flatMap(b => b.cuts.map(c => c.length)).sort(), cuts.sort());
  }
});
test('decimal cuts preserve capacity and leftovers', () => {
  const result = pack([3000.125,2999.875,2000.01,2000.01,2000.01]);
  for (const bar of result.bars) assert.ok(Math.abs(bar.cuts.reduce((s,c) => s+c.length,0)+bar.leftoverMm-6000)<0.00001);
});
test('rejects oversized cuts and invalid stock', () => {
  assert.throws(() => pack([6010]), /cannot fit/);
  assert.throws(() => optimizeProfileCuts([],0), /Invalid/);
});
test('search limit reports unproven minimum', () => {
  const result = pack([3600,3000,1800,1200,1200,1200], {maxNodes:0});
  assert.equal(result.optimal,false);
  assert.equal(result.barCount,3);
});
test('shared profile and join cuts allocate whole-bar pricing, keeping SAP codes separate', () => {
  const demand = (sapCode,pieceLength,quantity,type) => ({sapCode,pieceLength,quantity,stockLength:6000,row:{type,description:type,quantity:1,amount:2400,weightKg:12}});
  const result = allocateProfileCuts([demand('P1',2000,2,'Profile'),demand('P1',4000,2,'Mullion'),demand('P2',2000,1,'Beading')]);
  assert.equal(result.plans.length,2);
  assert.equal(result.plans[0].barCount,2);
  assert.equal(result.rows.reduce((s,r) => s+r.quantity,0),3);
  assert.equal(result.rows.reduce((s,r) => s+r.amount,0),7200);
  assert.equal(result.rows.reduce((s,r) => s+r.weightKg,0),36);
});
