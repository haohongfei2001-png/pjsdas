# Supabase production database CA

Public certificate, not a credential. Downloaded over verified HTTPS from the production URL used by the official Supabase Dashboard:

- Official source at reviewed revision: https://github.com/supabase/supabase/blob/4ab54b935919ba3f4bb92f436ae4e757108e4f8a/apps/studio/hooks/custom-content/custom-content.json (`ssl:certificate_url`, production environment).
- Certificate: https://supabase-downloads.s3-ap-southeast-1.amazonaws.com/prod/ssl/prod-ca-2021.crt
- File SHA-256: `700723581420dd1ac98fd7e9ac529f0ef210eadcaf87fc868a3ad7d114c2f3b7`
- Certificate SHA-256 fingerprint: `807025AD50D4ED219D2C9C7D299C004F824EB00CF7F65AFEF607D07B72E6CAFA`

Used only by this project's isolated migration client; does not change OS/browser CA stores, server TLS settings, grants or passwords. Both CA and original database hostname are checked. No automatic certificate replacement or relaxed fallback.
