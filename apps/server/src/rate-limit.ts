import { env } from "@my-better-t-app/env/server"
import { createClient } from "redis"

const redisClient = createClient({
  url: env.REDIS_URL,
})

let readyPromise: Promise<unknown> | null = null

const ensureRedisReady = async () => {
  if (!readyPromise) {
    readyPromise = redisClient.connect()
  }
  await readyPromise
}

export interface RateLimitResult {
  allowed: boolean
  remaining: number
  retryAfterSec: number
}

export const checkRateLimit = async (key: string): Promise<RateLimitResult> => {
  await ensureRedisReady()
  const now = Date.now()
  const minuteBucket = Math.floor(now / 60_000)
  const redisKey = `ratelimit:${key}:${minuteBucket}`
  const limit = env.REDIS_RATE_LIMIT_PER_MINUTE

  const current = await redisClient.incr(redisKey)
  if (current === 1) {
    await redisClient.expire(redisKey, 70)
  }

  const remaining = Math.max(0, limit - current)
  const retryAfterSec = Math.max(1, 60 - Math.floor((now % 60_000) / 1000))

  return {
    allowed: current <= limit,
    remaining,
    retryAfterSec,
  }
}
