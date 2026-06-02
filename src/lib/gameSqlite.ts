import initSqlJs from 'sql.js'
import sqliteWasmUrl from 'sql.js/dist/sql-wasm.wasm?url'
import type { Database } from 'sql.js'

export interface ScoreEntry {
  id: number
  name: string
  score: number
  date: string
  mode: string
}

type ScoreRow = [number, string, number, string, string]

const INDEXED_DB_NAME = 'snake-game-sqlite'
const INDEXED_DB_STORE = 'database'
const SQLITE_DATABASE_KEY = 'scores.sqlite'

let database: Database | null = null

const openDatabaseStore = (): Promise<IDBObjectStore> => {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(INDEXED_DB_NAME, 1)
    request.onupgradeneeded = () => {
      request.result.createObjectStore(INDEXED_DB_STORE)
    }
    request.onerror = () => reject(request.error)
    request.onsuccess = () => {
      const transaction = request.result.transaction(INDEXED_DB_STORE, 'readwrite')
      resolve(transaction.objectStore(INDEXED_DB_STORE))
    }
  })
}

const loadDatabaseBytes = async (): Promise<Uint8Array | null> => {
  const store = await openDatabaseStore()
  return new Promise((resolve, reject) => {
    const request = store.get(SQLITE_DATABASE_KEY)
    request.onerror = () => reject(request.error)
    request.onsuccess = () => {
      resolve(request.result instanceof Uint8Array ? request.result : null)
    }
  })
}

const saveDatabaseBytes = async (bytes: Uint8Array): Promise<void> => {
  const store = await openDatabaseStore()
  return new Promise((resolve, reject) => {
    const request = store.put(bytes, SQLITE_DATABASE_KEY)
    request.onerror = () => reject(request.error)
    request.onsuccess = () => resolve()
  })
}

const requireDatabase = () => {
  if (!database) throw new Error('SQLite database has not been initialized.')
  return database
}

const createScoreTable = (db: Database) => {
  db.run(`
    CREATE TABLE IF NOT EXISTS scores (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      score INTEGER NOT NULL,
      date TEXT NOT NULL,
      mode TEXT NOT NULL
    );
  `)
}

const mapRowToScore = (row: ScoreRow): ScoreEntry => ({
  id: row[0],
  name: row[1],
  score: row[2],
  date: row[3],
  mode: row[4],
})

export const initializeScoreDatabase = async (): Promise<void> => {
  const SQL = await initSqlJs({
    locateFile: () => sqliteWasmUrl,
  })
  const savedDatabase = await loadDatabaseBytes()
  database = savedDatabase ? new SQL.Database(savedDatabase) : new SQL.Database()
  createScoreTable(database)
  if (!savedDatabase) {
    await persistScoreDatabase()
  }
}

export const listScoresFromSqlite = (): ScoreEntry[] => {
  const db = requireDatabase()
  const result = db.exec(`
    SELECT id, name, score, date, mode
    FROM scores
    ORDER BY score DESC;
  `)
  const rows = (result[0]?.values ?? []) as ScoreRow[]
  return rows.map(mapRowToScore)
}

export const persistScoreDatabase = async (): Promise<void> => {
  const db = requireDatabase()
  await saveDatabaseBytes(db.export())
}

export const insertScoreIntoSqlite = async (name: string, score: number, date: string, mode: string): Promise<void> => {
  const db = requireDatabase()
  const insert = db.prepare(`
    INSERT INTO scores (id, name, score, date, mode)
    VALUES (?, ?, ?, ?, ?);
  `)
  insert.run([Date.now(), name, score, date, mode])
  insert.free()
  await persistScoreDatabase()
}
