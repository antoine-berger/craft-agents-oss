import {describe,expect,it} from 'bun:test'
import {handleWorkingDirectoryChanged} from '../session'
import type {SessionState} from '../../types'
const worktree = {
 repositoryPath:'/repos/app', needsRepository:false,
 owned:{version:1 as const,ownerId:'workspace/session',token:'test-owner-token',repoPath:'/repos/app',gitDir:'/repos/app/.git',path:'/repos/app-session',branch:'session/topic',base:'main',baseCommit:'abc',status:'ready' as const},
}
const state=():SessionState=>({session:{id:'session',workspaceId:'workspace',projectId:'project',messages:[{id:'first',role:'user',content:'hello',timestamp:1}],workingDirectory:'/repos',worktree:{repositoryPath:'/repos',needsRepository:true}} as SessionState['session'],streaming:null})
describe('first-message worktree state',()=>{
 it('updates the prepared repository and branch with the working directory, preserving the conversation project',()=>{
  const result=handleWorkingDirectoryChanged(state(),{type:'working_directory_changed',sessionId:'session',workingDirectory:worktree.owned.path,worktree})
  expect(result.state.session.worktree).toEqual(worktree)
  expect(result.state.session.workingDirectory).toBe(worktree.owned.path)
  expect(result.state.session.projectId).toBe('project')
  expect(result.state.session.messages).toHaveLength(1)
 })
 it('retains worktree metadata for older events that only contain a directory',()=>{
  const before=state()
  expect(handleWorkingDirectoryChanged(before,{type:'working_directory_changed',sessionId:'session',workingDirectory:'/new'}).state.session.worktree).toEqual(before.session.worktree)
 })
 it('clears metadata when the server explicitly removes a pending worktree policy',()=>{
  expect(handleWorkingDirectoryChanged(state(),{type:'working_directory_changed',sessionId:'session',workingDirectory:'/new',worktree:null}).state.session.worktree).toBeUndefined()
 })
})
