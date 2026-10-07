// Kept identical in backend-main and backend-quotation (independent deployments).
const fullPermissions = () => ({
  survey: { enabled: true, allQuotations: true },
  quotation: { enabled: true, allQuotations: true },
  orderPlacement: true, orderHistory: true, inventory: true,
});
const cleanPermissions = (input = {}) => { const value = input || {}; return ({
  survey: { enabled: value.survey?.enabled === true, allQuotations: value.survey?.allQuotations === true },
  quotation: { enabled: value.quotation?.enabled === true, allQuotations: value.quotation?.allQuotations === true },
  orderPlacement: value.orderPlacement === true, orderHistory: value.orderHistory === true, inventory: value.inventory === true,
}); };
function resolveAccess(business, identity) {
  if (!business || business.isActive === false) return null;
  const isOwner = !identity.memberId && identity.phoneNumber === business.phoneNumber;
  const member = isOwner ? null : (business.members || []).find(row =>
    identity.memberId ? String(row._id) === String(identity.memberId) && row.phoneNumber === identity.phoneNumber : row.phoneNumber === identity.phoneNumber);
  if (!isOwner && (!member || member.isActive === false)) return null;
  return {
    businessId: String(business._id), actorId: isOwner ? String(business._id) : String(member._id),
    memberId: isOwner ? null : String(member._id), isOwner,
    name: isOwner ? business.name : member.name, role: isOwner ? 'Owner' : member.role,
    phoneNumber: identity.phoneNumber,
    permissions: isOwner ? fullPermissions() : cleanPermissions(member.permissions),
  };
}
function permits(access, module) {
  if (!access) return false;
  if (access.isOwner) return true;
  if (module === 'SURVEY_APP') return access.permissions.survey.enabled;
  if (module === 'QUOTATION_ERP') return access.permissions.quotation.enabled;
  if (module === 'MAIN_SITE') return true; // Individual routes enforce module grants.
  return access.permissions[module] === true;
}
function publicBusiness(business, access) {
  const result = typeof business.toObject === 'function' ? business.toObject() : { ...business };
  delete result.members;
  if (!access?.isOwner) {
    for (const key of ['paUrl','partnerAgreement','virtualAccount','whitelistedRemitters','adminPermissions']) delete result[key];
  }
  result.access = access;
  return result;
}
function quotationScope(access, module) {
  if (access.isOwner) return { user: access.businessId };
  const permission = module === 'SURVEY_APP' ? access.permissions.survey : access.permissions.quotation;
  return { user: access.businessId, ...(permission.allQuotations ? {} : { createdByActor: access.actorId }) };
}
module.exports = { fullPermissions, cleanPermissions, resolveAccess, permits, publicBusiness, quotationScope };
