/** A URL without user info, query and fragment, safe for logs. Text that is no URL gives a marker. */
export function redactUrl(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    // Not a URL: never echo it, it may still hold a secret.
    return "<invalid url>";
  }
  parsed.username = "";
  parsed.password = "";
  parsed.search = "";
  parsed.hash = "";
  return parsed.toString();
}

/** Replaces every form of `url` that appears in `text` with its redacted form. */
export function redactInText(text: string, url: string): string {
  let out = text;
  const secrets = new Set<string>([url]);
  try {
    const parsed = new URL(url);
    secrets.add(parsed.href);
    if (parsed.username !== "" || parsed.password !== "") {
      secrets.add(`${parsed.username}:${parsed.password}`);
      secrets.add(parsed.password);
      secrets.add(decodeURIComponent(parsed.password));
    }
    if (parsed.search.length > 1) secrets.add(parsed.search.slice(1));
  } catch {
    // The raw string is still replaced below.
  }
  const marker = redactUrl(url);
  for (const secret of [...secrets].filter((s) => s !== "").sort((a, b) => b.length - a.length)) {
    out = out.replaceAll(secret, secret === url || secret.includes("/") ? marker : "***");
  }
  return out;
}
