// index.js (Node 20, CommonJS)
// npm deps packaged: pg
const crypto = require('crypto');
const { S3Client, GetObjectCommand } = require('@aws-sdk/client-s3');
const { SNSClient, PublishCommand } = require('@aws-sdk/client-sns'); //  SNS v3
const { Pool } = require('pg');

const s3 = new S3Client({});
const sns = new SNSClient({ region: "af-south-1" }); //  SNS client

const pool = new Pool({
  host: process.env.DB_HOST,
  port: parseInt(process.env.DB_PORT || '5432', 10),
  database: process.env.DB_NAME,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  ssl: { rejectUnauthorized: false }, 
});

// --- helpers ---

function squashWhitespace(s) {
  // Converts newlines/tabs/multiple spaces to a single space and trims ends
  return (typeof s === 'string') ? s.replace(/\s+/g, ' ').trim() : (s ?? null);
}

// Extract emails from a blob of text
function extractEmails(text) {
  if (!text) return [];
  const re = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
  const found = text.match(re) || [];
  return [...new Set(found)]; // dedupe
}

const streamToString = (stream) =>
  new Promise((resolve, reject) => {
    const chunks = [];
    stream.on('data', (d) => chunks.push(d));
    stream.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    stream.on('error', reject);
  });

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


function sha(data) {
  return crypto.createHash('sha256').update(data).digest('hex');
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

// ---------- SANRAL prose parsing helpers ----------

// Clean HTML-ish artifacts and whitespace
function cleanHtmlish(s) {
  if (s == null) return null;
  return String(s)
    .replace(/&nbsp;|&#160;|\u00A0/g, ' ')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

function looksTruncated(s) {
  if (!s) return true;
  return /\.\.\.$/.test(s) || /&n/.test(s) || s.length < 80;
}

function buildFullDescription(details) {
  if (!details) return null;
  let txt = details.rawText
    ? details.rawText
    : Array.isArray(details.paragraphs) ? details.paragraphs.join('\n') : null;
  if (!txt) return null;
  txt = txt.replace(/\r\n/g, '\n')
           .split('\n')
           .map(line => line.replace(/\s+/g, ' ').trim())
           .filter(Boolean)
           .join(' ');
  return cleanHtmlish(txt);
}

function normalizeLines(text) {
  if (!text) return [];
  return text
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map(l => l.replace(/&nbsp;|&#160;|\u00A0/g, ' ').replace(/\s+/g, ' ').trim())
    .filter(Boolean);
}

// Month map for textual dates
const MONTH_MAP = {
  january: '01', february: '02', march: '03', april: '04', may: '05', june: '06',
  july: '07', august: '08', september: '09', october: '10', november: '11', december: '12'
};

// 14 August 2025 12:00 / 14 August 2025 @ 12H00 / 14 August 2025 12:00 PM
function extractTextualDateTime(s) {
  const m = s && s.match(/(\d{1,2})\s+([A-Za-z]+)\s+(20\d{2})(?:[^0-9]{1,6}(\d{1,2})(?:[:Hh\.](\d{2}))?\s*(AM|PM)?)?/i);
  if (!m) return null;
  let [, d, mon, y, hh, mm, ampm] = m;
  const month = MONTH_MAP[mon.toLowerCase()];
  if (!month) return null;
  const day = String(d).padStart(2, '0');
  if (!hh || !mm) { hh = '00'; mm = '00'; }
  if (ampm) {
    let H = parseInt(hh, 10);
    if (ampm.toUpperCase() === 'PM' && H < 12) H += 12;
    if (ampm.toUpperCase() === 'AM' && H === 12) H = 0;
    hh = String(H).padStart(2, '0');
  }
  const tz = process.env.TZ_OFFSET || '+02:00';
  const iso = `${y}-${month}-${day}T${hh}:${mm}${tz}`;
  const dt = new Date(iso);
  return isNaN(dt) ? null : dt;
}

// 2025/10/20 10:00  (or without time)
function extractNumericDateTime(s) {
  const m = s && s.match(/(20\d{2})[\/\-\.](\d{2})[\/\-\.](\d{2})(?:[ T](\d{2}):(\d{2}))?/);
  if (!m) return null;
  const [, y, MM, DD, hh, mm] = m;
  const H = hh || '00', M = mm || '00';
  const tz = process.env.TZ_OFFSET || '+02:00';
  const iso = `${y}-${MM}-${DD}T${H}:${M}${tz}`;
  const dt = new Date(iso);
  return isNaN(dt) ? null : dt;
}

function parseDateTimeFromLine(line) {
  return extractTextualDateTime(line) || extractNumericDateTime(line);
}

// 13:30-14:00, 13h30–14h00, 13.30–14.00
function extractTimeRange(s) {
  const m = s && s.match(/(\d{1,2})[:hH\.]?(\d{2})\s*[-–]\s*(\d{1,2})[:hH\.]?(\d{2})/);
  if (!m) return null;
  const [, h1, m1, h2, m2] = m;
  return { start: `${String(h1).padStart(2,'0')}:${m1}`, end: `${String(h2).padStart(2,'0')}:${m2}` };
}

function guessVenueFromLine(line) {
  if (!line) return null;
  if (/(boardroom|building|house|hall|room|centre|center|street|road|offices? of)/i.test(line)) return line;
  const at = line.match(/\bat\s+(.{5,})/i);
  return at ? at[1] : null;
}

function extractUrls(s) {
  if (!s) return [];
  const re = /\bhttps?:\/\/[^\s)]+/gi;
  return [...new Set(s.match(re) || [])];
}

// Parse SANRAL raw prose into structured hints
function parseProseSanral(details, queriesTo) {
  const lines = normalizeLines(details?.rawText || (Array.isArray(details?.paragraphs) ? details.paragraphs.join('\n') : ''));
  const joined = lines.join(' | ');

  const closeline  = lines.find(l => /CLOSING\s+(DATE|TIME)/i.test(l));
  const briefline  = lines.find(l => /BRIEF(ING)?(\s+SESSION)?/i.test(l));
  const issueline  = lines.find(l => /ISSUE\s+DATE/i.test(l));
  const complLine  = lines.find(l => /COMPLETION AND DELIVERY OF TENDER|CLOSING TIME FOR RECEIPT/i.test(l));

  let issue_at    = issueline ? parseDateTimeFromLine(issueline) : null;

  // Briefing date/time
  let briefing_at = briefline ? parseDateTimeFromLine(briefline) : null;
  let briefing_window_end = null;
  if (briefline) {
    const brRange = extractTimeRange(briefline);
    if (brRange) {
      // If we have the date but not time, apply start time
      if (!briefing_at) {
        const day = extractTextualDateTime(briefline) || extractNumericDateTime(briefline) || parseDateTimeFromLine(joined);
        if (day) {
          const tz = process.env.TZ_OFFSET || '+02:00';
          const isoDay = day.toISOString().slice(0,10);
          briefing_at = new Date(`${isoDay}T${brRange.start}${tz}`);
        }
      }
      briefing_window_end = brRange.end;
    }
  }

  // Closing date/time (prefer latest if a range ever appears)
  let closing_at = closeline ? parseDateTimeFromLine(closeline) : null;
  if (!closing_at) {
    // Sometimes only present in "Completion and delivery…" block or elsewhere
    closing_at = complLine ? parseDateTimeFromLine(complLine) : parseDateTimeFromLine(joined);
  } else {
    const clRange = extractTimeRange(closeline);
    if (clRange) {
      const day = extractTextualDateTime(closeline) || extractNumericDateTime(closeline);
      if (day) {
        const tz = process.env.TZ_OFFSET || '+02:00';
        const isoDay = day.toISOString().slice(0,10);
        closing_at = new Date(`${isoDay}T${clRange.end}${tz}`); // deadline = end of window
      }
    }
  }

  // Venue guess
  const venueLine =
    lines.find(l => /boardroom|building|house|hall|room|centre|center|street|road|offices? of/i.test(l)) ||
    (briefline && guessVenueFromLine(briefline)) || null;
  const briefing_venue = venueLine || null;

  // Submission address (rough heuristic: lines after "at the Offices of" / "delivered to")
  let submission_address = null;
  if (complLine) {
    const idx = lines.indexOf(complLine);
    const window = lines.slice(idx, idx + 10); // next 10 lines max
    const startIdx = window.findIndex(l => /at the offices of|delivered to|address|offices of/i.test(l));
    if (startIdx >= 0) {
      const addrLines = window.slice(startIdx, startIdx + 6);
      submission_address = addrLines.join(', ');
    }
  }

  // Contacts
  const emails = extractEmails((queriesTo || '') + '\n' + (details?.rawText || ''));
  const phoneMatch = joined.match(/\b(\+?\d{1,3}[-\s]?)?\d{2,3}[-\s]?\d{3}[-\s]?\d{4}\b/);
  const phone = phoneMatch ? phoneMatch[0] : null;

  // Links / documents
  const urls = extractUrls(details?.rawText || '') // from prose
    .concat(extractUrls(queriesTo || ''));
  const document_urls = urls.filter(u =>
    /\.(pdf|zip|docx?|xlsx?)($|\?)/i.test(u) ||
    /drive\.google\.com|dropbox\.com|onedrive\.live\.com/i.test(u)
  );

  const notes = [];
  if (briefing_window_end) notes.push(`Briefing window ends at ${briefing_window_end}`);

  return {
    issue_at,
    briefing_at,
    closing_at,
    briefing_venue,
    submission_address,
    emails: [...new Set(emails)],
    phone,
    document_urls: [...new Set(document_urls)],
    notes
  };
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
      external_id: r.TenderID || r.enquiryNumber, // choose a stable id
      source_tender_id: r.TenderID || null,
      title,
      description,
      category: r.category || null,
      location: r.TenderBoxAddress || r.location || null,
      buyer: 'ESKOM',
      procurement_method: null,
      procurement_method_details: null,
      status: null,
      tender_type: null, // Eskom uses ContractType separately below
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

    // content hash to help idempotency (only meaningful fields)
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
  }).filter(x => x.tender.external_id); // drop any without an id
}

// Input: SANRAL file is an array of objects
function normalizeSanralArray(arr) {
  if (!Array.isArray(arr)) return [];
  return arr.map((r) => {
    const externalId = r.tenderNumber || null;
    if (!externalId) return null;

    const shortDesc = cleanHtmlish(r.description);
    const fullDesc =
      (looksTruncated(shortDesc) ? buildFullDescription(r.details) : null) ||
      shortDesc ||
      buildFullDescription(r.details);

    // Parse prose for date/time, venue, contacts, docs, etc.
    const prose = parseProseSanral(r.details, r.queriesTo);

    // closing_at priority: field -> prose -> null
    let closing_at = parseLocalTenderDate(r.closingDate) || prose.closing_at || null;

    const core = {
      external_id: externalId,
      source_tender_id: null,
      title: squashWhitespace(r.tenderNumber) || 'SANRAL Tender',
      description: fullDesc || null,
      category: null,
      location: squashWhitespace(r.region),
      buyer: 'SANRAL',
      procurement_method: null,
      procurement_method_details: null,
      status: null,
      tender_type: null,

      // dates
      published_at: prose.issue_at || null,
      briefing_at: prose.briefing_at || null,
      briefing_venue: prose.briefing_venue || null,
      briefing_compulsory: null,
      tender_start_at: null,
      closing_at,

      value_amount: null,
      value_currency: null,
      url: r.tenderLink || null,

      // extras
      tender_box_address: null,
      target_audience: null,
      contract_type: null,

      project_type: cleanHtmlish(r.projectType),
      queries_to: cleanHtmlish(r.queriesTo),
      // add submission address + notes into briefing_details so UI can show it
      briefing_details: [prose.submission_address, ...prose.notes].filter(Boolean).join(' | ') || null,
    };

    // Hash (based on cleaned fields)
    const hashFields = {
      external_id: core.external_id,
      title: core.title,
      description: core.description,
      location: core.location,
      published_at: core.published_at ? core.published_at.toISOString() : null,
      closing_at: core.closing_at ? core.closing_at.toISOString() : null,
      url: core.url,
      project_type: core.project_type,
      queries_to: core.queries_to,
      briefing_details: core.briefing_details
    };
    core.hash = sha(JSON.stringify(hashFields));

    // Documents: add any doc-like URLs we detected in prose
    const documents = (prose.document_urls || []).map(u => ({
      url: u,
      name: null,
      mime_type: null,
      published_at: null
    }));

    // Contacts: emails from queriesTo + prose (phone if we saw one)
    const contacts = [];
    for (const email of prose.emails) {
      contacts.push({ name: null, email, phone: prose.phone || null });
    }

    return { tender: core, documents, contacts };
  }).filter(Boolean);
}

//Transnet normaliser 
function normalizeTransnetArray(arr) {
  if (!Array.isArray(arr)) return [];
  return arr.map((r) => {
    const d = r.details || {};
    const externalId = r.referenceNumber || d.referenceNumber || null;
    if (!externalId) return null;

    // Prefer the richer 'details' fields when present
    const title = squashWhitespace(r.tenderName || d.nameOfTender || externalId);
    const description = squashWhitespace(r.description || d.description) || null;

    // Dates: prefer details.* if present, else top-level
    const published_at = parseTransnetDate(d.datePublished || null);
    const closing_at   = parseTransnetDate(d.closingDate || r.closingDate || null);
    const briefing_at  = parseTransnetDate(d.briefingDate || r.briefingSession || null);

    const contactName  = squashWhitespace(d.contactPerson);
    const contactEmail = (d.contactEmail || '').trim() || null;

    const core = {
      external_id: externalId,
      source_tender_id: null,
      title,
      description,
      category: squashWhitespace(d.tenderCategory) || null,
      location: squashWhitespace(d.locationOfService) || null,
      buyer: (d.institution || '').trim() || 'TRANSNET',
      procurement_method: null,
      procurement_method_details: null,
      status: (r.tenderStatus || d.tenderStatus || '').trim() || null,
      tender_type: (d.tenderType || '').trim() || null,

      published_at,
      briefing_at,
      briefing_venue: null,             
      briefing_compulsory: null,       
      tender_start_at: null,
      closing_at,

      value_amount: null,
      value_currency: null,

      url: r.detailsLink || null,

      tender_box_address: null,
      target_audience: null,
      contract_type: null,
      project_type: null,
      queries_to: null,
      briefing_details: squashWhitespace(d.briefingDetails) || null,
    };

    // Hash across meaningful fields (helps idempotency)
    const hashFields = {
      external_id: core.external_id,
      title: core.title,
      description: core.description,
      location: core.location,
      buyer: core.buyer,
      tender_type: core.tender_type,
      status: core.status,
      published_at: core.published_at ? core.published_at.toISOString() : null,
      closing_at: core.closing_at ? core.closing_at.toISOString() : null,
      briefing_at: core.briefing_at ? core.briefing_at.toISOString() : null,
      briefing_details: core.briefing_details,
      url: core.url
    };
    core.hash = sha(JSON.stringify(hashFields));

    // Documents (name + url)
    const documents = [];
    for (const doc of (d.documents || [])) {
      if (!doc?.url) continue;
      documents.push({
        url: doc.url,
        name: squashWhitespace(doc.name) || null,
        mime_type: null,
        published_at: null
      });
    }

    // Contacts (just one if present)
    const contacts = [];
    if (contactName || contactEmail) {
      contacts.push({ name: contactName || null, email: contactEmail || null, phone: null });
    }

    return { tender: core, documents, contacts };
  }).filter(Boolean);
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
  const client = await pool.connect();

  // Collect SNS messages and publish AFTER COMMIT
  const toPublish = [];

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

        let items = [];
        const asArray = Array.isArray(raw) ? raw : (raw && typeof raw === 'object' ? [raw] : []);

        if (source === 'eskom') {
          items = normalizeEskomArray(asArray);
        } else if (source === 'sanral') {
          items = normalizeSanralArray(asArray);
        } else if (source === 'transnet') {
          items = normalizeTransnetArray(asArray);
        } else {
          console.log(`Source not implemented yet: ${source || 'unknown'} for key ${key}`);
          continue;
        }

        if (!items.length) {
          console.log(`No ${source} items found in file: ${key}`);
          continue;
        }

        await client.query('BEGIN');
        const sourceId = await getSourceId(client, source);

        // MAIN LOOP PER TENDER
        for (const it of items) {
          const t = it.tender;
          console.log('🔹 Inside tender loop:', source, '→', t.title);
          const params = [
            sourceId, t.external_id, t.source_tender_id, t.title, t.description, t.category, t.location, t.buyer,
            t.procurement_method, t.procurement_method_details, t.status, t.tender_type,
            t.published_at, t.briefing_at, t.briefing_venue, t.briefing_compulsory,
            t.tender_start_at, t.closing_at, t.value_amount, t.value_currency, t.url, t.hash,
            t.tender_box_address, t.target_audience, t.contract_type, t.project_type, t.queries_to, t.briefing_details
          ];

          const { rows } = await client.query(UPSERT_TENDER_SQL, params);
          const tenderId = rows[0].id;

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

          // Queue SNS message (publish AFTER COMMIT)
          const cat = (t.category || source || 'general').toString().trim().toLowerCase();
          const subjectBase = `New ${cat} tender: ${t.title || 'Untitled'}`.slice(0, 95); // SNS Subject <= 100 chars

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

        // COMMIT TRANSACTION
        await client.query('COMMIT');
        console.log('Transaction committed for source', source);
        console.log(`Upserted ${items.length} ${source.toUpperCase()} record(s) from ${key}`);
      }
    }

    //  Publish all queued SNS messages AFTER successful DB commit(s)
    for (const msg of toPublish) {
      try {
        await sns.send(new PublishCommand({
          TopicArn: process.env.TENDER_TOPIC_ARN, //  from env
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

    return { ok: true };

  } catch (err) {
    console.error('Handler error:', err);
    try { await pool.query('ROLLBACK'); } catch {}
    throw err; // let SQS retry + DLQ if persistent

  } finally {
    client.release();
  }
};
