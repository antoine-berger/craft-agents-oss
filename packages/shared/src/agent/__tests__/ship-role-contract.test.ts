import { expect, test } from 'bun:test'
import { declaredShipRole, routeShipReviewer, SHIP_REVIEWER_ROLES } from '../core/ship-role-routing'

const root = '/fixture/workspace'
test('finite declared Codex roles cannot inherit the native Claude backend', () => {
  for (const role of ['factcheck', 'omissions', 'bugs', 'comments', 'light']) {
    const decision = routeShipReviewer('Agent', { prompt: `Ship-Role: ${role}\nNeutral inputs`, model: 'opus' }, root, false, true)
    expect(decision.type).toBe('block')
    expect('role' in decision && decision.role).toBe(role)
    expect('reason' in decision && decision.reason).toContain(`--role ${role}`)
  }
})
test('declared native role controls its model despite quoted unrelated reviewer descriptions', () => {
  for (const [role, model] of [['external-factcheck', 'opus'], ['performance', 'opus'], ['e2e', 'sonnet']]) {
    const decision = routeShipReviewer('Agent', { prompt: `Ship-Role: ${role}\nThe bugs reviewer mentioned code/doc claims.`, description: 'codex bugs security review', model: 'haiku' }, root, false, true)
    expect(decision.type).toBe('modify')
    expect(decision.type === 'modify' && decision.input.model).toBe(model)
    expect(routeShipReviewer('Agent', { prompt: `Ship-Role: ${role}\nInputs`, model }, root, false, true)).toEqual({ type: 'allow' })
  }
})
test('invalid header cannot silently inherit a parent model; quoted body headers do not declare roles', () => {
  for (const header of ['Ship-Role: typo', 'Ship-Role: e2e, bugs', 'Ship-Role : e2e', 'ship-role: e2e']) {
    expect(declaredShipRole(header)).toBe('invalid')
    expect(routeShipReviewer('Agent', { prompt: header, model: 'opus' }, root, false, true).type).toBe('block')
  }
  expect(declaredShipRole('Review inputs\nShip-Role: e2e')).toBeUndefined()
  expect(SHIP_REVIEWER_ROLES).toHaveLength(8)
})
test('fresh E2E enforced while old ordinary and known Ship calls keep compatibility', () => {
  expect(routeShipReviewer('Agent', { prompt: 'Ship-Role: e2e\nInputs', model: 'sonnet', resume: 'old-opus-id' }, root, false, true).type).toBe('block')
  expect(routeShipReviewer('Agent', { prompt: 'Ordinary research', model: 'haiku' }, root, false, true)).toEqual({ type: 'allow' })
  expect(routeShipReviewer('Agent', { prompt: 'Neutral e2e prover\nPLAN_DIR=/tmp/plan', description: 'independent e2e', model: 'opus' }, root, false, true).type).toBe('modify')
  expect(routeShipReviewer('Agent', { prompt: 'codex-factchecker\ngate: g1', model: 'opus' }, root, false, true).type).toBe('block')
})
