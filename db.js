import { Low } from 'lowdb'
import { JSONFile } from 'lowdb/node'

const adapter = new JSONFile('./db.json')
export const db = new Low(adapter, { users: [], messages: [] })

export async function initDb() {
  await db.read()
  db.data ||= { users: [], messages: [] }
  await db.write()
}
