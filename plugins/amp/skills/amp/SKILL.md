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
- Steer or answer a running agent: `send_message` with the thread ID.
- Clean up: `archive_thread` hides a finished thread (reversible with `unarchive: true`).

## Follow up when work finishes

`start_thread` and `send_message` return immediately while Amp keeps working. When the user wants a result, subscribe to the `thread.turn_ended` event with the thread's `thread_id`, then act on the event's `final_message`. Call `fetch` when you need the full thread. Do not poll.

Do not answer a `thread.turn_ended` event by messaging the same thread unless the user asked for that; it would start a loop.

## Report

Always give the thread URL. Summarize what the agent did and anything it needs from the user.
