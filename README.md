# Hermes on Docker Cloud Sandboxes

For whoever runs the demo: a small CLI that runs a persistent Hermes agent on Docker Cloud Sandboxes through the `@docker/sandboxes` TypeScript SDK, and the demo script that goes with it.

## Prerequisites

- Node 24 or later. It runs `hermes.ts` directly, with no build step.
- `DOCKER_ACCESS_TOKEN` set to an access token for the target account. Sourcing your prod or stage auth helper sets it and prints how long the token stays valid. A single stop took about four minutes on staging, so make sure the token covers the whole demo.
- An Anthropic API key.
- For the Telegram part only: a kit built with Hermes' Telegram extra, a bot token from @BotFather, and your numeric Telegram user ID. See [Telegram](#telegram).

The SDK is installed from the public npm registry as `@docker/sandboxes@0.53.0`. It is not published to GitHub Packages.

## One-time setup

```sh
npm install
<command that prints your Anthropic key> | node hermes.ts secret
```

`secret` reads the key from stdin only and stores it as the account secret `hermes-anthropic`. If that secret already exists, it reuses it and reads nothing. It ignores other Anthropic secrets on purpose: ones created earlier by `sbx` lack the resource identity that strict secrets requires, and create fails with "stored secret must be enrolled with an immutable resource identity".

`demo-run.txt` is a full run on prod on 2026-10-21: ready in 16 s, hibernate 112 s, resume 5 s, upgrade 62 s, and the remembered fact survived both the cycle and the upgrade.

Production is the default target. Add `--env stage` to every command to use staging. Any other environment is refused. IDs live in `.state.json`, which belongs to one environment.

## Demo script

| Command | What it shows |
|---|---|
| `node hermes.ts launch` | Creates the `hermes-state` volume and a Hermes sandbox with the model secret and an hourly restart cycle. Prints the sandbox name, id, and time to ready. |
| `node hermes.ts ask "What can you help me with?"` | A real model reply. Hermes only sees a placeholder key; the real key stays outside the sandbox. |
| `node hermes.ts remember "I deploy on Tuesdays"` | Hermes saves the fact with its own memory tool. The CLI then prints the memory file from the volume. |
| `node hermes.ts cycle` | Stop (hibernate) and start (resume), with timings. The platform runs this at every timeout. Stop can take a few minutes; resume takes seconds. |
| `node hermes.ts recall "Which day do I deploy?"` | A fresh Hermes session answers from memory. |
| `<command that prints the bot token> \| node hermes.ts telegram --user-id <id>` | Optional. Stores the bot token on the volume and starts the Telegram gateway. Message the bot from your phone. |
| `node hermes.ts upgrade` | Deletes the sandbox and creates a new one on the same volume, as an image upgrade would. It restarts the gateway when the volume holds a bot token. |
| `node hermes.ts recall "Which day do I deploy?"` | The new VM still knows the fact. |
| `node hermes.ts destroy --volume --secret` | Deletes the sandbox and volume. `--secret` deletes the secret only if this CLI created it. |

`node hermes.ts status` shows the sandbox, its next timeout, the volume, and the secret at any point.

## Two volume modes

Hermes keeps its state in `HERMES_HOME=/home/agent/.hermes/profiles/persistent`, which is where the volume is mounted. A fresh volume is owned by root, so it needs preparing before Hermes can write to it.

- Prepare mode (the default) works with the published kit. The sandbox is created without `HERMES_HOME`. A root command then hands the mount to the agent user, sets mode 0700, and copies `config.yaml` and `.env` in when they are missing. It also writes the proxy placeholder (`ANTHROPIC_API_KEY=proxy-managed`) into the profile's `.env`, because under a profile home Hermes reads provider keys only from that file. It is safe to rerun. Every Hermes command passes `HERMES_HOME` itself.
- `launch --kit-hook` is for after docker/sbx-kits-contrib#390 ships. It sets `HERMES_HOME` and `HERMES_INIT_VOLUME=1` at create and lets the kit's startup hook prepare the volume. With today's kit, create fails in this mode. The kit also needs the placeholder fix from the `Narrator/hermes-telegram-demo` branch, or `ask` fails with "No Anthropic credentials found".

## Telegram

The published kit, `docker.io/sbx/hermes-agent-kit:latest`, has no Telegram SDK and does not allow `api.telegram.org`, so the gateway fails there with `FeatureUnavailable`. A demo build from the `Narrator/hermes-telegram-demo` branch of docker/sbx-kits-contrib is public as `docker.io/kaushikgnanaskandan45643/hermes-agent-kit:telegram-demo` (amd64 and arm64). Pass it as `launch --kit <ref>`, or as `upgrade --kit <ref>` to move an existing sandbox onto it and keep the volume. The kit you pick is recorded, and later upgrades reuse it.

`demo-run-telegram.txt` is the prod run on 2026-10-22: the sandbox moved onto the Telegram kit with its memory intact, the gateway connected in 16 s, and the bot answered before and after a hibernate and resume.

`telegram --user-id <id>` reads the bot token from stdin only and never prints it. It writes `TELEGRAM_BOT_TOKEN` and `TELEGRAM_ALLOWED_USERS` into the profile's `.env` on the volume, mode 0600. Hermes then ignores messages from anyone else. Running it again replaces both. The token has to live in the sandbox because Telegram puts it in the request URL, and the proxy only injects headers. Anything Hermes runs can read it, so use a bot made for the demo and revoke its token with @BotFather afterwards.

It then starts `hermes gateway run --replace` as a background process. It runs on the default Hermes home, because Hermes 0.22 refuses a gateway of a profile's own and the default one serves every profile. The command waits until the gateway's status record says Telegram is connected, and fails with Hermes' own error otherwise. `status` shows the same state.

After a `cycle`, the gateway process resumes with the sandbox. It notices the dead connection within about 60 seconds through socket keepalive, its 90-second heartbeat backs that up, and it retries for as long as it runs. Telegram keeps messages sent in the meantime for up to 24 hours and delivers them once the gateway reconnects. A fresh gateway start, as after `upgrade`, drops them unless `platforms.telegram.extra.drop_pending_on_cold_boot` is `false` in the profile's `config.yaml`.

## Timeout options

- By default the sandbox uses `onTimeout: restart` with a one-hour first cycle, the minimum. This needs the AlwaysOn and Hibernate entitlements. If the account lacks them, create fails with the server's error.
- `--on-timeout stop` is the fallback. The sandbox hibernates at the timeout and stays stopped until the next `cycle`.
- `--always-on` also turns on auto-resume. Staging accepted it, but which requests wake a stopped sandbox was not tested.

The timeout action cannot change after create, and `upgrade` reuses the flags of the first launch, except that it takes a new `--kit`. To change the others, run `destroy` (the volume stays) and `launch` again.

## Not covered

- Real-time connections drop on every stop and start, including chat platform links and open sockets. Clients have to reconnect.
- Durability across host failure is out of scope. The volume survives sandbox replacement, but nothing here was tested against losing a host.
- Sign-in is bearer token only. The SDK's device-flow sign-in is tied to its public endpoints, so it cannot target staging.
