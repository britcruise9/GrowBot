# Contributing to GrowBot

Thanks for wanting to help build GrowBot. This project runs on a small amount of trust and a few simple rules, so reviews stay fast and the codebase stays clean.

## The short version

- One change per pull request. Keep it focused.
- Keep pull requests small. Aim for about 300 lines or less. Big PRs are hard to review and slow everyone down. If a change is genuinely large, open an issue first so we can talk about how to split it.
- Open an issue before starting anything big, so we don't both build the same thing or head in a direction that won't merge.
- Be kind and specific in reviews. "This breaks on an empty list at line 42" helps. "Fix this" does not.
- `app/` is a read-only copy of the live app and gets replaced on every snapshot, so a PR against it would be overwritten. Open an issue or post in Discord instead, and I'll fix it at the source.

## Licensing your contribution

Read this before you open a pull request. It is short.

GrowBot is free and noncommercial for everyone: the code is under PolyForm Noncommercial 1.0.0,
the hardware and docs under CC BY-NC 4.0. Commercial licences are sold separately, and that is
what pays for the project.

By opening a pull request, you confirm that:

- **The work is yours to give.** You wrote it, or you otherwise have the right to contribute it,
  and it does not contain code you are not allowed to license.
- **You grant Brit Cruise (Art of the Problem) a perpetual, worldwide, irrevocable, royalty-free
  licence** to use, modify and distribute your contribution, and to sublicense it under any
  terms, including commercial ones.
- **You keep your copyright.** This is a licence, not a handover. Your work stays yours and you
  can use it anywhere else, however you like.

Why this is here: if a contribution cannot be included in a commercial licence, it cannot ship
in a kit or go into a classroom, which means it never reaches the people it was written for.
This line keeps that door open without taking anything away from you.

If you would rather not grant that, say so in the pull request instead of quietly skipping it.
Plenty can still be merged, and we will work it out.

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

If you are not sure about something, open an issue or ask in the [GrowBot Discord](https://discord.gg/wCnAVaH4zR). That is always welcome.
