const express = require("express");
const isUser = require("../middleware/userMiddleware");
const {
  listOptionSets,
  replaceOptionSet,
  upsertOptionItem,
  deleteOptionItem,
  setAdminOptionItemRate,
  addHardware,
  listHardware,
  updateHardware,
  deleteHardware,
  setAdminHardwareRate,
  createHandleOption,
  updateHandleOption,
  deleteHandleOption,
} = require("../controllers/userQuotationDataController");

const router = express.Router();

router.use(isUser);

router.get("/option-sets", listOptionSets);
router.put("/option-sets/:type", replaceOptionSet);
router.post("/option-sets/:type/items", upsertOptionItem);
router.delete("/option-sets/:type/items/:name", deleteOptionItem);
router.put("/option-sets/:type/admin-items/:name/rate", setAdminOptionItemRate);

router.post("/hardware", addHardware);
router.get("/hardware", listHardware);
router.put("/hardware/:id", updateHardware);
router.delete("/hardware/:id", deleteHardware);
router.put("/hardware/admin/:hardwareId/rate", setAdminHardwareRate);

router.post("/handle-options", createHandleOption);
router.put("/handle-options/:id", updateHandleOption);
router.delete("/handle-options/:id", deleteHandleOption);

module.exports = router;
