'use strict'

const Dat = require('dat-node')
const fs = require('fs')
const http = require('http')
const hyperdriveHttp = require('hyperdrive-http')
const path = require('path')
const LRU = require('lru-cache')
const resolveDat = require('dat-link-resolve')

function log () {
  let msg = arguments[0]
  arguments[0] = '[dat-gateway] ' + msg
  if (process.env.DEBUG || process.env.LOG) {
    console.log.apply(console, arguments)
  }
}

module.exports =
class DatGateway {
  constructor ({ dir, max, maxAge }) {
    this.dir = dir
    this.datOptions = { temp: true }
    log('Starting gateway at %s with options %j', this.dir, { max, maxAge })
    this.cache = new LRU({
      dispose: function (key, dat) {
        const start = Date.now()
        log('Disposing of archive %s', key)
        dat.close(() => {
          const end = Date.now()
          log('Disposed of archive %s in %i ms', key, end - start)
        })
      },
      max,
      maxAge
    })
  }

  getHandler () {
    return this.getIndexHtml().then((welcome) => {
      return (req, res) => {
        log('%s %s', req.method, req.url)
        const start = Date.now()
        // TODO redirect /:key to /:key/
        let urlParts = req.url.split('/')
        let address = urlParts[1]
        let path = urlParts.slice(2).join('/')
        if (!address && !path) {
          res.writeHead(200)
          res.end(welcome)
          return Promise.resolve()
        }
        return this.resolveDat(address).then((key) => {
          return this.getDat(key)
        }).then((dat) => {
          // handle it!!
          const end = Date.now()
          log('%s %s | OK [%i ms]', req.method, req.url, end - start)
          req.url = `/${path}`
          dat.onrequest(req, res)
        }).catch((e) => {
          const end = Date.now()
          log('%s %s | ERROR %s [%i ms]', req.method, req.url, e.message, end - start)
          if (e.message.indexOf('not found') > -1) {
            res.writeHead(404)
            res.end('Not found')
          } else {
            res.writeHead(500)
            res.end(JSON.stringify(e))
          }
        })
      }
    })
  }

  listen (port) {
    return this.getHandler().then((handler) => {
      this.server = http.createServer(handler)
      return new Promise((resolve, reject) => {
        this.server.listen(port, (err) => {
          if (err) return reject(err)
          else return resolve()
        })
      })
    })
  }

  close () {
    return new Promise((resolve) => {
      if (this.server) this.server.close(resolve)
      else resolve()
    }).then(() => {
      this.cache.reset()
    })
  }

  getIndexHtml () {
    return new Promise((resolve, reject) => {
      let filePath = path.join(__dirname, 'index.html')
      fs.readFile(filePath, 'utf-8', (err, html) => {
        if (err) return reject(err)
        else return resolve(html)
      })
    })
  }

  getDat (key) {
    // check local cache
    if (this.cache.has(key)) return Promise.resolve(this.cache.get(key))
    // retrieve from the web
    return new Promise((resolve, reject) => {
      const opts = Object.assign({}, this.datOptions, { key })
      Dat(this.dir, opts, (err, dat) => {
        if (err) {
          return reject(err)
        } else {
          dat.onrequest = hyperdriveHttp(dat.archive, { live: false, exposeHeaders: true })
          dat.joinNetwork((err) => {
            if (err) {
              return reject(err)
            } else if (dat.network.connections.length === 0) {
              return reject(new Error('not found'))
            } else {
              this.cache.set(key, dat)
              return resolve(dat)
            }
          })
        }
      })
    })
  }

  resolveDat (address) {
    return new Promise((resolve, reject) => {
      resolveDat(address, (err, key) => {
        if (err) {
          return reject(err)
        } else {
          return resolve(key)
        }
      })
    })
  }
}
