#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

source_dir=${1:-/home/ubuntu/h00k/h00k/evgen-mon}
update_mode=${2:-}
branch=codex/ovh-trading-terminal-20261025
if [[ $# -gt 2 || ( -n "$update_mode" && "$update_mode" != --prepare-only ) ]]; then
  echo 'Використання: sudo bash update-docker.sh [каталог репозиторію] [--prepare-only]' >&2
  exit 1
fi
if [[ "$update_mode" != --prepare-only && $(id -u) != 0 ]]; then
  echo 'Запустіть скрипт через sudo bash.' >&2
  exit 1
fi
cd -- "$source_dir"
source_dir=$(pwd -P)
if [[ $(git rev-parse --show-toplevel) != "$source_dir" ]]; then
  echo 'Потрібен кореневий каталог репозиторію evgen-mon.' >&2
  exit 1
fi
if [[ $(git branch --show-current) != "$branch" ]]; then
  echo "Очікується гілка $branch. Поточну гілку не змінено." >&2
  exit 1
fi
git ls-files --error-unmatch src/App.tsx deploy/install-docker.sh >/dev/null
if [[ -d $(git rev-parse --git-path rebase-merge) || -d $(git rev-parse --git-path rebase-apply) ||
  -f $(git rev-parse --git-path MERGE_HEAD) || -f $(git rev-parse --git-path CHERRY_PICK_HEAD) ]]; then
  echo 'У репозиторії триває merge, rebase або cherry-pick. Спочатку завершіть цю операцію.' >&2
  exit 1
fi

unmerged=()
unmerged_list=$(git diff --name-only --diff-filter=U)
if [[ -n "$unmerged_list" ]]; then mapfile -t unmerged <<< "$unmerged_list"; fi
for file in "${unmerged[@]}"; do
  if [[ "$file" != src/App.tsx ]]; then
    echo "Потрібно окремо розв’язати конфлікт: $file. Файли не змінено." >&2
    exit 1
  fi
done
if [[ -L src/App.tsx || ! -f src/App.tsx ]]; then
  echo 'src/App.tsx має бути звичайним наявним файлом.' >&2
  exit 1
fi

# Fetch before changing local files; pin the exact fetched target for the update.
git fetch origin "$branch"
target_sha=$(git rev-parse FETCH_HEAD)
if ! git merge-base --is-ancestor HEAD "$target_sha"; then
  echo 'Гілки розійшлися. Автоматичне оновлення зупинено; локальні коміти збережено.' >&2
  exit 1
fi

backup_dir=$(mktemp -d "${TMPDIR:-/tmp}/evgen-mon-update.XXXXXX")
trap 'echo "Оновлення перервано. Резервна копія: $backup_dir" >&2' ERR
echo "Резервна копія локальних правок: $backup_dir"
git rev-parse HEAD > "$backup_dir/previous-head.txt"
git status --short > "$backup_dir/status.txt"
git diff --binary > "$backup_dir/worktree.patch"
git diff --cached --binary > "$backup_dir/index.patch"
cp -- src/App.tsx "$backup_dir/App.before.tsx"

# A failed stash apply leaves stages 1=ancestor, 2=upstream, 3=local.
# Preserve all stages, then keep local changes wherever they do not conflict
# with the requested upstream fixes. Do not drop or pop the original stash.
if [[ ${#unmerged[@]} -gt 0 ]]; then
  git show :1:src/App.tsx > "$backup_dir/conflict-base.tsx"
  git show :2:src/App.tsx > "$backup_dir/conflict-upstream.tsx"
  git show :3:src/App.tsx > "$backup_dir/conflict-local.tsx"
  # Use the working copy so manual edits outside conflict blocks survive too.
  # Git stash labels its first side "Updated upstream". Keep that side inside
  # conflict blocks, and preserve every nonconflicting line exactly as edited.
  awk '
    BEGIN { state = 0; invalid = 0 }
    /^<<<<<<< / { if (state != 0) invalid = 1; state = 1; next }
    /^\|\|\|\|\|\|\| / { if (state != 1) invalid = 1; state = 2; next }
    /^=======$/ { if (state != 1 && state != 2) invalid = 1; state = 3; next }
    /^>>>>>>> / { if (state != 3) invalid = 1; state = 0; next }
    { if (state == 0 || state == 1) print }
    END { if (state != 0 || invalid) exit 1 }
  ' "$backup_dir/App.before.tsx" > "$backup_dir/resolved.tsx"
  cp -- "$backup_dir/resolved.tsx" src/App.tsx
  git add -- src/App.tsx
fi
git show HEAD:src/App.tsx > "$backup_dir/base.tsx"
cp -- src/App.tsx "$backup_dir/local.tsx"
git stash push -m "vps-before-update-$target_sha" -- src/App.tsx
if git rev-parse --verify refs/stash >/dev/null 2>&1; then
  git rev-parse refs/stash > "$backup_dir/stash-ref.txt"
fi
git merge --ff-only "$target_sha"
git show HEAD:src/App.tsx > "$backup_dir/new.tsx"
git merge-file --ours "$backup_dir/new.tsx" "$backup_dir/base.tsx" "$backup_dir/local.tsx"
cp -- "$backup_dir/new.tsx" src/App.tsx
git add -- src/App.tsx
if [[ -n $(git diff --name-only --diff-filter=U) ]]; then
  echo 'Залишилися нерозв’язані конфлікти. Збірку не запущено.' >&2
  exit 1
fi
echo "Код оновлено до $(git rev-parse --short HEAD). Локальні правки збережено."
if [[ "$update_mode" == --prepare-only ]]; then
  echo 'Підготовку завершено. Збірку та контейнер не запускали.'
  exit 0
fi
bash deploy/install-docker.sh
echo "Резервна копія правок залишилася в $backup_dir"
