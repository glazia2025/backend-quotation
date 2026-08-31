const toNumber = (value, fallback = 0) => {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
};

const roundToTwo = (value) => Number(value.toFixed(2));

function addProfitToItemValues(item, profitPercentage) {
  const multiplier = 1 + toNumber(profitPercentage) / 100;
  return {
    ...item,
    rate: roundToTwo(toNumber(item.rate) * multiplier),
    amount: roundToTwo(toNumber(item.amount) * multiplier),
    subItems: Array.isArray(item.subItems)
      ? item.subItems.map((subItem) => addProfitToItemValues(subItem, profitPercentage))
      : [],
  };
}

function allocateAmountIntoItems(items, adjustment) {
  if (!items.length || Math.abs(adjustment) < 0.005) return items;

  const weights = items.map(
    (item) => toNumber(item.area) * Math.max(1, toNumber(item.quantity, 1))
  );
  const totalWeight = weights.reduce((sum, value) => sum + value, 0);
  const fallbackWeights = items.map((item) => Math.max(0, toNumber(item.amount)));
  const fallbackTotal = fallbackWeights.reduce((sum, value) => sum + value, 0);
  let allocated = 0;

  return items.map((item, index) => {
    const isLast = index === items.length - 1;
    const weight = totalWeight > 0 ? weights[index] : fallbackWeights[index];
    const weightTotal = totalWeight > 0 ? totalWeight : fallbackTotal;
    const share = isLast
      ? roundToTwo(adjustment - allocated)
      : roundToTwo(
          weightTotal > 0
            ? adjustment * (weight / weightTotal)
            : adjustment / items.length
        );
    allocated = roundToTwo(allocated + share);
    const amount = roundToTwo(toNumber(item.amount) + share);

    return {
      ...item,
      amount,
      rate: weights[index] > 0 ? roundToTwo(amount / weights[index]) : item.rate,
    };
  });
}

function calculateQuotationPdfPricing(items, additionalCosts = {}, profitPercentage = 0) {
  const baseTotal = items.reduce((sum, item) => sum + toNumber(item.amount), 0);
  const totalArea = items.reduce(
    (sum, item) => sum + toNumber(item.area) * Math.max(1, toNumber(item.quantity, 1)),
    0
  );
  const totalQty = items.reduce(
    (sum, item) => sum + Math.max(1, toNumber(item.quantity, 1)),
    0
  );
  const profitPercent = toNumber(profitPercentage);
  const profitValue = (baseTotal * profitPercent) / 100;
  const installationCost = totalArea * toNumber(additionalCosts.installation);
  const transportCost = toNumber(additionalCosts.transport);
  const loadingUnloadingCost = toNumber(additionalCosts.loadingUnloading);
  const discountPercent = toNumber(additionalCosts.discountPercent);
  const beforeDiscount =
    baseTotal + profitValue + installationCost + transportCost + loadingUnloadingCost;
  const discountValue = (beforeDiscount * discountPercent) / 100;
  const totalProjectCost = beforeDiscount - discountValue;
  const gstValue = totalProjectCost * 0.18;
  const grandTotal = totalProjectCost + gstValue;
  const hiddenAdditionalCosts =
    (additionalCosts.showInstallation ? 0 : installationCost) +
    (additionalCosts.showTransport ? 0 : transportCost) +
    (additionalCosts.showLoadingUnloading ? 0 : loadingUnloadingCost);
  const hiddenDiscount = additionalCosts.showDiscount ? 0 : discountValue;
  const adjustedItems = allocateAmountIntoItems(
    items.map((item) => addProfitToItemValues(item, profitPercent)),
    hiddenAdditionalCosts - hiddenDiscount
  );
  const itemsSubtotal = adjustedItems.reduce(
    (sum, item) => sum + toNumber(item.amount),
    0
  );

  return {
    items: adjustedItems,
    totals: {
      baseTotal,
      totalArea,
      totalQty,
      profitPercent,
      profitValue,
      itemsSubtotal,
      installationCost,
      transportCost,
      loadingUnloadingCost,
      beforeDiscount,
      discountPercent,
      discountValue,
      totalProjectCost,
      gstValue,
      grandTotal,
      avgWithoutGst: totalArea > 0 ? totalProjectCost / totalArea : 0,
      avgWithGst: totalArea > 0 ? grandTotal / totalArea : 0,
    },
  };
}

module.exports = { calculateQuotationPdfPricing };
