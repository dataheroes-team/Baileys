import { jest } from '@jest/globals'
import { EventEmitter } from 'events'
import P from 'pino'
import type { BinaryNode } from '../../WABinary'

/**
 * The socket only reaches the network through the `ws` package, so faking that
 * one module is enough to hold a connection open. Everything the stanza is
 * routed through - the real WebSocketClient and the `CB:*` fan-out its
 * listeners are keyed on - stays in play.
 */
class FakeWebSocket extends EventEmitter {
	static readonly CONNECTING = 0
	static readonly OPEN = 1
	static readonly CLOSING = 2
	static readonly CLOSED = 3

	/** Every frame a socket writes, so a test can read back what went out. */
	static readonly written = new EventEmitter()

	readyState: number = FakeWebSocket.OPEN

	send(data: Uint8Array | string, cb?: (err?: Error) => void) {
		FakeWebSocket.written.emit('frame', Buffer.from(data))
		cb?.()
	}

	close() {
		this.readyState = FakeWebSocket.CLOSED
		this.emit('close')
	}
}

jest.unstable_mockModule('ws', () => ({ __esModule: true, default: FakeWebSocket }))

// Imported after the mock is registered: mock factories are not hoisted in ESM.
const { DEF_CALLBACK_PREFIX, DEF_TAG_PREFIX, DEFAULT_CONNECTION_CONFIG, NOISE_WA_HEADER } = await import(
	'../../Defaults'
)
const { default: makeWASocket } = await import('../../Socket')
const { decodeBinaryNode, getBinaryNodeChild, getBinaryNodeChildren } = await import('../../WABinary')
const { proto } = await import('../../../WAProto/index.js')
const { makeSession } = await import('../TestUtils/session')

const logger = P({ level: 'silent' })

const COLLECTION = 'regular_low'
/** A key id the auth store has never been handed: the phone did not share it. */
const UNSHARED_KEY_ID = Buffer.from([0, 0, 0, 0, 129, 102])

/**
 * Mirrors the `CB:*` fan-out `onMessageReceived` performs, so a stanza reaches
 * the handlers it would reach on a live connection. Raw frames cannot be fed in
 * instead: the noise transport only decodes them once a handshake has run.
 */
const deliver = (ws: EventEmitter, node: BinaryNode) => {
	const childTag = Array.isArray(node.content) ? node.content[0]?.tag : ''

	for (const [attr, value] of Object.entries(node.attrs)) {
		ws.emit(`${DEF_CALLBACK_PREFIX}${node.tag},${attr}:${value},${childTag}`, node)
		ws.emit(`${DEF_CALLBACK_PREFIX}${node.tag},${attr}:${value}`, node)
		ws.emit(`${DEF_CALLBACK_PREFIX}${node.tag},${attr}`, node)
	}

	ws.emit(`${DEF_CALLBACK_PREFIX}${node.tag},,${childTag}`, node)
	ws.emit(`${DEF_CALLBACK_PREFIX}${node.tag}`, node)
}

/**
 * Reads back the stanza in a frame the socket wrote. No noise handshake runs
 * against the fake, so frames go out in the clear: a 3-byte length and the
 * encoded node, behind the intro header on the first frame only.
 */
const readFrame = (frame: Buffer) => {
	const start = frame.subarray(0, NOISE_WA_HEADER.length).equals(NOISE_WA_HEADER) ? NOISE_WA_HEADER.length : 0
	const length = frame.readUIntBE(start, 3)
	return decodeBinaryNode(frame.subarray(start + 3, start + 3 + length))
}

const serverSyncNotification = (id: string): BinaryNode => ({
	tag: 'notification',
	attrs: { from: 's.whatsapp.net', id, type: 'server_sync' },
	content: [{ tag: 'collection', attrs: { name: COLLECTION, version: '7' } }]
})

/**
 * A patch whose one mutation is encrypted under a key the companion does not
 * hold, as the server answers a sync query. The mutation is what needs the key:
 * patch MACs are not verified by default, so an empty patch would just apply.
 */
const patchUnderUnsharedKey = (requestId: string): BinaryNode => ({
	tag: 'iq',
	attrs: { from: 's.whatsapp.net', type: 'result', id: requestId },
	content: [
		{
			tag: 'sync',
			attrs: {},
			content: [
				{
					tag: 'collection',
					attrs: { name: COLLECTION, version: '0' },
					content: [
						{
							tag: 'patches',
							attrs: {},
							content: [
								{
									tag: 'patch',
									attrs: {},
									content: proto.SyncdPatch.encode({
										version: { version: 1 },
										keyId: { id: UNSHARED_KEY_ID },
										mutations: [
											{
												operation: proto.SyncdMutation.SyncdOperation.SET,
												record: {
													keyId: { id: UNSHARED_KEY_ID },
													index: { blob: Buffer.alloc(32) },
													value: { blob: Buffer.alloc(64) }
												}
											}
										],
										snapshotMac: Buffer.alloc(32),
										patchMac: Buffer.alloc(32)
									}).finish()
								}
							]
						}
					]
				}
			]
		}
	]
})

const cleanups: Array<() => Promise<void>> = []

/**
 * Boots a socket against the fake and answers every app state sync query with a
 * patch under the unshared key, counting the queries it had to answer.
 */
const bootSocket = async () => {
	const { state, clear } = await makeSession()
	const sock = makeWASocket({ ...DEFAULT_CONNECTION_CONFIG, auth: state, logger })

	const syncQueries: BinaryNode[] = []
	const onFrame = async (frame: Buffer) => {
		const node = await readFrame(frame)
		if (node.tag !== 'iq' || node.attrs.xmlns !== 'w:sync:app:state') {
			return
		}

		syncQueries.push(node)
		// answered on a later tick, like a server would: the query is still being
		// written when its frame is observed
		setImmediate(() => sock.ws.emit(`${DEF_TAG_PREFIX}${node.attrs.id}`, patchUnderUnsharedKey(node.attrs.id!)))
	}

	FakeWebSocket.written.on('frame', onFrame)

	cleanups.push(async () => {
		FakeWebSocket.written.off('frame', onFrame)
		try {
			await sock.end(new Error('test finished'))
		} finally {
			await clear()
		}
	})

	/** Resolves once the notification has been acked, i.e. fully handled. */
	const handle = (id: string) =>
		new Promise<void>(resolve => {
			const onAck = async (frame: Buffer) => {
				const node = await readFrame(frame)
				if (node.tag === 'ack' && node.attrs.id === id) {
					FakeWebSocket.written.off('frame', onAck)
					resolve()
				}
			}

			FakeWebSocket.written.on('frame', onAck)
			deliver(sock.ws, serverSyncNotification(id))
		})

	return { sock, syncQueries, handle }
}

const requestedSnapshot = (query: BinaryNode) => {
	const [collection] = getBinaryNodeChildren(getBinaryNodeChild(query, 'sync'), 'collection')
	return collection?.attrs.return_snapshot
}

describe('CB:notification,type:server_sync on a collection parked on a missing key', () => {
	afterEach(async () => {
		for (const cleanup of cleanups.splice(0)) {
			await cleanup()
		}
	})

	it('fetches the collection once, parks it, and leaves it parked for later notifications', async () => {
		const { syncQueries, handle } = await bootSocket()

		await handle('server-sync-1')
		// one try from the stored version and one forced snapshot, then parked
		expect(syncQueries).toHaveLength(2)
		expect(syncQueries.map(requestedSnapshot)).toEqual(['true', 'true'])

		// an offline backlog replays hundreds of these after a reconnect: none of
		// them may reach the server while the key is still missing
		for (const id of ['server-sync-2', 'server-sync-3', 'server-sync-4']) {
			await handle(id)
		}

		expect(syncQueries).toHaveLength(2)
	})

	it('re-syncs the parked collection when an app state sync key arrives', async () => {
		const { sock, syncQueries, handle } = await bootSocket()

		await handle('server-sync-1')
		expect(syncQueries).toHaveLength(2)

		const resynced = new Promise<void>(resolve => {
			const onFrame = async (frame: Buffer) => {
				const node = await readFrame(frame)
				if (node.tag === 'iq' && node.attrs.xmlns === 'w:sync:app:state') {
					FakeWebSocket.written.off('frame', onFrame)
					resolve()
				}
			}

			FakeWebSocket.written.on('frame', onFrame)
		})
		sock.ev.emit('creds.update', { myAppStateKeyId: 'AAAAAIFq' })
		await resynced

		expect(syncQueries.length).toBeGreaterThan(2)
	})
})
