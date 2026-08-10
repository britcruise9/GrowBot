# Contributing to GrowBot

Thanks for wanting to help build GrowBot. This project runs on a small amount of trust and a few simple rules, so reviews stay fast and the codebase stays clean.

## The short version

- One change per pull request. Keep it focused.
- Keep pull requests small. Aim for about 300 lines or less. Big PRs are hard to review and slow everyone down. If a change is genuinely large, open an issue first so we can talk about how to split it.
- Open an issue before starting anything big, so we don't both build the same thing or head in a direction that won't merge.
- Be kind and specific in reviews. "This breaks on an empty list at line 42" helps. "Fix this" does not.

## How to contribute

1. Fork the repo. You do not need push access, the fork is yours.
2. Make a branch named for what you are doing:
   - `feature/short-name` for new functionality
   - `fix/short-name` for bug fixes
   - `docs/short-name` for docs only
3. Commit in small steps. Start commit messages with `feat:`, `fix:`, `docs:`, or `chore:`.
4. Push to your fork and open a pull request against `main`.
5. Fill in the pull request template so a reviewer can understand the change without asking.

## What gets merged

- It does one thing, and does it clearly.
- It is small enough to review in one sitting.
- It does not commit secrets, keys, or `.env` files.
- A maintainer has reviewed and approved it. Nobody merges their own PR to `main`.

## What not to do

- Do not commit secrets, API keys, `.pem` or `.key` files, or `.env`.
- Do not bundle several unrelated changes into one PR.
- Do not open a giant rewrite without talking first.

If you are not sure about something, open an issue and ask. That is always welcome.
