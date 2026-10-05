# WAAI Publishing Hub

Private source repository for WAAI's Cloudflare publishing dashboard and public media host.

## Production
- Worker: `waai-publishing-hub`
- Public URL: `https://waai-publishing-hub.arsafiqri-ua03.workers.dev`
- Storage: Cloudflare Workers KV
- Current media limit: MP4 up to 25 MiB
- Admin actions are protected by a key; plaintext key is not committed.

## Capabilities
- Upload MP4 and obtain a public HTTPS URL.
- Store title, caption, status, platform, publish time, permalink, file size.
- Track views, reach, likes, saves, shares, comments.
- Serve MP4 with HTTP byte-range support for external consumers such as Meta.
- Responsive WAAI content dashboard.

## Architecture
```
Browser / publishing workflow
        |
        v
Cloudflare Worker (UI + API)
        |
        v
Workers KV
  |- media:<id>
  |- media-meta:<id>
  |- post:<timestamp>:<id>
  |- post-id:<id>
```

KV is the intentionally minimal v1 architecture. If the media library grows, move binary media to R2 while keeping the dashboard and metadata API stable.
