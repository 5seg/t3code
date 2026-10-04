import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";
import { CommandCodeSettings } from "@t3tools/contracts";

import { writeFakeCli } from "../../testUtils/fakeCli.ts";
import {
  buildInitialCommandCodeProviderSnapshot,
  checkCommandCodeProviderStatus,
} from "./CommandCodeProvider.ts";

const decodeSettings = Schema.decodeSync(CommandCodeSettings);

const MODEL_LIST_OUTPUT = [
  "Available models  ·  3 models",
  "",
  "Open Source",
  "",
  "deepseek/deepseek-v4-pro               hybrid-attention long-context reasoning",
  "poolside/laguna-s-2.1-free             FREE open-weight agentic coding",
  "",
  "Anthropic",
  "",
  "claude-sonnet-5-5                      best combo of speed & intelligence (recommended)",
  "",
  'Pass the full id, or just the short name after the last "/":',
  "command-code --model moonshotai/kimi-k2.5",
  "",
  "Docs:  https://commandcode.ai/docs/reference/cli/models",
  "",
  "Decision models (headless only)",
  "typesafe/jev  typed questions in, probabilities out",
  "",
].join("\n");

// Stands in for `command-code`: `--version` and `--list-models` print canned
// text, and `acp` answers `initialize` and `authenticate` the way the real
// agent does, failing `authenticate` with auth_required (-32000) when logged out.
const fakeCliSource = (input: {
  readonly versionExitCode: number;
  readonly loggedIn: boolean;
  readonly acpStarts: boolean;
}) =>
  [
    "const args = process.argv.slice(2);",
    'if (args[0] === "--version") {',
    '  process.stdout.write("1.74.1\\n");',
    `  process.exit(${input.versionExitCode});`,
    "}",
    'if (args[0] === "--list-models") {',
    // @effect-diagnostics-next-line preferSchemaOverJson:off
    `  process.stdout.write(${JSON.stringify(MODEL_LIST_OUTPUT)});`,
    "  process.exit(0);",
    "}",
    'if (args[0] !== "acp") process.exit(1);',
    ...(input.acpStarts ? [] : ["process.exit(3);"]),
    'process.stdin.setEncoding("utf8");',
    'let buffer = "";',
    'process.stdin.on("data", (chunk) => {',
    "  buffer += chunk;",
    "  let newline;",
    '  while ((newline = buffer.indexOf("\\n")) >= 0) {',
    "    const line = buffer.slice(0, newline);",
    "    buffer = buffer.slice(newline + 1);",
    "    if (!line.trim()) continue;",
    "    const message = JSON.parse(line);",
    '    const reply = (body) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, ...body }) + "\\n");',
    '    if (message.method === "initialize") {',
    "      reply({ result: {",
    "        protocolVersion: 1,",
    "        agentCapabilities: { loadSession: true },",
    '        authMethods: [{ id: "command-code-cli", name: "Command Code CLI login" }],',
    '        agentInfo: { name: "Command Code", version: "1.74.1" },',
    "      } });",
    '    } else if (message.method === "authenticate") {',
    input.loggedIn
      ? "      reply({ result: {} });"
      : '      reply({ error: { code: -32000, message: "Not authenticated." } });',
    "    }",
    "  }",
    "});",
  ].join("\n");

const probeFakeCli = (input: Parameters<typeof fakeCliSource>[0]) =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3code-command-code-" });
      const binaryPath = writeFakeCli({
        directory,
        name: "command-code",
        source: fakeCliSource(input),
      });
      return yield* checkCommandCodeProviderStatus(
        decodeSettings({ enabled: true, binaryPath }),
        process.env,
      );
    }),
  );

describe("buildInitialCommandCodeProviderSnapshot", () => {
  it.effect("reports a disabled provider as not checked", () =>
    Effect.gen(function* () {
      const snapshot = yield* buildInitialCommandCodeProviderSnapshot(
        decodeSettings({ enabled: false }),
      );

      expect(snapshot.enabled).toBe(false);
      expect(snapshot.status).toBe("disabled");
      expect(snapshot.models.map((model) => model.slug)).toEqual(["default"]);
    }),
  );
});

it.layer(NodeServices.layer)("checkCommandCodeProviderStatus", (it) => {
  it.effect("reports the binary as missing when the path does not resolve", () =>
    Effect.gen(function* () {
      const snapshot = yield* checkCommandCodeProviderStatus(
        decodeSettings({ enabled: true, binaryPath: "/definitely/not/installed/command-code" }),
        process.env,
      );

      expect(snapshot.installed).toBe(false);
      expect(snapshot.status).toBe("error");
      expect(snapshot.message).toMatch(/not installed|not on PATH|Failed to execute/);
    }),
  );

  it.effect("reports an installed CLI as unhealthy when --version exits non-zero", () =>
    Effect.gen(function* () {
      const snapshot = yield* probeFakeCli({
        versionExitCode: 2,
        loggedIn: true,
        acpStarts: true,
      });

      expect(snapshot.installed).toBe(true);
      expect(snapshot.status).toBe("error");
      expect(snapshot.message).toBe("Command Code CLI is installed but failed to run.");
    }),
  );

  it.effect("reports ready with the listed models when logged in", () =>
    Effect.gen(function* () {
      const snapshot = yield* probeFakeCli({
        versionExitCode: 0,
        loggedIn: true,
        acpStarts: true,
      });

      expect(snapshot.status).toBe("ready");
      expect(snapshot.version).toBe("1.74.1");
      expect(snapshot.auth.status).toBe("authenticated");
      // Group headings, usage text, and headless-only decision models are not models.
      expect(snapshot.models.map((model) => model.slug)).toEqual([
        "default",
        "deepseek/deepseek-v4-pro",
        "poolside/laguna-s-2.1-free",
        "claude-sonnet-5-5",
      ]);
      expect(snapshot.models.find((model) => model.isDefault)?.slug).toBe("default");
      expect(snapshot.slashCommands.map((command) => command.name)).toContain("compact");
    }),
  );

  it.effect("tells a logged-out user to run login while still listing models", () =>
    Effect.gen(function* () {
      const snapshot = yield* probeFakeCli({
        versionExitCode: 0,
        loggedIn: false,
        acpStarts: true,
      });

      expect(snapshot.status).toBe("error");
      expect(snapshot.auth.status).toBe("unauthenticated");
      expect(snapshot.message).toContain("login");
      expect(snapshot.models.length).toBeGreaterThan(1);
    }),
  );

  it.effect("degrades to a warning with unknown auth when the ACP agent cannot start", () =>
    Effect.gen(function* () {
      const snapshot = yield* probeFakeCli({
        versionExitCode: 0,
        loggedIn: true,
        acpStarts: false,
      });

      expect(snapshot.status).toBe("warning");
      expect(snapshot.auth.status).toBe("unknown");
    }),
  );
});
