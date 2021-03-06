const _ = require('lodash')
const assert = require('assert')

const { db, pgp } = require('db')
const error = require('error')

const { format, csv } = pgp.as

function mapper (mapping) {
  const mappingEntries = _(mapping)
  .omitBy(_.isArray)
  .entries()
  .map(([name, fx]) => [name, fx, _.isFunction(fx)])
  .value()

  const extras = _.pickBy(mapping, _.isArray)

  function mapItem (item) {
    const res = {}

    // optimized for performance (this code is potentially run on large datasets)
    for (const [name, fx, isFun] of mappingEntries) {
      const value = isFun ? fx(item) : item[fx]

      // ignore undefined values
      if (value !== undefined) {
        res[name] = value
      }
    }

    return res
  }

  function map (data) {
    if (!data) return null
    return _.isArray(data) ? data.map(mapItem) : mapItem(data)
  }

  map.loading = (includes, opts) => async data => {
    if (!data) return null

    const raw = _.castArray(data)
    const mapped = raw.map(mapItem)
    const getColumn = _.memoize(col => raw.map(r => r[col]))

    await Promise.all(_.map(includes, (inc, name) => {
      if (!inc) return null

      const [keyCol, resolver, _inc] = _.isArray(inc) ? inc : extras[name]

      return resolver(getColumn(keyCol), opts, _.isArray(inc) ? _inc : inc)
      .then(values => values.forEach((val, i) => {
        mapped[i][name] = val
      }))
    }))

    return _.isArray(data) ? mapped : mapped[0]
  }

  map.mapping = { ...mapping }
  return map
}

function createResolver (getter, keyColumn, { map = _.identity, multi = false, chunkSize = 250, condition = '' } = {}) {
  // getter as table name
  if (_.isString(getter)) {
    const leftPart = format('SELECT * FROM $1~ WHERE $2~ IN', [getter, keyColumn])
    const rightPart = condition ? `AND ${condition}` : ''
    getter = (keys, { t = db }) => t.any(`${leftPart} (${csv(keys)}) ${rightPart}`).catch(error.db)
  } else {
    assert(!condition, '"condition" option valid only with createResolver(tableName, ...)')
  }

  return async (keys, opts, { _options, ...includes } = {}) => {
    if (keys.length === 0) return []

    // Providing a way to define resource specific options (overriding common ones.)
    // This is subject of change, so don't relay on it too much, for now.
    opts = { ...opts, ..._options }

    // avoiding too large queries by chunking keys and making multiple smaller queries instead
    const rows = await autoChunk(chunkSize, keys, chunk => getter(chunk, opts))

    const mapped = _.isEmpty(includes)
      ? map(rows)
      : await map.loading(includes, opts)(rows)

    if (keyColumn === null) {
      return mapped
    }

    const keyed = createMap(multi)
    mapped.forEach((val, i) => {
      keyed.set(rows[i][keyColumn], val)
    })
    return keys.map(keyed.get)
  }
}

function autoChunk (chunkSize, data, func) {
  if (data.length <= chunkSize) {
    return func(data)
  }

  const chunks = _.chunk(_.uniq(data), chunkSize)
  return Promise.all(chunks.map(func)).then(_.flatten)
}

function createMap (multi = false) {
  const map = new Map()

  const get = multi
    ? key => map.get(key) || map.set(key, []).get(key)
    : key => map.get(key)

  const set = multi
    ? (key, val) => get(key).push(val)
    : (key, val) => map.set(key, val)

  return { get, set }
}

module.exports = {
  mapper,
  createResolver,
}
