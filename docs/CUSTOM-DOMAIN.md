# Custom Domain Configuration

Once a custom domain is chosen, the app is ready to cut over with zero changes to the codebase. This runbook walks the operator through the process.

## Prerequisites

- A domain name registered and accessible (e.g., `example.com`)
- Vercel account with admin access to the project
- Supabase admin access
- Resend account (for email sending)
- OAuth provider accounts (Google, Meta, Zoom, Calendly) that need callback URL updates

## Step 1: Add the Domain to Vercel

In the Vercel dashboard:

1. Go to Settings → Domains
2. Click "Add Domain"
3. Enter the custom domain (e.g., `example.com`)
4. Vercel will prompt you to update DNS records

## Step 2: Configure DNS Records

Vercel provides specific guidance on DNS configuration. The exact records depend on whether your registrar supports ALIAS or CNAME:

- **If ALIAS is supported** (recommended): Add an ALIAS record pointing to Vercel's nameserver
- **If only CNAME is available**: Add a CNAME record pointing to `cname.vercel-dns.com` (or similar — Vercel's dashboard will specify)
- **www subdomain**: Add a CNAME record pointing to `{custom-domain}.cname.vercel-dns.com`

Certificate issuance is automatic; Vercel will provision a free TLS certificate via Let's Encrypt once DNS is configured.

Check DNS propagation (typically 5–30 minutes):
```bash
nslookup example.com
```

In Vercel, the domain status will show "Verified" once propagation is complete.

## Step 3: Set `APP_CANONICAL_HOST` in Vercel

Once the domain is verified in Vercel and DNS is live, set the `APP_CANONICAL_HOST` environment variable in Vercel's dashboard for **Production only** (not Preview or Development):

1. Go to Settings → Environment Variables
2. Add a new variable:
   - **Name**: `APP_CANONICAL_HOST`
   - **Value**: `example.com` (without `https://` or trailing slash)
   - **Scope**: Production

This enables the middleware to redirect any non-canonical request to the canonical domain (preserving path and query), and ensures email links, OAuth callbacks, and webhooks all resolve to the new domain.

## Step 4: Update Supabase OAuth Redirect URLs

Supabase Auth uses a redirect-URL allowlist. The couple portal and platform login both rely on this.

In the Supabase dashboard:

1. Go to Authentication → Providers → Email
2. Under "Redirect URLs", add the new domain URLs:
   - `https://example.com/auth/callback`
   - `https://example.com/couple/[slug]/auth/callback` (if couples use separate subdomains)
3. Save

If your setup uses subdomain-based couple portals:

1. Under "Redirect URLs", add:
   - `https://*.example.com/auth/callback` (wildcard for all subdomains)

## Step 5: Update OAuth Provider Callback URLs

Every external OAuth provider (Google, Meta, Zoom, Calendly) has a hardcoded allowlist of callback URLs. Update each:

### Google OAuth (Gmail)

1. Go to [Google Cloud Console](https://console.cloud.google.com/apis/credentials)
2. Select your project
3. Find your OAuth 2.0 client
4. Edit the client and update "Authorised redirect URIs":
   - Add: `https://example.com/api/auth/gmail/callback`
   - Remove the old Vercel preview URL (unless keeping it for testing)

### Meta (Instagram DMs)

1. Go to [Meta App Dashboard](https://developers.facebook.com/)
2. Select your app
3. Go to Settings → Basic
4. In "App Domains", add `example.com`
5. Go to Products → Instagram Messaging (or Webhooks)
6. Update the "Redirect URI" whitelist:
   - Add: `https://example.com/api/integrations/instagram/oauth/callback`
   - Add webhook URL: `https://example.com/api/webhooks/instagram`
7. Save

### Zoom

1. Go to [Zoom App Marketplace](https://marketplace.zoom.us/)
2. Select your OAuth app
3. Go to App Credentials
4. Update "Redirect URL for OAuth":
   - Change to: `https://example.com/api/auth/zoom/callback`
5. Save

### Calendly

1. Go to [Calendly Developer Portal](https://developer.calendly.com/)
2. Select your OAuth app
3. Update "Redirect URIs":
   - Add: `https://example.com/api/integrations/calendly/oauth/callback`
   - Remove the old preview URL (optional but recommended)
4. Save

## Step 6: Update Resend (Optional but Recommended)

If you're using Resend for transactional email, update the verified domain so couple invitations arrive as `noreply@example.com` instead of `hello@thebloomhouse.ai`:

1. Go to [Resend Dashboard](https://resend.com/domains)
2. Click "Add Domain"
3. Enter `example.com` (or a subdomain like `mail.example.com`)
4. Add the DNS records Resend provides
5. Wait for verification
6. Once verified, update `EMAIL_FROM` in your environment to use the new sender domain

(This is optional; the current setup uses The Bloom House's verified Resend domain and works fine.)

## Step 7: Deploy and Verify

1. Create a test deployment (optional, for verification):
   - Use Vercel's preview deployment to test the new domain before going live
2. Promote to production:
   - Merge your changes to the main branch and deploy to production
3. Monitor the deployment for errors

## Step 8: Cutover Verification Checklist

Once deployed, walk through this checklist to confirm everything works:

### Email Links
- [ ] Invite a test couple to the portal and open the email link
- [ ] Verify the link starts with `https://example.com`
- [ ] Click the link and confirm it works (lands on the registration page, not a redirect loop)

### OAuth Callbacks
- [ ] Test Gmail OAuth: Settings → Integrations → Connect Gmail
- [ ] Verify the redirect URL is correct (`https://example.com/api/auth/gmail/callback`)
- [ ] Confirm the token is saved and Gmail emails start ingesting

- [ ] Test Zoom: Settings → Integrations → Connect Zoom
- [ ] Verify the connection succeeds without redirect errors

- [ ] Test Meta (Instagram): Settings → Integrations → Connect Instagram
- [ ] Verify the redirect works and the connection is saved

### Couple Portal (if using subdomain routing)
- [ ] Navigate to a subdomain (e.g., `venue.example.com`)
- [ ] Confirm you're redirected to the couple login
- [ ] Log in and confirm the portal loads correctly

### Webhooks
- [ ] Check recent webhook logs in Supabase (if applicable)
- [ ] Verify no webhook delivery failures related to domain mismatches

### Monitoring
- [ ] Check the app's error logs (Supabase, Vercel) for auth/callback errors
- [ ] Confirm heat-map signals and email ingestion are working
- [ ] Test a full workflow: inquiry ingestion → signal firing → Sage response

## Rollback

If something breaks after domain cutover:

1. **Temporarily**: Revert `APP_CANONICAL_HOST` in Vercel (set to empty string)
2. **Wait for redeployment** to complete
3. **Diagnose**: Check logs and OAuth provider settings
4. **Fix**: Correct any configuration (usually a typo in a callback URL)
5. **Re-enable**: Set `APP_CANONICAL_HOST` again and redeploy

## Notes

- `APP_CANONICAL_HOST` is production-only; preview and development deployments ignore it
- Redirects are 308 (permanent redirect), which preserves HTTP method and body
- All internal app URLs (email links, Stripe checkout returns, etc.) automatically route through the canonical domain
- Preview deployments (`*.vercel.app` hosts where `VERCEL_ENV` is not `production`) are never redirected, so previews keep working after cutover. The production `*.vercel.app` alias does redirect to the canonical domain
