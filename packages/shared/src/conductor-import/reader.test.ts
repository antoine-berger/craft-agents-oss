import { afterEach, expect, test } from 'bun:test'
import { mkdtemp, mkdir, rm, writeFile, symlink, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { listLocalConductorChats, exportLocalConductorChat } from './reader'
const folders: string[] = []
afterEach(async () => { await Promise.all(folders.splice(0).map(folder => rm(folder, { recursive: true, force: true }))) })
async function database(count = 3) {
  const dir = await mkdtemp(join(tmpdir(), 'craft-conductor-test-')); folders.push(dir)
  const path = join(dir, 'conductor.db')
  execFileSync('python3', ['-c', `import sqlite3,sys
c=sqlite3.connect(sys.argv[1]);c.executescript('''
create table repos(id text,name text,remote_url text);
create table workspaces(id text,local_id text,repository_id text,workspace_name text,state text,hosting_server_url text);
create table sessions(id text,title text,created_at text,updated_at text,workspace_id text,is_hidden integer,remote_archived_at text);
create table session_messages(id text,session_id text,role text,content text,created_at text,turn_id text,full_message text,cancelled_at text);
create table session_events(session_id text,event_id text,event_type text,session_index integer,content text,received_at text,reverted_at text);
create table attachments(id text,original_name text,path text,session_id text,session_message_id text,type text);
insert into repos values('r','app','git@github.com:team/app.git');
insert into workspaces values('w','local-w','r','Workspace','archived','https://cloud.conductor.build');
''')
c.executemany('insert into sessions values(?,?,?,?,?,?,?)', [('s'+str(i),'Chat '+str(i),'2026-10-20','2026-10-26','w',0,None) for i in range(int(sys.argv[2]))]);c.execute('insert into session_messages values(?,?,?,?,?,?,?,?)',('m','s0','user','A user message','2026-10-26',None,None,None));c.commit();c.close()`, path, String(count)])
  return { dir, path }
}
test('readonly inventory paginates metadata without reading message history', async () => {
  const { path } = await database(3000)
  const before = await readFile(path)
  const first = await listLocalConductorChats({ databasePath: path, limit: 17 })
  expect(first.total).toBe(3000); expect(first.chats).toHaveLength(17); expect(first.nextCursor).toBe(17)
  expect(first.chats[0]).toMatchObject({ repository: 'team/app', partial: true, archived: true })
  expect(first.chats[0]).not.toHaveProperty('messages')
  const next = await listLocalConductorChats({ databasePath: path, limit: 17, cursor: first.nextCursor })
  expect(new Set([...first.chats, ...next.chats].map(chat => chat.id)).size).toBe(34)
  const injection = await listLocalConductorChats({ databasePath: path, search: "' OR 1=1 --" })
  expect(injection.total).toBe(0)
  expect(await readFile(path)).toEqual(before)
})
test('copies authorized attachments; blocks outside paths and symlinks; originals unchanged', async () => {
  const { dir, path } = await database()
  const outside = await mkdtemp(join(tmpdir(), 'craft-conductor-outside-')); folders.push(outside)
  await mkdir(join(dir, 'assets')); await writeFile(join(dir, 'assets/allowed.txt'), 'hello'); await writeFile(join(outside, 'secret.txt'), 'DO NOT COPY'); await symlink(join(outside, 'secret.txt'), join(dir, 'assets/link.txt'))
  execFileSync('python3', ['-c', `import sqlite3,sys
c=sqlite3.connect(sys.argv[1]);c.executemany('insert into attachments values(?,?,?,?,?,?)',[(str(i),'file.txt',p,'s0','m','text') for i,p in enumerate(sys.argv[2:])]);c.commit()`, path, join(dir, 'assets/allowed.txt'), join(outside, 'secret.txt'), join(dir, 'assets/link.txt')])
  const result = await exportLocalConductorChat('s0', { databasePath: path })
  expect(result.bundle.files.filter(file => file.relativePath.startsWith('attachments/'))).toHaveLength(1)
  expect(result.warnings.filter(warning => warning.includes('outside'))).toHaveLength(2)
  expect(result.origin.partial).toBe(true)
  expect(result.bundle.session.messages[0]?.content).toBe('A user message')
  expect(await readFile(join(dir, 'assets/allowed.txt'), 'utf8')).toBe('hello')
})
test('rejects oversized chats before materializing rows; errors never echo content', async () => {
  const { path } = await database()
  execFileSync('python3', ['-c', `import sqlite3,sys
c=sqlite3.connect(sys.argv[1]);c.execute("update session_messages set content=? where session_id='s0'",('PRIVATE-SENTINEL'+('x'*34000000),));c.commit()`, path])
  try { await exportLocalConductorChat('s0', { databasePath: path }); throw new Error('Expected failure') }
  catch (error) { expect(String(error)).toContain('import limits'); expect(String(error)).not.toContain('PRIVATE-SENTINEL') }
})
