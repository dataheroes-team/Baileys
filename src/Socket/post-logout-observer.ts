import type { ILogger } from '../Utils/logger'
import type { BinaryNode } from '../WABinary'

const MAX_LOGGED_FRAMES = 50
const LOGGED_ATTRIBUTES = ['type', 'class', 'code', 'reason', 'xmlns'] as const

type ObservedSocket = {
	on(event: string, listener: (...args: any[]) => void): unknown
	close(): Promise<void>
}

type ObserverOptions = {
	ws: ObservedSocket
	decodeFrame: (data: Buffer, onFrame: (frame: Uint8Array | BinaryNode) => void) => Promise<void>
	logger: ILogger
	holdMs: number
}

/** True only for the stream error the server sends when it removes this companion, not for our own logout. */
export const isDeviceRemovedError = (error: unknown): boolean => {
	const { output, data } = (error ?? {}) as { output?: { statusCode?: number }; data?: Partial<BinaryNode> }
	return output?.statusCode === 401 && data?.tag === 'conflict' && data.attrs?.type === 'device_removed'
}

/** Tags and short attributes only: payloads and addresses must not reach the logs. */
const describeFrame = (frame: Uint8Array | BinaryNode) => {
	if (frame instanceof Uint8Array) {
		return { binaryLength: frame.length }
	}

	const attrs: Record<string, string> = {}
	for (const key of LOGGED_ATTRIBUTES) {
		const value = frame.attrs?.[key]
		if (value !== undefined) {
			attrs[key] = value
		}
	}

	return {
		tag: frame.tag,
		attrs,
		children: Array.isArray(frame.content) ? frame.content.map(child => child.tag) : undefined
	}
}

/**
 * Keeps an already ended socket open for a while and only logs what the server does with it.
 * Nothing is sent, and frames do not reach the regular handlers: the session is over for the caller.
 */
export const observeAfterLogout = ({ ws, decodeFrame, logger, holdMs }: ObserverOptions) => {
	const startedAt = Date.now()
	let frames = 0
	let finished = false

	// The caller keeps a reference to the socket and may close it during the hold, e.g. while polling for a new QR
	const close = ws.close.bind(ws)
	let closedLocally = false
	ws.close = () => {
		closedLocally = true
		return close()
	}

	const finish = (closedBy: 'server' | 'local' | 'hold-expired', closeCode?: number) => {
		if (finished) {
			return
		}

		finished = true
		clearTimeout(timer)
		logger.info({ closedBy, closeCode, afterMs: Date.now() - startedAt, frames }, 'post-logout hold finished')
	}

	const timer = setTimeout(() => {
		finish('hold-expired')
		close().catch(() => {})
	}, holdMs)
	timer.unref?.()

	ws.on('close', (code?: number) => finish(closedLocally ? 'local' : 'server', code))
	ws.on('message', (data: Buffer) => {
		decodeFrame(data, frame => {
			frames += 1
			if (frames <= MAX_LOGGED_FRAMES) {
				logger.info({ afterMs: Date.now() - startedAt, frame: describeFrame(frame) }, 'post-logout frame')
			}
		}).catch(err => logger.info({ afterMs: Date.now() - startedAt, err: String(err) }, 'post-logout frame undecoded'))
	})

	logger.info({ holdMs }, 'post-logout hold started')
}
