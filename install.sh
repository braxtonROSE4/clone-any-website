#!/bin/sh
# Install the clone-website skill for any agent that reads the Agent Skills standard.
#
#   curl -fsSL https://raw.githubusercontent.com/braxtonROSE4/clone-any-website/main/install.sh | sh
#
# Installs once into the vendor-neutral ~/.agents/skills/clone-website, then symlinks
# that one copy into the skills directory of every agent found on this machine, so an
# update is a single `git pull` and every agent sees it.
#
#   --project [dir]   install into <dir>/.agents/skills/clone-website instead (project scope)
#   --dir <path>      install into an explicit path
#
# Re-running updates an existing install instead of failing.

set -eu

REPO_URL="https://github.com/braxtonROSE4/clone-any-website.git"
SKILL_NAME="clone-website"   # the directory name is the skill name; agents require them to match

DEST=""
PROJECT_DIR=""

while [ $# -gt 0 ]; do
  case "$1" in
    --project)
      if [ $# -ge 2 ] && [ "${2#-}" = "$2" ]; then PROJECT_DIR="$2"; shift 2; else PROJECT_DIR="$PWD"; shift; fi
      ;;
    --dir)
      [ $# -ge 2 ] || { echo "--dir needs a path" >&2; exit 1; }
      DEST="$2"; shift 2
      ;;
    -h|--help)
      sed -n '2,13p' "$0" | sed 's/^# \{0,1\}//'; exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2; exit 1
      ;;
  esac
done

command -v git >/dev/null 2>&1 || { echo "git is required and was not found on PATH." >&2; exit 1; }

if [ -n "$PROJECT_DIR" ] && [ -z "$DEST" ]; then
  DEST="$PROJECT_DIR/.agents/skills/$SKILL_NAME"
fi
[ -n "$DEST" ] || DEST="$HOME/.agents/skills/$SKILL_NAME"

case "$(basename "$DEST")" in
  "$SKILL_NAME") ;;
  *) echo "Install directory must be named '$SKILL_NAME' (agents take the skill name from the folder): $DEST" >&2; exit 1 ;;
esac

# Fetch or update the skill itself.
if [ -d "$DEST/.git" ]; then
  echo "Updating existing install at $DEST"
  git -C "$DEST" pull --ff-only --quiet
elif [ -e "$DEST" ]; then
  echo "$DEST already exists and is not a git checkout. Move it aside and re-run." >&2
  exit 1
else
  echo "Installing to $DEST"
  mkdir -p "$(dirname "$DEST")"
  git clone --quiet --depth 1 "$REPO_URL" "$DEST"
fi

# Project-scope installs are already inside a path every agent scans; no linking needed.
if [ -n "$PROJECT_DIR" ]; then
  echo
  echo "Installed for this project at $DEST"
  echo "Agents reading .agents/skills/ (Cursor, Gemini CLI, opencode) pick it up on the next session."
  echo "For Claude Code or Codex in this project, link it in:"
  echo "  mkdir -p .claude/skills && ln -s \"$DEST\" .claude/skills/$SKILL_NAME"
  echo "  mkdir -p .codex/skills  && ln -s \"$DEST\" .codex/skills/$SKILL_NAME"
  exit 0
fi

# Link the single copy into each agent's own skills directory.
linked=""
skipped=""

link_into() {
  agent_home="$1"; skills_dir="$2"; label="$3"
  [ -d "$agent_home" ] || return 0
  mkdir -p "$skills_dir"
  link="$skills_dir/$SKILL_NAME"
  if [ -L "$link" ]; then
    if [ "$(readlink "$link")" = "$DEST" ]; then
      linked="$linked $label"
    else
      skipped="$skipped $label(other-link)"
    fi
  elif [ -e "$link" ]; then
    skipped="$skipped $label(existing-dir)"
  else
    ln -s "$DEST" "$link"
    linked="$linked $label"
  fi
}

link_into "$HOME/.claude" "$HOME/.claude/skills" "claude-code"
link_into "${CODEX_HOME:-$HOME/.codex}" "${CODEX_HOME:-$HOME/.codex}/skills" "codex"

echo
echo "Skill installed at $DEST"
[ -n "$linked" ] && echo "Linked into:$linked"
[ -n "$skipped" ] && echo "Left alone (resolve by hand):$skipped"
echo "Read directly from ~/.agents/skills by Cursor, Gemini CLI, and opencode; no link needed there."
echo "Any other agent: point it at $DEST/SKILL.md"

# The skill drives a real browser; without this CLI it can only walk the user through installing it.
if ! command -v ego-browser >/dev/null 2>&1; then
  echo
  echo "Note: the 'ego-browser' CLI is not on PATH. Every live-page probe runs through it."
  echo "Install ego lite from https://lite.ego.app/ (macOS and Windows; on macOS you can also run"
  echo "sh $DEST/scripts/install-ego-browser.sh), finish first-run onboarding in the app,"
  echo "then re-check with: command -v ego-browser"
fi
