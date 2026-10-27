/**
 * Slack slash commands for `swamp serve` webhooks. Verifies Slack's request
 * signature (rejecting stale timestamps), turns the form-encoded body into
 * named fields, and answers Slack within its 3-second limit: unknown
 * subcommands and users who are not allowed get a private reply and start no
 * run; accepted commands get an acknowledgement and queue the workflow.
 *
 * The endpoint secret is the Slack app's signing secret.
 *
 * @module
 */
import { z } from "npm:zod@4";

/** Header carrying `v0=<hex hmac>`. */
const SIGNATURE_HEADER = "x-slack-signature";
/** Header carrying the request's Unix time in seconds. */
const TIMESTAMP_HEADER = "x-slack-request-timestamp";
/** Slack's recommended replay window. */
export const MAX_AGE_SECONDS = 300;

/** Who may run one subcommand, and the reply they get. */
export const SubcommandSchema = z.object({
  description: z.string().default("").describe("Shown in the usage reply."),
  allowedUsers: z.array(z.string().min(1)).optional().describe(
    "Slack user ids (U...) allowed to run it; anyone when omitted.",
  ),
  allowedChannels: z.array(z.string().min(1)).optional().describe(
    "Channel ids (C...) it may be run in; any channel when omitted.",
  ),
  ack: z.string().optional().describe(
    "Reply when the command is accepted; `{user}`, `{subcommand}`, and `{args}` are filled in.",
  ),
});

/** Endpoint configuration. */
export const ConfigSchema = z.object({
  subcommands: z.record(
    z.string().regex(/^[a-z0-9][a-z0-9_-]*$/),
    SubcommandSchema,
  ).refine((s) => Object.keys(s).length > 0, {
    message: "configure at least one subcommand",
  }).describe(
    "Accepted first words of the command text, e.g. { test: {...}, production: {...} }.",
  ),
  ackVisibility: z.enum(["in_channel", "ephemeral"]).default("in_channel")
    .describe(
      "Whether the acknowledgement is shown to the channel or only the caller.",
    ),
});

/** Resolved configuration type. */
export type Config = z.infer<typeof ConfigSchema>;

/** The slash command as the workflow sees it in `webhook.body`. */
export interface SlashCommand {
  command: string;
  text: string;
  subcommand: string;
  args: string;
  userId: string;
  userName: string;
  channelId: string;
  channelName: string;
  teamId: string;
  responseUrl: string;
  triggerId: string;
  sslCheck: boolean;
}

/** Lowercase hex of HMAC-SHA256(`key`, `message`). */
async function hmacHex(
  key: string,
  message: Uint8Array<ArrayBuffer>,
): Promise<string> {
  const k = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(key),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", k, message));
  return Array.from(sig, (b) => b.toString(16).padStart(2, "0")).join("");
}

async function digest(value: string): Promise<Uint8Array> {
  return new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)),
  );
}

/** Constant-time comparison of two strings, via their SHA-256 digests. */
async function sameSecret(a: string, b: string): Promise<boolean> {
  const [x, y] = await Promise.all([digest(a), digest(b)]);
  let diff = x.length ^ y.length;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}

/**
 * True when `body` carries a valid Slack signature made with `secret` within
 * the replay window. `now` is Unix seconds (injectable for tests).
 */
export async function verifySlackSignature(
  body: Uint8Array,
  headers: Headers,
  secret: string,
  now: number = Math.floor(Date.now() / 1000),
): Promise<boolean> {
  const timestamp = headers.get(TIMESTAMP_HEADER) ?? "";
  const signature = headers.get(SIGNATURE_HEADER) ?? "";
  if (!/^\d+$/.test(timestamp) || !secret) return false;
  if (Math.abs(now - Number(timestamp)) > MAX_AGE_SECONDS) return false;
  const prefix = new TextEncoder().encode(`v0:${timestamp}:`);
  const message = new Uint8Array(prefix.length + body.length);
  message.set(prefix);
  message.set(body, prefix.length);
  return await sameSecret(signature, `v0=${await hmacHex(secret, message)}`);
}

/** Parse Slack's form body (or an already-parsed object) into a command. */
export function parseCommand(body: unknown): SlashCommand {
  const get: (k: string) => string = typeof body === "string"
    ? ((p) => (k: string) => p.get(k) ?? "")(new URLSearchParams(body))
    : (k: string) => {
      const v = (body as Record<string, unknown> | null)?.[k];
      return typeof v === "string" ? v : "";
    };
  const text = get("text").trim();
  const [first = "", ...rest] = text.split(/\s+/);
  return {
    command: get("command"),
    text,
    subcommand: first.toLowerCase(),
    args: rest.join(" "),
    userId: get("user_id"),
    userName: get("user_name"),
    channelId: get("channel_id"),
    channelName: get("channel_name"),
    teamId: get("team_id"),
    responseUrl: get("response_url"),
    triggerId: get("trigger_id"),
    sslCheck: get("ssl_check") === "1",
  };
}

/** What to tell Slack, and whether to start the workflow. */
export interface Decision {
  enqueue: boolean;
  responseType: "in_channel" | "ephemeral";
  text: string;
}

/** Usage text listing the configured subcommands. */
export function usage(command: string, config: Config): string {
  const lines = Object.entries(config.subcommands).map(([name, s]) =>
    `• \`${command || "/command"} ${name}\`${
      s.description ? ` — ${s.description}` : ""
    }`
  );
  return ["Usage:", ...lines].join("\n");
}

/** Decide whether a command runs, and the immediate reply. */
export function decide(cmd: SlashCommand, config: Config): Decision {
  const deny = (text: string): Decision => ({
    enqueue: false,
    responseType: "ephemeral",
    text,
  });
  const sub = config.subcommands[cmd.subcommand];
  if (!cmd.subcommand || cmd.subcommand === "help" || !sub) {
    const unknown = cmd.subcommand && cmd.subcommand !== "help"
      ? `Unknown option \`${cmd.subcommand}\`.\n`
      : "";
    return deny(unknown + usage(cmd.command, config));
  }
  if (sub.allowedChannels && !sub.allowedChannels.includes(cmd.channelId)) {
    return deny(
      `\`${cmd.command} ${cmd.subcommand}\` can't be run in this channel.`,
    );
  }
  if (sub.allowedUsers && !sub.allowedUsers.includes(cmd.userId)) {
    return deny(
      `Sorry, you're not allowed to run \`${cmd.command} ${cmd.subcommand}\`. ` +
        `Ask an admin to add your user id \`${cmd.userId}\`.`,
    );
  }
  // The caller's own text is echoed as plain text, so it can't smuggle in
  // mentions like <!channel> or links.
  const args = cmd.args.replaceAll("<", "&lt;").replaceAll(">", "&gt;");
  const text = (sub.ack ?? "Starting `{subcommand}` for <@{user}>…")
    .replaceAll("{user}", cmd.userId)
    .replaceAll("{subcommand}", cmd.subcommand)
    .replaceAll("{args}", args);
  return { enqueue: true, responseType: config.ackVisibility, text };
}

/** Webhook type `@bmonty/slack-command`. */
export const webhook = {
  type: "@bmonty/slack-command",
  name: "Slack slash command",
  description:
    "Verifies Slack slash command requests, parses them, allow-lists users per subcommand, and replies within Slack's 3-second limit",
  configSchema: ConfigSchema,
  createHandler: (rawConfig: Record<string, unknown>) => {
    const config = ConfigSchema.parse(rawConfig);
    return {
      signatureHeader: SIGNATURE_HEADER,
      requiredHeaders: [SIGNATURE_HEADER, TIMESTAMP_HEADER],
      verify: (body: Uint8Array, headers: Headers, secret: string) =>
        verifySlackSignature(body, headers, secret),
      transform: (body: unknown) => parseCommand(body),
      respond: (payload: { body: unknown }) => {
        const cmd = payload.body as SlashCommand;
        if (cmd.sslCheck) return { status: 200, enqueue: false };
        const d = decide(cmd, config);
        return {
          status: 200,
          headers: { "Content-Type": "application/json" },
          body: { response_type: d.responseType, text: d.text },
          enqueue: d.enqueue,
        };
      },
    };
  },
};
