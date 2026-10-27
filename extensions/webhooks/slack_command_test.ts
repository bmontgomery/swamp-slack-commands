import { assertEquals } from "jsr:@std/assert@1.0.13";
import {
  ConfigSchema,
  decide,
  MAX_AGE_SECONDS,
  parseCommand,
  verifySlackSignature,
  webhook,
} from "./slack_command.ts";

// Slack's documented signing example (api.slack.com/authentication/verifying-requests-from-slack).
const SLACK_SECRET = "8f742231b10e8888abcd99yyyzzz85a5";
const SLACK_TS = 1531420618;
const SLACK_BODY =
  "token=xyzz0WbapA4vBCDEFasx0q6G&team_id=T1DC2JH3J&team_domain=testteamnow&channel_id=G8PSS9T3V&channel_name=foobar&user_id=U2CERLKJA&user_name=roadrunner&command=%2Fwebhook-collect&text=&response_url=https%3A%2F%2Fhooks.slack.com%2Fcommands%2FT1DC2JH3J%2F397700885554%2F96rGlfmibIGlgcZRskXaIFfN&trigger_id=398738663015.47445629121.803a0bc887a14d10d2c447fce8b6703c";
const SLACK_SIG =
  "v0=a2114d57b48eac39b9ad189dd8316235a7b4a8d21a10bd27519666489c69b503";

const headers = (sig: string, ts: number | string) =>
  new Headers({
    "x-slack-signature": sig,
    "x-slack-request-timestamp": String(ts),
  });
const bytes = (s: string) => new TextEncoder().encode(s);

Deno.test("accepts Slack's documented example signature", async () => {
  assertEquals(
    await verifySlackSignature(
      bytes(SLACK_BODY),
      headers(SLACK_SIG, SLACK_TS),
      SLACK_SECRET,
      SLACK_TS + 10,
    ),
    true,
  );
});

Deno.test("rejects a wrong secret, a changed body, a bad header, or a stale timestamp", async () => {
  const ok = (body: string, h: Headers, secret: string, now: number) =>
    verifySlackSignature(bytes(body), h, secret, now);
  const h = headers(SLACK_SIG, SLACK_TS);
  assertEquals(await ok(SLACK_BODY, h, "other", SLACK_TS), false);
  assertEquals(await ok(SLACK_BODY + "x", h, SLACK_SECRET, SLACK_TS), false);
  assertEquals(
    await ok(SLACK_BODY, headers(SLACK_SIG, "abc"), SLACK_SECRET, SLACK_TS),
    false,
  );
  assertEquals(
    await ok(SLACK_BODY, h, SLACK_SECRET, SLACK_TS + MAX_AGE_SECONDS + 1),
    false,
  );
  assertEquals(await ok(SLACK_BODY, h, "", SLACK_TS), false);
});

Deno.test("parseCommand splits the subcommand and keeps the reply fields", () => {
  const cmd = parseCommand(
    "command=%2Fdeploy&text=Production++now&user_id=U1&user_name=pat&channel_id=C1&response_url=https%3A%2F%2Fhooks.slack.com%2Fx",
  );
  assertEquals(cmd.command, "/deploy");
  assertEquals(cmd.subcommand, "production");
  assertEquals(cmd.args, "now");
  assertEquals(cmd.userId, "U1");
  assertEquals(cmd.responseUrl, "https://hooks.slack.com/x");
  assertEquals(cmd.sslCheck, false);
  assertEquals(
    parseCommand({ text: "test", user_id: "U2" }).subcommand,
    "test",
  );
  assertEquals(parseCommand("ssl_check=1").sslCheck, true);
});

const config = ConfigSchema.parse({
  subcommands: {
    test: { description: "Deploy master to test" },
    production: {
      description: "Deploy to production",
      allowedUsers: ["U1"],
      ack: "<@{user}> started a {subcommand} deploy",
    },
  },
});

Deno.test("decide queues allowed commands with the ack text", () => {
  const d = decide(
    parseCommand("command=/deploy&text=production&user_id=U1"),
    config,
  );
  assertEquals(d, {
    enqueue: true,
    responseType: "in_channel",
    text: "<@U1> started a production deploy",
  });
});

Deno.test("decide refuses unknown options, help, and users not on the list, privately", () => {
  const unknown = decide(parseCommand("command=/deploy&text=staging"), config);
  assertEquals(unknown.enqueue, false);
  assertEquals(unknown.responseType, "ephemeral");
  assertEquals(unknown.text.includes("Unknown option `staging`"), true);
  assertEquals(
    unknown.text.includes("`/deploy test` — Deploy master to test"),
    true,
  );
  assertEquals(
    decide(parseCommand("command=/deploy&text="), config).enqueue,
    false,
  );
  assertEquals(
    decide(parseCommand("command=/deploy&text=help"), config).enqueue,
    false,
  );
  const denied = decide(
    parseCommand("command=/deploy&text=production&user_id=U9"),
    config,
  );
  assertEquals(denied.enqueue, false);
  assertEquals(denied.text.includes("not allowed"), true);
  assertEquals(denied.text.includes("`U9`"), true);
});

Deno.test("decide escapes the caller's args so they can't ping or link", () => {
  const c = ConfigSchema.parse({
    subcommands: { test: { ack: "test {args}" } },
  });
  assertEquals(
    decide(parseCommand({ text: "test <!channel> now" }), c).text,
    "test &lt;!channel&gt; now",
  );
});

Deno.test("allowedChannels limits where a subcommand runs", () => {
  const c = ConfigSchema.parse({
    subcommands: { test: { allowedChannels: ["C1"] } },
  });
  assertEquals(
    decide(parseCommand("text=test&channel_id=C2"), c).enqueue,
    false,
  );
  assertEquals(
    decide(parseCommand("text=test&channel_id=C1"), c).enqueue,
    true,
  );
});

Deno.test("handler answers ssl_check without a run and replies JSON otherwise", () => {
  const h = webhook.createHandler({ subcommands: { test: {} } });
  assertEquals(h.requiredHeaders, [
    "x-slack-signature",
    "x-slack-request-timestamp",
  ]);
  assertEquals(h.respond({ body: h.transform("ssl_check=1") }), {
    status: 200,
    enqueue: false,
  });
  const r = h.respond({
    body: h.transform("command=/deploy&text=test&user_id=U5"),
  });
  assertEquals(r.enqueue, true);
  assertEquals(
    (r as { body: { response_type: string } }).body.response_type,
    "in_channel",
  );
});

Deno.test("config needs at least one subcommand", () => {
  assertEquals(ConfigSchema.safeParse({ subcommands: {} }).success, false);
});
