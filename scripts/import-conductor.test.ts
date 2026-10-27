import { expect, test } from 'bun:test'
import { migrationArguments } from './import-conductor'
test('migration is opt-in and bulk versus selected copy is unambiguous', () => {
 expect(migrationArguments([]).all).toBeUndefined()
 expect(migrationArguments(['--dry-run'])['dry-run']).toBe(true)
 expect(migrationArguments(['--session','first','--session','second']).session).toEqual(['first','second'])
 expect(()=>migrationArguments(['--all','--session','first'])).toThrow('not both')
 expect(()=>migrationArguments(['--unknown'])).toThrow()
})
