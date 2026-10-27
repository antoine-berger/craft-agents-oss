import { afterAll, beforeEach, describe, expect, it } from 'bun:test'
import { addSelectedRepository, clearDraftRepository, getSelectedRepositories, initialRepository, rememberRepository, seedSelectedRepositories, setDraftRepository } from '../repository-history'
import type { RepositorySelection } from '@craft-agent/shared/protocol'
const previous = globalThis.localStorage
const values = new Map<string, string>()
Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value), removeItem: (key: string) => values.delete(key) } })
beforeEach(() => values.clear())
afterAll(() => Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: previous }))
const one: RepositorySelection = { kind: 'local', gitDir: '/repo-one/.git', name: 'repo-one', nameWithOwner: 'me/repo-one' }
const two: RepositorySelection = { kind: 'github', nameWithOwner: 'me/repo-two' }
describe('chosen repositories and draft selection', () => {
 it('opens with no suggestions until a repository was actually selected', () => {
  expect(getSelectedRepositories('workspace')).toEqual([])
  expect(initialRepository('draft', 'workspace')).toBeUndefined()
 })
 it('remembers the last chosen repo across new drafts and keeps workspaces isolated', () => {
  rememberRepository(one, 'workspace'); rememberRepository(two, 'workspace')
  expect(getSelectedRepositories('workspace')).toEqual([two, one])
  expect(initialRepository('new-chat', 'workspace')).toEqual(two)
  expect(initialRepository('new-chat', 'other-workspace')).toBeUndefined()
 })
 it('keeps an existing draft choice while another draft changes the global last choice', () => {
  setDraftRepository(one, 'draft-one', 'workspace'); rememberRepository(two, 'workspace')
  expect(initialRepository('draft-one', 'workspace')).toEqual(one)
  expect(initialRepository('draft-two', 'workspace')).toEqual(two)
  clearDraftRepository('draft-one', 'workspace')
  expect(initialRepository('draft-one', 'workspace')).toEqual(two)
 })
 it('deduplicates a cloned GitHub repository while retaining its selected local checkout', () => {
  expect(addSelectedRepository([{kind:'github',nameWithOwner:'ME/REPO-ONE'}],one)).toEqual([one])
 })
 it('keeps starting context in its draft without carrying it into the next session', () => {
  const selected: RepositorySelection = {...one,start:{kind:'pull-request',number:42}}
  rememberRepository(selected,'workspace')
  setDraftRepository(selected,'current','workspace')
  expect(initialRepository('current','workspace')).toEqual(selected)
  expect(initialRepository('next','workspace')).toEqual(one)
 })
 it('does not populate suggestions from scanned or unprepared session folders', () => {
  seedSelectedRepositories([{workspaceId:'workspace',worktree:undefined}])
  expect(getSelectedRepositories('workspace')).toEqual([])
  seedSelectedRepositories([{workspaceId:'workspace',createdAt:1,worktree:{owned:{gitDir:'/repo-one/.git',repoPath:'/repo-one'}}}])
  expect(getSelectedRepositories('workspace')).toEqual([{kind:'local',gitDir:'/repo-one/.git',name:'repo-one'}])
  rememberRepository(two,'workspace')
  seedSelectedRepositories([{workspaceId:'workspace',createdAt:100,worktree:{owned:{gitDir:'/repo-one/.git',repoPath:'/repo-one'}}}])
  expect(initialRepository('new','workspace')).toEqual(two)
 })
})
