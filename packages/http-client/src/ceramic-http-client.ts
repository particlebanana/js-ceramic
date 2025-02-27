import { combineURLs, typeStreamID } from './utils'
import { Document } from './document'

import type { DID } from 'dids'
import {
  CreateOpts,
  CeramicApi,
  CeramicCommit,
  Context,
  fetchJson,
  Stream,
  StreamConstructor,
  StreamHandler,
  StreamUtils,
  LoadOpts,
  MultiQuery,
  PinApi,
  UpdateOpts,
  SyncOptions,
  AnchorStatus,
} from '@ceramicnetwork/common'
import { TileDocument } from '@ceramicnetwork/stream-tile'
import { Caip10Link } from '@ceramicnetwork/stream-caip10-link'
import { StreamID, CommitID, StreamRef } from '@ceramicnetwork/streamid'
import { RemotePinApi } from './remote-pin-api'

const API_PATH = '/api/v0'
const CERAMIC_HOST = 'http://localhost:7007'

/**
 * Default Ceramic client configuration
 */
export const DEFAULT_CLIENT_CONFIG: CeramicClientConfig = {
  syncInterval: 5000,
}

const DEFAULT_APPLY_COMMIT_OPTS = { anchor: true, publish: true, sync: SyncOptions.PREFER_CACHE }
const DEFAULT_CREATE_FROM_GENESIS_OPTS = {
  anchor: true,
  publish: true,
  sync: SyncOptions.PREFER_CACHE,
}
const DEFAULT_LOAD_OPTS = { sync: SyncOptions.PREFER_CACHE }

/**
 * Ceramic client configuration
 */
export interface CeramicClientConfig {
  /**
   * How frequently the http-client polls the daemon for updates to subscribed-to streams, in milliseconds.
   */
  syncInterval: number
}

/**
 * Ceramic client implementation
 */
export class CeramicClient implements CeramicApi {
  private readonly _apiUrl: string
  /**
   * _streamCache stores handles to Documents that been handed out. This allows us
   * to update the state within the Document object when we learn about changes
   * to the stream. This means that client code with Document references
   * always have access to the most recent known-about version, without needing
   * to explicitly re-load the stream.
   */
  private readonly _streamCache: Map<string, Document>
  private _supportedChains: Array<string>

  public readonly pin: PinApi
  public readonly context: Context

  private readonly _config: CeramicClientConfig
  public readonly _streamConstructors: Record<number, StreamConstructor<Stream>>

  constructor(apiHost: string = CERAMIC_HOST, config: Partial<CeramicClientConfig> = {}) {
    this._config = { ...DEFAULT_CLIENT_CONFIG, ...config }

    this._apiUrl = combineURLs(apiHost, API_PATH)
    // this._streamCache = new LRUMap(config.streamCacheLimit) Not now. We do not know what to do when stream is evicted on HTTP client.
    this._streamCache = new Map()

    this.context = { api: this }

    this.pin = new RemotePinApi(this._apiUrl)

    this._streamConstructors = {
      [TileDocument.STREAM_TYPE_ID]: TileDocument,
      [Caip10Link.STREAM_TYPE_ID]: Caip10Link,
    }
  }

  get did(): DID | undefined {
    return this.context.did
  }

  /**
   * Sets the DID instance that will be used to author commits to streams.
   * @param did
   */
  set did(did: DID) {
    this.context.did = did
  }

  async createStreamFromGenesis<T extends Stream>(
    type: number,
    genesis: any,
    opts: CreateOpts = {}
  ): Promise<T> {
    opts = { ...DEFAULT_CREATE_FROM_GENESIS_OPTS, ...opts }
    const stream = await Document.createFromGenesis(
      this._apiUrl,
      type,
      genesis,
      opts,
      this._config.syncInterval
    )

    const found = this._streamCache.get(stream.id.toString())
    if (found) {
      if (!StreamUtils.statesEqual(stream.state, found.state)) found.next(stream.state)
      return this.buildStream<T>(found)
    } else {
      this._streamCache.set(stream.id.toString(), stream)
      return this.buildStream<T>(stream)
    }
  }

  async loadStream<T extends Stream>(
    streamId: StreamID | CommitID | string,
    opts: LoadOpts = {}
  ): Promise<T> {
    opts = { ...DEFAULT_LOAD_OPTS, ...opts }
    const streamRef = StreamRef.from(streamId)
    let stream = this._streamCache.get(streamRef.baseID.toString())
    if (stream) {
      await stream._syncState(streamRef, opts)
    } else {
      stream = await Document.load(streamRef, this._apiUrl, this._config.syncInterval, opts)
      this._streamCache.set(stream.id.toString(), stream)
    }
    return this.buildStream<T>(stream)
  }

  async multiQuery(queries: Array<MultiQuery>, timeout?: number): Promise<Record<string, Stream>> {
    const queriesJSON = queries.map((q) => {
      return {
        ...q,
        streamId: typeof q.streamId === 'string' ? q.streamId : q.streamId.toString(),
      }
    })

    const results = await fetchJson(this._apiUrl + '/multiqueries', {
      method: 'post',
      body: {
        queries: queriesJSON,
        ...{ timeout },
      },
    })

    return Object.entries(results).reduce((acc, e) => {
      const [k, v] = e
      const state = StreamUtils.deserializeState(v)
      const stream = new Document(state, this._apiUrl, this._config.syncInterval)
      acc[k] = this.buildStream(stream)
      return acc
    }, {})
  }

  loadStreamCommits(streamId: string | StreamID): Promise<Record<string, any>[]> {
    const effectiveStreamId = typeStreamID(streamId)
    return Document.loadStreamCommits(effectiveStreamId, this._apiUrl)
  }

  async applyCommit<T extends Stream>(
    streamId: string | StreamID,
    commit: CeramicCommit,
    opts: CreateOpts | UpdateOpts = {}
  ): Promise<T> {
    opts = { ...DEFAULT_APPLY_COMMIT_OPTS, ...opts }
    const effectiveStreamId: StreamID = typeStreamID(streamId)
    const document = await Document.applyCommit(
      this._apiUrl,
      effectiveStreamId,
      commit,
      opts,
      this._config.syncInterval
    )
    const fromCache = this._streamCache.get(effectiveStreamId.toString())
    if (fromCache) {
      fromCache.next(document.state)
      return this.buildStream<T>(document)
    } else {
      this._streamCache.set(effectiveStreamId.toString(), document)
      return this.buildStream<T>(document)
    }
  }

  async requestAnchor(streamId: string | StreamID, opts: LoadOpts = {}): Promise<AnchorStatus> {
    opts = { ...DEFAULT_LOAD_OPTS, ...opts }
    const { anchorStatus } = await fetchJson(
      `${this._apiUrl}/streams/${streamId.toString()}/anchor`,
      {
        method: 'post',
        body: {
          opts,
        },
      }
    )

    return anchorStatus
  }

  addStreamHandler<T extends Stream>(streamHandler: StreamHandler<T>): void {
    this._streamConstructors[streamHandler.name] = streamHandler.stream_constructor
  }

  findStreamConstructor<T extends Stream>(type: number) {
    const constructor = this._streamConstructors[type]
    if (constructor) {
      return constructor as StreamConstructor<T>
    } else {
      throw new Error(`Failed to find constructor for stream ${type}`)
    }
  }

  private buildStream<T extends Stream = Stream>(stream: Document) {
    const streamConstructor = this.findStreamConstructor<T>(stream.state.type)
    return new streamConstructor(stream, this.context)
  }

  async setDID(did: DID): Promise<void> {
    this.context.did = did
  }

  async getSupportedChains(): Promise<Array<string>> {
    if (this._supportedChains) {
      return this._supportedChains
    }

    // Fetch the chainId from the daemon and cache the result
    const { supportedChains } = await fetchJson(this._apiUrl + '/node/chains')
    this._supportedChains = supportedChains
    return supportedChains
  }

  async close(): Promise<void> {
    Array.from(this._streamCache).map(([, stream]) => {
      stream.complete()
    })
    this._streamCache.clear()
  }
}

export default CeramicClient
