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

/** How a wait for a turn end resolved: nothing was running, the turn ended, or the timeout elapsed first. */
export type TurnWait = 'idle' | 'ended' | 'timeout'

/** Parked callers waiting for a thread's turn to end. */
export class TurnWaiters {
	#waiters = new Map<string, Set<() => void>>()

	/** Resolves 'ended' on the next `ended(id)`, or 'timeout' after `timeoutMs`. */
	wait(id: string, timeoutMs: number): Promise<'ended' | 'timeout'> {
		return new Promise((resolve) => {
			const set = this.#waiters.get(id) ?? new Set()
			this.#waiters.set(id, set)
			const done = (result: 'ended' | 'timeout') => {
				clearTimeout(timer)
				set.delete(onEnded)
				if (set.size === 0 && this.#waiters.get(id) === set) this.#waiters.delete(id)
				resolve(result)
			}
			const onEnded = () => done('ended')
			const timer = setTimeout(() => done('timeout'), timeoutMs)
			set.add(onEnded)
		})
	}

	/** Releases everyone waiting on `id`. */
	ended(id: string): void {
		for (const release of [...(this.#waiters.get(id) ?? [])]) release()
	}
}

export type ActivityWatcher = {
	/** Threads `amp top` currently lists, most recently updated first. */
	current(): ActiveThread[]
	/**
	 * Waits for the thread's current agent turn to end. Resolves 'idle' at once if the
	 * thread is not working now, 'ended' when its turn ends, 'timeout' after `timeoutMs`.
	 */
	waitForTurnEnd(id: string, timeoutMs: number): Promise<TurnWait>
	stop(): void
}

/** Thread states derived from `amp top` snapshots; the part of the watcher that needs no child process. */
export class ActivityTracker {
	#known = new Map<string, ActiveThread>()
	#latest: ActiveThread[] = []
	#waiters = new TurnWaiters()

	/** Folds in a snapshot, releases waiters of threads whose turn ended, and returns those threads. */
	ingest(snapshot: TopSnapshot): ActiveThread[] {
		if (!snapshot.reconnecting) this.#latest = snapshot.threads
		const ended = applySnapshot(this.#known, snapshot)
		for (const thread of ended) this.#waiters.ended(thread.id)
		return ended
	}

	current = (): ActiveThread[] => this.#latest

	waitForTurnEnd = (id: string, timeoutMs: number): Promise<TurnWait> =>
		this.#known.get(id)?.working ? this.#waiters.wait(id, timeoutMs) : Promise.resolve('idle')
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
	const tracker = new ActivityTracker()
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
			for (const thread of tracker.ingest(snapshot)) options.onTurnEnded(thread)
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
		current: tracker.current,
		waitForTurnEnd: tracker.waitForTurnEnd,
		stop() {
			stopped = true
			child?.kill()
		},
	}
}
