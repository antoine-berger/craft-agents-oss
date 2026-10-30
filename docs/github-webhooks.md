# GitHub webhooks

The headless server accepts repository and organization webhooks at **`POST /webhooks/github`** on its existing RPC HTTP(S) port. It works with WebUI enabled or disabled. It is disabled until both settings below are configured; publishing or installing the release alone does not activate it.

## Configure the server when ready to activate

Set these in the server's existing environment file, then activate them during an authorized restart:

```dotenv
CRAFT_GITHUB_WEBHOOK_SECRET=<dedicated random secret of at least 32 characters>
CRAFT_GITHUB_WEBHOOK_REPOSITORIES=your-org/*,your-user/your-repo
```

Use `openssl rand -hex 32` to generate the secret. Entries are comma-separated, case-insensitive `owner/repo` or `owner/*`. Only GitHub.com is supported by this receiver. A shared secret can serve multiple authorized repo/org hooks. Existing GitHub credentials are still used for reads; webhook payloads never supply credentials or API hosts.

Expose **only this exact endpoint** through a public HTTPS reverse proxy. GitHub cannot reach a private `10.x` address. For example, inside an existing Nginx TLS server, proxy the path to the actual internal Craft RPC address:

```nginx
location = /webhooks/github {
    limit_except POST { deny all; }
    client_max_body_size 2m;
    client_body_timeout 10s;
    proxy_connect_timeout 5s;
    proxy_read_timeout 10s;
    proxy_set_header Upgrade "";
    proxy_set_header Connection "";
    proxy_pass http://127.0.0.1:9100;
}
```

Do not expose the RPC, WebUI, health or other paths through this public hostname. Keep HTTPS certificate verification enabled in GitHub.

## Configure GitHub

Open **repository → Settings → Webhooks**, or **organization → Settings → Webhooks**, and add:

- Payload URL: `https://YOUR-PUBLIC-HOST/webhooks/github`
- Content type: `application/json`
- Secret: the exact value of `CRAFT_GITHUB_WEBHOOK_SECRET`
- Individual events: **Pull requests**, **Pull request reviews**, **Pull request review comments**, **Pull request review threads**, **Issue comments**, **Check runs**, **Check suites**, **Statuses**, **Pushes** (where available for the webhook type).
- Active: enabled.

Pull-request events include queue enqueue/dequeue changes. The receiver also understands `merge_group` if used through a GitHub App; that event is not available for ordinary repo/org hooks. Creating a repository hook requires owner/admin access; creating an organization hook requires organization-owner access.

## Delivery, recovery and limits

- A signed ping returns `200 Pong`, including an organization ping with no repository.
- Actual changes return `202 accepted` after the compact invalidation is persisted, then update only tracked PRs through the existing WebSocket notifications. The receiver itself does not create sessions, send prompts, run commands or perform GitHub writes. Existing explicitly enabled auto-fix subscriptions react to the refreshed state just as they do after polling.
- Duplicate delivery IDs return `200 duplicate`, including after a receiver restart. Pending deliveries survive restart and are coalesced per repository. At most 512 pending deliveries and 4096 completed IDs are retained, with a 2 MiB inbox limit. Older completed IDs may be processed again safely as read-only invalidations.
- Inbox: `~/.craft-agent/github-webhooks/inbox.json` (or under the configured Craft configuration directory). It contains delivery IDs and PR/ref/SHA coordinates only. Do not remove it while the server is running.
- Bodies are capped at 2 MiB and reception at 10 seconds. Oversized requests return `413`; bad signatures `401`; unauthorized repos `403`; malformed payloads `400`; disk-full/inbox-full errors `503`. No successful ACK is sent for a change that cannot be persisted.
- Quota, `Retry-After` and network-error backoff remain in force. Deferred changes are retried. Active PRs in configured repositories reconcile every five minutes instead of polling the open chat every five seconds; repositories outside the configured scopes retain their existing cadence. Terminal PRs retain their existing stop-polling behavior. Startup/reconnect/manual synchronization remains available.
- GitHub does not automatically retry failed deliveries. Inspect **Recent deliveries** and redeliver after correcting the cause. The reconciliation fallback covers missed events, including large payloads that cannot be delivered.
- Search server logs for `[github-webhook]` to see accepted, processed, deferred or failed deliveries. Raw payloads and secrets are not logged.

## Verification

After authorized activation, use GitHub's initial ping, then an actual PR/review/CI change in a tracked repository. Check the GitHub delivery response, server log and Craft row/header together. Automated tests cover the real local HTTP receiver → durable inbox → real PR registry → real WebSocket client; upstream GitHub is simulated. They do not prove public DNS/TLS routing or install/configure a live GitHub webhook.

References: [creating webhooks](https://docs.github.com/en/webhooks/using-webhooks/creating-webhooks), [signature verification](https://docs.github.com/en/webhooks/using-webhooks/validating-webhook-deliveries), [events and availability](https://docs.github.com/en/webhooks/webhook-events-and-payloads), [failed deliveries](https://docs.github.com/en/webhooks/using-webhooks/handling-failed-webhook-deliveries).
