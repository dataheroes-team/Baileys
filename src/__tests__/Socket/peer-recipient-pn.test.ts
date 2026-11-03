import { jest } from '@jest/globals'
import P from 'pino'
import { DEFAULT_CONNECTION_CONFIG } from '../../Defaults'
import type { SignalDataSet, SignalDataTypeMap, SignalKeyStore } from '../../Types'
import { addTransactionCapability, initAuthCreds } from '../../Utils/auth-utils'
import type { BinaryNode } from '../../WABinary'

const makeNewsletterSocket = jest.fn()
jest.unstable_mockModule('../../Socket/newsletter', () => ({ makeNewsletterSocket }))
const { makeMessagesSocket } = await import('../../Socket/messages-send')

const ME = 'me:1@s.whatsapp.net'
const ME_LID = 'melid:1@lid'
const CONTACT = 'contact@s.whatsapp.net'
const CONTACT_LID = 'contactlid@lid'
const logger = P({ level: 'silent' })

function makeFixture(getPNForLID: (lid: string) => Promise<string | null>) {
	const data: SignalDataSet = {}
	const store: SignalKeyStore = {
		get<T extends keyof SignalDataTypeMap>(type: T, ids: string[]) {
			const result: Record<string, SignalDataTypeMap[T]> = {}
			for (const id of ids) {
				const value = data[type]?.[id]
				if (value !== undefined && value !== null) result[id] = value
			}

			return result
		},
		set(update) {
			for (const type of Object.keys(update) as (keyof SignalDataTypeMap)[]) {
				Object.assign((data[type] ??= {}), update[type])
			}
		}
	}
	const keys = addTransactionCapability(store, logger, { maxCommitRetries: 1, delayBetweenTriesMs: 0 })
	const creds = initAuthCreds()
	creds.me = { id: ME, lid: ME_LID, name: 'Test' }
	const sendNode = jest.fn<(node: BinaryNode) => Promise<void>>().mockResolvedValue(undefined)
	const devices: Record<string, unknown> = {
		melid: [],
		me: [],
		contactlid: [{ user: 'contactlid', server: 'lid', device: 0 }],
		contact: [{ user: 'contact', server: 's.whatsapp.net', device: 0 }]
	}
	makeNewsletterSocket.mockReturnValue({
		authState: { creds, keys },
		signalRepository: {
			lidMapping: {
				getLIDForPN: async () => CONTACT_LID,
				getPNForLID
			},
			validateSession: async () => ({ exists: true }),
			encryptMessage: async () => ({ type: 'msg', ciphertext: Buffer.from('synthetic-ciphertext') })
		},
		query: jest.fn<(node: BinaryNode) => Promise<BinaryNode>>().mockResolvedValue({ tag: 'iq', attrs: {} }),
		sendNode,
		serverProps: { privacyTokenOn1to1: false, lidTrustedTokenIssueToLid: false },
		registerSocketEndHandler: jest.fn()
	})
	const socket = makeMessagesSocket({
		...DEFAULT_CONNECTION_CONFIG,
		logger,
		auth: { creds, keys },
		userDevicesCache: {
			get: <T>(key: string) => devices[key] as T | undefined,
			set: () => true,
			del: () => 0,
			flushAll: () => {}
		},
		enableRecentMessageCache: false
	})
	const sent = () => sendNode.mock.calls.at(-1)?.[0]

	return { socket, sent }
}

describe('relayMessage peer_recipient_pn', () => {
	afterEach(() => {
		jest.restoreAllMocks()
		makeNewsletterSocket.mockReset()
	})

	it('puts the device-less PN next to a LID destination', async () => {
		const { socket, sent } = makeFixture(async () => 'contact:0@s.whatsapp.net')
		await socket.relayMessage(CONTACT_LID, { conversation: 'test' }, { messageId: 'lid-send' })

		expect(sent()?.attrs.to).toBe(CONTACT_LID)
		expect(sent()?.attrs.peer_recipient_pn).toBe(CONTACT)
	})

	it('sends without the attribute when the PN is unknown or the lookup fails', async () => {
		const unknown = makeFixture(async () => null)
		await unknown.socket.relayMessage(CONTACT_LID, { conversation: 'test' }, { messageId: 'no-pn' })
		expect(unknown.sent()?.attrs.peer_recipient_pn).toBeUndefined()

		const failing = makeFixture(async () => {
			throw new Error('synthetic lookup failure')
		})
		await failing.socket.relayMessage(CONTACT_LID, { conversation: 'test' }, { messageId: 'lookup-error' })
		expect(failing.sent()?.attrs.to).toBe(CONTACT_LID)
		expect(failing.sent()?.attrs.peer_recipient_pn).toBeUndefined()
	})

	it('leaves PN destinations alone', async () => {
		const getPNForLID = jest.fn(async () => CONTACT)
		const { socket, sent } = makeFixture(getPNForLID)
		await socket.relayMessage(CONTACT, { conversation: 'test' }, { messageId: 'pn-send' })

		expect(sent()?.attrs.to).toBe(CONTACT)
		expect(sent()?.attrs.peer_recipient_pn).toBeUndefined()
		expect(getPNForLID).not.toHaveBeenCalled()
	})
})
