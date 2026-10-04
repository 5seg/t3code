# Command Code

T3 Code can use your existing Command Code CLI installation (`command-code`, also installed as `cmd`) while keeping its account,
models, and native session history. Threads run through `cmd acp`.

## Set Up Command Code

1. Install Command Code on the machine running the T3 Code server (`npm i -g command-code`).
2. Run `cmd login` once in a terminal and finish the sign-in.
3. Open T3 Code Settings, enable Command Code, and refresh the provider.

If `command-code` is not on the server's `PATH`, set Command Code's binary path to the executable. T3 Code
reads the account you already signed in to; it does not ask for a separate token and cannot sign
in for you. If the provider shows as not logged in, run `cmd login` and refresh.

## What Carries Over

The model picker lists the models from `cmd --list-models`, plus a `Command Code default` entry
that keeps whichever model Command Code has configured. Custom models you add can also carry a
reasoning effort option. Effort levels differ by model, and a level the model does not offer is
ignored. Threads resume their native Command Code session, and Command Code's MCP, image, and
`/compact` support are available in the composer.

## Permission Modes

T3 Code applies the composer permission mode through Command Code's native session modes:

- **Supervised** runs `default` mode: tools that change anything ask for approval.
- **Auto-accept edits** runs `auto-accept`: file edits proceed, riskier actions still ask.
- **Full access** runs `bypass`: Command Code skips its permission checks.

The **Auto** option is not shown because Command Code has no equivalent classifier mode. The
**Plan** toggle selects Command Code's `plan` mode. Changing the permission mode restarts the
provider session and resumes the same conversation.

Questions that Command Code asks appear in T3 Code's question panel.

## Limits

- Reverting a thread does not truncate Command Code's conversation; the next turn starts a fresh
  Command Code session.
- Command Code is not used for T3's own text generation (thread titles, commit messages, PR
  descriptions). Configure another provider for those actions.

## Troubleshooting

- If Command Code shows as not installed, confirm `cmd --version` runs on the server machine, set
  the binary path, and refresh.
- If no models appear, the provider keeps the `Command Code default` entry. Confirm
  `cmd --list-models` works on the server.
