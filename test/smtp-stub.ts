import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TLSSocket } from "node:tls";

export interface TestCert {
  key: string;
  cert: string;
}

/** Makes a self-signed certificate for 127.0.0.1 in a temp directory with the openssl CLI. */
export function makeCert(): TestCert {
  const dir = mkdtempSync(join(tmpdir(), "notify-cert-"));
  try {
    execFileSync(
      // The test needs the openssl CLI to make a throwaway certificate.
      // eslint-disable-next-line sonarjs/no-os-command-from-path
      "openssl",
      [
        "req",
        "-x509",
        "-newkey",
        "rsa:2048",
        "-nodes",
        "-keyout",
        join(dir, "key.pem"),
        "-out",
        join(dir, "cert.pem"),
        "-days",
        "1",
        "-subj",
        "/CN=localhost",
        "-addext",
        "subjectAltName=DNS:localhost,IP:127.0.0.1",
      ],
      { stdio: "ignore" },
    );
    return {
      key: readFileSync(join(dir, "key.pem"), "utf8"),
      cert: readFileSync(join(dir, "cert.pem"), "utf8"),
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export interface SmtpStubOptions {
  /** Offer and accept STARTTLS with this certificate. */
  starttls?: TestCert;
  /** AUTH mechanisms to offer; default none. */
  auth?: ("PLAIN" | "LOGIN")[];
  /** Reply to the first command that starts with the key, instead of the normal one. */
  replies?: Record<string, string>;
  /** Do not send the greeting. */
  isSilent?: boolean;
}

export interface SmtpStub {
  port: number;
  /** Commands as received, in order (the message data is in `messages`). */
  commands: string[];
  /** Raw DATA content of each accepted message, without the final dot line. */
  messages: string[];
  close(): Promise<void>;
}

const CAPABILITY_LINE = "250-stub";

function ehloReply(options: SmtpStubOptions, isSecure: boolean): string {
  const lines = [CAPABILITY_LINE];
  if (options.starttls && !isSecure) lines.push("250-STARTTLS");
  if (options.auth) lines.push(`250-AUTH ${options.auth.join(" ")}`);
  lines.push("250 8BITMIME");
  return `${lines.join("\r\n")}\r\n`;
}

class Connection {
  readonly #stub: SmtpStub;
  readonly #options: SmtpStubOptions;
  #buffer = "";
  #data: string[] | undefined;
  #loginStep = 0;
  #isSecure: boolean;

  constructor(stub: SmtpStub, options: SmtpStubOptions, isSecure: boolean) {
    this.#stub = stub;
    this.#options = options;
    this.#isSecure = isSecure;
  }

  attach(socket: Socket): void {
    socket.setEncoding("utf8");
    socket.on("error", () => {});
    socket.on("data", (chunk: string) => {
      this.#buffer += chunk;
      for (let i = this.#buffer.indexOf("\r\n"); i >= 0; i = this.#buffer.indexOf("\r\n")) {
        const line = this.#buffer.slice(0, i);
        this.#buffer = this.#buffer.slice(i + 2);
        this.#line(socket, line);
      }
    });
  }

  #line(socket: Socket, line: string): void {
    if (this.#data) {
      if (line === ".") {
        this.#stub.messages.push(this.#data.join("\r\n"));
        this.#data = undefined;
        socket.write("250 queued\r\n");
      } else {
        this.#data.push(line);
      }
      return;
    }
    if (this.#loginStep > 0) {
      this.#loginStep += 1;
      socket.write(this.#loginStep === 2 ? "334 UGFzc3dvcmQ6\r\n" : "235 ok\r\n");
      if (this.#loginStep === 3) this.#loginStep = 0;
      this.#stub.commands.push(`<login step ${this.#loginStep === 0 ? 3 : 2}>`);
      return;
    }
    this.#stub.commands.push(line);
    const override = Object.keys(this.#options.replies ?? {}).find((k) => line.startsWith(k));
    if (override !== undefined) {
      const reply = this.#options.replies?.[override] ?? "";
      delete this.#options.replies?.[override];
      socket.write(`${reply}\r\n`);
      return;
    }
    this.#command(socket, line);
  }

  #command(socket: Socket, line: string): void {
    const verb = line.split(" ")[0]?.toUpperCase() ?? "";
    switch (verb) {
      case "EHLO":
        socket.write(ehloReply(this.#options, this.#isSecure));
        break;
      case "STARTTLS":
        this.#startTls(socket);
        break;
      case "AUTH":
        if (line.startsWith("AUTH LOGIN")) {
          this.#loginStep = 1;
          socket.write("334 VXNlcm5hbWU6\r\n");
        } else {
          socket.write("235 ok\r\n");
        }
        break;
      case "DATA":
        this.#data = [];
        socket.write("354 go\r\n");
        break;
      case "QUIT":
        socket.end("221 bye\r\n");
        break;
      default:
        socket.write("250 ok\r\n");
    }
  }

  #startTls(socket: Socket): void {
    const tls = this.#options.starttls;
    if (!tls) {
      socket.write("502 no\r\n");
      return;
    }
    socket.write("220 go ahead\r\n");
    // Stop reading plain text before the handshake starts.
    socket.removeAllListeners("data");
    const secure = new TLSSocket(socket, { isServer: true, key: tls.key, cert: tls.cert });
    this.#isSecure = true;
    this.#buffer = "";
    this.attach(secure);
  }
}

export async function startSmtpStub(options: SmtpStubOptions = {}): Promise<SmtpStub> {
  const sockets = new Set<Socket>();
  const stub: SmtpStub = {
    port: 0,
    commands: [],
    messages: [],
    close: () =>
      new Promise((resolve) => {
        for (const s of sockets) s.destroy();
        server.close(() => resolve());
      }),
  };
  const server: Server = createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    new Connection(stub, options, false).attach(socket);
    if (!options.isSilent) socket.write("220 stub ready\r\n");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  stub.port = typeof address === "object" && address ? address.port : 0;
  return stub;
}

/** An implicit-TLS SMTP stub (`tls: "tls"`). */
export async function startTlsSmtpStub(cert: TestCert): Promise<SmtpStub> {
  const { createServer: createTlsServer } = await import("node:tls");
  const stub: SmtpStub = {
    port: 0,
    commands: [],
    messages: [],
    close: () =>
      new Promise((resolve) => {
        for (const s of sockets) s.destroy();
        server.close(() => resolve());
      }),
  };
  const sockets = new Set<Socket>();
  const server = createTlsServer({ key: cert.key, cert: cert.cert }, (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    new Connection(stub, {}, true).attach(socket);
    socket.write("220 stub ready\r\n");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  stub.port = typeof address === "object" && address ? address.port : 0;
  return stub;
}
