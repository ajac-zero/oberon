import { join } from 'node:path'
import { watchActivity } from './activity.ts'
import { createAmpCli } from './amp.ts'
import { createApp } from './app.ts'
import { catchUpSubscription, publishTurnEnded, RecentTurns } from './bridge.ts'
import { loadConfig } from './config.ts'
import { Subscriptions, type SubscriptionState } from './events.ts'
import { emptyOriginState, OriginStore, type OriginState } from './origins.ts'
import { createAuthServer, emptyOAuthState, type OAuthState } from './oauth.ts'
import { JsonFile } from './store.ts'
import { sendWebhook } from './webhook.ts'

const log = (message: string) => console.error(`${new Date().toISOString()} ${message}`)

const config = loadConfig()
const amp = createAmpCli({ bin: config.ampBin, label: config.threadLabel })
const recentTurns = new RecentTurns()
const subscriptions: Subscriptions = new Subscriptions({
	store: new JsonFile<SubscriptionState>(join(config.dataDir, 'subscriptions.json'), { subscriptions: {}, verifiedCallbacks: {} }),
	send: sendWebhook,
	log,
	// Deliver a turn that ended just before the subscription existed. Deferred so ChatGPT gets the subscribe response first.
	onSubscribed: (subscription) =>
		void setTimeout(() => {
			catchUpSubscription({ amp, subscriptions, origins, recentTurns }, subscription).catch((error: Error) => log(`catch-up ${subscription.id}: ${error.message}`))
		}, 1_000),
})
const origins = new OriginStore(new JsonFile<OriginState>(join(config.dataDir, 'origins.json'), emptyOriginState()))
const auth = createAuthServer({
	publicUrl: config.publicUrl,
	passphrase: config.passphrase,
	log,
	store: new JsonFile<OAuthState>(join(config.dataDir, 'oauth.json'), emptyOAuthState()),
})
const activity = watchActivity({
	ampBin: config.ampBin,
	log,
	onTurnEnded: (thread) => {
		log(`turn ended: ${thread.id} (${thread.title})`)
		recentTurns.record(thread)
		publishTurnEnded({ amp, subscriptions, origins }, thread).catch((error: Error) => log(`publish ${thread.id}: ${error.message}`))
	},
})

const app = createApp({ auth, amp, activeThreads: activity.current, subscriptions, origins, waitForTurnEnd: config.enableWaitTool ? activity.waitForTurnEnd : undefined, log })
const server = app.listen(config.port, config.host, () => {
	log(`oberon listening on http://${config.host}:${config.port}`)
	log(`ChatGPT MCP server URL: ${auth.resource}`)
})

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
	process.on(signal, () => {
		activity.stop()
		server.close(() => process.exit(0))
	})
}
