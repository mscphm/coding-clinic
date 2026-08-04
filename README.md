# Coding Clinic

A question-and-answer forum and clinic booking system for programming support on the MSc in
Precision Health and Medicine × Artificial Intelligence.

**Live site:** https://mscphm.github.io/coding-clinic/login.html

## What it does

- **Discussions** — a GitHub Discussions-style forum: threads with markdown and
  syntax-highlighted code, nested replies, upvotes, accepted answers, categories and labels,
  full-text search, and a Top Contributors leaderboard.
- **Ask anonymously** — any question or reply can be posted anonymously. Classmates see
  "Anonymous"; the real identity is available only to the instructor, and only in the
  admin export.
- **Clinic booking** — weekly 20-minute slots. Booking requires linking one of your own
  threads, so every live session starts from a written problem statement.
- **Instructor dashboard** — moderation, attendance and outcome tracking, activity charts,
  and CSV exports for teaching records.

## How to use it (students)

1. Sign in with your NUS email address. You will be emailed a 6-digit code.
2. Choose a display name — this is what classmates see.
3. Post your question **before** booking a clinic slot. Include what you tried and the exact
   error message.
4. Book a slot only if the thread does not resolve it.

Concepts, error messages and debugging are all fair game. Do not post assignment solution
code.

## Technical notes

This repository contains **only the application shell** — HTML, CSS and JavaScript. It holds
no forum content and no personal data. Everything is fetched at runtime through an
authenticated API (Power Automate flows) backed by a workbook that stays inside the
instructor's institutional OneDrive. Without a valid session token, the API returns nothing.

Built with vanilla HTML/CSS/JavaScript — no framework, no build step. Third-party libraries
(marked, DOMPurify, highlight.js) are vendored in `assets/vendor/`.

To run it locally against seeded demo data, set `MOCK: true` in `assets/js/config.js` and
serve the folder over HTTP.
