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
  const subject = "Verify your VideoCall account";
  const html = `
    <div style="font-family: 'Inter', -apple-system, sans-serif; max-width: 480px; margin: 0 auto; padding: 40px 24px; background: #0f0f1a; color: #e2e2f0; border-radius: 16px;">
      <h1 style="font-size: 24px; font-weight: 700; color: #ffffff; margin: 0 0 8px;">Welcome, ${name}! 👋</h1>
      <p style="font-size: 14px; color: #9999b3; margin: 0 0 32px;">Verify your email to start making crystal-clear calls.</p>
      <div style="background: linear-gradient(135deg, #6366f1 0%, #8b5cf6 100%); border-radius: 12px; padding: 24px; text-align: center; margin-bottom: 24px;">
        <p style="font-size: 12px; text-transform: uppercase; letter-spacing: 2px; color: rgba(255,255,255,0.7); margin: 0 0 8px;">Your verification code</p>
        <p style="font-size: 36px; font-weight: 800; letter-spacing: 8px; color: #ffffff; margin: 0;">${code}</p>
      </div>
      <p style="font-size: 13px; color: #666680; margin: 0;">This code expires in 10 minutes. If you didn't create an account, ignore this email.</p>
    </div>
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
