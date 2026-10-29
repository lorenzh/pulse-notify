import { createHmac } from "node:crypto";

/** Value of `X-Pulse-Signature`: `sha256=<hex HMAC-SHA256(secret, body)>` over the raw body. */
export function signBody(secret: string, body: string): string {
  return `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
}
