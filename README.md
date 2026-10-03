# ViewFirst

Direct landlord-to-tenant rentals with 360° virtual tours. Tenants tour every room in the browser (or a VR headset), message the landlord, and can only request a physical viewing after finishing the tour. Landlords get a "Verified landlord" badge after an admin reviews their ID and proof of ownership.

**Zero dependencies.** Node.js 22.5+ only (uses the built-in `node:sqlite`). No `npm install`, no build step.

## Run it

```bash
cp .env.example .env        # then edit ADMIN_PASSWORD at least
npm run seed                # optional: demo landlords, listings with 360° tours, reviews, comments
npm start                   # http://localhost:3000
```

Demo logins after seeding (password `demo-password-123`):

| Account | Email |
|---|---|
| Verified landlord (Lagos) | landlord@demo.local |
| Verified landlord (Abuja) | kola@demo.local |
| Landlord awaiting verification | pending@demo.local |
| Tenants | tenant@demo.local, chi@demo.local |
| Admin | `ADMIN_EMAIL` / `ADMIN_PASSWORD` from `.env` |

Tests: `npm test` (14 API tests: auth, verification gating, booking gating, privacy, reviews, comments, messaging, moderation, CSRF, upload validation).

## What is in it

- **Accounts**: tenant and landlord roles, scrypt password hashing, hashed session tokens in HttpOnly cookies, login rate limiting.
- **Landlord verification**: ID + proof of ownership (+ optional selfie) uploaded to a private folder, reviewed by an admin who approves or asks for changes with a reason. Only verified landlords can publish (toggle with `REQUIRE_VERIFICATION`).
- **Listings**: photos, price (per month or year), deposit, service charge, move-in total, amenities, rules, availability, map pin, 360° photo per room, optional video walkthrough.
- **Virtual tour**: Pannellum 360° viewer, room switcher, partial-panorama support, gyroscope on phones, A-Frame VR mode for headsets, video fallback. Photos are shrunk in the browser before upload to keep tours light.
- **Search**: text, city, type, beds, price range, furnished, amenities, verified-only, has-tour, sorting, pagination, and a map view with price pins.
- **Tour-before-visit rule**: the server records which rooms each tenant has viewed (2.5 s dwell) and refuses viewing requests until all are seen. Landlords publish time slots; tenants pick one; the landlord confirms or declines; confirmed viewings export to `.ics`.
- **Privacy by default**: public pages show only the area and a ~350 m circle. The exact address, pin and phone numbers are revealed after a viewing is confirmed.
- **Reviews**: one per tenant per listing, separate stars for the place and the landlord, "Visited" badge for tenants who booked a viewing here, landlord replies, aggregate on the landlord profile.
- **Comments**: public Q&A under every listing, threaded one level, landlord replies tagged, delete by author, landlord or admin.
- **Messaging**: one thread per tenant per listing, unread counters, polling every 5 s.
- **Also**: saved places, in-app notifications, landlord dashboard (views, saves, tour visitors, chats), reporting, admin console (verifications, reports, listings, users, suspend), accessibility basics, responsive layout.

## Configuration (`.env`)

See `.env.example`: `PORT`, `APP_NAME`, `CURRENCY`, `LOCALE`, map centre, `REQUIRE_VERIFICATION`, admin credentials, `COOKIE_SECURE`, `DATA_DIR`.

## Going to production

1. Put it behind HTTPS (Caddy, nginx, or your host's proxy) and set `COOKIE_SECURE=true`. The server reads `X-Forwarded-For` for rate limiting, so keep it behind a proxy you control.
2. Back up `DATA_DIR` (SQLite database, `uploads/`, and `private/` verification documents). Treat `private/` as sensitive personal data and check your local data-protection rules (for Nigeria, the NDPA).
3. Change the admin password before launch.

## Known limits (be aware before launch)

- **Needs internet for third-party libraries** loaded from CDNs: Pannellum, Leaflet and OpenStreetMap tiles, A-Frame (VR), Google Fonts. Offline, the app still works with fallbacks (still images, no map). Self-host these files if you need full offline operation.
- **VR headset mode has not been tested on real hardware.** The 360° viewer, rooms, booking and everything else were exercised in a headless browser, but A-Frame VR was not.
- Verification is manual and only as good as the admin reviewing it. It does not call any national ID API.
- Rate limiting is in memory (single process). SQLite and local-disk uploads mean one server, not a cluster.
- No email/SMS: notifications are in-app only. No payments by design.
- Uploaded images are not resized or re-encoded server-side (the browser shrinks them first). Add a CDN or image pipeline when traffic grows.

## Layout

```
server.js            HTTP server, security headers, static files, range requests
src/                 config, db schema, auth, http helpers
src/routes/          auth, uploads, listings, viewings, social (reviews/comments/messages/reports), admin
public/              single-page app (vanilla ES modules, no build)
scripts/seed.js      demo data
scripts/make_panoramas.py   regenerates the demo 360° rooms (needs pillow + numpy; output is already included)
test/api.test.js     API tests (node:test)
```
