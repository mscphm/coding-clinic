/*!
 * MScPHMxAI Coding Clinic — config.js
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
 * You build the flows by following flows/FLOW_GUIDE.md. Four of them start with
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
 *   MSG_URL    <- the "[clinic]_msg_api" flow (actions: messages.*, attach.*)
 *                 OPTIONAL — see the note below.
 *
 * The scheduled clean-up flow and the reminders flow have no URL — they run on a
 * timer, so there is nothing to paste for either of them.
 *
 * Keep the quotes. Keep the commas. The URL is one single line, however long it is.
 * The URL contains a signature (`sig=`) that acts as a password for the flow, which
 * is why every request also carries a session token — see PRIVACY.md.
 *
 *
 * MSG_URL IS OPTIONAL, AND THE SITE IS DESIGNED TO RUN WITHOUT IT
 *
 * Direct messages and pasted screenshots live in their own flow, [clinic]_msg_api,
 * on purpose: chat is polled every 90 seconds and each pasted image costs a whole
 * round trip, so putting them in the App flow would let a busy afternoon of chat
 * slow down — or throttle — signing in and reading the board. They get their own
 * flow and therefore their own URL.
 *
 * While MSG_URL is still the PASTE_ placeholder below:
 *   - the site works completely normally; nothing is broken and nothing errors;
 *   - the Messages tab does not appear in the header at all;
 *   - pasting an image into a composer does nothing (as it does in any plain
 *     textarea), and says so once;
 *   - NO network request is ever made for chat. Not one. The site does not "try
 *     and fail" — it does not try.
 *
 * So it is perfectly fine to go live with the first three URLs and paste this one
 * weeks later, or never. Leave the line exactly as it is until the msg flow exists.
 * Do not delete the line: removing the key is the same as leaving the placeholder,
 * but a future you looking for it will wonder whether it was ever there.
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
  // Filled in and switched to live on 2026-08-07; all three flows are imported,
  // turned on, and end-to-end tested against the NUS tenant.
  MOCK: false,

  // [clinic]_auth_api      — auth.request_code / auth.verify / auth.passcode
  AUTH_URL: "https://default5ba5ef5e31094e7785bdcfeb0d347e.82.environment.api.powerplatform.com:443/powerautomate/automations/direct/cu/09/workflows/5948934a937b4b0f9c32392b4f8a3ea6/triggers/manual/paths/invoke?api-version=1&sp=%2Ftriggers%2Fmanual%2Frun&sv=1.0&sig=ae1c1tTYwt7Y-qAg5AnPjJMIr8V9-lNOwp-_vvnGsY4",

  // [clinic]_app_api       — meta.* / threads.* / posts.* / votes.* / profile.* / slots.*
  APP_URL: "https://default5ba5ef5e31094e7785bdcfeb0d347e.82.environment.api.powerplatform.com:443/powerautomate/automations/direct/cu/07/workflows/fc77eaf2de17410c8108b5776a94333b/triggers/manual/paths/invoke?api-version=1&sp=%2Ftriggers%2Fmanual%2Frun&sv=1.0&sig=2rwC7H8dZGjYN2noUgpBd09Dzkh0NRVleFaQcnmIG9g",

  // [clinic]_admin_api     — admin.*
  ADMIN_URL: "https://default5ba5ef5e31094e7785bdcfeb0d347e.82.environment.api.powerplatform.com:443/powerautomate/automations/direct/cu/01/workflows/3ebe116ae0ec4843b6517a7de26ba78c/triggers/manual/paths/invoke?api-version=1&sp=%2Ftriggers%2Fmanual%2Frun&sv=1.0&sig=kEYxpJDTaMkgSeFvoL0kkhKfaOEGkOpJQG3N98bpuWw",

  // [clinic]_msg_api       — messages.* / attach.*   OPTIONAL: while this still
  // says PASTE_, direct messages and image paste stay hidden and no request for
  // them is ever made. Everything else on the site works. See the long note above.
  MSG_URL: "https://default5ba5ef5e31094e7785bdcfeb0d347e.82.environment.api.powerplatform.com:443/powerautomate/automations/direct/cu/27/workflows/efe01a7677e14e3f83fe15fe4cd789b0/triggers/manual/paths/invoke?api-version=1&sp=%2Ftriggers%2Fmanual%2Frun&sv=1.0&sig=Ccryw0TeOt16nEIdwiNNcaD_aBJnHUzI26bGKuV-Z_4"

};

/* ---------------------------------------------------------------------------
 * Below this line is plumbing — no need to touch it.
 * `Clinic.config` is an alias so page code can read settings off the one global
 * namespace (see SPEC.md §3) without caring which file defined them.
 * ------------------------------------------------------------------------- */
window.Clinic = window.Clinic || {};
window.Clinic.config = window.CLINIC_CONFIG;
