---
name: amp
description: Delegate coding work to Amp agents and report on it. Use when the user asks Amp to do something, mentions Amp threads, orbs, or runners, or wants coding work done on their repositories or machines.
---

# Working with Amp

Amp is the user's coding agent. Use the Amp tools from this plugin for everything Amp-related: reading threads, checking status, starting agents, and messaging them. Never operate the Amp app or ampcode.com with computer use or a browser, never SSH into the user's machines, and never run the `amp` CLI or edit their code with shell commands yourself. The tools do all of that directly.

## Choose the tool

- Find past work: `search` (Amp query syntax such as `repo:github.com/owner/repo`, `after:7d`, `author:me`), then `fetch` to read a thread.
- See what is running now: `list_active_threads`.
- Start work: `start_thread`. Pass `project` (from `list_projects`) to run in an orb, or `runner_id` and `runner_dir` to run on one of the user's machines. Write the prompt as a complete, self-contained task. Use mode `low` for small tasks and `high` for hard ones.
- Wait for a result (only if the plugin offers `wait_for_thread`): see below.
- Steer or answer a running agent: `send_message` with the thread ID.
- Clean up: `archive_thread` hides a finished thread (reversible with `unarchive: true`).

## Follow up when work finishes

`start_thread` and `send_message` return immediately while Amp keeps working. When the user wants a result, subscribe to the `thread.turn_ended` event, then act on the event's `final_message`. Call `fetch` when you need the full thread. Do not poll.

- Following up on threads you started: subscribe with `origin: "oberon"`. It fires only for threads started through `start_thread`, not for threads the user is chatting with directly in Amp, which would otherwise be noise. Add `thread_id` to watch a single thread.
- Read the event's `outcome`: `completed`, `error`, `cancelled`, or `needs_approval` (the agent is waiting for approval; tell the user rather than retrying). Subscribe with `outcomes` (for example `["error", "needs_approval"]`) to hear only about those.

Events do not fire in every client (ChatGPT desktop's local mode, for one). If they do not and the plugin offers `wait_for_thread`, call it with the `thread_id` right after starting or messaging the thread. It returns when the agent's turn ends, with `final_message`, or after `timeout_seconds` (default 45, at most 55) with `finished: false`; in that case call it again. Prefer it over calling `fetch` repeatedly. If neither events nor `wait_for_thread` are available, tell the user the agent is running and give the thread URL rather than polling in a loop.

Do not answer a `thread.turn_ended` event by messaging the same thread unless the user asked for that; it would start a loop.

## Report

Always give the thread URL. Summarize what the agent did and anything it needs from the user.
