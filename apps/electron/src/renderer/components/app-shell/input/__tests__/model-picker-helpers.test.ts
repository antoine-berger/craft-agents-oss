/**
 * Pure-helper coverage for the model-picker. The helpers are tiny but they
 * back both the desktop dropdown and the compact (drawer) selector — pinning
 * the behavior here so future refactors of the picker can't quietly diverge
 * the two surfaces.
 */

import { describe, test, expect } from 'bun:test'
import type { LlmConnection } from '@craft-agent/shared/config/llm-connections'
import {
  connectionPickerModels,
  formatTokenCount,
  getPickerModelName,
  sortPickerModels,
  groupConnectionsByProvider,
  stripPiPrefixForDisplay,
} from '../model-picker-helpers'

// -----------------------------------------------------------------------------
// stripPiPrefixForDisplay
// -----------------------------------------------------------------------------

describe('stripPiPrefixForDisplay', () => {
  test('strips the "pi/" prefix when present', () => {
    expect(stripPiPrefixForDisplay('pi/claude-opus-4-7')).toBe('claude-opus-4-7')
  })

  test('returns input unchanged when prefix is absent', () => {
    expect(stripPiPrefixForDisplay('claude-opus-4-7')).toBe('claude-opus-4-7')
  })

  test('does NOT strip "pi:" (legacy other-form prefix)', () => {
    // The prefix is "pi/" — the alternative "pi:" form is intentionally not
    // collapsed because some IDs use a colon for unrelated purposes.
    expect(stripPiPrefixForDisplay('pi:claude-opus-4-7')).toBe('pi:claude-opus-4-7')
  })

  test('only strips at the start, not mid-string', () => {
    expect(stripPiPrefixForDisplay('foo-pi/bar')).toBe('foo-pi/bar')
  })

  test('handles empty string', () => {
    expect(stripPiPrefixForDisplay('')).toBe('')
  })
})

// -----------------------------------------------------------------------------
// formatTokenCount
// -----------------------------------------------------------------------------

describe('formatTokenCount', () => {
  test('renders zero as "0"', () => {
    expect(formatTokenCount(0)).toBe('0')
  })

  test('renders < 1k literally', () => {
    expect(formatTokenCount(42)).toBe('42')
    expect(formatTokenCount(999)).toBe('999')
  })

  test('renders 1k..<10k with one decimal', () => {
    expect(formatTokenCount(1000)).toBe('1.0k')
    expect(formatTokenCount(1500)).toBe('1.5k')
    expect(formatTokenCount(9999)).toBe('10.0k')
  })

  test('renders ≥ 10k as whole-k', () => {
    expect(formatTokenCount(10_000)).toBe('10k')
    expect(formatTokenCount(200_000)).toBe('200k')
    expect(formatTokenCount(999_999)).toBe('1000k')
  })

  test('renders ≥ 1M with one decimal', () => {
    expect(formatTokenCount(1_000_000)).toBe('1.0M')
    expect(formatTokenCount(1_500_000)).toBe('1.5M')
    expect(formatTokenCount(12_345_678)).toBe('12.3M')
  })
})

// -----------------------------------------------------------------------------
// groupConnectionsByProvider
// -----------------------------------------------------------------------------

function conn(
  slug: string,
  providerType: LlmConnection['providerType'],
  extras: Partial<LlmConnection> = {},
): LlmConnection {
  return {
    slug,
    name: slug,
    providerType,
    authType: 'api_key',
    createdAt: 0,
    ...extras,
  }
}

describe('groupConnectionsByProvider', () => {
  test('returns empty array for empty input', () => {
    expect(groupConnectionsByProvider([])).toEqual([])
  })

  test('groups anthropic providers into "Anthropic"', () => {
    const a = conn('a', 'anthropic')
    const b = conn('b', 'anthropic')
    const result = groupConnectionsByProvider([a, b])
    expect(result).toEqual([['Anthropic', [a, b]]])
  })

  test('preserves intra-group order', () => {
    const a = conn('first', 'anthropic')
    const b = conn('second', 'anthropic')
    const c = conn('third', 'anthropic')
    const result = groupConnectionsByProvider([a, b, c])
    expect(result[0][1].map(c => c.slug)).toEqual(['first', 'second', 'third'])
  })

  test('places "Anthropic" group before pi groups (display order)', () => {
    const piConn = conn('pi-1', 'pi')
    const anth = conn('anthropic-1', 'anthropic')
    const result = groupConnectionsByProvider([piConn, anth])
    expect(result.map(([k]) => k)).toEqual(['Anthropic', 'Craft Agents Backend'])
  })

  test('"pi_compat" with localhost baseUrl goes to "Local"', () => {
    const local = conn('ollama', 'pi_compat', { baseUrl: 'http://localhost:11434' })
    const result = groupConnectionsByProvider([local])
    expect(result).toEqual([['Local', [local]]])
  })

  test('"pi_compat" with remote baseUrl goes to "Craft Agents Backend"', () => {
    const remote = conn('openrouter', 'pi_compat', { baseUrl: 'https://openrouter.ai/api/v1' })
    const result = groupConnectionsByProvider([remote])
    expect(result).toEqual([['Craft Agents Backend', [remote]]])
  })

  test('drops empty groups from the output', () => {
    const a = conn('a', 'anthropic')
    const result = groupConnectionsByProvider([a])
    // Only "Anthropic" appears; "Local" and "Craft Agents Backend" are dropped.
    expect(result.length).toBe(1)
    expect(result[0][0]).toBe('Anthropic')
  })

  test('full mixed input — anthropic + local + remote pi_compat + pi', () => {
    const anth = conn('a', 'anthropic')
    const local = conn('ollama', 'pi_compat', { baseUrl: 'http://127.0.0.1:1234' })
    const remote = conn('or', 'pi_compat', { baseUrl: 'https://openrouter.ai' })
    const pi = conn('p', 'pi')
    const result = groupConnectionsByProvider([anth, local, remote, pi])
    expect(result.map(([k, conns]) => [k, conns.map(c => c.slug)])).toEqual([
      ['Anthropic', ['a']],
      ['Local', ['ollama']],
      ['Craft Agents Backend', ['or', 'p']],
    ])
  })
})

describe('readable model options', () => {
 test('uses exact Claude versions rather than registry short names or deprecated aliases', () => {
  for (const [id,name] of [
   ['claude-opus-5-5','Opus 5.5'], ['claude-sonnet-4-20250514','Sonnet 4'],
   ['claude-3-7-sonnet-20250219','Sonnet 3.7'], ['claude-3-5-haiku-20241022','Haiku 3.5'],
   ['claude-opus-4-5-20251101','Opus 4.5'], ['claude-fable-5-1','Fable 5.1'],
   ['pi/claude-opus-5-5','Opus 5.5'],
  ]) expect(getPickerModelName(id)).toBe(name)
 })
 test('formats GPT names consistently for string and promoted object options', () => {
  expect(getPickerModelName('gpt-6.1-sol')).toBe('GPT 6.1 Sol')
  expect(getPickerModelName({id:'gpt-6.1-sol',name:'Gpt 6.1.sol'})).toBe('GPT 6.1 Sol')
  expect(getPickerModelName({id:'claude-opus-5-5',name:'claude-opus-5-5'})).toBe('Opus 5.5')
  expect(getPickerModelName('openai/gpt-5.6-luna')).toBe('GPT 5.6 Luna')
  expect(getPickerModelName({id:'custom/model',name:'My custom model'})).toBe('My custom model')
 })
 test('groups families and sorts versions numerically without changing model identifiers', () => {
  const models=['claude-haiku-4-5-20251001','claude-sonnet-5','claude-opus-4-8','claude-opus-5-5','claude-sonnet-5-5','claude-opus-4-10']
  expect(sortPickerModels(models)).toEqual(['claude-opus-5-5','claude-opus-4-10','claude-opus-4-8','claude-sonnet-5-5','claude-sonnet-5','claude-haiku-4-5-20251001'])
  expect(models[0]).toBe('claude-haiku-4-5-20251001')
  expect(sortPickerModels(['gpt-5.6-sol','gpt-6-sol','gpt-6.1-sol'])).toEqual(['gpt-6.1-sol','gpt-6-sol','gpt-5.6-sol'])
 })
 test('puts proxied GPT under OpenAI while retaining genuine local runtimes', () => {
  const proxy=conn('cli-proxy-codex','pi_compat',{baseUrl:'http://127.0.0.1:41801',piAuthProvider:'openai'})
  const native=conn('chatgpt','pi',{piAuthProvider:'openai-codex'})
  const local=conn('ollama','pi_compat',{baseUrl:'http://localhost:11434'})
  const anthropic=conn('claude','anthropic')
  expect(groupConnectionsByProvider([local,proxy,native,anthropic]).map(([group,connections])=>[group,connections.map(c=>c.slug)])).toEqual([
   ['Anthropic',['claude']],['OpenAI',['cli-proxy-codex','chatgpt']],['Local',['ollama']],
  ])
 })
})


test('a mixed proxy catalogue keeps chat models in their real account pool', () => {
  const models = ['claude-opus-5-5', 'gpt-6.1-sol', 'gpt-image-2', 'codex-auto-review', 'o3']
  expect(connectionPickerModels('cli-proxy-claude', models)).toEqual(['claude-opus-5-5'])
  expect(connectionPickerModels('cli-proxy-codex', models)).toEqual(['gpt-6.1-sol', 'o3'])
  expect(connectionPickerModels('custom-aggregator', models)).toEqual(models)
  const definition = { id: 'claude-sonnet-4-6', name: 'Sonnet', supportsImages: true }
  expect(connectionPickerModels('cli-proxy-claude', [definition, { id: 'gpt-image-2' }])[0]).toBe(definition)
})
