import { afterEach, describe, test } from "bun:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { StartupError } from "@lorenzh/pulse-kit";
import {
  loadSubscriptionSettings,
  type SubscriptionSettings,
  type SubscriptionsOn,
  subscriptionStorePath,
} from "../src/subscription-settings.ts";
import { tempDir } from "./subscriptions-support.ts";

const TOKEN = "t".repeat(32);
const KEY = "0123456789abcdef".repeat(4);

const files: Record<string, string> = {
  "/s/token": `${TOKEN}\n`,
  "/s/key": `${KEY}\n`,
  "/s/pw": "s3cret-pw\n",
  "/s/empty": "",
  "/s/two": "s3cret-pw\nsecond\n",
  "/s/key63": `${KEY.slice(1)}\n`,
  "/s/key65": `${KEY}a\n`,
  "/s/keyupper": `${KEY.toUpperCase()}\n`,
  "/s/shorttoken": `${"t".repeat(31)}\n`,
};

const readFile = (path: string): string => {
  const text = files[path];
  if (text === undefined) throw Object.assign(new Error("no file"), { code: "ENOENT" });
  return text;
};

const base: Record<string, string> = {
  PULSE_NOTIFY_SUBSCRIPTIONS: "on",
  PULSE_NOTIFY_SUBSCRIPTIONS_STATUS_URL: "https://status.example.com",
  PULSE_NOTIFY_SUBSCRIPTIONS_FROM: "status@example.com",
  PULSE_NOTIFY_SUBSCRIPTIONS_SMTP_HOST: "mailpit",
  PULSE_NOTIFY_SUBSCRIPTIONS_TOKEN_FILE: "/s/token",
  PULSE_NOTIFY_SUBSCRIPTIONS_KEY_FILE: "/s/key",
};

function load(
  extra: Record<string, string | undefined>,
  drop: string[] = [],
): SubscriptionSettings {
  const env: Record<string, string | undefined> = { ...base, ...extra };
  for (const name of drop) delete env[name];
  return loadSubscriptionSettings(env, { readFile });
}

function on(extra: Record<string, string | undefined>): SubscriptionsOn {
  const s = load(extra);
  assert.equal(s.isOn, true);
  if (!s.isOn) throw new Error("expected on");
  return s;
}

/** Asserts a startup error (exit 2) whose line starts with `setting`; returns the message. */
function refused(
  extra: Record<string, string | undefined>,
  setting: string,
  drop: string[] = [],
): string {
  let caught: unknown;
  try {
    load(extra, drop);
  } catch (err) {
    caught = err;
  }
  assert.ok(caught instanceof StartupError, `expected a StartupError naming ${setting}`);
  assert.equal(caught.setting, setting);
  assert.ok(caught.message.startsWith(`${setting}`), caught.message);
  assert.ok(!caught.message.includes("s3cret-pw"));
  assert.ok(!caught.message.includes(TOKEN));
  assert.ok(!caught.message.includes(KEY));
  return caught.message;
}

describe("defaults", () => {
  test("off when unset, and nothing else is read", () => {
    assert.deepEqual(loadSubscriptionSettings({}, { readFile }), { isOn: false });
    assert.deepEqual(
      loadSubscriptionSettings(
        { PULSE_NOTIFY_SUBSCRIPTIONS: "off", PULSE_NOTIFY_SUBSCRIPTIONS_MAX: "bad" },
        { readFile },
      ),
      { isOn: false },
    );
  });

  test("a mode other than on or off is refused", () => {
    refused({ PULSE_NOTIFY_SUBSCRIPTIONS: "yes" }, "PULSE_NOTIFY_SUBSCRIPTIONS");
  });

  test("every default of R3", () => {
    const s = on({ PULSE_NOTIFY_STATE: "/data/notify-state.json" });
    assert.equal(s.statusUrl, "https://status.example.com");
    assert.equal(s.subjectPrefix, "[status.example.com]");
    assert.deepEqual(s.smtp, { host: "mailpit", port: 587, tls: "starttls" });
    assert.equal(s.token, TOKEN);
    assert.equal(s.key, KEY);
    assert.equal(s.host, "127.0.0.1");
    assert.equal(s.port, 9300);
    assert.equal(s.statePath, "/data/notify-subscriptions.db");
    assert.equal(s.max, 10000);
    assert.equal(s.maxPending, 1000);
    assert.equal(s.confirmPerHour, 100);
    assert.equal(s.sendTimeoutMs, 5000);
  });

  test("explicit values", () => {
    const s = on({
      PULSE_NOTIFY_SUBSCRIPTIONS_SUBJECT_PREFIX: "[Acme]",
      PULSE_NOTIFY_SUBSCRIPTIONS_SMTP_PORT: "2525",
      PULSE_NOTIFY_SUBSCRIPTIONS_SMTP_TLS: "tls",
      PULSE_NOTIFY_SUBSCRIPTIONS_HOST: "0.0.0.0",
      PULSE_NOTIFY_SUBSCRIPTIONS_PORT: "9400",
      PULSE_NOTIFY_SUBSCRIPTIONS_STATE: "/x/subs.db",
      PULSE_NOTIFY_SUBSCRIPTIONS_MAX: "100000",
      PULSE_NOTIFY_SUBSCRIPTIONS_MAX_PENDING: "1",
      PULSE_NOTIFY_SUBSCRIPTIONS_CONFIRM_PER_HOUR: "10000",
    });
    assert.equal(s.subjectPrefix, "[Acme]");
    assert.deepEqual(s.smtp, { host: "mailpit", port: 2525, tls: "tls" });
    assert.equal(s.host, "0.0.0.0");
    assert.equal(s.port, 9400);
    assert.equal(s.statePath, "/x/subs.db");
    assert.equal(s.max, 100000);
    assert.equal(s.maxPending, 1);
    assert.equal(s.confirmPerHour, 10000);
  });

  test("the store path defaults beside the ledger, also without PULSE_NOTIFY_STATE", () => {
    assert.equal(subscriptionStorePath({}), "notify-subscriptions.db");
    assert.equal(
      subscriptionStorePath({ PULSE_NOTIFY_STATE: "/var/lib/notify/state.db" }),
      "/var/lib/notify/notify-subscriptions.db",
    );
  });

  test("the send timeout is min(PULSE_NOTIFY_TIMEOUT_MS, 60000)", () => {
    assert.equal(on({ PULSE_NOTIFY_TIMEOUT_MS: "1234" }).sendTimeoutMs, 1234);
    assert.equal(on({ PULSE_NOTIFY_TIMEOUT_MS: "60000" }).sendTimeoutMs, 60000);
    assert.equal(on({ PULSE_NOTIFY_TIMEOUT_MS: "120000" }).sendTimeoutMs, 60000);
  });
});

describe("required settings", () => {
  for (const name of [
    "PULSE_NOTIFY_SUBSCRIPTIONS_STATUS_URL",
    "PULSE_NOTIFY_SUBSCRIPTIONS_FROM",
    "PULSE_NOTIFY_SUBSCRIPTIONS_SMTP_HOST",
    "PULSE_NOTIFY_SUBSCRIPTIONS_TOKEN_FILE",
    "PULSE_NOTIFY_SUBSCRIPTIONS_KEY_FILE",
  ]) {
    test(`missing ${name} is refused`, () => {
      assert.equal(refused({}, name, [name]), `${name}: is required`);
    });
  }
});

describe("ranges", () => {
  const cases: [string, string][] = [
    ["PULSE_NOTIFY_SUBSCRIPTIONS_MAX", "0"],
    ["PULSE_NOTIFY_SUBSCRIPTIONS_MAX", "100001"],
    ["PULSE_NOTIFY_SUBSCRIPTIONS_MAX_PENDING", "0"],
    ["PULSE_NOTIFY_SUBSCRIPTIONS_CONFIRM_PER_HOUR", "0"],
    ["PULSE_NOTIFY_SUBSCRIPTIONS_CONFIRM_PER_HOUR", "10001"],
    ["PULSE_NOTIFY_SUBSCRIPTIONS_SMTP_PORT", "0"],
    ["PULSE_NOTIFY_SUBSCRIPTIONS_SMTP_PORT", "65536"],
    ["PULSE_NOTIFY_SUBSCRIPTIONS_SMTP_TLS", "ssl"],
    ["PULSE_NOTIFY_SUBSCRIPTIONS_PORT", "70000"],
    ["PULSE_NOTIFY_SUBSCRIPTIONS_SMTP_HOST", "mail pit"],
    ["PULSE_NOTIFY_SUBSCRIPTIONS_FROM", "not-an-address"],
    ["PULSE_NOTIFY_SUBSCRIPTIONS_FROM", "a@example.com\nBcc: b@example.com"],
    ["PULSE_NOTIFY_SUBSCRIPTIONS_SUBJECT_PREFIX", "x".repeat(65)],
    ["PULSE_NOTIFY_SUBSCRIPTIONS_SUBJECT_PREFIX", "[a]\n[b]"],
  ];
  for (const [name, value] of cases) {
    test(`${name}=${JSON.stringify(value)} is refused`, () => {
      const message = refused({ [name]: value }, name);
      // A number can occur in the range text; only text values are checked for an echo.
      if (!/^\d+$/.test(value)) assert.ok(!message.includes(value), "the value is not echoed");
    });
  }

  test("a prefix of 64 characters is accepted", () => {
    assert.equal(
      on({ PULSE_NOTIFY_SUBSCRIPTIONS_SUBJECT_PREFIX: "x".repeat(64) }).subjectPrefix.length,
      64,
    );
  });

  test("MAX=5 with MAX_PENDING unset (1000) is refused naming MAX_PENDING", () => {
    assert.equal(
      refused({ PULSE_NOTIFY_SUBSCRIPTIONS_MAX: "5" }, "PULSE_NOTIFY_SUBSCRIPTIONS_MAX_PENDING"),
      "PULSE_NOTIFY_SUBSCRIPTIONS_MAX_PENDING: must be at most PULSE_NOTIFY_SUBSCRIPTIONS_MAX",
    );
  });

  test("MAX=5 with MAX_PENDING=6 is refused naming MAX_PENDING", () => {
    refused(
      { PULSE_NOTIFY_SUBSCRIPTIONS_MAX: "5", PULSE_NOTIFY_SUBSCRIPTIONS_MAX_PENDING: "6" },
      "PULSE_NOTIFY_SUBSCRIPTIONS_MAX_PENDING",
    );
  });

  test("MAX=5 with MAX_PENDING=5 is accepted", () => {
    const s = on({
      PULSE_NOTIFY_SUBSCRIPTIONS_MAX: "5",
      PULSE_NOTIFY_SUBSCRIPTIONS_MAX_PENDING: "5",
    });
    assert.equal(s.max, 5);
    assert.equal(s.maxPending, 5);
  });
});

describe("token and key files", () => {
  const key = "PULSE_NOTIFY_SUBSCRIPTIONS_KEY_FILE";
  for (const file of ["/s/key63", "/s/key65", "/s/keyupper"]) {
    test(`key file ${file} is refused`, () => {
      assert.equal(
        refused({ [key]: file }, key),
        `${key}: must hold exactly 64 lowercase hex characters`,
      );
    });
  }

  test("a token of 31 characters is refused", () => {
    refused(
      { PULSE_NOTIFY_SUBSCRIPTIONS_TOKEN_FILE: "/s/shorttoken" },
      "PULSE_NOTIFY_SUBSCRIPTIONS_TOKEN_FILE",
    );
  });

  test("an unreadable token file is refused", () => {
    refused(
      { PULSE_NOTIFY_SUBSCRIPTIONS_TOKEN_FILE: "/s/missing" },
      "PULSE_NOTIFY_SUBSCRIPTIONS_TOKEN_FILE",
    );
  });
});

describe("SMTP login", () => {
  const user = "PULSE_NOTIFY_SUBSCRIPTIONS_SMTP_USERNAME";
  const file = "PULSE_NOTIFY_SUBSCRIPTIONS_SMTP_PASSWORD_FILE";

  test("a password file without a username is refused", () => {
    refused({ [file]: "/s/pw" }, file);
  });

  test("a username without a password file is refused", () => {
    refused({ [user]: "mailer" }, file);
  });

  test("a username with TLS none and a remote host is refused", () => {
    refused(
      { [user]: "mailer", [file]: "/s/pw", PULSE_NOTIFY_SUBSCRIPTIONS_SMTP_TLS: "none" },
      "PULSE_NOTIFY_SUBSCRIPTIONS_SMTP_TLS",
    );
  });

  test("a username with TLS none and a loopback host is accepted", () => {
    const s = on({
      [user]: "mailer",
      [file]: "/s/pw",
      PULSE_NOTIFY_SUBSCRIPTIONS_SMTP_TLS: "none",
      PULSE_NOTIFY_SUBSCRIPTIONS_SMTP_HOST: "127.0.0.1",
    });
    const { password, ...rest } = s.smtp;
    assert.deepEqual(rest, { host: "127.0.0.1", port: 587, tls: "none", username: "mailer" });
    assert.equal(password, "s3cret-pw");
  });

  test("the password file is trimmed", () => {
    assert.equal(on({ [user]: "mailer", [file]: "/s/pw" }).smtp.password, "s3cret-pw");
  });

  for (const bad of ["/s/empty", "/s/two"]) {
    test(`password file ${bad} is refused without its content`, () => {
      const message = refused({ [user]: "mailer", [file]: bad }, file);
      assert.ok(!message.includes("second"));
    });
  }
});

describe("root hosting (R9)", () => {
  const name = "PULSE_NOTIFY_SUBSCRIPTIONS_STATUS_URL";
  const line = `${name}: must be an origin without a path (root hosting)`;

  test("an origin is accepted, with or without a trailing slash", () => {
    assert.equal(
      on({ [name]: "https://status.example.com" }).statusUrl,
      "https://status.example.com",
    );
    assert.equal(
      on({ [name]: "https://status.example.com/" }).statusUrl,
      "https://status.example.com",
    );
    assert.equal(on({ [name]: "http://127.0.0.1:8080/" }).statusUrl, "http://127.0.0.1:8080");
  });

  for (const value of ["https://status.example.com/pulse", "https://status.example.com/pulse/"]) {
    test(`${value} is refused with the R9 line`, () => {
      assert.equal(refused({ [name]: value }, name), line);
    });
  }

  for (const value of [
    "https://u:p@status.example.com",
    "https://status.example.com/?x=1",
    "https://status.example.com/#x",
    "ftp://status.example.com",
    "not a url",
  ]) {
    test(`${value} is refused`, () => {
      assert.equal(
        refused({ [name]: value }, name),
        `${name}: must be an http(s) URL without credentials, query or fragment`,
      );
    });
  }
});

describe("no file is opened", () => {
  let cleanup: (() => void) | undefined;
  afterEach(() => cleanup?.());

  test("off reads nothing in an unwritable state directory", () => {
    const { dir, remove } = tempDir("notify-subs-off-");
    chmodSync(dir, 0o500);
    cleanup = () => {
      chmodSync(dir, 0o700);
      remove();
    };
    const reads: string[] = [];
    const s = loadSubscriptionSettings(
      { PULSE_NOTIFY_STATE: join(dir, "state.db"), PULSE_NOTIFY_SUBSCRIPTIONS_KEY_FILE: "/s/key" },
      {
        readFile: (p) => {
          reads.push(p);
          return readFile(p);
        },
      },
    );
    assert.deepEqual(s, { isOn: false });
    assert.deepEqual(reads, []);
    assert.deepEqual(readdirSync(dir), []);
  });

  test("a refused root URL creates no store or lock file", () => {
    const { dir, remove } = tempDir("notify-subs-r9-");
    cleanup = remove;
    const state = join(dir, "subs.db");
    assert.throws(
      () =>
        load({
          PULSE_NOTIFY_SUBSCRIPTIONS_STATUS_URL: "https://status.example.com/pulse",
          PULSE_NOTIFY_SUBSCRIPTIONS_STATE: state,
        }),
      StartupError,
    );
    assert.equal(existsSync(state), false);
    assert.equal(existsSync(`${state}.lock`), false);
    assert.deepEqual(readdirSync(dir), []);
  });
});
