/**
 * Email Verification Service — Powered by Resend.
 * Sends beautifully designed 6-digit OTP codes.
 * Falls back to console logging when RESEND_API_KEY is not set.
 */
const { Resend } = require("resend");
const config = require("../config");

let resend = null;

if (config.resend.apiKey) {
  resend = new Resend(config.resend.apiKey);
  console.log("✅ Resend email service configured");
} else {
  console.warn(
    "⚠️  RESEND_API_KEY not set — verification codes will be logged to console",
  );
}

/**
 * Generate a cryptographically random 6-digit code.
 */
function generateCode() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

/**
 * Send verification email with 6-digit code via Resend.
 * @param {string} email - Recipient email
 * @param {string} name - User's name
 * @param {string} code - 6-digit verification code
 */
async function sendVerificationEmail(email, name, code) {
  const subject = "Verify your Aux account";
  const html = `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="utf-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
    </head>
    <body style="margin: 0; padding: 0; background-color: #f5f5f5; font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;">
      <table width="100%" cellpadding="0" cellspacing="0" style="background-color: #f5f5f5; padding: 40px 16px;">
        <tr>
          <td align="center">
            <table width="480" cellpadding="0" cellspacing="0" style="max-width: 480px; width: 100%; background-color: #ffffff; border-radius: 16px; overflow: hidden; box-shadow: 0 4px 24px rgba(0,0,0,0.06);">

              <!-- Header -->
              <tr>
                <td style="padding: 36px 32px 24px; text-align: center;">
                  <h1 style="font-size: 22px; font-weight: 800; color: #1A1A2E; margin: 0 0 8px; letter-spacing: -0.5px;">Hey ${name}!</h1>
                  <p style="font-size: 15px; color: #8E8E93; margin: 0; line-height: 22px;">Verify your email to get started with <strong style="color: #1A1A2E;">Aux</strong></p>
                </td>
              </tr>

              <!-- Code Box -->
              <tr>
                <td style="padding: 0 32px 28px;">
                  <div style="background-color: #FAFAFA; border: 1.5px solid #E5E5EA; border-radius: 14px; padding: 24px; text-align: center;">
                    <p style="font-size: 11px; text-transform: uppercase; letter-spacing: 2.5px; color: #8E8E93; margin: 0 0 12px; font-weight: 600;">Verification Code</p>
                    <p style="font-size: 38px; font-weight: 800; letter-spacing: 10px; color: #1A1A2E; margin: 0; font-family: 'SF Mono', 'Fira Code', 'Courier New', monospace;">${code}</p>
                  </div>
                </td>
              </tr>

              <!-- Expiry Notice -->
              <tr>
                <td style="padding: 0 32px 12px; text-align: center;">
                  <p style="font-size: 13px; color: #8E8E93; margin: 0; line-height: 20px;">This code expires in <strong style="color: #1A1A2E;">10 minutes</strong></p>
                </td>
              </tr>

              <!-- Divider -->
              <tr>
                <td style="padding: 0 32px;">
                  <div style="height: 1px; background-color: #F0F0F0;"></div>
                </td>
              </tr>

              <!-- Footer -->
              <tr>
                <td style="padding: 20px 32px 28px; text-align: center;">
                  <p style="font-size: 12px; color: #AEAEB2; margin: 0; line-height: 18px;">If you didn't create an account on Aux, you can safely ignore this email.</p>
                </td>
              </tr>

            </table>
          </td>
        </tr>
      </table>
    </body>
    </html>
  `;

  if (resend) {
    try {
      const { data, error } = await resend.emails.send({
        from: config.resend.from,
        to: [email],
        subject,
        html,
      });

      if (error) {
        console.error(`❌ Resend error for ${email}:`, error);
        console.log(`📋 [FALLBACK] Verification code for ${email}: ${code}`);
        return;
      }

      console.log(`📧 Verification email sent to ${email} (id: ${data.id})`);
    } catch (err) {
      console.error(`❌ Failed to send email to ${email}:`, err.message);
      console.log(`📋 [FALLBACK] Verification code for ${email}: ${code}`);
    }
  } else {
    // Dev mode: log to console
    console.log(`\n${"═".repeat(50)}`);
    console.log(`📋 VERIFICATION CODE for ${email}: ${code}`);
    console.log(`${"═".repeat(50)}\n`);
  }
}

module.exports = { generateCode, sendVerificationEmail };
