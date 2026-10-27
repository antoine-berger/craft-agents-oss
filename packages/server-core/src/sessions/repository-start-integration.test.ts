import { afterEach, beforeAll, beforeEach, expect, test, mock } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setupI18n } from '@craft-agent/shared/i18n'
import { getSessionFilePath, readSessionHeader, sessionPersistenceQueue } from '@craft-agent/shared/sessions'
import { createManagedSession, SessionManager } from './SessionManager'
let root: string, repo: string, manager: SessionManager, state: ReturnType<typeof createManagedSession>
const path = process.env.PATH
const env = { ...process.env, GIT_AUTHOR_NAME:'Fixture',GIT_AUTHOR_EMAIL:'fixture@example.invalid',GIT_COMMITTER_NAME:'Fixture',GIT_COMMITTER_EMAIL:'fixture@example.invalid' }
const git=(...args:string[])=>execFileSync('git',args,{cwd:repo,env,encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim()
beforeAll(()=>setupI18n())
beforeEach(()=>{
 root=realpathSync(mkdtempSync(join(tmpdir(),'craft-start-manager-')));repo=join(root,'repo');mkdirSync(repo);mkdirSync(join(root,'bin'))
 git('init','-b','main');writeFileSync(join(repo,'code.txt'),'initial');git('add','.');git('commit','-m','initial');git('remote','add','origin','https://github.com/fixture/app.git')
 writeFileSync(join(root,'bin','gh'),'#!/bin/sh\ncase "$1" in\napi) echo fixture-developer;;\nissue) echo \'{"number":8,"title":"Fix login","body":"Fixture issue details","url":"https://github.com/fixture/app/issues/8"}\';;\npr) echo \'{"number":4,"title":"Fix bug","body":"Fixture PR details","url":"https://github.com/fixture/app/pull/4","headRefName":"feature/fix","baseRefName":"main","isCrossRepository":false}\';;\nesac\n',{mode:0o755})
 process.env.PATH=`${join(root,'bin')}:${path}`
 manager=new SessionManager();const ws={id:randomUUID(),name:'fixture',slug:'fixture',rootPath:join(root,'workspace'),createdAt:1};mkdirSync(ws.rootPath)
 state=createManagedSession({id:randomUUID(),name:'Fixture',worktree:{repositoryPath:'',pendingRepository:{kind:'local',gitDir:join(repo,'.git'),name:'app',start:{kind:'github-issue',number:8}}}},ws,{messagesLoaded:true})
 state.messages.push({id:'user-one',role:'user',content:'Fix the login flow',timestamp:Date.now()})
 ;(manager as any).sessions.set(state.id,state);(manager as any).sendEvent=mock(()=>{})
})
afterEach(async()=>{process.env.PATH=path;sessionPersistenceQueue.cancel(state.id);manager.cleanup();await new Promise(r=>setTimeout(r,30));rmSync(root,{recursive:true,force:true})})
test('issue context and task branch survive persistence without an SDK; selected PR reuses its branch and binds metadata',async()=>{
 await (manager as any).prepareSessionWorktree(state)
 expect(state.worktree?.owned?.branch).toBe('fixture-developer/issue-8-fix-login')
 expect(state.worktree?.resolvedStart?.context).toContain('Fixture issue details')
 expect(state.worktree?.pendingRepository).toBeUndefined()
 expect(readSessionHeader(getSessionFilePath(state.workspace.rootPath,state.id))?.worktree?.resolvedStart?.context).toContain('Fixture issue details')
 const first=state.worktree?.owned?.path;await (manager as any).prepareSessionWorktree(state);expect(state.worktree?.owned?.path).toBe(first)
 git('branch','feature/fix')
 const pr=createManagedSession({id:randomUUID(),worktree:{repositoryPath:'',pendingRepository:{kind:'local',gitDir:join(repo,'.git'),name:'app',start:{kind:'pull-request',number:4}}}},state.workspace,{messagesLoaded:true})
 ;(manager as any).sessions.set(pr.id,pr)
 await (manager as any).prepareSessionWorktree(pr)
 expect(pr.worktree?.owned?.branch).toBe('feature/fix');expect(pr.boundPrs?.[0]).toMatchObject({host:'github.com',owner:'fixture',repo:'app',number:4})
 sessionPersistenceQueue.cancel(pr.id)
},30000)
test('failed resolution retains editable pending reference and never creates a checkout',async()=>{
 state.worktree!.pendingRepository!.start={kind:'github-issue',number:8,repository:'wrong/app'}
 await expect((manager as any).prepareSessionWorktree(state)).rejects.toThrow('different repository')
 expect(state.worktree?.pendingRepository?.start).toBeDefined();expect(state.worktree?.owned).toBeUndefined();expect(state.sdkSessionId).toBeUndefined()
 state.worktree!.pendingRepository!.start={kind:'github-issue',number:8}
 await (manager as any).prepareSessionWorktree(state)
 expect(state.worktree?.owned?.status).toBe('ready')
},30000)
