import mysql from "mysql2/promise";
import config from "../config/index.js";

// Single shared pool. mysql2 promise API; positional placeholders (use ?).
export const pool = mysql.createPool({
  host: config.db.host,
  port: config.db.port,
  user: config.db.user,
  password: config.db.password,
  database: config.db.database,
  waitForConnections: true,
  connectionLimit: 6,
  maxIdle: 3,
  idleTimeout: 60_000,
  charset: "utf8mb4",
  timezone: "Z",
});

export async function query(sql, params = []) {
  const [rows] = await pool.execute(sql, params);
  return rows;
}

export async function queryOne(sql, params = []) {
  const rows = await query(sql, params);
  return rows[0] ?? null;
}

export default pool;
