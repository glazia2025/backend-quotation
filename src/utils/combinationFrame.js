const PROFILE_PLACEMENTS = ['outer-left', 'outer-right', 'outer-top', 'outer-bottom', 'inner'];
const EPS = 1e-6;

// Layout coordinates are fractions of the whole frame, including nested leaves.
// Only remove a side when mullions cover its complete edge; a partial contact
// must never erase a whole frame member.
function getMullionRemovedSides(layout, joins = []) {
  const nodes = new Map();
  const leaves = [];
  function visit(node) {
    if (!node || typeof node !== 'object') return [];
    const descendants = node.children?.length ? node.children.flatMap(visit) : [node];
    if (!node.children?.length) leaves.push(node);
    if (node.id) nodes.set(String(node.id), descendants);
    return descendants;
  }
  visit(layout);
  const spans = new Map();
  const add = (leaf, side, start, end) => {
    if (end-start <= EPS) return;
    const id = String(leaf.id || '');
    if (!spans.has(id)) spans.set(id, new Map());
    const sides = spans.get(id);
    if (!sides.has(side)) sides.set(side, []);
    sides.get(side).push([start,end]);
  };
  for (const join of Array.isArray(joins) ? joins : []) {
    if (join.type !== 'Mullion') continue;
    for (const a of nodes.get(String(join.p1)) || []) {
      for (const b of nodes.get(String(join.p2)) || []) {
        if (a === b) continue;
        const ax=Number(a.x), ay=Number(a.y), aw=Number(a.w), ah=Number(a.h);
        const bx=Number(b.x), by=Number(b.y), bw=Number(b.w), bh=Number(b.h);
        if (![ax,ay,aw,ah,bx,by,bw,bh].every(Number.isFinite)) continue;
        if (Math.abs(ax+aw-bx)<EPS) {
          const start=Math.max(ay,by), end=Math.min(ay+ah,by+bh);
          add(a,'outer-right',start,end);add(b,'outer-left',start,end);
        }
        if (Math.abs(bx+bw-ax)<EPS) {
          const start=Math.max(ay,by), end=Math.min(ay+ah,by+bh);
          add(a,'outer-left',start,end);add(b,'outer-right',start,end);
        }
        if (Math.abs(ay+ah-by)<EPS) {
          const start=Math.max(ax,bx), end=Math.min(ax+aw,bx+bw);
          add(a,'outer-bottom',start,end);add(b,'outer-top',start,end);
        }
        if (Math.abs(by+bh-ay)<EPS) {
          const start=Math.max(ax,bx), end=Math.min(ax+aw,bx+bw);
          add(a,'outer-top',start,end);add(b,'outer-bottom',start,end);
        }
      }
    }
  }
  const result = new Map();
  for (const leaf of leaves) {
    const removed = [];
    for (const [side, intervals] of spans.get(String(leaf.id)) || []) {
      const vertical = side === 'outer-left' || side === 'outer-right';
      const start = Number(vertical ? leaf.y : leaf.x);
      const end = start + Number(vertical ? leaf.h : leaf.w);
      let covered = start;
      for (const [lo,hi] of intervals.sort((a,b)=>a[0]-b[0])) {
        if (lo>covered+EPS) break;
        covered=Math.max(covered,hi);
      }
      if (covered>=end-EPS) removed.push(side);
    }
    result.set(String(leaf.id), removed);
  }
  return result;
}

function removedSidesForRateItem(item) {
  const context = item.combinationContext;
  if (!context?.layout) return [];
  const sides=getMullionRemovedSides(context.layout, context.joins);
  if (sides.has(String(context.sectionId))) return sides.get(String(context.sectionId));
  return [...sides.values()][context.sectionIndex] || [];
}
function appliesToFrame(line, removedSides = []) {
  return line.itemType !== 'profile' || !removedSides.includes(line.placement);
}
module.exports = { PROFILE_PLACEMENTS, getMullionRemovedSides, removedSidesForRateItem, appliesToFrame };
