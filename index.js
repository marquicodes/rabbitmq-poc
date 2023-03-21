import rabbitMQ from './src/rabbitmq-connector.js'

const queueName = 'pocQueue'

process.once('SIGINT', async () => {
  console.warn('\nSIGINT received - Terminating the process...')
  await rabbitMQ.disconnect()
})

rabbitMQ.on('reconnect', () => {
  console.debug('[AMQP] The connection reestablished.')
  rabbitMQ.connection.then((connection) => {
    addConnectionListener(connection)
    startPublisher()
  })
})

/**
 * Adds a listener to the RabbitMQ broker connection for the close event.
 *
 * @param {object} connection the established connection to RabbitMQ broker
 */
function addConnectionListener (connection) {
  connection.on('close', function (err) {
    if (!err) {
      console.info('[AMQP] Connection closed successfully.')
    } else {
      console.error('[AMQP] %s', err.message)
      switch (err.code) {
        case 320:
          // Connection closed: 320 CONNECTION_FORCED - broker forced
          // connection closure with reason 'shutdown'
          console.info('[AMQP] Reconnecting ...')
          run()
          break
        default:
          console.info('[AMQP] Connection closed.')
      }
    }
  })
}

/**
 * Creates channels and asserts queue existence for the publisher.
 */
async function startPublisher () {
  const channelA = await rabbitMQ.createChannel()
  console.log('- Channel A id:', channelA.ch)
  // Sets a time out to close channel A (no particular reason, just testing)
  setTimeout(() => {
    rabbitMQ.closeChannel(channelA)
  }, 30000)

  const channelB = await rabbitMQ.createChannel()
  console.log('- Channel B id:', channelB.ch)

  const queue = await rabbitMQ.assertQuorumQueue(channelB, queueName)
  console.info('Queue info:', queue)
}

/**
 * Test scenario on connection and publisher.
 */
async function run () {
  const connection = await rabbitMQ.connect()
  if (!connection) {
    return
  }
  addConnectionListener(connection)
  await startPublisher()
}

run()
