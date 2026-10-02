// stdin must be /dev/null: with a non-TTY stdin, `amp -x` waits to read piped input and times out.
import { spawn } from 'node:child_process'

/** One entry of `amp top --stream-jsonl` (schema marked EXPERIMENTAL by the Amp CLI). */
export type ActiveThread = {
	id: string
	title: string
	url: string
	project: string
	status: string
	working: boolean
	executorConnected: boolean
	updatedAt: string
}

export type ThreadSummary = { id: string; title: string; url: string; updatedAt: string }

export type ThreadDetail = {
	id: string
	title: string
	url: string
	agentState: string | undefined
	/** Protocol ID of the message the agent state refers to; stable for one agent turn. */
	agentStateMessageId: string | undefined
	lastAssistantText: string
	/** The export has caught up with a finished turn: agent not running and the last message is a completed assistant message. */
	settled: boolean
	updatedAt: string
}

export type Project = { ref: string; name: string; repositoryURL: string }

export type Target = { kind: 'orb'; project: string } | { kind: 'runner'; runnerId: string; runnerDir?: string }

export type Mode = 'low' | 'medium' | 'high' | 'ultra'

/** The Amp operations the bridge relies on. Implemented by the Amp CLI; faked in tests. */
export interface Amp {
	searchThreads(query: string, limit: number): Promise<ThreadSummary[]>
	threadMarkdown(id: string): Promise<string>
	threadDetail(id: string): Promise<ThreadDetail>
	listProjects(): Promise<Project[]>
	startThread(input: { prompt: string; target: Target; mode?: Mode; title?: string }): Promise<{ id: string; url: string }>
	sendMessage(id: string, message: string): Promise<{ id: string; url: string }>
	archiveThread(id: string, archived: boolean): Promise<void>
}

const THREAD_ID = /^T-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const THREAD_URL = /https?:\/\/\S+\/threads\/(T-[0-9a-f-]{36})/i

/** Accepts a thread ID or thread URL and returns the bare ID. */
export function parseThreadId(input: string): string {
	const trimmed = input.trim()
	const id = THREAD_URL.exec(trimmed)?.[1] ?? trimmed
	if (!THREAD_ID.test(id)) throw new Error(`Not an Amp thread ID or URL: ${input}`)
	return id
}

export function threadUrl(id: string): string {
	return `https://ampcode.com/threads/${id}`
}

export function createAmpCli(options: { bin: string; label: string }): Amp {
	const run = (args: string[], timeoutMs = 60_000) =>
		new Promise<string>((resolve, reject) => {
			const child = spawn(options.bin, args, { stdio: ['ignore', 'pipe', 'pipe'] })
			const stdout: Buffer[] = []
			const stderr: Buffer[] = []
			child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk))
			child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk))
			const timer = setTimeout(() => child.kill(), timeoutMs)
			child.on('error', reject)
			child.on('close', (code, signal) => {
				clearTimeout(timer)
				if (code === 0) return resolve(Buffer.concat(stdout).toString('utf8'))
				const detail = Buffer.concat(stderr).toString('utf8').trim() || (signal ? `killed by ${signal}` : `exit code ${code}`)
				reject(new Error(`amp ${args[0]} ${args[1] ?? ''} failed: ${detail.slice(0, 500)}`))
			})
		})

	const createdThread = (stdout: string) => {
		const id = THREAD_URL.exec(stdout)?.[1]
		if (!id) throw new Error(`Amp did not print a thread URL: ${stdout.trim().slice(0, 300)}`)
		return { id, url: threadUrl(id) }
	}

	return {
		async searchThreads(query, limit) {
			const args = query.trim()
				? ['threads', 'search', query, '--json', '--limit', String(limit)]
				: ['threads', 'list', '--json', '--limit', String(limit)]
			const rows = JSON.parse(await run(args)) as { id: string; title: string; updated?: string; updatedAt?: string }[]
			return rows.map((row) => ({ id: row.id, title: row.title, url: threadUrl(row.id), updatedAt: row.updatedAt ?? row.updated ?? '' }))
		},

		threadMarkdown: (id) => run(['threads', 'markdown', parseThreadId(id)]),

		async threadDetail(id) {
			const raw = JSON.parse(await run(['threads', 'export', parseThreadId(id)])) as ExportedThread
			return toThreadDetail(raw)
		},

		async listProjects() {
			const rows = JSON.parse(await run(['projects', 'list', '--json'])) as { name: string; namespace: string; repositoryURL: string }[]
			return rows.map((row) => ({ ref: `${row.namespace}/${row.name}`, name: row.name, repositoryURL: row.repositoryURL }))
		},

		async startThread({ prompt, target, mode, title }) {
			const args =
				target.kind === 'orb'
					? ['--orb-execute', '--execute', prompt, '--project', target.project]
					: ['--execute', prompt, '--executor', `runner:${target.runnerId}`, ...(target.runnerDir ? ['--runner-dir', target.runnerDir] : [])]
			if (mode) args.push('--mode', mode)
			if (title) args.push('--title', title)
			args.push('--label', options.label)
			return createdThread(await run(args, 120_000))
		},

		async archiveThread(id, archived) {
			await run(['threads', 'archive', parseThreadId(id), ...(archived ? [] : ['--unarchive'])])
		},

		async sendMessage(id, message) {
			// `threads continue <id> -ox` queues the message on the thread's own executor
			// (orb or runner) and returns immediately; it works for runner threads too.
			return createdThread(await run(['threads', 'continue', parseThreadId(id), '--orb-execute', '--execute', message], 120_000))
		},
	}
}

type ExportedThread = {
	id: string
	title?: string
	updatedAt?: string
	meta?: { lastKnownAgentState?: { state?: string; messageID?: string } }
	messages: { role: string; state?: { type?: string }; content: { type: string; text?: string }[] }[]
}

const RUNNING_STATES = new Set(['working', 'tool_use', 'streaming'])

export function toThreadDetail(raw: ExportedThread): ThreadDetail {
	const state = raw.meta?.lastKnownAgentState?.state
	const last = raw.messages.at(-1)
	const lastAssistant = raw.messages.findLast((m) => m.role === 'assistant' && m.content.some((c) => c.type === 'text' && c.text?.trim()))
	return {
		id: raw.id,
		title: raw.title ?? '(untitled)',
		url: threadUrl(raw.id),
		agentState: state,
		agentStateMessageId: raw.meta?.lastKnownAgentState?.messageID,
		lastAssistantText: (lastAssistant?.content ?? []).flatMap((c) => (c.type === 'text' && c.text ? [c.text] : [])).join('\n\n'),
		settled: state !== undefined && !RUNNING_STATES.has(state) && last?.role === 'assistant' && last.state?.type === 'complete',
		updatedAt: raw.updatedAt ?? '',
	}
}
