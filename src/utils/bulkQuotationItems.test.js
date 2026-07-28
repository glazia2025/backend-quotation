const test = require("node:test");
const assert = require("node:assert/strict");

const {
  __test: { replaceLegacyItemOption },
} = require("../controllers/quotationItemController");

test("bulk replacement covers top-level and combination sub-items", () => {
  const items = [
    { glassSpec: "Clear", subItems: [] },
    {
      glassSpec: "",
      subItems: [
        { glassSpec: "Clear" },
        { glassSpec: "Tinted" },
      ],
    },
  ];

  const updatedCount = replaceLegacyItemOption(
    items,
    "glassSpec",
    "Clear",
    "Laminated"
  );

  assert.equal(updatedCount, 2);
  assert.equal(items[0].glassSpec, "Laminated");
  assert.equal(items[1].subItems[0].glassSpec, "Laminated");
  assert.equal(items[1].subItems[1].glassSpec, "Tinted");
});
