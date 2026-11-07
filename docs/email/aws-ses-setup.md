# CarbonWMS Email — Amazon SES set-up (one time)

CarbonCast → Email sends through Amazon SES (owner, 2026-11-07). These are the
one-time steps outside CarbonWMS. Everything else (domain, tracking, event
webhook) is done by the **Set up Amazon SES** button in Email → Settings.

## 1. AWS account + region

Sign in at <https://console.aws.amazon.com> (or create an account). Use region
**US East (N. Virginia) — us-east-1** for everything below.

## 2. A key for CarbonWMS (IAM user)

IAM → Users → Create user `carbon-wms-email` (no console access) → Attach
policy directly → Create policy → JSON, paste, name it `carbon-wms-email`:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "SesSendAndSetUp",
      "Effect": "Allow",
      "Action": [
        "ses:SendEmail",
        "ses:GetAccount",
        "ses:GetEmailIdentity",
        "ses:CreateEmailIdentity",
        "ses:PutEmailIdentityMailFromAttributes",
        "ses:CreateConfigurationSet",
        "ses:GetConfigurationSet",
        "ses:GetConfigurationSetEventDestinations",
        "ses:CreateConfigurationSetEventDestination"
      ],
      "Resource": "*"
    },
    {
      "Sid": "SnsEventTopic",
      "Effect": "Allow",
      "Action": [
        "sns:CreateTopic",
        "sns:SetTopicAttributes",
        "sns:GetTopicAttributes",
        "sns:Subscribe",
        "sns:ListSubscriptionsByTopic"
      ],
      "Resource": "arn:aws:sns:us-east-1:*:carbon-email-events"
    }
  ]
}
```

Then the user → Security credentials → Create access key → "Application running
outside AWS". Copy both values.

## 3. Put the key on the server

Coolify → the **web** app (not the worker) → Environment variables:

```
AWS_SES_ACCESS_KEY_ID=...
AWS_SES_SECRET_ACCESS_KEY=...
AWS_SES_REGION=us-east-1
```

Redeploy the web app.

## 4. In CarbonWMS

Email → Settings → **Set up Amazon SES**. It creates:

- the sending domain `shopcarbon.com` for **vip@shopcarbon.com** (DKIM — new records that sit beside the existing Resend ones; nothing existing changes),
- the bounce domain `bounce.shopcarbon.com`,
- configuration set `carbon-marketing` (reputation metrics, bounce/complaint suppression, open/click tracking),
- SNS topic `carbon-email-events` → `https://wms.shopcarbon.com/api/public/email/sns` (confirmed automatically).

Settings then lists the **DNS records** to add at NameBright (3 × CNAME for
DKIM, 1 × MX + 1 × TXT for the bounce domain, and the DMARC TXT for
shopcarbon.com if it is missing). Verification usually takes 5–60 minutes.

## 5. Production access (leave the sandbox)

A new SES account can only send to verified addresses. SES → Account dashboard
→ **Request production access**: mail type *Marketing*, website
`https://shopcarbon.com`, and describe: past customers of our Orlando stores and
online shop, single-use discount codes, unsubscribe link in every email (one
click), bounces and complaints suppressed automatically, campaigns pause
themselves above 3% bounces. Approval usually comes within 24 hours.

Until then: SES → Verified identities → Create identity → Email address (the
owner's) to receive **test** emails.
