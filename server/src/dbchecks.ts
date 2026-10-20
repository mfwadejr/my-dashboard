import { request as httpRequest } from "node:http";

/** Checks that talk to a database or to Docker. The database drivers are loaded only when such a monitor first runs, so they cost nothing otherwise. */

export interface DbResult { up: boolean; ms: number | null; message: string }
export const DB_KINDS = ["postgres", "mysql", "mongodb", "redis", "mssql"] as const;
export type DbKind = (typeof DB_KINDS)[number];

const load = (name: string): Promise<any> => import(name);

export const DEFAULT_QUERY: Record<string, string> = { postgres: "SELECT 1", mysql: "SELECT 1", mssql: "SELECT 1", mongodb: "", redis: "" };

/** Does this look like a connection string for the kind? Says why not in plain words. */
export function checkConn(kind: DbKind, conn: string): string | null {
  if (conn.length > 1000) return "That connection string is too long";
  const ok = {
    postgres: /^postgres(ql)?:\/\/\S+$/i, mysql: /^mysql:\/\/\S+$/i, mongodb: /^mongodb(\+srv)?:\/\/\S+$/i, redis: /^rediss?:\/\/\S*$/i,
    mssql: /^(mssql|sqlserver):\/\/\S+$|(^|;)\s*(server|data source)\s*=/i
  }[kind];
  if (ok.test(conn)) return null;
  return {
    postgres: "A PostgreSQL connection string looks like postgres://user:password@host:5432/database",
    mysql: "A MySQL or MariaDB connection string looks like mysql://user:password@host:3306/database",
    mongodb: "A MongoDB connection string looks like mongodb://user:password@host:27017",
    redis: "A Redis connection string looks like redis://:password@host:6379 (rediss:// for TLS)",
    mssql: "A SQL Server connection string looks like Server=host,1433;Database=db;User Id=user;Password=pass;Encrypt=true or mssql://user:password@host:1433/database"
  }[kind];
}

/** The address part of a connection string, without the user name or password, for showing in lists. */
export function describeConn(kind: DbKind, conn: string): string {
  try {
    if (kind === "mssql" && !/^(mssql|sqlserver):/i.test(conn)) {
      const m = /(?:^|;)\s*(?:server|data source)\s*=\s*(?:tcp:)?([^;]+)/i.exec(conn), d = /(?:^|;)\s*(?:database|initial catalog)\s*=\s*([^;]+)/i.exec(conn);
      return `${(m?.[1] ?? "SQL Server").trim().replace(",", ":")}${d ? `/${d[1].trim()}` : ""}`;
    }
    const u = new URL(conn.replace(/^mongodb\+srv:/i, "mongodb:").replace(/^mongodb:\/\/([^/]*)@([^@/]*(?:,[^@/]*)+)/i, "mongodb://$2"));
    const db = u.pathname.replace(/^\//, "");
    return `${u.host || kind}${db ? `/${db}` : ""}`;
  } catch { return kind; }
}

const scrub = (text: string, secret: string) => {
  let t = secret ? text.split(secret).join("…") : text;
  t = t.replace(/(\/\/[^/\s:@]*:)[^@\s/]+@/g, "$1…@").replace(/(password\s*=\s*)[^;\s]+/gi, "$1…");
  return t;
};

const friendly = (e: any, timeoutS: number, conn: string): string => {
  const code = String(e?.code ?? e?.errno ?? "");
  if (e?.name === "TimeoutError" || code === "ETIMEDOUT" || /timed out|timeout/i.test(String(e?.message))) return `Timed out after ${timeoutS} s`;
  if (code === "ECONNREFUSED") return "Connection refused";
  if (code === "ENOTFOUND" || code === "EAI_AGAIN") return "Name not found";
  if (code === "ECONNRESET") return "Connection was reset";
  if (code === "EHOSTUNREACH" || code === "ENETUNREACH") return "Host unreachable";
  if (e?.name === "AggregateError" && e.errors?.[0]) return friendly(e.errors[0], timeoutS, conn);
  if (/CERT|SELF.SIGNED|UNABLE_TO_VERIFY/i.test(`${code} ${e?.message}`)) return `Certificate problem: ${scrub(String(e.message), conn).slice(0, 80)}`;
  return scrub(String(e?.message ?? e ?? "Failed"), conn).slice(0, 140) || "Failed";
};

function raceTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => { const e = new Error("timed out"); e.name = "TimeoutError"; reject(e); }, ms);
    p.then(v => { clearTimeout(t); resolve(v); }, e => { clearTimeout(t); reject(e); });
  });
}

export async function dbCheck(kind: DbKind, conn: string, query: string, timeoutS: number, insecure: boolean): Promise<DbResult> {
  if (!conn) return { up: false, ms: null, message: "No connection string saved. Edit this monitor and enter one." };
  const started = Date.now();
  const ms = timeoutS * 1000;
  let close: () => Promise<unknown> | unknown = () => {};
  try {
    const sql = query.trim() || DEFAULT_QUERY[kind];
    const run = async (): Promise<string> => {
      if (kind === "postgres") {
        const pg = await load("pg"); const Client = pg.Client ?? pg.default?.Client;
        const c = new Client({ connectionString: conn, connectionTimeoutMillis: ms, query_timeout: ms, ...(insecure ? { ssl: { rejectUnauthorized: false } } : {}) });
        c.on("error", () => {});
        close = () => c.end();
        await c.connect(); const r = await c.query(sql);
        return `Query returned ${r.rowCount ?? r.rows?.length ?? 0} row(s)`;
      }
      if (kind === "mysql") {
        const my = await load("mysql2/promise");
        const c = await (my.createConnection ?? my.default.createConnection)({ uri: conn, connectTimeout: ms, ...(insecure ? { ssl: { rejectUnauthorized: false } } : {}) });
        close = () => c.end();
        const [rows] = await c.query(sql);
        return `Query returned ${Array.isArray(rows) ? rows.length : 1} row(s)`;
      }
      if (kind === "mongodb") {
        const mg = await load("mongodb"); const MongoClient = mg.MongoClient ?? mg.default.MongoClient;
        const c = new MongoClient(conn, { serverSelectionTimeoutMS: ms, connectTimeoutMS: ms, socketTimeoutMS: ms, ...(insecure ? { tlsAllowInvalidCertificates: true } : {}) });
        close = () => c.close();
        await c.connect(); await c.db("admin").command({ ping: 1 });
        return "Answered a ping";
      }
      if (kind === "redis") {
        const rd = await load("redis");
        const c = (rd.createClient ?? rd.default.createClient)({ url: conn, socket: { connectTimeout: ms, reconnectStrategy: false, ...(insecure && /^rediss:/i.test(conn) ? { rejectUnauthorized: false } : {}) } });
        c.on("error", () => {});
        close = () => { try { c.destroy(); } catch { /* already closed */ } };
        await c.connect(); const r = await c.ping();
        return `Answered ${String(r)}`;
      }
      const ms2 = await load("mssql"); const sqlLib = ms2.default ?? ms2;
      const text = /^(mssql|sqlserver):/i.test(conn) ? conn : `${conn}${insecure ? ";TrustServerCertificate=true" : ""};Connect Timeout=${timeoutS};Request Timeout=${ms}`;
      const pool = new sqlLib.ConnectionPool(insecure && /^(mssql|sqlserver):/i.test(conn) ? { ...parseMssqlUrl(conn), options: { trustServerCertificate: true } } : text);
      pool.on("error", () => {});
      close = () => pool.close();
      await pool.connect(); const r = await pool.request().query(sql);
      return `Query returned ${r.recordset?.length ?? r.rowsAffected?.[0] ?? 0} row(s)`;
    };
    const message = await raceTimeout(run(), ms + 1000);
    return { up: true, ms: Date.now() - started, message };
  } catch (e) { return { up: false, ms: null, message: friendly(e, timeoutS, conn) }; }
  finally { try { await Promise.resolve(close()); } catch { /* nothing to close */ } }
}

function parseMssqlUrl(conn: string) {
  const u = new URL(conn.replace(/^sqlserver:/i, "mssql:"));
  return { server: u.hostname, port: u.port ? Number(u.port) : 1433, user: decodeURIComponent(u.username), password: decodeURIComponent(u.password), database: u.pathname.replace(/^\//, "") || undefined };
}

// ---------------------------------------------------------------- Docker

export const CONTAINER_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;

/** Asks the Docker engine (over its socket) whether a container is running, and healthy when it has a health check. */
export function dockerCheck(name: string, timeoutS: number, socketPath = process.env.DOCKER_SOCKET || "/var/run/docker.sock"): Promise<DbResult> {
  return new Promise(resolve => {
    const started = Date.now();
    const req = httpRequest({ socketPath, path: `/containers/${encodeURIComponent(name)}/json`, method: "GET", timeout: timeoutS * 1000, headers: { Host: "docker" } }, res => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => {
        const ms = Date.now() - started, body = Buffer.concat(chunks).toString("utf8");
        if (res.statusCode === 404) return resolve({ up: false, ms, message: `No container named "${name}"` });
        if (res.statusCode !== 200) return resolve({ up: false, ms, message: `Docker answered ${res.statusCode}` });
        try {
          const st = JSON.parse(body).State ?? {}, health = st.Health?.Status as string | undefined;
          const status = String(st.Status ?? "unknown");
          if (!st.Running || st.Paused || st.Restarting) return resolve({ up: false, ms, message: `Container is ${st.Restarting ? "restarting" : st.Paused ? "paused" : status}` });
          if (health && health !== "healthy") return resolve({ up: false, ms, message: `Container is running but its health check says ${health}` });
          resolve({ up: true, ms, message: health ? "Running and healthy" : "Running" });
        } catch { resolve({ up: false, ms, message: "Docker sent an answer Homebase could not read" }); }
      });
    });
    req.on("timeout", () => { req.destroy(); resolve({ up: false, ms: null, message: `Timed out after ${timeoutS} s` }); });
    req.on("error", (e: NodeJS.ErrnoException) => {
      if (e.code === "ENOENT") return resolve({ up: false, ms: null, message: "Docker is not reachable: mount /var/run/docker.sock into the Homebase container" });
      if (e.code === "EACCES") return resolve({ up: false, ms: null, message: "Homebase may not use the Docker socket (give the container the docker group)" });
      resolve({ up: false, ms: null, message: e.message.slice(0, 120) });
    });
    req.end();
  });
}
