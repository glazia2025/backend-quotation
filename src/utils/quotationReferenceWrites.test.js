const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const references = require('./quotationReferences');

function fixture(existing = []) {
  let ids = existing.map(row => row._id), sequence = 0, inserts = 0;
  const module = { exports: {} };
  const model = {
    findById: () => {
      const result = Promise.resolve({_id:'quote', user:'owner', quotationItems:[...ids]});
      result.select = () => result;
      return result;
    },
    findOneAndUpdate: (filter, update) => ({select: () => ({lean: async () => {
      if (JSON.stringify(filter.quotationItems) !== JSON.stringify(ids)) return null;
      ids.push(update.$push.quotationItems);
      return {_id:'quote', updatedAt:new Date()};
    }})}),
  };
  vm.runInNewContext(fs.readFileSync(require.resolve('../controllers/quotationItemController'), 'utf8'), {
    module, console: {warn(){}, error(){}},
    require(name) {
      if (name === 'mongoose') return {Types:{ObjectId:{isValid:()=>true}}};
      if (name === 'node:perf_hooks') return require(name);
      if (name === '../models/Quotation/Quotation') return model;
      if (name === '../models/Quotation/QuotationItem') return {
        find: () => ({select: () => ({lean: async () => existing})}),
        deleteMany: async () => {},
      };
      if (name === '../utils/quotationReferences') return references;
      if (name === '../utils/quotationItems') return {
        createQuotationItems: async (_, items) => {
          inserts++;
          const id = `new-${++sequence}`;
          return {topLevelIds:[id], allIds:[id], documents:items};
        },
        hydrateQuotationItems: async (_, options) => ({items:options.documents}),
      };
      if (name === '../utils/quotationImages') return {
        uploadQuotationImages: async ({items}) => ({items, uploadedKeys:[]}),
        deleteS3Keys: async () => {}, collectQuotationImageKeys: () => [],
      };
      if (name === '../utils/pdfWarmup') return {scheduleQuotationPdfWarmup:async()=>{}};
      throw Error(name);
    },
  });
  return {
    get ids() {return ids;}, get inserts() {return inserts;},
    async create(refCode) {
      const response = {setHeader(){}, status(code){this.code=code;return this;}, json(body){this.body=body;return this;}};
      await module.exports.createQuotationItem({params:{id:'quote'},user:{userId:'owner'},body:{item:{refCode}}},response);
      return response;
    },
  };
}
test('duplicate create is rejected before writing items or images', async () => {
  const state = fixture([{_id:'existing',refCode:'W-01'}]);
  const result = await state.create(' w-01 ');
  assert.equal(result.code,409);
  assert.match(result.body.message,/already used/);
  assert.equal(state.inserts,0);
});
test('concurrent creates cannot both append against the same item snapshot', async () => {
  const state = fixture();
  const results = await Promise.all([state.create('W-01'),state.create('w-01')]);
  assert.deepEqual(results.map(result=>result.code).sort(),[201,409]);
  assert.equal(state.ids.length,1);
});
