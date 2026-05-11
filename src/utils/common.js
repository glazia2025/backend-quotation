const extractQueryParams = (query) => {
  return {
    page: Number(query?.page || 1),
    limit: Number(query?.limit || 20),
    filters: query?.filters || {},
    sortObj: {
      [query?.sortKey || "createdAt"]:
        query && query.sortOrder === "desc" ? -1 : 1,
    },
  };
};

const formatPrice = (price) => {
  return price.toLocaleString("en-IN", {
    style: "currency",
    currency: "INR",
  });
};

const escapeRegExp = (string) => {
  return string.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
};

module.exports = {
  extractQueryParams,
  formatPrice,
  escapeRegExp,
};
