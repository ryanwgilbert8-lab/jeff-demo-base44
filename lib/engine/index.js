// The money engine: pure functions, no I/O. Every number Jeff states comes from here.
module.exports = {
  ...require("./types"),
  ...require("./money"),
  ...require("./tax"),
  ...require("./income"),
  ...require("./living"),
  ...require("./debt"),
  ...require("./plan"),
  ...require("./safeToSpend"),
};
