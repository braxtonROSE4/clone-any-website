# Install ego lite (the ego-browser runtime)

Read this file only when the `ego-browser` command is missing, when `ego-browser skill` reports an unknown command, or when the user asks to install ego lite. For cloning work, go back to `SKILL.md`.

This skill drives every live-page operation through the `ego-browser` CLI, which is provided by the ego lite browser app. Once ego lite is installed and first-run onboarding is done, the environment is ready and stays ready.

ego lite website: https://lite.ego.app/

## ego lite is installed but too old

If `ego-browser` exists but `ego-browser skill` prints `Unknown command: skill`, or a script fails with `taskSpace is not defined`, the installed ego lite predates the API these scripts use. Ask the user for approval, then run:

```bash
ego-browser upgrade
```

If `upgrade` is also an unknown command, reinstall with the steps below. Afterwards run `ego-browser skill` and confirm its output ends with a line starting `[ego-browser:skill] end of guide`.

## macOS

Run the vendored installer with its actual path under this skill's directory:

```bash
sh <path-to-this-skill>/scripts/install-ego-browser.sh
```

The script:
- Downloads the ego lite installer DMG for the machine's CPU architecture (arm64 / x64), retrying three times.
- Installs `ego lite.app` to `/Applications`, falling back to `~/Applications` when needed.
- Strips the quarantine attribute so Gatekeeper does not block the first launch.
- Launches ego lite. If ego lite is already installed, it skips the download and just opens the app.

If the first launch is still blocked, the user allows ego lite under System Settings → Privacy & Security.

## Windows

There is no install script. The user downloads the installer from https://lite.ego.app/, runs it, and opens ego lite. If SmartScreen blocks the installer, they choose "More info" and then "Run anyway". Run this skill's scripts from Git Bash: the heredocs, `bash scripts/run_eval.sh`, and `python3` assume a POSIX shell.

## Other platforms

There is no installer. Have the user check https://lite.ego.app/ for a build; if none exists, this skill cannot run on that machine.

## Onboarding, a user step you must wait for

After ego lite opens, the user completes first-run onboarding in the app:
- Optionally import data from Chrome or another browser.
- Onboarding registers the `ego-browser` command on the PATH (on macOS usually under `~/.local/bin`).

Tell the user exactly this, then stop and wait for their confirmation that onboarding is finished. Do not poll, do not retry browser commands in a loop while they onboard.

## Confirm and resume

On Windows, open a new terminal first: an existing one keeps the PATH it started with.

```bash
command -v ego-browser
```

If nothing prints on macOS, `~/.local/bin` is most likely missing from the current PATH:

```bash
export PATH="$HOME/.local/bin:$PATH"
command -v ego-browser
```

Then verify the runtime and print the usage guide for the installed version:

```bash
ego-browser nodejs <<'EOF'
console.log('ego-browser ready')
EOF
ego-browser skill
```

`ego-browser ready` plus a guide ending in `[ego-browser:skill] end of guide` means the environment is ready: return to `SKILL.md` and continue from where the task stopped. If the command is still missing after onboarding, have the user reopen ego lite, finish onboarding, and open a new terminal before investigating anything else.
