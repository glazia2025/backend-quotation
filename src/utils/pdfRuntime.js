const isEnabled = (value) =>
  ["1", "true", "yes", "on"].includes(
    String(value || "").trim().toLowerCase()
  );

const isLocalPdfMode = () => {
  if (isEnabled(process.env.QUOTATION_PDF_CACHE_DISABLED)) return true;
  if (isEnabled(process.env.QUOTATION_PDF_CACHE_ENABLED)) return false;
  return process.env.NODE_ENV !== "production";
};

module.exports = {
  isLocalPdfMode,
};
