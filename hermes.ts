import { readFile, rm, writeFile } from 'node:fs/promises';
import { text } from 'node:stream/consumers';
import { setTimeout } from 'node:timers/promises';
import { parseArgs } from 'node:util';
import {
  NotFoundError,
  Sandboxes,
  SandboxesError,
  type ClientCreateOptions,
  type Process,
  type RunResult,
  type Sandbox,
} from '@docker/sandboxes';

const BASE_URLS: Record<string, string> = {
  prod: 'https://api.sandboxes-cloud.docker.com/sandboxes',
  stage: 'https://api.sandboxes-cloud-stage.docker.com/sandboxes',
};
const SANDBOX_NAME = 'hermes-agent';
const VOLUME_NAME = 'hermes-state';
const SECRET_NAME = 'hermes-anthropic';
const ROOT_HOME = '/home/agent/.hermes';
const PROFILE = 'persistent';
// Must stay under ~/.hermes: Hermes v0.22 treats any other HERMES_HOME as a separate install root.
const HERMES_HOME = `${ROOT_HOME}/profiles/${PROFILE}`;
const GATEWAY_STATE_FILE = `${ROOT_HOME}/gateway_state.json`;
const FIRST_CYCLE_MS = 3_600_000;
const LONG_CALL = { timeoutMs: 600_000 };
const STATE_FILE = new URL('.state.json', import.meta.url);
const DEFAULT_KIT = 'docker.io/sbx/hermes-agent-kit:latest';
const GATEWAY_SETTLE_MS = 60_000;
const POLL_MS = 2_000;

// The public SDK types only model inline kit artifacts, but the service also accepts a kit image reference.
function kitReference(ref: string): NonNullable<ClientCreateOptions['kits']>[number] {
  return { kitReference: { ref: { ref } } } as unknown as NonNullable<ClientCreateOptions['kits']>[number];
}

// Run as the agent with the token in its environment, so it never reaches argv or output.
const WRITE_TELEGRAM_ENV = `set -eu
env_file="$HERMES_HOME/.env"
umask 077
touch "$env_file"
{
  grep -v -e '^TELEGRAM_BOT_TOKEN=' -e '^TELEGRAM_ALLOWED_USERS=' "$env_file" || [ $? -eq 1 ]
  printf 'TELEGRAM_BOT_TOKEN=%s\\nTELEGRAM_ALLOWED_USERS=%s\\n' "$TELEGRAM_BOT_TOKEN" "$TELEGRAM_ALLOWED_USERS"
} > "$env_file.telegram"
chmod 600 "$env_file.telegram"
mv "$env_file.telegram" "$env_file"`;

// What the kit's HERMES_INIT_VOLUME hook does, run as root after create: hand the mount to agent and seed it.
const PREPARE_SCRIPT = `set -eu
dir="$1"
[ "$(stat -c %d "$dir")" != "$(stat -c %d "$dir/..")" ] || { echo "$dir is not a mounted volume" >&2; exit 1; }
owner=$(stat -c %u:%g "$dir")
if [ "$owner" = 0:0 ]; then
  if ls -A "$dir" | grep -qv '^lost+found$'; then echo "refusing a non-empty root-owned volume" >&2; exit 1; fi
  chmod 700 "$dir"
  chown 1000:1000 "$dir"
elif [ "$owner" != 1000:1000 ]; then
  echo "refusing a volume owned by $owner" >&2; exit 1
fi
for name in config.yaml .env; do
  if [ -e "$dir/$name" ] || [ ! -f "/home/agent/.hermes/$name" ]; then continue; fi
  cp -p "/home/agent/.hermes/$name" "$dir/.$name.seeding"
  chown 1000:1000 "$dir/.$name.seeding"
  mv "$dir/.$name.seeding" "$dir/$name"
  echo "seeded $name"
done
# Under a profile HERMES_HOME, Hermes reads provider keys only from the profile's .env, so copy the proxy placeholders there.
[ -f /home/agent/.hermes/credential-auth.env ] && . /home/agent/.hermes/credential-auth.env
for var in ANTHROPIC_API_KEY OPENAI_API_KEY OPENROUTER_API_KEY; do
  value=$(printenv "$var" || true)
  if [ "$value" = proxy-managed ] && ! grep -q "^$var=" "$dir/.env" 2>/dev/null; then
    printf '%s=proxy-managed\\n' "$var" >> "$dir/.env"
    chown 1000:1000 "$dir/.env"
    echo "placeholder $var"
  fi
done`;

interface LaunchMode {
  kit: string;
  kitHook: boolean;
  alwaysOn: boolean;
  onTimeout: 'restart' | 'stop';
}

interface State {
  env: string;
  volume?: string;
  sandbox?: string;
  createdSecret?: string;
  mode?: LaunchMode;
}

const USAGE = `usage: node hermes.ts [--env prod|stage] <command>

  secret                 store the Anthropic API key piped on stdin (reuses an existing one)
  launch [--kit <ref>] [--kit-hook] [--always-on] [--on-timeout restart|stop]
  ask "<prompt>"         one Hermes turn
  remember "<fact>"      ask Hermes to save a fact to its memory
  recall "<question>"    ask Hermes in a fresh session
  telegram --user-id <id>  store the bot token piped on stdin, then start the Telegram gateway
  cycle                  stop (hibernate) then start (resume)
  upgrade [--kit <ref>]  replace the sandbox, keep the state volume, restart the gateway
  status
  destroy [--volume] [--secret]`;

class CliError extends Error {}

function fail(message: string): never {
  throw new CliError(message);
}

function since(startedAt: number): string {
  return `${((performance.now() - startedAt) / 1000).toFixed(1)}s`;
}

async function loadState(env: string): Promise<State> {
  let state: State;
  try {
    state = JSON.parse(await readFile(STATE_FILE, 'utf8'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { env };
    throw error;
  }
  if (state.env !== env) fail(`.state.json belongs to --env ${state.env}; finish there or pass --env ${state.env}`);
  return state;
}

async function saveState(state: State): Promise<void> {
  if (!state.volume && !state.sandbox && !state.createdSecret) {
    await rm(STATE_FILE, { force: true });
    return;
  }
  await writeFile(STATE_FILE, JSON.stringify(state, null, 2) + '\n');
}

// Only this tool's own secret: older sbx-created secrets lack the resource identity strict secrets require.
async function findModelSecret(client: Sandboxes) {
  for await (const secret of client.secrets.all()) {
    if (secret.serviceType === 'anthropic' && secret.displayName === SECRET_NAME) return secret;
  }
  return undefined;
}

async function findVolume(client: Sandboxes) {
  for await (const volume of client.volumes.all()) {
    if (volume.displayName === VOLUME_NAME) return volume;
  }
  return undefined;
}

async function recordedSandbox(client: Sandboxes, state: State): Promise<Sandbox> {
  if (!state.sandbox) fail('no sandbox recorded; run launch first');
  try {
    return await client.get(state.sandbox);
  } catch (error) {
    if (error instanceof NotFoundError) fail(`${state.sandbox} no longer exists; run destroy, then launch`);
    throw error;
  }
}

async function runningSandbox(client: Sandboxes, state: State): Promise<Sandbox> {
  const sandbox = await recordedSandbox(client, state);
  if (sandbox.status !== 'running') fail(`${sandbox.name} is ${sandbox.status}; run cycle to resume it`);
  return sandbox;
}

// Hermes prints its own failures on stdout, so both streams go into the error.
function outputOf(result: RunResult, what: string): string {
  if (result.exitCode !== 0) {
    const detail = [result.stderr, result.stdout].map((stream) => stream.trim()).filter(Boolean).join('\n');
    fail(`${what} exited ${result.exitCode}: ${detail}`);
  }
  return result.stdout.trim();
}

async function hermes(sandbox: Sandbox, args: string[]): Promise<string> {
  // A login shell sources the kit's credential-auth.env, which drops the provider sentinels this account lacks.
  const result = await sandbox.processes.run(
    { args: ['sh', '-lc', 'exec hermes "$@"', 'hermes', ...args], env: { HERMES_HOME } },
    LONG_CALL,
  );
  return outputOf(result, `hermes ${args[0]}`);
}

// Hermes' memory tool writes MEMORY.md and USER.md here and loads them into every new session.
async function memoryFiles(sandbox: Sandbox): Promise<string> {
  const result = await sandbox.processes.run(
    { args: ['sh', '-c', 'tail -n +1 "$HERMES_HOME"/memories/*.md'], env: { HERMES_HOME } },
    LONG_CALL,
  );
  return outputOf(result, 'reading memory files');
}

async function remember(sandbox: Sandbox, fact: string): Promise<void> {
  console.log(await hermes(sandbox, ['-z', `Save this to your persistent memory with the memory tool, then confirm in one sentence: ${fact}`]));
  console.log(`\nmemory files on the volume:\n${await memoryFiles(sandbox)}`);
}

async function storeSecret(client: Sandboxes, state: State): Promise<void> {
  const existing = await findModelSecret(client);
  if (existing) {
    console.log(`reusing Anthropic secret ${existing.name} (${existing.displayName})`);
    return;
  }
  if (process.stdin.isTTY) fail('pipe the Anthropic API key on stdin; it is never taken from arguments');
  const key = (await text(process.stdin)).trim();
  if (!key.startsWith('sk-ant-')) fail('stdin does not look like an Anthropic API key');
  const secret = await client.secrets.create({ displayName: SECRET_NAME, serviceType: 'anthropic', token: { value: key } });
  state.createdSecret = secret.name;
  await saveState(state);
  console.log(`created Anthropic secret ${secret.name}`);
}

async function launch(client: Sandboxes, state: State, mode: LaunchMode): Promise<Sandbox> {
  if (state.sandbox) fail(`${state.sandbox} is already recorded; use upgrade, or destroy first`);
  const secret = await findModelSecret(client);
  if (!secret) fail('this account has no Anthropic secret; run secret first');
  const volume = (await findVolume(client)) ?? (await client.volumes.create({ displayName: VOLUME_NAME }));
  state.volume = volume.name;
  state.mode = mode;
  await saveState(state);

  const startedAt = performance.now();
  let sandbox: Sandbox;
  try {
    sandbox = await client.create(
      {
        displayName: SANDBOX_NAME,
        kits: [kitReference(mode.kit)],
        resources: 'small',
        environment: mode.kitHook ? { HERMES_HOME, HERMES_INIT_VOLUME: '1' } : undefined,
        storage: {
          volumes: [{ volume: volume.name, target: HERMES_HOME, mode: 'exclusive' }],
          secrets: [secret.name],
        },
        lifecycle: { timeoutMs: FIRST_CYCLE_MS, onTimeout: mode.onTimeout, autoResume: mode.alwaysOn },
      },
      LONG_CALL,
    );
  } catch (error) {
    if (mode.onTimeout === 'restart' && error instanceof SandboxesError) {
      console.error('hint: onTimeout restart needs the AlwaysOn and Hibernate entitlements; without them, retry with --on-timeout stop');
    }
    throw error;
  }
  state.sandbox = sandbox.name;
  await saveState(state);
  sandbox = await sandbox.waitUntilRunning(LONG_CALL);
  console.log(`running after ${since(startedAt)}`);

  if (!mode.kitHook) {
    const preparedAt = performance.now();
    const result = await sandbox.processes.run(
      { args: ['sh', '-c', PREPARE_SCRIPT, 'prepare', HERMES_HOME], user: 'root' },
      LONG_CALL,
    );
    const seeded = outputOf(result, 'preparing the state volume');
    console.log(`prepared ${HERMES_HOME} in ${since(preparedAt)}${seeded ? ` (${seeded.replaceAll('\n', ', ')})` : ''}`);
  }
  console.log(`sandbox ${sandbox.displayName}  id ${sandbox.uid}  volume ${volume.name}  kit ${mode.kit}  ready in ${since(startedAt)}`);
  return sandbox;
}

interface TelegramStatus {
  pid?: number;
  state?: string;
  error?: string;
}

// The gateway's own status record; its platform keys are "<profile>:<platform>".
async function telegramStatus(sandbox: Sandbox): Promise<TelegramStatus | undefined> {
  const result = await sandbox.processes.run({ args: ['cat', GATEWAY_STATE_FILE] }, LONG_CALL);
  if (result.exitCode !== 0) return undefined;
  const record = JSON.parse(result.stdout);
  const telegram = record.platforms?.[`${PROFILE}:telegram`];
  return { pid: record.pid, state: telegram?.state, error: telegram?.error_message };
}

async function gatewayOutput(gateway: Process): Promise<string> {
  const output = await gateway.readOutput({ resumeFrom: 0 });
  const decoder = new TextDecoder();
  return (output.chunks ?? []).map((chunk) => decoder.decode(chunk.data, { stream: true })).join('').trim();
}

async function startGateway(sandbox: Sandbox): Promise<void> {
  const startedAt = performance.now();
  // Default home, since Hermes 0.22 gives a profile no gateway of its own; --replace takes over a running one.
  // No label: todd keeps labels unique across exited processes too, so a rerun would collide.
  let gateway = await sandbox.processes.start({
    args: ['sh', '-lc', 'exec hermes gateway run --replace', 'hermes-gateway'],
    env: { HERMES_HOME: ROOT_HOME },
  });
  let status: TelegramStatus | undefined;
  while (performance.now() < startedAt + GATEWAY_SETTLE_MS) {
    await setTimeout(POLL_MS);
    gateway = await gateway.refresh();
    if (gateway.state !== 'running') fail(`the gateway exited ${gateway.exitCode}:\n${await gatewayOutput(gateway)}`);
    status = await telegramStatus(sandbox);
    // Until the new gateway writes its own record, the file may still describe the one it replaced.
    if (!status || status.pid !== gateway.pid) continue;
    if (status.state === 'connected') {
      console.log(`gateway connected to Telegram in ${since(startedAt)} (pid ${gateway.pid})`);
      return;
    }
    if (status.state === 'fatal') fail(`the gateway could not connect to Telegram: ${status.error}`);
  }
  fail(`the gateway had not connected to Telegram after ${since(startedAt)} (state ${status?.state ?? 'unknown'})`);
}

async function telegramConfigured(sandbox: Sandbox): Promise<boolean> {
  const result = await sandbox.processes.run(
    { args: ['grep', '-qs', '^TELEGRAM_BOT_TOKEN=.', `${HERMES_HOME}/.env`] },
    LONG_CALL,
  );
  return result.exitCode === 0;
}

async function storeTelegram(client: Sandboxes, state: State, userId: string | undefined): Promise<void> {
  if (!userId || !/^\d+$/.test(userId)) fail('telegram needs --user-id <your numeric Telegram user ID>');
  const sandbox = await runningSandbox(client, state);
  if (process.stdin.isTTY) fail('pipe the bot token on stdin; it is never taken from arguments');
  const token = (await text(process.stdin)).trim();
  // Hermes' own check for a bot token from @BotFather.
  if (!/^\d+:[A-Za-z0-9_-]{30,}$/.test(token)) fail('stdin does not look like a Telegram bot token');
  const result = await sandbox.processes.run(
    {
      args: ['sh', '-c', WRITE_TELEGRAM_ENV, 'telegram-env'],
      env: { HERMES_HOME, TELEGRAM_BOT_TOKEN: token, TELEGRAM_ALLOWED_USERS: userId },
    },
    LONG_CALL,
  );
  outputOf(result, 'writing the Telegram settings');
  console.log(`stored the bot token and TELEGRAM_ALLOWED_USERS=${userId} in ${HERMES_HOME}/.env`);
  await startGateway(sandbox);
}

async function cycle(client: Sandboxes, state: State): Promise<void> {
  let sandbox = await recordedSandbox(client, state);
  if (sandbox.status === 'running') {
    const stoppedAt = performance.now();
    sandbox = await (await sandbox.stop(LONG_CALL)).waitUntilStopped(LONG_CALL);
    console.log(`stopped (hibernated) in ${since(stoppedAt)}`);
  }
  if (sandbox.status !== 'stopped') fail(`${sandbox.name} is ${sandbox.status}; try again once it settles`);
  const startedAt = performance.now();
  sandbox = await (await sandbox.start(LONG_CALL)).waitUntilRunning(LONG_CALL);
  console.log(`started (resumed) in ${since(startedAt)}; ${sandbox.uid} is ${sandbox.status}`);
}

async function removeSandbox(client: Sandboxes, state: State): Promise<void> {
  if (!state.sandbox) fail('no sandbox recorded; run launch first');
  const deletedAt = performance.now();
  try {
    const sandbox = await client.get(state.sandbox);
    const deleting = await sandbox.delete({}, LONG_CALL);
    await deleting?.waitUntilDeleted(LONG_CALL);
    console.log(`deleted ${sandbox.uid} in ${since(deletedAt)}`);
  } catch (error) {
    if (!(error instanceof NotFoundError)) throw error;
    console.log(`${state.sandbox} was already deleted`);
  }
  state.sandbox = undefined;
  await saveState(state);
}

async function upgrade(client: Sandboxes, state: State, kit: string | undefined): Promise<void> {
  if (!state.mode) fail('no launch recorded; run launch first');
  const startedAt = performance.now();
  await removeSandbox(client, state);
  // Launches recorded before --kit existed have no kit in .state.json.
  const sandbox = await launch(client, state, { ...state.mode, kit: kit ?? state.mode.kit ?? DEFAULT_KIT });
  if (await telegramConfigured(sandbox)) await startGateway(sandbox);
  console.log(`upgrade took ${since(startedAt)}`);
}

async function status(client: Sandboxes, state: State): Promise<void> {
  console.log(`env      ${state.env}`);
  if (state.sandbox) {
    const sandbox = await recordedSandbox(client, state);
    const features = sandbox.effectiveFeatures;
    console.log(`sandbox  ${sandbox.displayName}  ${sandbox.uid}  ${sandbox.status}`);
    console.log(
      `timeout  onTimeout ${features?.timeouts?.onTimeout}  autoResume ${features?.lifecycle.autoResume}  next ${features?.timeouts?.expiresAt?.toISOString()}`,
    );
    if (sandbox.status === 'running') {
      const telegram = await telegramStatus(sandbox);
      console.log(`telegram ${telegram?.state ?? 'no gateway'}${telegram?.error ? `: ${telegram.error}` : ''}`);
    }
  } else {
    console.log('sandbox  none');
  }
  console.log(`volume   ${state.volume ?? 'none'}  mounted at ${HERMES_HOME}`);
  console.log(`mode     ${state.mode ? (state.mode.kitHook ? 'kit-hook' : 'prepare') : 'none'}`);
  console.log(`kit      ${state.mode ? (state.mode.kit ?? DEFAULT_KIT) : 'none'}`);
  const secret = await findModelSecret(client);
  console.log(`secret   ${secret?.name ?? 'none'}${state.createdSecret ? ' (created here)' : ''}`);
}

async function destroy(client: Sandboxes, state: State, withVolume: boolean, withSecret: boolean): Promise<void> {
  if (state.sandbox) await removeSandbox(client, state);
  if (withVolume) {
    const volume = await findVolume(client);
    if (volume) await volume.delete();
    state.volume = undefined;
    state.mode = undefined;
    console.log(volume ? `deleted volume ${volume.name}` : 'no volume to delete');
  }
  if (withSecret) {
    if (state.createdSecret) {
      await (await client.secrets.get(state.createdSecret)).delete();
      console.log(`deleted secret ${state.createdSecret}`);
      state.createdSecret = undefined;
    } else {
      console.log('no secret created by this tool; leaving secrets alone');
    }
  }
  await saveState(state);
}

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      env: { type: 'string', default: 'prod' },
      kit: { type: 'string' },
      'user-id': { type: 'string' },
      'kit-hook': { type: 'boolean', default: false },
      'always-on': { type: 'boolean', default: false },
      'on-timeout': { type: 'string', default: 'restart' },
      volume: { type: 'boolean', default: false },
      secret: { type: 'boolean', default: false },
    },
  });
  const [command, input] = positionals;
  const baseUrl = BASE_URLS[values.env];
  if (!baseUrl) fail(`refusing --env ${values.env}: only prod and stage are known`);
  const onTimeout = values['on-timeout'];
  if (onTimeout !== 'restart' && onTimeout !== 'stop') fail('--on-timeout must be restart or stop');
  const token = process.env.DOCKER_ACCESS_TOKEN;
  if (!token) fail(`DOCKER_ACCESS_TOKEN is not set; sign in to ${values.env} first`);
  const needsInput = ['ask', 'remember', 'recall'].includes(command ?? '');
  if (needsInput && !input) fail(`${command} needs a quoted argument`);

  // The auth helpers export a /v1 SANDBOXES_API_URL, which SDK 0.53.0 rejects even beside an explicit baseUrl.
  delete process.env.SANDBOXES_API_URL;
  const client = new Sandboxes({ accessToken: token, baseUrl });
  const state = await loadState(values.env);
  try {
    switch (command) {
      case 'secret':
        return await storeSecret(client, state);
      case 'launch':
        await launch(client, state, {
          kit: values.kit ?? DEFAULT_KIT,
          kitHook: values['kit-hook'],
          alwaysOn: values['always-on'],
          onTimeout,
        });
        return;
      case 'telegram':
        return await storeTelegram(client, state, values['user-id']);
      case 'ask':
      case 'recall':
        console.log(await hermes(await runningSandbox(client, state), ['-z', input!]));
        return;
      case 'remember':
        return await remember(await runningSandbox(client, state), input!);
      case 'cycle':
        return await cycle(client, state);
      case 'upgrade':
        return await upgrade(client, state, values.kit);
      case 'status':
        return await status(client, state);
      case 'destroy':
        return await destroy(client, state, values.volume, values.secret);
      default:
        fail(USAGE);
    }
  } finally {
    await client.close();
  }
}

main().catch((error: unknown) => {
  if (error instanceof CliError) {
    console.error(error.message);
  } else if (error instanceof SandboxesError) {
    console.error(`error: ${error.message}${error.requestId ? ` (request ${error.requestId})` : ''}`);
    const detail = (error as { raw?: { message?: string; details?: unknown } }).raw;
    if (detail?.message || detail?.details) console.error(`detail: ${JSON.stringify({ message: detail.message, details: detail.details })}`);
  } else {
    console.error(error);
  }
  process.exitCode = 1;
});
