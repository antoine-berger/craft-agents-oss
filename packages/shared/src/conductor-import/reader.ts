/** Read-only Conductor SQLite reader for the standalone migration script. */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { ConductorListOptions, ConductorExportOptions, ConductorChatList, ConductorImportBundle } from '../protocol/conductor-import'
import { convertConductorExport, type ConductorRawExport } from './convert'

const run = promisify(execFile)
export const DEFAULT_CONDUCTOR_DATABASE = join(homedir(), 'Library/Application Support/com.conductor.app/conductor.db')

// All database writes are prohibited at both the SQLite connection and pragma levels.
// Rows are read in batches, and size/count preflights reject oversized individual chats.
export const CONDUCTOR_READER_PYTHON = String.raw`
import sqlite3, json, sys, os, pathlib, base64, urllib.parse
request=json.loads(sys.argv[1])
p=os.path.abspath(os.path.expanduser(request['databasePath']))
if not os.path.isfile(p): raise ValueError('Conductor database not found. Choose a local database copy.')
c=sqlite3.connect('file:'+urllib.parse.quote(p)+'?mode=ro',uri=True,timeout=10)
c.row_factory=sqlite3.Row
c.execute('PRAGMA query_only=ON')
c.execute('BEGIN')
def columns(table): return {x[1] for x in c.execute('PRAGMA table_info('+table+')')}
def col(table, alias, name, fallback='NULL'): return alias+'.'+name if name in columns(table) else fallback
# Only a fixed set of known identifiers is interpolated. User input is always bound.
select='''SELECT s.id,s.title,s.created_at,s.updated_at,s.workspace_id,s.is_hidden,
'''+col('sessions','s','remote_archived_at')+''' remote_archived_at,
'''+col('workspaces','w','repository_id')+''' repository_id,
'''+col('workspaces','w','workspace_name')+''' workspace_name,
'''+col('workspaces','w','state')+''' workspace_state,
'''+col('workspaces','w','hosting_server_url')+''' hosting_server_url,
r.name repository_name,r.remote_url repository_remote FROM sessions s
LEFT JOIN workspaces w ON w.rowid=(SELECT w2.rowid FROM workspaces w2 WHERE w2.id=s.workspace_id OR w2.local_id=s.workspace_id LIMIT 1)
LEFT JOIN repos r ON r.id=w.repository_id '''
def github(remote):
 if not remote: return None
 import re
 m=re.fullmatch(r'(?:https://github\.com/|git@github\.com:|ssh://git@github\.com/)([\w.-]+/[\w.-]+?)(?:\.git)?/?',remote)
 return m.group(1) if m else None
def preview(row):
 r=dict(row)
 return dict(id=r['id'],title=r['title'] or 'Untitled Conductor chat',workspaceId=r['workspace_id'],repositoryId=r['repository_id'],repositoryName=r['repository_name'],repository=github(r['repository_remote']),workspaceName=r['workspace_name'],createdAt=r['created_at'],updatedAt=r['updated_at'] or r['created_at'],archived=bool(r['remote_archived_at'] or r['workspace_state'] in ('archived','deleted')),hidden=bool(r['is_hidden']),partial=bool(r['hosting_server_url']))
warning='Cloud chats are imported from the local cache. It may be incomplete; originals remain in Conductor.'
if request['action']=='list':
 limit=min(100,max(1,int(request.get('limit',50)))); offset=max(0,int(request.get('cursor',0))); search=request.get('search','')[:200]
 where=' WHERE (?=\'\' OR instr(lower(coalesce(s.title,\'\')||\' \'||coalesce(r.name,\'\')),lower(?))>0)'
 total=c.execute('SELECT count(*) FROM ('+select+where+')',(search,search)).fetchone()[0]
 rows=c.execute(select+where+' ORDER BY s.updated_at DESC,s.id LIMIT ? OFFSET ?',(search,search,limit,offset))
 out=dict(chats=[preview(r) for r in rows],total=total,warnings=[warning])
 if offset+limit<total: out['nextCursor']=offset+limit
else:
 sid=request['sessionId']; row=c.execute(select+' WHERE s.id=?',(sid,)).fetchone()
 if not row: raise ValueError('Conductor chat not found')
 budget=32*1024*1024
 def bounded(table,fields,order):
  global budget
  present=columns(table); selected=[f for f in fields if f in present]
  text=[f for f in selected if f not in ('session_index',)]
  amount=c.execute('SELECT count(*),coalesce(sum('+ '+'.join('coalesce(length(cast('+f+' as blob)),0)' for f in text)+'),0) FROM '+table+' WHERE session_id=?',(sid,)).fetchone()
  if amount[0]>50000 or amount[1]>budget: raise ValueError('This chat exceeds the safe import size. Export a smaller chat from Conductor.')
  budget-=amount[1]; result=[]
  cur=c.execute('SELECT '+','.join(selected)+' FROM '+table+' WHERE session_id=? ORDER BY '+order,(sid,))
  while True:
   batch=cur.fetchmany(200)
   if not batch: break
   result.extend(dict(r) for r in batch)
  return result
 messages=bounded('session_messages',['id','role','content','created_at','turn_id','full_message','cancelled_at'],'created_at,rowid')
 events=bounded('session_events',['event_id','event_type','session_index','content','received_at','reverted_at'],'session_index') if columns('session_events') else []
 attachments=[]; warnings=[]
 store=pathlib.Path(os.path.dirname(p))
 roots=[(store/name).resolve() for name in ('attachments','assets','session_assets')]+[pathlib.Path(os.path.expanduser('~/.conductor/attachments')).resolve(),pathlib.Path(os.path.expanduser('~/conductor/attachments')).resolve()]
 if columns('attachments'):
  for a in c.execute('SELECT id,original_name,path,session_message_id,type FROM attachments WHERE session_id=? ORDER BY id LIMIT 1001',(sid,)):
   if len(attachments)>=1000: raise ValueError('Too many attachments in one chat')
   item=dict(a); path=pathlib.Path(item.pop('path') or '')
   # Refuse symlinks and paths outside the Conductor asset stores. Never turn DB data into arbitrary file reads.
   absolute=path if path.is_absolute() else pathlib.Path(os.path.dirname(p))/path
   safe=not absolute.is_symlink() and any(absolute.parent.resolve().is_relative_to(root) for root in roots)
   if safe and absolute.is_file():
    canonical=absolute.parent.resolve()/absolute.name
    descriptor=os.open(canonical,os.O_RDONLY|getattr(os,'O_NOFOLLOW',0))
    with os.fdopen(descriptor,'rb') as handle:
     size=os.fstat(handle.fileno()).st_size
     data=handle.read(min(16*1024*1024,budget)+1) if size<=16*1024*1024 and size<=budget else None
    if data is not None and len(data)==size:
     budget-=len(data); item['contentBase64']=base64.b64encode(data).decode(); item['size']=len(data)
    else: item['unavailable']='Attachment exceeds the safe import size'
   else: item['unavailable']='Attachment missing or outside the Conductor asset stores'
   attachments.append(item)
 out=dict(preview=preview(row),messages=messages,events=events,attachments=attachments,warnings=warnings)
 if out['preview']['partial']: out['warnings'].append(warning)
print(json.dumps(out,separators=(',',':')))
c.rollback();c.close()
`

async function readLocal(request: Record<string, unknown>): Promise<unknown> {
  try {
    const { stdout } = await run('python3', ['-c', CONDUCTOR_READER_PYTHON, JSON.stringify(request)], {
      maxBuffer: 100 * 1024 * 1024, timeout: 120_000, encoding: 'utf8',
    })
    return JSON.parse(stdout)
  } catch (error) {
    // The subprocess may include source contents in an unexpected parser error. Never forward stderr.
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT') throw new Error('Python 3 is required to read the local Conductor database.')
    throw new Error('Unable to read this Conductor selection. Verify the database exists and the chat fits the import limits (32 MB, 50,000 records per stream).')
  }
}
export async function listLocalConductorChats(options: ConductorListOptions = {}): Promise<ConductorChatList> {
  const result = await readLocal({ ...options, databasePath: options.databasePath || DEFAULT_CONDUCTOR_DATABASE, action: 'list' }) as ConductorChatList
  result.chats = result.chats.map(chat => ({ ...chat, createdAt: toTimestamp(chat.createdAt), updatedAt: toTimestamp(chat.updatedAt) }))
  return result
}
function toTimestamp(value: unknown): number { return typeof value === 'number' ? value : Date.parse(String(value)) || 0 }
export async function exportLocalConductorChat(sessionId: string, options: ConductorExportOptions = {}): Promise<ConductorImportBundle> {
  if (!sessionId || sessionId.length > 200) throw new Error('Invalid Conductor chat ID')
  const raw = await readLocal({ ...options, databasePath: options.databasePath || DEFAULT_CONDUCTOR_DATABASE, action: 'export', sessionId }) as ConductorRawExport
  raw.preview.createdAt = toTimestamp(raw.preview.createdAt)
  raw.preview.updatedAt = toTimestamp(raw.preview.updatedAt)
  return convertConductorExport(raw)
}
