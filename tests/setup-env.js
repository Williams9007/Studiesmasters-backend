// tests/setup-env.js
//
// Preload for tests that import route modules directly. Importing the route
// modules pulls in third-party SDK clients that are constructed at import time
// (e.g. the Resend mail client in message/sendWelcomeEmail.js), so a dummy key
// keeps module loading from throwing in CI/dev where no real key is present.
// Nothing here is ever used to make a network call.
process.env.RESEND_API_KEY ||= "test-key-not-used";

// Deterministic auth settings for the dashboard read API suite.
process.env.MOODLE_DASHBOARD_TOKEN ||= "test-moodle-dashboard-token-0123456789";
process.env.MOODLE_DASHBOARD_NONCE_STORE ||= "memory";
process.env.JWT_SECRET ||= "test-jwt-secret";