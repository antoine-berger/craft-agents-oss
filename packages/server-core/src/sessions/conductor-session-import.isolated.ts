import { afterAll, expect, test } from 'bun:test'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const root=mkdtempSync(join(tmpdir(),'craft-conductor-manager-'))
const previous=process.env.CRAFT_CONFIG_DIR
process.env.CRAFT_CONFIG_DIR=join(root,'config');mkdirSync(process.env.CRAFT_CONFIG_DIR)
const workspace={id:'import-fixture-workspace',name:'Fixture',slug:'fixture',rootPath:join(root,'workspace'),createdAt:1};mkdirSync(workspace.rootPath)
writeFileSync(join(process.env.CRAFT_CONFIG_DIR,'config.json'),JSON.stringify({workspaces:[workspace],activeWorkspaceId:workspace.id}))
const {SessionManager}=await import('./SessionManager')
const {createProject}=await import('@craft-agent/shared/projects')
const {loadSession,sessionPersistenceQueue}=await import('@craft-agent/shared/sessions')
const manager=new SessionManager();(manager as any).sendEvent=()=>{}
afterAll(()=>{manager.cleanup();if(previous===undefined)delete process.env.CRAFT_CONFIG_DIR;else process.env.CRAFT_CONFIG_DIR=previous;rmSync(root,{recursive:true,force:true})})
test('Conductor copy persists project/archive/repository/provenance, resumes fresh and never publishes an incomplete bundle',async()=>{
 const project=createProject(workspace.rootPath,{name:'Imported fixture'})
 const origin={provider:'conductor' as const,sourceId:'source',sessionId:'original',fingerprint:'fingerprint',importedAt:Date.now()}
 const header={id:'conductor-fixture',workspaceRootPath:'',name:'Imported history',createdAt:1,lastUsedAt:2,messageCount:1,tokenUsage:{inputTokens:0,outputTokens:0,totalTokens:0,contextTokens:0,costUsd:0},isArchived:true,projectId:project.id,importedFrom:origin,worktree:{repositoryPath:'',pendingRepository:{kind:'github' as const,nameWithOwner:'fixture/app'},resolvedStart:{taskTitle:'Imported history'}},transferredSessionSummary:'Retained historical context',transferredSessionSummaryApplied:false}
 const bundle={version:1 as const,session:{header,messages:[{id:'original-message',type:'user' as const,content:'Historical message',timestamp:1}]},files:[{relativePath:'attachments/fixture.txt',contentBase64:Buffer.from('copied attachment').toString('base64'),size:17}]}
 const result=await manager.importSession(workspace.id,bundle,'move')
 const stored=loadSession(workspace.rootPath,result.sessionId)!
 expect(stored.projectId).toBe(project.id);expect(stored.isArchived).toBe(true);expect(stored.importedFrom).toEqual(origin)
 expect(stored.worktree?.pendingRepository).toEqual({kind:'github',nameWithOwner:'fixture/app'});expect(stored.worktree?.owned).toBeUndefined();expect(stored.sdkSessionId).toBeUndefined()
 expect(stored.transferredSessionSummaryApplied).toBe(false);expect(stored.messages[0]?.content).toBe('Historical message')
 expect(readFileSync(join(workspace.rootPath,'sessions',result.sessionId,'attachments/fixture.txt'),'utf8')).toBe('copied attachment')
 await expect(manager.importSession(workspace.id,bundle,'move')).rejects.toThrow('already exists')
 const broken={...bundle,session:{...bundle.session,header:{...header,id:'conductor-broken'}},files:[{relativePath:'../../escape',contentBase64:'',size:0}]}
 await expect(manager.importSession(workspace.id,broken,'move')).rejects.toThrow()
 expect(existsSync(join(workspace.rootPath,'sessions','conductor-broken'))).toBe(false)
 expect(readdirSync(join(workspace.rootPath,'sessions')).some(name=>name.startsWith('import-staging-'))).toBe(false)
 sessionPersistenceQueue.cancel(result.sessionId)
},30000)
