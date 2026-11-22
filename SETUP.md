# Finish the PULSE setup

The code is prepared locally. No cloud project was created, no paid resources were enabled,
and no deployment or database migration has been performed.

The frontend remains a static site. FastAPI runs on the existing Hugging Face Docker Space.
Supabase hosts email/password authentication, private named medical-history records, and saved conversations. Your PC is not
needed once the services are deployed.

## 1. Create a Supabase project

1. Sign in at <https://supabase.com/dashboard> and create a project on the **Free** plan.
2. Choose a region appropriate for your intended users and a strong database password.
3. Find the **project URL** and **publishable API key** in the Connect dialog / API settings.
   You need `https://YOUR_PROJECT.supabase.co` and a key beginning with `sb_publishable_`.
4. Open the project's SQL Editor. Paste and run `supabase/schema.sql` from this repository.
   It creates `medical_profiles`, validates history fields, and enables ownership policies.

**Expected SQL result:** usually `Success. No rows returned`. This is normal because the
script creates database objects without inserting or selecting rows. In Table Editor → public,
`medical_profiles` should have `user_id` (uuid), `history` (jsonb), and `updated_at` (timestamptz).
A fresh table has **zero rows**. To verify the security setup, run this separate read-only query:

```sql
select
    c.relrowsecurity as rls_enabled,
    (select count(*) from pg_policies
     where schemaname = 'public' and tablename = 'medical_profiles') as policy_count
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public' and c.relname = 'medical_profiles';
```

Expected output: **one row**, `rls_enabled = true` (or `t`), `policy_count = 4`.
If you already ran the schema successfully, switching login methods does **not** require a
new table or rerunning the migration. Password storage is handled by Supabase Auth.

The app intentionally uses a publishable key plus each user's access token, including from
the backend. **Do not use a Supabase secret key or service-role key in either configuration.**
A publishable key is public configuration; the ownership policies protect the medical records.
No Storage bucket or vector extension is required for this version.

### Upgrade: chat history and multiple medical records

After `schema.sql`, run **`supabase/chat_history_migration.sql`** in SQL Editor before deploying
the updated backend and frontend. A successful run normally says **Success. No rows returned**.
The migration is transactional and can be run again:

- Creates `medical_records` and `conversations`, each with RLS and four owner-only policies.
- Moves each existing single medical profile into a record named **Medical history**, preserving
  its contents. The duplicate legacy text is cleared after the copy succeeds. The old profile
  row is marked as migrated so rerunning SQL does not recreate records you deleted.
- Starts with an empty conversation list. Chats from the previous version existed only in
  browser memory and cannot be recovered after the page was closed.

Verify the new tables:

```sql
select c.relname as table_name, c.relrowsecurity as rls_enabled,
       (select count(*) from pg_policies p
        where p.schemaname = 'public' and p.tablename = c.relname) as policy_count
from pg_class c join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public' and c.relname in ('medical_records', 'conversations')
order by c.relname;
```

Expected: two rows, **conversations** and **medical_records**, both with **true** and **4**.
Keep existing provider keys and `AI_MODEL`; no additional service or key is required.

## 2. Enable email/password login

Google OAuth is no longer used. You do not need a Google Cloud project, OAuth client, or
Google client secret for this implementation.

1. In Supabase → **Authentication → Sign In / Providers → Email**, enable email sign-in
   and allow new user signups. Dashboard labels may vary slightly.
2. Keep **Confirm email** enabled for real users so they prove ownership of the address.
3. Under password/security settings, set the minimum password length to **12** to match
   PULSE's registration and reset forms. The provider remains the final authority on password
   requirements; already-existing accounts can still log in with their existing password.
4. In Authentication → **URL Configuration**, set **Site URL** to your actual frontend URL
   (for the current deployment, `https://pulse-med.vercel.app`).
5. Add these exact allowed redirect URLs for the environments you use:

   ```text
   https://pulse-med.vercel.app/
   https://pulse-med.vercel.app/?auth=recovery
   http://localhost:5500/
   http://localhost:5500/?auth=recovery
   http://127.0.0.1:5500/
   http://127.0.0.1:5500/?auth=recovery
   ```

   Replace the production domain if yours differs. If you use `/index.html`, add that exact
   path and its `?auth=recovery` version too. Open confirmation/reset links in the same browser
   and origin that requested them: PKCE relies on browser storage to complete the flow.

**Expected result:** the Email provider is enabled, site/redirect URLs are saved, and there
is no Google OAuth configuration needed by the application.

### Email delivery and the first test account

Supabase's built-in mailer is for limited testing. Its documentation currently restricts mail
to addresses belonging to the project's organization team and limits sending to 2 messages/hour.
It is not a general-purpose mail service for public signups.

For signup confirmation and password reset for other users, configure a custom SMTP provider
in Authentication → **Email / SMTP settings**. Enter the sender address, SMTP host, port,
username, and password obtained from your email provider. Keep SMTP credentials in Supabase.
Use the provider's verified sender/domain. Leave the standard confirmation/recovery templates
using `{{ .ConfirmationURL }}` unless you intentionally implement custom email templates.

To test login before SMTP is configured:

1. Go to **Authentication → Users → Add user → Create new user**.
2. Enter an email you control and a unique test password of at least 12 characters.
3. Use **Auto confirm user** if the dashboard offers it, or mark that test user's email
   confirmed through the dashboard. This is only for an account you intentionally create.
4. Once PULSE is configured/deployed, open **Log in / Create account** and log in with those details.

Expected result: Supabase's Users list contains the account; signing in opens the optional
history form. `medical_profiles` stays empty until you actually save that form.
Public signup confirmation and forgotten-password recovery still need working SMTP delivery.
Do not invite ordinary app users to your Supabase organization merely to receive test emails.

Supabase stores **salted bcrypt password hashes** in its managed Auth system. The
`auth.users.encrypted_password` column is named that for legacy reasons; its contents are a
hash, not reversible encryption. Do not create a password column in `medical_profiles` or
copy hashes/passwords into application configuration. PULSE sends credentials directly to
Supabase Auth over HTTPS; its FastAPI API and Groq never receive those credentials.

References:
- <https://supabase.com/docs/guides/auth/passwords>
- <https://supabase.com/docs/guides/auth/password-security>
- <https://supabase.com/docs/guides/auth/auth-smtp>

## 3. Set the frontend public configuration

Edit `frontend/config.js`:

```js
window.PULSE_CONFIG = Object.freeze({
    API_URL: "https://simonsimply-pulse.hf.space",
    SUPABASE_URL: "https://YOUR_PROJECT.supabase.co",
    SUPABASE_PUBLISHABLE_KEY: "sb_publishable_YOUR_KEY"
});
```

Use the same Supabase project in the backend and frontend. This file is served publicly.
User passwords, SMTP credentials, the Groq key, and the Pinecone key must never be placed here.

The first screen offers email/password login, account creation, and **Continue as guest**.
Until Supabase is configured, use the guest option. General chat still uses your existing
Groq/Pinecone backend, and the doctor directory works without login. Existing sessions enter
the app directly. Signing out returns to the account screen.

## 4. Configure the Hugging Face backend

In the existing Space's **Settings → Variables and secrets**, retain the existing Groq and
Pinecone secrets and add the following. `.env.example` documents every variable.

| Variable | Value |
| --- | --- |
| `GROQ_API_KEY` | Existing Groq key, as a secret |
| `PINECONE_API_KEY` | Existing Pinecone key, as a secret |
| `SUPABASE_URL` | Your project URL |
| `SUPABASE_PUBLISHABLE_KEY` | Your project's publishable key |
| `ALLOWED_ORIGINS` | Your exact frontend origin, e.g. `https://pulse-med.vercel.app` |
| `PINECONE_INDEX` | Optional; defaults to `pulse-medical-db` |
| `AI_MODEL` | `qwen/qwen3.8-27b`; shared by chat and photo transcription |
| `PHOTO_EXTRACTION_ENABLED` | Optional; defaults to `true`. Set `false` to disable photos. |

`ALLOWED_ORIGINS` is comma-separated, with no trailing slash on each origin. Include
`http://localhost:5500` and `http://127.0.0.1:5500` only if you want local frontend testing
against that backend. The existing MiniLM embeddings and Pinecone collection are unchanged.

## 5. Confirm shared Qwen model access

Both chat and photo transcription use **Qwen `qwen/qwen3.8-27b` on Groq**, through the
single `AI_MODEL` setting. Photo transcription remains a separate user action with consent
and review before saving. The model uses instruct mode with reasoning hidden from the UI.

1. Confirm that `qwen/qwen3.8-27b` is available in your Groq account. See
   <https://console.groq.com/docs/model/qwen/qwen3.8-27b>.
2. Set `AI_MODEL=qwen/qwen3.8-27b` in Hugging Face Settings. Remove old `CHAT_MODEL` and
   `VISION_MODEL` variables to avoid confusion; this version no longer reads them.
   No additional API key or separate vision service is required.
3. Rebuild/restart the Space to apply the code and configuration.

Set `PHOTO_EXTRACTION_ENABLED=false` to disable photos while keeping typed history usable.
Qwen is currently listed as a preview model by Groq. Confirm your account's model access and
quotas at <https://console.groq.com/settings/limits>; do not assume unlimited free usage.
Chat and image requests now use the same model's allowance. This code does not enable billing.

The flow is:

1. Sign in, open Medical history, and select a photo or use the mobile camera input.
2. Agree to send it to Groq, then choose **Extract text for review**.
3. Correct the returned text, especially drug names, doses, dates, units, and `[unclear]` portions.
4. Choose **Add reviewed text to notes** and then **Save history**.

The backend checks the image bytes (JPEG/PNG/WebP, up to 5 MB), strips image metadata, and
sends the normalized image to Groq. PULSE does not persist the original image in Supabase,
Pinecone, or the application filesystem. Upload libraries may temporarily buffer uploads.
Provider processing/retention is subject to Groq's own account settings and terms.
Only the text explicitly saved by the user goes into their history record.
This is transcription of written documents, not diagnosis from photographs, medical scans,
or X-rays. Unreadable handwriting may need manual correction. Upload one page/section at a time;
PDF and HEIC ingestion are not included.

## 6. Deploy and check the actual services

1. Deploy the updated repository to the **existing** HF Space using your normal deployment
   workflow. The Dockerfile now includes the new Python modules and fictional doctor data.
2. Deploy the `frontend/` directory to the existing Vercel project (no build command).
3. Check the Space's `/health` endpoint, then open the frontend over HTTPS.
4. Open **Log in / Create account**. Create an account, confirm the email if required,
   then log in. A user with no saved profile should see the optional history form.
   A manually created/confirmed test account can log in immediately.
5. Save a test profile using invented data, refresh, and confirm it persists.
6. Enable **Use saved history for replies and doctor matches** in the sidebar to share that history with Groq for personalization. The chat footer shows whether history is enabled.
   Choose the main record in the sidebar first. Each chat remembers the selected record and
   sharing preference. Changing either affects future replies and preserves existing messages;
   previously discussed details can remain in the conversation. Start a new chat for a clean context. Editing/deleting history and switching accounts reset chat too.
7. Try the fictional directory filters, then describe a current symptom such as “I have a headache”. Chat should proactively show relevant profiles without requiring a doctor request. With consented history, matching includes that context and prioritizes the current message. Follow-up details can use symptoms from earlier user turns; assistant messages do not supply patient history.
   Matches come from `data/doctors.json`; they cannot be booked and are not clinical referrals.
8. If enabled, test photo extraction with a **synthetic** written report. Confirm that
   extraction alone does not save history, then review and save the text explicitly.
9. Use two separate email/password accounts/browser profiles with different invented histories.
   Verify each sees only its own history. Anonymous access to `/medical-records` and `/conversations` should return 401. Test that neither account can fetch, edit, or delete the other account's record/chat IDs.
   Delete one profile and confirm the other account's data remains.

10. Sign out, try an incorrect password, and confirm that access is denied. Test **Forgot
    password?** with working SMTP, open the email link in the same browser, set a new password,
    sign out, and confirm that the new password logs in.

The automated checks mock cloud calls. Hosted email confirmation/recovery, Supabase policies
on the project, the current Pinecone index, and live vision inference must be verified after setup.

## Local development and tests

Use Python 3.11+ (the Docker image uses Python 3.11):

```bash
python -m venv .venv
source .venv/bin/activate
pip install -r requirements-dev.txt
cp .env.example .env
# Fill in your values. Set frontend/config.js API_URL to http://localhost:7860.
uvicorn main:app --host 0.0.0.0 --port 7860 --reload
```

Open `http://localhost:7860/` to use the frontend served by FastAPI. If you use this origin
for email confirmation/recovery, add `http://localhost:7860/` and
`http://localhost:7860/?auth=recovery` to Supabase's allowed redirects. Alternatively,
serve `frontend/` separately on port 5500, matching the default local CORS/redirect examples.
Do not open the HTML using a `file://` URL.

```bash
python -m pytest -q
node --check frontend/app.js
node --test tests/frontend.test.cjs
```

## What this version stores

- **Supabase:** private named medical-history records and conversation messages, short titles, doctor-match references, selected record IDs, and sharing preferences. Supabase Auth manages identity and salted password hashes. No application password column is added.
- **Browser:** login session tokens managed by Supabase, plus conversation/history form state in memory.
  Signed-in chats are saved to Supabase automatically. Guest chats are memory-only and disappear
  after refresh or account changes. PULSE does not write medical-history content to localStorage.
- **Repository:** 20 fictional doctor resumes and filterable attributes in `data/doctors.json`.
- **Pinecone:** the existing medical reference collection; personal history is not embedded or indexed.
- **Groq:** chat context (including history only when opted in), and photos only when extraction is requested.

For a real patient-data launch, assess the hosting/provider agreements and privacy requirements
for your deployment. This prepared implementation is a demo, not a certification of compliance.

## Conversation and record acceptance checks

1. Create two named histories (typed or photo transcription with review), with different conditions.
2. Start a chat, select the first record, explicitly enable sharing, and send a symptom message.
   Its short title should appear in Chat history and the footer should name the active record.
3. Start a new chat. It begins with no record selected and sharing off. Select the second record.
4. Refresh the page and reopen both chats. Each should restore its messages, doctor cards, and its
   own main-history selection. Changing a selection must not remove existing messages.
5. Delete a chat through its × button; medical records should remain. Delete a history record;
   its chats should remain but must stop using the deleted history. Old messages may retain
   details previously discussed from that record.
6. Simulate a failed save: the sidebar should report **Chat not saved** with Retry saving chat.
   Switching/new-chat navigation should preserve unsaved messages until saving succeeds. If
   another tab has updated a chat, use **Save as a separate chat** to keep your local version.
7. With two accounts, verify title lists, messages, and histories stay separate. A delayed response
   from a signed-out account must not restore the old account's data. Guest chats should reopen
   during the same visit but disappear after refreshing.

Optional local database verification uses PGlite (PostgreSQL in WASM), without live Supabase:

```bash
npm --prefix /tmp/pulse-sql-check install --no-audit --no-fund @electric-sql/pglite
PULSE_PGLITE_MODULE=/tmp/pulse-sql-check/node_modules/@electric-sql/pglite node --test tests/storage.integration.cjs
```

This executes both SQL files and checks migration idempotency, owner isolation, anonymous
access denial, cross-account record-link rejection, and record deletion. Live Supabase Auth
and cloud deployment still need the acceptance checks above.

The optional DOM integration test uses the actual HTML and JavaScript with mocked HTTP/Auth:

```bash
npm --prefix /tmp/pulse-sql-check install --no-audit --no-fund jsdom
PULSE_JSDOM_MODULE=/tmp/pulse-sql-check/node_modules/jsdom node --test tests/dom.integration.cjs
```

This checks form controls, multiple record creation, per-chat selection restoration, and deletion
using the page markup. It does not replace browser visual QA or live cloud checks.

## Enable optional web search and page reading

1. In the same Supabase project, run `supabase/web_tools_migration.sql` after the two earlier SQL
   files. Expect **Success. No rows returned**. It adds the saved `web_enabled` preference and
   private quota-counter tables plus a restricted budget RPC. Re-running preserves settings
   and counters. Browser users cannot read or reset those counters directly.
2. No search account or search API key is required. Docker installs the pinned DDGS result parser
   and defusedxml alongside the existing dependencies. Your existing Groq key is still required
   for Qwen. Public search availability remains subject to service policies and blocking.
3. Hugging Face Space → **Settings → Variables and secrets**:
   - Add **Variable** `WEB_TOOLS_ENABLED=true`.
   - Remove `BRAVE_SEARCH_API_KEY` if you previously added it; it is no longer read.
   - Retain `GROQ_API_KEY`, `AI_MODEL=qwen/qwen3.8-27b`, and the existing settings.
4. Deploy the updated Docker backend and Vercel frontend. The Dockerfile now includes
   `web_policy.py`, `web_tools.py`, `web_agent.py`, `clinical_safety.py`; requirements include
   dnspython, ddgs==9.16.1, and defusedxml.
5. Check `/web/status`: `available` should be true. This reports the enabled feature flag, not
   live search reachability or remaining quota. Test an approved search/read to verify those.
6. Sign in, enable **Use web search for this chat**, and enter generic public terms such as
   **migraine**. Do not paste the patient narrative. Check the approval
   box and send the actual question in the main composer. Only the approved public terms,
   with fixed source-domain filters for DuckDuckGo, are sent to search; the model cannot change
   them. If DuckDuckGo is unavailable or yields no approved results, the same approved terms are
   sent once to MedlinePlus health-topic search. The notice labels that narrower fallback scope.
7. The answer should show source IDs such as `[W1]` with safe links, publisher hostname,
   retrieval time, and publication date if supplied by the page. Uncited pages are labeled
   **Consulted; not cited**. Reopen the chat to verify source metadata and the web toggle restore;
   public query terms and per-turn approval should be blank again.
8. Repeat with web mode off: no search tools or search-service calls should be made. A
   disabled feature, unavailable budget RPC, exhausted quota, blocked service/page, or tool failure
   should produce an honest status and preserve ordinary chat when its providers are available.
9. Set `WEB_TOOLS_ENABLED=false` to disable new web requests. Existing saved source links remain.

### Web boundaries and checks

- Read tools accept only IDs returned by this turn's approved search, never model-provided URLs.
- Public DNS answers are checked, including every redirect, and the TCP destination is pinned
  to an approved public IP while TLS validates the original host. Environment proxies, cookies,
  and private-network/metadata destinations are excluded. Direct outbound DNS/HTTPS is required.
- The reader checks robots.txt, fails closed on unknown/error access policy, skips publishers
  requiring crawl-delay/request-rate scheduling, and respects explicit noai page/header tags.
  It does not execute JavaScript or bypass authentication/paywalls. This does not establish a
  license to republish a publisher's material; review access/usage terms for deployment.
- HTML scripts/navigation/hidden subtrees are excluded with bounded parsing. Retrieved text
  remains untrusted; no parser can guarantee that every malicious instruction is removed.
  The dispatcher still cannot run code, send messages, or search with a different query.
- Query approval is explicit because a simple filter cannot reliably recognize all personal
  names. Medical-history sharing with Groq does not grant permission to send that history to
  search. No query text, page bodies, or unrestricted tool traces are saved in database counters.
- The SQL function enforces UTC fixed-window caps: account 5/minute and 50/day; project
  30/minute and 500/day. Each web-enabled turn reserves budget even if Qwen elects not to search
  or the page is blocked. Changing these caps requires reviewing/editing the SQL function.
- Web operations have a 60-second budget and at most two tool rounds plus a final response.
  Each model call uses at most 20 seconds with retries disabled. The ordinary fallback path
  has its own provider latency; this is not a total end-to-end 60-second response guarantee.
- Basic explicit urgent-symptom phrases bypass search and model work. This is not validated
  medical triage and must never be interpreted as ruling out an emergency when no phrase matches.
  Background guidance: https://www.nhs.uk/symptoms/headaches/ and
  https://www.nhs.uk/symptoms/shortness-of-breath/ and
  https://www.nhs.uk/conditions/stroke/symptoms/ .

Run safety tests without live credentials:

```bash
python -m pytest -q
node --test tests/frontend.test.cjs
PULSE_PGLITE_MODULE=/tmp/pulse-sql-check/node_modules/@electric-sql/pglite node --test tests/web_storage.integration.cjs
```

The tests exercise URL/DNS/redirect policy, exact-query consent, private-network rejection,
TLS pinning, size/encoding/parser limits, tool budgets, citations, fallback, account cleanup,
and real PostgreSQL quota isolation. Complete live Qwen function calling still needs the configured
account acceptance check. A keyless search and page-read smoke check can run without model
credentials; it verifies discovery/reading, not medical correctness or the hosted account's quotas.

Assistant Markdown rendering also forbids remote image/media/style resources and removes model-supplied hyperlinks. Only server-validated source-panel links navigate outward, preventing unapproved tracking URLs from being loaded as answer images.

### Keyless provider migration and operational notes

If you have already applied `web_tools_migration.sql`, keep it: provider credentials were never
stored in that schema and the provider switch does not need a new SQL migration. If the file
has not been run yet, run it before deploying. Keep `WEB_TOOLS_ENABLED=true` on the Space and
retain the existing Groq/Pinecone/Supabase settings. There is no search secret to create.

The search adapter makes one bounded DuckDuckGo request, using DDGS only to parse its HTML.
PULSE's transport still handles DNS validation/IP pinning, TLS, byte/time caps, no proxies,
no cookies, and redirect rejection. It never enables DDGS auto-selection or its separate HTTP
client. A single fallback uses the official MedlinePlus public health-topic XML service:
https://medlineplus.gov/about/developers/webservices/ . Responses are parsed with defusedxml;
DTD/entity-bearing XML is rejected. Discovery does not treat search snippets as medical evidence.

The two-service search stage has a maximum 20-second deadline within the existing web-turn
budget. It does not retry a blocked engine or solve CAPTCHAs. All existing record privacy,
per-turn approval, source restrictions, quota counters, page-reader rules, and citation checks
remain active. A saved notice explicitly names MedlinePlus.gov when the narrower health-topic
index was used. Use short English topic terms; these terms are sent unchanged to the fallback.

PULSE's project cap of 30 web turns/minute is below MedlinePlus's documented 85 requests/minute
per IP, but unrelated applications sharing a hosting IP can still affect availability. Check the
linked service policy for changes. No unlimited availability or permanent free-host uptime is
promised. If search is unavailable, the ordinary Groq/Pinecone chat path remains available.
