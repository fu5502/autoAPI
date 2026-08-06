import { gunzipSync } from 'node:zlib'
import type { FastifyInstance } from 'fastify'

export function registerCompressedJsonParser(app: FastifyInstance): void {
  app.addContentTypeParser('application/json', { parseAs: 'buffer' }, (request, body, done) => {
    try {
      const encoding = String(request.headers['content-encoding'] ?? '').toLowerCase()
      const raw = Buffer.isBuffer(body) ? body : Buffer.from(String(body))
      const decoded = encoding === 'gzip' || encoding === 'x-gzip' ? gunzipSync(raw) : raw
      if (encoding && !['identity', 'gzip', 'x-gzip'].includes(encoding)) {
        throw new Error(`Unsupported content encoding: ${encoding}`)
      }
      done(null, JSON.parse(decoded.toString('utf8')))
    } catch (error) {
      done(error as Error)
    }
  })
}
