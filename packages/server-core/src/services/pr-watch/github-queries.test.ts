import { expect, test } from 'bun:test'
import { DETAILS_QUERY, PR_BY_NUMBER_QUERY, SUMMARY_QUERY } from './github-queries'

// https://docs.github.com/en/graphql/reference/checks#checkrun
// CheckRun supports databaseId; fullDatabaseId belongs to other GraphQL types.
test('all check-reading queries use the supported CheckRun identifier', () => {
  for (const query of [SUMMARY_QUERY, PR_BY_NUMBER_QUERY, DETAILS_QUERY]) {
    expect(query).toContain('databaseId name status conclusion detailsUrl')
    expect(query).not.toContain('fullDatabaseId')
  }
})
