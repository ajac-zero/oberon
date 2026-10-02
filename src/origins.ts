import type { JsonFile } from './store.ts'

export type OriginState = {
	/** Thread ID → ISO time Oberon started it. */
	threads: Record<string, string>
}

export const emptyOriginState = (): OriginState => ({ threads: {} })

/**
 * The threads Oberon started through `start_thread`. This persisted set is the
 * only source of truth for an event's `origin`: labels and titles are not consulted.
 */
export class OriginStore {
	readonly #store: JsonFile<OriginState>
	readonly #now: () => Date

	constructor(store: JsonFile<OriginState>, now: () => Date = () => new Date()) {
		this.#store = store
		this.#now = now
	}

	record(threadId: string): void {
		if (this.#store.value.threads[threadId]) return
		this.#store.update((state) => void (state.threads[threadId] = this.#now().toISOString()))
	}

	originOf(threadId: string): 'oberon' | 'other' {
		return this.#store.value.threads[threadId] ? 'oberon' : 'other'
	}
}
