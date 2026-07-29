const test = require("node:test");
const assert = require("node:assert/strict");

const {
  __test: {
    buildGlassDimensionEffects,
    compileGlassRows,
    consolidateCombinationGlassSections,
    getDisplayCutAngles,
    getJoinFormulaVariables,
    getJoinOrientation,
    getJoinLinesForOrientation,
    itemRowsForSchedule,
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

test("combination profiles and glass share one parent fabrication section", () => {
  const sections = consolidateCombinationGlassSections(
    [
      {
        item: { parentRefCode: "W1", refCode: "W1-a" },
        rows: [
          {
            itemType: "profile",
            description: "Frame",
            sapCode: "4011001",
            dimension: 500,
            cutAngle: "45",
            quantity: 2,
            unit: "Pcs",
            position: "W",
          },
          {
            itemType: "glass",
            description: "6mm Clear Toughened",
            sapCode: "--",
            dimension: "444 x 944",
            quantity: 1,
            unit: "Pcs",
            position: "Glass size",
          },
        ],
        notes: [],
      },
      {
        item: { parentRefCode: "W1", refCode: "W1-b" },
        rows: [
          {
            itemType: "profile",
            description: "Frame",
            sapCode: "4011001",
            dimension: 500,
            cutAngle: "45",
            quantity: 2,
            unit: "Pcs",
            position: "W",
          },
          {
            itemType: "glass",
            description: "6mm Clear Toughened",
            sapCode: "--",
            dimension: "444 x 944",
            quantity: 1,
            unit: "Pcs",
            position: "Glass size",
          },
        ],
        notes: [],
      },
    ],
    {
      items: [
        {
          refCode: "W1",
          systemType: "Combination",
          width: 1000,
          height: 1000,
        },
      ],
    }
  );

  assert.equal(sections.length, 1);
  assert.equal(sections[0].item.refCode, "W1");
  assert.equal(sections[0].rows.length, 2);
  assert.equal(
    sections[0].rows.find((row) => row.itemType === "profile").quantity,
    4
  );
  assert.equal(
    sections[0].rows.find((row) => row.itemType === "glass").quantity,
    2
  );
});

test("combination formula inputs come from each layout sub-frame", () => {
  const rows = itemRowsForSchedule({
    items: [
      {
        refCode: "W1",
        systemType: "Combination",
        width: 1200,
        height: 1000,
        quantity: 2,
        configuratorLayout: {
          id: "root",
          children: [
            { id: "left", x: 0, y: 0, w: 0.4, h: 1 },
            { id: "right", x: 0.4, y: 0, w: 0.6, h: 1 },
          ],
        },
        subItems: [
          { id: "left", refCode: "W1-a", width: 1200, height: 1000 },
          { id: "right", refCode: "W1-b", width: 1200, height: 1000 },
        ],
      },
    ],
  });

  assert.deepEqual(
    rows.map((row) => ({
      refCode: row.refCode,
      width: row.width,
      height: row.height,
      quantity: row.quantity,
    })),
    [
      { refCode: "W1-a", width: 480, height: 1000, quantity: 2 },
      { refCode: "W1-b", width: 720, height: 1000, quantity: 2 },
    ]
  );
});

test("cutting schedule displays selected frame and shutter cut angles", () => {
  assert.deepEqual(
    getDisplayCutAngles({
      item: { frameCutAngle: "45", shutterCutAngle: "45" },
      horizontalAngle: "",
      verticalAngle: "",
    }),
    { frame: "45", shutter: "45" }
  );
});

test("vertical joins use only H formulas and horizontal joins use only W formulas", () => {
  const config = {
    mullions: [
      { sapCode: "H-LINE", formula: "H - 50", quantity: 1 },
      { sapCode: "W-LINE", formula: "W - 50", quantity: 1 },
    ],
  };
  const vertical = makeEntry("vertical");
  const horizontal = makeEntry("horizontal");

  assert.deepEqual(
    getJoinLinesForOrientation(vertical, config).map((line) => line.sapCode),
    ["H-LINE"]
  );
  assert.deepEqual(
    getJoinLinesForOrientation(horizontal, config).map((line) => line.sapCode),
    ["W-LINE"]
  );
});

test("nested join formulas use the dimensions of the owning split section", () => {
  const entry = {
    parent: {
      width: 1200,
      height: 1000,
      area: 12.917,
      configuratorLayout: {
        id: "root",
        x: 0,
        y: 0,
        w: 1,
        h: 1,
        split: "horizontal",
        children: [
          {
            id: "top",
            x: 0,
            y: 0,
            w: 1,
            h: 0.4,
            split: "vertical",
            children: [
              { id: "top-left", x: 0, y: 0, w: 0.5, h: 0.4 },
              { id: "top-right", x: 0.5, y: 0, w: 0.5, h: 0.4 },
            ],
          },
          { id: "bottom", x: 0, y: 0.4, w: 1, h: 0.6 },
        ],
      },
    },
    join: { p1: "top-left", p2: "top-right", type: "Mullion" },
  };

  assert.deepEqual(getJoinFormulaVariables(entry, 1), {
    W: 1200,
    H: 400,
    Q: 1,
    AREA: 5.167,
  });
});
