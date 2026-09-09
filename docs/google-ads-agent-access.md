# Granting an agent access to Google Ads

## The short version

There is no way to add an AI agent as a user on a Google Ads account. Ads
permissions attach to a **Google account**, and an agent does not have one.
The Users tab under Admin → Access and security only accepts an email address.

Access is granted instead through the **Google Ads API**: the account owner
consents once in their own browser, and the resulting refresh token carries
whatever permissions that Google account already holds. The token *is* the
grant.

Two consequences worth understanding before starting:

- **The token inherits, it does not escalate.** Sign in as a read-only user and
  the agent is read-only. Sign in as an admin and the agent is an admin. This is
  the control surface, so use it.
- **Revocation is one click.** myaccount.google.com/permissions, remove the
  OAuth client. No password change, no effect on other users.

Never share a Google password or a 2FA code to accomplish this. Nothing in this
flow needs either, and a shared login defeats 2-Step Verification for everyone
on the account.

## What to collect

| Value | Where it comes from |
| --- | --- |
| `GOOGLE_ADS_DEVELOPER_TOKEN` | Your own manager account → Admin → API Center |
| `GOOGLE_ADS_CLIENT_ID` | Google Cloud Console → Credentials → OAuth client, type Desktop app |
| `GOOGLE_ADS_CLIENT_SECRET` | Same OAuth client |
| `GOOGLE_ADS_REFRESH_TOKEN` | `npm run ads:auth`, below |
| `GOOGLE_ADS_LOGIN_CUSTOMER_ID` | Your manager account ID, only if reaching the account through it |
| `GOOGLE_ADS_CUSTOMER_ID` | The advertising account, ten digits, shown under the avatar |

### 1. Your own manager account

The developer token comes from a manager account (MCC) that **you control**.
Manager accounts already linked to yours by third parties do not count and
cannot issue you a token.

Create one at `ads.google.com/home/tools/manager-accounts`. Use an email that is
not already the login for an existing Google Ads account, because Google rejects
manager signup on an email that is. Then link the advertising account from
inside the manager and approve the request from the advertising account.

### 2. Developer token

In the manager account: Admin → API Center → apply for **Basic access**.

Approval usually takes one to three business days. The token issued instantly
before approval is a **test token**, and it only works against test accounts. It
will authenticate successfully and then return zero rows for a live account,
which reads like a permissions bug and is not one.

### 3. OAuth client

Google Cloud Console, not Google Ads:

1. Create or pick a project.
2. APIs and Services → Library → enable **Google Ads API**.
3. Credentials → Create credentials → OAuth client ID → **Desktop app**.
4. Copy the client ID and client secret.

Desktop-app clients accept any `http://localhost` port, so the loopback script
below needs no redirect URI configured by hand.

### 4. Refresh token

Put the client ID and secret in `.env.agent-secrets` first, then:

```bash
npm run ads:auth
```

It prints a URL, waits on `http://localhost:8787`, and prints the refresh token
when you finish consenting. Sign in as the account whose access level you
intend to grant. Set `OAUTH_PORT` if 8787 is taken.

The token is printed locally and never transmitted anywhere. Paste it into
`.env.agent-secrets`, which `.gitignore` already covers via `.env*`.

### 5. Confirm

```bash
npm run ads:verify
```

Checks the three failure modes separately, because they look identical from the
Ads UI: token exchange, developer token, and which accounts the login actually
reaches. Zero reachable accounts means you consented as the wrong Google user.

## Reading the account

```bash
npm run ads:status
```

Lists every campaign with its status, serving status, and budget, then 30-day
spend. Read only.

It deliberately queries campaigns **without** a date segment. Adding one drops
campaigns that have never served, which are usually the ones being
investigated.

## Notes

- `GOOGLE_ADS_API_VERSION` defaults to `v21`. Google sunsets versions roughly
  every four months; a `NOT_FOUND` on the URL path means bump it in the env, not
  in code.
- A `login-customer-id` header is only required when the login reaches the
  account through a manager. Sending the wrong one is a common source of
  `USER_PERMISSION_DENIED`.
- `invalid_grant` on refresh means the token was revoked, expired, or was minted
  by a different OAuth client. Re-run `npm run ads:auth`.
