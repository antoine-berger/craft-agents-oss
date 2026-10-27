import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseRepositoryStart } from '@craft-agent/shared/protocol'
import { resolveRepositoryStart } from './start-context'
import { taskBranchSlug } from './owned-worktree'
let root: string
const git = (...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore','pipe','pipe'], env: { ...process.env, GIT_AUTHOR_NAME:'Fixture', GIT_AUTHOR_EMAIL:'fixture@example.invalid', GIT_COMMITTER_NAME:'Fixture', GIT_COMMITTER_EMAIL:'fixture@example.invalid' } }).trim()
beforeEach(() => { root=mkdtempSync(join(tmpdir(),'repository-start-'));git('init','-b','main');writeFileSync(join(root,'README.md'),'fixture');git('add','.');git('commit','-m','Initial');git('remote','add','origin','https://github.com/team/app.git') })
afterEach(()=>rmSync(root,{recursive:true,force:true}))
describe('repository starting context',()=>{
 it('parses canonical branch/PR/GitHub/Linear references and rejects forged hosts',()=>{
  expect(parseRepositoryStart('branch:feature/fix')).toEqual({kind:'branch',branch:'feature/fix'})
  expect(parseRepositoryStart('pr:23')).toEqual({kind:'pull-request',number:23})
  expect(parseRepositoryStart('https://github.com/team/app/issues/8')).toEqual({kind:'github-issue',repository:'team/app',number:8})
  expect(parseRepositoryStart('https://linear.app/team/issue/ENG-12/fix-login')).toMatchObject({kind:'linear-issue',identifier:'ENG-12'})
  for(const ref of ['https://github.com.evil.test/team/app/pull/1','https://user:token@github.com/team/app/pull/1','https://github.com/team/app/pull/1?token=x','http://github.com/team/app/pull/1','https://linear.app.evil/team/issue/ENG-1','../escape','-bad']) expect(()=>parseRepositoryStart(ref)).toThrow()
  expect(taskBranchSlug('Corriger l’affichage des PR')).toBe('corriger-l-affichage-des-pr')
  expect(taskBranchSlug('Connect API sk-secretcredential12345678901234567890 for user@example.com')).toBe('connect-api-reference-for')
 })
 it('loads issue title/context from the authenticated selected repository only',async()=>{
  const calls:string[][]=[]
  const resolved=await resolveRepositoryStart(root,{kind:'github-issue',number:8},{readGitHub:async args=>{calls.push(args);return {number:8,title:'Fix login',body:'Expected behavior',url:'https://github.com/team/app/issues/8'}}})
  expect(resolved.taskTitle).toBe('issue 8 Fix login')
  expect(resolved.context).toContain('Expected behavior')
  expect(calls[0]).toContain('team/app')
  await expect(resolveRepositoryStart(root,{kind:'github-issue',number:8,repository:'other/app'})).rejects.toThrow('different repository')
  await expect(resolveRepositoryStart(root,{kind:'github-issue',number:8},{readGitHub:async()=>({title:'Bad',url:'https://github.com/other/app/issues/8'})})).rejects.toThrow('different issue')
 })
 it('continues the PR head branch and returns its base and URL without renaming it',async()=>{
  git('branch','feature/pr')
  const result=await resolveRepositoryStart(root,{kind:'pull-request',number:4},{readGitHub:async()=>({title:'Fix bug',body:'PR description',url:'https://github.com/team/app/pull/4',headRefName:'feature/pr',baseRefName:'main',isCrossRepository:false})})
  expect(result).toMatchObject({existingBranch:'feature/pr',baseBranch:'main',pullRequestUrl:'https://github.com/team/app/pull/4',taskTitle:'Fix bug'})
  expect(git('symbolic-ref','--short','HEAD')).toBe('main')
 })
 it('continues a fork PR through a tracking branch without switching the source checkout',async()=>{
  const bare=join(root,'fork.git')
  git('clone','--bare','.',bare)
  git('--git-dir',bare,'branch','feature/fork','main')
  git('config',`url.file://${bare}.insteadOf`,'https://github.com/contributor/app.git')
  const result=await resolveRepositoryStart(root,{kind:'pull-request',number:7},{readGitHub:async()=>({title:'Fork fix',body:'Description',url:'https://github.com/team/app/pull/7',headRefName:'feature/fork',baseRefName:'main',isCrossRepository:true,headRepositoryOwner:{login:'contributor'},headRepository:{name:'app'}})})
  expect(result.existingBranch).toBe('feature/fork')
  expect(git('config','--get','branch.feature/fork.remote')).toBe('craft-pr-7-contributor')
  expect(git('config','--get','remote.craft-pr-7-contributor.url')).toBe('https://github.com/contributor/app.git')
  expect(git('symbolic-ref','--short','HEAD')).toBe('main')
 })
 it('resolves Linear through the configured source callback and refuses missing/mismatched access',async()=>{
  const start={kind:'linear-issue' as const,identifier:'ENG-12',url:'https://linear.app/team/issue/ENG-12/fix-login'}
  await expect(resolveRepositoryStart(root,start)).rejects.toThrow('Connect a Linear source')
  expect(await resolveRepositoryStart(root,start,{resolveLinearIssue:async id=>({title:'Fix login',description:'Details',url:`https://linear.app/team/issue/${id}/fix-login`})})).toMatchObject({taskTitle:'ENG-12 Fix login'})
  await expect(resolveRepositoryStart(root,start,{resolveLinearIssue:async()=>({title:'Wrong',url:'https://linear.app/team/issue/ENG-99/wrong'})})).rejects.toThrow('different issue')
 })
})
