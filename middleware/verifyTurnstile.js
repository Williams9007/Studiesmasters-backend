const TURNSTILE_VERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";

/**
 * Verifies a Turnstile token before allowing a protected public request.
 * Tokens are single-use and must always be checked on the server.
 */
export async function verifyTurnstile(req, res, next) {
  const token = req.body?.cfTurnstileToken;
  const secret = process.env.TURNSTILE_SECRET;

  // Allow bypass in development when no token is provided (for local testing)
  if (process.env.NODE_ENV !== "production" && !token) {
    return next();
  }

  if (!token) {
    return res.status(400).json({ message: "Please complete the CAPTCHA verification." });
  }

  if (!secret) {
    console.error("TURNSTILE_SECRET is not configured.");
    return res.status(500).json({ message: "CAPTCHA verification is not configured." });
  }

  try {
    const formData = new URLSearchParams({ secret, response: token });
    const clientIp = req.ip;
    if (clientIp) formData.set("remoteip", clientIp);

    const verificationResponse = await fetch(TURNSTILE_VERIFY_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: formData,
    });
    const verification = await verificationResponse.json();

    if (!verification.success || verification.action !== "login") {
      console.warn("Turnstile verification rejected:", verification["error-codes"] || "unexpected action");
      return res.status(400).json({
        message: "CAPTCHA verification failed. Please try again.",
        code: "turnstile_failed",
      });
    }

    next();
  } catch (error) {
    console.error("Turnstile verification error:", error);
    return res.status(502).json({ message: "Unable to verify CAPTCHA. Please try again." });
  }
}
