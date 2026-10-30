import { z } from "zod";
import { envelopeAddress, isEhloName } from "./channels/mailer.ts";

// Every message here is the text after `channel "<id>": `; config.ts adds the prefix.
// Messages never hold the input value, so a secret cannot leak through an error.

function isHttpUrl(url: string): boolean {
  try {
    const protocol = new URL(url).protocol;
    return protocol === "http:" || protocol === "https:";
  } catch {
    // An unparseable URL is simply not an HTTP URL.
    return false;
  }
}

const isSingleLine = (text: string): boolean => !/[\r\n]/.test(text);

const checkList = (key: string): z.ZodOptional<z.ZodArray<z.ZodString>> => {
  const message = `${key} must be an array of strings`;
  return z.array(z.string(message), message).optional();
};

const httpUrl = (message: string): z.ZodString => z.string(message).refine(isHttpUrl, message);

const secretRef = (key: string): z.ZodOptional<z.ZodString> =>
  z
    .string(`${key} must be a non-empty string`)
    .min(1, `${key} must be a non-empty string`)
    .optional();

const address = (key: string): z.ZodString =>
  z
    .string(`${key} must be a single-line address`)
    .refine((v) => v.trim() !== "" && isSingleLine(v), `${key} must be a single-line address`)
    .refine(
      (v) => /^[^\s<>@]+@[^\s<>@]+$/.test(envelopeAddress(v)),
      `${key} must hold an email address`,
    );

const baseShape = {
  id: z.string(),
  checks: checkList("checks"),
  excludeChecks: checkList("excludeChecks"),
  remindEverySeconds: z
    .number("remindEverySeconds must be an integer of at least 60")
    .int("remindEverySeconds must be an integer of at least 60")
    .min(60, "remindEverySeconds must be an integer of at least 60")
    .optional(),
};

const messageShape = {
  statusUrl: httpUrl("statusUrl must be a valid http(s) url").optional(),
  hideReason: z.boolean("hideReason must be true or false").optional(),
};

const chatShape = {
  ...baseShape,
  urlEnv: secretRef("urlEnv"),
  urlFile: secretRef("urlFile"),
  ...messageShape,
};

const webhookSchema = z.strictObject({
  ...baseShape,
  type: z.literal("webhook"),
  url: httpUrl("webhook needs a valid http(s) url"),
  secretEnv: secretRef("secretEnv"),
  secretFile: secretRef("secretFile"),
});

const fileSchema = z.strictObject({
  ...baseShape,
  type: z.literal("file"),
  path: z.string("file channel needs a path").min(1, "file channel needs a path"),
});

const slackSchema = z.strictObject({ ...chatShape, type: z.literal("slack") });
const teamsSchema = z.strictObject({ ...chatShape, type: z.literal("teams") });

const smtpSchema = z.strictObject(
  {
    host: z
      .string("smtp.host must be a host name")
      .refine((v) => v !== "" && !/\s/.test(v), "smtp.host must be a host name"),
    port: z
      .number("smtp.port must be an integer from 1 to 65535")
      .int("smtp.port must be an integer from 1 to 65535")
      .min(1, "smtp.port must be an integer from 1 to 65535")
      .max(65535, "smtp.port must be an integer from 1 to 65535"),
    tls: z
      .enum(["starttls", "tls", "none"], 'smtp.tls must be "starttls", "tls" or "none"')
      .default("starttls"),
    username: z
      .string("smtp.username must be a single-line string")
      .refine((v) => v !== "" && isSingleLine(v), "smtp.username must be a single-line string")
      .optional(),
    passwordEnv: secretRef("passwordEnv"),
    passwordFile: secretRef("passwordFile"),
    clientName: z
      .string("smtp.clientName must be a host name or an address literal")
      .refine(isEhloName, "smtp.clientName must be a host name or an address literal")
      .optional(),
  },
  "smtp must be an object",
);

const emailSchema = z.strictObject({
  ...baseShape,
  type: z.literal("email"),
  smtp: smtpSchema,
  from: address("from"),
  to: z
    .array(address("to"), "to must be a non-empty array of addresses")
    .min(1, "to must be a non-empty array of addresses"),
  subjectPrefix: z
    .string("subjectPrefix must be a single-line string")
    .refine(isSingleLine, "subjectPrefix must be a single-line string")
    .optional(),
  ...messageShape,
});

export type RawChannel =
  | z.output<typeof webhookSchema>
  | z.output<typeof fileSchema>
  | z.output<typeof slackSchema>
  | z.output<typeof teamsSchema>
  | z.output<typeof emailSchema>;

/** The schema for one channel type, or `undefined` for an unknown type. */
export function channelSchema(type: unknown): z.ZodType<RawChannel> | undefined {
  switch (type) {
    case "webhook":
      return webhookSchema;
    case "file":
      return fileSchema;
    case "slack":
      return slackSchema;
    case "teams":
      return teamsSchema;
    case "email":
      return emailSchema;
    default:
      return undefined;
  }
}
