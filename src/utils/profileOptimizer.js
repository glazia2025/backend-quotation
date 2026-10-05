// Work in micrometres so decimal millimetre cuts do not accumulate float error.
function optimizeProfileCuts(cuts, stockLength, { maxNodes = 200000 } = {}) {
  const capacity = Math.round(Number(stockLength) * 1000);
  if (!Number.isSafeInteger(capacity) || capacity <= 0) throw new Error('Invalid profile stock length');
  const pieces = cuts.map((cut, index) => {
    const length = Math.round(Number(cut.length) * 1000);
    if (!Number.isSafeInteger(length) || length <= 0 || length > capacity) {
      throw new Error(`Profile cut ${cut.length} mm cannot fit stock length ${stockLength} mm`);
    }
    return { ...cut, index, length };
  }).sort((a, b) => b.length - a.length || a.index - b.index);
  const greedy = [];
  for (const piece of pieces) {
    let best = null;
    for (const bar of greedy) {
      if (bar.remaining >= piece.length && (!best || bar.remaining < best.remaining)) best = bar;
    }
    if (!best) { best = { remaining: capacity, cuts: [] }; greedy.push(best); }
    best.remaining -= piece.length;
    best.cuts.push(piece);
  }
  const lowerBound = Math.ceil(pieces.reduce((sum, p) => sum + p.length, 0) / capacity);
  let solution = greedy;
  let nodes = 0;
  let exhausted = false;
  // Exact feasibility search from the theoretical minimum upward. Bound work
  // for large quotations and explicitly report when optimality is unproven.
  if (pieces.length > 500 && greedy.length > lowerBound) exhausted = true;
  for (let count = lowerBound; count < greedy.length && !exhausted; count++) {
    const bars = Array.from({ length: count }, () => ({ remaining: capacity, cuts: [] }));
    const failed = new Set();
    function place(index) {
      if (++nodes > maxNodes) { exhausted = true; return false; }
      if (index === pieces.length) return true;
      const key = `${index}:${bars.map(b => b.remaining).sort((a,b) => a-b).join(',')}`;
      if (failed.has(key)) return false;
      const piece = pieces[index];
      const seen = new Set();
      for (const bar of [...bars].sort((a,b) => a.remaining-b.remaining)) {
        if (bar.remaining < piece.length || seen.has(bar.remaining)) continue;
        seen.add(bar.remaining);
        bar.remaining -= piece.length; bar.cuts.push(piece);
        if (place(index + 1)) return true;
        bar.cuts.pop(); bar.remaining += piece.length;
        if (exhausted) return false;
      }
      failed.add(key);
      return false;
    }
    if (place(0)) { solution = bars; break; }
  }
  return {
    optimal: !exhausted,
    lowerBound,
    barCount: solution.length,
    totalLeftoverMm: solution.reduce((sum, bar) => sum + bar.remaining, 0) / 1000,
    bars: solution.map(bar => ({ leftoverMm: bar.remaining / 1000,
      cuts: bar.cuts.map(piece => ({ ...piece, length: piece.length / 1000 })) })),
  };
}

function allocateProfileCuts(demands) {
  const groups = new Map();
  for (const demand of demands) {
    const code = String(demand.sapCode).trim().toUpperCase();
    const group = groups.get(code) || { stockLength: demand.stockLength, cuts: [] };
    if (group.stockLength !== demand.stockLength) throw new Error(`Conflicting stock lengths for profile ${code}`);
    groups.set(code, group);
    for (let i = 0; i < Math.max(0, Math.round(demand.quantity)); i++) {
      group.cuts.push({ length: demand.pieceLength, demand });
    }
  }
  const rows = [];
  const plans = [];
  for (const [sapCode, group] of groups) {
    let plan;
    try { plan = optimizeProfileCuts(group.cuts, group.stockLength); }
    catch (error) { throw new Error(`${sapCode}: ${error.message}`); }
    // Attribute each purchased bar to the row supplying its longest cut.
    // All cuts still participate in the shared SAP-code cutting plan.
    for (const bar of plan.bars) rows.push({ ...bar.cuts[0].demand.row });
    plans.push({ sapCode, stockLengthMm: group.stockLength, ...plan,
      bars: plan.bars.map(bar => ({ leftoverMm: bar.leftoverMm,
        cuts: bar.cuts.map(cut => ({ lengthMm: cut.length, cutLengthMm: cut.demand.cutLengthMm ?? cut.length, allowanceMm: cut.demand.allowanceMm ?? 0, position: cut.demand.position || "", cutAngle: cut.demand.cutAngle || "", source: cut.demand.source, description: cut.demand.row.description })) })) });
  }
  return { rows, plans };
}
module.exports = { optimizeProfileCuts, allocateProfileCuts };
