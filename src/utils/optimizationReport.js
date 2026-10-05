const { escapeHtml: esc } = require('./cuttingSchedule');
const mm = value => Number(value.toFixed(3)).toLocaleString('en-IN', { maximumFractionDigits: 3 });
function summarizeItems(plans) {
  const items = new Map();
  plans.forEach(plan => plan.bars.forEach((bar, index) => {
    const used = bar.cuts.reduce((sum, cut) => sum + cut.lengthMm, 0);
    bar.cuts.forEach(cut => {
      const source = cut.source || { key: 'unknown', label: 'Unassigned item', instance: 1 };
      const key = `${source.refKey || source.key}:${plan.sapCode}`;
      if (!items.has(key)) items.set(key, { ...source, sapCode: plan.sapCode, cuts: 0, used: 0, waste: 0, bars: new Set(), descriptions: new Set() });
      const item = items.get(key);
      item.descriptions.add(cut.description || "Profile");
      item.cuts++;
      item.used += cut.lengthMm;
      item.waste += used ? bar.leftoverMm * cut.lengthMm / used : 0;
      item.bars.add(index + 1);
    });
  }));
  return [...items.values()].sort((a, b) =>
    String(a.refKey || a.key).localeCompare(String(b.refKey || b.key), undefined, { numeric: true }) ||
    a.sapCode.localeCompare(b.sapCode, undefined, { numeric: true }));
}
// The reference distinguishes reusable offcuts from scrap. This default is
// configurable because the source report does not state its cutoff.
function reusableCutoff() {
  const value = Number(process.env.PROFILE_REUSABLE_MIN_MM ?? 300);
  return Number.isFinite(value) && value > 0 ? value : 300;
}
const fixed = (value, digits = 1) => Number(value || 0).toFixed(digits);
const percent = (value, total) => total ? 100 * value / total : 0;
function profileWasteStats(plan, cutoff = reusableCutoff()) {
  const stock = plan.barCount * plan.stockLengthMm;
  const cuts = plan.bars.flatMap(bar => bar.cuts);
  const allowance = cuts.reduce((sum, cut) => sum + (cut.allowanceMm || 0), 0);
  const rests = plan.bars.filter(bar => bar.leftoverMm >= cutoff);
  const reusable = rests.reduce((sum, bar) => sum + bar.leftoverMm, 0);
  const leftover = plan.bars.reduce((sum, bar) => sum + bar.leftoverMm, 0);
  const inclusive = leftover + allowance;
  const exclusive = inclusive - reusable;
  return { stock, pieces: cuts.length, allowance, reusable, restCount: rests.length,
    inclusive, exclusive, inclusiveKg: inclusive / 1000 * (plan.kgm || 0),
    exclusiveKg: exclusive / 1000 * (plan.kgm || 0),
    totalPercent: percent(inclusive, stock), optimizationPercent: percent(exclusive, stock) };
}
function safeImage(value) {
  const source = String(value || '').trim();
  return /^(data:image\/(png|jpe?g|webp|gif|svg\+xml);|https?:\/\/)/i.test(source) ? source : '';
}
function optimizationPdfChrome(data) {
  const date = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kolkata', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).format(data.generatedAt || new Date()).replaceAll("/", "-").replace(",", "");
  return {
    headerTemplate: `<div style="font-family:Arial;width:100%;margin:0 10mm;color:#000;font-size:10px;"><div style="display:flex;justify-content:space-between;align-items:start"><strong style="font-size:17px">Profile Cutting Optimization Report</strong><span style="text-align:right">Date : ${esc(date)}<br>+05:30</span></div><div style="display:flex;justify-content:space-between;margin-top:14px;border-bottom:3px solid #4366de;padding-bottom:9px"><span>Project : <b>${esc(data.project)}</b></span><span>Project Code : ${esc(data.projectCode)}</span></div></div>`,
    footerTemplate: `<div style="font-family:Arial;font-size:9px;width:100%;margin:0 10mm;display:flex;justify-content:space-between;color:#000"><span>Glazia</span><span>Page <span class="pageNumber"></span> of <span class="totalPages"></span></span><span>${esc(data.quotation?.globalConfig?.website || '')}</span></div>`,
  };
}
function renderCutBar(bar, plan, offset, cutoff) {
  const reusable = bar.leftoverMm >= cutoff;
  let x = 0;
  const width = 1000;
  const pieces = bar.cuts.map((cut, index) => {
    const segment = cut.lengthMm / plan.stockLengthMm * width;
    const raw = cut.cutLengthMm ?? cut.lengthMm;
    const label = `${offset + index + 1}) ${cut.source?.label || cut.source?.refCode || '-'}${cut.position ? `-${cut.position}` : ''}`;
    const bevel = String(cut.cutAngle).includes('45') ? Math.min(12, segment / 5) : 0;
    const fontSize = Math.max(6, Math.min(15, segment / Math.max(label.length, 1) * 1.7));
    const result = `<polygon points="${x},23 ${x+bevel},3 ${x+segment-bevel},3 ${x+segment},23" fill="white" stroke="#444" stroke-width="1"/>
      <text x="${x+segment/2}" y="19" text-anchor="middle" font-size="${Math.min(15, segment/3)}">${esc(Number(raw.toFixed(3)))}</text>
      <text x="${x+segment/2}" y="43" text-anchor="middle" font-size="${fontSize}">${esc(label)}</text>`;
    x += segment;
    return result;
  }).join('');
  const leftWidth = Math.max(0, width-x);
  const tail = leftWidth ? `<rect x="${x}" y="3" width="${leftWidth}" height="20" fill="${reusable ? '#98ec90' : 'url(#scrap)'}" stroke="#444"/>${reusable ? `<text x="${x+leftWidth/2}" y="19" text-anchor="middle" font-size="${Math.min(15,leftWidth/3)}">${Number(bar.leftoverMm.toFixed(3))}</text>` : ''}` : '';
  return `<div class="bar-block"><table class="bar-meta"><tr><td class="stock-symbol">▮</td><td>Optimization bars: <span>1</span></td><td>Length : 1 x <span>${fixed(plan.stockLengthMm)}mm</span></td><td>Rest: <span>${fixed(reusable ? bar.leftoverMm : 0)}mm</span></td><td>Waste: <span>${fixed(reusable ? 0 : bar.leftoverMm)} mm</span></td></tr></table><svg viewBox="0 0 1000 48" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Bar cutting diagram"><defs><pattern id="scrap" width="7" height="7" patternUnits="userSpaceOnUse"><path d="M0 0L7 7" stroke="#e06a6a" stroke-width="1"/></pattern></defs>${pieces}${tail}</svg></div>`;
}
function buildOptimizationReportHtml(data) {
  const plans = data.profileCuttingPlans || [];
  const cutoff = reusableCutoff();
  const stats = plans.map(plan => profileWasteStats(plan, cutoff));
  const table = (headers, rows) => `<table><thead><tr>${headers.map(h => `<th>${h}</th>`).join('')}</tr></thead><tbody>${rows.join('')}</tbody></table>`;
  const references = new Map();
  summarizeItems(plans).forEach(item => {
    const key = item.refKey || item.key;
    if (!references.has(key)) references.set(key, { label: item.refCode || item.label, profiles: [] });
    references.get(key).profiles.push(item);
  });
  const appendix = [...references.values()].map(ref => `<h3>Ref Code: ${esc(ref.label)}</h3>${table(['Profile','SAP code','Pieces','Used (mm)','Allocated leftover (mm)'],ref.profiles.map((p,i) => `<tr><td>Profile ${i+1}<br>${esc([...p.descriptions].join(' / '))}</td><td>${esc(p.sapCode)}</td><td>${p.cuts}</td><td>${mm(p.used)}</td><td>${mm(p.waste)}</td></tr>`))}`).join('');
  const total = stats.reduce((sum,s) => { for(const key of ['stock','pieces','reusable','inclusive','exclusive','inclusiveKg','exclusiveKg']) sum[key]=(sum[key]||0)+s[key];return sum; }, {stock:0,pieces:0,reusable:0,inclusive:0,exclusive:0,inclusiveKg:0,exclusiveKg:0});
  const bars = plans.reduce((sum,p) => sum+p.barCount,0);
  const summaryCells = s => `<td>${mm(s.reusable)}</td><td>${mm(s.inclusive)}</td><td>${fixed(s.inclusiveKg,3)}</td><td>${fixed(percent(s.inclusive,s.stock),2)}</td><td>${mm(s.exclusive)}</td><td>${fixed(s.exclusiveKg,3)}</td><td>${fixed(percent(s.exclusive,s.stock),2)}</td>`;
  return `<!doctype html><html><head><meta charset="utf-8"><style>
  @page { size:A4; } * { box-sizing:border-box; } html,body { background:white; color:#000; color-scheme:light; } body { font:10px Arial,sans-serif; margin:0; }
  table { width:100%; border-collapse:collapse; margin:5px 0; } td,th { border:0.5px solid #888; padding:4px; text-align:left; overflow-wrap:anywhere; vertical-align:top; } thead { display:table-header-group; } tr { break-inside:avoid; }
  h2 { background:#9cdbfb; border:0.5px solid #999; font-size:12px; padding:5px 2px; margin:6px 0; break-after:avoid; } h3 { break-after:avoid; } .profile-head { break-inside:avoid; break-after:avoid; } .profile-info { background:#ddfcfb; font-weight:bold; } .profile-info .image { width:13%; background:white; text-align:center; vertical-align:middle; } .image img { width:65px; height:55px; object-fit:contain; } .image span { font-size:8px; color:#777; }
  .bar-block { break-inside:avoid; margin-top:7px; } .bar-meta { font-weight:bold; margin-bottom:0; table-layout:fixed; } .bar-meta td { height:29px; vertical-align:middle; } .bar-meta td:first-child { width:13%; } .bar-meta td:nth-child(2) { width:20%; } .bar-meta td:nth-child(3) { width:23%; } .bar-meta span { float:right; } .stock-symbol { text-align:center; font-size:22px; line-height:20px; } svg { display:block; width:100%; height:auto; font-family:Arial; }
  .profile-total { background:#ddfcfb; font-weight:bold; break-inside:avoid; margin:8px 0; } .profile-total td:nth-child(even) { text-align:right; } .summary-page,.appendix { break-before:page; } .summary-title { background:#f0e889; font-size:17px; margin:0; } .summary-table { font-size:8px; table-layout:fixed; } .summary-table th { text-align:center; overflow-wrap:normal; font-size:7.5px; } .summary-table td { padding:3px 2px; text-align:right; } .summary-table td:nth-child(2),.summary-table td:nth-child(3) { text-align:left; } .method { font-size:8px; line-height:1.4; } .warning { font-size:9px; font-weight:bold; }
  </style></head><body>
  <p>Report includes the data from projects :</p>
  <div style="width:76%">${table(['Sl No.','Project Name','Project Code','Qty','Quote Alias'],[`<tr><td>1</td><td><b>${esc(data.project)}</b></td><td>${esc(data.projectCode)}</td><td>${(data.quotation?.items || []).reduce((sum,item)=>sum+Math.max(1,Number(item.quantity)||1),0)}</td><td>${esc(data.quotation?.quotationDetails?.alias || '-')}</td></tr>`])}</div>
  ${plans.length ? plans.map((plan,index) => {
    const s=stats[index];let offset=0;
    const image=safeImage(plan.image);
    return `<div class="profile-head"><h2>${esc(plan.description || plan.sapCode)}</h2><table class="profile-info"><tr><td rowspan="3" class="image">${image ? `<img src="${esc(image)}" alt="${esc(plan.description || plan.sapCode)}">` : '<span>Image unavailable</span>'}</td><td style="width:15%">Code:</td><td style="width:32%">${esc(plan.sapCode)}</td><td>Color : ${esc(plan.colors?.join(', ') || '-')}</td></tr><tr><td>Designation:</td><td colspan="2">${esc(plan.description || plan.sapCode)}</td></tr><tr><td>Cutting tolerance:</td><td colspan="2">10 mm</td></tr></table></div>
    ${!plan.optimal ? '<p class="warning">Search limit reached; minimum not proven.</p>' : ''}
    ${plan.bars.map(bar=>{const html=renderCutBar(bar,plan,offset,cutoff);offset+=bar.cuts.length;return html;}).join('')}
    <table class="profile-total"><tr><td>Standard Bar:</td><td>${plan.barCount} Pcs</td><td>Rest No:</td><td>${s.restCount} Pcs</td><td>Total waste:</td><td>${fixed(s.totalPercent,2)} %</td></tr><tr><td>Inventory Cut Pieces:</td><td>0 Pcs</td><td>Rest length:</td><td>${fixed(s.reusable)} mm</td><td>Optimization waste:</td><td>${fixed(s.optimizationPercent,2)} %</td></tr></table>`;
  }).join('') : '<p>No profile cuts configured for this quotation.</p>'}
  <section class="summary-page"><h2 class="summary-title">Wastage Summary</h2><table class="summary-table"><colgroup><col style="width:3%"><col style="width:9%"><col style="width:16%"><col span="5" style="width:6%"><col span="7" style="width:6%"></colgroup><thead><tr><th rowspan="3">Sl No.</th><th rowspan="3">Code</th><th rowspan="3">Name</th><th colspan="5">Standard Bar</th><th colspan="7">Wastage</th></tr><tr><th rowspan="2">Length</th><th rowspan="2">Wt/Mtr</th><th rowspan="2">Ordered</th><th rowspan="2">Used</th><th rowspan="2">Total Cut Pcs</th><th rowspan="2">Reusable</th><th colspan="3">Incl. Reusable</th><th colspan="3">Excl. Reusable</th></tr><tr><th>MM</th><th>Kg.</th><th>%</th><th>MM</th><th>Kg.</th><th>%</th></tr></thead><tbody>
  ${plans.map((p,i)=>`<tr><td>${i+1}</td><td>${esc(p.sapCode)}</td><td>${esc(p.description || p.sapCode)}</td><td>${mm(p.stockLengthMm)}</td><td>${fixed(p.kgm,3)}</td><td>${p.barCount}</td><td>${p.barCount}</td><td>${stats[i].pieces}</td>${summaryCells(stats[i])}</tr>`).join('')}
  <tr><td colspan="5"><b>Total</b></td><td>${bars}</td><td>${bars}</td><td>${total.pieces}</td>${summaryCells(total)}</tr></tbody></table>
  <p class="method">Reusable rest: leftover ≥ ${mm(cutoff)} mm. Total waste includes reusable rest, scrap and the 10 mm allowance per cut. Optimization waste excludes reusable rest. Ordered is the required stock-bar quantity, not an inventory purchase record. Inventory cut pieces are 0 because this calculation uses new stock only.</p></section>
  <section class="appendix"><h2>Usage and wastage by Ref Code</h2><p class="method">Used length includes the 10 mm allowance. Shared-bar leftover is allocated proportional to each item’s cut length; it excludes cutting allowance. All copies, sections and joins are included.</p>${appendix}</section>
  </body></html>`;
}
module.exports = { buildOptimizationReportHtml, summarizeItems, profileWasteStats, optimizationPdfChrome, safeImage };
