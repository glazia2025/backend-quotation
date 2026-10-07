const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const mongoose = require("mongoose");
const QuotationItem = require("../models/Quotation/QuotationItem");
const quotationItems = require("./quotationItems");

for (const missingParent of [false, true]) {
  test(missingParent ? "failed parent append cleans up inserted items and images" : "item save uses persisted defaults without rereading items", async (t) => {
    const quotationId = new mongoose.Types.ObjectId();
    let deletedItems = false;
    let deletedImages = false;
    let scheduled = false;
    t.mock.method(QuotationItem, "insertMany", async (rows) => rows.map((row) => new QuotationItem(row)));
    t.mock.method(QuotationItem, "find", () => assert.fail("Save must not read items back"));
    t.mock.method(QuotationItem, "deleteMany", async () => { deletedItems = true; });
    const loaded = Promise.resolve({ _id: quotationId, user: "owner" });
    loaded.select = (fields) => { assert.equal(fields, "_id user quotationItems"); return loaded; };
    const updatedAt = new Date();
    const quotation = {
      findById: () => loaded,
      findOneAndUpdate: (filter, update, options) => {
        assert.equal(String(filter._id), String(quotationId));
        assert.equal(filter.quotationItems.length, 0);
        assert.ok(update.$push.quotationItems);
        assert.equal(update.$set, undefined);
        assert.equal(options.new, true);
        return { select: () => ({ lean: async () => missingParent ? null : { _id: quotationId, updatedAt } }) };
      },
    };
    const moduleStub = { exports: {} };
    vm.runInNewContext(fs.readFileSync(require.resolve("../controllers/quotationItemController"), "utf8"), {
      module: moduleStub,
      console: { warn() {}, error() {} },
      require(name) {
        if (name === "mongoose" || name === "node:perf_hooks") return require(name);
        if (name === "../models/Quotation/Quotation") return quotation;
        if (name === "../models/Quotation/QuotationItem") return QuotationItem;
        if (name === "../utils/quotationItems") return quotationItems;
        if (name === "../utils/quotationReferences") return require('./quotationReferences');
        if (name === "../utils/quotationImages") return {
          uploadQuotationImages: async ({ items }) => ({ items, uploadedKeys: ["uploaded-key"] }),
          deleteS3Keys: async () => { deletedImages = true; },
        };
        if (name === "../utils/pdfWarmup") return {
          scheduleQuotationPdfWarmup: async () => { scheduled = true; throw new Error("queue unavailable"); },
        };
        throw new Error(`Unexpected dependency: ${name}`);
      },
    });
    const response = {
      setHeader(name, value) { assert.equal(name, "Server-Timing"); assert.match(value, /image_upload;dur=/); },
      status(code) { this.code = code; return this; },
      json(body) { this.body = body; return this; },
    };
    await moduleStub.exports.createQuotationItem({
      params: { id: String(quotationId) }, user: { userId: "owner" },
      body: { item: { refCode: "W1", subItems: [{ id: "child", refCode: "W1-a" }] } },
    }, response);
    assert.equal(response.code, missingParent ? 409 : 201);
    assert.equal(deletedItems, missingParent);
    assert.equal(deletedImages, missingParent);
    assert.equal(scheduled, !missingParent);
    if (!missingParent) {
      assert.equal(response.body.updatedAt, updatedAt);
      assert.equal(response.body.item.refCode, "W1");
      assert.equal(response.body.item.subItems[0].refCode, "W1-a");
      assert.equal(response.body.item.subItems[0].id.length, 24);
      assert.equal(response.body.item.quotation, undefined);
    }
  });
}
