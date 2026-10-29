export interface DecodedMail {
  headers: Record<string, string>;
  body: string;
}

function decodeWord(charset: string, enc: string, text: string): string {
  const bytes =
    enc.toUpperCase() === "B"
      ? Buffer.from(text, "base64")
      : Buffer.from(
          text
            .replaceAll("_", " ")
            .replaceAll(/=([0-9A-Fa-f]{2})/g, (_m, h: string) =>
              String.fromCharCode(Number.parseInt(h, 16)),
            ),
          "latin1",
        );
  return new TextDecoder(charset).decode(bytes);
}

/** Decodes RFC 2047 encoded words; whitespace between two words is dropped. */
export function decodeHeader(value: string): string {
  const joined = value.replaceAll(/(\?=)\s+(=\?)/g, "$1$2");
  return joined.replaceAll(
    /=\?([^?]+)\?([BbQq])\?([^?]*)\?=/g,
    (_m, c: string, e: string, t: string) => decodeWord(c, e, t),
  );
}

function decodeQuotedPrintable(text: string): string {
  const bytes = text
    .replaceAll(/=\r?\n/g, "")
    .replaceAll(/=([0-9A-Fa-f]{2})/g, (_m, h: string) =>
      String.fromCharCode(Number.parseInt(h, 16)),
    );
  return Buffer.from(bytes, "latin1").toString("utf8");
}

/** Splits a raw message into unfolded headers (names lower case) and a decoded body. */
export function decodeMail(raw: string): DecodedMail {
  const split = raw.indexOf("\r\n\r\n");
  const head = split < 0 ? raw : raw.slice(0, split);
  const rawBody = split < 0 ? "" : raw.slice(split + 4);
  const headers: Record<string, string> = {};
  for (const line of head.replaceAll(/\r\n[ \t]+/g, " ").split("\r\n")) {
    const colon = line.indexOf(":");
    if (colon > 0) headers[line.slice(0, colon).toLowerCase()] = line.slice(colon + 1).trim();
  }
  const encoding = (headers["content-transfer-encoding"] ?? "7bit").toLowerCase();
  let body = rawBody;
  if (encoding === "base64") body = Buffer.from(rawBody, "base64").toString("utf8");
  else if (encoding === "quoted-printable") body = decodeQuotedPrintable(rawBody);
  return { headers, body: body.replaceAll("\r\n", "\n") };
}
