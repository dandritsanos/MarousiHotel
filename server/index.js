// server/index.js
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const compression = require('compression');
const morgan = require('morgan');
const rateLimit = require('express-rate-limit');
const path = require('path');
const qs = require('querystring');
const fs = require('fs');

// Node <18 fetch polyfill
const _fetch = global.fetch || ((...a) => import('node-fetch').then(({default: f}) => f(...a)));
const fetch = (...a) => _fetch(...a);

const app = express();
const PORT = process.env.PORT || 3000;

/* --------------------------- Security & middleware --------------------------- */
app.set('trust proxy', true); // behind CDN/ALB

app.use(helmet({
  contentSecurityPolicy: false, // static site may have inline styles/scripts
  crossOriginResourcePolicy: { policy: "cross-origin" }
}));
app.use(compression());
app.use(morgan(process.env.NODE_ENV === 'production' ? 'combined' : 'dev'));

const allowedOrigins = (process.env.ALLOWED_ORIGINS || '').split(',').map(s=>s.trim()).filter(Boolean);
app.use(cors({
  origin: allowedOrigins.length ? allowedOrigins : true,
  methods: ['GET','POST'],
}));

app.use(express.json({ limit: '200kb' }));
app.use(express.urlencoded({ extended: true, limit: '200kb' }));

/* --------------------------- Rate limiting --------------------------- */
// Optional Redis store (recommended when you have >1 instance)
let store;
if (process.env.REDIS_URL) {
  const { Redis } = require('ioredis');
  const { RedisStore } = require('rate-limit-redis');
  const redis = new Redis(process.env.REDIS_URL);
  store = new RedisStore({
    sendCommand: (...args) => redis.call(...args)
  });
}

const ipGetter = (req) =>
  req.headers['cf-connecting-ip'] ||
  (req.headers['x-forwarded-for'] || '').split(',')[0].trim() ||
  req.ip;

const formLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: ipGetter,
  message: { message: 'Too many requests. Please try again later.' },
  store
});

/* --------------------------- Static site ---------------------------- */
// Serve only ./public (avoid exposing project root)
const publicDir = path.join(__dirname, '..'); // project root
app.use(express.static(publicDir));
app.get('/', (req, res) => res.sendFile(path.join(publicDir, 'rooms.html')));
app.get('/rooms.html', (req, res) => res.sendFile(path.join(publicDir, 'rooms.html')));


/* ------------------ Inline logo for email header ------------------- */
const logoPath = path.join(publicDir, 'assets-marousi', 'logo.png');
const logoBase64 = fs.existsSync(logoPath) ? fs.readFileSync(logoPath).toString('base64') : null;
const inlineLogo = logoBase64 ? { filename: 'logo.png', cid: 'alfa-logo', _base64: logoBase64 } : null;

/* -------------------------- Mail transport ------------------------- */
const {
  TENANT_ID, CLIENT_ID, CLIENT_SECRET, SENDER_UPN, EMAIL_TO, EMAIL_USER
} = process.env;

["TENANT_ID","CLIENT_ID","CLIENT_SECRET","SENDER_UPN","EMAIL_TO","EMAIL_USER"].forEach(k=>{
  if(!process.env[k]) console.error(`[env] Missing ${k}`);
});

let graphTokenCache = { token: null, exp: 0 };

async function getGraphToken() {
  const now = Math.floor(Date.now()/1000);
  if (graphTokenCache.token && now < graphTokenCache.exp - 60) return graphTokenCache.token;

  const url = `https://login.microsoftonline.com/${TENANT_ID}/oauth2/v2.0/token`;
  const body = qs.stringify({
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET,
    scope: "https://graph.microsoft.com/.default",
    grant_type: "client_credentials"
  });

  const ac = new AbortController(); const t = setTimeout(()=>ac.abort(), 10000);
  const r = await fetch(url, { method: "POST", headers: {"Content-Type":"application/x-www-form-urlencoded"}, body, signal: ac.signal })
    .finally(()=>clearTimeout(t));
  const j = await r.json();
  if (!j.access_token) throw new Error("Graph token error: " + JSON.stringify(j));
  graphTokenCache = { token: j.access_token, exp: now + (j.expires_in || 3600) };
  return j.access_token;
}

async function sendViaGraph({ to, subject, html, text, attachments = [] }) {
  if (process.env.EMAIL_DRY_RUN === '1') {
    console.log('[DRY RUN] sendMail ->', { to, subject });
    return;
  }

  const token = await getGraphToken();
  const graphAttachments = (attachments || [])
    .filter(Boolean)
    .map(att => ({
      "@odata.type": "#microsoft.graph.fileAttachment",
      name: att.filename,
      contentBytes: att._base64 || '', // already base64
      isInline: !!att.cid,
      contentId: att.cid || undefined
    }));

  const payload = {
    message: {
      subject,
      body: { contentType: html ? "HTML" : "Text", content: html || text || "" },
      toRecipients: [{ emailAddress: { address: to } }],
      // "from" is implied by /users/{SENDER_UPN}/sendMail; keep explicit for clarity:
      from: { emailAddress: { address: SENDER_UPN } },
      attachments: graphAttachments
    },
    saveToSentItems: true
  };

  const url = `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(SENDER_UPN)}/sendMail`;

  let attempt = 0;
  while (true) {
    const ac = new AbortController(); const timeout = [5000,8000,12000][attempt] || 12000;
    const resp = await fetch(url, {
      method: "POST",
      headers: { "Authorization": `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: ac.signal
    }).finally(()=>clearTimeout(setTimeout(()=>ac.abort(), timeout)));

    if (resp.ok) return;
    const txt = await resp.text();

    if ((resp.status === 429 || resp.status >= 500) && attempt < 3) {
      const ra = Number(resp.headers.get('retry-after')) || (2 ** attempt) * 500;
      await new Promise(r => setTimeout(r, ra));
      attempt++;
      continue;
    }
    throw new Error(`Graph send failed ${resp.status}: ${txt}`);
  }
}

/* ------------------------- Turnstile check ------------------------- */
async function verifyTurnstile(token, req) {
  if (!process.env.TURNSTILE_SECRET_KEY) return { ok: false };
  const ip = ipGetter(req);

  const params = new URLSearchParams({
    secret: process.env.TURNSTILE_SECRET_KEY,
    response: token || '',
    remoteip: ip
  });

  try {
    const r = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      headers: {'Content-Type':'application/x-www-form-urlencoded'},
      body: params
    });
    const j = await r.json();
    return { ok: !!j.success, resp: j };
  } catch (e) {
    console.error('[Turnstile] verify error:', e);
    return { ok: false, resp: { error: String(e) } };
  }
}

const requireTurnstile = async (req, res, next) => {
  if (process.env.TURNSTILE_ENABLED !== '1') return next();
  const token = req.body?.turnstileToken || req.headers['cf-turnstile-token'];
  const { ok } = await verifyTurnstile(token, req);
  if (!ok) return res.status(400).json({ message: 'Human verification failed.' });
  next();
};

/* ------------------------------ Utils ------------------------------ */
const TITLE_FONT = "Georgia, 'Times New Roman', Times, 'DejaVu Serif', 'Noto Serif', serif";
const escapeHtml = (s = '') =>
  String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

/* --------------------------- Pricing data -------------------------- */
const PRICES = Object.freeze({
  'Standard Room': { 1: 62, 2: 67 },
  'Deluxe Room':   { 1: 72, 2: 77, 3: 87 }
});
const chargeableGuests = (r) =>
  Math.max(1, (Number(r.adults)||0) + (Number(r.children)||0) - (r.infantUnder2 ? 1 : 0));

/* ------------------- Booking email endpoint ----------------------- */
app.post('/send', formLimiter, requireTurnstile, async (req, res) => {
  try {
    const str = (v, max=400) => String(v ?? '').slice(0, max);
    const {
      roomType, name, email, phone,
      checkin, checkout,
      guests, guestsText,
      nights,
      roomBreakdown = '[]',
      message = ''
    } = req.body || {};

    const safeJson = (s, def = []) => { try { return JSON.parse(s); } catch { return def; } };
    const rooms = Array.isArray(roomBreakdown) ? roomBreakdown : safeJson(roomBreakdown);
    const roomsCount = rooms.length || 1;

    const nightsNum = (() => {
      const n = Number(nights);
      if (Number.isFinite(n) && n > 0) return n;
      if (checkin && checkout) {
        const inD = new Date(checkin), outD = new Date(checkout);
        return Math.max(0, Math.floor((outD - inD) / (1000*60*60*24)));
      }
      return 0;
    })();

    const nightlyRoomsSum = rooms.reduce((sum, r) => {
      const table = PRICES[r.type] || {};
      let g = chargeableGuests(r);
      while (g > 0 && table[g] == null) g--;
      return sum + (table[g] || 0);
    }, 0);

    const nightlySum   = nightlyRoomsSum;             // **do not trust client price**
    const taxPerNight  = 2 * roomsCount;              // €2/night/room
    const totalComputed = (nightlySum + taxPerNight) * nightsNum;

    const rowsHtml = rooms.map((r, i) => {
      const gl = `${r.adults} Adult(s), ${r.children} Child(ren)` + (r.infantUnder2 ? ' (1 Infant)' : '');
      return `<tr>
        <td style="padding:10px;border:1px solid #e6e6e6;">Room ${i+1}</td>
        <td style="padding:10px;border:1px solid #e6e6e6;">${escapeHtml(r.type || '')}</td>
        <td style="padding:10px;border:1px solid #e6e6e6;">${escapeHtml(gl)}</td>
      </tr>`;
    }).join('');

    const HOTEL_NAME = 'Hotel Maroussi';
    const HOTEL_ADDR = 'Olympias 10, Maroussi, Athens, 15124, Greece';
    const guestLine = guestsText || guests || '-';
    const requestId = `HM-${new Date().toISOString().slice(0,10).replace(/-/g,'')}-${String(Date.now()).slice(-5)}`;

    const TITLE_FONT = "Georgia, 'Times New Roman', Times, 'DejaVu Serif', 'Noto Serif', serif";

    const renderHTML = ({ heading, intro, footer }) => `
      <div style="margin:0;padding:0;background:#f7f8fb;">
        <!-- Preheader -->
        <div style="display:none;max-height:0;overflow:hidden;opacity:0;">
          ${escapeHtml(heading)} — ${escapeHtml(intro)}
        </div>

        <table role="presentation" cellpadding="0" cellspacing="0" border="0" align="center" width="100%">
          <tr>
            <td align="center" style="padding:16px;">
              <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="max-width:680px;width:100%;background:#fff;border-radius:16px;box-shadow:0 10px 28px rgba(0,0,0,0.07);overflow:hidden;">

                <!-- Header -->
                <tr>
                  <td style="background:#c47676;color:#000;padding:22px 24px;">
                    <table role="presentation" cellpadding="0" cellspacing="0" border="0">
                      <tr>
                        <td style="vertical-align:middle;">
                          <img src="cid:alfa-logo" alt="Hotel Maroussi" width="45" height="45" style="display:block;border-radius:4px;">
                        </td>
                        <td style="vertical-align:middle;padding-left:10px;">
                          <!-- BRAND uses TITLE_FONT inline -->
                          <div style="font-family:${TITLE_FONT};font-size:18px;font-weight:400;letter-spacing:.3px;">Hotel Maroussi</div>
                        </td>
                      </tr>
                    </table>
                  </td>
                </tr>

                <!-- Body -->
                <tr>
                  <td style="padding:28px 24px 8px;">
                    <!-- EMAIL TITLE uses TITLE_FONT inline -->
                    <div style="font-family:${TITLE_FONT};font-size:26px;color:#c47676;font-weight:400;line-height:1.25;margin:0 0 10px;">
                      Booking Request
                    </div>
                    <div style="font-size:13px;color:#6b7280;letter-spacing:.4px;text-transform:uppercase;margin-bottom:16px;">
                      Reference: ${requestId}
                    </div>
                    <p style="margin:0 0 18px;color:#2b2f36;line-height:1.65;">${escapeHtml(intro)}</p>

                    <!-- Details card -->
                    <div style="border:1px solid #e6eaf0;border-radius:14px;overflow:hidden;background:#fff;">
                      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:separate;border-spacing:0;">
                        <tr>
                          <td style="padding:14px 16px;background:#f7f9fc;color:#334155;width:45%;border-bottom:1px solid #edf2f7;">Room type(s)</td>
                          <td style="padding:14px 16px;text-align:right;color:#0f172a;font-weight:600;border-bottom:1px solid #edf2f7;">${escapeHtml(roomType || '-')}</td>
                        </tr>
                        <tr>
                          <td style="padding:14px 16px;background:#f7f9fc;color:#334155;width:45%;border-bottom:1px solid #edf2f7;">Guests</td>
                          <td style="padding:14px 16px;text-align:right;color:#0f172a;font-weight:600;border-bottom:1px solid #edf2f7;">${escapeHtml(guestLine)}</td>
                        </tr>
                        <tr>
                          <td style="padding:14px 16px;background:#f7f9fc;color:#334155;width:45%;border-bottom:1px solid #edf2f7;">Check-in</td>
                          <td style="padding:14px 16px;text-align:right;color:#0f172a;font-weight:600;border-bottom:1px solid #edf2f7;">${escapeHtml(checkin || '-')}</td>
                        </tr>
                        <tr>
                          <td style="padding:14px 16px;background:#f7f9fc;color:#334155;width:45%;border-bottom:1px solid #edf2f7;">Check-out</td>
                          <td style="padding:14px 16px;text-align:right;color:#0f172a;font-weight:600;border-bottom:1px solid #edf2f7;">${escapeHtml(checkout || '-')}</td>
                        </tr>
                        <tr>
                          <td style="padding:14px 16px;background:#f7f9fc;color:#334155;width:45%;">Nights</td>
                          <td style="padding:14px 16px;text-align:right;color:#0f172a;font-weight:600;">${escapeHtml(String(nightsNum) || '-')}</td>
                        </tr>
                      </table>
                    </div>

                    ${rowsHtml ? `
                      <div style="margin:22px 0 10px;">
                        <!-- SECTION TITLE uses TITLE_FONT inline -->
                        <div style="font-family:${TITLE_FONT};font-weight:400;margin:0 0 8px;color:#c47676;">Rooms</div>
                        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;border:1px solid #e6e6e6;border-radius:12px;overflow:hidden;">
                          <thead>
                            <tr style="background:#f3f5fb;">
                              <th align="left" style="padding:12px 12px;border-bottom:1px solid #e6e6e6;font-weight:700;color:#111;">#</th>
                              <th align="left" style="padding:12px 12px;border-bottom:1px solid #e6e6e6;font-weight:700;color:#111;">Type</th>
                              <th align="left" style="padding:12px 12px;border-bottom:1px solid #e6e6e6;font-weight:700;color:#111;">Guests</th>
                            </tr>
                          </thead>
                          <tbody>${rowsHtml}</tbody>
                        </table>
                      </div>` : ``}

                    <!-- Next steps -->
                    <div style="margin:20px 0 0;padding:14px 16px;border:1px solid #e9eef5;border-radius:12px;background:#fafbfe;">
                      <div style="font-weight:700;color:#0f172a;margin-bottom:8px;">Next steps</div>
                      <ol style="margin:0;padding-left:18px;color:#374151;line-height:1.6;">
                        <li>Our team will review availability and get back to you shortly.</li>
                        <li>We may request additional details to finalise your reservation.</li>
                        <li>No payment has been taken at this stage.</li>
                      </ol>
                    </div>

                    <!-- Guest + message -->
                    <div style="margin:18px 0 0;color:#2b2f36;">
                      <div style="font-weight:600;margin-bottom:4px;">Guest</div>
                      <div>${escapeHtml(name || '-')} · ${escapeHtml(email || '-')} · ${escapeHtml(phone || '-')}</div>
                    </div>
                    ${message ? `
                      <div style="margin:12px 0 0;">
                        <div style="font-weight:600;margin-bottom:4px;color:#2b2f36;">Message</div>
                        <div style="white-space:pre-wrap;color:#2b2f36;">${escapeHtml(message)}</div>
                      </div>` : ``}

                    <div style="margin:18px 0 0;color:#6b7280;font-size:12px;">${escapeHtml(footer)}</div>

                    <!-- BUTTONS: kept -->
                    <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:18px 0 8px;">
                      <tr>
                        <td align="left" style="padding:0;">
                          <a href="https://maps.app.goo.gl/qbPpfM9KXKvKtNpm8"
                            style="display:inline-block;background:#c47676;color:#000;text-decoration:none;padding:10px 16px;border-radius:8px;font-weight:600;">
                            Directions
                          </a>
                        </td>
                        <td style="width:10px;">&nbsp;</td>
                        <td align="left" style="padding:0;">
                          <a href="tel:+302106198338"
                            style="display:inline-block;background:#eef2ff;color:#c47676;text-decoration:none;padding:10px 16px;border-radius:8px;font-weight:600;">
                            Call reception
                          </a>
                        </td>
                      </tr>
                    </table>

                  </td>
                </tr>

                <!-- Footer -->
                <tr>
                  <td style="background:#f2f4f8;color:#6b7280;padding:14px 24px;font-size:12px;">
                    © ${new Date().getFullYear()} Hotel Maroussi · Olympias 10, Maroussi, Athens, 15124, Greece · Ref ${requestId}
                  </td>
                </tr>

              </table>
            </td>
          </tr>
        </table>
      </div>
    `;

    const textSummary =
`Booking Request — ${HOTEL_NAME}
Reference: ${requestId}

Room type(s): ${roomType || '-'}
Guests: ${guestLine}
Check-in: ${checkin || '-'}
Check-out: ${checkout || '-'}
Nights: ${nightsNum}
Rooms price/night: €${(Number(nightlySum)||0).toFixed(2)}
Fees/night: €${(Number(taxPerNight)||0).toFixed(2)}
Total: €${(Number(totalComputed)||0).toFixed(2)}

Guest: ${name || '-'}
Email: ${email || '-'}
Phone: ${phone || '-'}

${message ? `Message:\n${message}\n\n` : ''}This is a confirmation that we received your request. It is not a final booking.`;

    const adminMail = {
      from: `"${HOTEL_NAME} Website" <${EMAIL_USER}>`,
      to: EMAIL_TO,
      subject: `Booking request ${requestId} - ${HOTEL_NAME}`,
      text: textSummary,
      html: renderHTML({
        heading: 'New booking request received',
        intro: 'A guest submitted a booking request through your website.',
        footer: 'Internal notification. Reply to the guest to confirm availability and finalise the booking.'
      }),
      attachments: inlineLogo ? [inlineLogo] : []
    };

    const guestMail = {
      from: `"${HOTEL_NAME} Reservations" <${EMAIL_USER}>`,
      to: email,
      subject: `Your booking request - ${HOTEL_NAME} (Ref ${requestId})`,
      text: textSummary,
      html: renderHTML({
        heading: 'Your booking request is being processed',
        intro: `Hello ${name || 'there'}, thanks for choosing ${HOTEL_NAME}. We have received your request and our team will be in touch shortly to confirm availability and finalise your reservation.`,
        footer: 'Note: This is a confirmation of receipt, not a final booking. You can reply to this email for any changes or questions.'
      }),
      attachments: inlineLogo ? [inlineLogo] : []
    };

    if (!TENANT_ID || !CLIENT_ID || !CLIENT_SECRET || !SENDER_UPN || !EMAIL_TO || !EMAIL_USER) {
      console.error('[env] Missing required mail envs');
      return res.status(500).json({ message: 'Server email configuration is incomplete.' });
    }

    await sendViaGraph(adminMail);
    if (email) await sendViaGraph(guestMail);

    return res.status(200).json({ message: 'Thank you! Your booking request has been submitted.' });
  } catch (err) {
    console.error('Mailer error:', err);
    return res.status(500).json({ message: 'Email failed to send. Please try again later.' });
  }
});

/* ----------------------------- Contact ----------------------------- */
app.post('/contact', formLimiter, requireTurnstile, async (req, res) => {
  try {
    const { name, email, phone, message } = req.body || {};
    const HOTEL_NAME = 'Hotel Maroussi';
    const HOTEL_ADDR = 'Olympias 10, Maroussi, Athens, 15124, Greece';
    const requestId = `CT-${new Date().toISOString().slice(0,10).replace(/-/g,'')}-${String(Date.now()).slice(-5)}`;

    const renderHTML = ({ heading, intro, footer }) => `
      <div style="margin:0;padding:0;background:#f7f8fb;">
        <div style="display:none;max-height:0;overflow:hidden;opacity:0;">
          ${escapeHtml(heading)} — ${escapeHtml(intro)}
        </div>

        <table role="presentation" cellpadding="0" cellspacing="0" border="0" align="center" width="100%">
          <tr>
            <td align="center" style="padding:16px;">
              <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="max-width:680px;width:100%;background:#fff;border-radius:16px;box-shadow:0 10px 28px rgba(0,0,0,0.07);overflow:hidden;">
                <tr>
                  <td style="background:#c47676;color:#000;padding:22px 24px;">
                    <table role="presentation"><tr>
                      <td style="vertical-align:middle;">
                        <img src="cid:alfa-logo" alt="Hotel Maroussi" width="45" height="45" style="display:block;border-radius:4px;">
                      </td>
                      <td style="vertical-align:middle;padding-left:10px;">
                        <div style="font-family:${TITLE_FONT};font-size:18px;font-weight:400;letter-spacing:.3px;">Hotel Maroussi</div>
                      </td>
                    </tr></table>
                  </td>
                </tr>

                <tr>
                  <td style="padding:28px 24px 18px;">
                    <div style="font-family:${TITLE_FONT};font-size:26px;color:#c47676;font-weight:700;margin:0 0 12px;">We received your message</div>
                    <div style="font-size:13px;color:#6b7280;letter-spacing:.4px;text-transform:uppercase;margin-bottom:16px;">
                      Reference: ${requestId}
                    </div>

                    <p style="margin:0 0 18px;color:#2b2f36;line-height:1.65;">${intro}</p>

                    ${message ? `
                      <div style="margin:18px 0 0;color:#2b2f36;">
                        <div style="font-weight:600;margin-bottom:4px;">Your message</div>
                        <div style="white-space:pre-wrap;color:#2b2f36;">${escapeHtml(message)}</div>
                      </div>` : ''}

                    <div style="margin:22px 0 0;padding:14px 16px;border:1px solid #e9eef5;border-radius:12px;background:#fafbfe;color:#374151;font-size:14px;">
                      Our team will reply to <b>${escapeHtml(email || '')}</b> or call <b>${escapeHtml(phone || '')}</b> if needed.
                    </div>

                    <div style="margin:18px 0 0;color:#6b7280;font-size:12px;">${escapeHtml(footer)}</div>

                    <!-- (Optional) Keep buttons here too -->
                    <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:18px 0 8px;">
                      <tr>
                        <td align="left" style="padding:0;">
                          <a href="https://maps.app.goo.gl/qbPpfM9KXKvKtNpm8"
                            style="display:inline-block;background:#c47676;color:#000;text-decoration:none;padding:10px 16px;border-radius:8px;font-weight:600;">
                            Directions
                          </a>
                        </td>
                        <td style="width:10px;">&nbsp;</td>
                        <td align="left" style="padding:0;">
                          <a href="tel:+302106198338"
                            style="display:inline-block;background:#eef2ff;color:#c47676;text-decoration:none;padding:10px 16px;border-radius:8px;font-weight:600;">
                            Call reception
                          </a>
                        </td>
                      </tr>
                    </table>
                  </td>
                </tr>

                <tr>
                  <td style="background:#f2f4f8;color:#6b7280;padding:14px 24px;font-size:12px;">
                    © ${new Date().getFullYear()} Hotel Maroussi · Olympias 10, Maroussi, Athens, 15124, Greece · Ref ${requestId}
                  </td>
                </tr>
              </table>
            </td>
          </tr>
        </table>
      </div>
    `;

    const textMessage = `Hello ${name || 'there'},

Thank you for contacting ${HOTEL_NAME}.
We have received your message and our team will get back to you as soon as possible.

Your message:
${message || '-'}

Ref: ${requestId}
`;

    const adminMail = {
      from: `"${HOTEL_NAME} Website" <${EMAIL_USER}>`,
      to: EMAIL_TO,
      subject: `New contact form message — ${HOTEL_NAME}`,
      text: textMessage,
      html: renderHTML({
        heading: 'New contact form submission',
        intro: 'A guest has sent you a message from the website contact form.',
        footer: 'Internal notification. Reply directly to the guest.'
      }),
      attachments: inlineLogo ? [inlineLogo] : []
    };

    const guestMail = {
      from: `"${HOTEL_NAME} Team" <${EMAIL_USER}>`,
      to: email,
      subject: `We received your message — ${HOTEL_NAME}`,
      text: textMessage,
      html: renderHTML({
        heading: 'We received your message',
        intro: `Hello ${name || 'there'}, thank you for choosing ${HOTEL_NAME}.<br><br>We have received your request and our team will be in touch shortly.`,
        footer: 'This is an automated confirmation that your message was received.'
      }),
      attachments: inlineLogo ? [inlineLogo] : []
    };

    if (!TENANT_ID || !CLIENT_ID || !CLIENT_SECRET || !SENDER_UPN || !EMAIL_TO || !EMAIL_USER) {
      return res.status(500).json({ message: 'Server email configuration is incomplete.' });
    }

    await sendViaGraph(adminMail);
    if (email) await sendViaGraph(guestMail);

    return res.status(200).json({ message: 'Thank you! Your message has been received.' });
  } catch (err) {
    console.error('Mailer error (contact):', err);
    return res.status(500).json({ message: 'Email failed to send. Please try again later.' });
  }
});

/* --------------------------- Health check -------------------------- */
app.get('/health', (_req, res) => {
  const ok = !!(TENANT_ID && CLIENT_ID && CLIENT_SECRET && SENDER_UPN && EMAIL_TO && EMAIL_USER);
  res.status(ok ? 200 : 500).json({
    ok,
    uptime: process.uptime(),
    node: process.version,
    logo: !!logoBase64,
    turnstile: process.env.TURNSTILE_ENABLED === '1'
  });
});

/* ------------------------------ Start ------------------------------ */
app.listen(PORT, "0.0.0.0", () => console.log("Server started on port " + PORT));
