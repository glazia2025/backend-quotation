const express = require("express");
const router = express.Router();
const isUser = require("../middleware/userMiddleware");

const {
  getSystems,
  getSeries,
  getDescriptions,
  getOptionLists,
  previewRate,
  createQuotation,
  listQuotations,
  getQuotationById,
  updateQuotationById,
  deleteQuotationById,
  generateQuotationPdfController
} = require("../controllers/quotationController");
const {
  generateCuttingSchedulePdf,
} = require("../controllers/cuttingScheduleController");

const {
  getQuotationConfig,
  createOrUpdateQuotationConfig,
} = require("../controllers/quotationConfig");

router.get("/systems", getSystems);
router.get("/systems/:systemType/series", getSeries);
router.get(
  "/systems/:systemType/series/:series/descriptions",
  getDescriptions
);
router.get("/options", getOptionLists);
router.post("/rate-preview", previewRate);
router.post("/", isUser, createQuotation);
router.get("/", isUser, listQuotations);
router.get("/config", isUser, getQuotationConfig);
router.post("/config", isUser, createOrUpdateQuotationConfig);
router.get("/:id", isUser, getQuotationById);
router.post("/:id", isUser, updateQuotationById);
router.delete("/:id", isUser, deleteQuotationById);
router.get("/:id/pdf", isUser, generateQuotationPdfController);
router.get("/:id/cutting-schedule", isUser, generateCuttingSchedulePdf);
module.exports = router;
