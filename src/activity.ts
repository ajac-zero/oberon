import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import type { ActiveThread } from './amp.ts'

export type TopSnapshot = { updatedAt: string; threads: ActiveThread[]; reconnecting: boolean }

/**
 * Folds one `amp top` snapshot into the known thread states and returns the
 * threads whose agent turn just ended (working → not working).
 *
 * Threads absent from a snapshot keep their last known state: `amp top` emits
 * an empty list before its first sync and drops threads that go quiet, and
 * neither means a turn ended.
 */
export function applySnapshot(known: Map<string, ActiveThread>, snapshot: TopSnapshot): ActiveThread[] {
	if (snapshot.reconnecting) return []
	const ended: ActiveThread[] = []
	for (const thread of snapshot.threads) {
		if (known.get(thread.id)?.working && !thread.working) ended.push(thread)
		known.set(thread.id, thread)
	}
	return ended
}

export type ActivityWatcher = {
	/** Threads `amp top` currently lists, most recently updated first. */
	current(): ActiveThread[]
	stop(): void
}

/**
 * Runs `amp top --stream-jsonl` for the life of the process, restarting it with
 * backoff, and reports every ended agent turn.
 */
export function watchActivity(options: {
	ampBin: string
	onTurnEnded: (thread: ActiveThread) => void
	log: (message: string) => void
}): ActivityWatcher {
	const known = new Map<string, ActiveThread>()
	let latest: ActiveThread[] = []
	let stopped = false
	let backoffMs = 1_000
	let child: ReturnType<typeof spawn> | undefined

	const start = () => {
		child = spawn(options.ampBin, ['top', '--stream-jsonl'], { stdio: ['ignore', 'pipe', 'pipe'] })
		const startedAt = Date.now()
		createInterface({ input: child.stdout! }).on('line', (line) => {
			let snapshot: TopSnapshot
			try {
				snapshot = JSON.parse(line) as TopSnapshot
			} catch {
				options.log(`amp top: ignoring unparsable line: ${line.slice(0, 200)}`)
				return
			}
			if (!snapshot.reconnecting) latest = snapshot.threads
			for (const thread of applySnapshot(known, snapshot)) options.onTurnEnded(thread)
		})
		child.stderr!.on('data', (chunk: Buffer) => options.log(`amp top: ${chunk.toString().trim()}`))
		child.on('exit', (code) => {
			if (stopped) return
			if (Date.now() - startedAt > 60_000) backoffMs = 1_000
			options.log(`amp top exited (${code}); restarting in ${backoffMs}ms`)
			setTimeout(start, backoffMs).unref()
			backoffMs = Math.min(backoffMs * 2, 30_000)
		})
	}
	start()

	return {
		current: () => latest,
		stop() {
			stopped = true
			child?.kill()
		},
	}
}
