import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type { FileChannelConfig, Sender } from "../types.ts";

export function createFileSender(channel: FileChannelConfig): Sender {
  return async (notification) => {
    await mkdir(dirname(channel.path), { recursive: true });
    await appendFile(channel.path, `${JSON.stringify(notification)}\n`);
  };
}
