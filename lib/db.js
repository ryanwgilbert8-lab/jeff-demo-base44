// Postgres connection pool. DATABASE_URL comes from the environment (compose wires it locally).
const { Pool } = require("pg");

const pool = new Pool({
  connectionString: process.env.DATABASE_URL || "postgres://jeff:jeff@localhost:5432/jeff",
  max: 10
});

module.exports = pool;
