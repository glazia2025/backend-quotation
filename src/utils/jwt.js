const jwt = require("jsonwebtoken");

const DEFAULT_LOCAL_SECRET = "secret";
const LEGACY_LOCAL_SECRET = "your_secret_key";

const unique = (values) => Array.from(new Set(values.filter(Boolean)));

const getJwtSecret = () => process.env.JWT_SECRET || DEFAULT_LOCAL_SECRET;

const getJwtSecrets = () =>
  unique([
    getJwtSecret(),
    ...(process.env.JWT_SECRET_FALLBACKS || "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean),
    DEFAULT_LOCAL_SECRET,
    LEGACY_LOCAL_SECRET,
  ]);

const signJwt = (payload, options) => jwt.sign(payload, getJwtSecret(), options);

const verifyJwt = (token) => {
  let lastError;

  for (const secret of getJwtSecrets()) {
    try {
      return jwt.verify(token, secret);
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError;
};

module.exports = {
  getJwtSecret,
  signJwt,
  verifyJwt,
};
