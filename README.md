# @bmonty/slack-commands

A [swamp](https://github.com/swamp-club/swamp) extension that runs workflows
from Slack slash commands. Its webhook type, `@bmonty/slack-command`, plugs into
a `swamp serve` webhook endpoint and:

- verifies Slack's request signature with your app's signing secret, and rejects
  requests more than 5 minutes old (replays);
- parses Slack's form-encoded body into named fields for the workflow;
- allow-lists users and channels per subcommand (`/deploy test`,
  `/deploy production`, ...);
- answers Slack immediately: unknown subcommands, `help`, and callers who are
  not allowed get a private reply and start no run (a refused caller is shown
  their user id, to send to whoever maintains the allow-list); accepted commands
  get an acknowledgement and queue the workflow.

To post results back to Slack from the workflow, use a messaging extension such
as `@mgreten/slack-blocks`.

## Installation

```sh
swamp extension pull @bmonty/slack-commands
```

## Setup

1. Create a Slack app with a slash command (e.g. `/deploy`) whose request URL is
   your serve's public HTTPS address plus the route, e.g.
   `https://hooks.example.com/hooks/slack/deploy`. Expose only that route; see
   [Exposing serve](#exposing-serve).
2. Make the app's **Signing Secret** available to serve without committing it:
   an environment variable (`secret: "@env=SLACK_SIGNING_SECRET"`) or a file
   outside the repository (`secret: "@file=/etc/swamp/slack-signing-secret"`).
3. Configure the endpoint in `serve.yaml`:

```yaml
webhooks:
  - route: /hooks/slack/deploy
    workflow: slack-deploy
    secret: "@file=/etc/swamp/slack-signing-secret"
    scheme: "@bmonty/slack-command"
    config:
      ackVisibility: in_channel # or ephemeral
      subcommands:
        test:
          description: Deploy main to test
          ack: ":rocket: <@{user}> started a test deploy."
        production:
          description: Deploy to production
          allowedUsers: [U0123ABCD]
          allowedChannels: [C0123ABCD]
```

`ack` may use `{user}` (the caller's id, so `<@{user}>` mentions them),
`{subcommand}`, and `{args}` (the words after the subcommand). Omit
`allowedUsers` or `allowedChannels` to allow anyone or any channel.

4. Map the command onto workflow inputs with `trigger.inputs`:

```yaml
trigger:
  inputs:
    environment: ${{ webhook.body.subcommand }}
    requestedBy: ${{ webhook.body.userId }}
    channel: ${{ webhook.body.channelId }}
```

## Fields in `webhook.body`

| Field         | Example                                            |
| ------------- | -------------------------------------------------- |
| `command`     | `/deploy`                                          |
| `text`        | `production now`                                   |
| `subcommand`  | `production` (first word, lowercased)              |
| `args`        | `now` (the rest)                                   |
| `userId`      | `U0123ABCD`                                        |
| `userName`    | `pat`                                              |
| `channelId`   | `C0123ABCD`                                        |
| `channelName` | `deploys`                                          |
| `teamId`      | `T0123ABCD`                                        |
| `responseUrl` | Slack's URL for delayed replies (valid 30 minutes) |
| `triggerId`   | for opening a modal                                |

## Exposing serve

Slack must reach serve over public HTTPS. Forward only the webhook route, never
the rest of serve (its API and dashboard). For example:

- **Cloudflare Tunnel**: an ingress rule with `path: ^/hooks/slack/` and a final
  `service: http_status:404`.
- **ngrok**:
  `ngrok http 9090 --url https://<your-domain> --traffic-policy-file policy.yml`
  with a policy that refuses every other path:

```yaml
on_http_request:
  - expressions:
      - "!req.url.path.startsWith('/hooks/slack/')"
    actions:
      - type: custom-response
        config:
          status_code: 404
          content: Not found
```

A request that reaches serve without Slack's signature gets `401`, which makes a
quick external check that the route is wired up.

## Development

```sh
deno test extensions/webhooks/
swamp extension source add /path/to/swamp-slack-commands
```

## License

MIT. See [LICENSE](LICENSE).
