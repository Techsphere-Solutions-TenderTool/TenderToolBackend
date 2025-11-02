// index.js (Node 20, CommonJS) - FIXED VERSION
// npm deps packaged: pg
const crypto = require("crypto");
const { S3Client, GetObjectCommand } = require("@aws-sdk/client-s3");
const { SNSClient, PublishCommand } = require("@aws-sdk/client-sns");
const { SSMClient, GetParameterCommand } = require("@aws-sdk/client-ssm");
const { Pool } = require("pg");

const s3 = new S3Client({});
const sns = new SNSClient({ region: "af-south-1" });

// --- DB connection helpers ---
let pool;

async function getDbPassword() {
  const ssm = new SSMClient({ region: "af-south-1" });
  const paramName = process.env.DB_PASSWORD_PARAM;
  if (!paramName) throw new Error("Missing DB_PASSWORD_PARAM in environment");

  const resp = await ssm.send(
    new GetParameterCommand({ Name: paramName, WithDecryption: true })
  );

  if (!resp.Parameter || !resp.Parameter.Value) {
    throw new Error(`Parameter ${paramName} not found or empty`);
  }

  return String(resp.Parameter.Value).trim();
}

async function getPool() {
  if (pool) return pool;

  const password = await getDbPassword();
  console.log(`Got DB password from SSM (length: ${password.length})`);

  pool = new Pool({
    host: process.env.DB_HOST,
    port: parseInt(process.env.DB_PORT || "5432", 10),
    database: process.env.DB_NAME,
    user: process.env.DB_USER,
    password,
    ssl: { rejectUnauthorized: false },
  });

  return pool;
}

// --- helpers ---
function squashWhitespace(s) {
  return typeof s === "string" ? s.replace(/\s+/g, " ").trim() : s ?? null;
}

function extractEmails(text) {
  if (!text) return [];
  const re = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
  const found = text.match(re) || [];
  return [...new Set(found)];
}

const streamToString = (stream) =>
  new Promise((resolve, reject) => {
    const chunks = [];
    stream.on("data", (d) => chunks.push(d));
    stream.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    stream.on("error", reject);
  });

function sha(data) {
  return crypto.createHash("sha256").update(data).digest("hex");
}

// Parse ISO date strings from eTenders
function parseEtendersDate(dateStr) {
  if (!dateStr) return null;
  try {
    const dt = new Date(dateStr);
    return isNaN(dt) ? null : dt;
  } catch {
    return null;
  }
}

// One parser for Eskom + SANRAL (SA local time by default)
function parseLocalTenderDate(s) {
  if (!s) return null;
  const tz = process.env.TZ_OFFSET || '+02:00';

  // Try Eskom: 2027-Feb-22 13:33:00
  const m1 = s.match(/^(\d{4})-([A-Za-z]{3})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/);
  if (m1) {
    const MONTHS = { Jan:0, Feb:1, Mar:2, Apr:3, May:4, Jun:5, Jul:6, Aug:7, Sep:8, Oct:9, Nov:10, Dec:11 };
    const [_, y, mon, d, hh, mm, ss] = m1;
    const monthIndex = MONTHS[mon];
    if (monthIndex != null) {
      const yyyy = y.padStart(4, '0');
      const MM = String(monthIndex + 1).padStart(2, '0');
      const DD = d.padStart(2, '0');
      const iso = `${yyyy}-${MM}-${DD}T${hh}:${mm}:${ss}${tz}`;
      const dt = new Date(iso);
      return isNaN(dt) ? null : dt;
    }
  }

  // Try SANRAL: 2026/01/01 12:00 or 2026/01/01 12:00:30
  const m2 = s.match(/^(\d{4})\/(\d{2})\/(\d{2}) (\d{2}):(\d{2})(?::(\d{2}))?$/);
  if (m2) {
    const [_, yyyy, MM, DD, hh, mm, ss] = m2;
    const sec = ss || '00';
    const iso = `${yyyy}-${MM}-${DD}T${hh}:${mm}:${sec}${tz}`;
    const dt = new Date(iso);
    return isNaN(dt) ? null : dt;
  }

  // Fallback: return null if format unknown
  return null;
}

// Transnet: "12/12/2025 4:00:00 PM" (sometimes single-digit month/day, seconds optional)
function parseTransnetDate(s) {
  if (!s) return null;
  const tz = process.env.TZ_OFFSET || '+02:00';
  // M/D/YYYY HH:MM(:SS)? AM|PM
  const m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4}) (\d{1,2}):(\d{2})(?::(\d{2}))?\s*(AM|PM)$/i);
  if (!m) return null;
  let [_, M, D, Y, hh, mm, ss, ampm] = m;
  let H = parseInt(hh, 10) % 12;
  if (/PM/i.test(ampm)) H += 12;
  const sec = ss || '00';
  const MM = String(parseInt(M,10)).padStart(2,'0');
  const DD = String(parseInt(D,10)).padStart(2,'0');
  const HH = String(H).padStart(2,'0');
  const iso = `${Y}-${MM}-${DD}T${HH}:${mm}:${sec}${tz}`;
  const dt = new Date(iso);
  return isNaN(dt) ? null : dt;
}

// Cache for source ids (avoid querying every row)
const sourceIdCache = new Map();
async function getSourceId(client, name) {
  if (sourceIdCache.has(name)) return sourceIdCache.get(name);
  const { rows } = await client.query('SELECT id FROM sources WHERE name=$1', [name]);
  if (!rows[0]) throw new Error(`Source not found: ${name}`);
  sourceIdCache.set(name, rows[0].id);
  return rows[0].id;
}

// --- normalizers ---
/** Input: Eskom S3 file contains an array of tender objects */
function normalizeEskomArray(arr) {
  if (!Array.isArray(arr)) return [];
  return arr.map((r) => {
    const title = r.enquiryNumber || r.TenderID || 'Eskom Tender';
    const description = squashWhitespace(r.scopeDetails || r.description);
    const published_at = parseLocalTenderDate(r.published);
    const closing_at = parseLocalTenderDate(r.closing);

    const core = {
      external_id: r.TenderID || r.enquiryNumber,
      source_tender_id: r.TenderID || null,
      title,
      description,
      category: r.category || null,
      location: r.TenderBoxAddress || r.location || null,
      buyer: 'ESKOM',
      procurement_method: null,
      procurement_method_details: null,
      status: null,
      tender_type: null,
      published_at,
      briefing_at: null,
      briefing_venue: null,
      briefing_compulsory: null,
      tender_start_at: null,
      closing_at,
      value_amount: null,
      value_currency: null,
      url: r.readMore || null,
      // extras
      tender_box_address: r.TenderBoxAddress || null,
      target_audience: r.TargetAudience || null,
      contract_type: r.ContractType || null,
      project_type: null,
      queries_to: null,
      briefing_details: null,
    };

    // content hash to help idempotency
    const hashFields = {
      external_id: core.external_id,
      title: core.title,
      description: core.description,
      category: core.category,
      location: core.location,
      published_at: core.published_at ? core.published_at.toISOString() : null,
      closing_at: core.closing_at ? core.closing_at.toISOString() : null,
      url: core.url,
      tender_box_address: core.tender_box_address,
      target_audience: core.target_audience,
      contract_type: core.contract_type,
    };
    const hash = sha(JSON.stringify(hashFields));
    core.hash = hash;

    // documents (0..n)
    const documents = [];
    if (r.downloadLink) {
      documents.push({
        url: r.downloadLink,
        name: null,
        mime_type: null,
        published_at: null,
      });
    }

    // contacts (none in sample)
    const contacts = [];

    return { tender: core, documents, contacts };
  }).filter(x => x.tender.external_id);
}

// ... [SANRAL and Transnet normalizers remain the same - omitted for brevity] ...

// FIXED eTenders normalizer
function normalizeEtendersArray(raw) {
  // Handle the eTenders JSON structure which has { data: [...] }
  if (!raw || !raw.data || !Array.isArray(raw.data)) {
    console.warn("⚠️ Unexpected eTenders format - no data array found");
    return [];
  }

  console.log(`Processing ${raw.data.length} eTenders records`);

  return raw.data.map((item) => {
    // Use tender_No as external_id (required for uniqueness)
    const externalId = item.tender_No || `etenders-${item.id}`;
    
    const core = {
      external_id: externalId,
      source_tender_id: item.id ? String(item.id) : null,
      title: squashWhitespace(item.tender_No) || 'eTenders Tender',
      description: squashWhitespace(item.description),
      category: squashWhitespace(item.category || item.categories?.name),
      location: squashWhitespace(item.town || item.provinces?.name || item.province),
      buyer: squashWhitespace(item.organ_of_State || item.departments?.name || item.department),
      procurement_method: squashWhitespace(item.type),
      procurement_method_details: null,
      status: squashWhitespace(item.status),
      tender_type: squashWhitespace(item.type),
      
      // Parse dates properly
      published_at: parseEtendersDate(item.date_Published),
      briefing_at: parseEtendersDate(item.compulsory_briefing_session),
      briefing_venue: squashWhitespace(item.briefingVenue),
      briefing_compulsory: item.briefingCompulsory === true ? true : (item.briefingCompulsory === false ? false : null),
      tender_start_at: null,
      closing_at: parseEtendersDate(item.closing_Date),
      
      value_amount: null,
      value_currency: null,
      url: null, // eTenders doesn't provide direct URLs in this data
      
      // Extra fields
      tender_box_address: squashWhitespace(item.delivery || item.streetname),
      target_audience: null,
      contract_type: null,
      project_type: null,
      queries_to: squashWhitespace(item.contactPerson),
      briefing_details: item.briefingSession ? squashWhitespace(item.conditions) : null,
    };

    // Create hash for idempotency
    const hashFields = {
      external_id: core.external_id,
      title: core.title,
      description: core.description,
      category: core.category,
      location: core.location,
      buyer: core.buyer,
      published_at: core.published_at ? core.published_at.toISOString() : null,
      closing_at: core.closing_at ? core.closing_at.toISOString() : null,
      briefing_at: core.briefing_at ? core.briefing_at.toISOString() : null,
      status: core.status,
    };
    core.hash = sha(JSON.stringify(hashFields));

    // Documents from supportDocument array
    const documents = [];
    if (Array.isArray(item.supportDocument)) {
      for (const doc of item.supportDocument) {
        if (doc.fileName) {
          documents.push({
            url: null, // No URL provided in the data
            name: squashWhitespace(doc.fileName),
            mime_type: doc.extension === '.pdf' ? 'application/pdf' : null,
            published_at: parseEtendersDate(doc.dateModified),
          });
        }
      }
    }

    // Contacts
    const contacts = [];
    if (item.contactPerson || item.email || item.telephone) {
      contacts.push({
        name: squashWhitespace(item.contactPerson),
        email: item.email ? item.email.trim() : null,
        phone: squashWhitespace(item.telephone || item.fax),
      });
    }

    return { tender: core, documents, contacts };
  }).filter(item => item && item.tender && item.tender.external_id);
}

// --- DB upsert ---
const UPSERT_TENDER_SQL = `
INSERT INTO tenders (
  source_id, external_id, source_tender_id, title, description, category, location, buyer,
  procurement_method, procurement_method_details, status, tender_type,
  published_at, briefing_at, briefing_venue, briefing_compulsory,
  tender_start_at, closing_at, value_amount, value_currency, url, hash, last_seen_at,
  tender_box_address, target_audience, contract_type, project_type, queries_to, briefing_details
) VALUES (
  $1,$2,$3,$4,$5,$6,$7,$8,
  $9,$10,$11,$12,
  $13,$14,$15,$16,
  $17,$18,$19,$20,$21,$22, now(),
  $23,$24,$25,$26,$27,$28
)
ON CONFLICT (source_id, external_id) DO UPDATE SET
  source_tender_id=EXCLUDED.source_tender_id,
  title=EXCLUDED.title,
  description=EXCLUDED.description,
  category=EXCLUDED.category,
  location=EXCLUDED.location,
  buyer=EXCLUDED.buyer,
  procurement_method=EXCLUDED.procurement_method,
  procurement_method_details=EXCLUDED.procurement_method_details,
  status=EXCLUDED.status,
  tender_type=EXCLUDED.tender_type,
  published_at=EXCLUDED.published_at,
  briefing_at=EXCLUDED.briefing_at,
  briefing_venue=EXCLUDED.briefing_venue,
  briefing_compulsory=EXCLUDED.briefing_compulsory,
  tender_start_at=EXCLUDED.tender_start_at,
  closing_at=EXCLUDED.closing_at,
  value_amount=EXCLUDED.value_amount,
  value_currency=EXCLUDED.value_currency,
  url=EXCLUDED.url,
  hash=EXCLUDED.hash,
  last_seen_at=now(),
  tender_box_address=EXCLUDED.tender_box_address,
  target_audience=EXCLUDED.target_audience,
  contract_type=EXCLUDED.contract_type,
  project_type=EXCLUDED.project_type,
  queries_to=EXCLUDED.queries_to,
  briefing_details=EXCLUDED.briefing_details
RETURNING id
`;

// --- Lambda handler ---
exports.handler = async (event) => {
  console.log('SQS batch size:', event.Records?.length || 0);

  const db = await getPool();  
  const client = await db.connect();

  // Collect SNS messages and publish AFTER COMMIT
  const toPublish = [];
  let totalProcessed = 0;

  try {
    for (const msg of (event.Records || [])) {
      let body;
      try {
        body = JSON.parse(msg.body);
      } catch (e) {
        console.error('Non-JSON message body', msg.body);
        continue;
      }

      for (const rec of (body.Records || [])) {
        const bucket = rec.s3.bucket.name;
        const key = decodeURIComponent(rec.s3.object.key.replace(/\+/g, ' '));

        console.log('Processing', { bucket, key });

        // Load JSON from S3
        const { Body } = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
        const text = await streamToString(Body);
        let raw;
        try {
          raw = JSON.parse(text);
        } catch (e) {
          console.error('Bad JSON in S3 object', key, e);
          continue;
        }

        // Detect source by key prefix
        let source = null;
        if (key.startsWith('eskom/')) source = 'eskom';
        else if (key.startsWith('sanral/')) source = 'sanral';
        else if (key.startsWith('transnet/')) source = 'transnet';
        else if (key.startsWith('etenders/')) source = 'etenders';

        if (!source) {
          console.log(`Unknown source for key: ${key}`);
          continue;
        }

        let items = [];

        // Process based on source type
        if (source === 'eskom') {
          const asArray = Array.isArray(raw) ? raw : (raw && typeof raw === 'object' ? [raw] : []);
          items = normalizeEskomArray(asArray);
        } else if (source === 'sanral') {
          const asArray = Array.isArray(raw) ? raw : (raw && typeof raw === 'object' ? [raw] : []);
          items = normalizeSanralArray(asArray);
        } else if (source === 'transnet') {
          const asArray = Array.isArray(raw) ? raw : (raw && typeof raw === 'object' ? [raw] : []);
          items = normalizeTransnetArray(asArray);
        } else if (source === 'etenders') {
          // eTenders has different structure - pass the whole object
          items = normalizeEtendersArray(raw);
        }

        if (!items.length) {
          console.log(`No ${source} items found in file: ${key}`);
          continue;
        }

        console.log(`Found ${items.length} ${source} items to process`);

        // Process in batches to avoid long transactions
        const BATCH_SIZE = 100;
        for (let i = 0; i < items.length; i += BATCH_SIZE) {
          const batch = items.slice(i, Math.min(i + BATCH_SIZE, items.length));
          
          await client.query('BEGIN');
          const sourceId = await getSourceId(client, source);

          // Process batch
          for (const it of batch) {
            const t = it.tender;
            
            try {
              const params = [
                sourceId, t.external_id, t.source_tender_id, t.title, t.description, t.category, t.location, t.buyer,
                t.procurement_method, t.procurement_method_details, t.status, t.tender_type,
                t.published_at, t.briefing_at, t.briefing_venue, t.briefing_compulsory,
                t.tender_start_at, t.closing_at, t.value_amount, t.value_currency, t.url, t.hash,
                t.tender_box_address, t.target_audience, t.contract_type, t.project_type, t.queries_to, t.briefing_details
              ];

              const { rows } = await client.query(UPSERT_TENDER_SQL, params);
              const tenderId = rows[0].id;
              totalProcessed++;

              // Replace documents
              await client.query('DELETE FROM documents WHERE tender_id=$1', [tenderId]);
              for (const d of it.documents || []) {
                await client.query(
                  `INSERT INTO documents (tender_id, url, name, mime_type, published_at)
                   VALUES ($1,$2,$3,$4,$5)`,
                  [tenderId, d.url, d.name || null, d.mime_type || null, d.published_at || null]
                );
              }

              // Replace contacts
              await client.query('DELETE FROM contacts WHERE tender_id=$1', [tenderId]);
              for (const c of it.contacts || []) {
                await client.query(
                  `INSERT INTO contacts (tender_id, name, email, phone)
                   VALUES ($1,$2,$3,$4)`,
                  [tenderId, c.name || null, c.email || null, c.phone || null]
                );
              }

              // Queue SNS message (only for first few to avoid spam)
              if (toPublish.length < 10) {
                const cat = (t.category || source || 'general').toString().trim().toLowerCase();
                const subjectBase = `New ${cat} tender: ${t.title || 'Untitled'}`.slice(0, 95);

                toPublish.push({
                  subject: subjectBase,
                  payload: {
                    tenderId,
                    title: t.title,
                    category: cat,
                    source,
                    published_at: t.published_at,
                    closing_at: t.closing_at,
                    url: t.url,
                    description: t.description ? String(t.description).slice(0, 300) : null
                  }
                });
              }
            } catch (err) {
              console.error(`Error processing tender ${t.external_id}:`, err.message);
              // Continue with next tender instead of failing entire batch
            }
          }

          // COMMIT batch
          await client.query('COMMIT');
          console.log(`Committed batch ${Math.floor(i/BATCH_SIZE) + 1} of ${Math.ceil(items.length/BATCH_SIZE)} for ${source}`);
        }

        console.log(`✅ Successfully upserted ${items.length} ${source.toUpperCase()} records from ${key}`);
      }
    }

    // Publish SNS messages (limited to avoid spam)
    for (const msg of toPublish) {
      try {
        await sns.send(new PublishCommand({
          TopicArn: process.env.TENDER_TOPIC_ARN,
          Subject: msg.subject,
          Message: JSON.stringify(msg.payload),
          MessageAttributes: {
            category: { DataType: 'String', StringValue: msg.payload.category }
          }
        }));
        console.log(`📣 SNS published: ${msg.subject}`);
      } catch (snsErr) {
        console.error('SNS publish failed:', snsErr);
      }
    }

    console.log(`🎯 Total tenders processed: ${totalProcessed}`);
    return { ok: true, totalProcessed };

  } catch (err) {
    console.error('Handler error:', err);
    try { await client.query('ROLLBACK'); } catch {}
    throw err;

  } finally {
    client.release();
  }
};