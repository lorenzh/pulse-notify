# Webhook channel

```json
{
  "id": "ops-hook",
  "type": "webhook",
  "url": "https://example.com/hook",
  "secretEnv": "HOOK_SECRET"
}
```

- Sends a `POST` to `url` with the [payload](../channels.md#payload) as the JSON body.
- Headers: `content-type: application/json` and `idempotency-key: <key>`. Delivery is at least once, so use the key to drop duplicates.
- A 2xx status is success. Any other status, a redirect (not followed), a timeout or a network error is a failure that is retried. The error text holds the status only, never the URL.
- `url` stays inline. A `http:` URL to a host other than `127.0.0.1`/`localhost` is not rejected, but startup logs one warning that names the channel id.
- Reminders are off unless `remindEverySeconds` is set, because an old receiver may not know `"event": "reminder"`.

## Signing

Set one of `secretEnv` (environment variable name) or `secretFile` (file path) to sign requests. A file is read once at start and a trailing newline is removed. A missing or empty value stops startup.

With a secret, each request has:

- `X-Pulse-Signature: sha256=<hex>`, the HMAC-SHA256 of the **raw request body** with the secret as key.
- `X-Pulse-Timestamp: <unix seconds>`, the time of this attempt.

Without a secret neither header is sent and the request is the same as before.

Limits: the timestamp is **not** covered by the signature, so treat it as a hint only. Replay protection is the `Idempotency-Key` header: remember the keys you have processed.

Verify in Node:

```js
import { createHmac, timingSafeEqual } from "node:crypto";

export function isValidSignature(secret, rawBody, header) {
  const expected = Buffer.from(
    `sha256=${createHmac("sha256", secret).update(rawBody).digest("hex")}`,
  );
  const received = Buffer.from(header ?? "");
  return received.length === expected.length && timingSafeEqual(received, expected);
}
```

Pass the body exactly as received (a `Buffer` or the unparsed string), not re-serialized JSON.

## Sample

```text
POST /hook
idempotency-key: 12:opened
x-pulse-signature: sha256=3f1c...
x-pulse-timestamp: 1767268800

{"key":"12:opened","event":"opened","incidentId":12,"checkId":"example","checkName":"Example site","reason":"HTTP 503","time":"2026-01-01T12:00:00.000Z","timeMs":1767268800000,"openedMs":1767268800000}
```

`hideReason` and `statusUrl` do not apply to webhooks. The payload is always complete.
