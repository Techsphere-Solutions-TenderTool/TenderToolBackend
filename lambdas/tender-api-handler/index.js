// index.js — Tender API Lambda (Node 20, AWS SDK v3)
import { Pool } from 'pg';
import {
  SNSClient,
  SubscribeCommand
} from "@aws-sdk/client-sns";
import { SSMClient, GetParameterCommand } from "@aws-sdk/client-ssm";

// ---------- Secure DB Password Fetcher ----------
const ssm = new SSMClient({ region: process.env.AWS_REGION });

async function getDbPassword() {
  try {
    console.log('Fetching password from SSM:', process.env.DB_PASSWORD_PARAM);
    const command = new GetParameterCommand({
      Name: process.env.DB_PASSWORD_PARAM,
      WithDecryption: true,
    });
    const response = await ssm.send(command);
    console.log('Successfully retrieved password from SSM');
    return response.Parameter.Value;
  } catch (error) {
    console.error('Error fetching password from SSM:', error);
    throw error;
  }
}

// ---------- Shared Clients ----------
const snsClient = new SNSClient({});

// ---------- Helper Functions ----------
const cors = () => ({
  "Content-Type": "application/json",
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type,Authorization",
});
const ok = (body) => ({ statusCode: 200, headers: cors(), body: JSON.stringify(body) });
const bad = (code, msg) => ({ statusCode: code, headers: cors(), body: JSON.stringify({ error: msg }) });

const SORT_WHITELIST = new Set(["closing_at", "published_at", "id"]);
function parseIntSafe(v, d) { const n = parseInt(v, 10); return Number.isFinite(n) ? n : d; }
function parseDateOrNull(s) { return /^\d{4}-\d{2}-\d{2}$/.test(s || "") ? s : null; }

// ---------- WHERE Builder ----------
function buildTenderWhere(qp) {
  const where = [];
  const params = [];

  if (qp.source) {
    params.push(qp.source);
    where.push(`t.source_id = (SELECT id FROM sources WHERE name = $${params.length})`);
  }
  if (qp.status) {
    params.push(qp.status);
    where.push(`t.status = $${params.length}`);
  }
  if (qp.buyer) {
    params.push(qp.buyer);
    where.push(`t.buyer = $${params.length}`);
  }
  if (qp.category) {
    params.push(qp.category);
    where.push(`t.category = $${params.length}`);
  }
  if (qp.q) {
    params.push(qp.q);
    where.push(`to_tsvector('english', coalesce(t.title,'') || ' ' || coalesce(t.description,'')) @@ plainto_tsquery('english', $${params.length})`);
  }

  const cf = parseDateOrNull(qp.closing_from);
  const ct = parseDateOrNull(qp.closing_to);
  if (cf) { params.push(cf); where.push(`t.closing_at >= $${params.length}::date`); }
  if (ct) { params.push(ct); where.push(`t.closing_at < ($${params.length}::date + INTERVAL '1 day')`); }

  const pf = parseDateOrNull(qp.published_from);
  const pt = parseDateOrNull(qp.published_to);
  if (pf) { params.push(pf); where.push(`t.published_at >= $${params.length}::date`); }
  if (pt) { params.push(pt); where.push(`t.published_at < ($${params.length}::date + INTERVAL '1 day')`); }

  const sql = where.length ? `WHERE ${where.join(" AND ")}` : "";
  return { sql, params };
}

// ---------- Shared Connection Pool ----------
let pool;

// ---------- Lambda Handler ----------
export const handler = async (event) => {
  // Initialize DB pool once per container
  if (!pool) {
    const password = await getDbPassword();
    pool = new Pool({
      host: process.env.DB_HOST,
      port: parseInt(process.env.DB_PORT || '5432', 10),
      database: process.env.DB_NAME,
      user: process.env.DB_USER,
      password,
      ssl: { rejectUnauthorized: false },
    });
  }

  const client = await pool.connect();

  try {
    const method = event.requestContext?.http?.method || event.httpMethod || "GET";
    const path = event.requestContext?.http?.path || event.path || "/";
    const qp = event.queryStringParameters || {};

    if (method === "OPTIONS") return ok({}); // CORS preflight

    // ---------- Save User Tender Preferences ----------
    if (method === "POST" && path === "/user/preferences") {
      const body = JSON.parse(event.body || "{}");
      const { email, categories } = body;

      if (!email || !Array.isArray(categories)) {
        return bad(400, "Email and categories[] required");
      }

      try {
        // find user
        const user = await client.query(
          "SELECT id FROM users WHERE email = $1",
          [email]
        );

        if (user.rowCount === 0) {
          return bad(404, "User not found");
        }

        const userId = user.rows[0].id;

        // clear old preferences
        await client.query("DELETE FROM user_preferences WHERE user_id = $1", [userId]);

        // insert new prefs + create SNS subscription per category
        for (const category of categories) {
          await client.query(
            "INSERT INTO user_preferences (user_id, tender_category) VALUES ($1, $2)",
            [userId, category]
          );

          await snsClient.send(new SubscribeCommand({
            TopicArn: process.env.TENDER_TOPIC_ARN,
            Protocol: "email",
            Endpoint: email,
            Attributes: {
              FilterPolicy: JSON.stringify({ category: [category] })
            }
          }));
        }

        return ok({ message: "Preferences saved & SNS subscriptions created" });

      } catch (err) {
        console.error("Error saving preferences:", err);
        return bad(500, "Internal server error");
      }
    }

    // ---------- GET /tenders ----------
    if (method === "GET" && path === "/tenders") {
      const { sql: whereSql, params } = buildTenderWhere(qp);
      const limit = Math.min(Math.max(parseIntSafe(qp.limit, 20), 1), 100);
      const offset = Math.max(parseIntSafe(qp.offset, 0), 0);
      const sort = SORT_WHITELIST.has(qp.sort) ? qp.sort : "closing_at";
      const order = (qp.order || "asc").toLowerCase() === "desc" ? "DESC" : "ASC";

      const totalSql = `SELECT COUNT(*) AS c FROM tenders t ${whereSql};`;
      const dataSql = `
        SELECT t.id, t.title, t.buyer, t.category, t.status, t.source_id,
               t.published_at, t.briefing_at, t.closing_at, t.location, t.url
        FROM tenders t
        ${whereSql}
        ORDER BY t.${sort} ${order} NULLS LAST
        LIMIT ${limit} OFFSET ${offset};
      `;

      const total = await client.query(totalSql, params);
      const rows = await client.query(dataSql, params);

      return ok({
        total: parseInt(total.rows[0].c, 10),
        limit, offset,
        results: rows.rows,
      });
    }

    // ---------- GET /tenders/{id} ----------
    if (method === "GET" && /^\/tenders\/\d+$/.test(path)) {
      const id = path.split("/")[2];
      const tender = await client.query(`SELECT * FROM tenders WHERE id=$1;`, [id]);
      if (tender.rowCount === 0) return bad(404, "Not found");

      const docs = await client.query(`SELECT id, url, name, mime_type, published_at FROM documents WHERE tender_id=$1 ORDER BY id;`, [id]);
      const contacts = await client.query(`SELECT id, name, email, phone FROM contacts WHERE tender_id=$1 ORDER BY id;`, [id]);

      return ok({ ...tender.rows[0], documents: docs.rows, contacts: contacts.rows });
    }

    // ---------- GET /tenders/{id}/documents ----------
    if (method === "GET" && /^\/tenders\/\d+\/documents$/.test(path)) {
      const id = path.split("/")[2];
      const docs = await client.query(`SELECT id, url, name, mime_type, published_at FROM documents WHERE tender_id=$1 ORDER BY id;`, [id]);
      return ok(docs.rows);
    }

    // ---------- GET /tenders/{id}/contacts ----------
    if (method === "GET" && /^\/tenders\/\d+\/contacts$/.test(path)) {
      const id = path.split("/")[2];
      const contacts = await client.query(`SELECT id, name, email, phone FROM contacts WHERE tender_id=$1 ORDER BY id;`, [id]);
      return ok(contacts.rows);
    }

    // ---------- Fallback ----------
    return bad(404, "Route not found");

  } catch (err) {
    console.error("API error:", err);
    return bad(500, "Internal error");
  } finally {
    client.release();
  }
};
