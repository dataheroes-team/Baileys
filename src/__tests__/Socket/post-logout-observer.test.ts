import { Boom } from '@hapi/boom'
import { EventEmitter } from 'events'
import { isDeviceRemovedError, observeAfterLogout } from '../../Socket/post-logout-observer'
import type { ILogger } from '../../Utils/logger'
import type { BinaryNode } from '../../WABinary'

const makeLogger = () => {
	const lines: Array<{ msg: string; obj: Record<string, unknown> }> = []
	const logger = {
		info: (obj: Record<string, unknown>, msg: string) => lines.push({ msg, obj })
	} as unknown as ILogger
	return { logger, lines }
}

const makeWs = () => {
	let closeCalls = 0
	const ws = Object.assign(new EventEmitter(), {
		close: async () => {
			closeCalls += 1
			ws.emit('close', 1000)
		}
	})
	return { ws, closeCalls: () => closeCalls }
}

const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

describe('isDeviceRemovedError', () => {
	const conflict = (type: string) => ({ tag: 'conflict', attrs: { type } })

	it('matches the stream error of a removed companion', () => {
		expect(isDeviceRemovedError(new Boom('x', { statusCode: 401, data: conflict('device_removed') }))).toBe(true)
	})

	it('ignores our own logout, other conflicts and other codes', () => {
		expect(isDeviceRemovedError(new Boom('Intentional Logout', { statusCode: 401 }))).toBe(false)
		expect(isDeviceRemovedError(new Boom('x', { statusCode: 401, data: conflict('replaced') }))).toBe(false)
		expect(isDeviceRemovedError(new Boom('x', { statusCode: 440, data: conflict('device_removed') }))).toBe(false)
		expect(isDeviceRemovedError(undefined)).toBe(false)
	})
})

describe('observeAfterLogout', () => {
	const noFrames = async () => {}

	it('closes the socket itself when the hold expires', async () => {
		const { logger, lines } = makeLogger()
		const { ws, closeCalls } = makeWs()

		observeAfterLogout({ ws, decodeFrame: noFrames, logger, holdMs: 10 })
		await wait(40)

		expect(closeCalls()).toBe(1)
		const finished = lines.filter(line => line.msg === 'post-logout hold finished')
		expect(finished).toHaveLength(1)
		expect(finished[0]?.obj.closedBy).toBe('hold-expired')
	})

	it('reports a close by the server and does not close again', async () => {
		const { logger, lines } = makeLogger()
		const { ws, closeCalls } = makeWs()

		observeAfterLogout({ ws, decodeFrame: noFrames, logger, holdMs: 10 })
		ws.emit('close', 1006)
		await wait(40)

		expect(closeCalls()).toBe(0)
		const finished = lines.find(line => line.msg === 'post-logout hold finished')
		expect(finished?.obj).toMatchObject({ closedBy: 'server', closeCode: 1006 })
	})

	it('tells a close by the caller from a close by the server', async () => {
		const { logger, lines } = makeLogger()
		const { ws } = makeWs()

		observeAfterLogout({ ws, decodeFrame: noFrames, logger, holdMs: 10 })
		await ws.close()
		await wait(40)

		const finished = lines.filter(line => line.msg === 'post-logout hold finished')
		expect(finished).toHaveLength(1)
		expect(finished[0]?.obj.closedBy).toBe('local')
	})

	it('logs tags and short attributes but no addresses or payload', async () => {
		const { logger, lines } = makeLogger()
		const { ws } = makeWs()
		const node: BinaryNode = {
			tag: 'notification',
			attrs: { type: 'mex', from: '79990000000@s.whatsapp.net', id: 'SECRET' },
			content: [{ tag: 'update', attrs: {}, content: Buffer.from('payload') }]
		}
		const decodeFrame = async (_: Buffer, onFrame: (frame: Uint8Array | BinaryNode) => void) => onFrame(node)

		observeAfterLogout({ ws, decodeFrame, logger, holdMs: 10 })
		ws.emit('message', Buffer.alloc(1))
		await wait(40)

		const frame = lines.find(line => line.msg === 'post-logout frame')
		expect(frame?.obj.frame).toEqual({ tag: 'notification', attrs: { type: 'mex' }, children: ['update'] })
		expect(JSON.stringify(lines)).not.toContain('79990000000')
	})
})
