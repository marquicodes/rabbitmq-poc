import { EventEmitter } from 'node:events'
import amqp from 'amqplib'
import * as dotenv from 'dotenv'
dotenv.config()

const USER = process.env.RABBITMQ_USER || 'guest'
const PASS = process.env.RABBITMQ_PASS || 'guest'
const NODES = process.env.RABBITMQ_NODES || 'localhost:5672'
const VHOST = process.env.RABBITMQ_VHOST || ''
const CONN_NAME = process.env.CONNECTION_NAME || ''
const RECONNECT_DELAY = process.env.RECONNECT_DELAY || 5000

class RabbitMQConnector extends EventEmitter {
  #nodes // broker nodes
  #nodeIndex // the index of the broker node that the connection is established
  #connection
  #channels
  #reconnectTimeout

  constructor () {
    super()
    this.#nodes = NODES.split(',')
    this.#nodeIndex = -1
    this.#connection = null
    this.#channels = []
    this.#reconnectTimeout = null
  }

  /**
   * Returns the connection as an object, will connect first if not already
   * connected.
   *
   * @returns {Promise<object>} the connection as an object
   */
  get connection () {
    return this.#connection ? Promise.resolve(this.#connection) : this.connect()
  }

  /**
   * Tries to establish a connection to a RabbitMQ broker. If a connection error
   * occures on a node, it tries to connect to a different node. If all nodes
   * are unavailable, it tries to reconnect after a predefined interval. In this
   * implementation there is no maximum number of reconnection attempts.
   *
   * @param {object} options an object that specifies certain properties, it can
   * be empty or omitted. The relevant fields in options are:
   * - reason: it should be supplied in case of a reconnection to emit the
   * apropriate event. Possible value ('reconnect')
   * @returns {object} the established connection
   */
  async connect (options = {}) {
    // if all specified broker nodes are unavailable
    if (this.#nodeIndex === this.#nodes.length - 1) {
      this.#nodeIndex = -1
      this.reconnect() // tries to reconnect after some time
      return
    }

    try {
      const node = this.#nodes[++this.#nodeIndex]
      const connection = await amqp.connect(
        `amqp://${USER}:${PASS}@${node}/${VHOST}?heartbeat=60`,
        { clientProperties: { connection_name: CONN_NAME } }
      )

      connection.on('error', function (err) {
        if (err.message !== 'Connection closing') {
          console.error('[AMQP] Connection error %s', err.message)
        }
      })

      // connection.on('close', function (err) {
      //   if (!err) {
      //     console.info('[AMQP] Connection closed successfully.')
      //   } else {
      //     console.error('[AMQP] %s', err.message)
      //     switch (err.code) {
      //       case 320:
      //         // Connection closed: 320 CONNECTION_FORCED - broker forced
      //         // connection closure with reason 'shutdown'
      //         console.info('[AMQP] Reconnecting ...')
      //         this.reconnect()
      //         break
      //       default:
      //         console.info('[AMQP] Connection closed.')
      //     }
      //   }
      // })

      if (options?.reason === 'reconnect') {
        this.emit(options.reason)
      } else {
        console.info('[AMQP] The connection is successfully established.')
      }

      this.#connection = connection
      return connection
    } catch (err) {
      if (err.message.startsWith('connect ECONNREFUSED')) {
        console.error('[AMQP] Connection error: %s', err.message)
        return await this.connect()
      } else {
        console.error('[AMQP] %s', err.message)
      }
    }
  }

  /**
   * Tries to reconnect to the RabbitMQ broker after the specified delay.
   *
   * @param {number} delay the time, in milliseconds, that the process waits
   * before trying to reconnect. Default is 5 seconds.
   */
  reconnect (delay = RECONNECT_DELAY) {
    const options = { reason: 'reconnect' }
    this.#reconnectTimeout = setTimeout(() => this.connect(options), delay)
  }

  /**
   * Creates and returns a channel.
   *
   * @returns {object} the created channel
   */
  async createChannel () {
    const channel = await this.#connection.createChannel()
    console.log("[AMQP] Channel with id '%s' was created.", channel.ch)

    channel.on('error', function (err) {
      console.error('[AMQP] Channel error %s', err.message)
    })

    channel.on('close', function (err) {
      if (!err) {
        console.info('[AMQP] Channel closed successfully.')
      } else {
        console.error('[AMQP] %s', err.message)
        // TODO check if the channel should be removed from the list, as it did
        // no go through the proper channel closure
        this.createChannel()
      }
    })

    this.#channels.push(channel)
    return channel
  }

  /**
   * Closes the specified channel and removes it from the available channels
   * list.
   *
   * @param {object} channel the channel to be closed
   */
  async closeChannel (channel) {
    const channelNumber = channel.ch
    try {
      console.info('[AMQP] Closing channel %s ...', channelNumber)
      await channel.close()
      // removes the closed channel from the active channels array
      const idx = this.#channels.findIndex((c) => c.ch === channelNumber)
      this.#channels.splice(idx, 1)
    } catch (err) {
      console.error(
        'Error while closing channel %s. %s',
        channelNumber,
        err.message
      )
    }
  }

  /**
   * Closes any open channel and lastly the connection to the RabbitMQ broker.
   */
  async disconnect () {
    // no active connection
    if (!this.#connection) {
      if (this.#reconnectTimeout) {
        // there is a timeout set for reconnection
        clearTimeout(this.#reconnectTimeout)
        this.#reconnectTimeout = null
      }
      return
    }

    try {
      // closes all opened channels
      if (this.#channels.length > 0) {
        await Promise.all(
          this.#channels.map(async (channel) => {
            await this.closeChannel(channel)
          })
        )
      }

      console.assert(
        this.#channels.length === 0,
        'Not all channels are closed.'
      )

      // closes the connection
      await this.#connection.close()
      this.#connection = null
      this.#nodeIndex = -1
      this.#nodes = []
    } catch (err) {
      console.error('Error while disconnecting... %s', err.message)
    }
  }

  /**
   * Asserts the existence of the specified exchange, or creates a new one. If
   * the exchange exists already and has properties different to those supplied,
   * the channel will 'splode.
   *
   * @param {object} channel the channel to assert exchange existence
   * @param {string} exchange the name of the exchange
   * @param {string} type the type of the exchange
   * @param {object} options an object that may be empty, null, or omitted. The
   * relevant fields in options are:
   *  - durable: if true, the exchange will survive broker restarts. Defaults to
   * true.
   *  - internal: if true, messages cannot be published directly to the exchange
   * (i.e., it can only be the target of bindings, or possibly create messages
   * ex-nihilo). Defaults to false.
   *  - autoDelete: if true, the exchange will be destroyed once the number of
   * bindings for which it is the source drop to zero. Defaults to false.
   *  - alternateExchange (string): an exchange to send messages to if this
   * exchange can’t route them to any queues.
   *  - arguments (object): any additional arguments that may be needed by an
   * exchange type.
   * @returns {string} the exchange name
   */
  async assertExchange (channel, exchange, type, options) {
    return await channel.assertExchange(exchange, type, options)
  }

  /**
   * Asserts the existence of the specified Quorum queue, or creates a new one.
   * This operation is idempotent given identical arguments; however, it will
   * crash the channel if the queue already exists but has different properties.
   *
   * @param {object} channel the channel to assert queue existence
   * @param {string} queue the name of the queue
   * @param {object} options an object that may be empty, null, or omitted. The
   * relevant fields in options are:
   *  - exclusive: if true, scopes the queue to the connection (defaults to
   * false)
   *  - durable: if true, the queue will survive broker restarts, modulo the
   * effects of exclusive and autoDelete; this defaults to true if not supplied,
   * unlike the others
   *  - autoDelete: if true, the queue will be deleted when the number of
   * consumers drops to zero (defaults to false)
   *  - arguments: object that contains additional arguments, usually parameters
   * for some kind of broker-specific extension e.g., high availability, TTL.
   * @returns {object} an object that contains the queue name, message count and
   * consumer count
   */
  async assertQuorumQueue (channel, queue, options) {
    const quorumOptions = {
      arguments: {
        'x-queue-type': 'quorum',
        'x-queue-leader-locator': 'balanced'
      },
      durable: true
    }

    // hack - deep cloning arguments object
    const args = { ...quorumOptions.arguments, ...options?.arguments }
    const opts = { ...quorumOptions, ...options, ...{ arguments: args } }
    return await channel.assertQueue(queue, opts)
  }

  /**
   * Publishes a single message to the specified exchange or queue.
   *
   * @param {object} channel the channel to use to publish the message
   * @param {string} exchange the name of the exchange to publish the message; a
   * special case is sending '' as the exchange, which will send directly to the
   * queue named by the routing key
   * @param {string} routingKey determines where the message goes
   * @param {string} message the message content to be published (internally it
   * is converted into a buffer as expected from AMQP lib)
   * @param {object} options an object that contains the remaining parameters,
   * and are divided into those that have some meaning to `RabbitMQ` and those
   * that will be ignored by `RabbitMQ` but passed on to consumers. It may be
   * empty, or omitted in which case defaults will apply.
   * Extensive information on the fields that can be provided in options can be
   * found [here]{@link https://amqp-node.github.io/amqplib/channel_api.html#channel_publish}
   * @returns {boolean} false in case the channel’s write buffer is ‘full’, true
   * otherwise. If it returns false, it will emit a 'drain' event at some later
   * time
   * @throws will throw an error if the message cannot be converted into a
   * buffer
   */
  async publish (channel, exchange, routingKey, message, options) {
    const content = Buffer.from(message)
    return await channel.publish(exchange, routingKey, content, options)
  }

  /**
   * Sets up a consumer with a callback to be invoked with each message.
   *
   * @param {object} channel the channel to use to consume message(s)
   * @param {string} queue the name of the queue from which message(s) will be
   * consumed
   * @param {consumeMessageCallback} callback the function to be invoked every
   * time a message gets consumed
   * @param {object} options an object that may be omitted. The relevant fields
   * in options are:
   *  - consumerTag: a name which the server will use to distinguish message
   * deliveries for the consumer; mustn’t be already in use on the channel. It’s
   * usually easier to omit this, in which case the server will create a random
   * name and supply it in the reply.
   *  - noLocal: RabbitMQ doesn’t implement it though, and will ignore it.
   * Defaults to false.
   *  - noAck: if true, the broker won’t expect an acknowledgement of messages
   * delivered to this consumer; i.e., it will dequeue messages as soon as they
   * have been sent down the wire. Defaults to false (i.e., you will be expected
   * to acknowledge messages)
   *  - exclusive: if true, the broker won’t let anyone else consume from this
   * queue; if there already is a consumer, there goes your channel (so usually
   * only useful if you’ve made a ‘private’ queue by letting the server choose
   * its name)
   *  - priority: gives a priority to the consumer; higher priority consumers
   * get messages in preference to lower priority consumers.
   *  - arguments: arbitrary arguments
   * @returns {string} the consumerTag, it is necessary to save it in case later
   * you need to cancel this consume operation (i.e., to stop getting messages)
   */
  async consume (channel, queue, callback, options) {
    return await channel.consume(queue, callback, options)
  }

  /**
   * This callback processes the messages consumed from a queue.
   *
   * @callback consumeMessageCallback
   * @param {object} msg the message
   * @param {object} msg.content a buffer containing the bytes published
   * @param {object} msg.fields has a handful of bookkeeping values largely of
   * interest only to the library code:
   *  - deliveryTag: a serial number for the message;
   *  - consumerTag: identifying the consumer for which the message is destined;
   *  - exchange: information about the exchange;
   *  - routingKey: the routing information with which the message was
   * published; and,
   * - redelivered: if true indicates that this message has been delivered
   * before and been handed back to the server (e.g., by a nack or recover
   * operation)
   * @param {object} msg.properties contains the message properties, which are
   * the options and configuration with which the message is transmitted
   */
}

export default new RabbitMQConnector()
