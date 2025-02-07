/* eslint-disable */
import { exponentialBackoff } from './helpers.js'
import { resolveRequestDocument } from './resolveRequestDocument.js'
import type { RequestDocument, Variables } from './types.js'
import { ClientError } from './types.js'
import { TypedDocumentNode } from '@graphql-typed-document-node/core'
// import type WebSocket from 'ws'

const CONNECTION_INIT = `connection_init`
const CONNECTION_ACK = `connection_ack`
const PING = `ping`
const PONG = `pong`
const START = `start`
const DATA = `data`
const ERROR = `error`
const STOP = `stop`

type MessagePayload = { [key: string]: any }

type SubscribePayload<V extends Variables = Variables, E = any> = {
  operationName?: string | null
  query: string
  variables?: V
  extensions?: E
}

class GraphQLWebSocketMessage<A = MessagePayload> {
  private _type: string
  private _id?: string
  private _payload?: A

  public get type(): string {
    return this._type
  }
  public get id(): string | undefined {
    return this._id
  }
  public get payload(): A | undefined {
    return this._payload
  }

  constructor(type: string, payload?: A, id?: string) {
    this._type = type
    this._payload = payload
    this._id = id
  }

  public get text(): string {
    const result: any = { type: this.type }
    if (this.id != null && this.id != undefined) result.id = this.id
    if (this.payload != null && this.payload != undefined) result.payload = this.payload
    return JSON.stringify(result)
  }

  static parse<A>(data: string, f: (payload: any) => A): GraphQLWebSocketMessage<A> {
    const { type, payload, id }: { type: string; payload: any; id: string } = JSON.parse(data)
    return new GraphQLWebSocketMessage(type, f(payload), id)
  }
}

export type SocketHandler = {
  onInit?: <T>() => Promise<T>
  onAcknowledged?: <A>(payload?: A) => Promise<void>
  onPing?: <In, Out>(payload: In) => Promise<Out>
  onPong?: <T>(payload: T) => any
  onClose?: () => any
}

export type UnsubscribeCallback = () => void

export interface GraphQLSubscriber<T, E = unknown> {
  next?(data: T, extensions?: E): void
  error?(errorValue: ClientError): void
  complete?(): void
}

type SubscriptionRecord = {
  subscriber: GraphQLSubscriber<unknown, unknown>
  query: string
  variables?: Variables
}

type SocketState = {
  acknowledged: boolean
  lastRequestId: number
  subscriptions: { [key: string]: SubscriptionRecord }
}

export class GraphQLWebSocketClient {
  static PROTOCOL = `graphql-ws`

  private url: string
  private socket: WebSocket
  private socketState: SocketState = { acknowledged: false, lastRequestId: 0, subscriptions: {} }
  private socketHandler: SocketHandler

  constructor(url: string, socketHandler: SocketHandler) {
    this.url = url
    this.socketHandler = socketHandler
    this.socket = new WebSocket(url, 'graphql-ws')
    this.initialize()
  }

  private isOpen() {
    return this.socket.readyState === WebSocket.OPEN
  }

  private async initialize(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const { onInit, onAcknowledged, onPing, onPong } = this.socketHandler
      this.socket.addEventListener(`open`, async (e) => {
        this.socketState.acknowledged = false
        this.socketState.subscriptions = {}
        exponentialBackoff({
          func: async () => {
            this.socket.send(ConnectionInit(onInit ? await onInit() : null).text)
          },
          fallback: (e) => {
            console.warn(e)
          },
          maxRetry: 5,
          timeout: 1000,
        })
      })

      this.socket.addEventListener(`close`, (e) => {
        this.socketState.acknowledged = false
        this.socketState.subscriptions = {}
      })

      this.socket.addEventListener(`error`, (e) => {
        console.error(e)
      })

      this.socket.addEventListener(`message`, (e) => {
        try {
          const message = parseMessage(e.data)
          switch (message.type) {
            case CONNECTION_ACK: {
              if (this.socketState.acknowledged) {
                console.warn(`Duplicate CONNECTION_ACK message ignored`)
              } else {
                this.socketState.acknowledged = true
                if (onAcknowledged) onAcknowledged(message.payload)
              }
              resolve()
              return
            }
            case PING: {
              if (onPing) onPing(message.payload).then((r) => this.socket.send(Pong(r).text))
              else this.socket.send(Pong(null).text)
              return
            }
            case PONG: {
              if (onPong) onPong(message.payload)
              return
            }
          }

          if (!this.socketState.acknowledged) {
            // Web-socket connection not acknowledged
            return
          }

          if (
            message.id === undefined ||
            message.id === null ||
            !this.socketState.subscriptions[message.id]
          ) {
            // No subscription identifer or subscription indentifier is not found
            return
          }
          const { query, variables, subscriber } = this.socketState.subscriptions[message.id]!

          switch (message.type) {
            case DATA: {
              if (!message.payload.errors && message.payload.data) {
                subscriber.next && subscriber.next(message.payload.data)
              }
              if (message.payload.errors) {
                subscriber.error &&
                  subscriber.error(new ClientError({ ...message.payload, status: 200 }, { query, variables }))
              } else {
              }
              return
            }

            case ERROR: {
              subscriber.error &&
                subscriber.error(
                  new ClientError({ errors: message.payload, status: 200 }, { query, variables }),
                )
              return
            }

            case STOP: {
              subscriber.complete && subscriber.complete()
              delete this.socketState.subscriptions[message.id]
              return
            }
          }
        } catch (e) {
          // Unexpected errors while handling graphql-ws message
          console.error(e)
          this.socket.close(1006)
        }
        this.socket.close(4400, `Unknown graphql-ws message.`)
      })
    })
  }

  private generateSubscriptionId() {
    return (this.socketState.lastRequestId++).toString()
  }

  private makeSubscribe<T, V extends Variables, E>(
    subscriptionId: string,
    query: string,
    operationName: string | undefined,
    subscriber: GraphQLSubscriber<T, E>,
    variables?: V,
  ) {
    this.socketState.subscriptions[subscriptionId] = { query, variables, subscriber }

    exponentialBackoff({
      func: () => {
        this.socket.send(Subscribe(subscriptionId, { query, operationName, variables }).text)
      },
      fallback: (e) => {
        console.log('Failed to connect websocket connection', e)
        delete this.socketState.subscriptions[subscriptionId]
      },
      maxRetry: 5,
      timeout: 1000,
    })
  }

  private getUnsubsctiber(subscriptionId: string): UnsubscribeCallback {
    return () => {
      try {
        this.socket.send(Stop(subscriptionId).text)
      } catch (e) {
        console.log('Failed to stop websocket connection')
      }
      delete this.socketState.subscriptions[subscriptionId]
    }
  }

  rawRequest<T = any, V extends Variables = Variables, E = any>(
    query: string,
    variables?: V,
  ): Promise<{ data: T; extensions?: E }> {
    return new Promise<{ data: T; extensions?: E; headers?: Headers; status?: number }>((resolve, reject) => {
      let result: { data: T; extensions?: E }
      this.rawSubscribe(
        query,
        {
          next: (data: T, extensions: E) => (result = { data, extensions }),
          error: reject,
          complete: () => resolve(result),
        },
        variables,
      )
    })
  }

  request<T = any, V extends Variables = Variables>(
    document: RequestDocument | TypedDocumentNode<T, V>,
    variables?: V,
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      let result: T
      this.subscribe(
        document,
        {
          next: (data: T) => (result = data),
          error: reject,
          complete: () => resolve(result),
        },
        variables,
      )
    })
  }

  subscribe<T = any, V extends Variables = Variables, E = any>(
    document: RequestDocument | TypedDocumentNode<T, V>,
    subscriber: GraphQLSubscriber<T, E>,
    variables?: V,
  ): UnsubscribeCallback {
    const { query, operationName } = resolveRequestDocument(document)

    const subscriberId = this.generateSubscriptionId()
    if (!this.isOpen()) {
      this.socket = new WebSocket(this.url, 'graphql-ws')
      this.initialize().then(() => {
        this.makeSubscribe(subscriberId, query, operationName, subscriber, variables)
      })
    } else {
      this.makeSubscribe(subscriberId, query, operationName, subscriber, variables)
    }

    return this.getUnsubsctiber(subscriberId)
  }

  rawSubscribe<T = any, V extends Variables = Variables, E = any>(
    query: string,
    subscriber: GraphQLSubscriber<T, E>,
    variables?: V,
  ): UnsubscribeCallback {
    const subscriberId = this.generateSubscriptionId()
    if (!this.isOpen()) {
      this.socket = new WebSocket(this.url, 'graphql-ws')
      this.initialize().then(() => this.makeSubscribe(subscriberId, query, undefined, subscriber, variables))
    } else {
      this.makeSubscribe(subscriberId, query, undefined, subscriber, variables)
    }

    return this.getUnsubsctiber(subscriberId)
  }

  ping(payload: Variables) {
    this.socket.send(Ping(payload).text)
  }

  close() {
    this.socket.close(1000)
  }
}

// Helper functions

function parseMessage<A = any>(data: string, f: (payload: any) => A = (a) => a): GraphQLWebSocketMessage<A> {
  const m = GraphQLWebSocketMessage.parse<A>(data, f)
  return m
}

function ConnectionInit<A>(payload?: A) {
  return new GraphQLWebSocketMessage(CONNECTION_INIT, payload)
}

function Ping(payload: any) {
  return new GraphQLWebSocketMessage(PING, payload, undefined)
}
function Pong(payload: any) {
  return new GraphQLWebSocketMessage(PONG, payload, undefined)
}

function Subscribe(id: string, payload: SubscribePayload) {
  return new GraphQLWebSocketMessage(START, payload, id)
}

function Stop(id: string) {
  return new GraphQLWebSocketMessage(STOP, undefined, id)
}
