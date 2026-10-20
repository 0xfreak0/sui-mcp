#!/usr/bin/env bash
# Check commit identities locally, and verify unfamiliar GitHub noreply IDs in CI.
set -uo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
failed=0
verify_github=0
identity_re='^.+[[:space:]]<([^<>[:space:]]+)>([[:space:]][0-9]+[[:space:]][+-][0-9]{4})?$'
trailer_re='^[[:space:]]*[Cc][Oo]-[Aa][Uu][Tt][Hh][Oo][Rr][Ee][Dd]-[Bb][Yy]:[[:space:]]+(.+[[:space:]])<([^<>[:space:]]+)>[[:space:]]*$'

reject() {
  echo "BLOCKED: $1" >&2
  failed=1
}

check_email() {
  local email="${1,,}" label="$2" login id known_login known_id response actual
  if [[ "$email" == 'noreply@users.noreply.github.com' ]]; then
    reject "$label uses an unowned GitHub noreply address"
    return
  fi
  if [[ "$email" =~ ^[^@[:space:]]+@([^@[:space:]]+)$ ]]; then
    local domain="${BASH_REMATCH[1]}"
    if [[ "$domain" == localhost* || "$domain" == *.localhost || "$domain" == *.internal ||
          "$domain" == *.local || "$domain" == *.localdomain || "$domain" == *.lan ||
          "$domain" == *.home || "$domain" == *.home.arpa || "$domain" == *.corp ||
          "$domain" == *.intranet || "$domain" == *.test || "$domain" == *.invalid ||
          "$domain" != *.* || "$domain" =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}$ ]]; then
      reject "$label uses a machine-local email address"
      return
    fi
  else
    reject "$label has an invalid email address"
    return
  fi

  if [[ "$email" =~ ^([0-9]+)\+([a-z0-9-]+(\[bot\])?)@users\.noreply\.github\.com$ ]]; then
    id="${BASH_REMATCH[1]}"
    login="${BASH_REMATCH[2]}"
    while read -r known_login known_id; do
      [[ "$known_login" == '' || "$known_login" == \#* ]] && continue
      if [[ "${known_login,,}" == "$login" ]]; then
        if [[ "$id" != "$known_id" ]]; then
          reject "$label has a GitHub noreply ID that does not belong to its login"
        fi
        return
      fi
    done < "$here/known-github-ids"
    if (( verify_github )); then
      if [[ -z "${GITHUB_TOKEN:-}" ]]; then
        reject "$label cannot verify a GitHub noreply ID without GITHUB_TOKEN"
      elif ! response="$(curl -g -fsS --max-time 15 -H "Authorization: Bearer $GITHUB_TOKEN" \
          -H 'Accept: application/vnd.github+json' "https://api.github.com/users/$login")"; then
        reject "$label could not verify its GitHub noreply ID"
      elif ! actual="$(printf '%s' "$response" | jq -er '.id | select(type == "number")')"; then
        reject "$label received no GitHub account ID"
      elif [[ "$id" != "$actual" ]]; then
        reject "$label has a GitHub noreply ID that does not belong to its login"
      fi
    fi
  elif [[ "$email" == *@users.noreply.github.com ]]; then
    reject "$label has an invalid GitHub noreply address"
  fi
}

check_identity() {
  local label="$1" identity="$2" email
  if ! printf '%s\n' "$identity" | "$here/leak-scan.sh" "$label"; then
    failed=1
  fi
  if [[ "$identity" =~ $identity_re ]]; then
    email="${BASH_REMATCH[1]}"
    check_email "$email" "$label"
  else
    reject "$label has an invalid name and email"
  fi
}

check_message() {
  local line email
  while IFS= read -r line || [[ -n "$line" ]]; do
    if [[ "$line" =~ ^[[:space:]]*[Cc][Oo]-[Aa][Uu][Tt][Hh][Oo][Rr][Ee][Dd]-[Bb][Yy]: ]]; then
      if [[ "$line" =~ $trailer_re ]]; then
        check_identity 'Co-authored-by trailer' "${BASH_REMATCH[1]}<${BASH_REMATCH[2]}>"
      else
        reject 'Co-authored-by trailer has an invalid name and email'
      fi
    fi
  done <<< "$1"
}

case "${1:-}" in
  --current)
    if ! author="$(git var GIT_AUTHOR_IDENT)" || ! committer="$(git var GIT_COMMITTER_IDENT)"; then
      reject 'cannot read the author or committer identity'
    else
      check_identity 'author' "$author"
      check_identity 'committer' "$committer"
    fi
    ;;
  --identity)
    [[ $# -ge 2 && $# -le 3 && ( $# -eq 2 || "$3" == --ci ) ]] || {
      echo 'Usage: identity-check.sh --identity "Name <email>" [--ci]' >&2
      exit 2
    }
    [[ "${3:-}" != --ci ]] || verify_github=1
    check_identity 'identity' "$2"
    ;;
  --message)
    check_message "$(cat)"
    ;;
  --commit)
    [[ $# -ge 2 && $# -le 3 && ( $# -eq 2 || "$3" == --ci ) ]] || {
      echo 'Usage: identity-check.sh --commit SHA [--ci]' >&2
      exit 2
    }
    [[ "${3:-}" != --ci ]] || verify_github=1
    if ! git cat-file -e "$2^{commit}"; then
      reject 'cannot read the commit'
    else
      mapfile -d '' -t fields < <(git log -1 --format='%an <%ae>%x00%cn <%ce>%x00%B%x00' "$2")
      if [[ ${#fields[@]} -lt 3 ]]; then
        reject 'cannot read commit identities and message'
      else
        check_identity 'author' "${fields[0]}"
        check_identity 'committer' "${fields[1]}"
        check_message "${fields[2]}"
      fi
    fi
    ;;
  *)
    echo 'Usage: identity-check.sh --current | --identity "Name <email>" [--ci] | --message | --commit SHA [--ci]' >&2
    exit 2
    ;;
esac
exit "$failed"
