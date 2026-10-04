import { describe, expect, it } from "@effect/vitest";
import type * as EffectAcpSchema from "effect-acp/compat";

import {
  commandCodeSessionMode,
  extractCommandCodeQuestion,
  COMMAND_CODE_SUPPORTED_RUNTIME_MODES,
} from "./CommandCodeAcpSupport.ts";

const questionRequest = {
  sessionId: "session-1",
  toolCall: {
    toolCallId: "question-1",
    title: "Database: Which database should I use?",
    kind: "other",
    status: "pending",
    rawInput: { question: "Which database should I use?", options: ["Postgres", "SQLite"] },
  },
  options: [
    { optionId: "option_0", name: "Postgres: production grade", kind: "allow_once" },
    { optionId: "option_1", name: "SQLite", kind: "allow_once" },
  ],
} satisfies EffectAcpSchema.RequestPermissionRequest;

describe("commandCodeSessionMode", () => {
  it("maps every offered runtime mode to a native session mode", () => {
    expect(COMMAND_CODE_SUPPORTED_RUNTIME_MODES.map(commandCodeSessionMode)).toEqual([
      "default",
      "auto-accept",
      "bypass",
    ]);
  });

  it("leaves Auto without a native mode, since Command Code has no equivalent", () => {
    expect(commandCodeSessionMode("auto")).toBeUndefined();
  });
});

describe("extractCommandCodeQuestion", () => {
  it("presents the choices as a question instead of an approval", () => {
    const extracted = extractCommandCodeQuestion(questionRequest);

    expect(extracted?.question).toEqual({
      id: "question-1",
      header: "Question",
      question: "Database: Which database should I use?",
      options: [
        { label: "Postgres", description: "Postgres: production grade" },
        { label: "SQLite", description: "SQLite" },
      ],
      multiSelect: false,
    });
  });

  it("answers with the option id of the chosen label", () => {
    const extracted = extractCommandCodeQuestion(questionRequest);

    expect(extracted?.respond({ "question-1": "SQLite" })).toEqual({
      outcome: { outcome: "selected", optionId: "option_1" },
    });
    expect(extracted?.respond({ "question-1": ["Postgres"] })).toEqual({
      outcome: { outcome: "selected", optionId: "option_0" },
    });
  });

  it("keeps the question open for an answer that matches no choice", () => {
    const extracted = extractCommandCodeQuestion(questionRequest);

    expect(extracted?.respond({ "question-1": "MySQL" })).toBeUndefined();
    expect(extracted?.respond({})).toBeUndefined();
  });

  it("does not treat an ordinary approval request as a question", () => {
    expect(
      extractCommandCodeQuestion({
        sessionId: "session-1",
        toolCall: {
          toolCallId: "edit-1",
          title: "Edit file",
          kind: "edit",
          status: "pending",
          rawInput: { file_path: "a.txt" },
        },
        options: [
          { optionId: "allow_once", name: "Allow once", kind: "allow_once" },
          { optionId: "reject_once", name: "Reject", kind: "reject_once" },
        ],
      }),
    ).toBeUndefined();
  });

  it("rejects options that do not line up with the question choices", () => {
    expect(
      extractCommandCodeQuestion({
        ...questionRequest,
        options: questionRequest.options.slice(0, 1),
      }),
    ).toBeUndefined();
    expect(
      extractCommandCodeQuestion({
        ...questionRequest,
        options: [
          { optionId: "option_1", name: "Postgres", kind: "allow_once" },
          { optionId: "option_0", name: "SQLite", kind: "allow_once" },
        ],
      }),
    ).toBeUndefined();
  });
});
