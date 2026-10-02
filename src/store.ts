import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

/**
 * A JSON document persisted to one file. Writes are synchronous and atomic
 * (temp file + rename), which is plenty for a single-user bridge's OAuth and
 * subscription state and keeps every mutation durable before we respond.
 */
export class JsonFile<T> {
	readonly #path: string | undefined
	#value: T

	/** Pass `path: undefined` for an in-memory store (tests). */
	constructor(path: string | undefined, initial: T) {
		this.#path = path
		this.#value = path ? (readJson<T>(path) ?? initial) : initial
	}

	get value(): T {
		return this.#value
	}

	update(mutate: (draft: T) => void): void {
		const draft = structuredClone(this.#value)
		mutate(draft)
		if (this.#path) {
			mkdirSync(dirname(this.#path), { recursive: true, mode: 0o700 })
			const tmp = `${this.#path}.${process.pid}.tmp`
			writeFileSync(tmp, JSON.stringify(draft, null, 2), { mode: 0o600 })
			renameSync(tmp, this.#path)
		}
		this.#value = draft
	}
}

function readJson<T>(path: string): T | undefined {
	try {
		return JSON.parse(readFileSync(path, 'utf8')) as T
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
		throw error
	}
}
