const test = require('node:test');
const assert = require('node:assert/strict');
const { assertUniqueReferences, assertReferenceAvailable } = require('./quotationReferences');
test('reference uniqueness ignores case and outside spaces within a quotation', () => {
  assert.throws(() => assertUniqueReferences([{refCode:' W-01 '}, {refCode:'w-01'}]), error => error.statusCode === 409);
});
test('distinct references and unspecified drafts are accepted', () => {
  assert.doesNotThrow(() => assertUniqueReferences([{refCode:'W-01'}, {refCode:'W-02'}, {}, {}]));
});
test('same reference in separate quotations is accepted', () => {
  assertUniqueReferences([{refCode:'W-01'}]);
  assertUniqueReferences([{refCode:'W-01'}]);
});
test('editing retains own reference but cannot use another item reference', () => {
  const existing = [{_id:'a',refCode:'W-01'}, {_id:'b',refCode:'W-02'}];
  assert.doesNotThrow(() => assertReferenceAvailable(existing,{refCode:' w-01 '},'a'));
  assert.throws(() => assertReferenceAvailable(existing,{refCode:'w-02'},'a'), error => error.statusCode === 409);
});
