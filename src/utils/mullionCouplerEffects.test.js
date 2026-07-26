const test = require("node:test");
const assert = require("node:assert/strict");

const {
  __test: {
    buildGlassDimensionEffects,
    compileGlassRows,
    consolidateCombinationGlassSections,
    getJoinOrientation,
  },
} = require("../controllers/cuttingScheduleController");
const {
  __test: {
    collectLayoutNodeIds,
    remapConfiguratorLayout,
    resolveJoinEndpoint,
  },
} = require("./quotationItems");

const makeEntry = (split) => {
  const vertical = split === "vertical";
  const first = { id: "first", width: vertical ? 500 : 1000, height: vertical ? 1000 : 500 };
  const second = { id: "second", width: vertical ? 500 : 1000, height: vertical ? 1000 : 500 };
  return {
    parent: {
      width: 1000,
      height: 1000,
      subItems: [first, second],
      configuratorLayout: {
        children: vertical
          ? [
              { id: "old-first", x: 0, y: 0, w: 0.5, h: 1 },
              { id: "old-second", x: 0.5, y: 0, w: 0.5, h: 1 },
            ]
          : [
              { id: "old-first", x: 0, y: 0, w: 1, h: 0.5 },
              { id: "old-second", x: 0, y: 0.5, w: 1, h: 0.5 },
            ],
      },
    },
    join: { p1: "first", p2: "second", type: "Mullion" },
    first,
    second,
    source: first,
    systemType: "Casement",
    series: "CS-1",
  };
};

test("vertical divider reduces glass width on both adjoining sections", () => {
  const entry = makeEntry("vertical");
  assert.equal(getJoinOrientation(entry), "vertical");

  const effects = buildGlassDimensionEffects([entry], {
    "Casement||CS-1": {
      mullions: [
        { glassDimensionEffect: 12.5 },
        { glassDimensionEffect: 2.5 },
      ],
    },
  });

  assert.deepEqual(effects.get("first"), { width: 15, height: 0 });
  assert.deepEqual(effects.get("second"), { width: 15, height: 0 });
});

test("horizontal divider reduces glass height on both adjoining sections", () => {
  const entry = makeEntry("horizontal");
  entry.join.type = "Coupler";
  assert.equal(getJoinOrientation(entry), "horizontal");

  const effects = buildGlassDimensionEffects([entry], {
    "Casement||CS-1": {
      couplers: [{ glassDimensionEffect: 8 }],
    },
  });

  assert.deepEqual(effects.get("first"), { width: 0, height: 8 });
  assert.deepEqual(effects.get("second"), { width: 0, height: 8 });
});

test("an internal split section remains a valid join endpoint after sub-items are remapped", () => {
  const subItemIdMap = new Map([
    ["top-left", "saved-top-left"],
    ["bottom-left", "saved-bottom-left"],
    ["right", "saved-right"],
  ]);
  const layout = remapConfiguratorLayout(
    {
      id: "root",
      split: "vertical",
      children: [
        {
          id: "left-group",
          split: "horizontal",
          children: [{ id: "top-left" }, { id: "bottom-left" }],
        },
        { id: "right" },
      ],
    },
    subItemIdMap
  );
  const validLayoutIds = collectLayoutNodeIds(layout);

  assert.equal(
    resolveJoinEndpoint("left-group", subItemIdMap, validLayoutIds),
    "left-group"
  );
  assert.equal(
    resolveJoinEndpoint("right", subItemIdMap, validLayoutIds),
    "saved-right"
  );
  assert.equal(
    resolveJoinEndpoint("missing", subItemIdMap, validLayoutIds),
    ""
  );
});

test("nested split glass effect applies to persisted descendant panes, not the group id", () => {
  const topLeft = { id: "top-left", systemType: "Casement" };
  const blank = { id: "bottom-left", systemType: "Blank Area" };
  const right = { id: "right", systemType: "Casement" };
  const entry = {
    parent: {
      configuratorLayout: {
        id: "root",
        split: "vertical",
        children: [
          {
            id: "left-group",
            split: "horizontal",
            children: [{ id: "top-left" }, { id: "bottom-left" }],
          },
          { id: "right" },
        ],
      },
    },
    join: { p1: "left-group", p2: "right", type: "Coupler" },
    first: topLeft,
    second: right,
    firstItems: [topLeft, blank],
    secondItems: [right],
    systemType: "Casement",
    series: "CS-1",
  };

  assert.equal(getJoinOrientation(entry), "vertical");
  const effects = buildGlassDimensionEffects([entry], {
    "Casement||CS-1": { couplers: [{ glassDimensionEffect: 10 }] },
  });
  assert.deepEqual(effects.get("top-left"), { width: 10, height: 0 });
  assert.deepEqual(effects.get("right"), { width: 10, height: 0 });
  assert.equal(effects.has("left-group"), false);
  assert.equal(effects.has("bottom-left"), false);
});

test("width and height glass lines compile into one pane row", () => {
  const rows = compileGlassRows([
    { itemType: "profile", sapCode: "P-1", dimension: 500, quantity: 2 },
    { itemType: "glass", description: "6mm Clear", dimension: 480, quantity: 2 },
    { itemType: "glass", description: "6mm Clear", dimension: 980, quantity: 2 },
  ]);

  assert.equal(rows.length, 2);
  assert.deepEqual(rows[1], {
    itemType: "glass",
    description: "6mm Clear",
    dimension: "480 x 980",
    quantity: 2,
    unit: "Pcs",
    position: "Glass size",
    linkedBeading: undefined,
  });
});

test("combination panes with identical dimensions consolidate quantity", () => {
  const makeSection = (dimension) => ({
    item: { parentRefCode: "F-1" },
    rows: [
      {
        itemType: "glass",
        description: "6mm Clear",
        dimension,
        quantity: 1,
        unit: "Pcs",
      },
    ],
    notes: [],
  });
  const sections = consolidateCombinationGlassSections(
    [makeSection("480 x 980"), makeSection("480 x 980"), makeSection("500 x 980")],
    { items: [{ refCode: "F-1", width: 1500, height: 1000 }] }
  );

  assert.equal(sections.length, 1);
  assert.equal(sections[0].rows.length, 2);
  assert.equal(
    sections[0].rows.find((row) => row.dimension === "480 x 980").quantity,
    2
  );
  assert.equal(
    sections[0].rows.find((row) => row.dimension === "500 x 980").quantity,
    1
  );
});
