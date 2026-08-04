/*!
 * NUS Coding Clinic — config.js
 * -----------------------------------------------------------------------------
 * THIS IS THE ONLY FILE YOU NEED TO EDIT TO GO LIVE.
 *
 * Everything else in assets/js/ is machinery. This file holds the three Power
 * Automate flow URLs and one switch. Edit it in Notepad, VS Code, or straight in
 * GitHub's web editor — it is plain text.
 * -----------------------------------------------------------------------------
 *
 * WHAT TO PASTE, AND WHERE TO GET IT
 *
 * You build four flows by following flows/FLOW_GUIDE.md. Three of them start with
 * the trigger "When an HTTP request is received". After you save each of those
 * flows for the first time, Power Automate fills in the trigger's
 * "HTTP POST URL" box — a very long https://prod-XX.westus.logic.azure.com/...
 * address ending in "&sig=...". Click the copy icon next to it and paste the whole
 * thing, unchanged, between the quotes below.
 *
 *   AUTH_URL   <- the "Clinic Auth" flow      (actions: auth.request_code,
 *                                              auth.verify, auth.passcode)
 *   APP_URL    <- the "Clinic App" flow       (actions: meta.*, threads.*, posts.*,
 *                                              votes.*, profile.*, slots.*)
 *   ADMIN_URL  <- the "Clinic Admin" flow     (actions: admin.*)
 *
 * The fourth flow (the daily scheduled clean-up) has no URL — nothing to paste.
 *
 * Keep the quotes. Keep the commas. The URL is one single line, however long it is.
 * The URL contains a signature (`sig=`) that acts as a password for the flow, which
 * is why every request also carries a session token — see PRIVACY.md.
 *
 *
 * THE MOCK SWITCH
 *
 *   MOCK: true   — demo mode. No network calls at all. The site runs entirely on
 *                  seeded data in the browser (assets/js/mock-data.js): eight
 *                  discussions, a leaderboard, clinic slots, an admin dashboard.
 *                  Sign in with ANY email address; the code is always 000000.
 *                  Use this to show the site to someone before any flow exists.
 *
 *   MOCK: false  — live mode. Every action goes to the flow URLs above.
 *
 * AT GO-LIVE: paste the three URLs, then change `MOCK: true` to `MOCK: false` on
 * the line below, commit, and push. That is the whole switch-over. To go back to
 * demo mode (e.g. to show a colleague), flip it to `true` again — the flow URLs can
 * stay where they are, they are simply ignored while MOCK is true.
 *
 * Demo data lives only in the visitor's own browser. Clearing it: open the site,
 * press F12, and run  Clinic.mock.reset()  in the Console.
 */

window.CLINIC_CONFIG = {

  // true = demo mode (no backend needed). false = talk to the flows below.
  MOCK: true,

  // Paste the "HTTP POST URL" of the Clinic Auth flow here:
  AUTH_URL: "PASTE_AUTH_FLOW_URL",

  // Paste the "HTTP POST URL" of the Clinic App flow here:
  APP_URL: "PASTE_APP_FLOW_URL",

  // Paste the "HTTP POST URL" of the Clinic Admin flow here:
  ADMIN_URL: "PASTE_ADMIN_FLOW_URL"

};

/* ---------------------------------------------------------------------------
 * Below this line is plumbing — no need to touch it.
 * `Clinic.config` is an alias so page code can read settings off the one global
 * namespace (see SPEC.md §3) without caring which file defined them.
 * ------------------------------------------------------------------------- */
window.Clinic = window.Clinic || {};
window.Clinic.config = window.CLINIC_CONFIG;
