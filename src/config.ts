import { resolve } from 'node:path'

export type Config = {
	/** Interface the HTTP server binds to. Put a tunnel or reverse proxy in front for HTTPS. */
	host: string
	port: number
	/** Public HTTPS origin ChatGPT reaches, e.g. https://oberon.example.com. Also the OAuth issuer. */
	publicUrl: URL
	/** Passphrase the owner types on the consent page to link ChatGPT. */
	passphrase: string
	/** Directory for OAuth and subscription state. */
	dataDir: string
	/** Amp CLI binary. */
	ampBin: string
	/** Label added to every thread the bridge starts, so they are easy to find in Amp. */
	threadLabel: string
	/** Register the `wait_for_thread` tool (for clients where MCP Events do not fire). */
	enableWaitTool: boolean
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
	const publicUrl = parsePublicUrl(required(env, 'OBERON_PUBLIC_URL'))
	const passphrase = required(env, 'OBERON_PASSPHRASE')
	if (passphrase.length < 12) throw new Error('OBERON_PASSPHRASE must be at least 12 characters')
	return {
		host: env.OBERON_HOST ?? '127.0.0.1',
		port: Number(env.OBERON_PORT ?? 8787),
		publicUrl,
		passphrase,
		dataDir: resolve(env.OBERON_DATA_DIR ?? '.data'),
		ampBin: env.AMP_BIN ?? 'amp',
		threadLabel: env.OBERON_THREAD_LABEL ?? 'chatgpt',
		enableWaitTool: ['1', 'true'].includes(env.OBERON_ENABLE_WAIT_TOOL?.trim().toLowerCase() ?? ''),
	}
}

function required(env: NodeJS.ProcessEnv, name: string): string {
	const value = env[name]?.trim()
	if (!value) throw new Error(`${name} is required`)
	return value
}

function parsePublicUrl(raw: string): URL {
	const url = new URL(raw)
	const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1'
	if (url.protocol !== 'https:' && !local) throw new Error('OBERON_PUBLIC_URL must use https')
	if (url.pathname !== '/' || url.search || url.hash) {
		throw new Error('OBERON_PUBLIC_URL must be an origin without a path, e.g. https://oberon.example.com')
	}
	return url
}
