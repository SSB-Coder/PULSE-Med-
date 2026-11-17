# Finish the PULSE setup

The code is prepared locally. No cloud project was created, no paid resources were enabled,
and no deployment or database migration has been performed.

The frontend remains a static site. FastAPI runs on the existing Hugging Face Docker Space.
Supabase hosts email/password authentication and one private medical-history record per user. Your PC is not
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
| `CHAT_MODEL` | Optional; defaults to `openai/gpt-oss-120b` |
| `VISION_MODEL` | `qwen/qwen3.8-27b` (also the code default) |

`ALLOWED_ORIGINS` is comma-separated, with no trailing slash on each origin. Include
`http://localhost:5500` and `http://127.0.0.1:5500` only if you want local frontend testing
against that backend. The existing MiniLM embeddings and Pinecone collection are unchanged.

## 5. Confirm Qwen photo-to-text access

GPT-OSS is text-only. Photo transcription uses **Qwen `qwen/qwen3.8-27b` on Groq**;
GPT-OSS receives the saved, reviewed text when the user enables history in chat.

1. Confirm that `qwen/qwen3.8-27b` is available in your Groq account. It is listed in the
   current vision documentation at <https://console.groq.com/docs/vision>.
2. Set `VISION_MODEL=qwen/qwen3.8-27b` on the backend for explicit configuration, or leave
   the variable unset to use that default. If you previously set an empty value, replace it.
   No additional API key or separate vision service is required.
3. Rebuild/restart the Space to apply the code and configuration.

Setting `VISION_MODEL` explicitly blank disables extraction while keeping the typed form usable.
Groq currently lists Qwen and GPT-OSS on its Free plan; confirm your account's access and
limits at <https://console.groq.com/settings/limits>. Images consume the token allowance.
Stay on the Free plan for quota-limited free usage; this code does not enable a paid plan.

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
   Changing that toggle resets the current conversation so previously sent history isn't
   silently reused after opting out. Editing/deleting history and switching accounts reset chat too.
7. Try the fictional directory filters, then describe a current symptom such as “I have a headache”. Chat should proactively show relevant profiles without requiring a doctor request. With consented history, matching includes that context and prioritizes the current message. Follow-up details can use symptoms from earlier user turns; assistant messages do not supply patient history.
   Matches come from `data/doctors.json`; they cannot be booked and are not clinical referrals.
8. If enabled, test photo extraction with a **synthetic** written report. Confirm that
   extraction alone does not save history, then review and save the text explicitly.
9. Use two separate email/password accounts/browser profiles with different invented histories.
   Verify each sees only its own history. Anonymous access to `/profile` should return 401.
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

- **Supabase:** one medical-history JSON record per authenticated user; Supabase Auth manages identity
  and salted password hashes. No password column is added to the history table.
- **Browser:** login session tokens managed by Supabase, plus conversation/history form state in memory.
  PULSE does not write medical-history content to localStorage.
- **Repository:** 20 fictional doctor resumes and filterable attributes in `data/doctors.json`.
- **Pinecone:** the existing medical reference collection; personal history is not embedded or indexed.
- **Groq:** chat context (including history only when opted in), and photos only when extraction is requested.

For a real patient-data launch, assess the hosting/provider agreements and privacy requirements
for your deployment. This prepared implementation is a demo, not a certification of compliance.
