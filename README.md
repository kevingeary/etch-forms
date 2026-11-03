# Etch Forms for Cloudflare

A private, self-hosted form delivery setup for agencies that build sites with Etch. It runs in your Cloudflare account and keeps each client's submissions in a separate D1 database.

You deploy two small Workers:

1. **Etch Mailer** sends email for every client site. Deploy this once per agency account.
2. **Etch Forms** receives one client's form submissions. Deploy a new copy for each client site.

No Cloudflare account is connected to this repository. The buttons copy the selected folder into your own Git provider and deploy it to your own Cloudflare account.

## Before you start

You need:

- A Cloudflare account
- A domain using Cloudflare DNS that you can send email from
- A GitHub or GitLab account for the copy Cloudflare creates
- The client's site domain and destination email address

Cloudflare Email Sending requires one manual domain-verification step. Do that first so your test message can be delivered.

### Verify your sending domain

1. Open the [Cloudflare dashboard](https://dash.cloudflare.com/).
2. Go to **Compute**, then **Email Service**, then **Email Sending**.
3. Choose **Onboard Domain**.
4. Select your agency's sending domain and accept the DNS records Cloudflare offers to add.
5. Wait until Cloudflare shows the domain as ready. This is often quick, but DNS can take up to 24 hours.

The mailer sends from `forms@your-sending-domain.com`. That mailbox does not need to exist. Replies go to the person who filled in the form.

## Step 1: deploy the shared mailer

[![Deploy Etch Mailer to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/kevingeary/etch-forms/tree/main/mailer)

Cloudflare will show a setup page. Use these values:

| Prompt | What to enter |
| --- | --- |
| Worker name | Keep `etch-mailer`. Every forms Worker looks for this exact name. |
| `SENDING_DOMAIN` | The domain you verified above, such as `agency.com`. Do not include `https://` or an email address. |
| Email binding | Keep the binding named `EMAIL`. |

Finish the deployment before continuing. The mailer has no public sending endpoint. Other Workers in your account can call its `send()` method through a Cloudflare service binding.

## Step 2: deploy a forms Worker for the client

[![Deploy Etch Forms to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/kevingeary/etch-forms/tree/main/forms)

Use these values on Cloudflare's setup page:

| Prompt | What to enter |
| --- | --- |
| Worker name | A unique name such as `forms-acme`. |
| `SITE_NAME` | A friendly name used in email subjects, such as `Acme Dental`. |
| `SITE_DOMAIN` | The live website domain, such as `acmedental.com`. You may also enter a full origin such as `https://www.acmedental.com`. |
| `RECIPIENT_EMAIL` | The address that should receive submissions. |
| D1 database name | Replace `client-site` with `client-` plus a short client name, such as `client-acme`. |

Keep these generated binding names unchanged:

- D1 binding: `DB`
- Service binding: `MAILER`, connected to `etch-mailer`
- Rate limiter binding: `BURST_LIMITER`

Cloudflare creates the D1 database. The deploy command then applies the included schema before it deploys the Worker. No database IDs or secrets are needed.

When deployment finishes, open the Worker's `workers.dev` URL. The page shows:

- A green health status
- The exact `/api/contact` action URL
- A copy button
- The field names to use in Etch

## Connect the Etch form

On the client's Etch form:

1. Set the form action to the URL shown on the Worker's home page.
2. Set the method to `POST`.
3. Use `name`, `email`, and `message` for the required field names.
4. You can also add `phone` and `company`.
5. Add a hidden field named `website` with an empty value. This is the spam honeypot.
6. Publish the site and send a test submission.

The endpoint accepts normal form posts, multipart form posts, and JSON. Successful requests return JSON containing `{"ok":true}` and a submission ID.

Only the configured site origin is allowed. If the site uses both `www` and the bare domain, edit `SITE_DOMAIN` under the forms Worker's **Settings > Variables and Secrets** and enter both origins separated by a comma. For example:

```text
https://example.com,https://www.example.com
```

## Add a second client site

Keep the existing `etch-mailer`. Click the **Deploy Etch Forms to Cloudflare** button again and use:

- A new Worker name
- The second client's site name, domain, and recipient
- A new D1 database name such as `client-secondclient`

Each forms Worker gets its own database and configuration while all of them use the one private mailer.

## Built-in protection

The forms Worker includes:

- Exact origin checks and CORS headers
- A hidden-field honeypot
- A Cloudflare burst limit of 3 attempts per minute
- A D1-backed limit of 5 valid submissions per IP hash per hour
- Field length and email validation
- An optional Turnstile check
- A submission record and mail-delivery log in D1

No IP salt is requested. The Worker hashes the IP together with the site origin before storing it, so separate client databases do not use the same hash. Raw IP addresses are never written to D1.

Turnstile is off by default. Advanced users can add a secret named `TURNSTILE_SECRET` in the forms Worker's **Settings > Variables and Secrets**, then add a Turnstile widget to the form. Do not add the secret unless the form sends a `cf-turnstile-response` value.

## Troubleshooting

### The forms Worker will not deploy

Deploy `etch-mailer` first and keep that exact Worker name. Cloudflare cannot create a service binding to a Worker that does not exist.

If the D1 migration fails, confirm the database binding is named `DB` and rerun the deployment from **Workers & Pages > your Worker > Builds**.

### The form says "Origin not allowed"

Check `SITE_DOMAIN` in the forms Worker's variables. The browser origin must match exactly, including `www`. Add both origins as a comma-separated list if the site uses both.

### The submission is saved but email is not delivered

Check all three items:

1. The sending domain is ready under **Email Service > Email Sending**.
2. `SENDING_DOMAIN` on `etch-mailer` contains only the domain.
3. The forms Worker service binding points to `etch-mailer`.

Then inspect the forms Worker's logs and the `mail_log` table. Cloudflare errors such as `E_SENDER_NOT_VERIFIED` identify an incomplete sending-domain setup.

### The form receives a 429 response

The same visitor sent too many requests. The burst limiter resets after one minute. The hourly limit allows five valid submissions from one IP hash.

### The home page works but the Etch form does not

Confirm the action ends in `/api/contact`, the method is `POST`, and the fields are named `name`, `email`, and `message`. The message must contain at least 10 characters.

## For developers

The two folders are intentionally self-contained because Cloudflare treats a button's repository subfolder as the root of a new repository.

```text
mailer/  Shared private WorkerEntrypoint and Email Sending binding
forms/   Per-client form Worker, D1 migration, landing page, and tests
```

Run checks in each folder:

```sh
npm install
npm run typecheck
npm run lint
npm test
```

The forms test exercises a complete accepted submission with an in-memory D1 stand-in and a stubbed mailer. Nothing in the test sends email or connects to a Cloudflare account.

## Cloudflare button limitations

Cloudflare's button flow cannot derive the D1 name from `SITE_NAME`, so the installer must change the suggested `client-site` name to `client-<slug>`. It also cannot discover which shared Worker should receive the service binding, so this template uses the fixed name `etch-mailer`.

The buttons create two separate repositories and Workers Builds projects in the installer's Git account. This is how Cloudflare currently handles Worker subfolders in a monorepo.

References:

- [Deploy to Cloudflare buttons](https://developers.cloudflare.com/workers/platform/deploy-buttons/)
- [Cloudflare Email Sending setup](https://developers.cloudflare.com/email-service/get-started/send-emails/)
- [Cloudflare service bindings](https://developers.cloudflare.com/workers/runtime-apis/bindings/service-bindings/)
