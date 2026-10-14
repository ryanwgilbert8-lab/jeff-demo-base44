const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

process.env.PLAID_SECRET = "test-secret";
const plaid = require("../lib/plaid");
const { cleanPayer } = require("../lib/profile");

describe("bank token encryption", () => {
  it("round-trips and never stores the token in the clear", () => {
    const blob = plaid.encrypt("access-sandbox-abc123");
    assert.ok(!blob.includes("abc123"));
    assert.equal(plaid.decrypt(blob), "access-sandbox-abc123");
  });
  it("rejects a tampered token", () => {
    const blob = plaid.encrypt("access-sandbox-abc123");
    const parts = blob.split(".");
    parts[3] = Buffer.from("tampered!!").toString("base64url");
    assert.throws(() => plaid.decrypt(parts.join(".")));
  });
});

describe("payer names", () => {
  it("cleans payroll descriptors into a company name", () => {
    assert.equal(cleanPayer("ACME SOFTWARE PAYROLL PPD"), "Acme Software");
    assert.equal(cleanPayer("GUSTO DIR DEP ID:12345"), "Gusto");
  });
});
