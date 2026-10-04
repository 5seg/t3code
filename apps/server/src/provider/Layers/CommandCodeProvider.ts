import {
  type CommandCodeSettings,
  type CustomModelSetting,
  type ServerProviderModel,
} from "@t3tools/contracts";
import { causeErrorTag } from "@t3tools/shared/observability";
import { createModelCapabilities } from "@t3tools/shared/model";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import {
  buildServerProvider,
  COMPACT_SLASH_COMMAND,
  isCommandMissingCause,
  parseGenericCliVersion,
  providerModelsFromSettings,
  spawnAndCollect,
  type ServerProviderDraft,
} from "../providerSnapshot.ts";
import {
  COMMAND_CODE_AUTH_METHOD_ID,
  makeCommandCodeAcpRuntime,
} from "../acp/CommandCodeAcpSupport.ts";

const COMMAND_CODE_PRESENTATION = {
  displayName: "Command Code",
  supportsConversationRollback: false,
  showInteractionModeToggle: true,
} as const;

// `cmd` is a large Node bundle: even `--version` takes several seconds to start.
const VERSION_PROBE_TIMEOUT_MS = 15_000;
const MODEL_LIST_TIMEOUT_MS = 20_000;
const ACP_AUTH_PROBE_TIMEOUT_MS = 20_000;
const EMPTY_CAPABILITIES = createModelCapabilities({ optionDescriptors: [] });

// "default" keeps the model Command Code has configured (`cmd` settings).
const COMMAND_CODE_DEFAULT_MODEL: ServerProviderModel = {
  slug: "default",
  name: "Command Code default",
  isCustom: false,
  isDefault: true,
  capabilities: EMPTY_CAPABILITIES,
};

function commandCodeModelsFromSettings(
  customModels: ReadonlyArray<CustomModelSetting> | undefined,
  discovered: ReadonlyArray<ServerProviderModel> = [],
): ReadonlyArray<ServerProviderModel> {
  return providerModelsFromSettings(
    [COMMAND_CODE_DEFAULT_MODEL, ...discovered],
    customModels ?? [],
    EMPTY_CAPABILITIES,
  );
}

/**
 * Parses `cmd --list-models`: one `<id>  <description>` row per model under
 * group headings, followed by usage text. Parsing stops at that usage text so
 * headless-only decision models are not offered to chat threads.
 * Reasoning effort is per model and only known to a live session, so the list
 * carries no effort options.
 */
function parseCommandCodeModelList(output: string): ReadonlyArray<ServerProviderModel> {
  const models: ServerProviderModel[] = [];
  const seen = new Set<string>();
  for (const line of output.split(/\r?\n/)) {
    if (line.startsWith("Pass the full id")) break;
    const slug = line.match(/^([a-z0-9][a-z0-9._:@/-]*)\s{2,}\S/)?.[1];
    if (slug === undefined || seen.has(slug)) continue;
    seen.add(slug);
    models.push({ slug, name: slug, isCustom: false, capabilities: EMPTY_CAPABILITIES });
  }
  return models;
}

export function buildInitialCommandCodeProviderSnapshot(
  settings: CommandCodeSettings,
): Effect.Effect<ServerProviderDraft> {
  return Effect.gen(function* () {
    const checkedAt = yield* Effect.map(DateTime.now, DateTime.formatIso);
    return buildServerProvider({
      presentation: COMMAND_CODE_PRESENTATION,
      enabled: settings.enabled,
      checkedAt,
      models: commandCodeModelsFromSettings(settings.customModels),
      probe: {
        installed: settings.enabled,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: settings.enabled
          ? "Checking Command Code CLI availability..."
          : "Command Code is disabled in T3 Code settings.",
      },
    });
  });
}

const runCommandCodeCli = (
  settings: CommandCodeSettings,
  args: ReadonlyArray<string>,
  environment: NodeJS.ProcessEnv,
) =>
  Effect.gen(function* () {
    const command = settings.binaryPath || "command-code";
    const spawnCommand = yield* resolveSpawnCommand(command, args, { env: environment });
    return yield* spawnAndCollect(
      command,
      ChildProcess.make(spawnCommand.command, spawnCommand.args, {
        env: environment,
        shell: spawnCommand.shell,
      }),
    );
  });

/**
 * `authenticate` against `cmd acp` only checks the stored `cmd login`
 * credential: it opens no session, starts no MCP servers, and never starts a
 * browser login. A missing login answers with ACP's `auth_required` (-32000).
 */
const probeCommandCodeAuth = (settings: CommandCodeSettings, environment: NodeJS.ProcessEnv) =>
  Effect.gen(function* () {
    const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const acp = yield* makeCommandCodeAcpRuntime({
      binaryPath: settings.binaryPath,
      environment,
      childProcessSpawner,
      cwd: process.cwd(),
      clientInfo: { name: "t3-code-provider-probe", version: "0.0.0" },
    });
    yield* acp.initialize();
    return yield* acp.authenticate(COMMAND_CODE_AUTH_METHOD_ID).pipe(
      Effect.as("authenticated" as const),
      Effect.catchTag("AcpRequestError", (error) =>
        error.code === -32000 ? Effect.succeed("unauthenticated" as const) : Effect.fail(error),
      ),
      // effect-acp surfaces a JSON-RPC error response from the agent as a
      // defect rather than a typed `AcpRequestError`; it also means logged out.
      // Transport failures and process exits stay failures.
      Effect.catchDefect(() => Effect.succeed("unauthenticated" as const)),
    );
  }).pipe(Effect.scoped);

export const checkCommandCodeProviderStatus = Effect.fn("checkCommandCodeProviderStatus")(
  function* (
    settings: CommandCodeSettings,
    environment: NodeJS.ProcessEnv = process.env,
  ): Effect.fn.Return<
    ServerProviderDraft,
    never,
    ChildProcessSpawner.ChildProcessSpawner | Crypto.Crypto
  > {
    const checkedAt = DateTime.formatIso(yield* DateTime.now);
    const fallbackModels = commandCodeModelsFromSettings(settings.customModels);
    const draft = (
      probe: Parameters<typeof buildServerProvider>[0]["probe"],
      extra: Partial<Parameters<typeof buildServerProvider>[0]> = {},
    ) =>
      buildServerProvider({
        presentation: COMMAND_CODE_PRESENTATION,
        enabled: settings.enabled,
        checkedAt,
        models: fallbackModels,
        probe,
        ...extra,
      });

    if (!settings.enabled) {
      return draft({
        installed: false,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: "Command Code is disabled in T3 Code settings.",
      });
    }

    const versionResult = yield* runCommandCodeCli(settings, ["--version"], environment).pipe(
      Effect.timeoutOption(VERSION_PROBE_TIMEOUT_MS),
      Effect.result,
    );
    if (Result.isFailure(versionResult)) {
      const error = versionResult.failure;
      yield* Effect.logWarning("Command Code CLI health check failed.", { errorTag: error._tag });
      return draft({
        installed: !isCommandMissingCause(error),
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message: isCommandMissingCause(error)
          ? "Command Code CLI (`command-code`) is not installed or not on PATH."
          : "Failed to execute Command Code CLI health check.",
      });
    }
    if (Option.isNone(versionResult.success)) {
      return draft({
        installed: true,
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message: "Command Code CLI is installed but timed out while running `--version`.",
      });
    }
    const versionOutput = versionResult.success.value;
    const version = parseGenericCliVersion(`${versionOutput.stdout}\n${versionOutput.stderr}`);
    if (versionOutput.code !== 0) {
      return draft({
        installed: true,
        version,
        status: "error",
        auth: { status: "unknown" },
        message: "Command Code CLI is installed but failed to run.",
      });
    }

    const [modelsResult, authExit] = yield* Effect.all(
      [
        runCommandCodeCli(settings, ["--list-models"], environment).pipe(
          Effect.timeoutOption(MODEL_LIST_TIMEOUT_MS),
          Effect.result,
        ),
        probeCommandCodeAuth(settings, environment).pipe(
          Effect.timeoutOption(ACP_AUTH_PROBE_TIMEOUT_MS),
          Effect.exit,
        ),
      ],
      { concurrency: "unbounded" },
    );

    const discovered =
      Result.isSuccess(modelsResult) &&
      Option.isSome(modelsResult.success) &&
      modelsResult.success.value.code === 0
        ? parseCommandCodeModelList(modelsResult.success.value.stdout)
        : [];
    if (discovered.length === 0) {
      yield* Effect.logWarning("Command Code model listing failed or timed out.");
    }
    const models = commandCodeModelsFromSettings(settings.customModels, discovered);

    const authStatus = Exit.isSuccess(authExit) ? Option.getOrUndefined(authExit.value) : undefined;
    if (authStatus === undefined) {
      yield* Effect.logWarning("Command Code ACP auth probe failed or timed out.", {
        errorTag: Exit.isFailure(authExit) ? causeErrorTag(authExit.cause) : "Timeout",
      });
    }

    if (authStatus === "unauthenticated") {
      return draft(
        {
          installed: true,
          version,
          status: "error",
          auth: { status: "unauthenticated" },
          message: "Command Code is not logged in. Run `command-code login` in a terminal.",
        },
        { models },
      );
    }
    return draft(
      {
        installed: true,
        version,
        // A failed ACP probe leaves login state unknown; chats report auth errors themselves.
        status: authStatus === undefined ? "warning" : "ready",
        auth:
          authStatus === undefined
            ? { status: "unknown" }
            : { status: "authenticated", label: "Command Code account" },
        ...(authStatus === undefined
          ? { message: "Command Code CLI is installed but the ACP check failed." }
          : {}),
      },
      { models, slashCommands: [COMPACT_SLASH_COMMAND] },
    );
  },
);
