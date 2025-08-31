// server/index.js
const path = require('path');
const fs = require('fs');

// Load .env from project root (../.env)
const envPath = path.join(__dirname, '../.env');
if (fs.existsSync(envPath)) {
  require('dotenv').config({ path: envPath });
} else {
  // Still load default if available
  require('dotenv').config();
}

const express = require('express');
const cors = require('cors');
const nodemailer = require('nodemailer');

const app = express();
const PORT = process.env.PORT || 3000;

/* --------------------------- Middleware --------------------------- */
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

/* --------------------------- Static site -------------------------- */
const publicDir = path.join(__dirname, '..'); // project root (rooms.html lives here)
app.use(express.static(publicDir));

app.get('/', (req, res) => {
  // Serve your homepage (change to index.html if you prefer)
  res.sendFile(path.join(publicDir, 'rooms.html'));
});

/* ------------------ Inline logo for email header ------------------ */
const logoPath = path.join(publicDir, 'assets', 'images', 'LOGO3.png');
const inlineLogo = {
  filename: 'LOGO3.png',
  path: logoPath,
  cid: 'alfa-logo' // <img src="cid:alfa-logo">
};

/* ----------------------- Turnstile verifier ----------------------- */
// Uses Node 18+ global fetch. If you’re on older Node, install node-fetch and import it.
async function verifyTurnstile(token, ip) {
  // In dev, if no secret is set, don’t block. In production, set TURNSTILE_SECRET_KEY.
  const secret = process.env.TURNSTILE_SECRET_KEY;
  if (!secret) {
    console.warn('[Turnstile] TURNSTILE_SECRET_KEY missing. Skipping verification (dev mode).');
    return true;
  }

  try {
    const form = new URLSearchParams();
    form.append('secret', secret);
    form.append('response', token || '');
    if (ip) form.append('remoteip', ip);

    const resp = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      body: form
    });
    const data = await resp.json();
    return !!data.success;
  } catch (e) {
    console.error('[Turnstile] Verification error:', e);
    return false;
  }
}

/* -------------------------- Mail transport ------------------------ */
const transporter = nodemailer.createTransport({
  host: 'smtp.gmail.com',
  port: 465,
  secure: true,
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS
  },
  // Dev-only: avoid local self-signed cert errors. Remove in production.
  tls: { rejectUnauthorized: false }
});

/* --------------------------- Utilities ---------------------------- */
const escapeHtml = (s = '') =>
  String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/* ------------- Booking email endpoint (no ICS file) --------------- */
app.post('/send', async (req, res) => {
  // --- Turnstile check (booking form passes `captchaToken`) ---
  const captchaToken = (req.body && req.body.captchaToken) || '';
  const ip = req.headers['cf-connecting-ip'] || req.ip;
  const captchaOk = await verifyTurnstile(captchaToken, ip);
  if (!captchaOk) {
    return res.status(400).json({ message: 'Verification failed. Please try again.' });
  }

  const {
    roomType, name, email, phone,
    checkin, checkout,
    guests, guestsText,
    nights, pricePerNight,
    roomBreakdown = '[]',
    message = ''
  } = req.body || {};

  // Parse & compute (same logic as your UI)
  const safeJson = (s, def = []) => { try { return JSON.parse(s); } catch { return def; } };
  const rooms = Array.isArray(roomBreakdown) ? roomBreakdown : safeJson(roomBreakdown);
  const roomsCount = rooms.length || 1;

  const nightsNum = (() => {
    const n = Number(nights);
    if (Number.isFinite(n) && n > 0) return n;
    if (checkin && checkout) {
      const inD = new Date(checkin), outD = new Date(checkout);
      return Math.max(0, Math.floor((outD - inD) / (1000 * 60 * 60 * 24)));
    }
    return 0;
  })();

  // Keep in sync with your front-end data-prices
  const PRICES = {
    'Economy Room':  { 1: 62, 2: 67 },
    'Standard Room': { 1: 62, 2: 67 },
    'Deluxe Room':   { 1: 67, 2: 72, 3: 76 }
  };
  const chargeableGuests = (r) =>
    Math.max(1, (Number(r.adults) || 0) + (Number(r.children) || 0) - (r.infantUnder2 ? 1 : 0));

  const nightlyRoomsSum = rooms.reduce((sum, r) => {
    const table = PRICES[r.type] || {};
    let g = chargeableGuests(r);
    while (g > 0 && table[g] == null) g--; // fallback like UI
    return sum + (table[g] || 0);
  }, 0);

  const nightlySum = nightlyRoomsSum || Number(pricePerNight) || 0;
  const taxPerNight = 2 * roomsCount; // €2/night/room
  const totalComputed = (nightlySum + taxPerNight) * nightsNum;

  // Pretty rows for "Rooms" table (if multiple)
  const rowsHtml = rooms.map((r, i) => {
    const gl = `${r.adults} Adult(s), ${r.children} Child(ren)` + (r.infantUnder2 ? ' (1 Infant)' : '');
    return `<tr>
      <td style="padding:10px;border:1px solid #e6e6e6;">Room ${i + 1}</td>
      <td style="padding:10px;border:1px solid #e6e6e6;">${escapeHtml(r.type || '')}</td>
      <td style="padding:10px;border:1px solid #e6e6e6;">${escapeHtml(gl)}</td>
    </tr>`;
  }).join('');

  // Email template
  const HOTEL_NAME = 'Hotel maroussi';
  const HOTEL_ADDR = 'Olympias 10, Maroussi, Athens, 15124, Greece';
  const guestLine = guestsText || guests || '-';
  const requestId = `AH-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}-${String(Date.now()).slice(-5)}`;

  const renderHTML = ({ heading, intro, footer }) => `
    <div style="margin:0;padding:0;background:#f7f8fb;">
      <div style="display:none;max-height:0;overflow:hidden;opacity:0;">
        ${escapeHtml(heading)} — ${escapeHtml(intro)}
      </div>
      <style>
        @media only screen and (max-width: 480px) {
          .container { width:100% !important; border-radius:0 !important; }
          .px-24 { padding-left:16px !important; padding-right:16px !important; }
          .grid { display:block !important; }
          .value { text-align:left !important; display:block !important; padding-top:4px !important; }
          .actions { white-space:nowrap !important; }
          .actions td { white-space:nowrap !important; }
          .actions a { display:inline-block !important; width:auto !important; font-size:14px !important; padding:10px 14px !important; }
        }
        .btn { border-radius:10px; }
      </style>
      <table role="presentation" cellpadding="0" cellspacing="0" border="0" align="center" width="100%">
        <tr><td align="center" style="padding:16px;">
          <table role="presentation" cellpadding="0" cellspacing="0" border="0" class="container" style="max-width:680px;width:100%;background:#ffffff;border-radius:16px;box-shadow:0 10px 28px rgba(0,0,0,0.07);overflow:hidden;">
            <tr>
              <td style="background:#800020;color:#fff;padding:22px 24px;">
                <table role="presentation"><tr>
                  <td style="vertical-align:middle;"><img src="cid:alfa-logo" alt="Hotel Maroussi" width="36" height="36" style="display:block;border-radius:4px;"></td>
                  <td style="vertical-align:middle;padding-left:10px;">
                    <div style="font-size:18px;font-weight:700;letter-spacing:.3px;font-family: Georgia, 'Times New Roman', serif;">Hotel Maroussi</div>
                    <div style="opacity:.9;font-size:12px;">${HOTEL_ADDR}</div>
                  </td>
                </tr></table>
              </td>
            </tr>
            <tr>
              <td class="px-24" style="padding:28px 24px 8px;">
                <div style="font-family: Georgia, 'Times New Roman', serif; font-size:26px; color:#800020; font-weight:700; line-height:1.25; margin:0 0 10px;">
                  Booking Request
                </div>
                <div style="font-size:13px; color:#6b7280; letter-spacing:.4px; text-transform:uppercase; margin-bottom:16px;">
                  Reference: ${requestId}
                </div>
                <p style="margin:0 0 18px;color:#2b2f36;line-height:1.65;">${escapeHtml(intro)}</p>
                <div style="border:1px solid #e6eaf0;border-radius:14px;overflow:hidden;background:#fff;">
                  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:separate;border-spacing:0;">
                    <tr><td style="padding:14px 16px;background:#f7f9fc;color:#334155;width:45%;border-bottom:1px solid #edf2f7;">Room type(s)</td>
                        <td style="padding:14px 16px;text-align:right;color:#0f172a;font-weight:600;border-bottom:1px solid #edf2f7;">${escapeHtml(roomType || '-')}</td></tr>
                    <tr><td style="padding:14px 16px;background:#f7f9fc;color:#334155;width:45%;border-bottom:1px solid #edf2f7;">Guests</td>
                        <td style="padding:14px 16px;text-align:right;color:#0f172a;font-weight:600;border-bottom:1px solid #edf2f7;">${escapeHtml(guestLine)}</td></tr>
                    <tr><td style="padding:14px 16px;background:#f7f9fc;color:#334155;width:45%;border-bottom:1px solid #edf2f7;">Check-in</td>
                        <td style="padding:14px 16px;text-align:right;color:#0f172a;font-weight:600;border-bottom:1px solid #edf2f7;">${escapeHtml(checkin || '-')}</td></tr>
                    <tr><td style="padding:14px 16px;background:#f7f9fc;color:#334155;width:45%;border-bottom:1px solid #edf2f7;">Check-out</td>
                        <td style="padding:14px 16px;text-align:right;color:#0f172a;font-weight:600;border-bottom:1px solid #edf2f7;">${escapeHtml(checkout || '-')}</td></tr>
                    <tr><td style="padding:14px 16px;background:#f7f9fc;color:#334155;width:45%;">Nights</td>
                        <td style="padding:14px 16px;text-align:right;color:#0f172a;font-weight:600;">${escapeHtml(String(nightsNum) || '-')}</td></tr>
                  </table>
                </div>
                ${rowsHtml ? `
                <div style="margin:22px 0 10px;">
                  <div style="font-weight:700;margin:0 0 8px;color:#800020;">Rooms</div>
                  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;border:1px solid #e6e6e6;border-radius:12px;overflow:hidden;">
                    <thead><tr style="background:#f3f5fb;">
                      <th align="left" style="padding:12px 12px;border-bottom:1px solid #e6e6e6;font-weight:700;color:#111;">#</th>
                      <th align="left" style="padding:12px 12px;border-bottom:1px solid #e6e6e6;font-weight:700;color:#111;">Type</th>
                      <th align="left" style="padding:12px 12px;border-bottom:1px solid #e6e6e6;font-weight:700;color:#111;">Guests</th>
                    </tr></thead>
                    <tbody>${rowsHtml}</tbody>
                  </table>
                </div>` : ``}
                <table role="presentation" cellpadding="0" cellspacing="0" border="0" class="actions" style="margin:18px 0 8px;">
                  <tr>
                    <td align="left" style="padding:0;">
                      <a href="mailto:${escapeHtml(process.env.EMAIL_TO || process.env.EMAIL_USER || '')}"
                         style="display:inline-block;background:#800020;color:#fff;text-decoration:none;padding:10px 16px;border-radius:8px;font-weight:600;white-space:nowrap;">Reply with changes</a>
                    </td>
                    <td style="width:10px;">&nbsp;</td>
                    <td align="left" style="padding:0;">
                      <a href="tel:+302106198338"
                         style="display:inline-block;background:#eef2ff;color:#800020;text-decoration:none;padding:10px 16px;border-radius:8px;font-weight:600;white-space:nowrap;">Call reception</a>
                    </td>
                  </tr>
                </table>
              </td>
            </tr>
            <tr><td style="background:#f2f4f8;color:#6b7280;padding:14px 24px;font-size:12px;">
              © ${new Date().getFullYear()} ${HOTEL_NAME} · ${HOTEL_ADDR} · Ref ${requestId}
            </td></tr>
          </table>
        </td></tr>
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
Rooms price/night: €${(Number(nightlySum) || 0).toFixed(2)}
Fees/night: €${(Number(taxPerNight) || 0).toFixed(2)}
Total: €${(Number(totalComputed) || 0).toFixed(2)}

Guest: ${name || '-'}
Email: ${email || '-'}
Phone: ${phone || '-'}

${message ? `Message:\n${message}\n\n` : ''}This is a confirmation that we received your request. It is not a final booking.`;

  // Admin email
  const adminMail = {
    from: `"${HOTEL_NAME} Website" <${process.env.EMAIL_USER}>`,
    replyTo: (name && email) ? `"${name}" <${email}>` : undefined,
    to: process.env.EMAIL_TO,
    subject: `Booking request ${requestId} — ${HOTEL_NAME}`,
    text: textSummary,
    html: renderHTML({
      heading: 'New booking request received',
      intro: 'A guest submitted a booking request through your website.',
      footer: 'Internal notification. Reply to the guest to confirm availability and finalise the booking.'
    }),
    attachments: [inlineLogo]
  };

  // Guest email
  const guestMail = {
    from: `"${HOTEL_NAME} Reservations" <${process.env.EMAIL_USER}>`,
    to: email,
    subject: `Your booking request — ${HOTEL_NAME} (Ref ${requestId})`,
    text: textSummary,
    html: renderHTML({
      heading: 'Your booking request is being processed',
      intro: `Hello ${name || 'there'}, thanks for choosing ${HOTEL_NAME}! We’ve received your request and our team will get back to you shortly to confirm availability and complete your reservation.`,
      footer: 'Note: This is a confirmation of receipt, not a final booking. You can reply to this email for any changes or questions.'
    }),
    attachments: [inlineLogo]
  };

  try {
    await transporter.sendMail(adminMail);
    if (email) await transporter.sendMail(guestMail);
    return res.status(200).json({ message: 'Thank you! Your booking request has been submitted.' });
  } catch (err) {
    console.error('Mailer error:', err);
    return res.status(500).json({ message: 'Email failed to send. Please try again later.' });
  }
});

/* --------------------------- Contact form ------------------------- */
app.post('/contact', async (req, res) => {
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
        <tr><td align="center" style="padding:16px;">
          <table role="presentation" cellpadding="0" cellspacing="0" border="0" class="container" style="max-width:680px;width:100%;background:#ffffff;border-radius:16px;box-shadow:0 10px 28px rgba(0,0,0,0.07);overflow:hidden;">
            <tr>
              <td style="background:#800020;color:#fff;padding:22px 24px;">
                <table role="presentation"><tr>
                  <td style="vertical-align:middle;"><img src="cid:alfa-logo" alt="Hotel Maroussi" width="36" height="36" style="display:block;border-radius:4px;"></td>
                  <td style="vertical-align:middle;padding-left:10px;">
                    <div style="font-size:18px;font-weight:700;letter-spacing:.3px;font-family: Georgia, 'Times New Roman', serif;">Hotel Maroussi</div>
                    <div style="opacity:.9;font-size:12px;">${HOTEL_ADDR}</div>
                  </td>
                </tr></table>
              </td>
            </tr>
            <tr>
              <td style="padding:28px 24px 18px;font-family: Georgia, 'Times New Roman', serif;">
                <div style="font-size:26px;color:#800020;font-weight:700;margin:0 0 12px;">We received your message</div>
                <div style="font-size:13px;color:#6b7280;letter-spacing:.4px;text-transform:uppercase;margin-bottom:16px;">Reference: ${requestId}</div>
                <p style="margin:0 0 18px;color:#2b2f36;line-height:1.65;">${escapeHtml(intro)}</p>
                ${message ? `
                  <div style="margin:18px 0 0;color:#2b2f36;">
                    <div style="font-weight:600;margin-bottom:4px;">Your message</div>
                    <div style="white-space:pre-wrap;color:#2b2f36;">${escapeHtml(message)}</div>
                  </div>` : ''}
                <div style="margin:22px 0 0;padding:14px 16px;border:1px solid #e9eef5;border-radius:12px;background:#fafbfe;color:#374151;font-size:14px;">
                  Our team will reply to <b>${escapeHtml(email || '')}</b> or call <b>${escapeHtml(phone || '')}</b> if needed.
                </div>
                <div style="margin:18px 0 0;color:#6b7280;font-size:12px;">${escapeHtml(footer)}</div>
              </td>
            </tr>
            <tr><td style="background:#f2f4f8;color:#6b7280;padding:14px 24px;font-size:12px;">
              © ${new Date().getFullYear()} ${HOTEL_NAME} · ${HOTEL_ADDR} · Ref ${requestId}
            </td></tr>
          </table>
        </td></tr>
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
    from: `"${HOTEL_NAME} Website" <${process.env.EMAIL_USER}>`,
    replyTo: email ? `"${name}" <${email}>` : undefined,
    to: process.env.EMAIL_TO,
    subject: `New contact form message — ${HOTEL_NAME}`,
    text: textMessage,
    html: renderHTML({
      heading: 'New contact form submission',
      intro: 'A guest has sent you a message from the website contact form.',
      footer: 'Internal notification. Reply directly to the guest.'
    }),
    attachments: [inlineLogo]
  };

  const guestMail = {
    from: `"${HOTEL_NAME} Team" <${process.env.EMAIL_USER}>`,
    to: email,
    subject: `We received your message — ${HOTEL_NAME}`,
    text: textMessage,
    html: renderHTML({
      heading: 'We received your message',
      intro: `Hello ${name || 'there'}, thank you for contacting ${HOTEL_NAME}.<br><br>We have received your message and our team will get back to you as soon as possible.`,
      footer: 'This is an automated confirmation that your message was received. Our team will contact you shortly.'
    }),
    attachments: [inlineLogo]
  };

  try {
    await transporter.sendMail(adminMail);
    if (email) await transporter.sendMail(guestMail);
    return res.status(200).json({ message: 'Thank you! Your message has been received.' });
  } catch (err) {
    console.error('Mailer error (contact):', err);
    return res.status(500).json({ message: 'Email failed to send. Please try again later.' });
  }
});

/* --------------------------- Health check ------------------------- */
app.get('/health', (_, res) => res.send('OK'));

/* ------------------------------ Start ----------------------------- */
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
