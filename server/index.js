// server/index.js
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
// --- Graph mail helper (Microsoft Graph, app permissions) ---
const qs = require('querystring');
const fs = require('fs');


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
  res.sendFile(path.join(publicDir, 'rooms.html'));
});

/* ------------------ Inline logo for email header ------------------ */
const logoPath = path.join(publicDir, 'assets-marousi', 'logo.png');
const inlineLogo = {
  filename: 'logo.png',
  path: logoPath,
  cid: 'alfa-logo' // use <img src="cid:alfa-logo">
};

/* -------------------------- Mail transport ------------------------ */
const {
  TENANT_ID, CLIENT_ID, CLIENT_SECRET, SENDER_UPN, EMAIL_TO, EMAIL_USER
} = process.env;

["TENANT_ID","CLIENT_ID","CLIENT_SECRET","SENDER_UPN","EMAIL_TO"].forEach(k=>{
  if(!process.env[k]) console.error(`[env] Missing ${k}`);
});

async function getGraphToken() {
  const url = `https://login.microsoftonline.com/${TENANT_ID}/oauth2/v2.0/token`;
  const body = qs.stringify({
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET,
    scope: "https://graph.microsoft.com/.default",
    grant_type: "client_credentials"
  });
  const r = await fetch(url, {
    method: "POST",
    headers: {"Content-Type":"application/x-www-form-urlencoded"},
    body
  });
  const j = await r.json();
  if (!j.access_token) throw new Error("Graph token error: " + JSON.stringify(j));
  return j.access_token;
}

function fileToBase64(path) {
  const buf = fs.readFileSync(path);
  return buf.toString('base64');
}

/**
 * Send mail via Microsoft Graph.
 * Supports HTML or text and inline attachments via cid (contentId).
 *   sendViaGraph({ to, subject, html, text, attachments: [{ filename, path, cid }] })
 */
async function sendViaGraph({ to, subject, html, text, attachments = [] }) {
  const token = await getGraphToken();

  const graphAttachments = attachments.map(att => ({
    "@odata.type": "#microsoft.graph.fileAttachment",
    name: att.filename,
    contentBytes: fileToBase64(att.path),
    isInline: !!att.cid,
    contentId: att.cid || undefined
  }));

  const payload = {
    message: {
      subject,
      body: { contentType: html ? "HTML" : "Text", content: html || text || "" },
      toRecipients: [{ emailAddress: { address: to } }],
      // The actual sender will be SENDER_UPN. Ensure that mailbox exists and is allowed.
      from: { emailAddress: { address: SENDER_UPN } },
      attachments: graphAttachments
    },
    saveToSentItems: true
  };

  const url = `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(SENDER_UPN)}/sendMail`;
  const resp = await fetch(url, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${token}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(payload)
  });

  if (!resp.ok) {
    const t = await resp.text();
    throw new Error(`Graph send failed ${resp.status}: ${t}`);
  }
}


app.set('trust proxy', true); // get real client IP behind a proxy/CDN

// server
async function verifyTurnstile(token, req) {
  console.log('[Turnstile] token:', token ? token.slice(0,12)+'…' : '(missing)');
  const secret = process.env.TURNSTILE_SECRET_KEY;
  if (!secret) { console.error('TURNSTILE_SECRET_KEY missing'); return { ok:false }; }

  const ip = req.headers['cf-connecting-ip']
          || (req.headers['x-forwarded-for']||'').split(',')[0].trim()
          || req.ip;

  const resp = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
    method: 'POST',
    headers: {'Content-Type':'application/x-www-form-urlencoded'},
    body: new URLSearchParams({ secret, response: token, remoteip: ip })
  }).then(r => r.json()).catch(e => ({ success:false, error: String(e) }));

  console.log('[Turnstile] verify resp:', resp);
  return { ok: !!resp.success, resp };
}

const TITLE_FONT = "Georgia, 'Times New Roman', Times, 'DejaVu Serif', 'Noto Serif', serif";

/* --------------------------- Utilities ---------------------------- */
const escapeHtml = (s = '') =>
  String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

/* ------------- Booking email endpoint (no ICS file) --------------- */
app.post('/send', async (req, res) => {
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
      return Math.max(0, Math.floor((outD - inD) / (1000*60*60*24)));
    }
    return 0;
  })();

  // keep in sync with your front-end data-prices
  const PRICES = {
    'Standard Room': { 1: 62, 2: 67 },
    'Deluxe Room':   { 1: 72, 2: 77, 3: 87 }
  };
  const chargeableGuests = (r) =>
    Math.max(1, (Number(r.adults)||0) + (Number(r.children)||0) - (r.infantUnder2 ? 1 : 0));

  const nightlyRoomsSum = rooms.reduce((sum, r) => {
    const table = PRICES[r.type] || {};
    let g = chargeableGuests(r);
    while (g > 0 && table[g] == null) g--;  // fallback like UI
    return sum + (table[g] || 0);
  }, 0);

  const nightlySum   = nightlyRoomsSum || Number(pricePerNight) || 0;
  const taxPerNight  = 2 * roomsCount; // €2/night/room
  const totalComputed = (nightlySum + taxPerNight) * nightsNum;

  // Pretty rows for "Rooms" table (if multiple)
  const rowsHtml = rooms.map((r, i) => {
    const gl = `${r.adults} Adult(s), ${r.children} Child(ren)` + (r.infantUnder2 ? ' (1 Infant)' : '');
    return `<tr>
      <td style="padding:10px;border:1px solid #e6e6e6;">Room ${i+1}</td>
      <td style="padding:10px;border:1px solid #e6e6e6;">${escapeHtml(r.type || '')}</td>
      <td style="padding:10px;border:1px solid #e6e6e6;">${escapeHtml(gl)}</td>
    </tr>`;
  }).join('');

  // Email template (formal, icon-free)
  const HOTEL_NAME = 'Hotel Maroussi';
  const HOTEL_ADDR = 'Olympias 10, Maroussi, Athens, 15124, Greece';
  const guestLine = guestsText || guests || '-';
  const fmt = (n) => Number.isFinite(n) ? `€${Number(n).toFixed(2)}` : '-';

  // Lightweight reference for this request (for the subject/footer)
  const requestId = `AH-${new Date().toISOString().slice(0,10).replace(/-/g,'')}-${String(Date.now()).slice(-5)}`;

  const renderHTML = ({ heading, intro, footer }) => `
    <div style="margin:0;padding:0;background:#f7f8fb;">
      <!-- Preheader -->
      <div style="display:none;max-height:0;overflow:hidden;opacity:0;">
        ${escapeHtml(heading)} — ${escapeHtml(intro)}
      </div>

      <style>

        .brand, .title, .section-title {
          font-family: ${TITLE_FONT}!important;
        }

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
        <tr>
          <td align="center" style="padding:16px;">
            <table role="presentation" cellpadding="0" cellspacing="0" border="0" class="container" style="max-width:680px;width:100%;background:#fff;border-radius:16px;box-shadow:0 10px 28px rgba(0,0,0,0.07);overflow:hidden;">

              <!-- Header -->
              <tr>
                <td style="background:#c47676;color:#000;padding:22px 24px;">
                  <table role="presentation" cellpadding="0" cellspacing="0" border="0">
                    <tr>
                      <td style="vertical-align:middle;">
                        <img src="cid:alfa-logo" alt="Hotel Maroussi" width="45" height="45" style="display:block;border-radius:4px;">
                      </td>
                      <td style="vertical-align:middle;padding-left:10px;">
                        <div  class="brand" style="font-family: Georgia, 'Times New Roman', Times, 'DejaVu Serif', 'Noto Serif', serif; font-size:18px;font-weight:400;letter-spacing:.3px;">Hotel Maroussi</div>
                      </td>
                    </tr>
                  </table>
                </td>
              </tr>

              <!-- Body -->
              <tr>
                <td class="px-24" style="padding:28px 24px 8px;">
                  <div class="title" style="font-family: Georgia, 'Times New Roman', Times, 'DejaVu Serif', 'Noto Serif', serif; font-size:26px; color:#c47676; font-weight:400; line-height:1.25; margin:0 0 10px;">
                    Booking Request
                  </div>
                  <div style="font-size:13px; color:#6b7280; letter-spacing:.4px; text-transform:uppercase; margin-bottom:16px;">
                    Reference: ${requestId}
                  </div>
                  <p style="margin:0 0 18px;color:#2b2f36;line-height:1.65;">
                    ${escapeHtml(intro)}
                  </p>

                  <!-- Details card (unchanged) -->
                  <div style="border:1px solid #e6eaf0;border-radius:14px;overflow:hidden;background:#fff;">
                    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:separate;border-spacing:0;">
                      <tr>
                        <td class="label" style="padding:14px 16px;background:#f7f9fc;color:#334155;width:45%;border-bottom:1px solid #edf2f7;">Room type(s)</td>
                        <td class="value" style="padding:14px 16px;text-align:right;color:#0f172a;font-weight:600;border-bottom:1px solid #edf2f7;">${escapeHtml(roomType || '-')}</td>
                      </tr>
                      <tr>
                        <td class="label" style="padding:14px 16px;background:#f7f9fc;color:#334155;width:45%;border-bottom:1px solid #edf2f7;">Guests</td>
                        <td class="value" style="padding:14px 16px;text-align:right;color:#0f172a;font-weight:600;border-bottom:1px solid #edf2f7;">${escapeHtml(guestLine)}</td>
                      </tr>
                      <tr>
                        <td class="label" style="padding:14px 16px;background:#f7f9fc;color:#334155;width:45%;border-bottom:1px solid #edf2f7;">Check-in</td>
                        <td class="value" style="padding:14px 16px;text-align:right;color:#0f172a;font-weight:600;border-bottom:1px solid #edf2f7;">${escapeHtml(checkin || '-')}</td>
                      </tr>
                      <tr>
                        <td class="label" style="padding:14px 16px;background:#f7f9fc;color:#334155;width:45%;border-bottom:1px solid #edf2f7;">Check-out</td>
                        <td class="value" style="padding:14px 16px;text-align:right;color:#0f172a;font-weight:600;border-bottom:1px solid #edf2f7;">${escapeHtml(checkout || '-')}</td>
                      </tr>
                      <tr>
                        <td class="label" style="padding:14px 16px;background:#f7f9fc;color:#334155;width:45%;">Nights</td>
                        <td class="value" style="padding:14px 16px;text-align:right;color:#0f172a;font-weight:600;">${escapeHtml(String(nightsNum) || '-')}</td>
                      </tr>
                    </table>
                  </div>

                  ${rowsHtml ? `
                    <div style="margin:22px 0 10px;">
                      <div style="font-family: Georgia, 'Times New Roman', Times, 'DejaVu Serif', 'Noto Serif', serif;font-weight:400;margin:0 0 8px;color:#c47676;">Rooms</div>
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


                  <!-- Next steps (unchanged) -->
                  <div style="margin:20px 0 0;padding:14px 16px;border:1px solid #e9eef5;border-radius:12px;background:#fafbfe;">
                    <div style="font-weight:700;color:#0f172a;margin-bottom:8px;">Next steps</div>
                    <ol style="margin:0;padding-left:18px;color:#374151;line-height:1.6;">
                      <li>Our team will review availability and get back to you shortly.</li>
                      <li>We may request additional details to finalise your reservation.</li>
                      <li>No payment has been taken at this stage.</li>
                    </ol>
                  </div>

                  <!-- Guest + message (unchanged) -->
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

                  <!-- Buttons: side-by-side on ALL devices -->
                  <table role="presentation" cellpadding="0" cellspacing="0" border="0" class="actions" style="margin:18px 0 8px;">
                    <tr>
                      <td align="left" style="padding:0;">
                        <a href="https://maps.app.goo.gl/qbPpfM9KXKvKtNpm8"
                          style="display:inline-block;background:#c47676;color:#000;text-decoration:none;padding:10px 16px;border-radius:8px;font-weight:600;white-space:nowrap;">
                          Directions
                        </a>
                      </td>
                      <td style="width:10px;">&nbsp;</td>
                      <td align="left" style="padding:0;">
                        <a href="tel:+302106198338"
                          style="display:inline-block;background:#eef2ff;color:#c47676;text-decoration:none;padding:10px 16px;border-radius:8px;font-weight:600;white-space:nowrap;">
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
                  © ${new Date().getFullYear()} ${HOTEL_NAME} · ${HOTEL_ADDR} · Ref ${requestId}
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

  /* ------------------ Compose & send the emails ------------------ */

  // Admin
  const adminMail = {
    from: `"${HOTEL_NAME} Website" <${EMAIL_USER}>`,
    replyTo: (name && email) ? `"${name}" <${email}>` : undefined,
    to: EMAIL_TO,
    subject: `Booking request ${requestId} - ${HOTEL_NAME}`,
    text: textSummary,
    html: renderHTML({
      heading: 'New booking request received',
      intro: 'A guest submitted a booking request through your website.',
      footer: 'Internal notification. Reply to the guest to confirm availability and finalise the booking.'
    }),
    attachments: [inlineLogo] // logo only (no ICS)
  };

  // Guest
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
    attachments: [inlineLogo] // logo only (no ICS)
  };

  try {
    await sendViaGraph({
      to: EMAIL_TO,
      subject: adminMail.subject,
      text: adminMail.text,
      html: adminMail.html,
      attachments: adminMail.attachments // [{ filename, path, cid }]
    });

    if (email) {
      await sendViaGraph({
        to: email,
        subject: guestMail.subject,
        text: guestMail.text,
        html: guestMail.html,
        attachments: guestMail.attachments
      });
    }

    return res.status(200).json({ message: 'Thank you! Your booking request has been submitted.' });
  } catch (err) {
    console.error('Mailer error:', err);
    return res.status(500).json({ message: 'Email failed to send. Please try again later.' });
  }
});

/* --------------------------- Health check ------------------------- */
app.get('/health', (_, res) => res.send('OK'));

/* ------------------------------ Start ----------------------------- */
app.listen(PORT, "0.0.0.0", () => console.log("Server has started on port " + PORT))



app.post('/contact', async (req, res) => {
  const { name, email, phone, message } = req.body || {};

  const HOTEL_NAME = 'Hotel Maroussi';
  const HOTEL_ADDR = 'Olympias 10, Maroussi, Athens, 15124, Greece';

  // Unique reference ID for tracking
  const requestId = `CT-${new Date().toISOString().slice(0,10).replace(/-/g,'')}-${String(Date.now()).slice(-5)}`;

  // Reuse your HTML renderer
  const renderHTML = ({ heading, intro, footer }) => `
    <div style="margin:0;padding:0;background:#f7f8fb;">
      <!-- Preheader -->
      <div style="display:none;max-height:0;overflow:hidden;opacity:0;">
        ${escapeHtml(heading)} — ${escapeHtml(intro)}
      </div>

      <table role="presentation" cellpadding="0" cellspacing="0" border="0" align="center" width="100%">
        <tr>
          <td align="center" style="padding:16px;">
            <table role="presentation" cellpadding="0" cellspacing="0" border="0" class="container" style="max-width:680px;width:100%;background:#fff;border-radius:16px;box-shadow:0 10px 28px rgba(0,0,0,0.07);overflow:hidden;">

              <!-- Header -->
              <tr>
                <td style="background:#c47676;color:#000;padding:22px 24px;">
                  <table role="presentation" cellpadding="0" cellspacing="0" border="0">
                    <tr>
                      <td style="vertical-align:middle;">
                        <img src="cid:alfa-logo" alt="Hotel Maroussi" width="45" height="45" style="display:block;border-radius:4px;">
                      </td>
                      <td style="vertical-align:middle;padding-left:10px;">
                        <div style="font-family: Georgia, 'Times New Roman', Times, 'DejaVu Serif', 'Noto Serif', serif; font-size:18px;font-weight:400;letter-spacing:.3px;">Hotel Maroussi</div>
                      </td>
                    </tr>
                  </table>
                </td>
              </tr>

              <!-- Body -->
              <tr>
                <td style="padding:28px 24px 18px;">
                  <div style="font-family: Georgia, 'Times New Roman', Times, 'DejaVu Serif', 'Noto Serif', serif; font-size:26px;color:#c47676;font-weight:700;margin:0 0 12px;">We received your message</div>
                  <div style="font-size:13px;color:#6b7280;letter-spacing:.4px;text-transform:uppercase;margin-bottom:16px;">
                    Reference: ${requestId}
                  </div>
                  <p style="margin:0 0 18px;color:#2b2f36;line-height:1.65;">
                    Hello ${escapeHtml(name || 'there')}, thank you for choosing ${HOTEL_NAME}.<br><br>
                    We have received your request and our team will be in touch shortly to confirm availability and finalise your reservation.
                  </p>

                  ${message ? `
                    <div style="margin:18px 0 0;color:#2b2f36;">
                      <div style="font-weight:600;margin-bottom:4px;">Your message</div>
                      <div style="white-space:pre-wrap;color:#2b2f36;">${escapeHtml(message)}</div>
                    </div>
                  ` : ''}

                  <div style="margin:22px 0 0;padding:14px 16px;border:1px solid #e9eef5;border-radius:12px;background:#fafbfe;color:#374151;font-size:14px;">
                    Our team will reply to <b>${escapeHtml(email || '')}</b> or call <b>${escapeHtml(phone || '')}</b> if needed.
                  </div>

                  <div style="margin:18px 0 0;color:#6b7280;font-size:12px;">${escapeHtml(footer)}</div>
                </td>
              </tr>

              <!-- Footer -->
              <tr>
                <td style="background:#f2f4f8;color:#6b7280;padding:14px 24px;font-size:12px;">
                  © ${new Date().getFullYear()} ${HOTEL_NAME} · ${HOTEL_ADDR} · Ref ${requestId}
                </td>
              </tr>
            </table>
          </td>
        </tr>
      </table>
    </div>
  `;

  // Plain text fallback
  const textMessage = `Hello ${name || 'there'},

Thank you for contacting ${HOTEL_NAME}.
We have received your message and our team will get back to you as soon as possible.

Your message:
${message || '-'}

Ref: ${requestId}
`;

  // Admin notification
  const adminMail = {
    from: `"${HOTEL_NAME} Website" <${EMAIL_USER}>`,
    replyTo: email ? `"${name}" <${email}>` : undefined,
    to: EMAIL_TO,
    subject: `New contact form message — ${HOTEL_NAME}`,
    text: textMessage,
    html: renderHTML({
      heading: 'New contact form submission',
      intro: 'A guest has sent you a message from the website contact form.',
      footer: 'Internal notification. Reply directly to the guest.'
    }),
    attachments: [inlineLogo]
  };

  // Guest confirmation
  const guestMail = {
    from: `"${HOTEL_NAME} Team" <${EMAIL_USER}>`,
    to: email,
    subject: `We received your message — ${HOTEL_NAME}`,
    text: textMessage,
    html: renderHTML({
      heading: 'We received your message',
      intro: `Hello ${name || 'there'}, thank you for choosing ${HOTEL_NAME}.<br><br>We have received your request and our team will be in touch shortly to confirm availability and finalise your reservation.`,
      footer: 'This is an automated confirmation that your message was received. Our team will contact you shortly.'
    }),
    attachments: [inlineLogo]
  };

  

  try {
    await sendViaGraph({
      to: EMAIL_TO,
      subject: adminMail.subject,
      text: adminMail.text,
      html: adminMail.html,
      attachments: adminMail.attachments // [{ filename, path, cid }]
    });

    if (email) {
      await sendViaGraph({
        to: email,
        subject: guestMail.subject,
        text: guestMail.text,
        html: guestMail.html,
        attachments: guestMail.attachments
      });
    }

    return res.status(200).json({ message: 'Thank you! Your message has been received.' });
  } catch (err) {
    console.error('Mailer error (contact):', err);
    return res.status(500).json({ message: 'Email failed to send. Please try again later.' });
  }
});
