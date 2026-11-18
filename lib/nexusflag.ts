/*
 * NexusFlag demo: the only file that knows about the NexusFlag SDK.
 * The SDK is loaded at runtime from a path (not an npm dependency). If it is
 * missing or NEXUSFLAG_API_KEY is unset, the shop behaves like stock Juice Shop.
 */

import path from 'node:path'
import { type Request, type Response } from 'express'
import * as security from './insecurity'
import logger from './logger'
import { QuantityModel } from '../models/quantity'

interface NexusFlagContext {
  userId: string
  [attribute: string]: string | number | boolean
}

interface NexusFlagClientLike {
  waitForReady: () => Promise<unknown>
  evaluate: (flagKey: string, context: NexusFlagContext, fallback: boolean) => boolean
  recordOutcome: (flagKey: string, outcome: { success: boolean, durationMs: number }) => void
  close: () => Promise<unknown>
  getStatus?: () => { ready: boolean, transport: string, seq: number | null, lastError: string | null }
}

type NexusFlagClientCtor = new (options: { apiKey: string, baseUrl: string, streamUrl?: string }) => NexusFlagClientLike

let client: NexusFlagClientLike | undefined

function loadSdk (): NexusFlagClientCtor | undefined {
  // Default: a NexusFlag checkout next to this repo (../NexusFlag). start-shop.mjs passes an absolute path.
  const sdkPath = process.env.NEXUSFLAG_SDK_PATH ?? path.resolve(process.cwd(), '../NexusFlag/packages/sdk-node')
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const sdk: unknown = require(sdkPath)
  if (typeof sdk === 'object' && sdk !== null) {
    const ctor = (sdk as { NexusFlagClient?: unknown }).NexusFlagClient
    if (typeof ctor === 'function') return ctor as NexusFlagClientCtor
  }
  return undefined
}

export async function initNexusFlag (): Promise<void> {
  try {
    const apiKey = process.env.NEXUSFLAG_API_KEY
    if (!apiKey) {
      logger.info('NexusFlag demo: NEXUSFLAG_API_KEY not set, flag switch disabled (stock checkout)')
      return
    }
    let Ctor: NexusFlagClientCtor | undefined
    try {
      Ctor = loadSdk()
    } catch (error: unknown) {
      logger.info(`NexusFlag demo: SDK could not be loaded, flag switch disabled (${error instanceof Error ? error.message : String(error)})`)
      return
    }
    if (!Ctor) {
      logger.info('NexusFlag demo: SDK has no NexusFlagClient export, flag switch disabled')
      return
    }
    let created: NexusFlagClientLike
    try {
      created = new Ctor({
        apiKey,
        baseUrl: process.env.NEXUSFLAG_BASE_URL ?? 'http://127.0.0.1:3001',
        streamUrl: process.env.NEXUSFLAG_STREAM_URL ?? 'http://127.0.0.1:4000'
      })
    } catch (error: unknown) {
      logger.info(`NexusFlag demo: SDK constructor failed, flag switch disabled (${error instanceof Error ? error.message : String(error)})`)
      return
    }
    client = created
    await created.waitForReady()
    const status = created.getStatus?.()
    if (status?.ready === true) {
      logger.info(`NexusFlag demo: client ready (bootstrapped, seq ${String(status.seq)}, transport ${status.transport}), flag "new-delivery-pricing" active`)
    } else {
      logger.info(`NexusFlag demo: client NOT bootstrapped, serving coded fallbacks (v1) until the platform answers (transport ${status?.transport ?? 'unknown'}, lastError ${status?.lastError ?? 'none'})`)
    }

    if (process.env.NEXUSFLAG_DEMO_STOCK !== 'off') {
      try {
        await QuantityModel.update({ quantity: 1000000 }, { where: {} })
        logger.info('NexusFlag demo: all product stock set to 1000000')
      } catch (error: unknown) {
        logger.info(`NexusFlag demo: stock top-up failed (${error instanceof Error ? error.message : String(error)})`)
      }
    }
  } catch (error: unknown) {
    logger.info(`NexusFlag demo: init failed (${error instanceof Error ? error.message : String(error)})`)
  }
}

export async function closeNexusFlag (): Promise<void> {
  const current = client
  client = undefined
  if (!current) return
  try {
    await current.close()
  } catch {
    // never throw from shutdown
  }
}

/**
 * Is the feature flag ON for the shopper making this request?
 *
 * Used inline around the code a feature changes: `if (isFeatureOn('my-flag', req, res)) { new } else { current }`.
 * When ON, the request's result is reported to NexusFlag when it finishes (failure = HTTP 5xx); that is what
 * AutoPilot watches to switch the feature off again. Never throws: any problem counts as OFF (current behaviour).
 * Tags the response with X-Checkout-Version v2 (new) / v1 (current) for the demo traffic script.
 */
export function isFeatureOn (flagKey: string, req: Request, res: Response): boolean {
  let on = false
  try {
    const customer = client ? security.authenticatedUsers.from(req) : undefined
    if (client && customer?.data) {
      const email = String(customer.data.email ?? '')
      const context: NexusFlagContext = {
        userId: String(customer.data.id),
        email,
        demo: email.endsWith('@demo.local')
      }
      on = client.evaluate(flagKey, context, false) === true
    }
  } catch {
    on = false
  }

  try {
    if (!res.headersSent) res.setHeader('X-Checkout-Version', on ? 'v2' : 'v1')
    if (on) {
      const started = Date.now()
      res.on('finish', () => {
        try {
          client?.recordOutcome(flagKey, { success: res.statusCode < 500, durationMs: Date.now() - started })
        } catch {
          // telemetry must never affect the shop
        }
      })
    }
  } catch {
    // tagging and reporting are best effort
  }
  return on
}
