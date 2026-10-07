const normalizeReference = (value) => String(value || '').trim().toLowerCase();

function assertUniqueReferences(items = []) {
  const seen = new Set();
  for (const item of items) {
    const key = normalizeReference(item.refCode);
    if (!key) continue; // Existing unspecific draft rows may have no reference yet.
    if (seen.has(key)) {
      const error = new Error(`Reference code "${String(item.refCode).trim()}" is already used in this quotation. Choose a different reference code.`);
      error.statusCode = 409;
      throw error;
    }
    seen.add(key);
  }
}

function assertReferenceAvailable(existing, item, excludedId) {
  assertUniqueReferences([
    ...existing.filter(row => String(row._id || row.id) !== String(excludedId)), item,
  ]);
}
module.exports = { normalizeReference, assertUniqueReferences, assertReferenceAvailable };
