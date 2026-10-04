import type { ProviderUserInputAnswers, RuntimeMode } from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as Scope from "effect/Scope";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import type * as EffectAcpSchema from "effect-acp/compat";
import type * as EffectAcpErrors from "effect-acp/errors";

import * as AcpSessionRuntime from "./AcpSessionRuntime.ts";

/** Auth is a one-time `cmd login`; ACP only checks the stored credential. */
export const COMMAND_CODE_AUTH_METHOD_ID = "command-code-cli";

/**
 * Runtime modes with a native Command Code session mode. Command Code's
 * `dont-ask` mode keeps its own safety rails and has no T3 equivalent, so Auto
 * is not offered.
 */
export const COMMAND_CODE_SUPPORTED_RUNTIME_MODES = [
  "approval-required",
  "auto-accept-edits",
  "full-access",
] as const satisfies ReadonlyArray<RuntimeMode>;

/** Native `session/set_mode` ids advertised by `cmd acp`. */
export function commandCodeSessionMode(runtimeMode: RuntimeMode): string | undefined {
  switch (runtimeMode) {
    case "approval-required":
      return "default";
    case "auto-accept-edits":
      return "auto-accept";
    case "full-access":
      return "bypass";
    default:
      return undefined;
  }
}

interface CommandCodeAcpRuntimeInput extends Omit<
  AcpSessionRuntime.AcpSessionRuntimeOptions,
  "spawn"
> {
  readonly childProcessSpawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
  readonly binaryPath: string | null | undefined;
  readonly environment?: NodeJS.ProcessEnv;
}

export const makeCommandCodeAcpRuntime = (
  input: CommandCodeAcpRuntimeInput,
): Effect.Effect<
  AcpSessionRuntime.AcpSessionRuntime["Service"],
  EffectAcpErrors.AcpError,
  Crypto.Crypto | Scope.Scope
> =>
  Effect.gen(function* () {
    const { binaryPath, environment, childProcessSpawner, ...options } = input;
    const context = yield* Layer.build(
      AcpSessionRuntime.layer({
        ...options,
        spawn: {
          command: binaryPath || "command-code",
          args: ["acp"],
          cwd: options.cwd,
          ...(environment === undefined ? {} : { env: environment }),
        },
      }).pipe(
        Layer.provide(Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, childProcessSpawner)),
      ),
    );
    return yield* Effect.service(AcpSessionRuntime.AcpSessionRuntime).pipe(Effect.provide(context));
  });

const optionLabel = (option: EffectAcpSchema.PermissionOption) => option.name.trim();

/**
 * `ask_user_question` arrives as a permission request whose options are
 * `option_<index>`, one per question choice. Treating it as an approval would
 * silently answer with the first choice, so the adapter asks the user instead.
 */
export function extractCommandCodeQuestion(request: EffectAcpSchema.RequestPermissionRequest) {
  const rawInput = request.toolCall.rawInput;
  const choices =
    typeof rawInput === "object" && rawInput !== null && "options" in rawInput
      ? rawInput.options
      : undefined;
  if (
    !Array.isArray(choices) ||
    choices.length === 0 ||
    request.options.length !== choices.length ||
    !request.options.every((option, index) => option.optionId === `option_${index}`)
  ) {
    return undefined;
  }
  const title = request.toolCall.title?.trim() || "Choose an option.";
  const labelAt = (index: number) => {
    const choice = choices[index];
    return typeof choice === "string" && choice.trim()
      ? choice.trim()
      : optionLabel(request.options[index]!);
  };
  return {
    question: {
      id: request.toolCall.toolCallId,
      header: "Question",
      question: title,
      options: request.options.map((option, index) => ({
        label: labelAt(index),
        description: optionLabel(option),
      })),
      multiSelect: false,
    },
    respond: (
      answers: ProviderUserInputAnswers,
    ): EffectAcpSchema.RequestPermissionResponse | undefined => {
      const raw = answers[request.toolCall.toolCallId];
      const answer = Array.isArray(raw) ? raw[0] : raw;
      const matches = request.options.filter((_, index) => labelAt(index) === answer);
      return matches.length === 1
        ? { outcome: { outcome: "selected", optionId: matches[0]!.optionId } }
        : undefined;
    },
  };
}
