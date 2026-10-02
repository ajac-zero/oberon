import { McpServer } from '@modelcontextprotocol/server'
import { z } from 'zod'
import { parseThreadId, type ActiveThread, type Amp, type Target } from './amp.ts'
import { canonicalJson, EVENT_DEFINITIONS, ListEventsParams, SubscribeParams, Subscriptions, UnsubscribeParams } from './events.ts'

const INSTRUCTIONS = `Amp is the user's coding agent. These tools are the way to use Amp: do not operate the Amp app or ampcode.com with computer use or a browser, and do not SSH into the user's machines.
An Amp thread is one agent conversation; it runs in an orb (cloud sandbox for a project) or on a runner (one of the user's machines).
Read threads with search and fetch; check live status with list_active_threads.
start_thread and send_message return at once while Amp keeps working. To act when the work is done, subscribe to the thread.turn_ended event for that thread_id instead of polling.
Always give the user the thread URL. Do not send a message to the thread that triggered a thread.turn_ended event unless the user asked for that, to avoid loops.`

/** Keeps the start and end of a long text: the request and the outcome matter most. */
export function excerpt(text: string, max: number): { text: string; truncated: boolean } {
	if (text.length <= max) return { text, truncated: false }
	const head = Math.floor(max * 0.2)
	const tail = max - head
	return { text: `${text.slice(0, head)}\n\n[… ${text.length - max} characters omitted …]\n\n${text.slice(-tail)}`, truncated: true }
}

const readOnly = { readOnlyHint: true, destructiveHint: false, openWorldHint: false, idempotentHint: true }
const write = { readOnlyHint: false, destructiveHint: false, openWorldHint: false, idempotentHint: false }

const ThreadRow = z.object({ id: z.string(), title: z.string(), url: z.string() })

export function createMcpServer(deps: { amp: Amp; activeThreads: () => ActiveThread[]; subscriptions: Subscriptions; principal: string; log?: (message: string) => void }): McpServer {
	const { amp, subscriptions, principal } = deps
	const called = (name: string) => deps.log?.(`mcp: ${name}`)
	const server = new McpServer({ name: 'oberon', title: 'Amp', version: '0.1.0' }, { capabilities: { tools: {} }, instructions: INSTRUCTIONS })

	server.registerTool(
		'search',
		{
			title: 'Search Amp threads',
			description:
				'Use this to find Amp threads by topic or filter. Accepts Amp search syntax: keywords or "phrases", repo:github.com/owner/repo, author:me, after:7d, archived:true, pr:123, label:x. An empty query lists the most recent threads.',
			inputSchema: z.object({ query: z.string().describe('Amp thread search query') }),
			outputSchema: z.object({ results: z.array(ThreadRow) }),
			annotations: readOnly,
		},
		async ({ query }) => {
			called('search')
			const rows = await amp.searchThreads(query, 20)
			const results = rows.map(({ id, title, url }) => ({ id, title, url }))
			return { structuredContent: { results }, content: [{ type: 'text', text: JSON.stringify({ results }) }] }
		},
	)

	server.registerTool(
		'fetch',
		{
			title: 'Read an Amp thread',
			description:
				"Use this to read an Amp thread's conversation (user requests, agent replies, tool calls) by thread ID or URL. Very long threads keep the beginning and the end.",
			inputSchema: z.object({ id: z.string().describe('Thread ID (T-…) or thread URL') }),
			outputSchema: z.object({ id: z.string(), title: z.string(), text: z.string(), url: z.string(), metadata: z.record(z.string(), z.string()).optional() }),
			annotations: readOnly,
		},
		async ({ id }) => {
			called('fetch')
			const threadId = parseThreadId(id)
			const [markdown, detail] = await Promise.all([amp.threadMarkdown(threadId), amp.threadDetail(threadId)])
			const body = excerpt(markdown, 60_000)
			const live = deps.activeThreads().find((t) => t.id === threadId)
			const result = {
				id: threadId,
				title: detail.title,
				text: body.text,
				url: detail.url,
				metadata: {
					agent_state: live?.working ? 'working' : (detail.agentState ?? 'unknown'),
					...(live?.project ? { project: live.project } : {}),
					updated_at: detail.updatedAt,
					truncated: String(body.truncated),
				},
			}
			return { structuredContent: result, content: [{ type: 'text', text: JSON.stringify(result) }] }
		},
	)

	server.registerTool(
		'list_active_threads',
		{
			title: 'List active Amp threads',
			description: 'Use this to see which Amp threads are working right now or were active recently, with their project and live status.',
			inputSchema: z.object({}),
			outputSchema: z.object({
				threads: z.array(ThreadRow.extend({ project: z.string(), working: z.boolean(), status: z.string(), updated_at: z.string() })),
			}),
			annotations: readOnly,
		},
		async () => {
			called('list_active_threads')
			const threads = deps.activeThreads().map((t) => ({ id: t.id, title: t.title, url: t.url, project: t.project, working: t.working, status: t.status, updated_at: t.updatedAt }))
			return { structuredContent: { threads }, content: [{ type: 'text', text: JSON.stringify({ threads }) }] }
		},
	)

	server.registerTool(
		'list_projects',
		{
			title: 'List Amp projects',
			description: 'Use this to find the project to pass to start_thread when running an agent in an orb.',
			inputSchema: z.object({}),
			outputSchema: z.object({ projects: z.array(z.object({ ref: z.string(), name: z.string(), repository_url: z.string() })) }),
			annotations: readOnly,
		},
		async () => {
			called('list_projects')
			const projects = (await amp.listProjects()).map((p) => ({ ref: p.ref, name: p.name, repository_url: p.repositoryURL }))
			return { structuredContent: { projects }, content: [{ type: 'text', text: JSON.stringify({ projects }) }] }
		},
	)

	server.registerTool(
		'start_thread',
		{
			title: 'Start an Amp agent',
			description:
				'Use this when the user wants Amp to do coding work. Starts a new Amp thread and returns its URL immediately; the agent keeps working in the background. Run it in an orb by passing project (see list_projects), or on one of the user\'s machines by passing runner_id. Write the prompt as a complete, self-contained task.',
			inputSchema: z.object({
				prompt: z.string().min(1).describe('The full task for the agent'),
				project: z.string().optional().describe('Amp project (namespace/name or owner/repo) to run in an orb'),
				runner_id: z.string().optional().describe('Runner ID to run on one of the user\'s machines instead of an orb'),
				runner_dir: z.string().optional().describe('Absolute directory on the runner; defaults to the runner\'s starting directory'),
				mode: z.enum(['low', 'medium', 'high', 'ultra']).optional().describe('Agent mode; default medium. Use low for small tasks, high for hard ones'),
				title: z.string().optional().describe('Thread title'),
			}),
			outputSchema: z.object({ thread_id: z.string(), url: z.string(), executor: z.string() }),
			annotations: write,
		},
		async ({ prompt, project, runner_id, runner_dir, mode, title }) => {
			called('start_thread')
			if (Boolean(project) === Boolean(runner_id)) throw new Error('Pass exactly one of project (orb) or runner_id (runner).')
			if (runner_dir && !runner_id) throw new Error('runner_dir requires runner_id.')
			const target: Target = runner_id ? { kind: 'runner', runnerId: runner_id, runnerDir: runner_dir } : { kind: 'orb', project: project! }
			const { id, url } = await amp.startThread({ prompt, target, mode, title })
			const result = { thread_id: id, url, executor: runner_id ? `runner:${runner_id}` : `orb:${project}` }
			return { structuredContent: result, content: [{ type: 'text', text: `Started ${url}. Subscribe to thread.turn_ended with thread_id ${id} to follow up when it finishes.` }] }
		},
	)

	server.registerTool(
		'send_message',
		{
			title: 'Message an Amp thread',
			description: 'Use this to give an existing Amp thread a follow-up instruction, answer its question, or steer it. Returns immediately; the agent works in the background.',
			inputSchema: z.object({
				thread_id: z.string().describe('Thread ID (T-…) or thread URL'),
				message: z.string().min(1).describe('The message to send as the user'),
			}),
			outputSchema: z.object({ thread_id: z.string(), url: z.string() }),
			annotations: write,
		},
		async ({ thread_id, message }) => {
			called('send_message')
			const { id, url } = await amp.sendMessage(parseThreadId(thread_id), message)
			return { structuredContent: { thread_id: id, url }, content: [{ type: 'text', text: `Sent to ${url}.` }] }
		},
	)

	// ── MCP Events (ChatGPT webhook delivery; draft extension, not in the SDK) ──
	server.server.registerCapabilities({ events: {} } as never)
	server.server.setRequestHandler('events/list', { params: ListEventsParams }, async () => (called('events/list'), { events: EVENT_DEFINITIONS }))
	server.server.setRequestHandler('events/subscribe', { params: SubscribeParams }, (params) => (called(`events/subscribe ${canonicalJson(params.arguments)}`), subscriptions.subscribe(principal, params)))
	server.server.setRequestHandler('events/unsubscribe', { params: UnsubscribeParams }, (params) => (called(`events/unsubscribe ${canonicalJson(params.arguments)}`), subscriptions.unsubscribe(principal, params)))

	return server
}
