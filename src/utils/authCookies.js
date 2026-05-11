const AUTH_COOKIE_NAME = process.env.AUTH_COOKIE_NAME || "glazia_auth";
const AUTH_COOKIE_MAX_AGE_MS = 1000 * 60 * 60 * 24 * 120;

function getRequestHost(req) {
  const forwardedHost = req.get("x-forwarded-host");
  const hostHeader = forwardedHost || req.get("host") || "";
  return hostHeader.split(",")[0].trim().split(":")[0];
}

function getCookieDomain(req) {
  const host = getRequestHost(req);

  if (!host || host === "localhost" || /^\d{1,3}(\.\d{1,3}){3}$/.test(host)) {
    return undefined;
  }

  if (host === "glazia.in" || host.endsWith(".glazia.in")) {
    return ".glazia.in";
  }

  return undefined;
}

function isSecureRequest(req) {
  const forwardedProto = req.get("x-forwarded-proto");
  const protocol = (forwardedProto || req.protocol || "").split(",")[0].trim();
  const host = getRequestHost(req);

  if (protocol) {
    return protocol === "https";
  }

  return Boolean(host && host !== "localhost" && !/^\d{1,3}(\.\d{1,3}){3}$/.test(host));
}

function buildCookieOptions(req, maxAge = AUTH_COOKIE_MAX_AGE_MS) {
  const domain = getCookieDomain(req);
  const options = {
    httpOnly: false,
    sameSite: "lax",
    secure: isSecureRequest(req),
    path: "/",
    maxAge,
  };

  if (domain) {
    options.domain = domain;
  }

  return options;
}

function setAuthCookie(req, res, token, maxAge = AUTH_COOKIE_MAX_AGE_MS) {
  res.cookie(AUTH_COOKIE_NAME, token, buildCookieOptions(req, maxAge));
}

function clearAuthCookie(req, res) {
  const secure = isSecureRequest(req);
  const domain = getCookieDomain(req);
  const expired = { path: "/", expires: new Date(0), sameSite: "lax", secure };

  res.clearCookie(AUTH_COOKIE_NAME, expired);
  res.clearCookie("authToken", expired);

  if (domain) {
    res.clearCookie(AUTH_COOKIE_NAME, { ...expired, domain });
    res.clearCookie("authToken", { ...expired, domain });
  }
}

function parseCookies(req) {
  const rawCookies = req.headers.cookie;

  if (!rawCookies) {
    return {};
  }

  return rawCookies.split(";").reduce((accumulator, entry) => {
    const [name, ...valueParts] = entry.split("=");
    const trimmedName = name?.trim();

    if (!trimmedName) {
      return accumulator;
    }

    accumulator[trimmedName] = decodeURIComponent(valueParts.join("=").trim());
    return accumulator;
  }, {});
}

function extractAuthToken(req) {
  const bearerToken = req.header("Authorization")?.replace("Bearer ", "").trim();

  if (bearerToken) {
    return bearerToken;
  }

  const cookies = parseCookies(req);
  return cookies[AUTH_COOKIE_NAME] || cookies.authToken || null;
}

module.exports = {
  AUTH_COOKIE_MAX_AGE_MS,
  AUTH_COOKIE_NAME,
  buildCookieOptions,
  clearAuthCookie,
  extractAuthToken,
  setAuthCookie,
};
