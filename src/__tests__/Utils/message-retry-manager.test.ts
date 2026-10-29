import { MessageRetryManager } from '../../Utils/message-retry-manager'
import logger from '../../Utils/logger'

describe('MessageRetryManager.restoreRetryCount', () => {
	it('continues counting from a value kept outside the manager', () => {
		const manager = new MessageRetryManager(logger, 5)
		manager.restoreRetryCount('id', 2)
		expect(manager.incrementRetryCount('id')).toBe(3)
	})

	it('never lowers the count', () => {
		const manager = new MessageRetryManager(logger, 5)
		manager.incrementRetryCount('id')
		manager.incrementRetryCount('id')
		manager.restoreRetryCount('id', 1)
		expect(manager.getRetryCount('id')).toBe(2)
	})

	it('reports the limit when the carried count reaches it', () => {
		const manager = new MessageRetryManager(logger, 5)
		manager.restoreRetryCount('id', 5)
		expect(manager.hasExceededMaxRetries('id')).toBe(true)
	})
})
